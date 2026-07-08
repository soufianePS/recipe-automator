/**
 * Apps Script — recipe-automator multi-site bridge (upgraded)
 *
 * REPLACE your current Apps Script doPost() with this code, then redeploy.
 *
 * Backward-compatible: existing writeRange calls (with {spreadsheetId, range,
 * values, bgColor} body and no `action` field) still work exactly as before.
 *
 * NEW capabilities (triggered by action field in POST body):
 *   - action: "addSheet"       — create a new tab if missing, write headers,
 *                                freeze first row, apply header style.
 *   - action: "appendRow"      — append a row at the bottom of a tab
 *                                (no need to know rowIndex).
 *   - action: "writeRange"     — explicit version of legacy behavior.
 *
 * Deploy steps (only need to do once after editing):
 *   1. Open Apps Script editor in browser (same project as current one).
 *   2. Paste this entire file (replace existing code).
 *   3. Click "Deploy" → "Manage deployments" → edit existing deployment.
 *   4. Bump version, save, copy NEW URL (it usually stays the same).
 *   5. Paste new URL in settings.json appsScriptUrl if it changed.
 */

function doPost(e) {
  // Two separate automations (different sites/users) share this one script
  // and spreadsheet. Without a lock, two writes landing at nearly the same
  // moment can interleave and drop or cross-write each other's values —
  // e.g. a "mark pin posted" write silently failing, which then causes the
  // same pin to be re-picked and posted again on the next run. The lock
  // forces writes to happen one at a time.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000); // wait up to 30s for another write to finish
  } catch (lockErr) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Could not acquire lock (another write is taking too long): ' + String(lockErr) }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || 'writeRange';
    const ss = SpreadsheetApp.openById(body.spreadsheetId);

    if (action === 'addSheet') {
      return handleAddSheet(ss, body);
    }
    if (action === 'appendRow') {
      return handleAppendRow(ss, body);
    }
    // Default: legacy writeRange
    return handleWriteRange(ss, body);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err && err.message || err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function handleAddSheet(ss, body) {
  var sheetName = body.sheetName;
  var headers = body.headers || [];
  var headerBgColor = body.headerBgColor || '#dfe9f3';
  var created = false;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    created = true;
  }
  if (headers.length > 0) {
    var range = sheet.getRange(1, 1, 1, headers.length);
    range.setValues([headers]);
    range.setFontWeight('bold');
    range.setBackground(headerBgColor);
    sheet.setFrozenRows(1);
    // Auto-resize columns for readability
    for (var c = 1; c <= headers.length; c++) sheet.autoResizeColumn(c);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, created: created, sheet: sheetName }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleAppendRow(ss, body) {
  var sheet = ss.getSheetByName(body.sheetName);
  if (!sheet) throw new Error('Sheet not found: ' + body.sheetName);
  sheet.appendRow(body.values);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, appended: 1 }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleWriteRange(ss, body) {
  var range = ss.getRange(body.range);
  range.setValues(body.values);
  if (body.bgColor) {
    range.setBackground(body.bgColor);
  } else if (body.bgColor === null) {
    range.setBackground(null);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
