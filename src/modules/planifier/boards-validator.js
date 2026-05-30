/**
 * Boards Validator — verify Pinterest account has boards matching the
 * site's WP categories.
 *
 * Strategy:
 *   1. Open the account's profile saved-boards page on Pinterest
 *   2. Scrape visible board titles
 *   3. Compare with site.wpCategories (case-insensitive partial match)
 *   4. Report missing categories (board not found) + extra boards (informational)
 *   5. Cache result per (account, day) in data/planifier/boards-validation.json
 *      so repeated checks don't re-scrape Pinterest unnecessarily.
 *
 * Used by:
 *   - Warming + regular sessions: optional pre-flight that warns if a
 *     category-named board is missing (saves will fall back to default board
 *     or be skipped if no board picker dialog appears).
 *   - Dashboard "Multi-Site" tab: shows per-account board status.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../shared/utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CACHE_PATH = join(PROJECT_ROOT, 'data', 'planifier', 'boards-validation.json');
const CACHE_TTL_HOURS = 24;

async function _loadCache() {
  if (!existsSync(CACHE_PATH)) return { version: 1, byAccount: {} };
  try { return JSON.parse(await readFile(CACHE_PATH, 'utf8')); }
  catch { return { version: 1, byAccount: {} }; }
}

async function _saveCache(cache) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
}

function _cacheKey(site, accountId) {
  return `${site}/${accountId}`;
}

/**
 * Scrape Pinterest profile boards. Receives a logged-in PinterestPage,
 * navigates to the user's profile page, collects board titles.
 *
 * Strategy:
 *   1. Navigate to /me/ (Pinterest redirects to /<username>/)
 *   2. Wait for the page to settle + scroll to trigger lazy load
 *   3. Try multiple selector strategies (Pinterest updates these often)
 *   4. Fallback: scrape any link with the user's URL pattern (/<user>/<board>/)
 *      which always points to a board page
 *
 * Best-effort: returns whatever it can scrape. Logs what selector worked
 * (or didn't) so we can debug from the server console.
 */
export async function scrapeBoardNames(page) {
  try {
    Logger.info('[Boards] navigating to /me/ to read profile boards...');
    await page.goto('https://www.pinterest.com/me/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3500);

    // Make sure we land on the user's profile (not a redirect loop or business hub)
    const finalUrl = page.url();
    Logger.info(`[Boards] settled on URL: ${finalUrl}`);
    if (finalUrl.includes('business.pinterest.com')) {
      Logger.info('[Boards] redirected to business hub — switching to consumer profile...');
      // Click Pinterest logo or hard-nav to / and re-hit /me/
      await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2500);
      await page.goto('https://www.pinterest.com/me/', { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(3500);
    }

    // Extract the username from the URL — used by the fallback selector
    const username = (() => {
      try {
        const m = page.url().match(/pinterest\.com\/([^\/?]+)\//);
        return m ? m[1] : null;
      } catch { return null; }
    })();
    if (username) Logger.info(`[Boards] detected username: ${username}`);

    // Click the "Created" / "Saved" tab if visible (sometimes default tab is wrong)
    try {
      await page.evaluate(() => {
        const candidates = [
          'div[data-test-id="created-tab"]',
          'button[role="tab"]',
          'a[href$="/_created/"]',
          'a[href$="/_saved/"]',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el && /created|saved|boards|cr.{2}.{1,3}|enregistr/i.test(el.textContent || '')) {
            el.click();
            return;
          }
        }
      });
      await page.waitForTimeout(1500);
    } catch {}

    // Scroll a bit to trigger lazy load of board cards
    for (let i = 0; i < 3; i++) {
      try { await page.mouse.wheel(0, 700); } catch {}
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);

    // Run multiple extraction strategies inside the page context
    const result = await page.evaluate((username) => {
      const seen = new Set();
      const trace = {};

      // ── Strategy 1: data-test-id selectors (Pinterest internal) ──
      const tidSelectors = [
        '[data-test-id="board-card-title"]',
        '[data-test-id="board-card-title-text"]',
        '[data-test-id="boardCardTitle"]',
        'div[data-test-id="boardCard"] [data-test-id*="title" i]',
        'div[data-test-id="board"] [data-test-id*="title" i]',
        '[data-test-id="board"] h2',
        '[data-test-id="board"] h3',
      ];
      for (const sel of tidSelectors) {
        const elements = document.querySelectorAll(sel);
        if (elements.length > 0) trace[sel] = elements.length;
        for (const el of elements) {
          const name = (el.textContent || '').trim();
          if (name && name.length > 0 && name.length < 100) seen.add(name);
        }
      }

      // ── Strategy 2: aria-label on board links ────────────────────
      const ariaSelectors = [
        'a[aria-label*="board" i]',
        'div[role="button"][aria-label*="board" i]',
        'div[aria-label*="board" i]',
      ];
      for (const sel of ariaSelectors) {
        const elements = document.querySelectorAll(sel);
        if (elements.length > 0) trace[sel] = elements.length;
        for (const el of elements) {
          const aria = el.getAttribute('aria-label') || '';
          const name = aria
            .replace(/^(Open|View|Go to)\s+(board|tableau)\s+/i, '')
            .replace(/^board\s+/i, '')
            .replace(/\s+with\s+\d+.*$/i, '')
            .trim();
          if (name && name.length > 0 && name.length < 100) seen.add(name);
        }
      }

      // ── Strategy 3: links to board pages /<username>/<board-slug>/ ──
      // Most reliable cross-redesign — Pinterest's URL scheme is stable.
      if (username) {
        const pattern = new RegExp(`/${username}/([^/?#]+)/?$`, 'i');
        const links = document.querySelectorAll(`a[href*="/${username}/"]`);
        trace[`a[href*="/${username}/"]`] = links.length;
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const m = href.match(pattern);
          if (!m) continue;
          const slug = m[1];
          // Skip non-board pages
          if (['_saved', '_created', '_following', 'followers', 'pins', 'activity'].includes(slug)) continue;
          // Prefer the link's text or aria-label as the readable board name
          const aria = a.getAttribute('aria-label') || '';
          const text = (a.textContent || '').trim();
          let name = aria.replace(/^(Open|View|Go to)\s+(board|tableau)\s+/i, '').trim() || text;
          // If still empty, prettify the slug
          if (!name) {
            name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          }
          if (name && name.length > 0 && name.length < 100) seen.add(name);
        }
      }

      // ── Strategy 4: H2/H3 within visible cards (last-resort) ────
      if (seen.size === 0) {
        const headings = document.querySelectorAll('main h2, main h3, [role="main"] h2, [role="main"] h3');
        trace['main h2/h3'] = headings.length;
        for (const h of headings) {
          const name = (h.textContent || '').trim();
          if (name && name.length > 0 && name.length < 80 && !/pinterest|home|following/i.test(name)) {
            seen.add(name);
          }
        }
      }

      return { names: [...seen], trace };
    }, username);

    // Log what worked for debugging
    Logger.info(`[Boards] selector trace: ${JSON.stringify(result.trace)}`);
    Logger.info(`[Boards] found ${result.names.length} board(s): ${result.names.slice(0, 10).join(', ')}${result.names.length > 10 ? '...' : ''}`);
    return result.names;
  } catch (e) {
    Logger.warn(`[Boards] scrape failed: ${e.message}`);
    return [];
  }
}

/**
 * Find the Pinterest board name that matches a recipe category.
 * Matching: case-insensitive, substring either direction.
 * Example: category="Dinner", boards=["Best Dinner for Family", "Breakfast"]
 *          → returns "Best Dinner for Family"
 * Returns null if no match.
 */
export function findBoardForCategory(boards, category) {
  if (!category || !Array.isArray(boards) || boards.length === 0) return null;
  const lowerCat = String(category).toLowerCase().trim();
  if (!lowerCat) return null;
  for (const b of boards) {
    const lb = String(b).toLowerCase().trim();
    if (lb === lowerCat || lb.includes(lowerCat) || lowerCat.includes(lb)) {
      return b;
    }
  }
  return null;
}

/**
 * Get the LIST of Pinterest boards we trust to use for posting. Priority:
 *   1. Cached scraped boards (validator ran during a previous session)
 *   2. Manually-entered account.boards (from dashboard)
 * Returns { boards: string[], source: 'cached-scrape' | 'manual-config' | 'none' }
 */
export async function getEffectiveBoards(site, accountId, manualBoards = []) {
  try {
    const cached = await readValidation(site, accountId);
    if (cached?.boards?.length > 0) {
      return { boards: cached.boards, source: 'cached-scrape' };
    }
  } catch {}
  if (manualBoards.length > 0) {
    return { boards: manualBoards, source: 'manual-config' };
  }
  return { boards: [], source: 'none' };
}

/**
 * Compare scraped Pinterest boards with site's WP categories.
 * Match is case-insensitive partial (Pinterest "Dinner Ideas" matches
 * category "Dinner"). Returns:
 *   { missing: [], present: [], extras: [] }
 */
export function compareWithCategories(boards, categories) {
  const lowerBoards = boards.map(b => String(b).toLowerCase());
  const present = [];
  const missing = [];
  for (const cat of categories) {
    const lower = String(cat).toLowerCase();
    const found = lowerBoards.some(b => b.includes(lower) || lower.includes(b));
    if (found) present.push(cat); else missing.push(cat);
  }
  const lowerCats = categories.map(c => String(c).toLowerCase());
  const extras = boards.filter(b => {
    const lb = String(b).toLowerCase();
    return !lowerCats.some(c => lb.includes(c) || c.includes(lb));
  });
  return { present, missing, extras };
}

/**
 * Read cached validation result for an account. Returns null if stale or absent.
 */
export async function readValidation(site, accountId) {
  const cache = await _loadCache();
  const entry = cache.byAccount[_cacheKey(site, accountId)];
  if (!entry) return null;
  const ageMs = Date.now() - new Date(entry.validatedAt).getTime();
  if (ageMs > CACHE_TTL_HOURS * 3600_000) return null;
  return entry;
}

/**
 * Run validation: open Pinterest profile, scrape boards, compare with
 * site categories, save result, return.
 *
 * Uses an already-open Playwright Page (caller manages browser lifecycle).
 *
 * @param {object} page - logged-in PinterestPage's underlying page
 * @param {string} site - site_id (for cache key)
 * @param {string} accountId
 * @param {string[]} categories - site's wpCategories
 * @returns {Promise<object>} { boards, present, missing, extras, validatedAt }
 */
export async function validate(page, site, accountId, categories) {
  const boards = await scrapeBoardNames(page);
  const cmp = compareWithCategories(boards, categories);
  const result = {
    site, accountId,
    validatedAt: new Date().toISOString(),
    boards,
    ...cmp,
  };
  // Persist
  const cache = await _loadCache();
  cache.byAccount[_cacheKey(site, accountId)] = result;
  await _saveCache(cache);
  Logger.info(`[Boards] ${site}/${accountId} validated: ${cmp.present.length} ok, ${cmp.missing.length} missing${cmp.missing.length > 0 ? ' (' + cmp.missing.join(', ') + ')' : ''}`);
  return result;
}

/**
 * Return cached validation OR run a fresh scrape if cache is missing/stale.
 * Convenient wrapper for "I want a result NOW".
 */
export async function ensureValidation(page, site, accountId, categories) {
  const cached = await readValidation(site, accountId);
  if (cached) {
    Logger.info(`[Boards] using cached validation (${Math.round((Date.now() - new Date(cached.validatedAt).getTime()) / 3600_000)}h old) for ${site}/${accountId}`);
    return cached;
  }
  return await validate(page, site, accountId, categories);
}
