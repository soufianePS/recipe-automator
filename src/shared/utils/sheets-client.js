/**
 * Sheets Client — service-account authenticated wrapper around googleapis.
 *
 * This is the NEW path for sheet access. Use this for the multi-site
 * operational tabs (sites-config, pin-campaigns, pin-history, warming-pool,
 * warming-pin-list). The legacy gviz+AppsScript path (sheets-api.js) stays
 * untouched for the existing recipes/scraper tabs.
 *
 * Authentication: reads data/google-credentials.json (gitignored).
 * Lazy: the client is created once on first use.
 *
 * Required: data/google-credentials.json must exist + service-account email
 * must be shared as Editor on the target spreadsheet. If credentials are
 * missing, helpers throw a clear actionable error.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import { Logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const CREDS_PATH = join(PROJECT_ROOT, 'data', 'google-credentials.json');

// Shared spreadsheet ID — same for all sites. Lifted from any site's
// settings.json (they all share this one already). If a user ever needs to
// switch spreadsheets, override via SHEET_ID env var.
export const MULTI_SITE_SHEET_ID =
  process.env.SHEET_ID || '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';

let _cachedClient = null;
let _cachedAuth = null;
let _credsMissingWarned = false;

/**
 * Get an authenticated Sheets API v4 client. Cached after first call.
 * Throws if credentials file is missing or invalid.
 */
export async function getSheetsClient() {
  if (_cachedClient) return _cachedClient;
  if (!existsSync(CREDS_PATH)) {
    if (!_credsMissingWarned) {
      Logger.warn('[Sheets] google-credentials.json not found in data/. Multi-site sheet features disabled.');
      _credsMissingWarned = true;
    }
    throw new Error(`Missing ${CREDS_PATH}. See scripts/init-sheet-v2.mjs for setup.`);
  }
  const credsRaw = await readFile(CREDS_PATH, 'utf8');
  const creds = JSON.parse(credsRaw);
  _cachedAuth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  _cachedClient = google.sheets({ version: 'v4', auth: _cachedAuth });
  return _cachedClient;
}

/** Quick check — does the credentials file exist? */
export function credentialsAvailable() {
  return existsSync(CREDS_PATH);
}

// ── Convenience helpers ────────────────────────────────────────────

/**
 * Read all rows from a tab as an array of objects keyed by the header row.
 * Empty cells become empty strings.
 *
 * @param {string} tabName
 * @param {object} [opts]
 * @param {string} [opts.spreadsheetId=MULTI_SITE_SHEET_ID]
 * @returns {Promise<Array<Object>>}
 */
export async function readTabAsObjects(tabName, opts = {}) {
  const spreadsheetId = opts.spreadsheetId || MULTI_SITE_SHEET_ID;
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:ZZ`,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      const v = row[i];
      obj[h] = v == null ? '' : v;
    });
    return obj;
  });
}

/**
 * Append rows of objects to a tab. Keys are matched against the existing
 * header row; missing columns are written as empty strings.
 *
 * @param {string} tabName
 * @param {Array<Object>} objects
 * @param {object} [opts]
 */
export async function appendObjects(tabName, objects, opts = {}) {
  if (!objects || objects.length === 0) return { appended: 0 };
  const spreadsheetId = opts.spreadsheetId || MULTI_SITE_SHEET_ID;
  const sheets = await getSheetsClient();
  // Get the header row to know column order
  const hdrRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!1:1`,
  });
  const headers = hdrRes.data.values?.[0] || [];
  if (headers.length === 0) {
    throw new Error(`Tab "${tabName}" has no header row — can't append by object`);
  }
  const values = objects.map(obj => headers.map(h => {
    const v = obj[h];
    if (v == null) return '';
    if (typeof v === 'boolean') return v;  // Sheets API accepts boolean for TRUE/FALSE cells
    return String(v);
  }));
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
  return { appended: values.length };
}

/**
 * Update a single cell (or range) by A1 notation.
 *
 * @param {string} range — e.g. "sites-config!E2" or "pin-history!H2:H5"
 * @param {Array<Array>|Array} values — 2D array; or 1D will be wrapped
 */
export async function updateRange(range, values, opts = {}) {
  const spreadsheetId = opts.spreadsheetId || MULTI_SITE_SHEET_ID;
  const sheets = await getSheetsClient();
  // Normalize 1D → 2D
  const vals = Array.isArray(values[0]) ? values : [values];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: vals },
  });
}

/**
 * Find the row index (1-based, Sheets-style) for a row where a column
 * matches a value. Returns null if not found.
 *
 * Useful pattern: locate the right row to update by site_id, campaign_id, etc.
 *
 * @param {string} tabName
 * @param {string} columnHeader — header name like "site_id"
 * @param {string} value — value to match
 * @returns {Promise<number|null>} row index (≥2) or null
 */
export async function findRowByColumn(tabName, columnHeader, value, opts = {}) {
  const objects = await readTabAsObjects(tabName, opts);
  for (let i = 0; i < objects.length; i++) {
    if (objects[i][columnHeader] === value) {
      return i + 2;  // row 1 = header, data starts at row 2
    }
  }
  return null;
}

/**
 * Update a single cell at a header-named column on the row matching another
 * column. Concrete example: "set status_1=posted on the campaign row where
 * campaign_id=abc-123".
 *
 * @param {string} tabName
 * @param {string} matchColumn — header name to match on (e.g. "campaign_id")
 * @param {string} matchValue — value to find
 * @param {Object} patch — { headerName: newValue, ... }
 * @returns {Promise<{ updated: number }>}
 */
export async function patchRow(tabName, matchColumn, matchValue, patch, opts = {}) {
  const spreadsheetId = opts.spreadsheetId || MULTI_SITE_SHEET_ID;
  const sheets = await getSheetsClient();
  // Load header + data in one pass
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:ZZ`,
  });
  const rows = res.data.values || [];
  if (rows.length < 2) return { updated: 0 };
  const headers = rows[0];
  const matchIdx = headers.indexOf(matchColumn);
  if (matchIdx === -1) throw new Error(`Column "${matchColumn}" not found in ${tabName}`);

  let rowIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][matchIdx] === matchValue) { rowIndex = i + 1; break; }
  }
  if (rowIndex === -1) return { updated: 0 };

  // Build A1 ranges for each patch field
  const updates = [];
  for (const [key, value] of Object.entries(patch)) {
    const colIdx = headers.indexOf(key);
    if (colIdx === -1) {
      Logger.warn(`[Sheets] patchRow: column "${key}" not in ${tabName} — skipping`);
      continue;
    }
    const colLetter = _colLetter(colIdx);
    updates.push({
      range: `${tabName}!${colLetter}${rowIndex}`,
      values: [[value == null ? '' : value]],
    });
  }
  if (updates.length === 0) return { updated: 0 };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
  });
  return { updated: updates.length };
}

const _sheetIdCache = new Map(); // `${spreadsheetId}|${tabName}` -> numeric sheetId

/** Resolve a tab name to its numeric sheetId (needed for formatting calls). */
async function _resolveSheetId(spreadsheetId, tabName) {
  const key = `${spreadsheetId}|${tabName}`;
  if (_sheetIdCache.has(key)) return _sheetIdCache.get(key);
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  for (const s of res.data.sheets || []) {
    _sheetIdCache.set(`${spreadsheetId}|${s.properties.title}`, s.properties.sheetId);
  }
  if (!_sheetIdCache.has(key)) throw new Error(`Tab "${tabName}" not found in spreadsheet ${spreadsheetId}`);
  return _sheetIdCache.get(key);
}

function _hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { red: ((n >> 16) & 255) / 255, green: ((n >> 8) & 255) / 255, blue: (n & 255) / 255 };
}

/**
 * Write a value to a single cell AND set its background color, via the real
 * authenticated Sheets API (no Apps Script involved). This is the reliable
 * replacement for the legacy gviz+AppsScript write path (sheets-api.js),
 * which has been observed to silently drop or mis-assign writes.
 *
 * @param {string} tabName
 * @param {string} a1Cell — e.g. "V92" (single cell, no tab prefix)
 * @param {*} value
 * @param {string|null} [bgColor] — CSS hex like "#c6efce", or null to clear
 */
export async function writeCellWithColor(tabName, a1Cell, value, bgColor, opts = {}) {
  const spreadsheetId = opts.spreadsheetId || MULTI_SITE_SHEET_ID;
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!${a1Cell}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value == null ? '' : value]] },
  });
  if (bgColor !== undefined) {
    const sheetId = await _resolveSheetId(spreadsheetId, tabName);
    const m = /^([A-Z]+)(\d+)$/.exec(a1Cell);
    if (!m) throw new Error(`Bad A1 cell: ${a1Cell}`);
    const colIdx = m[1].split('').reduce((acc, c) => acc * 26 + (c.charCodeAt(0) - 64), 0) - 1;
    const rowIdx = Number(m[2]) - 1;
    const color = bgColor ? _hexToRgb(bgColor) : { red: 1, green: 1, blue: 1 };
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{
          repeatCell: {
            range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
            cell: { userEnteredFormat: { backgroundColor: color } },
            fields: 'userEnteredFormat.backgroundColor',
          },
        }],
      },
    });
  }
}

function _colLetter(idx) {
  // 0 → A, 25 → Z, 26 → AA, 27 → AB
  let result = '';
  let n = idx;
  while (n >= 0) {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}
