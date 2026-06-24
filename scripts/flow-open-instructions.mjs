/**
 * flow-open-instructions.mjs — Click "Instructions pour l'agent" and dump the
 * dialog (inputs/textarea/buttons) + screenshot, so we know how to set guardrails.
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

// Click "Instructions pour l'agent"
let clicked = false;
try { await page.getByRole('button', { name: /Instructions pour l'agent/i }).first().click({ timeout: 5000 }); clicked = true; } catch {}
if (!clicked) { try { await page.getByText("Instructions pour l'agent", { exact: false }).first().click({ timeout: 5000 }); clicked = true; } catch {} }
console.log('clicked Instructions:', clicked);
await page.waitForTimeout(2000);
await page.screenshot({ path: join(outDir, 'instr-dialog.png') });

const dlg = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const ta = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type=text]')].filter(vis)
    .map(e => ({ tag: e.tagName.toLowerCase(), ph: e.getAttribute('placeholder') || '', ce: e.getAttribute('contenteditable') || '' }));
  const btns = [...document.querySelectorAll('button')].filter(vis).map(b => (b.textContent || '').trim().slice(0, 30)).filter(Boolean);
  const heading = (document.body.innerText.match(/.{0,60}instruction.{0,80}/i) || [''])[0];
  return { textInputs: ta, buttons: btns.slice(0, 25), heading };
});
console.log('DIALOG inputs:', JSON.stringify(dlg.textInputs, null, 1));
console.log('DIALOG buttons:', JSON.stringify(dlg.buttons));
console.log('heading-ish:', dlg.heading);

await page.waitForTimeout(1000);
await context.close();
console.log('DONE -> output/_flow-test/instr-dialog.png');
