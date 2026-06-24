/**
 * flow-discover-agent-toggle.mjs — open a Flow project and dump every control
 * around the bottom chat input so we can find how to SWITCH OFF "Agent" mode
 * (agent mode burns credits). We want the classic/direct image generation mode.
 *
 * Dumps: all buttons w/ icon+text+aria near the input, any mode dropdown,
 * role=tab / role=switch / role=radio / aria-haspopup elements, and the full
 * innerText of the bottom toolbar. Screenshots before + after clicking any
 * "Agent"-looking control.
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

// Enter a project so the chat input is present
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(6000);
await page.screenshot({ path: join(outDir, 'agent-1-project.png'), fullPage: false });

const dump = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const H = window.innerHeight;
  const grab = el => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      text: (el.textContent || '').trim().slice(0, 50),
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      icon: (el.querySelector('i') ? el.querySelector('i').textContent.trim() : ''),
      haspopup: el.getAttribute('aria-haspopup') || '',
      pressed: el.getAttribute('aria-pressed') || '',
      checked: el.getAttribute('aria-checked') || '',
      state: el.getAttribute('data-state') || '',
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    };
  };
  const out = { bottomButtons: [], agentish: [], switches: [], menus: [], tabs: [], bottomText: '' };
  for (const b of document.querySelectorAll('button, [role="button"], [role="switch"], [role="radio"], [role="tab"]')) {
    if (!vis(b)) continue;
    const g = grab(b);
    // Bottom half of screen = the chat input toolbar
    if (g.y > H * 0.5) out.bottomButtons.push(g);
    const blob = (g.text + ' ' + g.aria + ' ' + g.title + ' ' + g.icon).toLowerCase();
    if (/agent|mode|classique|classic|image|vid[eé]o|outil|tool/.test(blob)) out.agentish.push(g);
    if (g.role === 'switch') out.switches.push(g);
    if (g.haspopup === 'menu') out.menus.push(g);
    if (g.role === 'tab') out.tabs.push(g);
  }
  // Grab innerText of the bottom-most toolbar container
  const inputs = [...document.querySelectorAll('div[contenteditable="true"]')].filter(vis);
  if (inputs.length) {
    let box = inputs[0];
    for (let i = 0; i < 5 && box.parentElement; i++) box = box.parentElement;
    out.bottomText = (box.innerText || '').trim().slice(0, 600);
  }
  return out;
});

console.log('=== BOTTOM TOOLBAR BUTTONS (y > 50% screen) ===');
for (const b of dump.bottomButtons.sort((a, c) => a.x - c.x)) console.log(' ', JSON.stringify(b));
console.log('\n=== AGENT / MODE-ish controls ===');
for (const b of dump.agentish) console.log(' ', JSON.stringify(b));
console.log('\n=== role=switch ===', JSON.stringify(dump.switches, null, 1));
console.log('\n=== aria-haspopup=menu ===', JSON.stringify(dump.menus, null, 1));
console.log('\n=== role=tab ===', JSON.stringify(dump.tabs, null, 1));
console.log('\n=== bottom toolbar innerText ===\n', dump.bottomText);

// Try opening any menu trigger that mentions Agent/mode to see options
for (const m of dump.menus) {
  const blob = (m.text + ' ' + m.aria + ' ' + m.icon).toLowerCase();
  if (/agent|mode|outil|tool|nano|imagen|banana/.test(blob)) {
    console.log(`\n>>> Clicking menu trigger: "${m.text}" (icon=${m.icon}) @ ${m.x},${m.y}`);
    try {
      await page.mouse.click(m.x + m.w / 2, m.y + m.h / 2);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(outDir, `agent-menu-${m.x}.png`) });
      const opts = await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"]')]
        .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0; })
        .map(e => ({ text: (e.textContent || '').trim().slice(0, 50), state: e.getAttribute('data-state') || e.getAttribute('aria-checked') || '' })));
      console.log('   menu options:', JSON.stringify(opts, null, 1));
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    } catch (e) { console.log('   click failed:', e.message); }
  }
}

await page.waitForTimeout(1500);
await context.close();
console.log('\nDONE. Screenshots -> output/_flow-test/agent-*.png');
