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
import { Logger } from '../../shared/utils/logger.js';
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
const PIN_BLOCK_START = 'F';
const WP_STATUS_COL = 'R';
const POSTED_COLS = ['U', 'V', 'W'];

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

    // WP status — only post pins for posts that are actually live
    const wpStatus = (row[idxWpStatus] || '').trim().toLowerCase();
    if (wpStatus !== 'published') continue;

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
    });
  }
  return out;
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
 * Selection rules:
 *   1. Recipe assigned to this account (Strategy A)
 *   2. Pin not yet posted (postedAt is empty)
 *   3. Today >= eligibleAt (pinSpreadDays respected)
 *   4. FIFO — oldest publishedAt first; tie-broken by pinIndex
 *
 * Returns { recipe, pin } or null if no eligible pin.
 */
export async function pickNextEligiblePin(planifierConfig, siteName, accountId) {
  const pool = await readSitePool(siteName, planifierConfig);
  const todayKey = new Date().toISOString().slice(0, 10);
  let best = null;
  for (const recipe of pool) {
    if (recipe.assignedAccountId !== accountId) continue;
    for (const pin of recipe.pins) {
      if (pin.postedAt) continue;
      if (!pin.imageUrl) continue;   // no image generated yet
      if (pin.eligibleAt && pin.eligibleAt > todayKey) continue;
      if (!best
          || (recipe.publishedAt || '') < (best.recipe.publishedAt || '')
          || ((recipe.publishedAt || '') === (best.recipe.publishedAt || '') && pin.pinIndex < best.pin.pinIndex)) {
        best = { recipe, pin };
      }
    }
  }
  return best;
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
  const settings = await loadSiteSettings(siteName);
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
  const settings = await loadSiteSettings(siteName);
  const col = POSTED_COLS[pinIndex];
  if (!col) throw new Error(`Invalid pinIndex: ${pinIndex}`);
  const range = `${settings.sheetTabName}!${col}${rowIndex}`;
  await SheetsAPI.writeRange(settings.sheetId, range, [['']], settings, { bgColor: CLEAR_COLOR });
}
