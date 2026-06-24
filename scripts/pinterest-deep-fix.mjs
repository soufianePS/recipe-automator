/**
 * pinterest-deep-fix.mjs — AUTHORITATIVE sweep. For every pin in the audit JSON
 * whose destination wasn't confirmed clean, open the Edit form and read the real
 * link (#WebsiteField). If it's a draft ?p=<ID> URL, resolve the post's public
 * permalink (publishing the post if still draft) and set the pin's link to it.
 *
 * One Dolphin session. Skips pins already known clean (from the audit JSON).
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const ROOT = process.cwd();
const PROFILE_ID = 793614953;

const settings = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'sites', 'leagueofcooking', 'settings.json'), 'utf8'));
const WP = settings.wpUrl.replace(/\/$/, '');
const WP_AUTH = 'Basic ' + Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64');
const cfg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'planifier', 'config.json'), 'utf8'));

const audit = JSON.parse(fs.readFileSync(join(ROOT, 'output', '_flow-test', 'pinterest-pin-audit.json'), 'utf8'));
// Unique real pin URLs; skip ones already confirmed clean (dest set & not draft)
const seen = new Set();
const todo = [];
for (const r of audit) {
  const m = (r.pinUrl || '').match(/\/pin\/(\d+)\/?$/);
  if (!m) continue;
  const id = m[1];
  if (seen.has(id)) continue; seen.add(id);
  const cleanKnown = r.dest && !r.isDraft && /leagueofcooking\.com\/[a-z0-9-]+\//i.test(r.dest);
  if (cleanKnown) continue;          // already good
  todo.push(id);
}
console.log(`Audit had ${seen.size} unique pins · ${todo.length} to verify via Edit form\n`);

// Resolve a post's public permalink, publishing it if it's still a draft.
const permalinkCache = new Map();
async function resolvePermalink(postId) {
  if (permalinkCache.has(postId)) return permalinkCache.get(postId);
  let r = await fetch(`${WP}/wp-json/wp/v2/posts/${postId}?_fields=id,status,link&context=edit`, { headers: { Authorization: WP_AUTH } });
  let j = await r.json().catch(() => ({}));
  if (!j || !j.id) { permalinkCache.set(postId, null); return null; }
  if (j.status !== 'publish') {
    const pr = await fetch(`${WP}/wp-json/wp/v2/posts/${postId}`, { method: 'POST', headers: { Authorization: WP_AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'publish' }) });
    const pj = await pr.json().catch(() => ({}));
    if (pj.link) j.link = pj.link;
    console.log(`   (published post ${postId})`);
  }
  permalinkCache.set(postId, j.link || null);
  return j.link || null;
}

const dolphin = new DolphinAnty({ dolphinAnty: cfg.dolphinAnty });
console.log(`Starting Dolphin profile ${PROFILE_ID}…`);
const { port } = await dolphin.startAndGetCDP(PROFILE_ID);
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());
const cleanup = async () => { try { await browser.close(); } catch {} try { await dolphin.stopProfile(PROFILE_ID); } catch {} };

async function openEditForm(pinId) {
  await page.goto(`https://www.pinterest.com/pin/${pinId}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2800);
  await page.locator('button[aria-label="More actions"]').first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByText(/^Edit Pin$/i).first().click().catch(() => {});
  await page.waitForTimeout(2800);
  const link = page.locator('#WebsiteField');
  return (await link.count()) ? link : null;
}

try {
  let fixed = 0, clean = 0, nolink = 0, errors = 0;
  const fixes = [];
  for (let i = 0; i < todo.length; i++) {
    const pinId = todo[i];
    try {
      const link = await openEditForm(pinId);
      if (!link) { errors++; console.log(`${i + 1}/${todo.length} ${pinId}: ⚠ edit form not found`); continue; }
      const val = (await link.inputValue().catch(() => '')) || '';
      const m = val.match(/[?&]p=(\d+)/);
      if (!m) {
        if (!val) { nolink++; console.log(`${i + 1}/${todo.length} ${pinId}: (no link)`); }
        else { clean++; console.log(`${i + 1}/${todo.length} ${pinId}: ✅ clean (${val.slice(0, 60)})`); }
        // close editor without saving
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      const permalink = await resolvePermalink(m[1]);
      if (!permalink) { errors++; console.log(`${i + 1}/${todo.length} ${pinId}: ⚠ could not resolve post ${m[1]}`); await page.keyboard.press('Escape').catch(() => {}); continue; }
      await link.click().catch(() => {});
      await link.fill(permalink);
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: /^save$/i }).last().click().catch(() => {});
      await page.waitForTimeout(1500);
      if (await page.evaluate(() => /heads up|engagement metrics|will be lost/i.test(document.body.innerText))) {
        await page.getByRole('button', { name: /^save$/i }).last().click().catch(() => {});
        await page.waitForTimeout(3500);
      }
      fixed++;
      fixes.push({ pinId, from: val, to: permalink });
      console.log(`${i + 1}/${todo.length} ${pinId}: ❌→✅ ${val.match(/p=\d+/)[0]} → ${permalink}`);
    } catch (e) { errors++; console.log(`${i + 1}/${todo.length} ${pinId}: ERR ${e.message}`); }
    await page.waitForTimeout(900);
  }
  console.log(`\n══════════════════════════════════════════`);
  console.log(`SWEEP DONE: ${fixed} draft pins fixed · ${clean} already clean · ${nolink} no-link · ${errors} errors (of ${todo.length} checked)`);
  if (fixes.length) { console.log('\nFixed:'); fixes.forEach(f => console.log(`  ${f.pinId}: ${f.from.match(/p=\d+/)[0]} → ${f.to}`)); }
} finally {
  await cleanup();
  console.log('Dolphin stopped.');
}
