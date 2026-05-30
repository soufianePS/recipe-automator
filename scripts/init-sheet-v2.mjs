/**
 * Init Multi-Site Sheet (v2 — uses Google Sheets API directly via service account).
 *
 * Creates 5 new tabs on the shared sheet, applies header formatting, freezes
 * the first row, sets bold+coloured headers, applies data validation where
 * appropriate, then populates sites-config with current per-site metadata
 * read from data/sites/(siteId)/settings.json.
 *
 * Idempotent: tabs that already exist are skipped (or have only their headers
 * refreshed). sites-config rows are deduped by site_id.
 *
 * Safe: never touches existing tabs (recipes, scraper, Config, etc.).
 */

import { readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CREDS_PATH = join(PROJECT_ROOT, 'data', 'google-credentials.json');
const SITES_DIR = join(PROJECT_ROOT, 'data', 'sites');
const SHEET_ID = '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';

const DRY_RUN = process.argv.includes('--dry-run');

const ok   = m => console.log(`\x1b[32m[OK]\x1b[0m   ${m}`);
const info = m => console.log(`\x1b[34m[INFO]\x1b[0m ${m}`);
const warn = m => console.log(`\x1b[33m[WARN]\x1b[0m ${m}`);
const err  = m => console.log(`\x1b[31m[ERR]\x1b[0m  ${m}`);
const dry  = m => console.log(`\x1b[36m[DRY]\x1b[0m  ${m}`);

// ── Schemas ──────────────────────────────────────────────────────

const TABS = [
  {
    name: 'sites-config',
    headerBg: { red: 0.81, green: 0.89, blue: 0.95 },  // light blue
    // Template folders are per-USER (local paths) + now managed by the app
    // (backgrounds.json), so they live in local settings.json, NOT here.
    // Only globally-shared metadata stays in sites-config.
    headers: [
      'site_id', 'display_name', 'wp_url', 'active', 'warming_enabled',
      'recipes_tab', 'scraper_tab', 'created_at', 'notes',
    ],
    // Add TRUE/FALSE validation on active + warming_enabled columns (D, E)
    booleanColumns: [3, 4],  // 0-indexed: active, warming_enabled
  },
  {
    name: 'pin-campaigns',
    headerBg: { red: 0.85, green: 0.92, blue: 0.83 },  // light green
    headers: [
      'campaign_id', 'site', 'recipe_url', 'recipe_title', 'type',
      'template', 'scheduled_date_1', 'scheduled_date_2', 'scheduled_date_3',
      'status_1', 'status_2', 'status_3', 'account_id', 'created_at', 'notes',
    ],
  },
  {
    name: 'pin-history',
    headerBg: { red: 1.0, green: 0.95, blue: 0.80 },  // light yellow
    headers: [
      'timestamp', 'site', 'type', 'recipe_topic', 'recipe_url',
      'pin_slot', 'template', 'wp_image_url', 'pinterest_url',
      'posted_at', 'account_id', 'notes',
    ],
  },
  {
    name: 'warming-pool',
    headerBg: { red: 0.96, green: 0.80, blue: 0.80 },  // light red
    headers: [
      'site', 'pin_url', 'keyword', 'status', 'saved_at',
      'saved_by_account', 'notes',
    ],
  },
  {
    name: 'warming-pin-list',
    headerBg: { red: 0.92, green: 0.82, blue: 0.86 },  // light pink
    headers: [
      'site', 'topic', 'status', 'last_generated_at', 'assigned_account',
      'skip', 'notes',
    ],
    booleanColumns: [5],  // skip
  },
];

const nowIso = () => new Date().toISOString();

async function loadSites() {
  if (!existsSync(SITES_DIR)) return [];
  const entries = await readdir(SITES_DIR, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const p = join(SITES_DIR, e.name, 'settings.json');
    if (!existsSync(p)) continue;
    try {
      const settings = JSON.parse(await readFile(p, 'utf8'));
      out.push({ id: e.name, settings });
    } catch (er) {
      warn(`${e.name}: settings.json parse failed: ${er.message}`);
    }
  }
  return out;
}

async function getAuth() {
  const raw = await readFile(CREDS_PATH, 'utf8');
  const creds = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return { auth, creds };
}

async function getExistingTabs(sheets) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const map = new Map();
  for (const s of res.data.sheets) {
    map.set(s.properties.title, s.properties.sheetId);
  }
  return map;
}

async function readSitesConfigIds(sheets, sheetTitle) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetTitle}!A2:A`,
    });
    return new Set((res.data.values || []).map(r => r[0]).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function main() {
  console.log('━'.repeat(60));
  console.log(' Multi-Site Sheet Init (Service Account)');
  console.log('━'.repeat(60));
  if (DRY_RUN) info('DRY RUN — no writes.');

  const { auth, creds } = await getAuth();
  info(`Service account: ${creds.client_email}`);
  const sheets = google.sheets({ version: 'v4', auth });

  const sites = await loadSites();
  info(`Found ${sites.length} local site(s): ${sites.map(s => s.id).join(', ')}`);

  const existingTabs = await getExistingTabs(sheets);
  info(`Sheet has ${existingTabs.size} existing tab(s).`);

  // ── Step 1: create missing tabs ──────────────────────────
  console.log();
  info('Step 1 — Creating missing tabs...');
  const createRequests = [];
  for (const tab of TABS) {
    if (existingTabs.has(tab.name)) {
      info(`  • ${tab.name} exists (sheetId=${existingTabs.get(tab.name)}) — will refresh headers only`);
      continue;
    }
    createRequests.push({
      addSheet: {
        properties: {
          title: tab.name,
          gridProperties: { rowCount: 1000, columnCount: tab.headers.length, frozenRowCount: 1 },
        },
      },
    });
  }
  if (createRequests.length > 0) {
    if (DRY_RUN) {
      dry(`  Would create ${createRequests.length} new tab(s).`);
    } else {
      const res = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { requests: createRequests },
      });
      for (const r of res.data.replies) {
        if (r.addSheet) {
          ok(`  + Created tab "${r.addSheet.properties.title}" (sheetId=${r.addSheet.properties.sheetId})`);
          existingTabs.set(r.addSheet.properties.title, r.addSheet.properties.sheetId);
        }
      }
    }
  } else {
    info('  All tabs already exist — skipping create.');
  }

  if (DRY_RUN) {
    info('DRY RUN done.');
    return;
  }

  // ── Step 2: write headers + formatting ───────────────────
  console.log();
  info('Step 2 — Writing headers + formatting...');
  const formatRequests = [];
  const valueUpdates = [];
  for (const tab of TABS) {
    const sheetId = existingTabs.get(tab.name);
    if (sheetId == null) {
      warn(`  ${tab.name} has no sheetId after creation — skipping`);
      continue;
    }
    // Values: headers in row 1
    valueUpdates.push({
      range: `${tab.name}!A1:${String.fromCharCode(65 + tab.headers.length - 1)}1`,
      values: [tab.headers],
    });
    // Format: bold + bg color + freeze row 1
    formatRequests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0, endRowIndex: 1,
          startColumnIndex: 0, endColumnIndex: tab.headers.length,
        },
        cell: {
          userEnteredFormat: {
            backgroundColor: tab.headerBg,
            textFormat: { bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });
    formatRequests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
    // Auto-resize columns
    formatRequests.push({
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: 'COLUMNS',
          startIndex: 0,
          endIndex: tab.headers.length,
        },
      },
    });
    // Boolean validation (TRUE/FALSE dropdown) where requested
    if (tab.booleanColumns) {
      for (const colIdx of tab.booleanColumns) {
        formatRequests.push({
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1, endRowIndex: 1000,
              startColumnIndex: colIdx, endColumnIndex: colIdx + 1,
            },
            rule: {
              condition: {
                type: 'BOOLEAN',
              },
              showCustomUi: true,
              strict: true,
            },
          },
        });
      }
    }
  }

  if (valueUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: valueUpdates },
    });
    ok(`  Headers written across ${valueUpdates.length} tab(s)`);
  }
  if (formatRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: formatRequests },
    });
    ok(`  Applied ${formatRequests.length} formatting/validation operation(s)`);
  }

  // ── Step 3: populate sites-config ────────────────────────
  console.log();
  info('Step 3 — Populating sites-config...');
  const existingSiteIds = await readSitesConfigIds(sheets, 'sites-config');
  if (existingSiteIds.size > 0) {
    info(`  sites-config already has rows for: ${[...existingSiteIds].join(', ')}`);
  }

  const newRows = [];
  for (const site of sites) {
    if (existingSiteIds.has(site.id)) {
      info(`  • ${site.id} already present — skipping`);
      continue;
    }
    const s = site.settings;
    newRows.push([
      site.id,
      s.siteName || site.id,
      s.wpUrl || '',
      true,    // active (boolean)
      false,   // warming_enabled (boolean)
      s.generatorSheetTab || s.sheetTabName || '',
      s.scraperSheetTab || '',
      nowIso(),
      'migrated from settings.json',
    ]);
  }
  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'sites-config!A2',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: newRows },
    });
    ok(`  Appended ${newRows.length} row(s) to sites-config`);
  } else {
    info('  No new rows to append.');
  }

  // ── Done ─────────────────────────────────────────────────
  console.log();
  console.log('━'.repeat(60));
  ok('Migration complete.');
  info(`Open the sheet: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
  console.log('━'.repeat(60));
}

main().catch(e => {
  err('Failed: ' + e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
