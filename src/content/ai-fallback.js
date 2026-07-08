// Vision-LLM fallback for Playwright actions that fail because the page layout
// drifted (a selector that used to match no longer does). This is a
// self-healing resilience layer for browser automation, not a primary path.
//
// Usage:
//   await withAiFallback(
//     () => page.locator('...').click(),
//     page,
//     'Click the Continue button'
//   );
//
// On primary failure it captures a viewport screenshot plus a structured list
// of every visible interactive element, sends both to a vision model with the
// supplied intent, parses the model's chosen element index, and clicks it via
// mouse coordinates. It re-throws the original error if no API key is set or
// the model declines.
//
// The `page` object is supplied by the caller, so this module does not import
// Playwright itself. It uses ANTHROPIC_API_KEY via axios; no SDK dependency.

const axios = require('axios');

const MODEL = process.env.AI_FALLBACK_MODEL || 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

async function getInteractables(page) {
  // Snapshot every visible interactive element with its visible text, aria,
  // and viewport-center coordinates. The model picks one by `idx`; we click at
  // (x, y), which aligns with the screenshot we send alongside.
  return await page.evaluate(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    // Accept elements within 2x viewport height to catch below-fold action
    // buttons; horizontal bounds stay strict.
    const inViewport = (rect) =>
      rect.bottom > 0
      && rect.right > 0
      && rect.top < window.innerHeight * 2
      && rect.left < window.innerWidth;
    const els = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a, [role="link"], [role="option"], [role="menuitem"], [role="tab"], input, textarea, select, [contenteditable="true"]'
      )
    );
    const out = [];
    for (const el of els) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (!inViewport(rect)) continue;
      out.push({
        idx: out.length,
        tag: el.tagName,
        text: (el.innerText || el.textContent || '').trim().slice(0, 100),
        ariaLabel: el.getAttribute('aria-label') || undefined,
        role: el.getAttribute('role') || undefined,
        type: el.getAttribute('type') || undefined,
        name: el.getAttribute('name') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        href: el.getAttribute('href') ? el.getAttribute('href').slice(0, 80) : undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
      if (out.length >= 80) break;
    }
    return out;
  });
}

async function aiPickAction(page, intent) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  [ai-fallback] ANTHROPIC_API_KEY not set — skipping AI fallback');
    return null;
  }

  let interactables, screenshot;
  try {
    interactables = await getInteractables(page);
    screenshot = await page.screenshot({ type: 'png' });
  } catch (e) {
    console.log(`  [ai-fallback] Page snapshot failed: ${e.message}`);
    return null;
  }
  if (!interactables.length) {
    console.log('  [ai-fallback] No interactive elements found on page');
    return null;
  }

  const systemPrompt =
    'You are a web automation assistant. Given a screenshot and a list of interactive elements visible on the page (each with an index, tag, visible text, aria-label, and other attributes), pick the single element that best matches the user\'s intent.\n\n' +
    'Respond with strict JSON only — no markdown, no prose, no code fences:\n' +
    '{"action":"click","idx":<number>,"reason":"<short>"}\n' +
    'or {"action":"type","idx":<number>,"text":"<text>","reason":"<short>"}\n' +
    'or {"action":"none","reason":"<why no element matches>"}\n\n' +
    'Prefer elements with explicit aria-labels or visible text that exactly matches the intent. Avoid disabled elements and footer/legal links. If the intended action would navigate away from the flow or trigger something destructive, return action=none.';

  const userText =
    `Intent: ${intent}\n\n` +
    `Page URL: ${page.url()}\n\n` +
    `Interactive elements (${interactables.length}):\n${JSON.stringify(interactables)}\n\n` +
    `Pick the one element matching the intent.`;

  let response;
  try {
    response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: screenshot.toString('base64') },
              },
              { type: 'text', text: userText },
            ],
          },
        ],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        timeout: 60000,
      }
    );
  } catch (e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    console.log(`  [ai-fallback] API call failed: ${detail}`);
    return null;
  }

  const text = (response.data?.content?.[0]?.text || '').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.log(`  [ai-fallback] No JSON in response: ${text.slice(0, 200)}`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    console.log(`  [ai-fallback] JSON parse failed: ${e.message}`);
    return null;
  }

  if (parsed.action === 'none') {
    console.log(`  [ai-fallback] Model declined: ${parsed.reason || '(no reason)'}`);
    return null;
  }
  if (typeof parsed.idx !== 'number' || parsed.idx < 0 || parsed.idx >= interactables.length) {
    console.log(`  [ai-fallback] Model returned invalid idx: ${parsed.idx}`);
    return null;
  }
  parsed.element = interactables[parsed.idx];
  return parsed;
}

async function aiFallbackClick(page, intent) {
  console.log(`  [ai-fallback] Engaging vision model for: ${intent}`);
  const action = await aiPickAction(page, intent);
  if (!action || !action.element) return false;

  const el = action.element;
  const label = el.ariaLabel || el.text || el.placeholder || '(no label)';
  console.log(
    `  [ai-fallback] Model picked idx=${el.idx} <${el.tag}> "${label.slice(0, 60)}" @ (${el.x},${el.y}) — ${action.reason}`
  );

  try {
    if (action.action === 'type') {
      await page.mouse.click(el.x, el.y);
      await page.waitForTimeout(400);
      await page.keyboard.type(action.text || '', { delay: 80 });
    } else {
      await page.mouse.click(el.x, el.y);
    }
    return true;
  } catch (e) {
    console.log(`  [ai-fallback] Click execution failed: ${e.message}`);
    return false;
  }
}

async function withAiFallback(primaryFn, page, intent) {
  try {
    return await primaryFn();
  } catch (e) {
    const firstLine = (e.message || '').split('\n')[0].slice(0, 120);
    console.log(`  [ai-fallback] Primary action failed (${firstLine}) — invoking AI fallback`);
    const ok = await aiFallbackClick(page, intent);
    if (!ok) throw e;
    return null;
  }
}

module.exports = { aiFallbackClick, withAiFallback, aiPickAction, getInteractables };
