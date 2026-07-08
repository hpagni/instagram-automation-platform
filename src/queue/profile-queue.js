// Generic per-key task queue. A cross-process mutex with a configurable
// post-task gap before the next task on the same key may start.
//
// This is the neutral primitive the rest of the queue layer is built on:
// give it a lock root directory and a key, and it guarantees that only one
// process across the whole box holds a given key at a time, with a cooldown
// gap enforced between consecutive holders.
//
// Algorithm:
//   acquire  — atomic mkdir <root>/<key>.lock; write holder.json with pid +
//              hostname + acquiredAt. On EEXIST, poll until the holder is
//              stale (its pid is dead) or its scheduled release gap elapses.
//   release  — write releaseScheduledAt = now + gapMs; gapMs later, unlink
//              holder.json and rmdir the lock. The current task is not blocked
//              by the gap; only subsequent waiters are.
//   takeover — if the holder pid is dead and any pending gap has elapsed, the
//              next waiter takes the lock over. This covers worker crashes.

const fs = require('fs');
const path = require('path');
const os = require('os');

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function createProfileQueue({ root, gapMs = 60_000, pollMs = 1500, label: queueLabel = 'profile-queue' }) {
  if (!root) throw new Error('createProfileQueue requires a root directory');

  function ensureRoot() {
    try { fs.mkdirSync(root, { recursive: true }); } catch {}
  }

  function lockDir(id) { return path.join(root, `${safeId(id)}.lock`); }
  function holderPath(id) { return path.join(lockDir(id), 'holder.json'); }

  function readHolder(id) {
    try { return JSON.parse(fs.readFileSync(holderPath(id), 'utf8')); } catch { return null; }
  }

  function writeHolder(id, data) {
    const tmp = holderPath(id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, holderPath(id));
  }

  function isHolderStale(holder) {
    if (!holder) return true;
    if (holder.hostname && holder.hostname !== os.hostname()) return false;
    return !processAlive(holder.pid);
  }

  function pendingGapMs(holder) {
    if (!holder?.releaseScheduledAt) return 0;
    return Math.max(0, holder.releaseScheduledAt - Date.now());
  }

  function tryAcquire(id) {
    ensureRoot();
    try {
      fs.mkdirSync(lockDir(id));
      writeHolder(id, {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
        releaseScheduledAt: null,
      });
      return true;
    } catch (e) {
      if (e.code === 'EEXIST') return false;
      throw e;
    }
  }

  function takeOverStale(id, prev) {
    try {
      writeHolder(id, {
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: Date.now(),
        releaseScheduledAt: null,
        tookOverFrom: prev?.pid ?? null,
      });
      const v = readHolder(id);
      return !!v && v.pid === process.pid && v.hostname === os.hostname();
    } catch { return false; }
  }

  async function acquire(id, callerLabel) {
    let waitingLogged = false;
    while (true) {
      if (tryAcquire(id)) return;

      const holder = readHolder(id);

      if (isHolderStale(holder)) {
        const gap = pendingGapMs(holder);
        if (gap > 0) {
          await sleep(gap + Math.floor(Math.random() * 500));
          continue;
        }
        if (takeOverStale(id, holder)) {
          console.log(`[${queueLabel}] Took over stale lock for ${id} (prev pid ${holder?.pid ?? 'unknown'})`);
          return;
        }
        await sleep(pollMs);
        continue;
      }

      if (!waitingLogged) {
        const heldBy = holder?.pid ? `pid ${holder.pid}` : 'unknown';
        const since = holder?.acquiredAt ? `${Math.round((Date.now() - holder.acquiredAt) / 1000)}s` : '?';
        const tag = callerLabel ? `[${callerLabel}] ` : '';
        console.log(`${tag}[${queueLabel}] Waiting on ${id} (held by ${heldBy} for ${since})`);
        waitingLogged = true;
      }

      if (holder?.releaseScheduledAt) {
        const wait = Math.max(pollMs, holder.releaseScheduledAt - Date.now());
        await sleep(wait + Math.floor(Math.random() * 500));
      } else {
        await sleep(pollMs + Math.floor(Math.random() * 500));
      }
    }
  }

  function scheduleRelease(id) {
    const releaseAt = Date.now() + gapMs;
    try {
      const holder = readHolder(id) || {};
      writeHolder(id, { ...holder, releaseScheduledAt: releaseAt });
    } catch {}

    setTimeout(() => {
      try { fs.unlinkSync(holderPath(id)); } catch {}
      try { fs.rmdirSync(lockDir(id)); } catch {}
    }, gapMs).unref?.();
  }

  async function runWithQueue(id, taskFn, callerLabel) {
    if (!id) throw new Error(`${queueLabel}: runWithQueue requires an id`);
    await acquire(id, callerLabel);
    try {
      return await taskFn();
    } finally {
      scheduleRelease(id);
    }
  }

  async function acquireSlot(id, callerLabel) {
    if (!id) throw new Error(`${queueLabel}: acquireSlot requires an id`);
    await acquire(id, callerLabel);
  }

  function releaseSlot(id) {
    if (!id) return;
    scheduleRelease(id);
  }

  return { runWithQueue, acquireSlot, releaseSlot };
}

module.exports = { createProfileQueue };
