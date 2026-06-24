/**
 * pinterest-find-search.mjs — connect to the Dolphin profile, open Pinterest,
 * and dump search-input candidates so we can fix _performSearch's selector.
 */
import { chromium } from 'playwright';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync('data/planifier/config.json', 'utf8'));
const profileId = 793614953;
const dolphin = new DolphinAnty({ dolphinAnty: cfg.dolphinAnty });
console.log('Starting Dolphin profile', profileId, '...');
const { port } = await dolphin.startAndGetCDP(profileId);
const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
const context = browser.contexts()[0] || await browser.newContext();
const page = context.pages()[0] || await context.newPage();
await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
fs.mkdirSync('output/_flow-test', { recursive: true });

// Click the collapsed search trigger to reveal the input, then dump.
try {
  const trig = await page.$('[data-test-id="search-box-container"], button[aria-label="Search icon"]');
  if (trig) { await trig.click(); console.log('clicked search trigger'); await page.waitForTimeout(1800); }
} catch (e) { console.log('trigger click err', e.message); }
await page.screenshot({ path: 'output/_flow-test/pinterest-search.png' });

const dump = await page.evaluate(() => {
  const desc = el => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', name: el.getAttribute('name') || '', ph: el.getAttribute('placeholder') || '', aria: el.getAttribute('aria-label') || '', testid: el.getAttribute('data-test-id') || '', role: el.getAttribute('role') || '', ce: el.getAttribute('contenteditable') || '', vis: r.width > 0 && r.height > 0, x: Math.round(r.x), y: Math.round(r.y) }; };
  const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"], [role="combobox"], [role="searchbox"]')].map(desc).filter(i => i.vis);
  const searchish = [...document.querySelectorAll('[data-test-id*="search" i],[aria-label*="search" i],[aria-label*="recherch" i],[placeholder*="search" i],[placeholder*="recherch" i]')].map(desc).slice(0, 20);
  return { inputs, searchish };
});
console.log('VISIBLE INPUTS:', JSON.stringify(dump.inputs, null, 1));
console.log('SEARCH-ish ELEMENTS:', JSON.stringify(dump.searchish, null, 1));

try { await browser.close(); } catch {}
try { await dolphin.stopProfile(profileId); } catch {}
console.log('DONE -> output/_flow-test/pinterest-search.png');
