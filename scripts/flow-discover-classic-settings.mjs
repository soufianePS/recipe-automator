/**
 * flow-discover-classic-settings.mjs — verify the CLASSIC inline generation
 * settings popup that appears once Agent mode is OFF, so we can confirm/fix
 * flow.js _setGenerationSettings (aspect / count / model selectors).
 *
 * Steps: open project -> close right Agent zone if open -> deselect the "Agent"
 * pill -> click the inline "Nano Banana Pro · aspect · 1x" button -> dump the
 * popup (role=tab aspect+count with ids/state, model menu trigger, options).
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
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
});
const page = context.pages()[0] || await context.newPage();
await page.goto('https://labs.google/fx/fr/tools/flow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

// Open a project
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 6000 }); } catch (e) { console.log('Nouveau projet:', e.message); }
await page.waitForTimeout(6000);

// Close the right Agent assistant zone if it covers the composer (X "close" icon top-right)
const closeRightZone = async () => {
  const pos = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(b => {
      const ic = (b.querySelector('i')?.textContent || '').trim();
      const r = b.getBoundingClientRect();
      return ic === 'close' && r.width > 0 && r.x > 1400 && r.y < 200;
    });
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (pos) { await page.mouse.click(pos.x, pos.y); await page.waitForTimeout(1500); return true; }
  return false;
};
console.log('closed right zone:', await closeRightZone());
await page.waitForTimeout(1000);

// Deselect Agent pill
const agent = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Agent');
  if (!b) return null; const r = b.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), pressed: b.getAttribute('aria-pressed') };
});
console.log('Agent pill:', JSON.stringify(agent));
if (agent && agent.pressed === 'true') { await page.mouse.click(agent.x, agent.y); await page.waitForTimeout(1500); }
await page.screenshot({ path: join(outDir, 'classic-0-agentoff.png') });

// Find + click the inline model/settings pill (Nano Banana / Imagen)
const pillPos = await page.evaluate(() => {
  for (const b of document.querySelectorAll('button')) {
    const t = (b.textContent || '').toLowerCase();
    if (t.includes('nano banana') || t.includes('imagen')) {
      const r = b.getBoundingClientRect();
      if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: b.textContent.trim().slice(0, 40) };
    }
  }
  return null;
});
console.log('inline settings pill:', JSON.stringify(pillPos));
if (pillPos) { await page.mouse.click(pillPos.x, pillPos.y); await page.waitForTimeout(1800); }
await page.screenshot({ path: join(outDir, 'classic-1-popup.png') });

// Dump the popup structure
const dump = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const tabs = [...document.querySelectorAll('button[role="tab"]')].filter(vis).map(t => ({
    id: t.id || '', text: (t.textContent || '').trim().slice(0, 16), state: t.getAttribute('data-state') || '',
  }));
  const menus = [...document.querySelectorAll('button[aria-haspopup="menu"]')].filter(vis).map(m => ({
    text: (m.textContent || '').trim().slice(0, 40), id: m.id || '',
  }));
  const radios = [...document.querySelectorAll('[role="menuitemradio"],[role="option"],[role="radio"]')].filter(vis).map(r => ({
    text: (r.textContent || '').trim().slice(0, 40), state: r.getAttribute('data-state') || r.getAttribute('aria-checked') || '',
  }));
  return { tabs, menus, radios };
});
console.log('\n=== role=tab (aspect + count) ===\n', JSON.stringify(dump.tabs, null, 1));
console.log('\n=== model menu triggers (aria-haspopup=menu) ===\n', JSON.stringify(dump.menus, null, 1));
console.log('\n=== radios/options ===\n', JSON.stringify(dump.radios, null, 1));

await page.waitForTimeout(2000);
await context.close();
console.log('\nDONE -> output/_flow-test/classic-*.png');
