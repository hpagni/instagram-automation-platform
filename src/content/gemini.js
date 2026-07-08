// Gemini content client: LLM caption generation with few-shot exemplars,
// image generation, prompt-version hashing, and retry with exponential
// backoff. A thin axios layer over the Generative Language API; no SDK
// dependency.
//
// The API key is read from GEMINI_API_KEY at call time so importing this
// module never throws on a missing key.

const axios = require('axios');
const crypto = require('crypto');

const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Prompt versioning. Each generator exposes a short hash of its system/template
// text via PROMPT_VERSIONS; callers log it alongside the output so a later
// prompt change can be correlated against output-quality changes. Editing the
// prompt text below bumps the hash automatically.
const hashText = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);

// A small static set of caption exemplars. In the source system these were
// drawn from a larger corpus of real captions; here a compact inline sample
// stands in. A production deployment would plug a real corpus in behind
// sampleCaptionExemplars() (e.g. load from a file or a datastore) and keep this
// as the fallback.
const CAPTION_EXEMPLARS = [
  'nyc', 'thursday', 'ok', 'idk', 'finally', 'not bad', '3am', 'ugh',
  'treated myself', 'back !!', 'lol bye', '5pm sunday', 'bored', 'the usual',
  'light was nice', 'did not edit this', 'one of those', 'proof i was there',
  'before it got cold', 'in a rush', 'still here', 'maybe later', 'afternoon',
  'nothing to add', 'february', 'earned it',
];

function sampleCaptionExemplars(n = 15) {
  const pool = CAPTION_EXEMPLARS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error('GEMINI_API_KEY is not set');
  return k;
}

async function postWithRetry(url, body, { timeout = 180000, maxAttempts = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await axios.post(url, body, {
        timeout,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) return res.data;
      const transient = res.status === 429 || res.status >= 500;
      const msg = `Gemini ${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`;
      if (!transient || attempt === maxAttempts) throw new Error(msg);
      lastErr = new Error(msg);
    } catch (e) {
      lastErr = e;
      if (attempt === maxAttempts) throw e;
    }
    const backoff = 2000 * attempt + Math.random() * 1000;
    console.log(`[gemini] retry ${attempt}/${maxAttempts} after ${Math.round(backoff)}ms — ${lastErr.message?.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw lastErr;
}

function pickRandomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// System prompt for short social captions. The goal is a plain, casual voice
// rather than polished marketing copy; the rules below steer the model away
// from the tells that make generated captions read as generated.
const CAPTION_SYSTEM = `You write short captions for a personal social post. The voice is casual and understated. Most real captions are short and low-effort, and that is the goal — captions that try too hard read as fake.

Hard rules:
- Output ONLY the caption text. No quotes, no explanations, no labels.
- Output exactly the requested number of words. An emoji counts as one word.
- Do NOT use hashtags.
- Do NOT use the @ symbol.
- Do NOT describe what is in the photo. The caption sits next to the photo; it does not narrate it.
- Vary every time. No two captions should share structure or theme.

How real captions read:
- Most are throwaways: a single word, an emoji, a place, a time, a feeling.
- Capitalization is loose: usually lowercase, occasionally sentence case, rarely all caps.
- Punctuation is sparse: often none, sometimes "!!" or "...".
- Casual abbreviations are normal: idk, tbh, ngl, ok.
- Specific beats poetic: "thursday" beats "soft sunday", "3am" beats "late".

Tone palette (pick ONE per caption, never combine): a single word or emoji; a place or time stamp; a flat statement of fact; a short reaction; a self-aware throwaway; dry and deadpan; playful; nostalgic; a plainly named feeling; a question to no one.

Emojis: most captions have none. Include an emoji only about 1 in 12 captions, at most one, and only when it feels natural.`;

// Generate one caption. `imageJsons` is optional loose context used only as a
// vibe hint (never described). `coverImage` is an optional { buffer, mimeType }
// attached as a visual reference. `length` fixes the word count; `theme` adds
// an optional steer.
async function generateCaption(imageJsons, { length, theme, coverImage } = {}) {
  const wordCount = length || pickRandomInt(2, 7);

  const contextParts = [];
  if (theme) contextParts.push(`Theme: ${theme}`);

  const cleanedJsons = (imageJsons || []).filter(Boolean).map((j) => {
    if (typeof j === 'string') return j;
    try { return JSON.stringify(j); } catch { return String(j); }
  });
  if (cleanedJsons.length) {
    contextParts.push(`Loose context (do NOT describe the image — use only as a vibe hint):\n${cleanedJsons.join('\n---\n')}`);
  }

  const hasCover = !!(coverImage && coverImage.buffer);

  // Inject a fresh sample of exemplars each call so the model sees a
  // representative spread of voice and length rather than overfitting to a
  // fixed set. They are a reference, not a template.
  const exemplars = sampleCaptionExemplars(15);
  const exemplarBlock = exemplars.length
    ? `Here are ${exemplars.length} example captions showing the range of voice and length to match. Do NOT copy any of them — they are a reference, not a template:\n${exemplars.map((c) => `- ${c}`).join('\n')}`
    : null;

  const userPrompt = [
    `Write ONE caption that is exactly ${wordCount} word${wordCount === 1 ? '' : 's'} long. An emoji counts as one word.`,
    hasCover ? `The cover photo is attached. Use it ONLY as a vibe reference — do NOT describe what is in it.` : null,
    exemplarBlock,
    contextParts.length ? contextParts.join('\n\n') : null,
    `Output the caption only — nothing else.`,
  ].filter(Boolean).join('\n\n');

  const userParts = [{ text: userPrompt }];
  if (hasCover) {
    userParts.push({
      inline_data: {
        mime_type: coverImage.mimeType || 'image/jpeg',
        data: coverImage.buffer.toString('base64'),
      },
    });
  }

  const body = {
    systemInstruction: { parts: [{ text: CAPTION_SYSTEM }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      temperature: 1.4,
      topP: 0.98,
      maxOutputTokens: 256,
      // Request several candidates and pick the shortest/lowest-emoji one — the
      // system prompt asks for low-effort captions, so sampling then picking
      // pushes harder toward that than a single high-temp draw.
      candidateCount: 4,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const url = `${API_BASE}/models/${TEXT_MODEL}:generateContent?key=${apiKey()}`;
  const data = await postWithRetry(url, body, { timeout: 60000 });

  const candidates = (data?.candidates || [])
    .map((c) => c?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim())
    .filter(Boolean)
    .map((t) => t.replace(/^["'`]|["'`]$/g, '').trim())
    .filter((t) => t.length > 0);

  if (!candidates.length) {
    throw new Error(`Gemini caption returned no text: ${JSON.stringify(data).slice(0, 400)}`);
  }

  // Prefer fewer emojis, then shorter length.
  const emojiCount = (s) => (s.match(/[☀-➿]|[\ud83c-\ud83e][\udc00-\udfff]/g) || []).length;
  const scored = candidates.map((t) => ({ t, emoji: emojiCount(t), len: t.length }));
  scored.sort((a, b) => (a.emoji - b.emoji) || (a.len - b.len));
  return scored[0].t;
}

// A neutral image prompt builder. Takes a plain scene description (string or
// JSON) and returns a prompt for a casual, phone-camera-style photo. It does
// not reference or reproduce any specific person.
const IMAGE_PROMPT_TEMPLATE = (scene) => {
  const sceneText = typeof scene === 'string' ? scene : JSON.stringify(scene || {});
  return `Generate ONE casual photo for a personal social post. The target look is an ordinary smartphone snapshot: natural available light, loose and slightly off-center framing, true-to-life color, minor phone-camera imperfections. Not a studio shoot, not an advertisement, not a portfolio piece.

Scene description (the source of truth for location, framing, time of day, and lighting):
${sceneText}

Rules:
- Follow the scene description for location, framing, time of day, and lighting. Do not "improve" the framing.
- Do not add text, captions, logos, watermarks, borders, or collages.
- Aspect ratio: portrait (vertical), like a phone photo.

Output: exactly ONE image.`;
};

// Generate an image from a scene description. `referenceImages` is an optional
// array of { buffer, mimeType } passed to the model as visual references.
// Returns { buffer, mimeType }.
async function generateImage(scene, { referenceImages = [] } = {}) {
  const prompt = IMAGE_PROMPT_TEMPLATE(scene);
  const requestParts = [{ text: prompt }];
  for (const ref of referenceImages) {
    if (!ref || !ref.buffer) continue;
    requestParts.push({
      inline_data: {
        mime_type: ref.mimeType || 'image/png',
        data: ref.buffer.toString('base64'),
      },
    });
  }

  const body = { contents: [{ role: 'user', parts: requestParts }] };
  const url = `${API_BASE}/models/${IMAGE_MODEL}:generateContent?key=${apiKey()}`;
  const data = await postWithRetry(url, body, { timeout: 360000 });

  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const p of parts) {
    const inline = p.inline_data || p.inlineData;
    if (inline && inline.data) {
      return {
        buffer: Buffer.from(inline.data, 'base64'),
        mimeType: inline.mime_type || inline.mimeType || 'image/png',
      };
    }
  }
  throw new Error(`Gemini image returned no inline_data: ${JSON.stringify(data).slice(0, 500)}`);
}

// Prompt versions exposed so callers can record which prompt produced a given
// caption or image. Editing the prompt text above changes the hash.
const PROMPT_VERSIONS = {
  caption: hashText(CAPTION_SYSTEM),
  image: hashText(IMAGE_PROMPT_TEMPLATE('')),
};

module.exports = {
  generateCaption,
  generateImage,
  sampleCaptionExemplars,
  postWithRetry,
  hashText,
  PROMPT_VERSIONS,
};
