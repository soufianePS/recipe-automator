/**
 * test-flow-continuity.mjs — Test Flow's NEW chat continuity.
 *
 * Generates image 1 (background + prompt), then sends FOLLOW-UP prompts in the
 * SAME chat — no new project, no background re-upload, NO image references —
 * to see whether Flow keeps the same bowl/kitchen/composition from chat memory.
 *
 * Usage: node scripts/test-flow-continuity.mjs
 */
import { chromium } from 'playwright';
import { FlowPage } from '../src/shared/pages/flow.js';
import { join } from 'path';
import fs from 'fs';

const ROOT = process.cwd();
const LA = process.env.LOCALAPPDATA;

const fa = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'flow-accounts.json'), 'utf8'));
const acct = fa.accounts.find(a => a.id === fa.activeAccountId) || fa.accounts.find(a => a.enabled);
const profileDir = join(LA, acct.profileDir);
console.log('Flow account:', acct.name);
for (const lf of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) { try { fs.unlinkSync(join(profileDir, lf)); } catch {} }

const bg = JSON.parse(fs.readFileSync(join(ROOT, 'data', 'sites', 'leagueofcooking', 'backgrounds.json'), 'utf8'));
const kit = (bg.kitchens || []).find(k => k.id === bg.activeKitchenId) || (bg.kitchens || [])[0];
const b0 = (kit && kit.backgrounds && kit.backgrounds[0]) || (bg.hero || [])[0];
fs.mkdirSync(join(ROOT, 'data', 'tmp'), { recursive: true });
const bgPath = join(ROOT, 'data', 'tmp', '_flowtest-bg.jpg');
fs.writeFileSync(bgPath, Buffer.from(String(b0.base64).replace(/^data:image\/\w+;base64,/, ''), 'base64'));

const outDir = join(ROOT, 'output', '_flow-test');
fs.mkdirSync(outDir, { recursive: true });

// Simple recipe (pancake batter) — prompt 1 establishes a WHITE BOWL.
// Follow-ups DO NOT re-describe the bowl/kitchen; they rely on chat memory.
const PROMPTS = [
  'Photorealistic homemade iPhone-style kitchen photo: a white ceramic mixing bowl containing flour, a cracked egg and sugar, ready to be mixed, sitting on the counter, soft natural daylight, casual imperfect look, no text, no watermark, no hands.',
  'Next step of the same recipe, same scene: the ingredients are now mixed into a smooth pale pancake batter inside the bowl.',
  'Final step of the same recipe: a finished stack of golden pancakes served on a white plate, with the same kitchen background.',
];

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false, viewport: null,
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'],
  ignoreDefaultArgs: ['--enable-automation'], timeout: 60000,
});
const flow = new FlowPage(null, context);

function saveCaptured(flow, before, outPath) {
  // try sniffer buffer first, else new DOM src
  return (async () => {
    const caps = flow._stopNetworkSniffer();
    if (caps && caps.length && caps[0].buffer) {
      fs.writeFileSync(outPath, caps[0].buffer);
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 5000) return 'sniffer';
    }
    const after = await flow._getAllImgSrcs();
    const newSrcs = after.filter(s => !before.has(s));
    if (newSrcs.length) { try { await flow._downloadBySrc(outPath, newSrcs); return 'src'; } catch {} }
    return 'FAIL';
  })();
}

(async () => {
  // ---- Image 1: full generate (project + background + prompt, NO refs) ----
  const out1 = join(outDir, 'continuity-1.jpg');
  console.log('\n=== Image 1 (background + prompt, NO refs) ===');
  const ok1 = await flow.generate(PROMPTS[0], bgPath, [], 'PORTRAIT', out1, {});
  console.log('img1 ->', ok1, fs.existsSync(out1) ? (fs.statSync(out1).size / 1024).toFixed(0) + 'KB' : 'MISSING');

  // ---- Follow-ups in the SAME chat: no new project, no bg, no refs ----
  for (let i = 1; i < PROMPTS.length; i++) {
    const outN = join(outDir, `continuity-${i + 1}.jpg`);
    console.log(`\n=== Image ${i + 1} (FOLLOW-UP in same chat, NO refs) ===`);
    console.log('prompt:', PROMPTS[i]);
    try {
      await flow._typePrompt(PROMPTS[i]);
      const before = new Set(await flow._getAllImgSrcs());
      flow._startNetworkSniffer();
      await flow._clickCreate();
      await flow._waitForGenerationProgress();
      await flow._delay(4000);
      const how = await saveCaptured(flow, before, outN);
      console.log(`img${i + 1} -> ${how}`, fs.existsSync(outN) ? (fs.statSync(outN).size / 1024).toFixed(0) + 'KB' : 'MISSING');
    } catch (e) {
      console.error(`img${i + 1} error:`, e.message);
    }
  }

  try { await flow.page.screenshot({ path: join(outDir, 'continuity-chat.png') }); console.log('\nchat screenshot -> output/_flow-test/continuity-chat.png'); } catch {}
  await flow._delay(1500);
  try { await context.close(); } catch {}
  console.log('DONE.');
})();
