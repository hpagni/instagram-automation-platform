# Instagram Automation Platform

A distributed system for operating a large fleet of Instagram accounts and their content at scale. Each account runs in its own isolated browser session pinned to its own proxy, work is dispatched through a durable job queue across a fleet of PM2 workers, and post content is produced by an AI generation pipeline. A monitor layer watches the fleet and recovers from crashes.

This repository is the task-neutral infrastructure layer of that system: the queue and concurrency primitives, the proxy pool clients, and the AI content-generation clients. It is meant to be read as systems engineering, not run end to end as a turnkey account operator. See "What is and isn't in this repo" below.

## Architecture at a glance

- Per-session isolation. Every account gets its own browser session and its own proxy so sessions do not share state or network identity.
- Durable job queue. Browser work is leased from a persistent queue so a crashed worker's job is retried rather than lost. The queue engine is published separately as [distributed-job-runner](https://github.com/hpagni/distributed-job-runner).
- Two-tier concurrency. A per-session mutex serializes work for a single account (so two processes never touch the same on-disk profile), and a box-wide semaphore with resource-admission backpressure caps how many memory-heavy browser sessions run at once.
- AI content pipeline. Multi-provider LLM clients generate captions with few-shot exemplars and generate images, with prompt-version hashing so output can be traced back to the prompt that produced it.
- Monitoring and recovery. A PM2 fleet runs the workers with bounded auto-restart, and a monitor process tracks queue depth and worker health.

For the full picture, including the parts that are described but not shipped, read [ARCHITECTURE.md](ARCHITECTURE.md).

## Repository layout

```
src/
  queue/
    profile-queue.js      Per-key cross-process mutex queue (the core primitive)
    session-queue.js      Per-session-key queue built on profile-queue
  concurrency/
    throttle.js           Playwright click pacing / rate control
    global-cap.js         Box-wide FIFO concurrency cap + resource admission
    scheduler-budget.js   Persistent multi-bucket cooldown budget for a scheduler
  proxy/
    iproyal.js            IPRoyal ISP proxy API client
    geo.js                IP to geolocation resolver
  content/
    openai.js             OpenAI text + image client
    claude.js             Anthropic (Claude) text + vision client
    gemini.js             Gemini captions + image generation, prompt versioning
    ai-fallback.js        Vision-LLM self-healing fallback for Playwright actions
ecosystem.config.js       PM2 worker-fleet + monitor process definitions
```

## Quickstart

```
npm install
cp .env.example .env      # fill in the keys you need
```

The modules are independent building blocks. Import the ones you need:

```js
const { createProfileQueue } = require('./src/queue/profile-queue');
const { acquireGlobalSlot, releaseGlobalSlot } = require('./src/concurrency/global-cap');
const openai = require('./src/content/openai');

const queue = createProfileQueue({ root: '/tmp/my-queue', gapMs: 60000 });

await queue.runWithQueue('account-123', async () => {
  const slot = await acquireGlobalSlot('caption-job', { pool: 'default' });
  try {
    const caption = await openai.generateText('Write a two word caption.', { maxTokens: 16 });
    console.log(caption);
  } finally {
    releaseGlobalSlot(slot, { pool: 'default' });
  }
});
```

Run the fleet under PM2 once you have supplied your own `worker.js` and `monitor.js` entry points:

```
npm start        # pm2 start ecosystem.config.js
```

## Configuration

Everything is configured through environment variables. No keys, tokens, or URLs are committed. `.env.example` lists every variable the included code reads, with no values. Copy it to `.env` and fill in what you need.

## What is and isn't in this repo

This repo publishes the infrastructure that stands on its own as general systems work. It intentionally leaves out the components that only make sense in the context of operating Instagram accounts against Instagram's terms of service.

Included:

- The queue and concurrency primitives.
- The proxy pool client and IP geolocation resolver.
- The AI content-generation clients (captions, images) and the vision-LLM action fallback.
- The PM2 fleet-plus-monitor process pattern.

Not included, by design:

- Account provisioning. The subsystem that created and registered accounts is omitted. This includes the identity, phone-verification, and email-verification pieces that fed it.
- Session integrity handling. The subsystem responsible for making automated sessions pass as ordinary browser traffic is omitted, along with any anti-bot or challenge-solving code.
- The account-network data collection. The follower and engagement scraping code, and the automated following behavior, are omitted.
- Persona and likeness generation. The code that fabricated per-account identities and their reference imagery is omitted, and the content clients here have been decoupled from it.

Those omitted subsystems are described at a box level in [ARCHITECTURE.md](ARCHITECTURE.md) so the shape of the full system is clear, with no method-level detail.

## License

MIT. See [LICENSE](LICENSE).
