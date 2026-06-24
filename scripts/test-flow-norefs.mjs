/**
 * test-flow-norefs.mjs — Test the NEW Flow with background + prompt ONLY
 * (no previous-image references). Generates a few sequential images and
 * screenshots the Flow UI so we can see the new "chat" interface.
 *
 * Usage: node scripts/test-flow-norefs.mjs
 */
import { chromium } from 'playwright';
import { FlowPage } from '../src/shared/pages/flow.js';
import { join } from 'path';
import fs from 'fs';

const ROOT = process.cwd();
const LA = process.env.LOCALAPPDATA;

// Resolve active Flow account profile
const fa = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'flow-accounts.json'), 'utf8'));
const acct = fa.accounts.find(a => a.id === fa.activeAccountId) || fa.accounts.find(a => a.enabled);
const profileDir = join(LA, acct.profileDir);
console.log('Flow account:', acct.name, '| profile:', profileDir);

// Clear any stale singleton lock (browser died last run)
for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
  try { fs.unlinkSync(join(profileDir, lf)); } catch {}
}

// Extract one active-kitchen background to a temp jpg
const bg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'sites', 'leagueofcooking', 'backgrounds.json'), 'utf8'));
const kit = (bg.kitchens || []).find(k => k.id === bg.activeKitchenId) || (bg.kitchens || [])[0];
const b0 = (kit && kit.backgrounds && kit.backgrounds[0]) || (bg.hero || [])[0];
if (!b0) { console.error('No background available'); process.exit(1); }
fs.mkdirSync(join(ROOT, 'data', 'tmp'), { recursive: true });
const bgPath = join(ROOT, 'data', 'tmp', '_flowtest-bg.jpg');
fs.writeFileSync(bgPath, Buffer.from(String(b0.base64).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
console.log('Background written:', (fs.statSync(bgPath).size / 1024).toFixed(0) + 'KB');

const outDir = join(ROOT, 'output', '_flow-test');
fs.mkdirSync(outDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'],
  timeout: 60000,
});

const flow = new FlowPage(null, context);

// One realistic recipe-style prompt, background + prompt ONLY (no context refs)
const prompt = 'Photorealistic homemade iPhone-style kitchen photo: a white ceramic bowl filled with raw chocolate chip cookie dough, chocolate chips visible, soft natural daylight, casual imperfect arrangement, no text, no watermark, no hands.';
const out = join(outDir, 'test-norefs-1.jpg');

console.log('\n=== Generating image (background + prompt ONLY, NO refs) ===');
let ok = false;
try {
  ok = await flow.generate(prompt, bgPath, [], 'PORTRAIT', out, {});
} catch (e) {
  console.error('generate threw:', e.message);
}
console.log('generate ->', ok, '| file:', fs.existsSync(out) ? (fs.statSync(out).size / 1024).toFixed(0) + 'KB' : 'MISSING');

// Screenshot the Flow UI so we can see the new chat interface
try {
  if (flow.page) { await flow.page.screenshot({ path: join(outDir, 'flow-ui.png') }); console.log('UI screenshot saved -> output/_flow-test/flow-ui.png'); }
} catch (e) { console.log('screenshot failed:', e.message); }

await new Promise(r => setTimeout(r, 1500));
try { await context.close(); } catch {}
console.log('\nDONE. Check output/_flow-test/');
