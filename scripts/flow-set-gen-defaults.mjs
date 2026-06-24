/**
 * flow-set-gen-defaults.mjs — Per-PROJECT agent defaults: Confirm=Never,
 * image aspect 9:16, count 1x, model Nano Banana Pro.
 * Image section renders BEFORE the video section, so .first() targets images.
 * Also dumps real selectors (outerHTML) so the driver can reproduce them.
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
try { await page.getByText('Nouveau projet', { exact: false }).first().click({ timeout: 4000 }); } catch {}
await page.waitForTimeout(6000);

// open agent settings (tune icon on chat input)
const tune = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(b => (b.querySelector('i')?.textContent || '').trim() === 'tune');
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
});
if (tune) { await page.mouse.click(tune.x, tune.y); await page.waitForTimeout(2500); }
const panelOpen = await page.evaluate(() => /Génération d.images par défaut/i.test(document.body.innerText));
console.log('panel open:', panelOpen);
await shot(page, 'gen-1-panel.png');

// dump real selectors for the driver
const sel = await page.evaluate(() => {
  const find = (label) => [...document.querySelectorAll('button,[role="button"]')].filter(b => (b.textContent || '').trim() === label);
  const sample = (label) => { const e = find(label)[0]; return e ? e.outerHTML.slice(0, 180) : null; };
  const combo = [...document.querySelectorAll('button,[role="combobox"],[role="button"]')].find(b => /Nano Banana/i.test(b.textContent || ''));
  return {
    n_9_16: find('9:16').length, n_1x: find('1x').length,
    sample_9_16: sample('9:16'), sample_1x: sample('1x'),
    combo_html: combo ? combo.outerHTML.slice(0, 220) : null,
  };
});
console.log('SELECTORS:', JSON.stringify(sel, null, 1));

// Apply: Jamais, then image 9:16 (first), image 1x (first), model Pro
try { await page.getByText('Jamais', { exact: true }).first().click({ timeout: 4000 }); console.log('Jamais ok'); } catch (e) { console.log('Jamais err', e.message); }
try { await page.getByText('9:16', { exact: false }).first().click({ timeout: 4000 }); console.log('9:16 ok'); } catch (e) { console.log('9:16 err', e.message); }
try { await page.getByText('1x', { exact: true }).first().click({ timeout: 4000 }); console.log('1x ok'); } catch (e) { console.log('1x err', e.message); }

// model dropdown -> Nano Banana Pro
try {
  await page.getByText(/Nano Banana 2|Nano Banana Pro/i).first().click({ timeout: 4000 });
  await page.waitForTimeout(1000); await shot(page, 'gen-2-modelopen.png');
  await page.getByText(/Nano Banana Pro/i).last().click({ timeout: 3000 });
  console.log('model Pro ok');
} catch (e) { console.log('model err', e.message); }
await page.waitForTimeout(500);
await shot(page, 'gen-3-selected.png');

try { await page.getByRole('button', { name: /Enregistrer/i }).first().click({ timeout: 4000 }); console.log('saved'); } catch (e) { console.log('save err', e.message); }
await page.waitForTimeout(1500);
await shot(page, 'gen-4-after.png');
await context.close();
console.log('DONE.');
