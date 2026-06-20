/**
 * Pinterest Playwright wrapper.
 *
 * Drives the Pinterest "Create Pin" flow on pinterest.com.
 * Connects to an existing browser (via Dolphin Anty CDP) — does NOT launch one.
 *
 * Usage:
 *   const browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
 *   const page = (browser.contexts()[0].pages()[0]) || (await browser.contexts()[0].newPage());
 *   const pinterest = new PinterestPage(page);
 *   await pinterest.init();
 *   await pinterest.createPin({ imagePath, title, description, link, boardName });
 *
 * Humanization: every click goes through humanClick (multi-step bezier-ish
 * mouse move), every input via humanType (80-250ms per char with random pauses).
 *
 * Selectors are intentionally permissive (multiple fallbacks) because
 * Pinterest's React DOM changes frequently — keep the test scripts handy to
 * update them when Pinterest ships a redesign.
 */

import { Logger } from '../utils/logger.js';

const PINTEREST_URL = 'https://www.pinterest.com';
const CREATE_PIN_URL = 'https://www.pinterest.com/pin-creation-tool/';

// Multi-fallback selectors. Pinterest sprinkles data-test-id attributes
// on most interactive elements; we fall back to text/role when missing.
const SEL = {
  loginForm: 'input[type="email"], input[name="email"]',
  avatar: '[data-test-id="header-profile"], div[data-test-id="user-avatar"], [data-test-id="header-avatar"]',
  // Create button in the top nav
  createButton: 'div[data-test-id="header-create-button"], button:has-text("Create"), [aria-label="Create"]',
  // "Create Pin" option in the dropdown
  createPinLink: 'a[href*="/pin-creation-tool/"], a:has-text("Create Pin"), button:has-text("Create Pin")',
  // File input on Create Pin page (hidden, used by drop zone)
  fileInput: 'input[type="file"]',
  dropZone: '[data-test-id="storyboard-drop-zone"], div[role="button"][aria-label*="drag" i]',

  // Form fields — Pinterest mixes <textarea>, <input>, and contenteditable
  // divs depending on field. The UI is localized (FR/EN/ES/…), so we
  // combine: (1) data-test-id / id when available, (2) placeholder/aria
  // keywords in multiple languages, (3) language-agnostic fallbacks based
  // on element TYPE (input[type=url] for link, only-contenteditable-combobox
  // for description, etc.).
  titleInput: [
    '#pin-draft-title',
    'input[type="text"][placeholder*="title" i]',          // EN
    'input[type="text"][placeholder*="titre" i]',          // FR (older)
    'input[type="text"][placeholder*="Parlez" i]',         // FR (current: "Parlez-nous de votre Épingle")
    'input[type="text"][placeholder*="título" i]',    // ES
    'input[type="text"][aria-label*="title" i]',
    'input[type="text"][aria-label*="titre" i]',
    // Last-resort fallback: any plain text input that is NOT a search/header
    // (header search has role=combobox so we exclude that)
    'input[type="text"]:not([role="combobox"]):not([role="searchbox"])',
  ].join(', '),

  descriptionInput: [
    '#pin-draft-description',
    '[data-test-id="pin-draft-description"] [contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="description" i]',
    'div[contenteditable="true"][aria-label*="Décriv" i]',   // FR "Décrivez"
    'div[contenteditable="true"][aria-label*="Tell" i]',          // EN "Tell us about..."
    // Pinterest FR uses contenteditable + role=combobox for description
    'div[contenteditable="true"][role="combobox"]',
  ].join(', '),

  linkInput: [
    '#pin-draft-link',
    'input[type="url"]',                                   // most reliable, type=url is unambiguous
    'input[type="text"][placeholder*="link" i]',
    'input[type="text"][placeholder*="lien" i]',
    'input[type="text"][placeholder*="enlace" i]',
    'input[aria-label*="link" i]',
    'input[aria-label*="lien" i]',
  ].join(', '),

  altTextInput: [
    'textarea[placeholder*="alt" i]',
    'input[placeholder*="alt" i]',
    'div[contenteditable="true"][aria-label*="alt" i]',
  ].join(', '),

  // Board selector
  boardSelectorButton: '[data-test-id="board-dropdown-select-button"], button:has-text("Choose a board"), button:has-text("Select")',
  boardSearchInput: '[data-test-id="board-dropdown-search-field"], input[placeholder*="Search" i]',
  boardOption: (name) => `div[data-test-id="board-row-${name}"], div:has-text("${name}")`,

  // Publish button (sometimes "Save", sometimes "Publish")
  publishButton: 'button[data-test-id="storyboard-creation-nav-done"], button:has-text("Publish"):not([disabled]), button:has-text("Save"):not([disabled])',

  // Post-publish confirmation
  publishedToast: 'div:has-text("Your Pin is being processed"), div:has-text("Saved to"), div:has-text("Published")',
  publishedPinLink: 'a[href*="/pin/"]',
};

// ── Humanization helpers ────────────────────────────────────────

function rand(min, max) {
  return min + Math.random() * (max - min);
}

async function humanWait(page, min = 800, max = 2500) {
  await page.waitForTimeout(rand(min, max));
}

async function humanType(page, selector, text, { fast = false } = {}) {
  const handle = await page.waitForSelector(selector, { timeout: 15000 });
  await handle.click();
  await page.waitForTimeout(rand(150, 400));
  for (const char of text) {
    await page.keyboard.type(char);
    await page.waitForTimeout(rand(fast ? 30 : 60, fast ? 110 : 220));
    // 5% chance of a longer "thinking" pause
    if (Math.random() < 0.04) await page.waitForTimeout(rand(400, 1200));
  }
}

// Last known cursor position — lets moves start from where we are so the
// path is continuous (not teleporting), and lets idle "wander" stay local.
let _lastMouse = { x: 480, y: 360 };

/**
 * Move the cursor to (x,y) along a curved, jittered path through 1-2
 * intermediate waypoints — never a perfectly straight line. Updates _lastMouse.
 */
async function humanMouseMove(page, x, y) {
  const start = _lastMouse;
  const waypoints = 1 + Math.floor(Math.random() * 2);  // 1-2 mid points
  for (let i = 1; i <= waypoints; i++) {
    const frac = i / (waypoints + 1);
    const wx = start.x + (x - start.x) * frac + (Math.random() - 0.5) * 120;
    const wy = start.y + (y - start.y) * frac + (Math.random() - 0.5) * 120;
    await page.mouse.move(wx, wy, { steps: Math.floor(rand(6, 16)) });
    await page.waitForTimeout(rand(20, 90));
  }
  await page.mouse.move(x, y, { steps: Math.floor(rand(8, 20)) });
  _lastMouse = { x, y };
}

/** Small, aimless cursor drift — used during idle/reading to look alive. */
async function humanMouseWander(page) {
  const moves = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < moves; i++) {
    const x = Math.max(5, _lastMouse.x + (Math.random() - 0.5) * 220);
    const y = Math.max(5, _lastMouse.y + (Math.random() - 0.5) * 220);
    await page.mouse.move(x, y, { steps: Math.floor(rand(5, 14)) });
    _lastMouse = { x, y };
    await page.waitForTimeout(rand(150, 600));
  }
}

async function humanClick(page, target) {
  // target can be a selector string or an ElementHandle / Locator
  let handle;
  if (typeof target === 'string') {
    handle = await page.waitForSelector(target, { timeout: 15000 });
  } else if (target && typeof target.boundingBox === 'function') {
    handle = target;
  } else {
    throw new Error('humanClick: invalid target');
  }
  const box = await handle.boundingBox();
  if (!box) {
    await handle.click();
    return;
  }
  const targetX = box.x + box.width * (0.3 + Math.random() * 0.4);
  const targetY = box.y + box.height * (0.3 + Math.random() * 0.4);
  await humanMouseMove(page, targetX, targetY);
  await page.waitForTimeout(rand(80, 240));
  await page.mouse.click(targetX, targetY);
}

/** Distance-based scroll (kept for createPin warmup callers). */
async function humanScroll(page, totalDistance = 1200) {
  let scrolled = 0;
  while (scrolled < totalDistance) {
    const step = rand(180, 480);
    await page.mouse.wheel(0, step);
    scrolled += step;
    await page.waitForTimeout(rand(400, 1100));
  }
}

/**
 * Scroll for a DURATION with irregular speed: bursts of 1-4 wheel ticks of
 * varying size, uneven reading pauses between bursts, and the occasional
 * micro up-scroll (re-reading something that scrolled past).
 */
async function humanScrollFor(page, seconds, { irregular = true } = {}) {
  const end = Date.now() + Math.max(0, seconds) * 1000;
  while (Date.now() < end) {
    const burst = 1 + Math.floor(Math.random() * 4);
    for (let i = 0; i < burst && Date.now() < end; i++) {
      const step = irregular ? rand(120, 680) : rand(180, 480);
      await page.mouse.wheel(0, step);
      await page.waitForTimeout(rand(120, 520));
    }
    await page.waitForTimeout(rand(500, 2600));            // reading pause between bursts
    if (irregular && Math.random() < 0.15) {               // occasional re-look up
      await page.mouse.wheel(0, -rand(80, 280));
      await page.waitForTimeout(rand(300, 900));
    }
  }
}

// ── PinterestPage class ────────────────────────────────────────

export class PinterestPage {
  constructor(page) {
    this.page = page;
  }

  /** Verify the page is on pinterest.com and logged in; navigate home if needed. */
  async init() {
    const url = this.page.url();
    if (!url.includes('pinterest.com')) {
      await this.page.goto(PINTEREST_URL, { waitUntil: 'domcontentloaded' });
    }
    await humanWait(this.page, 2000, 4000);
    await this.ensureLoggedIn();
  }

  async ensureLoggedIn() {
    // Robust detection: Pinterest changes data-test-id values often, so we
    // check MULTIPLE signals and only throw if the LOGIN form is clearly
    // visible (positive signal of "not logged in") rather than requiring
    // a specific avatar selector to match. URL-based heuristic too.
    const state = await this.page.evaluate(() => {
      // Login form: visible email/password input prompting to sign in
      const loginInputs = document.querySelectorAll(
        'input[type="email"]:not([style*="display:none"]), ' +
        'input[name="email"], ' +
        'input[id="email"]'
      );
      const hasVisibleLoginInput = Array.from(loginInputs).some(i => i.offsetWidth > 0 && i.offsetHeight > 0);
      // Login URL paths
      const path = location.pathname.toLowerCase();
      const onLoginPage = path === '/login' || path === '/login/' || path.startsWith('/signup');
      // Multiple logged-in indicators (any one = logged in)
      const loggedInSignals = [
        '[data-test-id="header-profile"]',
        '[data-test-id="user-avatar"]',
        '[data-test-id="header-avatar"]',
        '[data-test-id="header-create-button"]',
        '[data-test-id="header-create"]',
        'button[aria-label*="Create" i]',
        'button[aria-label*="Créer" i]',
        'a[href="/pin-builder/"]',
        'a[href*="/business/hub"]',
        '[data-test-id="profileMenuButton"]',
        'header [aria-label*="profile" i]',
        'header [aria-label*="profil" i]',
      ];
      const loggedInHits = loggedInSignals.filter(s => document.querySelector(s)).length;
      return { hasVisibleLoginInput, onLoginPage, loggedInHits, url: location.href };
    });
    // Throw ONLY if positive evidence of not-logged-in (login form visible OR on /login path).
    // Avatar check is now optional (Pinterest renames testids without notice).
    if (state.hasVisibleLoginInput || state.onLoginPage) {
      throw new Error(`Pinterest is not logged in for this profile (login form visible at ${state.url}). Open the Dolphin profile manually, log in to Pinterest, then re-run.`);
    }
    Logger.info(`[Pinterest] Logged in (${state.loggedInHits} signals matched)`);
  }

  /**
   * Warm-up before posting: scroll the feed, optionally click a random pin.
   * Mimics human "browsing" behavior to look less bot-like.
   */
  async warmup({ scrollSeconds = 30, clickRandomPin = false } = {}) {
    Logger.info(`[Pinterest] Warming up (~${scrollSeconds}s)`);
    const startTime = Date.now();
    while ((Date.now() - startTime) / 1000 < scrollSeconds) {
      await humanScroll(this.page, rand(300, 800));
      await humanWait(this.page, 1500, 4000);
    }
    if (clickRandomPin && Math.random() < 0.5) {
      try {
        const pins = await this.page.$$('[data-test-id="pin"]');
        if (pins.length > 0) {
          const target = pins[Math.floor(Math.random() * Math.min(pins.length, 8))];
          await humanClick(this.page, target);
          await humanWait(this.page, 4000, 8000);
          await this.page.goBack();
          await humanWait(this.page, 2000, 4000);
        }
      } catch (e) {
        Logger.debug('[Pinterest] warmup click skipped:', e.message);
      }
    }
  }

  /**
   * Replay a list of simulator events as real Playwright actions.
   *
   * Each event has { t, action, detail }. Time gaps between events are
   * computed from `t` deltas — we await `event[i+1].t - event[i].t` seconds
   * between actions, capped at a reasonable max so the session never hangs
   * if the simulator produced a very long wait.
   *
   * Robustness: every action is wrapped in try/catch + Logger.warn. If a
   * Pinterest selector changes, the session continues with the next event
   * rather than aborting. This means a partial session is still useful as
   * a "human warmup" even when Pinterest updates their UI.
   *
   * @param {object} opts
   * @param {Array<{t:number, action:string, detail:string}>} opts.events
   * @param {Array<string>} [opts.boards] - candidate board names for save
   * @param {number} [opts.maxWaitSeconds=10] - cap per-step wait
   */
  async humanBrowseSession({ events, boards = [], maxWaitSeconds = 90 }) {
    Logger.info(`[Pinterest] humanBrowseSession starting (${events?.length || 0} events)`);
    if (!events || events.length === 0) return { executed: 0 };

    // Force navigation to the consumer home feed — business accounts otherwise
    // land on business.pinterest.com/hub/ which has no pin feed to browse.
    await this._ensureOnHomeFeed();

    let executed = 0;
    const fails = [];
    const startedAt = Date.now();

    for (const e of events) {
      // Each event carries its own dwell time (durSec) — the executor honors
      // it (capped at maxWaitSeconds) so sessions actually last the planned
      // 3-20 min. Legacy events without durSec fall back to a 1s pause.
      const dur = Math.min(maxWaitSeconds, Math.max(0, Number(e.durSec ?? 1)));
      try {
        await this._executeBrowseAction(e, { boards, durSec: dur });
        executed++;
      } catch (err) {
        Logger.warn(`[Pinterest] event "${e.action}" failed: ${err.message}`);
        fails.push({ action: e.action, detail: e.detail, error: err.message });
      }
    }

    const realMin = ((Date.now() - startedAt) / 60000).toFixed(1);
    Logger.info(`[Pinterest] humanBrowseSession done — ${executed}/${events.length} executed, ${fails.length} skipped, ${realMin} min real`);
    return { executed, failed: fails.length, fails };
  }

  /**
   * Dispatch a single browse event to the appropriate Playwright action.
   */
  async _executeBrowseAction(event, { boards, durSec = 1 }) {
    const { action, detail } = event;
    const dwellMs = Math.max(0, durSec * 1000);
    switch (action) {
      case 'open':
        await this.page.waitForTimeout(dwellMs);
        return;
      case 'wait':
        // Reading / settling pause — tiny cursor drift to look alive
        if (event.reading) { try { await humanMouseWander(this.page); } catch {} }
        await this.page.waitForTimeout(dwellMs);
        return;
      case 'idle':
        // Distracted — small aimless wander, then sit idle
        try { await humanMouseWander(this.page); } catch {}
        await this.page.waitForTimeout(dwellMs);
        return;
      case 'scroll':
        // Scroll for the planned DURATION with irregular speed + reading pauses
        await humanScrollFor(this.page, durSec, { irregular: event.irregular !== false });
        return;
      case 'backtrack':
        // Scroll back UP to re-look at something that passed
        try { await this.page.mouse.wheel(0, -rand(200, 650)); } catch {}
        await this.page.waitForTimeout(dwellMs);
        return;
      case 'closeup': {
        const pin = await this._pickRandomVisiblePin();
        if (!pin) throw new Error('no visible pin in feed');
        await humanClick(this.page, pin);
        // Detail loads here; the long "read title/description" pause is the
        // separate 'wait' event that follows in the plan.
        await this.page.waitForTimeout(dwellMs);
        return;
      }
      case 'zoom': {
        // Examine the image up close — move over it (some pins hover-zoom),
        // then dwell. Best-effort: never throws if the image isn't found.
        try {
          const img = await this.page.$('div[data-test-id="closeup-image"] img, [data-test-id="pin-closeup-image"] img, img[elementtiming]');
          if (img) { const b = await img.boundingBox(); if (b) await humanMouseMove(this.page, b.x + b.width / 2, b.y + b.height / 2); }
        } catch {}
        try { await humanMouseWander(this.page); } catch {}
        await this.page.waitForTimeout(Math.max(0, dwellMs - 800));
        return;
      }
      case 'save': {
        // boardHint = the searched recipe's category (set by the simulator).
        let boardName = event.boardHint;
        if (!boardName) {
          if (boards.length === 0) return; // skip silently
          boardName = boards[Math.floor(Math.random() * boards.length)];
        }
        await this._tryClickSave(boardName);   // has its own internal waits
        return;
      }
      case 'search': {
        const keyword = event.keyword || (detail || '').match(/"([^"]+)"/)?.[1] || 'easy recipes';
        await this._performSearch(keyword);    // has its own internal waits
        return;
      }
      case 'video':
        await this.page.waitForTimeout(dwellMs);  // video autoplays while in view
        return;
      case 'visit':
        // Open the external blog in a new tab and LEAVE it idle (the following
        // 'idle' event provides the dwell; tab is cleaned up at session end).
        await this._tryClickVisit({ leaveOpen: true });
        return;
      case 'hesitate': {
        // Move toward a pin, pause, then DON'T click (not every move engages)
        try {
          const pin = await this._pickRandomVisiblePin();
          if (pin) { const b = await pin.boundingBox(); if (b) await humanMouseMove(this.page, b.x + b.width * 0.5, b.y + b.height * 0.4); }
        } catch {}
        await this.page.waitForTimeout(dwellMs);
        return;
      }
      case 'profile':
        await this._navigateToProfile();          // navigates + scrolls (~6s)
        await this.page.waitForTimeout(Math.max(0, dwellMs - 6000));
        return;
      case 'back':
        try { await this.page.goBack({ timeout: 8000 }); } catch {}
        await this.page.waitForTimeout(dwellMs);
        return;
      case 'close':
        // Caller will close browser; do nothing here
        return;
      default:
        Logger.debug(`[Pinterest] unknown event action: ${action}`);
    }
  }

  /**
   * Make sure the page is on the personal home feed (the masonry pin grid),
   * NOT on the business dashboard (analytics) which has no pins to browse.
   *
   * For business accounts, www.pinterest.com/ may auto-redirect to
   * business.pinterest.com/hub/. We detect that and click the Pinterest logo
   * (or navigate to a known consumer URL) to switch to the personal view.
   */
  async _ensureOnHomeFeed() {
    // Always navigate explicitly — even if already on pinterest.com, we may be
    // on the wrong sub-page (business hub, profile, search, etc.)
    await this.page.goto(PINTEREST_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await humanWait(this.page, 2000, 4000);

    // If we landed on business hub, switch to consumer view
    const url = this.page.url();
    const onBusiness = url.includes('business.pinterest.com') || url.includes('/business/');
    const hasFeed = await this.page.$('[data-test-id="pin"], div[role="listitem"] a[href*="/pin/"]');

    if (onBusiness || !hasFeed) {
      Logger.info(`[Pinterest] Not on consumer feed (url=${url}). Switching…`);
      // Strategy 1: click the Pinterest logo / "Home" link in the top nav
      const switched = await this.page.evaluate(() => {
        const candidates = [
          'a[data-test-id="pinterest-logo"]',
          'a[href="/"][aria-label*="Pinterest" i]',
          'a[data-test-id="header-home-btn"]',
          'div[data-test-id="header-home-button"] a',
          'a[href="/"]',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return sel; }
        }
        return null;
      });
      if (switched) {
        Logger.info(`[Pinterest] Clicked: ${switched}`);
        await humanWait(this.page, 3000, 5000);
      }
      // Strategy 2: hard navigate to a URL that always renders consumer feed
      if (!(await this.page.$('[data-test-id="pin"], div[role="listitem"] a[href*="/pin/"]'))) {
        Logger.info(`[Pinterest] Still no feed — hard nav to /ideas/`);
        await this.page.goto('https://www.pinterest.com/ideas/', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await humanWait(this.page, 2500, 4500);
      }
    }

    const finalUrl = this.page.url();
    Logger.info(`[Pinterest] Browse will run on: ${finalUrl}`);
  }

  /**
   * Pick a random pin element visible in the current viewport.
   * Tries multiple selectors — Pinterest changes them across redesigns.
   * Logs candidate counts if nothing matches (diagnostic for missing pins).
   */
  async _pickRandomVisiblePin() {
    // Multiple selector fallbacks (Pinterest 2026 redesigns)
    const selectors = [
      '[data-test-id="pin"]',
      '[data-test-id="pinrep"]',
      'div[data-test-id="pinrep"]',
      'div[role="listitem"] a[href*="/pin/"]',
      'a[href*="/pin/"][role="link"]',
      'div[data-grid-item="true"] a[href*="/pin/"]',
      'div[data-test-pin-id]',
    ];
    let candidates = [];
    let matchedSelector = '';
    for (const sel of selectors) {
      const found = await this.page.$$(sel).catch(() => []);
      if (found.length > 0) {
        candidates = found;
        matchedSelector = sel;
        break;
      }
    }
    if (candidates.length === 0) {
      // Diagnostic — log selector counts for visibility
      const counts = await this.page.evaluate(sels => {
        const out = {};
        for (const s of sels) out[s] = document.querySelectorAll(s).length;
        return out;
      }, selectors).catch(() => ({}));
      Logger.warn(`[Pinterest] no pins matched any selector. Counts: ${JSON.stringify(counts)}`);
      return null;
    }
    Logger.debug(`[Pinterest] pin candidates: ${candidates.length} via "${matchedSelector}"`);
    const visible = [];
    for (const el of candidates) {
      const box = await el.boundingBox().catch(() => null);
      if (!box) continue;
      if (box.y < 0 || box.y > 1200) continue;       // skip off-screen (viewport up to ~1200px)
      if (box.width < 100 || box.height < 100) continue;
      visible.push(el);
    }
    if (visible.length === 0) {
      Logger.warn(`[Pinterest] found ${candidates.length} pin candidates but none visible in viewport (need to scroll first?)`);
      return null;
    }
    return visible[Math.floor(Math.random() * Math.min(visible.length, 6))];
  }

  /**
   * On a pin detail page, click "Save" and pick a board by name (partial match).
   * Best-effort — fails silently if Pinterest changes selectors.
   */
  async _tryClickSave(boardName) {
    const saveBtn = await this.page.$('button:has-text("Save"), button[data-test-id="board-pick-button"], div[data-test-id="board-dropdown-select-button"]');
    if (!saveBtn) {
      Logger.debug('[Pinterest] save button not found, skipping');
      return;
    }
    await humanClick(this.page, saveBtn);
    await humanWait(this.page, 800, 1600);

    // Sometimes a board picker dropdown appears
    const picked = await this.page.evaluate((name) => {
      const lower = String(name).toLowerCase();
      const rows = document.querySelectorAll('div[role="option"], div[data-test-id^="board-row"], li');
      for (const row of rows) {
        if ((row.textContent || '').toLowerCase().includes(lower)) {
          row.click();
          return true;
        }
      }
      return false;
    }, boardName);
    if (!picked) {
      // No picker — Pinterest may have saved to default board already
      Logger.debug(`[Pinterest] board picker not visible for "${boardName}", saved to default`);
    }
    await humanWait(this.page, 1500, 3000);
  }

  /**
   * Type a query in the search bar, press Enter, scroll results briefly.
   */
  async _performSearch(keyword) {
    // Pinterest now COLLAPSES the search bar into a button — the input doesn't
    // exist in the DOM until you click the search trigger. Click it first.
    let searchInput = await this.page.$('input[name="searchBoxInput"], input[data-test-id="search-box-input"]');
    if (!searchInput) {
      try {
        const trigger = await this.page.$('[data-test-id="search-box-container"], button[aria-label="Search icon"], button[aria-label*="recherch" i]');
        if (trigger) { await humanClick(this.page, trigger); await humanWait(this.page, 500, 1000); }
      } catch {}
      searchInput = await this.page.$('input[name="searchBoxInput"], input[data-test-id="search-box-input"], input[placeholder*="Search" i], input[placeholder*="Rechercher" i], input[aria-label*="Search" i], input[aria-label*="Rechercher" i], input[type="search"]');
    }
    if (!searchInput) {
      Logger.warn(`[Pinterest] search input not found for "${keyword}" (after clicking trigger) — URL: ${this.page.url()}`);
      return;
    }
    await humanClick(this.page, searchInput);
    await humanWait(this.page, 300, 700);
    // Clear any existing text
    try { await this.page.keyboard.press('Control+A'); await this.page.keyboard.press('Backspace'); } catch {}
    for (const ch of keyword) {
      await this.page.keyboard.type(ch);
      await this.page.waitForTimeout(rand(60, 200));
    }
    await humanWait(this.page, 400, 900);
    await this.page.keyboard.press('Enter');
    await humanWait(this.page, 3000, 6000);
    // Scroll results a bit
    try { await humanScroll(this.page, rand(600, 1400)); } catch {}
  }

  /**
   * On a pin detail page, click the "Visit" external link.
   */
  async _tryClickVisit({ leaveOpen = false } = {}) {
    const btn = await this.page.$('a[data-test-id="pin-closeup-clickthrough"], a:has-text("Visit"), a:has-text("Visiter")');
    if (!btn) {
      Logger.debug('[Pinterest] visit button not found');
      return;
    }
    const popupPromise = this.page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await humanClick(this.page, btn);
    const popup = await popupPromise;
    if (popup && !leaveOpen) {
      await popup.waitForTimeout(rand(5000, 12000));
      try { await popup.close(); } catch {}
    }
    // leaveOpen: the blog tab stays open and idle (a natural "I'll read it
    // later" signal); it's cleaned up when the browser closes at session end.
  }

  async _navigateToProfile() {
    // Pinterest profile URL is /<username>/. Try clicking the avatar in header.
    const avatar = await this.page.$('[data-test-id="header-profile"], [data-test-id="header-avatar"], div[data-test-id="user-avatar"]');
    if (avatar) {
      try {
        await humanClick(this.page, avatar);
        await humanWait(this.page, 2500, 5000);
        try { await humanScroll(this.page, rand(500, 1200)); } catch {}
        return;
      } catch (e) {
        Logger.debug('[Pinterest] avatar click failed: ' + e.message);
      }
    }
    Logger.debug('[Pinterest] avatar not found, skipping profile glance');
  }

  /**
   * Open the Create Pin form. Tries the direct URL first; falls back to the
   * top-nav "Create" button if the URL goes through a redirect.
   */
  async openCreatePin() {
    Logger.info('[Pinterest] Opening Create Pin');
    try {
      await this.page.goto(CREATE_PIN_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) {
      Logger.warn(`[Pinterest] direct URL failed (${e.message.split('\n')[0]}), trying nav button`);
      await humanClick(this.page, SEL.createButton);
      await humanWait(this.page, 800, 1800);
      await humanClick(this.page, SEL.createPinLink);
    }
    // Wait for the file input or drop zone
    await Promise.race([
      this.page.waitForSelector(SEL.fileInput, { state: 'attached', timeout: 15000 }),
      this.page.waitForSelector(SEL.dropZone, { timeout: 15000 }),
    ]);
    await humanWait(this.page, 800, 1600);
    Logger.info('[Pinterest] Create Pin form ready');
  }

  /** Upload an image via the file input (works even when hidden by drop zone). */
  async uploadImage(imagePath) {
    Logger.info(`[Pinterest] Uploading image: ${imagePath}`);
    const input = await this.page.waitForSelector(SEL.fileInput, { state: 'attached', timeout: 15000 });
    await input.setInputFiles(imagePath);
    // Pinterest processes the upload — usually 3-10s before the preview shows
    await humanWait(this.page, 4000, 8000);
    Logger.info('[Pinterest] Image upload submitted (waiting for processing)');
  }

  /**
   * Dump all editable elements (inputs, textareas, contenteditable divs)
   * on the current page. Used to debug when Pinterest changes selectors.
   * Returns an array of { tag, id, type, name, placeholder, aria, dataTestId, role, contentEditable, classes, boundingBox }
   */
  async diagnoseFields() {
    return await this.page.evaluate(() => {
      const candidates = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="file"]), textarea, [contenteditable="true"], [role="textbox"]'
      );
      return Array.from(candidates).map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || '',
          aria: el.getAttribute('aria-label') || '',
          dataTestId: el.getAttribute('data-test-id') || '',
          role: el.getAttribute('role') || '',
          contentEditable: el.getAttribute('contenteditable') || '',
          classes: (el.className || '').toString().slice(0, 80),
          visible: r.width > 0 && r.height > 0,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        };
      }).filter(f => f.visible);
    });
  }

  /** Fill all the text fields. board is selected separately. */
  async fillFields({ title, description, link, altText }) {
    // Diagnose: log what fields we actually see (helpful when Pinterest changes the DOM)
    const fields = await this.diagnoseFields();
    Logger.info(`[Pinterest] ${fields.length} editable fields detected on page:`);
    fields.forEach((f, i) => {
      const label = f.aria || f.placeholder || f.dataTestId || f.id || `(no-label)`;
      Logger.info(`  [${i}] <${f.tag}${f.type ? ' type=' + f.type : ''}${f.contentEditable ? ' contenteditable' : ''}${f.role ? ' role=' + f.role : ''}> ${label} — @ y=${f.y} h=${f.h}`);
    });

    if (title) {
      Logger.info(`[Pinterest] Typing title: "${title.slice(0, 60)}"`);
      await humanType(this.page, SEL.titleInput, title);
      await humanWait(this.page, 700, 1500);
    }
    if (description) {
      Logger.info(`[Pinterest] Typing description (${description.length} chars)`);
      await humanType(this.page, SEL.descriptionInput, description);
      await humanWait(this.page, 700, 1500);
    }
    if (link) {
      Logger.info(`[Pinterest] Typing link: ${link}`);
      await humanType(this.page, SEL.linkInput, link, { fast: true });
      await humanWait(this.page, 700, 1500);
    }
    if (altText) {
      try {
        Logger.info(`[Pinterest] Typing alt text`);
        await humanType(this.page, SEL.altTextInput, altText);
        await humanWait(this.page, 500, 1200);
      } catch (e) {
        Logger.debug('[Pinterest] alt text field not present, skipping');
      }
    }
  }

  /**
   * Open the board dropdown and pick the board by name (or partial match).
   * If boardName is null, picks the first available board.
   */
  async selectBoard(boardName) {
    Logger.info(`[Pinterest] Selecting board: ${boardName || '(first available)'}`);
    await humanClick(this.page, SEL.boardSelectorButton);
    await humanWait(this.page, 800, 1500);

    if (boardName) {
      // Search the dropdown by typing the name
      try {
        await humanType(this.page, SEL.boardSearchInput, boardName, { fast: true });
        await humanWait(this.page, 600, 1200);
      } catch (e) {
        Logger.debug('[Pinterest] board search field not found, will scroll');
      }
      // Try to click a board matching the name
      const clicked = await this.page.evaluate((name) => {
        const lname = name.toLowerCase();
        const rows = document.querySelectorAll('div[role="option"], div[data-test-id^="board-row"], li');
        for (const row of rows) {
          if ((row.textContent || '').toLowerCase().includes(lname)) {
            row.click();
            return true;
          }
        }
        return false;
      }, boardName);
      if (!clicked) throw new Error(`Board "${boardName}" not found in dropdown`);
    } else {
      // First available
      const clicked = await this.page.evaluate(() => {
        const row = document.querySelector('div[role="option"], div[data-test-id^="board-row"], li');
        if (row) { row.click(); return true; }
        return false;
      });
      if (!clicked) throw new Error('No boards found in dropdown');
    }
    await humanWait(this.page, 700, 1400);
  }

  /** Click Publish and wait for confirmation. Returns the published pin URL if detectable. */
  async publish() {
    Logger.info('[Pinterest] Clicking Publish');
    await humanClick(this.page, SEL.publishButton);
    // Wait up to 30s for the published confirmation
    try {
      await this.page.waitForSelector(SEL.publishedToast, { timeout: 30000 });
      Logger.info('[Pinterest] ✓ Published confirmation toast shown');
    } catch {
      Logger.warn('[Pinterest] No confirmation toast appeared — pin may still have been published');
    }
    await humanWait(this.page, 2000, 4000);
    // Try to grab the pin URL from the page or from a "See your pin" link
    try {
      const href = await this.page.evaluate(() => {
        const a = document.querySelector('a[href*="/pin/"]');
        return a ? a.href : null;
      });
      if (href) Logger.info(`[Pinterest] Pin URL: ${href}`);
      return href;
    } catch {
      return null;
    }
  }

  /**
   * Add Pinterest interest tags to the current pin. Pinterest only accepts
   * tags from its predefined catalog — typed text triggers a suggestion
   * dropdown, and you must click an existing suggestion.
   *
   * Strategy per tag:
   *   1. Focus the "Search for a tag" combobox
   *   2. Clear any prior text + type the tag slowly
   *   3. Wait 700-1100ms for suggestions to populate
   *   4. Click the FIRST visible suggestion (closest match by Pinterest's ranking)
   *   5. If no suggestion appears → press Escape, skip this tag, log it
   *
   * Returns { added, skipped, reason? }.
   */
  async addTags(tags) {
    if (!tags || tags.length === 0) return { added: 0, skipped: 0 };
    const tagInput = await this.page.$('input[role="combobox"][placeholder*="tag" i], input[placeholder*="Search for a tag" i], input[placeholder*="Rechercher un tag" i]');
    if (!tagInput) {
      Logger.warn('[Pinterest] tag combobox not found — skipping all tags');
      return { added: 0, skipped: tags.length, reason: 'no-input' };
    }
    let added = 0, skipped = 0;
    const addedList = [];
    const skippedList = [];
    for (const tagRaw of tags) {
      const tag = String(tagRaw || '').trim();
      if (!tag) continue;
      try {
        await humanClick(this.page, tagInput);
        await humanWait(this.page, 200, 450);
        // Clear any prior text
        try {
          await this.page.keyboard.press('Control+A');
          await this.page.keyboard.press('Backspace');
        } catch {}
        // Type the tag with human-ish cadence
        for (const ch of tag) {
          await this.page.keyboard.type(ch);
          await this.page.waitForTimeout(rand(40, 110));
        }
        // Wait for the suggestion dropdown to populate
        await humanWait(this.page, 700, 1100);
        // Click the first VISIBLE suggestion option
        const clicked = await this.page.evaluate(() => {
          const candidates = document.querySelectorAll('div[role="option"], li[role="option"], button[role="option"], div[data-test-id^="topic-suggestion"]');
          for (const c of candidates) {
            if (c.offsetWidth === 0 || c.offsetHeight === 0) continue;
            const text = (c.textContent || '').trim();
            if (!text || text.length > 80) continue;
            c.click();
            return text;
          }
          return null;
        });
        if (clicked) {
          Logger.info(`[Pinterest] ✓ tag added: "${clicked}"`);
          added++;
          addedList.push(clicked);
        } else {
          Logger.info(`[Pinterest] ✗ tag skipped (no Pinterest suggestion): "${tag}"`);
          try { await this.page.keyboard.press('Escape'); } catch {}
          skipped++;
          skippedList.push(tag);
        }
        await humanWait(this.page, 300, 600);
      } catch (e) {
        Logger.warn(`[Pinterest] tag error for "${tag}": ${e.message}`);
        skipped++;
        skippedList.push(tag);
      }
    }
    Logger.info(`[Pinterest] Tags result: ${added} added (${addedList.join(', ')}) · ${skipped} skipped${skippedList.length ? ' (' + skippedList.join(', ') + ')' : ''}`);
    return { added, skipped, addedList, skippedList };
  }

  /**
   * Full pipeline for one pin. Returns { ok: true, pinUrl } or throws.
   */
  async createPin({ imagePath, title, description, link, boardName, altText, tags, warmup = true }) {
    if (warmup) await this.warmup({ scrollSeconds: rand(20, 45) });
    await this.openCreatePin();
    await this.uploadImage(imagePath);
    await this.fillFields({ title, description, link, altText });
    // Add tags BEFORE board selection (the tag combobox lives in the same
    // form panel; selectBoard switches to a different modal/panel).
    if (Array.isArray(tags) && tags.length > 0) {
      await this.addTags(tags);
    }
    await this.selectBoard(boardName);
    const pinUrl = await this.publish();
    return { ok: true, pinUrl };
  }
}
