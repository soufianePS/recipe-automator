/**
 * flow-inspect-composer.mjs — close the right Agent zone using the exact button
 * class the user pointed out, then dump div.sc-f4dcf155-0.GVBqS (the composer)
 * so we can see the Agent mode pill and how to deselect it.
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
  headless: false, viewport: { width: 1920, height: 1080 },
  args: ['--window-size=1920,1080', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
});
const page = context.pages()[0] || await context.newPage();
await page.goto('https://labs.google/fx/fr/tools/flow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

// Close the right Agent zone via the user's exact close-button classes (real mouse)
const closeBtnPos = await page.evaluate(() => {
  const sels = ['button.ewGlDn.famhRe.evQzGD', 'button.famhRe.evQzGD', 'button.ewGlDn', 'button.evQzGD'];
  for (const s of sels) {
    const el = document.querySelector(s);
    if (el) { const r = el.getBoundingClientRect(); if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), sel: s }; }
  }
  return null;
});
console.log('close button:', JSON.stringify(closeBtnPos));
if (closeBtnPos) { await page.mouse.click(closeBtnPos.x, closeBtnPos.y); await page.waitForTimeout(2000); }
await page.screenshot({ path: join(outDir, 'inspect-0-after-close.png') });

// Dump the composer div the user pointed at
const info = await page.evaluate(() => {
  const div = document.querySelector('div.sc-f4dcf155-0.GVBqS') || document.querySelector('div.GVBqS');
  if (!div) return { found: false, allGV: [...document.querySelectorAll('[class*="GVBqS"], [class*="sc-f4dcf155-0"]')].length };
  const r = div.getBoundingClientRect();
  const buttons = [...div.querySelectorAll('button')].map(b => {
    const br = b.getBoundingClientRect();
    return {
      text: (b.textContent || '').trim().slice(0, 30),
      icon: (b.querySelector('i')?.textContent || '').trim(),
      aria: b.getAttribute('aria-label') || '',
      pressed: b.getAttribute('aria-pressed') || '',
      haspopup: b.getAttribute('aria-haspopup') || '',
      cls: b.className,
      x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2), w: Math.round(br.width),
    };
  });
  return { found: true, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: (div.innerText || '').trim().slice(0, 200), buttons };
});
console.log('\ncomposer div.GVBqS:', JSON.stringify(info, null, 1));

// If we found the Agent pill, click it and capture the resulting mode menu/state
const pill = (info.buttons || []).find(b => b.text === 'Agent' || /agent/i.test(b.text));
if (pill) {
  console.log(`\n>>> Clicking Agent pill @ ${pill.x},${pill.y} (pressed=${pill.pressed}, haspopup=${pill.haspopup})`);
  await page.mouse.click(pill.x, pill.y);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, 'inspect-1-pill-clicked.png') });
  const after = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const menu = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"],li')]
      .filter(vis).map(e => ({ text: (e.textContent || '').trim().slice(0, 40), state: e.getAttribute('data-state') || e.getAttribute('aria-checked') || '' })).filter(e => e.text);
    const div = document.querySelector('div.sc-f4dcf155-0.GVBqS') || document.querySelector('div.GVBqS');
    const pillNow = div ? [...div.querySelectorAll('button')].find(b => /agent/i.test((b.textContent || '').trim())) : null;
    return { menu, pillText: pillNow ? pillNow.textContent.trim().slice(0, 30) : null, pillPressed: pillNow ? pillNow.getAttribute('aria-pressed') : null };
  });
  console.log('\nAFTER pill click:', JSON.stringify(after, null, 1));
}

await page.waitForTimeout(2500);
await context.close();
console.log('\nDONE -> output/_flow-test/inspect-*.png');
