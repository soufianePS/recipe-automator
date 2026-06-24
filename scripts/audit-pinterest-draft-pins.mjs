/**
 * audit-pinterest-draft-pins.mjs — open the LeagueOfCooking Pinterest profile in
 * the Dolphin profile and report which posted pins link to a DRAFT URL
 * (leagueofcooking.com/?p=<ID>) vs a clean public permalink.
 *
 * Requires the Dolphin Anty desktop app running + logged in (local API :3001).
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const ROOT = process.cwd();
const PROFILE_ID = 793614953;
const PIN_USER = 'LeagueOfCookingwithAmelia';
const MAX_PINS = Number(process.env.MAX_PINS || 40);

const cfg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'planifier', 'config.json'), 'utf8'));
if (!cfg?.dolphinAnty?.apiToken) { console.error('No dolphinAnty token in config'); process.exit(1); }

const dolphin = new DolphinAnty({ dolphinAnty: cfg.dolphinAnty });
console.log(`Starting Dolphin profile ${PROFILE_ID}…`);
const { port } = await dolphin.startAndGetCDP(PROFILE_ID);
console.log(`CDP port ${port}`);
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const context = browser.contexts()[0] || (await browser.newContext());
const page = context.pages()[0] || (await context.newPage());

const cleanup = async () => {
  try { await browser.close(); } catch {}
  try { await dolphin.stopProfile(PROFILE_ID); console.log('Dolphin profile stopped'); } catch {}
};

try {
  // Open the user's CREATED pins
  const createdUrl = `https://www.pinterest.com/${PIN_USER}/_created/`;
  console.log(`Opening ${createdUrl}`);
  await page.goto(createdUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  // Scroll to load pins, collecting /pin/<id>/ links. Keep scrolling until no
  // new pins appear for several consecutive rounds (full profile).
  const pinLinks = new Set();
  let dry = 0;
  for (let i = 0; i < 200 && pinLinks.size < MAX_PINS && dry < 5; i++) {
    const before = pinLinks.size;
    const found = await page.evaluate(() => [...document.querySelectorAll('a[href*="/pin/"]')]
      .map(a => a.href).filter(h => /\/pin\/\d+(\/|$)/.test(h)));
    found.forEach(h => pinLinks.add(h.split('?')[0].replace(/\/analytics\/?$/, '/')));
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1100);
    dry = (pinLinks.size === before) ? dry + 1 : 0;
  }
  const pins = [...pinLinks].filter(u => /\/pin\/\d+\/?$/.test(u)).slice(0, MAX_PINS);
  console.log(`Collected ${pins.length} created pin(s). Inspecting destination links…\n`);

  const results = [];
  for (let i = 0; i < pins.length; i++) {
    const pinUrl = pins[i];
    let dest = null;
    try {
      await page.goto(pinUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);
      dest = await page.evaluate(() => {
        const a = [...document.querySelectorAll('a[href]')].map(x => x.href).find(h => /leagueofcooking\.com/i.test(h));
        if (a) return a;
        const m = document.documentElement.innerHTML.match(/"link":"(https?:[^"]*leagueofcooking\.com[^"]*)"/i);
        if (m) return m[1].replace(/\\\//g, '/').replace(/\\u002F/gi, '/');
        return null;
      });
    } catch (e) { dest = `(error: ${e.message})`; }
    const isDraft = dest && /[?&]p=\d+/.test(dest);
    results.push({ pinUrl, dest, isDraft });
    console.log(`${i + 1}/${pins.length} ${isDraft ? '❌ DRAFT' : (dest ? '✅ ok   ' : '⚠ none ')} ${dest || '(no leagueofcooking link found)'}  ← ${pinUrl}`);
  }

  const drafts = results.filter(r => r.isDraft);
  console.log(`\n══════════════════════════════════════════`);
  console.log(`SUMMARY: ${results.length} pins inspected · ${drafts.length} with DRAFT (?p=) links`);
  if (drafts.length) {
    console.log(`\nDRAFT-LINKED PINS:`);
    for (const d of drafts) console.log(`  ${d.dest}  (${d.pinUrl})`);
  }
  fs.writeFileSync(join(ROOT, 'output', '_flow-test', 'pinterest-pin-audit.json'), JSON.stringify(results, null, 2));
  console.log(`\nFull report → output/_flow-test/pinterest-pin-audit.json`);
} finally {
  await cleanup();
}
