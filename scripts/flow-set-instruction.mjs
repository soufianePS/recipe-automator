/**
 * flow-set-instruction.mjs — Add a persistent Agent Instruction (guardrail).
 * Targets the real fields: title + "Créez des consignes pour votre agent" textarea.
 */
import { chromium } from 'playwright';
import { join } from 'path';
import fs from 'fs';

const TITLE = 'Recipe blog style';
const GUARDRAIL = "Photorealistic homemade food-blog photography. Within each session keep STRICT visual consistency across all images: same dish identity, same plate or bowl, same kitchen surface, same lighting and style as the previous images in this session. Natural iPhone-style home photo, soft daylight, casual imperfect arrangement. Portrait orientation. Never add text, watermark, hands, logos, brand names, or extra utensils. Evolve the food realistically step by step (raw to mixed to cooked/golden); do not jump ahead to the finished dish in early steps.";

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
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 4000 }); } catch {}
await page.waitForTimeout(6000);

// open Instructions pour l'agent
try { await page.getByRole('button', { name: /Instructions pour l'agent/i }).first().click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(1500);

// delete any existing instruction cards (clean slate) — trash icons inside panel
for (let i = 0; i < 4; i++) {
  const del = page.locator('button:has(i:text-is("delete"))');
  const n = await del.count().catch(() => 0);
  if (!n) break;
  try { await del.first().click({ timeout: 2000 }); await page.waitForTimeout(600); } catch { break; }
}

// add a fresh instruction
try { await page.getByRole('button', { name: /Ajouter une instruction/i }).first().click({ timeout: 5000 }); } catch {}
await page.waitForTimeout(1200);

// fill the guidelines textarea (placeholder mentions "consignes")
let guideOk = false;
try { await page.getByPlaceholder(/consignes/i).first().fill(GUARDRAIL); guideOk = true; } catch (e) { console.log('consignes fill err:', e.message); }
// optional: set a title
try { await page.getByPlaceholder(/Titre de l'instruction/i).first().fill(TITLE); } catch {}
console.log('guideline filled:', guideOk);
await shot(page, 'instr-set-2-typed.png');

// confirm length
const len = await page.evaluate(() => {
  const els = [...document.querySelectorAll('textarea, [contenteditable="true"], input')];
  return Math.max(0, ...els.map(e => (e.value || e.textContent || '').length));
});
console.log('max field length:', len);

// Save with OK
try { await page.getByRole('button', { name: /^OK$/i }).first().click({ timeout: 4000 }); console.log('clicked OK'); } catch (e) { console.log('OK err:', e.message); }
await page.waitForTimeout(1500);
await shot(page, 'instr-set-3-done.png');

await page.waitForTimeout(1000);
await context.close();
console.log('DONE.');
