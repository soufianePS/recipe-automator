/**
 * flow-watch-agent-toggle.mjs (PASSIVE) — opens Flow and does NOTHING else.
 * YOU drive the browser: open a project, close the right Agent zone, then click
 * the "Agent" pill in the bottom composer to DESELECT agent mode (and pick the
 * non-agent / image option if a menu appears).
 *
 * Every 1.2s it snapshots ALL visible buttons and prints a DIFF (new / removed /
 * state-changed) plus the live state of any exact-text "Agent" button. This
 * captures the precise element + stable selector + aria-pressed before/after so
 * we can deselect Agent in flow.js and avoid agent credit usage.
 *
 * Browser stays open ~180s. Watch the terminal for ">>>".
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

console.log('\n==================================================================');
console.log(' PASSIVE WATCH. In the browser, do it yourself:');
console.log('   1) Open a project (click a project tile or "+ Nouveau projet").');
console.log('   2) Close the right "Agent" chat zone (its X) if it is open.');
console.log('   3) Click the white "Agent" pill in the bottom composer -> OFF.');
console.log('   4) If a menu opens, choose the non-agent / image option.');
console.log(' I print every button change for ~180s. Take your time.');
console.log('==================================================================\n');

const snap = () => page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const out = {};
  let agentPill = null;
  for (const b of document.querySelectorAll('button,[role="button"],[role="switch"],[role="tab"],[role="menuitemradio"],[role="radio"]')) {
    if (!vis(b)) continue;
    const r = b.getBoundingClientRect();
    const text = (b.textContent || '').trim().slice(0, 36);
    const icon = (b.querySelector && b.querySelector('i') ? b.querySelector('i').textContent.trim() : '');
    const key = `${text}|${icon}|${Math.round(r.x)},${Math.round(r.y)}`;
    const rec = {
      text, icon,
      pressed: b.getAttribute('aria-pressed') || '',
      checked: b.getAttribute('aria-checked') || '',
      state: b.getAttribute('data-state') || '',
      role: b.getAttribute('role') || '',
      cls: (b.className || '').toString().slice(0, 70),
      x: Math.round(r.x), y: Math.round(r.y),
    };
    out[key] = rec;
    if (text === 'Agent') agentPill = rec;
  }
  return { out, agentPill };
});

let prev = {};
const TICKS = 150; // ~180s
for (let i = 0; i < TICKS; i++) {
  let s;
  try { s = await snap(); } catch { await page.waitForTimeout(1200); continue; }
  const cur = s.out;
  const lines = [];
  for (const k of Object.keys(cur)) {
    if (!prev[k]) lines.push(`  + NEW   ${JSON.stringify(cur[k])}`);
    else if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) lines.push(`  ~ CHG   ${JSON.stringify(cur[k])}`);
  }
  for (const k of Object.keys(prev)) if (!cur[k]) lines.push(`  - GONE  ${JSON.stringify(prev[k])}`);

  if (i === 0) {
    console.log('INITIAL Agent pill:', JSON.stringify(s.agentPill));
  } else if (lines.length) {
    console.log(`\n>>> t=${(i * 1.2).toFixed(0)}s  Agent pill=${JSON.stringify(s.agentPill)}`);
    console.log(lines.join('\n'));
    try { await page.screenshot({ path: join(outDir, `watch2-${i}.png`) }); } catch {}
  }
  prev = cur;
  await page.waitForTimeout(1200);
}

console.log('\nWatch ended.');
try { await page.screenshot({ path: join(outDir, 'watch2-final.png') }); } catch {}
await context.close();
console.log('DONE -> output/_flow-test/watch2-*.png');
