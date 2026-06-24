/**
 * flow-probe-agent-click.mjs — open a Flow project, find the "Agent" mode pill
 * in the bottom composer, click it to DESELECT agent mode (avoid agent credit
 * usage), and report the resulting mode/buttons.
 *
 * Fixed viewport for stable coords. If the global Agent assistant zone is open
 * over the home, close it ONCE, then open a fresh project.
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

// Close the global Agent assistant zone ONLY if we're on home (so we can reach "Nouveau projet")
const closeAgentZoneIfOnHome = async () => {
  const pos = await page.evaluate(() => {
    const x = [...document.querySelectorAll('button')].find(b => {
      const ic = (b.querySelector('i')?.textContent || '').trim();
      const r = b.getBoundingClientRect();
      return ic === 'close' && r.width > 0 && r.x > 1500 && r.y < 200;
    });
    if (!x) return null; const r = x.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (pos) { await page.mouse.click(pos.x, pos.y); await page.waitForTimeout(1500); }
};
await closeAgentZoneIfOnHome();

// Open a fresh project
try {
  await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 6000 });
} catch (e) { console.log('Nouveau projet click:', e.message); }
await page.waitForTimeout(7000);
await page.screenshot({ path: join(outDir, 'agentclick-0-before.png') });

const findAgentPill = async () => page.evaluate(() => {
  const cands = [...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === 'Agent');
  for (const b of cands) {
    const r = b.getBoundingClientRect();
    if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), pressed: b.getAttribute('aria-pressed'), haspopup: b.getAttribute('aria-haspopup'), y0: Math.round(r.y) };
  }
  return null;
});

let a = await findAgentPill();
console.log('Agent pill BEFORE click:', JSON.stringify(a));

if (a) {
  await page.mouse.click(a.x, a.y);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, 'agentclick-1-after.png') });

  const popup = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],[role="radio"],[role="tab"],li')]
      .filter(vis)
      .map(e => ({ tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', text: (e.textContent || '').trim().slice(0, 50), state: e.getAttribute('data-state') || e.getAttribute('aria-checked') || e.getAttribute('aria-selected') || '' }))
      .filter(e => e.text);
  });
  console.log('\nMenu/list items after clicking Agent pill:', JSON.stringify(popup, null, 1));

  a = await findAgentPill();
  console.log('\nAgent pill AFTER click:', JSON.stringify(a));

  const bottom = await page.evaluate(() => {
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const H = window.innerHeight;
    return [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return vis(b) && r.y > H * 0.55; })
      .map(b => ({ text: (b.textContent || '').trim().slice(0, 30), icon: (b.querySelector('i')?.textContent || '').trim(), pressed: b.getAttribute('aria-pressed') || '', x: Math.round(b.getBoundingClientRect().x) }))
      .sort((a, c) => a.x - c.x);
  });
  console.log('\nBottom composer buttons AFTER click:', JSON.stringify(bottom, null, 1));
} else {
  console.log('Agent pill not found — see agentclick-0-before.png');
}

await page.waitForTimeout(2500);
await context.close();
console.log('\nDONE -> output/_flow-test/agentclick-*.png');
