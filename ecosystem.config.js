// PM2 process definitions for the worker fleet.
//
// The pattern: a set of long-running worker processes that each pull jobs from
// the durable queue and drive browser sessions, plus a monitor process that
// watches the fleet and restarts or alerts on trouble. Each worker restarts on
// crash with a bounded restart count so a persistent failure does not spin.
//
// Genericized for the public release: the private deployment ran several
// task-specific workers (each pinned to a class of browser work) behind the
// same shape. Only the neutral fleet-plus-monitor structure is shown here.
// Adjust `instances`, `cwd`, and env to your own deployment. All secrets come
// from the process environment (see .env.example); none are inlined here.

const CWD = process.env.APP_DIR || '.';

module.exports = {
  apps: [
    // Worker fleet. Scale by raising `instances`; PM2 runs them in cluster
    // mode and load-balances across them. Each worker leases jobs from the
    // queue and processes them independently.
    {
      name: 'worker',
      script: 'worker.js',
      cwd: CWD,
      instances: Number(process.env.WORKER_INSTANCES || 4),
      exec_mode: 'cluster',
      restart_delay: 3000,
      max_restarts: 10,
      max_memory_restart: '1G',
    },
    // Monitor: no browser work. Watches queue depth and worker health and
    // surfaces problems. Kept lightweight and memory-capped.
    {
      name: 'monitor',
      script: 'monitor.js',
      cwd: CWD,
      restart_delay: 5000,
      max_restarts: 10,
      max_memory_restart: '300M',
    },
  ],
};
