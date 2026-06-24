/**
 * flow-discover-ui.mjs — Open Flow and dump the UI so we can locate the
 * Agent settings ("Confirm before generating") and Agent Instructions.
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

// Click into a project if on dashboard (try a "new project" style button)
await page.screenshot({ path: join(outDir, 'discover-1-landing.png') });

const dump = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const grab = el => ({
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').trim().slice(0, 40),
    aria: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
    icon: (el.querySelector('i') ? el.querySelector('i').textContent.trim() : ''),
    x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y),
  });
  const out = { buttons: [], settingsish: [], agentish: [] };
  for (const b of document.querySelectorAll('button, [role="button"]')) {
    if (!vis(b)) continue;
    const g = grab(b);
    out.buttons.push(g);
    const blob = (g.text + ' ' + g.aria + ' ' + g.title + ' ' + g.icon).toLowerCase();
    if (/setting|paramètre|gear|tune|cog/.test(blob)) out.settingsish.push(g);
    if (/agent|instruction/.test(blob)) out.agentish.push(g);
  }
  return out;
});
console.log('TOP-RIGHT buttons (x>1000):');
for (const b of dump.buttons.filter(b => b.x > 1000).sort((a, c) => a.y - c.y).slice(0, 25)) console.log(' ', JSON.stringify(b));
console.log('\nSETTINGS-ish:', JSON.stringify(dump.settingsish, null, 1));
console.log('\nAGENT-ish:', JSON.stringify(dump.agentish, null, 1));

await page.waitForTimeout(1500);
await context.close();
console.log('DONE. screenshot -> output/_flow-test/discover-1-landing.png');
