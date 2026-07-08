// Click pacing / rate control for Playwright Page objects.
//
// Wraps `.click()` / `.dblclick()` / `.tap()` on the page, on every locator
// returned from page.locator()/getByRole()/etc., on every Frame returned from
// page.frames()/mainFrame(), and on `page.mouse.click/dblclick`. Before each
// click it ensures a minimum interval has elapsed since the previous click on
// the same page, so an automated flow paces its interactions instead of firing
// them back to back.
//
// Also exposes `page.__clickThrottle()` so call sites that bypass the wrapped
// APIs (e.g. `el.evaluate(e => e.click())` running inside the browser) can opt
// back in by awaiting it before triggering their click.
//
// Why a floor and not a fixed sleep: handlers already scatter their own
// `await delay()` calls before clicks. Tracking the last-click time makes the
// throttle a floor: if the caller already waited long enough, no extra wait is
// added. This keeps throughput up while still bounding the click rate.

const CHAIN_METHODS = [
  'locator', 'first', 'last', 'nth', 'filter', 'or', 'and',
  'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
  'getByTestId', 'getByAltText', 'getByTitle',
  'frameLocator', 'contentFrame',
];

const CLICK_METHODS = ['click', 'dblclick', 'tap'];

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Non-uniform pacing. Rather than spacing every click by the same fixed
// interval, sample from a 3-mode mix so bursts of related clicks (opening a
// menu, then tapping a row inside it) can happen quickly while longer pauses
// are interleaved. The expected value lands around 6s so average throughput is
// comparable to a fixed midpoint, but the load is spread rather than uniform.
//
//   ~22% fast    300-1200ms    a quick follow-up click in an open context
//   ~70% normal  3000-10000ms  the default spacing
//   ~8%  long    15000-40000ms an occasional longer pause
function sampleClickDelay() {
  const r = Math.random();
  if (r < 0.22) return rand(300, 1200);
  if (r < 0.92) return rand(3000, 10000);
  return rand(15000, 40000);
}

function installClickThrottle(page, opts = {}) {
  if (!page || page.__clickThrottleInstalled) return page;
  page.__clickThrottleInstalled = true;

  const state = { lastClickAt: 0 };

  const throttle = async () => {
    const desired = (typeof opts.sample === 'function') ? opts.sample() : sampleClickDelay();
    const elapsed = Date.now() - state.lastClickAt;
    const wait = desired - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    state.lastClickAt = Date.now();
  };

  const wrapClickMethods = (target) => {
    for (const m of CLICK_METHODS) {
      if (typeof target[m] !== 'function') continue;
      const orig = target[m].bind(target);
      target[m] = async (...args) => {
        await throttle();
        return orig(...args);
      };
    }
  };

  const wrapLocator = (loc) => {
    if (!loc || typeof loc !== 'object' || loc.__clickThrottleWrapped) return loc;
    loc.__clickThrottleWrapped = true;
    wrapClickMethods(loc);
    for (const m of CHAIN_METHODS) {
      if (typeof loc[m] !== 'function') continue;
      const orig = loc[m].bind(loc);
      loc[m] = (...args) => wrapLocator(orig(...args));
    }
    return loc;
  };

  const wrapFactoriesOn = (target) => {
    for (const m of CHAIN_METHODS) {
      if (typeof target[m] !== 'function') continue;
      const orig = target[m].bind(target);
      target[m] = (...args) => wrapLocator(orig(...args));
    }
  };

  const wrapFrame = (frame) => {
    if (!frame || frame.__clickThrottleWrapped) return frame;
    frame.__clickThrottleWrapped = true;
    wrapClickMethods(frame);
    wrapFactoriesOn(frame);
    return frame;
  };

  wrapClickMethods(page);
  wrapFactoriesOn(page);

  // Wrap page.mouse.click / .dblclick. `page.mouse.move` and `.wheel` are not
  // clicks so they are left alone.
  if (page.mouse && typeof page.mouse === 'object') {
    for (const m of ['click', 'dblclick']) {
      if (typeof page.mouse[m] !== 'function') continue;
      const orig = page.mouse[m].bind(page.mouse);
      page.mouse[m] = async (...args) => {
        await throttle();
        return orig(...args);
      };
    }
  }

  // Expose the throttle for call sites that intentionally bypass the locator
  // API (e.g. ElementHandle.click(), or `el.evaluate(e => e.click())` running
  // inside the browser). Those paths can `await page.__clickThrottle()` to
  // honour the same floor.
  page.__clickThrottle = throttle;

  if (typeof page.frames === 'function') {
    const origFrames = page.frames.bind(page);
    page.frames = (...args) => origFrames(...args).map(wrapFrame);
  }
  if (typeof page.mainFrame === 'function') {
    const origMain = page.mainFrame.bind(page);
    page.mainFrame = (...args) => wrapFrame(origMain(...args));
  }

  return page;
}

module.exports = { installClickThrottle };
