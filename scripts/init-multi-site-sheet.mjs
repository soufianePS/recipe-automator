/**
 * Init Multi-Site Sheet Migration
 * --------------------------------
 * Adds 5 new tabs to the existing Google Sheet (shared across all sites):
 *   - sites-config       — site metadata (1 row per site)
 *   - pin-campaigns      — calendar of pin regen/single-pin/warming jobs
 *   - pin-history        — audit log of every pin created
 *   - warming-pool       — Pinterest pin URLs to re-save during warming
 *   - warming-pin-list   — recipe names to generate warming pins from
 *
 * This script:
 *   1. Reads data/sites/{id}/settings.json for every site
 *   2. Verifies they all share the same sheetId
 *   3. Calls Apps Script "addSheet" action for each new tab (idempotent)
 *   4. Populates sites-config with current site metadata
 *
 * Existing recipe tabs ("League of cooking Gen", "single post", etc.) are
 * NOT migrated — they keep working as-is. Each site continues to use its own
 * recipes tab; the new tabs are for cross-site OPERATIONS layer (warming,
 * campaigns, history).
 *
 * Usage:
 *   node scripts/init-multi-site-sheet.mjs --dry-run    # preview, no writes
 *   node scripts/init-multi-site-sheet.mjs              # execute
 *
 * Idempotent: safe to re-run. addSheet only creates if missing. sites-config
 * rows are skipped if site_id already present.
 */

import { readdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const SITES_DIR = join(PROJECT_ROOT, 'data', 'sites');

const DRY_RUN = process.argv.includes('--dry-run');

// ── Schemas ──────────────────────────────────────────────────────

const TABS = [
  {
    name: 'sites-config',
    headerBgColor: '#cfe2f3',
    headers: [
      'site_id', 'display_name', 'wp_url', 'active', 'warming_enabled',
      'recipes_tab', 'scraper_tab', 'pin_template_folder_gen',
      'pin_template_folder_scrap', 'created_at', 'notes',
    ],
  },
  {
    name: 'pin-campaigns',
    headerBgColor: '#d9ead3',
    headers: [
      'campaign_id', 'site', 'recipe_url', 'recipe_title', 'type',
      'template', 'scheduled_date_1', 'scheduled_date_2', 'scheduled_date_3',
      'status_1', 'status_2', 'status_3', 'account_id', 'created_at', 'notes',
    ],
  },
  {
    name: 'pin-history',
    headerBgColor: '#fff2cc',
    headers: [
      'timestamp', 'site', 'type', 'recipe_topic', 'recipe_url',
      'pin_slot', 'template', 'wp_image_url', 'pinterest_url',
      'posted_at', 'account_id', 'notes',
    ],
  },
  {
    name: 'warming-pool',
    headerBgColor: '#f4cccc',
    headers: [
      'site', 'pin_url', 'keyword', 'status', 'saved_at',
      'saved_by_account', 'notes',
    ],
  },
  {
    name: 'warming-pin-list',
    headerBgColor: '#ead1dc',
    headers: [
      'site', 'topic', 'status', 'last_generated_at', 'assigned_account',
      'skip', 'notes',
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────

function logInfo(msg)  { console.log(`\x1b[34m[INFO]\x1b[0m  ${msg}`); }
function logOk(msg)    { console.log(`\x1b[32m[OK]\x1b[0m    ${msg}`); }
function logWarn(msg)  { console.log(`\x1b[33m[WARN]\x1b[0m  ${msg}`); }
function logErr(msg)   { console.log(`\x1b[31m[ERR]\x1b[0m   ${msg}`); }
function logDry(msg)   { console.log(`\x1b[36m[DRY]\x1b[0m   ${msg}`); }

async function loadSites() {
  if (!existsSync(SITES_DIR)) {
    throw new Error(`Sites directory not found: ${SITES_DIR}`);
  }
  const entries = await readdir(SITES_DIR, { withFileTypes: true });
  const sites = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_')) continue;
    const settingsPath = join(SITES_DIR, e.name, 'settings.json');
    if (!existsSync(settingsPath)) {
      logWarn(`Site "${e.name}" has no settings.json — skipping.`);
      continue;
    }
    try {
      const raw = await readFile(settingsPath, 'utf8');
      const settings = JSON.parse(raw);
      sites.push({ id: e.name, settings });
    } catch (err) {
      logWarn(`Failed to parse ${settingsPath}: ${err.message}`);
    }
  }
  return sites;
}

async function callAppsScript(url, body) {
  if (DRY_RUN) {
    logDry(`POST ${url.slice(0, 60)}...`);
    logDry(`     ${JSON.stringify(body).slice(0, 200)}${JSON.stringify(body).length > 200 ? '...' : ''}`);
    return { ok: true, dryRun: true };
  }
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'text/plain' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`Apps Script returned non-JSON: ${text.slice(0, 200)}`); }
  if (!res.ok || json.ok === false) {
    throw new Error(`Apps Script error: ${json.error || res.status}`);
  }
  return json;
}

async function readGvizSheet(sheetId, sheetName) {
  // Try to read an existing tab; returns rows array or null if tab missing.
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(sheetName)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/google\.visualization\.Query\.setResponse\(({.*})\)/s);
    if (!m) return null;
    const data = JSON.parse(m[1]);
    if (data.status === 'error') return null;
    if (!data.table || !data.table.rows) return [];
    return data.table.rows.map(r => r.c.map(c => (c && c.v != null) ? String(c.v) : ''));
  } catch {
    return null;
  }
}

function nowIso() { return new Date().toISOString(); }

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(60));
  console.log(' Multi-Site Sheet Migration');
  console.log('━'.repeat(60));
  if (DRY_RUN) logInfo('DRY RUN — no writes will happen.');

  // 1. Load sites
  const sites = await loadSites();
  if (sites.length === 0) {
    logErr('No sites found in data/sites/. Aborting.');
    process.exit(1);
  }
  logInfo(`Found ${sites.length} site(s): ${sites.map(s => s.id).join(', ')}`);

  // 2. Verify shared sheetId + appsScriptUrl
  const sheetIds = [...new Set(sites.map(s => s.settings.sheetId).filter(Boolean))];
  const appsScriptUrls = [...new Set(sites.map(s => s.settings.appsScriptUrl).filter(Boolean))];

  if (sheetIds.length === 0) {
    logErr('No sheetId found in any settings.json. Aborting.');
    process.exit(1);
  }
  if (sheetIds.length > 1) {
    logWarn(`Sites use ${sheetIds.length} different sheet IDs:`);
    sheetIds.forEach(id => logWarn(`  - ${id}`));
    logErr('All sites must share ONE sheetId for this migration. Update settings.json files first.');
    process.exit(1);
  }
  if (appsScriptUrls.length === 0) {
    logErr('No appsScriptUrl found. Aborting.');
    process.exit(1);
  }
  if (appsScriptUrls.length > 1) {
    logWarn(`Sites use ${appsScriptUrls.length} different Apps Script URLs — using first one.`);
  }

  const SHEET_ID = sheetIds[0];
  const APPS_SCRIPT_URL = appsScriptUrls[0];
  logInfo(`Sheet ID: ${SHEET_ID}`);
  logInfo(`Apps Script: ${APPS_SCRIPT_URL.slice(0, 60)}...`);

  // 3. Create the 5 new tabs (idempotent — Apps Script no-op if exists)
  console.log();
  logInfo('Creating new tabs...');
  for (const tab of TABS) {
    try {
      const res = await callAppsScript(APPS_SCRIPT_URL, {
        action: 'addSheet',
        spreadsheetId: SHEET_ID,
        sheetName: tab.name,
        headers: tab.headers,
        headerBgColor: tab.headerBgColor,
      });
      if (res.dryRun) {
        logDry(`  + ${tab.name} (${tab.headers.length} cols)`);
      } else if (res.created) {
        logOk(`  + ${tab.name} CREATED (${tab.headers.length} cols)`);
      } else {
        logInfo(`  • ${tab.name} already exists — headers refreshed`);
      }
    } catch (err) {
      logErr(`  ${tab.name} failed: ${err.message}`);
      logErr('  → Make sure you updated the Apps Script with the new code (scripts/apps-script-multi-site.gs)');
      process.exit(1);
    }
  }

  // 4. Read current sites-config rows to skip duplicates
  let existingSiteIds = new Set();
  if (!DRY_RUN) {
    const rows = await readGvizSheet(SHEET_ID, 'sites-config');
    if (rows && rows.length > 0) {
      existingSiteIds = new Set(rows.map(r => r[0]).filter(Boolean));
      if (existingSiteIds.size > 0) {
        logInfo(`sites-config has ${existingSiteIds.size} existing row(s): ${[...existingSiteIds].join(', ')}`);
      }
    }
  }

  // 5. Populate sites-config
  console.log();
  logInfo('Populating sites-config...');
  for (const site of sites) {
    if (existingSiteIds.has(site.id)) {
      logInfo(`  • ${site.id} already in sites-config — skipping`);
      continue;
    }
    const s = site.settings;
    const row = [
      site.id,                                          // site_id
      s.siteName || site.id,                            // display_name
      s.wpUrl || '',                                    // wp_url
      'TRUE',                                           // active
      'FALSE',                                          // warming_enabled (default off)
      s.generatorSheetTab || s.sheetTabName || '',      // recipes_tab
      s.scraperSheetTab || '',                          // scraper_tab
      s.pinterestTemplateFolderGenerator || '',         // pin_template_folder_gen
      s.pinterestTemplateFolderScrap || s.pinterestTemplateFolderScraper || '', // pin_template_folder_scrap
      nowIso(),                                         // created_at
      'migrated from settings.json',                    // notes
    ];
    try {
      await callAppsScript(APPS_SCRIPT_URL, {
        action: 'appendRow',
        spreadsheetId: SHEET_ID,
        sheetName: 'sites-config',
        values: row,
      });
      logOk(`  + ${site.id} → row added`);
    } catch (err) {
      logErr(`  ${site.id} failed: ${err.message}`);
    }
  }

  // 6. Print summary
  console.log();
  console.log('━'.repeat(60));
  if (DRY_RUN) {
    logInfo('DRY RUN complete. Re-run without --dry-run to execute.');
  } else {
    logOk('Migration complete.');
    logInfo(`Open the sheet to verify: https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`);
    logInfo('You should now see 5 new tabs + your existing recipe tabs.');
    logInfo('sites-config should contain a row per site with current metadata.');
    logInfo('warming_enabled defaults to FALSE — set to TRUE per site when you want warming mode.');
  }
  console.log('━'.repeat(60));
}

main().catch(err => {
  console.error('\n❌ Migration failed:', err);
  process.exit(1);
});
