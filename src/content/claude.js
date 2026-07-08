// Anthropic (Claude) client wrapper: text + vision messages with retry and
// exponential backoff. A thin axios layer over the Messages API; no SDK
// dependency.
//
// The API key is read from ANTHROPIC_API_KEY at call time so importing this
// module never throws on a missing key.

const axios = require('axios');

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const API_URL = 'https://api.anthropic.com/v1/messages';

function apiKey() {
  const k = process.env.ANTHROPIC_API_KEY;
  if (!k) throw new Error('ANTHROPIC_API_KEY env var is not set');
  return k;
}

async function postWithRetry(body, { maxAttempts = 3, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await axios.post(API_URL, body, {
        timeout: timeoutMs,
        headers: {
          'x-api-key': apiKey(),
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      const isTransient = res.status === 429 || (res.status >= 500 && res.status < 600);
      const snippet = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      lastErr = new Error(`Claude ${res.status}: ${snippet.slice(0, 300)}`);
      if (!isTransient || i === maxAttempts) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (i === maxAttempts) throw e;
    }
    const backoffMs = 800 * Math.pow(2, i - 1) + Math.floor(Math.random() * 400);
    console.warn(`[claude] retry ${i}/${maxAttempts} after ${backoffMs}ms — ${lastErr.message}`);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr;
}

// Send one user turn built from a prompt string and optional images, returning
// the model's text. `images` is an array of { buffer, mimeType }.
async function createMessage(prompt, { system, images = [], model = MODEL, maxTokens = 512 } = {}) {
  const content = [];
  for (const img of images) {
    if (!img || !img.buffer) continue;
    const base64 = Buffer.isBuffer(img.buffer) ? img.buffer.toString('base64') : String(img.buffer);
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: base64 } });
  }
  content.push({ type: 'text', text: String(prompt) });

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  if (system) body.system = String(system);

  const data = await postWithRetry(body, { timeoutMs: 60000 });
  return (data?.content?.[0]?.text || '').trim();
}

module.exports = { createMessage, postWithRetry };
