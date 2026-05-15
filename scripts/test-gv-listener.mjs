/**
 * Direct test of the new GeminiImageChat network-listener path.
 *
 * Goal: prove the listener captures (a) the model text on chat init and
 * (b) the raw image bytes on each generate(), with cross-turn dedup intact.
 * No orchestrator, no sheet, no WP — just the driver class with a recipe
 * picked here.
 *
 * Recipe (from my mind): Honey Sriracha Glazed Salmon
 *   turn 1 — ingredients flatlay (raw salmon, honey, sriracha, garlic, lime)
 *   turn 2 — cooking step (salmon searing in skillet, glaze reducing)
 *
 * Run:
 *   node scripts/test-gv-listener.mjs
 *
 * Output: output/_gv-listener-test/ + console.
 */

import { chromium } from 'playwright';
import { GeminiImageChat, GeminiRateLimitError, GeminiAccountBlockedError } from '../src/shared/pages/gemini-image-chat.js';
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'output', '_gv-listener-test');

function pickBackground() {
  const bgFile = join(ROOT, 'data', 'sites', 'leagueofcooking', 'backgrounds.json');
  if (!existsSync(bgFile)) return null;
  let data;
  try { data = JSON.parse(readFileSync(bgFile, 'utf-8')); } catch { return null; }
  const candidates = [...(data.steps || []), ...(data.hero || []), ...(data.ingredients || [])];
  if (!candidates.length) return null;
  const first = candidates.find(b => b.base64);
  if (!first) return null;
  const tmpDir = join(ROOT, 'data', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const ext = (first.name && /\.(jpe?g|png|webp)$/i.exec(first.name)?.[0]) || '.jpg';
  const tmpPath = join(tmpDir, `gv-test-bg-${Date.now()}${ext}`);
  writeFileSync(tmpPath, Buffer.from(first.base64, 'base64'));
  return tmpPath;
}

const RECIPE_TITLE = 'Honey Sriracha Glazed Salmon';

const INTRO = [
  `You are a professional food photographer with a recognizable, consistent visual style.`,
  `We will create a recipe blog post for "${RECIPE_TITLE}" together over the next few turns.`,
  ``,
  `In this conversation I will ask you to generate 2 photorealistic food photography images, ONE AT A TIME, in this exact order:`,
  ` 1. Ingredients flatlay — raw salmon fillets, a small bowl of honey, a small bowl of sriracha, garlic cloves, lime, on the kitchen surface I attach.`,
  ` 2. Cooking step — salmon fillets searing in a skillet, glossy red-orange glaze reducing around them, slight char on the edges.`,
  ``,
  `Same kitchen surface, lighting, and color grading across both images. Photorealistic magazine food-photography style. ONE IMAGE PER TURN — never a grid.`,
  ``,
  `Acknowledge with a single short sentence (no preamble), then I'll send the first prompt.`,
].join('\n');

const PROMPT_INGREDIENTS = `Generate image 1 of 2 in this recipe series — ingredients flatlay for "${RECIPE_TITLE}". Top-down view on the attached kitchen surface (treat it as ground truth for the surface texture and lighting). Arrangement: two raw salmon fillets skin-side down, a small ramekin of honey, a small ramekin of bright red sriracha, 4 garlic cloves, half a lime cut-side up, a few sprigs of cilantro. Soft natural side light, shallow DoF on the salmon, real glistening skin. No text, no overlays, no plates — just ingredients on the surface. ONE image, no grid.`;

const PROMPT_COOKING = `Generate image 2 of 2 — cooking step for "${RECIPE_TITLE}". Treat the previous image as ground truth for the salmon appearance (same color, same fillet shape). Now show those fillets searing skin-side-down in a stainless steel skillet on the same kitchen surface, with a glossy red-orange honey-sriracha glaze reducing around them — visible bubbles, slight caramelization on the edges, steam wisps. Side angle, shallow DoF, magazine food-blog style. ONE image, no grid, no plating.`;

function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

async function main() {
  console.log('=== GV listener direct test ===');
  console.log('Recipe:', RECIPE_TITLE);

  const bgPath = pickBackground();
  if (!bgPath) {
    console.error('No background image available. Add at least one background via the dashboard first.');
    process.exit(1);
  }
  console.log('Background:', bgPath, '(', statSync(bgPath).size, 'bytes)');

  const account = await FlowAccountManager.getActiveAccount();
  if (!account) {
    console.error('No active Flow account.');
    process.exit(1);
  }
  const profileDir = FlowAccountManager.getProfileDir(account);
  if (!existsSync(profileDir)) {
    console.error('Profile dir missing:', profileDir);
    process.exit(1);
  }
  console.log(`Account: "${account.name}" → ${profileDir}`);

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = `${Date.now()}`;
  const outIngredients = join(OUT_DIR, `${stem}-1-ingredients.jpg`);
  const outCooking     = join(OUT_DIR, `${stem}-2-cooking.jpg`);

  console.log('\nLaunching Playwright Chromium with persistent profile...');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const gemini = new GeminiImageChat(null, context);
  const results = { intro: null, gen1: null, gen2: null };

  try {
    console.log('\n[step 1/4] init() — opens gemini.google.com, attaches network listener');
    const tInit = Date.now();
    await gemini.init();
    console.log(`  init() done in ${((Date.now() - tInit)/1000).toFixed(1)}s`);

    console.log('\n[step 2/4] startNewChat() — sends intro, captures ack via network listener');
    const tIntro = Date.now();
    const introResp = await gemini.startNewChat(INTRO);
    const introMs = Date.now() - tIntro;
    results.intro = { ms: introMs, len: introResp?.length || 0, preview: (introResp || '').slice(0, 120).replace(/\n/g,' ') };
    console.log(`  startNewChat() in ${(introMs/1000).toFixed(1)}s — ${results.intro.len} chars`);
    console.log(`  preview: "${results.intro.preview}…"`);

    console.log('\n[step 3/4] generate() #1 — ingredients flatlay');
    const t1 = Date.now();
    const ok1 = await gemini.generate(PROMPT_INGREDIENTS, bgPath, [], '9:16', outIngredients);
    const ms1 = Date.now() - t1;
    if (ok1 && existsSync(outIngredients)) {
      const buf = readFileSync(outIngredients);
      results.gen1 = { ms: ms1, kb: (buf.length/1024).toFixed(1), md5: md5(buf).slice(0, 12), path: outIngredients };
      console.log(`  ✓ gen1 in ${(ms1/1000).toFixed(1)}s — ${results.gen1.kb}KB md5=${results.gen1.md5} → ${outIngredients}`);
    } else {
      console.error('  ✗ gen1 returned false or no file');
      results.gen1 = { ms: ms1, error: 'no file' };
    }

    console.log('\n[step 4/4] generate() #2 — cooking step (with ingredients as ref)');
    const refsForStep = existsSync(outIngredients) ? [outIngredients] : [];
    const t2 = Date.now();
    const ok2 = await gemini.generate(PROMPT_COOKING, bgPath, refsForStep, '9:16', outCooking);
    const ms2 = Date.now() - t2;
    if (ok2 && existsSync(outCooking)) {
      const buf = readFileSync(outCooking);
      results.gen2 = { ms: ms2, kb: (buf.length/1024).toFixed(1), md5: md5(buf).slice(0, 12), path: outCooking };
      console.log(`  ✓ gen2 in ${(ms2/1000).toFixed(1)}s — ${results.gen2.kb}KB md5=${results.gen2.md5} → ${outCooking}`);
      if (results.gen1?.md5 && results.gen1.md5 === results.gen2.md5) {
        console.error('  ⚠ gen2 md5 == gen1 md5 — dedup did NOT catch a duplicate');
      }
    } else {
      console.error('  ✗ gen2 returned false or no file');
      results.gen2 = { ms: ms2, error: 'no file' };
    }

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify(results, null, 2));
    writeFileSync(join(OUT_DIR, `${stem}-summary.json`), JSON.stringify(results, null, 2));
  } catch (e) {
    if (e instanceof GeminiRateLimitError) {
      console.error('Rate-limit:', e.message);
    } else if (e instanceof GeminiAccountBlockedError) {
      console.error('Login wall:', e.message);
    } else {
      console.error('FAIL:', e.message);
      console.error(e.stack);
    }
    process.exitCode = 1;
  } finally {
    console.log('\nClosing browser in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    try { await gemini.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

main();
