// Box-wide FIFO concurrency cap for browser sessions, partitioned by pool.
//
// Each browser session is memory-heavy (hundreds of MB resident), so the
// number that can run at once on a single host is bounded. This module is a
// file-based semaphore: every worker process and ad-hoc CLI script on the box
// reads the same slot directories, so they all agree on the live-session count
// and no single worker can exceed the cap.
//
// Pools let two independent classes of work share the host without starving
// each other. Each pool has its own ticket queue, its own numbered slot dirs,
// and its own capacity, so heavy load in one pool cannot drain the other.
// (This is distinct from the per-key serialization in the queue layer, which
// protects a single session's working directory; this module bounds the total
// number of concurrent sessions box-wide.)
//
// Layout (per pool):
//   <root>/<pool>/
//     tickets/<sortable-ts>-<pid>-<rand>.tic   waiters, FIFO ordered by name
//     slots/slot-N.lock/holder.json            live holders, N in 0..cap-1
//
// Algorithm (per pool):
//   acquire(pool):
//     1. Atomically create a ticket in the pool's tickets dir.
//     2. Loop: reap stale tickets/slots; if my_position < cap - n_active,
//        claim the lowest free slot via atomic mkdir; on win, delete the
//        ticket and return the slot index.
//     3. Else sleep poll_ms + jitter and retry.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = process.env.SESSION_GLOBAL_ROOT || '/tmp/session-global';
const POLL_MS = Number(process.env.SESSION_GLOBAL_POLL_MS) || 750;

// Per-pool HARD cap. The soft watermark below (resource-based admission)
// usually keeps live sessions well under this, but the hard cap is the
// always-respected backstop: even if there is apparent RAM headroom, a runaway
// loop or a measurement glitch cannot admit more than this many.
const POOL_CAPACITY = {
  default: Number(process.env.SESSION_MAX_GLOBAL_DEFAULT) || 8,
  batch: Number(process.env.SESSION_MAX_GLOBAL_BATCH) || 4,
};

// Soft-watermark thresholds. The wait loop refuses to claim an otherwise-free
// slot when the box is under resource pressure. Each browser session is
// several hundred MB resident, and an out-of-memory kill mid-navigation loses
// the run, so it is cheaper to wait than to over-admit. Override per-process
// via env if a worker needs to be more or less greedy.
const MIN_FREE_MB = Number(process.env.SESSION_MIN_FREE_MB) || 3000;
const MAX_LOAD_RATIO = Number(process.env.SESSION_MAX_LOAD_RATIO) || 0.85;
const RESOURCE_POLL_MULT = 2; // wait longer between checks when resource-throttled

function poolDirs(pool) {
  if (!Object.prototype.hasOwnProperty.call(POOL_CAPACITY, pool)) {
    throw new Error(`Unknown pool "${pool}" — expected one of: ${Object.keys(POOL_CAPACITY).join(', ')}`);
  }
  const base = path.join(ROOT, pool);
  return {
    base,
    tickets: path.join(base, 'tickets'),
    slots: path.join(base, 'slots'),
    capacity: POOL_CAPACITY[pool],
  };
}

function ensureRoot(dirs) {
  fs.mkdirSync(dirs.tickets, { recursive: true });
  fs.mkdirSync(dirs.slots, { recursive: true });
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

function reapStaleTickets(dirs) {
  let names;
  try { names = fs.readdirSync(dirs.tickets); } catch { return []; }
  const alive = [];
  for (const name of names) {
    if (!name.endsWith('.tic')) continue;
    const full = path.join(dirs.tickets, name);
    const data = readJsonSafe(full);
    if (data && (data.host !== os.hostname() || isAlive(data.pid))) {
      alive.push(name);
    } else {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  alive.sort();
  return alive;
}

function reapStaleSlots(dirs, poolName) {
  let entries;
  try { entries = fs.readdirSync(dirs.slots); } catch { return []; }
  const live = [];
  for (const name of entries) {
    const m = name.match(/^slot-(\d+)\.lock$/);
    if (!m) continue;
    const idx = Number(m[1]);
    const holderPath = path.join(dirs.slots, name, 'holder.json');
    const h = readJsonSafe(holderPath);
    if (h && h.host === os.hostname() && !isAlive(h.pid)) {
      try { fs.unlinkSync(holderPath); } catch {}
      try { fs.rmdirSync(path.join(dirs.slots, name)); } catch {}
      console.log(`[session-global:${poolName}] Reaped stale slot ${idx} (dead pid ${h.pid})`);
      continue;
    }
    live.push(idx);
  }
  return live;
}

function tryClaimSlot(dirs, idx) {
  const dir = path.join(dirs.slots, `slot-${idx}.lock`);
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    return false;
  }
  writeJsonAtomic(path.join(dir, 'holder.json'), {
    pid: process.pid,
    host: os.hostname(),
    acquiredAt: Date.now(),
  });
  return true;
}

function makeTicketName() {
  const ts = Date.now().toString().padStart(16, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${process.pid.toString().padStart(7, '0')}-${rand}.tic`;
}

async function acquireGlobalSlot(callerLabel, opts = {}) {
  const pool = opts.pool || 'default';
  // Test-only escape hatch: when SESSION_GLOBAL_BYPASS=1 is set on the calling
  // process, skip the queue entirely and return a sentinel slot index that
  // releaseGlobalSlot() ignores (slotIdx < 0). Use only for one-shot debug
  // runs; running multiple bypass-enabled processes at once defeats the
  // resource protection the cap exists for.
  if (String(process.env.SESSION_GLOBAL_BYPASS || '').toLowerCase() === '1' || String(process.env.SESSION_GLOBAL_BYPASS || '').toLowerCase() === 'true') {
    console.log(`[session-global:${pool}] SESSION_GLOBAL_BYPASS=1 — skipping FIFO cap (label=${callerLabel || '?'})`);
    return -1;
  }
  const dirs = poolDirs(pool);
  ensureRoot(dirs);

  const ticketName = makeTicketName();
  const ticketPath = path.join(dirs.tickets, ticketName);
  writeJsonAtomic(ticketPath, {
    pid: process.pid,
    host: os.hostname(),
    createdAt: Date.now(),
    label: callerLabel || null,
  });

  let waitingLogged = false;
  let lastReportedPosition = -1;
  let resourceThrottleLogged = false;
  let resourceThrottleStartedAt = 0;
  const startedAt = Date.now();
  try {
    while (true) {
      const aliveTickets = reapStaleTickets(dirs);
      const liveSlots = reapStaleSlots(dirs, pool);
      const myIdx = aliveTickets.indexOf(ticketName);
      if (myIdx === -1) {
        writeJsonAtomic(ticketPath, {
          pid: process.pid,
          host: os.hostname(),
          createdAt: Date.now(),
          label: callerLabel || null,
        });
        await sleep(POLL_MS);
        continue;
      }
      const headroom = dirs.capacity - liveSlots.length;
      if (myIdx < headroom) {
        // Soft-watermark admission gate. The FIFO position would let us in, but
        // only claim if the box has headroom for another session. When
        // resource-throttled: log once, then poll slower, since pressure
        // usually clears within seconds as other sessions finish their bursts.
        const admission = checkResourceAdmission();
        if (!admission.ok) {
          if (!resourceThrottleLogged) {
            const tag = callerLabel ? `[${callerLabel}] ` : '';
            console.log(`${tag}[session-global:${pool}] resource-throttled (${admission.reason}); slot ${dirs.capacity - liveSlots.length} would otherwise be free`);
            resourceThrottleLogged = true;
            resourceThrottleStartedAt = Date.now();
          }
          await sleep(POLL_MS * RESOURCE_POLL_MULT + Math.floor(Math.random() * 500));
          continue;
        }
        if (resourceThrottleLogged) {
          const throttledMs = Date.now() - resourceThrottleStartedAt;
          const tag = callerLabel ? `[${callerLabel}] ` : '';
          console.log(`${tag}[session-global:${pool}] resource pressure cleared (after ${Math.round(throttledMs / 1000)}s); avail=${admission.status.availableMb}MB load=${admission.status.loadRatio.toFixed(2)}`);
          resourceThrottleLogged = false;
        }
        for (let k = 0; k < dirs.capacity; k++) {
          if (liveSlots.includes(k)) continue;
          if (tryClaimSlot(dirs, k)) {
            try { fs.unlinkSync(ticketPath); } catch {}
            const waitedMs = Date.now() - startedAt;
            if (waitingLogged || waitedMs > 5000) {
              console.log(`[session-global:${pool}] ${callerLabel || ''} → slot ${k} (waited ${Math.round(waitedMs / 1000)}s, cap=${dirs.capacity}, avail=${admission.status.availableMb}MB load=${admission.status.loadRatio.toFixed(2)})`);
            }
            return k;
          }
        }
      }
      if (!waitingLogged || (myIdx !== lastReportedPosition && myIdx <= 5)) {
        const tag = callerLabel ? `[${callerLabel}] ` : '';
        console.log(`${tag}[session-global:${pool}] In line: position ${myIdx + 1}/${aliveTickets.length}, ${liveSlots.length}/${dirs.capacity} slots in use`);
        waitingLogged = true;
        lastReportedPosition = myIdx;
      }
      await sleep(POLL_MS + Math.floor(Math.random() * 350));
    }
  } catch (e) {
    try { fs.unlinkSync(ticketPath); } catch {}
    throw e;
  }
}

function releaseGlobalSlot(slotIdx, opts = {}) {
  if (slotIdx == null || slotIdx < 0) return;
  const pool = opts.pool || 'default';
  const dirs = poolDirs(pool);
  const dir = path.join(dirs.slots, `slot-${slotIdx}.lock`);
  try { fs.unlinkSync(path.join(dir, 'holder.json')); } catch {}
  try { fs.rmdirSync(dir); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Read box-wide memory + load. On Linux this uses /proc/meminfo's MemAvailable
// (a correct accounting of free + reclaimable page cache, which os.freemem()
// undercounts by roughly the page-cache size). Elsewhere it falls back to
// os.freemem().
function getResourceStatus() {
  let availableMb;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    availableMb = m ? Math.floor(Number(m[1]) / 1024) : Math.floor(os.freemem() / 1024 / 1024);
  } catch {
    availableMb = Math.floor(os.freemem() / 1024 / 1024);
  }
  const load1 = os.loadavg()[0];
  const cores = Math.max(1, os.cpus().length || 1);
  return { availableMb, load1, cores, loadRatio: load1 / cores };
}

// Returns { ok, reason, status }. ok=true means the box has headroom for
// another session. When ok=false, the wait loop refuses to claim a slot even
// if the FIFO position would otherwise allow it, and polls at a slower cadence
// so the throttle does not busy-loop.
function checkResourceAdmission() {
  const status = getResourceStatus();
  if (status.availableMb < MIN_FREE_MB) {
    return {
      ok: false,
      reason: `RAM pressure: avail=${status.availableMb}MB < min=${MIN_FREE_MB}MB`,
      status,
    };
  }
  if (status.loadRatio > MAX_LOAD_RATIO) {
    return {
      ok: false,
      reason: `CPU pressure: load1/cores=${status.loadRatio.toFixed(2)} > max=${MAX_LOAD_RATIO}`,
      status,
    };
  }
  return { ok: true, reason: '', status };
}

module.exports = {
  acquireGlobalSlot,
  releaseGlobalSlot,
  POOL_CAPACITY,
  // Exported for diagnostics (e.g. a monitor worker, ad-hoc CLI checks).
  getResourceStatus,
  checkResourceAdmission,
};
