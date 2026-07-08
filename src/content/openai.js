// OpenAI client wrapper: text completion + image generation with retry and
// exponential backoff. A thin axios layer over the OpenAI HTTP API; no SDK
// dependency.
//
// The API key is read from OPENAI_API_KEY at call time so importing this
// module never throws on a missing key.

const axios = require('axios');
const crypto = require('crypto');

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || 'auto';
const API_BASE = 'https://api.openai.com/v1';

// Short hash of a prompt string, so callers can log which prompt version
// produced a given output and correlate prompt edits against quality changes.
const hashText = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

function apiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('OPENAI_API_KEY is not set');
  return k;
}

async function postWithRetry(url, body, { timeout = 120000, maxAttempts = 3, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let transient = true;
    try {
      const res = await axios.post(url, body, {
        timeout,
        headers: { Authorization: `Bearer ${apiKey()}`, ...headers },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      transient = res.status === 429 || res.status >= 500;
      const bodyStr = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      lastErr = new Error(`OpenAI ${res.status}: ${bodyStr.slice(0, 500)}`);
    } catch (e) {
      lastErr = e;
    }
    if (!transient || attempt === maxAttempts) throw lastErr;
    const backoff = 2000 * attempt + Math.random() * 1000;
    console.log(`[openai] retry ${attempt}/${maxAttempts} after ${Math.round(backoff)}ms — ${lastErr.message?.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw lastErr;
}

// Generate text from a prompt. `system` is optional; `fewShot` is an optional
// array of { role, content } messages inserted between the system message and
// the user prompt so callers can drive output with examples.
async function generateText(prompt, { system, fewShot = [], model = TEXT_MODEL, temperature = 1.0, maxTokens = 256 } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const m of fewShot) {
    if (m && m.role && m.content != null) messages.push({ role: m.role, content: String(m.content) });
  }
  messages.push({ role: 'user', content: String(prompt) });

  const data = await postWithRetry(`${API_BASE}/chat/completions`, {
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  }, { timeout: 60000, headers: { 'Content-Type': 'application/json' } });

  const text = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!text) throw new Error(`OpenAI text returned empty: ${JSON.stringify(data).slice(0, 400)}`);
  return text;
}

// Text-to-image generation. Returns { buffer, mimeType }. Uses the images
// generations endpoint with a JSON body, so there is no multipart/File
// dependency and it runs on any Node version.
async function generateImage(prompt, { model = IMAGE_MODEL, size = IMAGE_SIZE, quality = IMAGE_QUALITY } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('generateImage requires a prompt');

  const data = await postWithRetry(`${API_BASE}/images/generations`, {
    model,
    prompt: String(prompt),
    n: 1,
    size,
    quality,
  }, { timeout: 300000, headers: { 'Content-Type': 'application/json' } });

  const item = data?.data?.[0];
  if (!item) throw new Error(`OpenAI image returned no data: ${JSON.stringify(data).slice(0, 500)}`);
  if (item.b64_json) {
    return { buffer: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' };
  }
  if (item.url) {
    const res = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000 });
    return { buffer: Buffer.from(res.data), mimeType: 'image/png' };
  }
  throw new Error(`OpenAI image returned no b64_json or url: ${JSON.stringify(data).slice(0, 500)}`);
}

module.exports = { generateText, generateImage, postWithRetry, hashText };
