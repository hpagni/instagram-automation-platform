// Per-session-key queue built on the generic profile-queue primitive,
// configured against its own lock root so it can coexist with other queues
// on the same box without colliding.
//
// The unit of contention here is the per-session working directory: two
// concurrent browser processes pointed at the same on-disk session profile
// corrupt its SQLite stores, so work for a given session key is serialized.

const { createProfileQueue } = require('./profile-queue');

const ROOT = process.env.SESSION_QUEUE_ROOT || '/tmp/session-queue';
const GAP_MS = Number(process.env.SESSION_QUEUE_GAP_MS) || 60_000;
const POLL_MS = Number(process.env.SESSION_QUEUE_POLL_MS) || 1500;

const queue = createProfileQueue({ root: ROOT, gapMs: GAP_MS, pollMs: POLL_MS, label: 'session-queue' });

module.exports = {
  runWithSessionQueue: queue.runWithQueue,
  acquireSessionSlot: queue.acquireSlot,
  releaseSessionSlot: queue.releaseSlot,
};
