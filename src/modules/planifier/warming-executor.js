/**
 * Warming Executor — runs a "warming" Pinterest session.
 *
 * Different from a normal pinterest-session in 3 ways:
 *   1. Longer total session (15-25 min vs 8-15)
 *   2. CATEGORY-FOCUSED cycles: for each cycle, pick a random category from
 *      the site's wpCategories ("Breakfast, Lunch, Dinner, Dessert"),
 *      search Pinterest for it, scroll, click pins, and save 1-2 to the
 *      same-name Pinterest board ("Dinner" → board "Dinner"). This builds
 *      a coherent topical interest graph for the account that mirrors the
 *      site's content structure.
 *   3. (Future) Generate + post ONE warming pin with no outbound link to
 *      reinforce the "real food enthusiast" signal. Wired in next iteration.
 *
 * Setup requirements (per Pinterest account, user does manually once):
 *   - Pinterest boards named EXACTLY like the site's wpCategories
 *     (case-insensitive partial match — "dinner", "Dinner", "Dinner Ideas"
 *     all work, but having the exact name is cleanest).
 *
 * Recipe pipeline for the site continues normally during warming. The
 * difference is only the Pinterest action behavior.
 *
 * Called by action-executor when item.type === 'warming-session'.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../shared/utils/logger.js';
import { DolphinAnty } from '../../shared/utils/dolphin-anty.js';
import { PinterestPage } from '../../shared/pages/pinterest.js';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

const SESSION_MIN_MINUTES = 15;
const SESSION_MAX_MINUTES = 25;
// Each cycle = 1 category search + closeups + saves. User wants exactly 2
// distinct categories searched per warming (= 2 "recipes" looked at), to keep
// activity light and varied. The no-replacement pool below ensures the 2
// cycles always pick DIFFERENT categories.
const CYCLES_PER_SESSION_MIN = 2;
const CYCLES_PER_SESSION_MAX = 2;
const SAVES_PER_CYCLE_MIN = 1;
const SAVES_PER_CYCLE_MAX = 2;
const CLOSEUPS_PER_CYCLE_MIN = 2;
const CLOSEUPS_PER_CYCLE_MAX = 4;

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * Scroll the page in human-like bursts for ~N seconds total.
 * Uses page.mouse.wheel() — works without requiring the local humanScroll
 * helper defined in pinterest.js (which isn't exported).
 */
async function _scrollFor(page, totalSeconds) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) / 1000 < totalSeconds) {
    try {
      const pixels = randInt(300, 800);
      await page.mouse.wheel(0, pixels);
    } catch {}
    await page.waitForTimeout(randInt(1200, 3500));
  }
}

async function _resolveDolphinSettings() {
  const { Planifier } = await import('./planifier.js');
  const planCfg = await Planifier.getConfig();
  if (planCfg?.dolphinAnty?.apiToken) return { dolphinAnty: planCfg.dolphinAnty };
  throw new Error('No Dolphin token configured.');
}

async function _connectDolphin(profileId) {
  const settings = await _resolveDolphinSettings();
  const dolphin = new DolphinAnty(settings);
  Logger.info(`[Warming] Dolphin starting profile ${profileId}...`);
  const { port } = await dolphin.startAndGetCDP(profileId);
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { await dolphin.stopProfile(profileId); } catch (e) { Logger.warn(`[Warming] stopProfile failed: ${e.message}`); }
  };
  return { page, cleanup };
}

/**
 * Read the site's wpCategories from settings.json and parse into an array
 * of trimmed category names. Returns [] if absent.
 */
async function _loadSiteCategories(siteId) {
  try {
    const path = join(PROJECT_ROOT, 'data', 'sites', siteId, 'settings.json');
    const raw = await readFile(path, 'utf8');
    const settings = JSON.parse(raw);
    const csv = settings.wpCategories || '';
    return csv.split(',').map(s => s.trim()).filter(Boolean);
  } catch (e) {
    Logger.warn(`[Warming] Could not load categories for ${siteId}: ${e.message}`);
    return [];
  }
}

/**
 * Run ONE category cycle:
 *   - search Pinterest for the category name
 *   - scroll the results
 *   - close-up N random pins, linger on each
 *   - save 1-2 of them to the same-name board
 *   - go back to feed
 *
 * Best-effort: individual step failures are logged but don't abort the cycle.
 */
async function _runCategoryCycle(pinterest, page, category, opts = {}) {
  const closeupsTarget = randInt(opts.closeupsMin || CLOSEUPS_PER_CYCLE_MIN, opts.closeupsMax || CLOSEUPS_PER_CYCLE_MAX);
  const savesTarget = randInt(opts.savesMin || SAVES_PER_CYCLE_MIN, opts.savesMax || SAVES_PER_CYCLE_MAX);
  const targetBoard = opts.boardName || category;
  let savesDone = 0;
  let closeupsDone = 0;

  Logger.info(`[Warming] Cycle for "${category}" → ${closeupsTarget} closeups, target ${savesTarget} saves`);

  // Navigate DIRECTLY to the search URL — much more reliable than typing
  // into the search box (which can be hidden on profile pages, blocked by
  // CF, or have changing selectors).
  const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(category)}&rs=typed`;
  try {
    Logger.info(`[Warming] Navigating to search: ${category}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(randInt(3000, 5500));
  } catch (e) {
    Logger.warn(`[Warming] search nav for "${category}" failed: ${e.message}`);
    return { category, closeups: 0, saves: 0 };
  }

  // Diagnostic: count pin candidates on the results page
  const pinCount = await page.evaluate(() => {
    const sels = ['[data-test-id="pin"]', 'div[role="listitem"] a[href*="/pin/"]', 'a[href*="/pin/"]', 'div[data-test-id="pinrep"]'];
    const counts = {};
    for (const s of sels) counts[s] = document.querySelectorAll(s).length;
    return counts;
  }).catch(() => ({}));
  Logger.info(`[Warming] Pin selectors on results page: ${JSON.stringify(pinCount)}`);

  // Scroll the results page a bit before clicking
  await _scrollFor(page, randInt(20, 50));

  for (let i = 0; i < closeupsTarget; i++) {
    let pin;
    try {
      pin = await pinterest._pickRandomVisiblePin();
    } catch (e) {
      Logger.warn(`[Warming] pickRandomVisiblePin failed: ${e.message}`);
    }
    if (!pin) break;

    try {
      await pin.click({ timeout: 5000 });
      closeupsDone++;
      // Linger (12-30s — reading the pin description, ratings, comments)
      await page.waitForTimeout(randInt(12000, 30000));

      // Maybe save to the category's board
      if (savesDone < savesTarget && Math.random() < 0.85) {
        try {
          await pinterest._tryClickSave(targetBoard);
          savesDone++;
          Logger.info(`[Warming] Saved a pin to board "${targetBoard}"`);
        } catch (e) {
          Logger.warn(`[Warming] save to "${targetBoard}" failed: ${e.message}`);
        }
      }

      // Back to results
      try { await page.goBack({ timeout: 8000 }); } catch {}
      await page.waitForTimeout(randInt(1500, 3500));
      // Small scroll between closeups (3-7s of natural scrolling)
      await _scrollFor(page, randInt(3, 7));
    } catch (e) {
      Logger.warn(`[Warming] closeup-cycle iter ${i} failed: ${e.message}`);
    }
  }

  return { category, closeups: closeupsDone, saves: savesDone };
}

/**
 * Run one warming session end-to-end.
 *
 * @param {object} item - planifier item (must have site, accountId, dolphinProfileId)
 * @param {object} config - planifier full config
 * @returns {Promise<{ok, cycles, totalSaves, totalCloseups, durationMin}>}
 */
export async function runWarmingSession(item, config) {
  const site = config.sites?.[item.site];
  if (!site) throw new Error(`Site ${item.site} not in planifier config`);
  const account = (site.pinterestAccounts || []).find(a => a.id === item.accountId);
  if (!account) throw new Error(`Account ${item.accountId} not found in ${item.site}`);
  const profileId = item.dolphinProfileId || account.dolphinProfileId;
  if (!profileId) throw new Error(`No Dolphin profile assigned to ${item.site}/${item.accountId}`);

  // Pull categories from the SITE's wpCategories. These become both search
  // keywords AND target board names (1-to-1 mapping).
  const categories = await _loadSiteCategories(item.site);
  if (categories.length === 0) {
    throw new Error(`Site ${item.site} has no wpCategories — set them in settings.json (or via dashboard).`);
  }
  Logger.info(`[Warming] ${item.site} categories: ${categories.join(', ')}`);

  const cycleCount = randInt(CYCLES_PER_SESSION_MIN, CYCLES_PER_SESSION_MAX);
  // Pick cycle categories WITHOUT replacement (until pool exhausted, then refill)
  const cycleCategories = [];
  let pool = [...categories];
  for (let i = 0; i < cycleCount; i++) {
    if (pool.length === 0) pool = [...categories];
    const c = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    cycleCategories.push(c);
  }
  Logger.info(`[Warming] Session plan: ${cycleCount} cycles → ${cycleCategories.join(' → ')}`);

  const startedAt = Date.now();
  const { page, cleanup } = await _connectDolphin(Number(profileId));
  const cycleResults = [];
  const categoryBoardNames = {};

  try {
    const pinterest = new PinterestPage(page);
    await pinterest.init();
    Logger.info(`[Warming] Pinterest ready — starting category cycles`);

    // Pre-flight: validate that each category has a matching Pinterest board.
    // Cached 24h so we don't re-scrape every session.
    try {
      const { ensureValidation, resolveBoardForCategory } = await import('./boards-validator.js');
      const val = await ensureValidation(page, item.site, item.accountId, categories);
      for (const cat of categories) {
        const resolved = resolveBoardForCategory(val.boards || [], cat, account.categoryBoardMap || {});
        if (resolved?.boardName) categoryBoardNames[cat] = resolved.boardName;
      }
      if (val.missing.length > 0) {
        Logger.warn(`[Warming] Missing Pinterest boards for categories: ${val.missing.join(', ')} — saves to those categories will use Pinterest default board.`);
      } else if (val.present.length > 0) {
        Logger.info(`[Warming] All ${val.present.length} category-boards present on Pinterest ✓`);
      }
    } catch (e) {
      Logger.warn(`[Warming] board validation skipped: ${e.message}`);
    }

    // Initial feed scroll on home — appears like a "natural arrival"
    const initialScrollSec = randInt(45, 90);
    Logger.info(`[Warming] Initial feed scroll ~${initialScrollSec}s`);
    await _scrollFor(page, initialScrollSec);

    // Run category cycles
    for (const cat of cycleCategories) {
      // Soft time-budget enforcement
      const elapsedMin = (Date.now() - startedAt) / 60000;
      if (elapsedMin >= SESSION_MAX_MINUTES) {
        Logger.info(`[Warming] Time budget reached (${elapsedMin.toFixed(1)}min) — stopping cycles early`);
        break;
      }
      const result = await _runCategoryCycle(pinterest, page, cat, { boardName: categoryBoardNames[cat] || cat });
      cycleResults.push(result);
    }

    // Optional final scroll back on home (~30s) — "winding down"
    try {
      await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await _scrollFor(page, randInt(30, 60));
    } catch {}

    const durationMin = (Date.now() - startedAt) / 60000;
    const totalSaves = cycleResults.reduce((s, r) => s + r.saves, 0);
    const totalCloseups = cycleResults.reduce((s, r) => s + r.closeups, 0);

    Logger.info(`[Warming] Session complete: ${durationMin.toFixed(1)}min, ${cycleResults.length} cycles, ${totalCloseups} closeups, ${totalSaves} saves`);

    return {
      ok: true,
      cycles: cycleResults,
      totalSaves,
      totalCloseups,
      durationMin: Number(durationMin.toFixed(1)),
      categoriesUsed: cycleCategories,
    };
  } finally {
    await cleanup();
  }
}
