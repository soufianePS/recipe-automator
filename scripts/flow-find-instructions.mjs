/**
 * flow-find-instructions.mjs — locate the Agent Instructions control in a Flow
 * project chat, open it, and dump the dialog so we can set guardrails.
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

// Dump anything mentioning instruction/instructions, + bottom chat controls (y>780)
const info = await page.evaluate(() => {
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const grab = el => { const r = el.getBoundingClientRect(); return { tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 50), aria: el.getAttribute('aria-label') || '', icon: (el.querySelector('i')?.textContent || '').trim(), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; };
  const all = [...document.querySelectorAll('button, [role="button"], a, span, div')].filter(vis);
  const instr = all.filter(e => /instruction|garde|guardrail|guideline|consigne/i.test((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || ''))).map(grab);
  const bottomBtns = [...document.querySelectorAll('button, [role="button"]')].filter(vis).map(grab).filter(c => c.y > 760 && c.x > 1500);
  return { instr: instr.slice(0, 15), bottomBtns };
});
console.log('INSTRUCTION-ish elements:', JSON.stringify(info.instr, null, 1));
console.log('\nBOTTOM-RIGHT chat controls:', JSON.stringify(info.bottomBtns, null, 1));
await page.screenshot({ path: join(outDir, 'instr-1-project.png') });

// Try clicking the "+" on the chat input (often opens add menu w/ instructions)
const plus = info.bottomBtns.find(b => b.icon === 'add' || b.text === '+' || /add/i.test(b.aria));
if (plus) { console.log('clicking + at', plus.x, plus.y); await page.mouse.click(plus.x, plus.y); await page.waitForTimeout(1500); await page.screenshot({ path: join(outDir, 'instr-2-plusmenu.png') }); }

await page.waitForTimeout(1000);
await context.close();
console.log('DONE.');
