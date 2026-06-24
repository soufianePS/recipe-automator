/**
 * flow-discover-gensettings.mjs — open the CLASSIC generation-settings popup
 * (the one flow.js _setGenerationSettings uses) and dump the aspect tabs,
 * count tabs, and model selector so we can fix the selectors for the new UI.
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';

const ROOT = process.cwd();
const LA = process.env.LOCALAPPDATA;
const fa = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'flow-accounts.json'), 'utf8'));
const acct = fa.accounts.find(a => a.id === fa.activeAccountId) || fa.accounts.find(a => a.enabled);
const profileDir = join(LA, acct.profileDir);
for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.unlinkSync(join(profileDir, lf)); } catch {} }
const outDir = join(ROOT, 'output', '_flow-test'); fs.mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false, viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
});
const page = context.pages()[0] || await context.newPage();
await page.goto('https://labs.google/fx/fr/tools/flow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 4000 }); } catch {}
await page.waitForTimeout(6000);

// click the model/settings button (same heuristic as _setGenerationSettings)
const pos = await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').toLowerCase();
    if (t.includes('nano banana') || t.includes('imagen')) { const r = b.getBoundingClientRect(); if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim().slice(0, 30) }; }
  }
  return null;
});
console.log('settings/model button:', JSON.stringify(pos));
if (pos) { await page.mouse.click(pos.x, pos.y); await page.waitForTimeout(2000); }
await page.screenshot({ path: join(outDir, 'gensettings-popup.png') });

// dump all role=tab (aspect + count) and the model menu trigger
const dump = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('button[role="tab"]')].map(t => ({
    id: t.id || '', text: (t.textContent || '').trim().slice(0, 12), state: t.getAttribute('data-state') || '',
  }));
  const menus = [...document.querySelectorAll('button[aria-haspopup="menu"]')].map(m => ({
    text: (m.textContent || '').trim().slice(0, 30), id: m.id || '',
  }));
  return { tabs, menus };
});
console.log('TABS (aspect + count):', JSON.stringify(dump.tabs, null, 1));
console.log('MODEL menus:', JSON.stringify(dump.menus, null, 1));

await page.waitForTimeout(1000);
await context.close();
console.log('DONE -> output/_flow-test/gensettings-popup.png');
