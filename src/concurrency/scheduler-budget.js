// Persistent multi-bucket cooldown budget for a scheduler.
//
// A scheduler that dispatches work sometimes needs to avoid reusing the same
// resource too often within a window. This module tracks last-seen timestamps
// for keys across one or more named buckets, each with its own cooldown, and
// answers "is this key free to use right now?" A key that was reserved less
// than its bucket's cooldown ago is reported as still on cooldown.
//
// State is persisted to a small JSON file in the OS temp dir so it survives
// scheduler restarts. Stale entries (older than the retention window) are
// pruned on every read.
//
// Example:
//   const budget = makeBudget({
//     buckets: { region: { cooldownMs: 4 * 3600e3 }, group: { cooldownMs: 2 * 3600e3 } },
//   });
//   const verdict = budget.check({ region: 'us-west', group: 'alpha' });
//   if (verdict.ok) { doWork(); budget.reserve({ region: 'us-west', group: 'alpha' }); }

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_STATE_FILE = path.join(os.tmpdir(), 'scheduler-budget.json');
const MAX_RETENTION_MS = 24 * 60 * 60 * 1000; // prune entries older than 24h

function normalizeKey(key) {
  if (key == null) return null;
  const s = String(key).trim();
  return s || null;
}

function makeBudget({ stateFile = DEFAULT_STATE_FILE, buckets = {}, now = () => Date.now() } = {}) {
  const bucketNames = Object.keys(buckets);
  if (!bucketNames.length) throw new Error('makeBudget requires at least one bucket');

  function emptyState() {
    const s = {};
    for (const b of bucketNames) s[b] = {};
    return s;
  }

  function load() {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const s = emptyState();
        for (const b of bucketNames) s[b] = parsed[b] || {};
        return s;
      }
    } catch (_) { /* missing/corrupt → fresh */ }
    return emptyState();
  }

  function prune(state, t) {
    for (const b of bucketNames) {
      for (const k of Object.keys(state[b])) {
        if (t - state[b][k] > MAX_RETENTION_MS) delete state[b][k];
      }
    }
  }

  function save(state) {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(state), 'utf8');
    } catch (e) {
      // budget persistence is best-effort; never block on a disk error
      console.warn(`[scheduler-budget] save failed: ${e.message}`);
    }
  }

  // Inspect a candidate set of { bucketName: key } values. Returns
  // { ok: true } if every key is free, or { ok: false, reason, bucket, key,
  // ageMs } for the first bucket still on cooldown.
  function check(values = {}) {
    const t = now();
    const state = load();
    prune(state, t);
    for (const b of bucketNames) {
      const key = normalizeKey(values[b]);
      if (key == null) continue;
      const last = state[b][key];
      if (last != null) {
        const age = t - last;
        if (age < buckets[b].cooldownMs) {
          return { ok: false, reason: b, bucket: b, key, ageMs: age };
        }
      }
    }
    return { ok: true };
  }

  // Reserve a set of { bucketName: key } values AFTER a successful check and a
  // committed dispatch. Idempotent — last write wins.
  function reserve(values = {}) {
    const t = now();
    const state = load();
    prune(state, t);
    const reserved = {};
    for (const b of bucketNames) {
      const key = normalizeKey(values[b]);
      if (key == null) continue;
      state[b][key] = t;
      reserved[b] = key;
    }
    save(state);
    return { reserved, ts: t };
  }

  function snapshot() {
    const t = now();
    const state = load();
    prune(state, t);
    return state;
  }

  function reset() {
    try { fs.unlinkSync(stateFile); } catch (_) {}
  }

  return { check, reserve, snapshot, reset, stateFile };
}

module.exports = { makeBudget };
