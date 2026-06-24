/**
 * pinterest-edit-pin-link.mjs — edit a posted pin's DESTINATION link on Pinterest
 * (via Dolphin) from the draft ?p=ID URL to the clean public permalink.
 *
 * Usage: node scripts/pinterest-edit-pin-link.mjs <pinId> <newUrl> [--apply]
 *   without --apply = DISCOVER only (dump the edit form, screenshots, no save)
 *   with --apply    = fill the link field + Save
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const ROOT = process.cwd();
const PROFILE_ID = 793614953;
const outDir = join(ROOT, 'output', '_flow-test');
const [pinId, newUrl] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!pinId || !newUrl) { console.error('usage: <pinId> <newUrl> [--apply]'); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'planifier', 'config.json'), 'utf8'));
const dolphin = new DolphinAnty({ dolphinAnty: cfg.dolphinAnty });
console.log(`Starting Dolphin profile ${PROFILE_ID}…`);
const { port } = await dolphin.startAndGetCDP(PROFILE_ID);
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());
const cleanup = async () => { try { await browser.close(); } catch {} try { await dolphin.stopProfile(PROFILE_ID); } catch {} };

try {
  // Open the pin VIEW page first (as owner), then click the Edit (pencil) control.
  const pinUrl = `https://www.pinterest.com/pin/${pinId}/`;
  console.log(`Opening ${pinUrl}`);
  await page.goto(pinUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(outDir, `pinedit-${pinId}-0-view.png`) });

  // Dump ALL visible action buttons (top area) to locate the edit control
  const allBtns = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('button,a,[role="button"]')].filter(vis).map(b => {
      const r = b.getBoundingClientRect();
      return {
        text: (b.textContent || '').trim().slice(0, 20),
        aria: b.getAttribute('aria-label') || '',
        icon: (b.querySelector('svg')?.getAttribute('aria-label')) || '',
        href: (b.getAttribute('href') || '').slice(0, 40),
        x: Math.round(r.x), y: Math.round(r.y),
      };
    }).filter(b => b.y < 220).sort((a, c) => a.y - c.y || a.x - c.x);
  });
  console.log('TOP BUTTONS:'); allBtns.forEach(b => console.log(' ', JSON.stringify(b)));
  const editCandidates = allBtns.filter(c => /edit|modif|pencil|crayon/i.test(c.text + ' ' + c.aria + ' ' + c.icon + ' ' + c.href));
  console.log('EDIT-ish:', JSON.stringify(editCandidates));

  // Edit is behind the "More actions" (…) menu → "Edit Pin"
  const more = page.locator('button[aria-label="More actions"], button[aria-label*="More actions" i]').first();
  if (await more.count()) { await more.click().catch(() => {}); console.log('clicked More actions'); }
  await page.waitForTimeout(1500);
  const menu = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"],[role="menu"] *,div[role="button"]')]
    .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (el.textContent || '').trim(); })
    .map(el => (el.textContent || '').trim().slice(0, 30)).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 20));
  console.log('MENU items:', JSON.stringify(menu));
  // Click "Edit Pin" / "Edit"
  let clicked = false;
  for (const rx of [/^Edit Pin$/i, /^Edit$/i, /^Modifier/i]) {
    const it = page.getByText(rx).first();
    if (await it.count() && await it.isVisible().catch(() => false)) { await it.click().catch(() => {}); clicked = true; console.log(`clicked menu: ${rx}`); break; }
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(outDir, `pinedit-${pinId}-1-form.png`) });
  console.log('edit opened:', clicked);

  // Dump all inputs/textareas with their current values + nearby label/placeholder
  const fields = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('input, textarea')].filter(vis).map((el, i) => ({
      i, tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '',
      name: el.name || '', placeholder: el.placeholder || '',
      aria: el.getAttribute('aria-label') || '',
      value: (el.value || '').slice(0, 80),
    }));
  });
  console.log('FORM FIELDS:'); fields.forEach(f => console.log(' ', JSON.stringify(f)));

  // Find the destination-link field: current value contains the site URL / ?p=,
  // or placeholder/aria mentions link/destination/lien.
  const linkIdx = fields.findIndex(f =>
    /leagueofcooking|[?&]p=\d/i.test(f.value) ||
    /destination|website|lien|link|url/i.test(f.placeholder + ' ' + f.aria));
  console.log(`\nLink field index: ${linkIdx}`, linkIdx >= 0 ? JSON.stringify(fields[linkIdx]) : '(not found)');

  if (APPLY) {
    // The destination link field is a stable input#WebsiteField
    const link = page.locator('#WebsiteField');
    if (!(await link.count())) throw new Error('#WebsiteField not found — edit form did not open');
    await link.click().catch(() => {});
    await link.fill(newUrl);
    await page.waitForTimeout(600);
    const confirmVal = await link.inputValue().catch(() => '');
    console.log(`#WebsiteField now = ${confirmVal}`);
    await page.screenshot({ path: join(outDir, `pinedit-${pinId}-2-filled.png`) });

    // Find the edit modal's Save button (dump candidates, pick a real "Save")
    const saveBtns = await page.evaluate(() => [...document.querySelectorAll('button')]
      .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && /^(save|enregistrer|done|termin)/i.test((b.textContent || '').trim()); })
      .map(b => ({ text: (b.textContent || '').trim().slice(0, 20), aria: b.getAttribute('aria-label') || '' })));
    console.log('SAVE candidates:', JSON.stringify(saveBtns));
    let saved = false;
    const saveBtn = page.getByRole('button', { name: /^save$/i }).last();
    if (await saveBtn.count() && await saveBtn.isVisible().catch(() => false)) { await saveBtn.click().catch(() => {}); saved = true; }
    await page.waitForTimeout(1800);
    // Confirmation dialog: "Heads up! ... engagement metrics ... will be lost" → red Save
    const needsConfirm = await page.evaluate(() => /heads up|engagement metrics|will be lost/i.test(document.body.innerText));
    if (needsConfirm) {
      await page.screenshot({ path: join(outDir, `pinedit-${pinId}-2b-confirm.png`) });
      const confirm = page.getByRole('button', { name: /^save$/i }).last();
      await confirm.click().catch(() => {});
      console.log('confirmed "metrics will be lost" dialog');
      await page.waitForTimeout(4000);
    }
    await page.screenshot({ path: join(outDir, `pinedit-${pinId}-3-saved.png`) });
    console.log(saved ? 'Clicked Save.' : '⚠ Save button not found — see screenshot.');

    // Verify
    await page.goto(`https://www.pinterest.com/pin/${pinId}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const nowDest = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href]')].map(x => x.href).find(h => /leagueofcooking\.com/i.test(h));
      if (a) return a;
      const m = document.documentElement.innerHTML.match(/"link":"(https?:[^"]*leagueofcooking\.com[^"]*)"/i);
      return m ? m[1].replace(/\\\//g, '/') : null;
    });
    console.log(`\nVERIFY pin ${pinId} destination now: ${nowDest}`);
  } else if (!APPLY) {
    console.log('\n(discover only — re-run with --apply to save)');
  }
} finally {
  await cleanup();
  console.log('Dolphin stopped.');
}
