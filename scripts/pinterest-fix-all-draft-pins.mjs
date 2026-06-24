/**
 * pinterest-fix-all-draft-pins.mjs — fix every pin that links to a draft ?p=ID
 * URL by editing its destination to the clean public permalink. One Dolphin
 * session for all. Flow per pin: open pin → More actions → Edit Pin →
 * set #WebsiteField → Save → confirm "metrics will be lost" dialog → verify.
 *
 * Edit the PINS array below (pinId → clean url).
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const ROOT = process.cwd();
const PROFILE_ID = 793614953;
const outDir = join(ROOT, 'output', '_flow-test');

// Draft-linked pins found by the audit (4539 already fixed)
const PINS = [
  { pinId: '1151232723521929392', url: 'https://leagueofcooking.com/creamy-tomato-pasta/' },
  { pinId: '1151232723521915997', url: 'https://leagueofcooking.com/one-pot-chicken-alfredo-pasta/' },
  { pinId: '1151232723521913664', url: 'https://leagueofcooking.com/spaghetti-and-meatballs/' },
];

const cfg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'planifier', 'config.json'), 'utf8'));
const dolphin = new DolphinAnty({ dolphinAnty: cfg.dolphinAnty });
console.log(`Starting Dolphin profile ${PROFILE_ID}…`);
const { port } = await dolphin.startAndGetCDP(PROFILE_ID);
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());
const cleanup = async () => { try { await browser.close(); } catch {} try { await dolphin.stopProfile(PROFILE_ID); } catch {} };

async function readDest() {
  return page.evaluate(() => {
    const a = [...document.querySelectorAll('a[href]')].map(x => x.href).find(h => /leagueofcooking\.com/i.test(h));
    if (a) return a;
    const m = document.documentElement.innerHTML.match(/"link":"(https?:[^"]*leagueofcooking\.com[^"]*)"/i);
    return m ? m[1].replace(/\\\//g, '/') : null;
  });
}

async function fixPin({ pinId, url }) {
  await page.goto(`https://www.pinterest.com/pin/${pinId}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  const before = await readDest();
  if (before && !/[?&]p=\d/.test(before)) { return { pinId, skipped: true, before, after: before, note: 'already clean' }; }
  // More actions → Edit Pin
  await page.locator('button[aria-label="More actions"]').first().click().catch(() => {});
  await page.waitForTimeout(1200);
  await page.getByText(/^Edit Pin$/i).first().click().catch(() => {});
  await page.waitForTimeout(3500);
  const link = page.locator('#WebsiteField');
  if (!(await link.count())) return { pinId, error: 'edit form / #WebsiteField not found' };
  await link.click().catch(() => {});
  await link.fill(url);
  await page.waitForTimeout(500);
  // Save + confirm "metrics will be lost"
  await page.getByRole('button', { name: /^save$/i }).last().click().catch(() => {});
  await page.waitForTimeout(1600);
  if (await page.evaluate(() => /heads up|engagement metrics|will be lost/i.test(document.body.innerText))) {
    await page.getByRole('button', { name: /^save$/i }).last().click().catch(() => {});
    await page.waitForTimeout(4000);
  }
  // Verify
  await page.goto(`https://www.pinterest.com/pin/${pinId}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  const after = await readDest();
  return { pinId, before, after, ok: after && !/[?&]p=\d/.test(after) };
}

try {
  const results = [];
  for (const p of PINS) {
    try { const r = await fixPin(p); results.push(r); console.log(`${r.ok ? '✅' : (r.skipped ? '↷' : '❌')} ${p.pinId}: ${r.before} → ${r.after}${r.error ? ' ERR:' + r.error : ''}`); }
    catch (e) { results.push({ pinId: p.pinId, error: e.message }); console.log(`❌ ${p.pinId}: ${e.message}`); }
  }
  const fixed = results.filter(r => r.ok).length;
  console.log(`\nDONE: ${fixed}/${PINS.length} pins now have clean links.`);
} finally {
  await cleanup();
  console.log('Dolphin stopped.');
}
