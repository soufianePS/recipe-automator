/**
 * Pin Pool — pin sourcing and posted-status tracking.
 *
 * Single source of truth: the Google Sheet (per site).
 *   - Reads recipes from settings.sheetTabName
 *   - Reads pin data from columns F-Q (3 pins × 4 cols each)
 *   - Reads/writes posted_at from columns R, S, T (one per pin)
 *
 * Account assignment (Strategy A): hash(draftUrl) mod activeAccountCount.
 *   Same recipe always lands on the same account — deterministic, stateless,
 *   survives restarts.
 *
 * The Pinterest-session action will call getNextEligiblePin() to know what
 * to post; after posting it calls markPinPosted() to persist the timestamp.
 */

import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { WordPressAPI } from '../../shared/utils/wordpress-api.js';
import { Logger } from '../../shared/utils/logger.js';
import { validateRecipe } from './recipe-validator.js';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '..', '..', '..', 'data', 'sites');

// Sheet layout (existing):
//   A=topic | B=status | C=draftUrl | D=timestamp | E=category
//   F-I=pin1 (image, desc, title, tags)
//   J-M=pin2 (image, desc, title, tags)
//   N-Q=pin3 (image, desc, title, tags)
//   R=wpStatus  (existing — 'published' | 'draft' | 'future')
// New columns added by the Planifier:
//   U=pin1_posted_at | V=pin2_posted_at | W=pin3_posted_at
//   X=validation    ("valid" / "invalid: <issue summary>" / "" = not yet validated)
const PIN_BLOCK_START = 'F';
const WP_STATUS_COL = 'R';
const POSTED_COLS = ['U', 'V', 'W'];
const VALIDATION_COL = 'X';
// Soft-delete flag (col B has data validation that rejects "deleted",
// so we use a separate column controlled solely by the Planifier).
const DELETED_FLAG_COL = 'Y';

const colIdx = (c) => c.toUpperCase().charCodeAt(0) - 65;

/**
 * Parse Google's gviz date format: "Date(YYYY,M-1,D[,h,m,s])".
 * Returns "YYYY-MM-DD" or null.
 */
function parseGvizDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already ISO?
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // gviz: "Date(2026,3,7)" → 2026-04-07 (month is 0-indexed)
  m = s.match(/Date\((\d+),(\d+),(\d+)/);
  if (m) {
    const y = m[1].padStart(4, '0');
    const mo = String(Number(m[2]) + 1).padStart(2, '0');
    const d = m[3].padStart(2, '0');
    return `${y}-${mo}-${d}`;
  }
  return null;
}

/**
 * Normalize a WP URL to its host (no protocol, no trailing slash).
 * Used to match sheet rows to a site (draftUrl contains the host).
 */
function urlHost(url) {
  if (!url) return '';
  return String(url).replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
}

async function loadSiteSettings(siteName) {
  const path = join(SITES_DIR, siteName, 'settings.json');
  if (!existsSync(path)) throw new Error(`Settings not found for site ${siteName}`);
  return JSON.parse(await readFile(path, 'utf8'));
}

// In-memory cache for live WP status (5 min TTL) — recipes list reloads
// often (filters, refresh) and WP REST is the slow link.
const _liveWpStatusCache = new Map();   // "{siteName}|{postId}" → { status, at }
const LIVE_WP_STATUS_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch live WordPress post status (publish/draft/future/private/pending/trash)
 * using authenticated REST. Used by the recipes dashboard to show real status
 * regardless of what's cached in sheet col R. Cached 5 min per (site, postId).
 *
 * Returns string status, or null if unfetchable (no draftUrl, no auth, etc.)
 */
export async function fetchLiveWpStatus(siteName, draftUrl) {
  if (!draftUrl) return null;
  let postId;
  try {
    const u = new URL(draftUrl);
    postId = u.searchParams.get('post');
  } catch { return null; }
  if (!postId || !/^\d+$/.test(postId)) return null;

  const cacheKey = `${siteName}|${postId}`;
  const cached = _liveWpStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVE_WP_STATUS_TTL_MS) {
    return cached.status;
  }

  let settings;
  try {
    settings = await loadSiteSettings(siteName);
  } catch { return null; }
  const { wpUrl, wpUsername, wpAppPassword } = settings;
  if (!wpUrl || !wpUsername || !wpAppPassword) return null;

  const auth = 'Basic ' + Buffer.from(`${wpUsername}:${wpAppPassword}`).toString('base64');
  const restUrl = `${wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/posts/${postId}?context=edit&_fields=status`;
  try {
    const res = await fetch(restUrl, {
      headers: { 'Authorization': auth },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      // 404 = trashed/deleted; 401/403 = auth wrong
      const status = res.status === 404 ? 'trash' : `http-${res.status}`;
      _liveWpStatusCache.set(cacheKey, { status, at: Date.now() });
      return status;
    }
    const json = await res.json();
    const status = json?.status || 'unknown';
    _liveWpStatusCache.set(cacheKey, { status, at: Date.now() });
    return status;
  } catch (e) {
    return null; // network error → don't cache, let next call retry
  }
}

/**
 * Resolve which sheet tab to use for a site's Planifier reads/writes.
 *
 * Priority:
 *   1. planifierConfig.sites[siteName].sheetTab — if set (non-empty)
 *   2. siteSettings.sheetTabName — fallback to the site's default tab
 *
 * Mutates the passed settings object in place AND returns the resolved tab,
 * so existing callers that read settings.sheetTabName get the right value.
 */
function resolveSheetTab(settings, siteName, planifierConfig) {
  const override = planifierConfig?.sites?.[siteName]?.sheetTab;
  if (override && typeof override === 'string' && override.trim()) {
    settings.sheetTabName = override.trim();
    settings._sheetTabSource = 'planifier-override';
  } else {
    settings._sheetTabSource = 'site-default';
  }
  return settings.sheetTabName;
}

/**
 * Load site settings + apply the planifier's per-site sheetTab override.
 * Use this for any sheet write (marking posted, validating, deleting…) so
 * the operation targets the same tab the Planifier reads from.
 */
async function loadSiteSettingsForPlanifier(siteName) {
  const settings = await loadSiteSettings(siteName);
  try {
    // Lazy import to avoid circular dep with planifier.js
    const { loadConfig } = await import('./plan-storage.js');
    const cfg = await loadConfig();
    resolveSheetTab(settings, siteName, cfg);
  } catch (e) {
    Logger.debug?.(`[PinPool] couldn't apply tab override: ${e.message}`);
  }
  return settings;
}

/**
 * Returns the candidate sheet tabs known for a site (from its settings).
 * Used by the UI dropdown so the user picks among existing tabs rather
 * than typing a name.
 */
export async function getAvailableSheetTabs(siteName) {
  const settings = await loadSiteSettings(siteName);
  const tabs = new Set();
  for (const key of ['sheetTabName', 'generatorSheetTab', 'scraperSheetTab']) {
    if (settings[key] && typeof settings[key] === 'string' && settings[key].trim()) {
      tabs.add(settings[key].trim());
    }
  }
  return {
    site: siteName,
    defaultTab: settings.sheetTabName || '',
    tabs: [...tabs],
  };
}

/**
 * Determine which account a recipe belongs to (Strategy A).
 *
 * @param {string} key - typically the recipe's draftUrl, or topic if unavailable
 * @param {Array<object>} activeAccounts - eligible accounts (status: active | warmup_week_2)
 * @returns {object|null}
 */
export function assignAccount(key, activeAccounts) {
  if (!activeAccounts || activeAccounts.length === 0) return null;
  if (!key) return activeAccounts[0];
  const hash = createHash('sha256').update(String(key)).digest();
  return activeAccounts[hash[0] % activeAccounts.length];
}

/**
 * Filter accounts of a site that can currently post pins.
 * (active = full rate; warmup_week_2 = partial; others = no posting)
 */
function getPostingAccounts(siteConfig) {
  return (siteConfig?.pinterestAccounts || [])
    .filter(a => a.status === 'active' || a.status === 'warmup_week_2');
}

/**
 * Read the full pin pool for one site.
 *
 * @returns {Promise<Array>} recipes = [{ rowIndex, topic, draftUrl, publishedAt, category,
 *   assignedAccountId, pins: [{ pinIndex, imageUrl, description, title, tags, postedAt, eligibleAt }] }]
 */
export async function readSitePool(siteName, planifierConfig) {
  const settings = await loadSiteSettings(siteName);
  resolveSheetTab(settings, siteName, planifierConfig);
  if (!settings.sheetId || !settings.sheetTabName) {
    Logger.warn(`[PinPool] ${siteName} — sheet not configured, skipping`);
    return [];
  }

  const rows = await SheetsAPI.readSheet(settings.sheetId, settings.sheetTabName);
  const startRow = Number(settings.startRow) || 2;
  const dataStartIdx = startRow - 2;

  const idxStatus = colIdx(settings.statusColumn || 'B');
  const idxTopic = colIdx(settings.topicColumn || 'A');
  const idxDraftUrl = colIdx('C');
  const idxTimestamp = colIdx('D');
  const idxCategory = colIdx('E');
  const idxPinBlockStart = colIdx(PIN_BLOCK_START);   // F = 5
  const idxWpStatus = colIdx(WP_STATUS_COL);          // R = 17
  const idxPostedStart = colIdx(POSTED_COLS[0]);      // U = 20
  const idxValidation = colIdx(VALIDATION_COL);       // X = 23
  const idxDeletedFlag = colIdx(DELETED_FLAG_COL);    // Y = 24

  const siteConfig = planifierConfig.sites?.[siteName] || {};
  const postingAccounts = getPostingAccounts(siteConfig);
  const spreadDays = planifierConfig.rules?.pinSpreadDaysFromRecipe || [0, 2, 5];

  const out = [];
  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i];
    const status = (row[idxStatus] || '').trim().toLowerCase();
    if (status !== 'done') continue;

    const draftUrl = (row[idxDraftUrl] || '').trim();
    if (!draftUrl) continue;

    // The site config's sheetTabName IS the partition key — we trust that
    // every row in this tab belongs to this site (no URL host filtering).

    // WP status (col R): some tabs fill it ("published"/"draft"/"future"),
    // others leave it empty. We BLOCK only known-bad states (draft/future)
    // and accept "published" or empty (since the orchestrator may not write
    // R on every tab — relying on status=done + draftUrl is enough proof
    // the post is live).
    const wpStatus = (row[idxWpStatus] || '').trim().toLowerCase();
    if (wpStatus === 'draft' || wpStatus === 'future') continue;

    const topic = (row[idxTopic] || '').trim();
    const rowIndex = i + 2;
    const publishedAt = parseGvizDate(row[idxTimestamp]);
    const category = (row[idxCategory] || '').trim();

    // Build 3 pins from the F-Q block (4 cols per pin)
    const pins = [];
    for (let p = 0; p < 3; p++) {
      const base = idxPinBlockStart + p * 4;
      pins.push({
        pinIndex: p,
        imageUrl: (row[base] || '').trim(),
        description: (row[base + 1] || '').trim(),
        title: (row[base + 2] || '').trim(),
        tags: (row[base + 3] || '').trim(),
        postedAt: (row[idxPostedStart + p] || '').trim() || null,
        eligibleAt: computeEligibleAt(publishedAt, spreadDays[p] || 0),
      });
    }

    const assignedAccount = assignAccount(draftUrl || topic, postingAccounts);
    // Parse validation column X — "valid" or "invalid: <issues>" or ""
    const rawValidation = (row[idxValidation] || '').trim();
    let sheetValidation = null;
    if (rawValidation) {
      if (rawValidation.toLowerCase().startsWith('valid')) {
        sheetValidation = { valid: true, source: 'sheet', issues: [] };
      } else if (rawValidation.toLowerCase().startsWith('invalid')) {
        const msg = rawValidation.replace(/^invalid:\s*/i, '');
        sheetValidation = { valid: false, source: 'sheet', issues: [{ kind: 'sheet-cached', msg }] };
      }
    }

    out.push({
      rowIndex,
      site: siteName,
      topic,
      draftUrl,
      publishedAt,
      category,
      wpStatus,
      assignedAccountId: assignedAccount?.id || null,
      pins,
      validation: sheetValidation,    // null if never validated
    });
  }
  // Append "extra" pins from pin-history (campaign-generated, not in sheet F/J/N)
  await _attachExtraPins(out, siteName);
  return out;
}

/**
 * Augment the pool with "extra" pins from the pin-history sheet.
 * Extras are pins generated via Calendar Create Pin campaigns (mode='extra'
 * in pin-regenerator) — they don't overwrite the recipe's original 3 pins
 * but become additional available pins to post.
 *
 * Read once, attach to matching recipes by draftUrl. Each extra appears as
 * a pin with pinIndex >= 3 so it sorts after the original slots.
 */
async function _attachExtraPins(pool, siteName) {
  try {
    const { credentialsAvailable, readTabAsObjects } = await import('../../shared/utils/sheets-client.js');
    if (!credentialsAvailable()) return;
    const rows = await readTabAsObjects('pin-history').catch(() => []);
    if (!rows || rows.length === 0) return;
    // Filter: this site + type='extra' + has wp_image_url + NOT yet posted to pinterest
    const extras = rows.filter(r =>
      r.site === siteName &&
      (r.type || '').toLowerCase() === 'extra' &&
      r.wp_image_url &&
      !r.pinterest_url
    );
    if (extras.length === 0) return;
    // Group by recipe_url
    const byUrl = new Map();
    for (const e of extras) {
      const url = (e.recipe_url || '').trim();
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(e);
    }
    // Attach to matching recipes
    let extraIdx = 3;
    for (const recipe of pool) {
      const arr = byUrl.get(recipe.draftUrl);
      if (!arr || arr.length === 0) continue;
      // Sort extras by timestamp ASC (oldest first → post first)
      arr.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      for (const ex of arr) {
        recipe.pins.push({
          pinIndex: extraIdx++,
          imageUrl: ex.wp_image_url,
          description: recipe.pins[0]?.description || '',  // borrow desc/title from slot 1
          title: recipe.pins[0]?.title || recipe.topic || '',
          tags: '',
          postedAt: null,                  // never posted (filter guarantees)
          eligibleAt: null,                // always eligible (no spread for extras)
          isExtra: true,
          historyTimestamp: ex.timestamp,  // used to patch pin-history on post
        });
      }
    }
  } catch (e) {
    // best-effort — extras enhancement never blocks the main pool
    if (typeof Logger !== 'undefined') Logger.warn(`[PinPool] extras enrichment failed: ${e.message}`);
  }
}

/**
 * For pin spread: pin#0 eligible same day as publish, pin#1 publish+2d, pin#2 publish+5d.
 */
function computeEligibleAt(publishedAt, daysOffset) {
  if (!publishedAt) return null;
  const m = publishedAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + (Number(daysOffset) || 0));
  return d.toISOString().slice(0, 10);
}

// Whole days from an ISO date/timestamp to a YYYY-MM-DD key. Returns Infinity
// if unparseable/empty (treated as "long ago" so the gap never blocks).
function _daysSince(iso, todayKey) {
  if (!iso) return Infinity;
  const a = new Date(String(iso).slice(0, 10) + 'T00:00:00');
  const b = new Date(todayKey + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * RECYCLE selection (rules #4 + #5): when no fresh pin is eligible, find the
 * article that has gone the LONGEST without a new pin (oldest last-posted date),
 * while still respecting the gap. Returns that recipe (so the caller can
 * regenerate a fresh extra pin for it) or null. Only considers published,
 * account-assigned recipes that already have ≥1 posted pin.
 */
export async function pickOldestForRecycle(planifierConfig, siteName, accountId) {
  const gapDays = Number(planifierConfig.rules?.pinGapDays ?? 2);
  const todayKey = new Date().toISOString().slice(0, 10);
  const pool = await readSitePool(siteName, planifierConfig);
  let best = null, bestLast = null;
  for (const recipe of pool) {
    if (recipe.assignedAccountId !== accountId) continue;
    const posted = recipe.pins.filter(p => p.postedAt).map(p => p.postedAt).sort();
    if (posted.length === 0) continue;                 // never pinned → normal flow handles it
    const last = posted[posted.length - 1];
    if (_daysSince(last, todayKey) < gapDays) continue; // respect the gap
    if (bestLast === null || last < bestLast) { best = recipe; bestLast = last; }
  }
  if (best) Logger.info(`[PinPool] Recycle pick: "${best.topic}" (last pin ${bestLast}) — longest without a new pin`);
  return best;
}

/**
 * Read ALL recipes from a site's sheet (regardless of status / wp status).
 * Used by the Recipes management tab — shows everything: pending, processing,
 * done, deleted, etc.
 *
 * Same row shape as readSitePool but no filter.
 */
export async function readAllRecipesForSite(siteName, planifierConfig) {
  const settings = await loadSiteSettings(siteName);
  resolveSheetTab(settings, siteName, planifierConfig);
  if (!settings.sheetId || !settings.sheetTabName) {
    return [];
  }
  const rows = await SheetsAPI.readSheet(settings.sheetId, settings.sheetTabName);
  const startRow = Number(settings.startRow) || 2;
  const dataStartIdx = startRow - 2;

  const idxStatus = colIdx(settings.statusColumn || 'B');
  const idxTopic = colIdx(settings.topicColumn || 'A');
  const idxDraftUrl = colIdx('C');
  const idxTimestamp = colIdx('D');
  const idxCategory = colIdx('E');
  const idxPinBlockStart = colIdx(PIN_BLOCK_START);
  const idxWpStatus = colIdx(WP_STATUS_COL);
  const idxPostedStart = colIdx(POSTED_COLS[0]);
  const idxValidation = colIdx(VALIDATION_COL);

  const out = [];
  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i];
    const topic = (row[idxTopic] || '').trim();
    const status = (row[idxStatus] || '').trim().toLowerCase();
    // Include rows with EITHER a topic or a status — but skip totally empty rows
    if (!topic && !status) continue;

    const rowIndex = i + 2;
    const draftUrl = (row[idxDraftUrl] || '').trim();
    const wpStatus = (row[idxWpStatus] || '').trim().toLowerCase();
    const publishedAt = parseGvizDate(row[idxTimestamp]);
    const category = (row[idxCategory] || '').trim();

    const pins = [];
    for (let p = 0; p < 3; p++) {
      const base = idxPinBlockStart + p * 4;
      pins.push({
        pinIndex: p,
        imageUrl: (row[base] || '').trim(),
        description: (row[base + 1] || '').trim(),
        title: (row[base + 2] || '').trim(),
        tags: (row[base + 3] || '').trim(),
        postedAt: (row[idxPostedStart + p] || '').trim() || null,
      });
    }

    const rawValidation = (row[idxValidation] || '').trim();
    let validation = null;
    if (rawValidation) {
      if (rawValidation.toLowerCase().startsWith('valid')) {
        validation = { valid: true, source: 'sheet', issues: [] };
      } else if (rawValidation.toLowerCase().startsWith('invalid')) {
        const msg = rawValidation.replace(/^invalid:\s*/i, '');
        validation = { valid: false, source: 'sheet', issues: [{ kind: 'sheet-cached', msg }] };
      }
    }

    out.push({
      rowIndex,
      site: siteName,
      topic,
      status,
      draftUrl,
      wpStatus,
      publishedAt,
      category,
      pins,
      validation,
    });
  }
  return out;
}

export async function readAllRecipes(planifierConfig) {
  const out = [];
  for (const siteName of Object.keys(planifierConfig.sites || {})) {
    if (siteName.startsWith('_')) continue;
    try {
      const recipes = await readAllRecipesForSite(siteName, planifierConfig);
      out.push(...recipes);
    } catch (e) {
      Logger.warn(`[Recipes] ${siteName} read failed: ${e.message}`);
    }
  }
  return out;
}

/**
 * Add a new recipe row to a site's sheet. The orchestrator will pick it up
 * on its next batch run (because col B will read 'pending').
 *
 * Finds the next empty row (after the last non-empty topic) and writes
 * { topic, status: 'pending' } to col A and B.
 */
export async function addRecipeToSheet(siteName, topic) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  if (!settings.sheetId || !settings.sheetTabName) {
    throw new Error(`Site ${siteName} has no sheet configured`);
  }
  const rows = await SheetsAPI.readSheet(settings.sheetId, settings.sheetTabName);
  const idxTopic = colIdx(settings.topicColumn || 'A');
  const startRow = Number(settings.startRow) || 2;
  // Find next empty row (1-indexed sheet rows)
  let nextRow = Math.max(startRow, rows.length + 2);
  for (let i = Math.max(0, startRow - 2); i < rows.length; i++) {
    const t = (rows[i][idxTopic] || '').trim();
    if (!t) {
      nextRow = i + 2;
      break;
    }
  }
  const topicCol = settings.topicColumn || 'A';
  const statusCol = settings.statusColumn || 'B';
  const range = `${settings.sheetTabName}!${topicCol}${nextRow}:${statusCol}${nextRow}`;
  await SheetsAPI.writeRange(settings.sheetId, range, [[topic, 'pending']], settings);
  Logger.info(`[Recipes] Added "${topic}" to ${siteName} row ${nextRow}`);
  return { rowIndex: nextRow, topic, status: 'pending' };
}

/**
 * HARD delete a recipe:
 *   1. Delete the WordPress post + ALL its media (featured image, content
 *      images, pin images attached to the post)
 *   2. Reset the sheet row: keep col A (topic) only. Reset col B to 'pending'
 *      so the orchestrator picks it up to re-generate. Clear all data fields
 *      (draftUrl, timestamp, category, pin data F-Q, wpStatus R, posted_at U/V/W,
 *      validation X, deleted flag Y).
 *
 * The recipe stays in the sheet as a fresh "pending" row with just the topic.
 * The orchestrator will treat it as a new recipe to generate.
 *
 * If WP delete fails (post already gone, network issue), we still proceed
 * with the sheet reset and return a partial-success indicator.
 */
export async function deleteRecipeFromSheet(siteName, rowIndex) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  // Read the row first to get the draftUrl (and to extract post ID)
  const rows = await SheetsAPI.readSheet(settings.sheetId, settings.sheetTabName);
  const row = rows[rowIndex - 2];
  if (!row) throw new Error(`Row ${rowIndex} not found in ${settings.sheetTabName}`);
  const draftUrl = (row[colIdx('C')] || '').trim();

  const result = { wpDeleted: false, wpError: null, mediaDeleted: 0 };

  // 1. Try to delete the WP post + media
  if (draftUrl) {
    try {
      const u = new URL(draftUrl);
      const postId = u.searchParams.get('post');
      if (postId && /^\d+$/.test(postId)) {
        Logger.info(`[Recipes] Hard-delete: removing WP post ${postId} + media…`);
        const r = await WordPressAPI.deletePostWithMedia(settings, postId);
        result.wpDeleted = !!r?.postDeleted;
        result.mediaDeleted = r?.mediaDeleted || 0;
        Logger.info(`[Recipes] WP cleanup: post=${result.wpDeleted}, media=${result.mediaDeleted}/${r?.totalMedia || 0}`);
      } else {
        Logger.warn(`[Recipes] draftUrl has no post ID: ${draftUrl}`);
      }
    } catch (e) {
      result.wpError = e.message;
      Logger.warn(`[Recipes] WP delete failed (continuing with sheet reset): ${e.message}`);
    }
  }

  // 2. Reset sheet row — keep col A, set col B = pending, clear C through Y
  // Use a single range write for efficiency: B{row}:Y{row} = 24 cols
  // Values: [pending, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
  //          B       C  D  E  F  G  H  I  J  K  L  M  N  O  P  Q  R  S  T  U  V  W  X  Y
  const emptyRow = ['pending', ...Array(23).fill('')];
  const range = `${settings.sheetTabName}!B${rowIndex}:Y${rowIndex}`;
  await SheetsAPI.writeRange(settings.sheetId, range, [emptyRow], settings, { bgColor: '#ffffff' });
  Logger.info(`[Recipes] Reset sheet row ${rowIndex}: col A kept, col B → "pending", C-Y cleared`);

  return result;
}

/**
 * Reset a recipe's status back to 'pending' so the orchestrator picks it
 * up again on the next batch run. Useful for "done but no URL" orphans.
 *
 * Also clears the soft-delete flag (col Y) in case the row was deleted before.
 */
export async function resetRecipeToPending(siteName, rowIndex) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  const statusCol = settings.statusColumn || 'B';
  await SheetsAPI.writeRange(settings.sheetId, `${settings.sheetTabName}!${statusCol}${rowIndex}`, [['pending']], settings, { bgColor: '#ffffff' });
  // Also clear deleted flag — if the row was soft-deleted, resetting it should fully restore
  await SheetsAPI.writeRange(settings.sheetId, `${settings.sheetTabName}!${DELETED_FLAG_COL}${rowIndex}`, [['']], settings, { bgColor: '#ffffff' });
  Logger.info(`[Recipes] Reset ${siteName} row ${rowIndex} to pending (+ cleared col ${DELETED_FLAG_COL})`);
}

/**
 * Aggregate pin pool across all enabled sites.
 */
export async function readAllPools(planifierConfig) {
  const out = [];
  for (const [siteName, siteCfg] of Object.entries(planifierConfig.sites || {})) {
    if (siteName.startsWith('_')) continue;
    if (!siteCfg.enabled) continue;
    try {
      const recipes = await readSitePool(siteName, planifierConfig);
      out.push(...recipes);
    } catch (e) {
      Logger.warn(`[PinPool] ${siteName} read failed: ${e.message}`);
    }
  }
  return out;
}

/**
 * Build summary stats from a pool (for dashboard).
 */
export function summarizePool(pool) {
  const summary = {
    totalRecipes: pool.length,
    pinsTotal: pool.length * 3,
    pinsPosted: 0,
    pinsPending: 0,
    pinsEligibleNow: 0,
    byAccount: {},
    bySite: {},
  };
  const todayKey = new Date().toISOString().slice(0, 10);
  for (const r of pool) {
    summary.bySite[r.site] = summary.bySite[r.site] || { recipes: 0, posted: 0, pending: 0, eligibleNow: 0 };
    summary.bySite[r.site].recipes++;
    const accountKey = r.assignedAccountId ? `${r.site}/${r.assignedAccountId}` : `${r.site}/(unassigned)`;
    summary.byAccount[accountKey] = summary.byAccount[accountKey] || { recipes: 0, posted: 0, pending: 0, eligibleNow: 0 };
    summary.byAccount[accountKey].recipes++;
    for (const p of r.pins) {
      if (p.postedAt) {
        summary.pinsPosted++;
        summary.bySite[r.site].posted++;
        summary.byAccount[accountKey].posted++;
      } else {
        summary.pinsPending++;
        summary.bySite[r.site].pending++;
        summary.byAccount[accountKey].pending++;
        if (p.eligibleAt && p.eligibleAt <= todayKey) {
          summary.pinsEligibleNow++;
          summary.bySite[r.site].eligibleNow++;
          summary.byAccount[accountKey].eligibleNow++;
        }
      }
    }
  }
  return summary;
}

/**
 * Pick the next pin to post for a given (site, accountId).
 *
 * Selection priority (in order):
 *   1. Recipe assigned to this account (Strategy A) ✓
 *   2. Recipe passes validator (skip recipes with ingredient-reconciliation
 *      failures — they shouldn't drive traffic to broken content)
 *   3. Pin not yet posted + has imageUrl + eligibleAt has passed
 *
 * Sort priority — FAVOR DIVERSITY across recipes:
 *   a. Recipes with the FEWEST pins already posted come first
 *      (so we post pin0 of every recipe before posting pin1 of any)
 *   b. Then oldest publishedAt
 *   c. Then lowest pinIndex (within the chosen recipe)
 *
 * NOTE: Per user request, validation is INFORMATIONAL only — invalid
 * recipes are still picked, the validation status is just returned for
 * UI display. To skip invalid recipes, set options.skipInvalid = true.
 *
 * @param {object} [options]
 * @param {boolean} [options.validate=true] - run validator (annotates result)
 * @param {boolean} [options.skipInvalid=false] - skip recipes that fail validation
 *
 * Returns { recipe, pin, validation } or null.
 */
/**
 * Pick a SPECIFIC pin by recipe rowIndex + pinIndex — used by the bulk
 * "queue for Pinterest" feature which targets the exact pins the user selected
 * (vs pickNextEligiblePin which auto-picks by diversity). Returns
 * { recipe, pin, validation:null } or null if not in the pool / no image /
 * already posted. The "recipe must be published" guard is still enforced later
 * by the executor's _isRecipePublished() check just before createPin.
 */
export async function pickSpecificPin(planifierConfig, siteName, rowIndex, pinIndex) {
  const pool = await readSitePool(siteName, planifierConfig);
  const recipe = pool.find(r => Number(r.rowIndex) === Number(rowIndex));
  if (!recipe) { Logger.warn(`[PinPool] targetPin: recipe row ${rowIndex} not in pool`); return null; }
  const pin = (recipe.pins || []).find(p => Number(p.pinIndex) === Number(pinIndex));
  if (!pin) { Logger.warn(`[PinPool] targetPin: pin#${pinIndex} not found on row ${rowIndex}`); return null; }
  if (!pin.imageUrl) { Logger.warn(`[PinPool] targetPin: pin#${pinIndex} row ${rowIndex} has no image`); return null; }
  if (pin.postedAt) { Logger.warn(`[PinPool] targetPin: pin#${pinIndex} row ${rowIndex} already posted ${pin.postedAt}`); return null; }
  return { recipe, pin, validation: null };
}

export async function pickNextEligiblePin(planifierConfig, siteName, accountId, options = {}) {
  const { validate = true, skipInvalid = false } = options;
  const pool = await readSitePool(siteName, planifierConfig);
  const todayKey = new Date().toISOString().slice(0, 10);

  // Build candidate list with computed sort key
  const gapDays = Number(planifierConfig.rules?.pinGapDays ?? 2);
  const candidates = [];
  for (const recipe of pool) {
    if (recipe.assignedAccountId !== accountId) continue;
    const postedPins = recipe.pins.filter(p => p.postedAt);
    const postedCount = postedPins.length;
    // ROLLING GAP (rule #2): if this article had a pin posted within the last
    // gapDays, do NOT offer its next pin yet. Anchored to the LAST pin actually
    // posted (not the recipe publish date), so two pins of one article are never
    // posted close together — applies to the 3 original pins AND extra pins.
    if (postedCount > 0 && gapDays > 0) {
      const lastPosted = postedPins.map(p => p.postedAt).sort().pop();
      if (_daysSince(lastPosted, todayKey) < gapDays) continue;
    }
    for (const pin of recipe.pins) {
      if (pin.postedAt) continue;
      if (!pin.imageUrl) continue;
      candidates.push({ recipe, pin, postedCount });
    }
  }
  if (candidates.length === 0) return null;

  // Sort: postedCount ASC, publishedAt ASC, pinIndex ASC
  candidates.sort((a, b) => {
    if (a.postedCount !== b.postedCount) return a.postedCount - b.postedCount;
    const pubA = a.recipe.publishedAt || '';
    const pubB = b.recipe.publishedAt || '';
    if (pubA !== pubB) return pubA.localeCompare(pubB);
    return a.pin.pinIndex - b.pin.pinIndex;
  });

  // Walk candidates in order, validating each recipe. Skip invalid ones.
  //
  // Validation source priority:
  //   1. recipe.validation already populated from sheet col X (no fetch)
  //   2. In-memory cache from validateRecipe (24h TTL)
  //   3. Fresh fetch (writes back to sheet for next time)
  const checkedRecipes = new Map();
  const liveStatusByRow = new Map();
  for (const c of candidates) {
    // HARD RULE: only pin recipes that are LIVE-PUBLISHED on WordPress. Skip
    // draft / future (scheduled) / private / pending / trashed so a pin never
    // links to a non-public URL. Defense-in-depth with the post-time
    // _isRecipePublished guard. live===null = transient WP error → let it fall
    // through to that final guard rather than blocking the whole queue.
    let live = liveStatusByRow.get(c.recipe.rowIndex);
    if (live === undefined) { live = await fetchLiveWpStatus(siteName, c.recipe.draftUrl); liveStatusByRow.set(c.recipe.rowIndex, live); }
    if (live && live !== 'publish') {
      Logger.info(`[PinPool] Skipping ${c.recipe.topic} pin#${c.pin.pinIndex} — WP status "${live}" (must be published to pin)`);
      continue;
    }
    if (!validate) {
      return { recipe: c.recipe, pin: c.pin, validation: null };
    }
    const key = c.recipe.rowIndex;
    let v = checkedRecipes.get(key);
    if (!v) {
      // If the sheet already has validation, trust it (no WP fetch needed).
      if (c.recipe.validation) {
        v = c.recipe.validation;
      } else {
        v = await validateRecipe(c.recipe);
        // Persist to sheet for next time
        try { await writeValidationToSheet(c.recipe.site, c.recipe.rowIndex, v); } catch (e) {
          Logger.warn(`[PinPool] write validation to sheet failed: ${e.message}`);
        }
      }
      checkedRecipes.set(key, v);
    }
    if (!skipInvalid || v.valid) {
      if (!v.valid) {
        Logger.info(`[PinPool] Using INVALID recipe ${c.recipe.topic} pin#${c.pin.pinIndex} (issues: ${v.issues.map(i=>i.kind || 'reason').join(',')}) — validation is informational only`);
      }
      return { recipe: c.recipe, pin: c.pin, validation: v };
    }
    Logger.info(`[PinPool] Skipping ${c.recipe.topic} pin#${c.pin.pinIndex} — skipInvalid=true and validation failed. Trying next.`);
  }

  Logger.warn(`[PinPool] No eligible pin for ${siteName}/${accountId} (${candidates.length} candidate(s))`);
  return null;
}

// Soft green for "posted OK" — matches Google Sheets' built-in palette
const POSTED_COLOR = '#c6efce';
// White (clears the green) when un-marking
const CLEAR_COLOR = '#ffffff';

/**
 * Mark a pin as posted by writing the ISO timestamp to its posted_at cell.
 * Also colors the cell green for visual confirmation in the sheet.
 * Idempotent — re-writing overwrites with a new timestamp.
 */
export async function markPinPosted(siteName, rowIndex, pinIndex, when = null) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  const col = POSTED_COLS[pinIndex];
  if (!col) throw new Error(`Invalid pinIndex: ${pinIndex}`);
  const ts = when || new Date().toISOString();
  const range = `${settings.sheetTabName}!${col}${rowIndex}`;
  await SheetsAPI.writeRange(settings.sheetId, range, [[ts]], settings, { bgColor: POSTED_COLOR });
  Logger.info(`[PinPool] marked ${siteName} row ${rowIndex} pin#${pinIndex} posted at ${ts}`);
}

/**
 * Reverse — clears posted_at and the green background.
 */
export async function unmarkPinPosted(siteName, rowIndex, pinIndex) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  const col = POSTED_COLS[pinIndex];
  if (!col) throw new Error(`Invalid pinIndex: ${pinIndex}`);
  const range = `${settings.sheetTabName}!${col}${rowIndex}`;
  await SheetsAPI.writeRange(settings.sheetId, range, [['']], settings, { bgColor: CLEAR_COLOR });
}

const VALIDATION_VALID_COLOR = '#c6efce';   // green
const VALIDATION_INVALID_COLOR = '#ffe699'; // light orange

/**
 * Write the validation result to col X of the recipe row. Format:
 *   - "valid" (green cell)
 *   - "invalid: <issue summary>" (orange cell)
 *   - "" + white (clears)
 */
export async function writeValidationToSheet(siteName, rowIndex, validation) {
  const settings = await loadSiteSettingsForPlanifier(siteName);
  const range = `${settings.sheetTabName}!${VALIDATION_COL}${rowIndex}`;
  if (!validation) {
    await SheetsAPI.writeRange(settings.sheetId, range, [['']], settings, { bgColor: '#ffffff' });
    return;
  }
  if (validation.valid) {
    await SheetsAPI.writeRange(settings.sheetId, range, [['valid']], settings, { bgColor: VALIDATION_VALID_COLOR });
  } else {
    const summary = (validation.issues || []).map(i => i.msg || i.kind).join(' | ').slice(0, 300);
    await SheetsAPI.writeRange(settings.sheetId, range, [[`invalid: ${summary}`]], settings, { bgColor: VALIDATION_INVALID_COLOR });
  }
}
