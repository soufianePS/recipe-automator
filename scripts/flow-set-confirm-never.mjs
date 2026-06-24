/**
 * flow-set-confirm-never.mjs — Set the Flow Agent "Confirm before generating"
 * to "Jamais" (Never) so automation generates without a confirmation pause.
 * Verbose + screenshots so we can see each step.
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
const shot = (p, n) => p.screenshot({ path: join(outDir, n) }).catch(() => {});

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false, viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
});
const page = context.pages()[0] || await context.newPage();
await page.goto('https://labs.google/fx/fr/tools/flow', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

// 1) Open a project (click first existing project card, else "Nouveau projet")
let opened = false;
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 4000 }); opened = true; console.log('opened: Nouveau projet'); } catch {}
if (!opened) {
  // click first project thumbnail area
  try { await page.mouse.click(150, 230); opened = true; console.log('opened: first card click'); } catch {}
}
await page.waitForTimeout(6000);
await shot(page, 'set-1-project.png');

// close any stray panel
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(500);

// 2) The AGENT settings open from the "tune" (sliders) icon on the agent chat
//    input (bottom-right), NOT the top display gear.
const cands = await page.evaluate(() => {
  return [...document.querySelectorAll('button, [role="button"]')].map(b => {
    const r = b.getBoundingClientRect(); const icon = (b.querySelector('i')?.textContent || '').trim();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), icon };
  }).filter(c => c.w > 0 && /tune/.test(c.icon));
});
console.log('tune candidates:', JSON.stringify(cands));
// prefer the bottom-right one (agent chat input)
const tune = cands.sort((a, b) => (b.y - a.y) || (b.x - a.x))[0];
if (tune) { console.log('clicking tune at', tune.x, tune.y); await page.mouse.click(tune.x, tune.y); await page.waitForTimeout(2500); }
await shot(page, 'set-2-settings.png');

// confirm the agent settings panel is showing
const hasConfirm = await page.evaluate(() => /Confirmer avant de générer/i.test(document.body.innerText));
console.log('agent-settings panel visible:', hasConfirm);

// 3) Click "Jamais" radio/label
let jamais = false;
try { await page.getByText('Jamais', { exact: true }).first().click({ timeout: 4000 }); jamais = true; } catch {}
if (!jamais) { try { await page.getByText('Jamais', { exact: false }).first().click({ timeout: 4000 }); jamais = true; } catch {} }
console.log('clicked Jamais:', jamais);
await page.waitForTimeout(800);
await shot(page, 'set-3-jamais.png');

// 4) Save
let saved = false;
for (const label of ['Enregistrer', 'Save', 'Done', 'OK']) {
  try { await page.getByRole('button', { name: label, exact: false }).first().click({ timeout: 3000 }); saved = true; console.log('saved via', label); break; } catch {}
}
console.log('saved:', saved);
await page.waitForTimeout(1500);
await shot(page, 'set-4-after.png');

await page.waitForTimeout(1000);
await context.close();
console.log('DONE. Check output/_flow-test/set-*.png');
