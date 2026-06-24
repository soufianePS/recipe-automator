/**
 * test-bulk-ui.mjs — smoke-test the bulk-selection UI on the Recipes tab:
 * checkboxes render, the bulk toolbar shows on selection, select-all works.
 */
import { chromium } from 'playwright';
import { join } from 'path';
const ROOT = process.cwd();
const outDir = join(ROOT, 'output', '_flow-test');

const browser = await chromium.launch({ headless: false, args: ['--window-size=1500,1000'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// Navigate to Planifier section, then the Recipes tab
await page.evaluate(() => { location.hash = '#planifier'; });
await page.waitForTimeout(2500);
const recTab = await page.$('.plf-tab[data-plftab="recipes"]');
if (!recTab) { console.log('FAIL: recipes tab button not found'); await browser.close(); process.exit(1); }
await recTab.click();

// Wait for recipe rows (or empty message)
await page.waitForTimeout(1000);
await page.waitForFunction(() => {
  const t = document.getElementById('plfRecipesTable');
  return t && (t.querySelectorAll('.plf-rec-row').length > 0 || /No recipes|Failed/i.test(t.textContent));
}, { timeout: 20000 }).catch(() => {});

const before = await page.evaluate(() => ({
  rows: document.querySelectorAll('.plf-rec-row').length,
  rowChecks: document.querySelectorAll('.plf-rec-select[data-key]').length,
  selectAll: !!document.getElementById('plfRecSelectAll'),
  barExists: !!document.getElementById('plfBulkBar'),
  barVisible: document.getElementById('plfBulkBar')?.style.display !== 'none',
}));
console.log('BEFORE selection:', JSON.stringify(before));

// Click the first row checkbox → bar should appear with "1 selected"
let afterOne = {};
if (before.rowChecks > 0) {
  await page.$eval('.plf-rec-select[data-key]', el => el.click());
  await page.waitForTimeout(400);
  afterOne = await page.evaluate(() => ({
    barVisible: document.getElementById('plfBulkBar')?.style.display === 'flex',
    count: document.getElementById('plfBulkCount')?.textContent,
    hasRegenBtn: /Regenerate pins/.test(document.getElementById('plfBulkBar')?.textContent || ''),
    hasQueueBtn: /Queue for Pinterest/.test(document.getElementById('plfBulkBar')?.textContent || ''),
    hasRecreateBtn: /Recreate/.test(document.getElementById('plfBulkBar')?.textContent || ''),
  }));
  console.log('AFTER selecting 1:', JSON.stringify(afterOne));

  // Open the bulk regen modal (single recipe selected = single site → modal opens)
  await page.evaluate(() => window.plfBulkRegen());
  await page.waitForTimeout(800);
  await page.waitForFunction(() => document.querySelectorAll('#plfRegenTemplates .plf-regen-thumb').length > 0 || /Failed|No /.test(document.getElementById('plfRegenTemplates')?.textContent || ''), { timeout: 8000 }).catch(() => {});
  const modal = await page.evaluate(() => ({
    slotBtns: document.querySelectorAll('#plfBulkRegenSlots .plf-slot-btn').length,
    templates: document.querySelectorAll('#plfRegenTemplates .plf-regen-thumb').length,
    submitDisabled: document.getElementById('plfBulkRegenSubmitBtn')?.disabled,
  }));
  console.log('REGEN MODAL:', JSON.stringify(modal));
  // Pick Pin 1 + first template → submit should enable
  await page.$eval('#plfBulkRegenSlots .plf-slot-btn[data-slot="0"]', el => el.click());
  if (modal.templates > 0) await page.$eval('#plfRegenTemplates .plf-regen-thumb', el => el.click());
  await page.waitForTimeout(300);
  const afterPick = await page.evaluate(() => ({
    slotSelected: document.querySelectorAll('#plfBulkRegenSlots .plf-slot-btn.selected').length,
    tmplSelected: !!document.querySelector('#plfRegenTemplates .plf-regen-thumb.selected'),
    submitDisabled: document.getElementById('plfBulkRegenSubmitBtn')?.disabled,
  }));
  console.log('AFTER pick slot+template:', JSON.stringify(afterPick));
  await page.screenshot({ path: join(outDir, 'bulk-regen-modal.png') });
  // Close without submitting (don't trigger real ChatGPT regen)
  await page.evaluate(() => document.querySelector('.plf-modal-backdrop')?.remove());
  await page.waitForTimeout(200);

  const modalOk = modal.slotBtns === 3 && modal.templates > 0 && modal.submitDisabled === true
    && afterPick.slotSelected === 1 && afterPick.tmplSelected && afterPick.submitDisabled === false;
  console.log(modalOk ? '✅ regen modal: slots + template picker + submit-gating OK' : '⚠ regen modal CHECK values above');
}

await page.screenshot({ path: join(outDir, 'bulk-ui.png'), fullPage: false });
const ok = before.rowChecks > 0 && before.selectAll && before.barExists && !before.barVisible
  && afterOne.barVisible && afterOne.hasRegenBtn && afterOne.hasQueueBtn && afterOne.hasRecreateBtn;
console.log(ok ? '\n✅ PASS — bulk UI renders + toggles correctly' : '\n⚠ CHECK — see values above + screenshot');
await browser.close();
