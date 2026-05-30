/**
 * Fix sites-config schema — remove obsolete template-folder columns.
 *
 * The columns pin_template_folder_gen (H) and pin_template_folder_scrap (I)
 * are per-user local paths and are now managed by the app via
 * backgrounds.json. They belong in local settings.json, not the shared sheet.
 *
 * This deletes columns H+I from sites-config in one shot, shifting the
 * created_at + notes columns left.
 *
 * One-shot script — safe to delete after running.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CREDS_PATH = join(PROJECT_ROOT, 'data', 'google-credentials.json');
const SHEET_ID = '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';
const TAB_NAME = 'sites-config';

async function main() {
  const creds = JSON.parse(await readFile(CREDS_PATH, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  // Find sheetId of sites-config
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tab = meta.data.sheets.find(s => s.properties.title === TAB_NAME);
  if (!tab) {
    console.error(`Tab ${TAB_NAME} not found.`);
    process.exit(1);
  }
  const sheetId = tab.properties.sheetId;
  console.log(`Found ${TAB_NAME} (sheetId=${sheetId}). Deleting columns H+I...`);

  // Delete columns H (index 7) and I (index 8) — delete in REVERSE order so
  // indices don't shift mid-operation.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 9 },
          },
        },
      ],
    },
  });
  console.log('✓ Columns deleted.');
  console.log('  New schema: site_id, display_name, wp_url, active, warming_enabled, recipes_tab, scraper_tab, created_at, notes');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
