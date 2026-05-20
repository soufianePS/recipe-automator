/**
 * Test script: send the EXACT VG prompt to Gemini and capture the raw output.
 *
 * Goal: see what Gemini actually returns BEFORE patching anything in the
 * orchestrator. Saves the prompt + raw response + parsed JSON (if valid)
 * to data/tmp/gemini-test/ for inspection.
 *
 * Usage:
 *   node scripts/test-gemini-vg-output.mjs [--topic "Cheeseburgers"]
 *
 * Requires:
 *   - The recipe-automator-profile Chrome profile to be logged into Gemini
 *   - No other automation running (this one launches its own Playwright)
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { StateManager } from '../src/shared/utils/state-manager.js';
import { VERIFIED_GENERATOR_DEFAULTS } from '../src/modules/verified-generator/prompts-verified.js';
import { GeminiChatPage } from '../src/shared/pages/gemini-chat.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'data', 'tmp', 'gemini-test');

const args = process.argv.slice(2);
const arg = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const TOPIC = arg('topic', 'Cheeseburgers');
const PROFILE_OVERRIDE = arg('profile', null);  // e.g. 'malikaassim2017@gmail.com'

const log = (...a) => console.log('[test]', ...a);

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // ── 1. Build the prompt the orchestrator would build ──────────
  await StateManager.init();
  const settings = await StateManager.getSettings();
  const vgSettings = settings.verifiedGenerator || {};
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings.prompts?.recipeVisualPlan || defaults.prompts.recipeVisualPlan;

  // Mimic the substitutions the orchestrator does (line 587-595)
  const prompt = template
    .replace(/\{\{topic\}\}/g, TOPIC)
    .replace(/\{\{categories\}\}/g, settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert')
    .replace(/\{\{min_steps\}\}/g, String(vgSettings.minVisualSteps || defaults.minVisualSteps))
    .replace(/\{\{max_steps\}\}/g, String(vgSettings.maxVisualSteps || defaults.maxVisualSteps))
    .replace(/\{\{default_camera_angle\}\}/g, 'choose best angle for this step')
    .replace(/\{\{related_recipes\}\}/g, 'No related recipes available — skip internal linking.')
    .replace(/\{\{section_structure\}\}/g, '')
    .replace(/\{\{template_instructions\}\}/g, '\nUse a friendly, conversational tone.');

  const promptPath = join(OUT_DIR, `${ts}-prompt.txt`);
  writeFileSync(promptPath, prompt, 'utf8');
  log(`Prompt saved to: ${promptPath} (${prompt.length} chars)`);

  // ── 2. Launch Playwright with the chosen Flow account profile ─
  const profileName = PROFILE_OVERRIDE || 'recipe-automator-profile';
  const profileDir = join(process.env.LOCALAPPDATA || '', profileName);
  log(`Profile: ${profileDir}`);
  log(`Topic: ${TOPIC}`);
  log('Launching Playwright Chromium with the recipe-automator profile…');

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const browser = context.browser();

  try {
    const gemini = new GeminiChatPage(browser, context);
    log('Opening Gemini chat…');
    await gemini.init();
    log('Gemini chat ready.');

    log('Sending prompt + waiting for response (this can take 30s-2min)…');
    const t0 = Date.now();
    const response = await gemini.sendPromptAndGetResponse(prompt, true);
    const dur = ((Date.now() - t0) / 1000).toFixed(1);

    log(`Response received in ${dur}s.`);
    log(`success: ${response.success}`);
    if (!response.success) log(`error: ${response.error}`);

    // ── 3. Save raw response + parsed JSON ───────────────────────
    const responsePath = join(OUT_DIR, `${ts}-response.json`);
    writeFileSync(responsePath, JSON.stringify({
      topic: TOPIC,
      timestamp: ts,
      durationSec: Number(dur),
      success: response.success,
      error: response.error || null,
      rawText: response.rawText || response.text || null,
      data: response.data || null,
    }, null, 2), 'utf8');
    log(`Full response saved to: ${responsePath}`);

    // ── 4. Visual summary on stdout ──────────────────────────────
    console.log('\n=================================================');
    console.log('  GEMINI RESPONSE SUMMARY');
    console.log('=================================================');
    console.log('Topic:', TOPIC);
    console.log('Duration:', dur, 's');
    console.log('Success:', response.success);
    if (response.error) console.log('Error:', response.error);

    if (response.data) {
      console.log('\n--- DATA STRUCTURE ---');
      console.log('Top-level keys:', Object.keys(response.data).join(', '));
      if (response.data.recipe) {
        console.log('recipe.* keys:', Object.keys(response.data.recipe).join(', '));
        console.log('recipe.post_title:', JSON.stringify(response.data.recipe.post_title || '(missing)').slice(0, 80));
        console.log('recipe.article_title:', JSON.stringify(response.data.recipe.article_title || '(missing)').slice(0, 80));
        console.log('recipe.steps?', Array.isArray(response.data.recipe.steps) ? `array of ${response.data.recipe.steps.length}` : '(not an array)');
        console.log('recipe.instructions?', Array.isArray(response.data.recipe.instructions) ? `array of ${response.data.recipe.instructions.length}` : '(not present)');
        console.log('recipe.ingredients?', Array.isArray(response.data.recipe.ingredients) ? `array of ${response.data.recipe.ingredients.length}` : '(not an array)');
      }
      if (response.data.visual_plan) {
        console.log('visual_plan.* keys:', Object.keys(response.data.visual_plan).join(', '));
      }
      if (response.data.pinterest_pins) {
        console.log('pinterest_pins:', Array.isArray(response.data.pinterest_pins) ? `array of ${response.data.pinterest_pins.length}` : 'present (not array)');
      }
    }

    if (response.rawText || response.text) {
      const raw = response.rawText || response.text;
      console.log('\n--- RAW RESPONSE PREVIEW (first 800 chars) ---');
      console.log(raw.slice(0, 800));
      console.log(raw.length > 800 ? '... (truncated, full content in file)' : '');
    }
    console.log('\n=================================================');
    console.log('Files:');
    console.log('  Prompt :', promptPath);
    console.log('  Response:', responsePath);
    console.log('=================================================\n');
  } finally {
    log('Closing browser in 5s — review the Gemini tab if you want…');
    await new Promise(r => setTimeout(r, 5000));
    try { await context.close(); } catch {}
  }
}

main().catch(e => {
  console.error('[test] FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
