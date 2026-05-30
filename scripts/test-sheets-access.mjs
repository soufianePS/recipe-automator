/**
 * Quick test: validate service-account access to the Google Sheet.
 *   1. Authenticate with the service account credentials.
 *   2. Read the sheet metadata (list of all tabs).
 *   3. Attempt a tiny write (and immediate revert) to confirm Editor permission.
 * Exits non-zero on any failure with an actionable message.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const CREDS_PATH = join(PROJECT_ROOT, 'data', 'google-credentials.json');
const SHEET_ID = '1ZWZGfKV3dqkwJZ7Hhw-tLo6t8LwZVeBPZ4zEfjm0l0Y';

const ok = m => console.log(`\x1b[32m[OK]\x1b[0m   ${m}`);
const info = m => console.log(`\x1b[34m[INFO]\x1b[0m ${m}`);
const err = m => console.log(`\x1b[31m[ERR]\x1b[0m  ${m}`);

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

async function main() {
  console.log('━'.repeat(60));
  console.log(' Google Sheets API access test');
  console.log('━'.repeat(60));

  const { auth, creds } = await getAuth();
  info(`Service account: ${creds.client_email}`);
  info(`Sheet ID: ${SHEET_ID}`);

  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Read metadata — list all tabs
  let meta;
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    meta = res.data;
    ok(`Read access works. Sheet title: "${meta.properties.title}"`);
    info(`Existing tabs (${meta.sheets.length}):`);
    for (const s of meta.sheets) {
      console.log(`     • ${s.properties.title} (sheetId=${s.properties.sheetId})`);
    }
  } catch (e) {
    err(`Read FAILED: ${e.message}`);
    if (e.message.includes('does not have permission') || e.message.includes('PERMISSION_DENIED') || e.status === 403) {
      err('→ The sheet is NOT shared with the service account email yet.');
      err('→ Open the sheet, click Share, paste:');
      err(`     ${creds.client_email}`);
      err('   set role to Editor, send.');
    }
    process.exit(1);
  }

  // 2. Write test — append a value to A1 of an existing tab, then revert
  const firstTab = meta.sheets[0].properties.title;
  const testRange = `${firstTab}!ZZ1`; // remote cell unlikely to interfere
  try {
    // Read whatever is currently in ZZ1
    const before = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: testRange });
    const original = before.data.values?.[0]?.[0] ?? '';

    // Write a sentinel
    const sentinel = `__sa_test_${Date.now()}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: testRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[sentinel]] },
    });

    // Read back
    const after = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: testRange });
    const got = after.data.values?.[0]?.[0] ?? '';
    if (got !== sentinel) throw new Error(`Write verification failed. Expected "${sentinel}", got "${got}"`);

    // Revert
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: testRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[original]] },
    });

    ok(`Write access works. Round-trip on ${testRange} succeeded + reverted.`);
  } catch (e) {
    err(`Write FAILED: ${e.message}`);
    if (e.message.includes('does not have permission') || e.message.includes('PERMISSION_DENIED') || e.status === 403) {
      err(`→ Service account has READ but not WRITE permission. Re-share with Editor role.`);
    }
    process.exit(1);
  }

  console.log('━'.repeat(60));
  ok('All checks passed. Full control confirmed.');
  console.log('━'.repeat(60));
}

main().catch(e => {
  err('Unexpected error: ' + e.message);
  process.exit(1);
});
