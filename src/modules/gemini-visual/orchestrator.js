/**
 * GeminiVisualOrchestrator — same recipe pipeline as VG (ChatGPT → recipe JSON
 * → visual plan), but image generation runs via the Gemini consumer chat
 * (gemini.google.com) instead of Google Flow. One chat per recipe gives the
 * model native multi-turn visual memory: every new image "sees" every prior
 * one in the same conversation, so consistency is enforced by the model
 * rather than by Gemini-API verification rounds.
 *
 * Extends VerifiedGeneratorOrchestrator to reuse:
 *   - _stepLoadJob (Sheet → recipeTitle)
 *   - _stepGenerateRecipeJSON (ChatGPT or Gemini browser → recipe + visual_plan + pins)
 *   - structure randomization, internal-linking, nutrition fetch, stats hooks
 *   - _prepareFile / _getOutputDir / _findStepImage
 *
 * Overrides only the 4 image-generation states to call gemini-image-chat.
 * Same prompt builders as VG (buildIngredientsPrompt / buildStepPrompt /
 * buildHeroPrompt) — exactly the same instructions that previously drove Flow.
 *
 * This module never touches FlowPage. Flow modules stay intact for the other
 * modes (generator, scraper, verified-generator).
 */

import { VerifiedGeneratorOrchestrator } from '../verified-generator/orchestrator.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { Logger } from '../../shared/utils/logger.js';
import { WordPressAPI } from '../../shared/utils/wordpress-api.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { fetchNutrition } from '../../shared/utils/nutrition-api.js';
import { GeminiImageChat, GeminiRateLimitError, GeminiAccountBlockedError } from '../../shared/pages/gemini-image-chat.js';
import { buildIngredientsPrompt, buildStepPrompt, buildHeroPrompt } from '../verified-generator/prompt-builder.js';
import { VERIFIED_GENERATOR_DEFAULTS } from '../verified-generator/prompts-verified.js';
import { validateVisualPlan } from '../verified-generator/visual-planner.js';
import { VGStats } from '../verified-generator/vg-stats.js';
import { sanitizeRecipeJSON, FILENAMES } from '../base-orchestrator.js';
import { scrapePinterestImages } from './pinterest-scraper.js';
import { buildGVRecipePrompt, resolveBaseTemplate, describeBaseTemplate } from './prompts-gv.js';
import { GV_VOICES, pickVoice } from './voice-pool.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

/** Title-case helper (mirrors VG's local one). Kept local to avoid touching VG. */
function toTitleCase(str) {
  if (!str) return str;
  const smallWords = new Set(['a','an','the','and','but','or','for','nor','on','at','to','in','of','with','by','from','as','is','vs']);
  return str.split(/\s+/).map((word, i) => {
    if (i === 0 || !smallWords.has(word.toLowerCase())) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.toLowerCase();
  }).join(' ');
}

/**
 * Convert ISO 8601 duration (PT45M, PT1H30M, PT2H) into Pinterest-pin-friendly
 * text ("45 Minutes", "1 Hour 30 Minutes", "2 Hours"). Returns empty string on
 * unparseable input — caller falls back to a generic subtitle.
 */
function parseTotalTimeHuman(pt) {
  if (!pt || typeof pt !== 'string') return '';
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(pt.trim());
  if (!m) return '';
  const hours = parseInt(m[1] || '0', 10);
  const mins = parseInt(m[2] || '0', 10);
  if (!hours && !mins) return '';
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'Hour' : 'Hours'}`);
  if (mins > 0) parts.push(`${mins} Minutes`);
  return parts.join(' ');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = join(__dirname, '..', '..', '..', 'data', 'tmp');

export class GeminiVisualOrchestrator extends VerifiedGeneratorOrchestrator {
  constructor(browser, context, serverCtx) {
    super(browser, context, serverCtx);
    // One chat instance, lazily initialized on the first image generation.
    // Persists across all 4 image-gen states for the SAME recipe — that's
    // what gives us native visual memory.
    this.gemini = new GeminiImageChat(null, context);
    this._chatStarted = false;
    this._chatStartedFor = null; // recipe title, so we restart for a new recipe
    this._consistencyRulesSent = false; // single-conv mode: send consistency-rules turn once before first image
  }

  // ───────────────────────────────────────────────────────────────────
  // Step handler routing — only image-gen states differ from VG.
  // ───────────────────────────────────────────────────────────────────
  get _stepHandlers() {
    const parent = super._stepHandlers;
    return {
      ...parent,
      [STATES.GENERATING_RECIPE_JSON]: () => this._stepGenerateRecipeJSON(),
      [STATES.GENERATING_INGREDIENTS]: () => this._stepGeminiIngredients(),
      [STATES.GENERATING_STEPS]:       () => this._stepGeminiStep(),
      [STATES.GENERATING_HERO]:        () => this._stepGeminiHero(),
      [STATES.GENERATING_PINS]:        () => this._stepGeminiPins(),
      [STATES.COMPLETED]: async () => {
        // Reset chat marker so the next recipe gets a fresh conversation
        this._chatStarted = false;
        this._chatStartedFor = null;
        this._consistencyRulesSent = false;
        try { await this.gemini.close(); } catch {}
        // Delegate to VG's COMPLETED (which itself wraps base cleanup + stats)
        await parent[STATES.COMPLETED]();
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Chat lifecycle — one conversation per recipe.
  // ───────────────────────────────────────────────────────────────────

  /**
   * Open the Gemini chat tab (if not already) and send the recipe-context
   * message. Idempotent within a recipe; resets when the recipe title changes.
   *
   * Single-conversation mode note: when recipe-gen ran via Gemini, the chat is
   * already open (and _chatStarted is already true). We do NOT re-send the
   * full intro in that case — but we DO send a short consistency-rules
   * follow-up turn ONCE before the first image gen, so the model has explicit
   * cross-image continuity guidance even though the recipe-gen prompt is what
   * primed the chat.
   */
  async _ensureChatStarted(state) {
    if (this._chatStarted && this._chatStartedFor === state.recipeTitle) {
      // Chat already open (recipe-gen path). Inject consistency rules once.
      if (!this._consistencyRulesSent) {
        try {
          const rules = this._buildConsistencyRulesText(state);
          Logger.step('GeminiVisual', 'Sending consistency-rules follow-up before first image…');
          await this.gemini.sendFollowupText(rules);
          this._consistencyRulesSent = true;
          Logger.success('[GeminiVisual] consistency rules acknowledged');
        } catch (e) {
          // Non-fatal — the recipe-gen prompt already includes image-gen guidance.
          // Worst case: image gen leans more on the per-turn prompt content.
          Logger.warn(`[GeminiVisual] consistency-rules follow-up failed (${e.message.split('\n')[0]}) — continuing`);
          this._consistencyRulesSent = true; // don't keep retrying
        }
      }
      return;
    }

    Logger.step('GeminiVisual', `Opening chat for "${state.recipeTitle}"`);
    await this.gemini.init();

    const recipe = state.recipeJSON || {};
    const stepsCount = state.steps?.length || 0;
    const pinsCount  = state.pinterestPins?.length || 0;
    const total = 1 + stepsCount + 1 + pinsCount; // ingredients + steps + hero + pins

    const intro = [
      `You are a professional food photographer with a recognizable, consistent visual style.`,
      ``,
      `RECIPE: "${recipe.post_title || state.recipeTitle}"`,
      recipe.intro ? recipe.intro.split(/\n+/).slice(0, 2).join(' ') : '',
      ``,
      `In this conversation I will ask you to generate ${total} photorealistic food photography images, ONE AT A TIME, in this exact order:`,
      ` 1. Ingredients flatlay (raw ingredients in small bowls on the kitchen surface)`,
      ` 2-${stepsCount + 1}. ${stepsCount} cooking step images, in cooking-progression order`,
      ` ${stepsCount + 2}. Hero image — finished plated dish`,
      pinsCount ? ` ${stepsCount + 3}-${total}. ${pinsCount} Pinterest pin images (vertical 2:3, with title overlay)` : '',
      ``,
      `CRITICAL CONSISTENCY RULES:`,
      `- Every image must use the SAME kitchen surface, lighting direction, color grading, and cookware as the references I attach.`,
      `- Whenever I attach a previous step image, treat it as ground truth for the food's appearance — keep the same chicken / vegetables / sauce color / sear level evolving naturally between steps.`,
      `- Look at every image you have generated earlier in this conversation before producing the next one. They are part of the visual canon for this recipe.`,
      `- Photorealistic, magazine food-photography style. Soft natural side light, shallow DoF, real steam/glaze/sear, no plastic look. No text or logo overlays unless I ask for one.`,
      ``,
      `I will send each prompt with the relevant background and previous images attached. Acknowledge with a single short sentence (no preamble), then I will send the first prompt.`,
    ].filter(Boolean).join('\n');

    // Pass Pinterest reference photos at turn 1 so Gemini has visual grounding
    // for the dish before any image-gen turn (mirrors what we do with ChatGPT).
    const refPaths = (state.gvPinterestRefs || []).filter(p => p && existsSync(p));
    if (refPaths.length > 0) {
      Logger.info(`[GeminiVisual] attaching ${refPaths.length} Pinterest refs at chat start`);
    }
    await this.gemini.startNewChat(intro, refPaths);
    this._chatStarted = true;
    this._chatStartedFor = state.recipeTitle;
    Logger.success('[GeminiVisual] chat ready, recipe context sent');
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────

  /**
   * GV doesn't use Flow at all — recipe + images both go through Gemini chat.
   * Override the base hook so the Flow tab never opens during a GV run.
   */
  async _cleanupFlowProjects() {
    // intentional no-op
  }

  _writeBgToTmp(bgState, name) {
    if (!bgState?.base64) throw new Error(`Background "${name}" not loaded — re-run from start`);
    mkdirSync(TMP_DIR, { recursive: true });
    const path = join(TMP_DIR, name);
    writeFileSync(path, Buffer.from(bgState.base64, 'base64'));
    return path;
  }

  /**
   * Build the consistency-rules text injected ONCE into a Gemini chat that was
   * opened by recipe-gen (single-conversation mode). This is what the legacy
   * intro used to send during _ensureChatStarted's full path — but since
   * recipe-gen already opened the chat with its own prompt, we send a tighter
   * turn here to prime image gen without restating the recipe.
   */
  _buildConsistencyRulesText(state) {
    const stepsCount = state.steps?.length || 0;
    const pinsCount  = state.pinterestPins?.length || 0;
    const total = 1 + stepsCount + 1 + pinsCount; // ingredients + steps + hero + pins
    return [
      `Now I will follow up with ${total} image-generation requests in this same conversation, ONE AT A TIME, in this order:`,
      ` 1. Ingredients flatlay (raw ingredients on the kitchen surface — still life)`,
      ` 2-${stepsCount + 1}. ${stepsCount} cooking step images, in cooking-progression order (active cooking, motion, heat — visually distinct from the flatlay)`,
      ` ${stepsCount + 2}. Hero image — finished plated dish`,
      pinsCount ? ` ${stepsCount + 3}-${total}. ${pinsCount} Pinterest pin images (vertical 2:3, with title overlay)` : '',
      ``,
      `CRITICAL CONSISTENCY RULES for every upcoming image:`,
      `- ONE IMAGE PER TURN. When I ask for image N, produce EXACTLY ONE image — never a grid, never multiple variations, never anticipate future steps. I will request each image individually in its own turn.`,
      `- Same kitchen surface, same lighting direction, same color grading, same cookware family across all images.`,
      `- When I attach a previous step image, treat it as ground truth for the food's appearance — keep the food evolving naturally between steps (sear deepens, sauce thickens, etc., not random restarts).`,
      `- Look at every image you have generated earlier in this conversation before producing the next one. They are part of the visual canon for this recipe.`,
      `- Step images must be visually DISTINCT from the ingredients flatlay — process shots with active cooking, never another still-life of raw ingredients.`,
      `- Photorealistic, magazine food-photography style. Soft natural side light, shallow DoF, real steam/glaze/sear, no plastic look. No text or logo overlays unless I ask.`,
      ``,
      `Acknowledge with a single short sentence (no preamble), then I will send the first image prompt.`
    ].filter(Boolean).join('\n');
  }

  /**
   * Wrap a VG-style image prompt with a tiny Gemini-chat-aware prefix that
   * tells the model to leverage the conversation context without altering
   * the proven photographic instructions VG uses for Flow.
   *
   * Keep this short — the model responds best to concise photo prompts.
   * The chat memory itself does the heavy lifting for continuity.
   */
  _wrapForChat(vgPrompt, kind, opts = {}) {
    // CRITICAL: never phrase the prefix as "Image X of Y in this series" —
    // Gemini interprets that as a request to produce all Y images RIGHT NOW
    // (verified in production: a single ingredients turn returned 4–6 images
    // including future cooking steps). Instead, frame this turn as a single,
    // standalone image request and rely on chat memory for continuity.
    const refHint = opts.hasRefs
      ? 'Treat the attached image(s) as ground truth: match their style, lighting, surface, plating exactly.'
      : '';
    const oneImageRule =
      'PRODUCE EXACTLY ONE IMAGE in this turn. Do NOT generate variations, alternatives, grids, or anticipate future steps — I will request the next images one at a time in subsequent turns. If you produced multiple images in your previous turn, treat that as a mistake and produce only one this time.';
    const continuityHint =
      'Keep the same kitchen surface, lighting direction, color grading, and cookware family as any image you generated earlier in this conversation.';
    const prefix = [oneImageRule, continuityHint, refHint].filter(Boolean).join(' ');
    return `${prefix}\n\n${vgPrompt}`;
  }

  /** Convert the recipe-card aspect ratio names (LANDSCAPE/PORTRAIT/SQUARE) into ratios Gemini understands. */
  _aspectLabel(setting) {
    const v = (setting || '').toString().toUpperCase();
    if (v === 'LANDSCAPE' || v === '16:9') return '16:9 landscape';
    if (v === 'SQUARE' || v === '1:1') return '1:1 square';
    if (v === '3:4') return '3:4 portrait';
    if (v === '2:3') return '2:3 vertical';
    return '4:5 portrait';
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE: GENERATING_INGREDIENTS
  // ───────────────────────────────────────────────────────────────────

  async _stepGeminiIngredients() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);

    if (state.ingredientsImage?.base64) {
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    const ingredientsState = state.visualPlan?.ingredients_image;
    if (!ingredientsState) throw new Error('No ingredients_image in visual plan');

    Logger.step('GeminiVisual', 'Generating ingredients flatlay...');
    await this._ensureChatStarted(state);

    // Use VG's proven prompt builder, then wrap with a tiny chat-aware prefix.
    const vgPrompt = buildIngredientsPrompt(ingredientsState, vgSettings);
    const totalShots = 1 + (state.steps?.length || 0) + 1 + (state.pinterestPins?.length || 0);
    const prompt = this._wrapForChat(vgPrompt, 'ingredients', {
      hasRefs: true,
      shotNumber: 1,
      totalShots
    });

    // Background: ingredients/steps share the SAME kitchen pool (configured in
    // Settings → Kitchens). The hero background is reserved for the hero shot
    // and the last step (the serving moment). Using the hero bg here was a bug:
    // it ignored the user's configured ingredient/steps surface.
    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue — set a kitchen in Settings');
    let bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const bgPath = this._prepareFile(state.backgroundQueue[bgIndex], `ingredients-bg`);

    const outputDir = this._getOutputDir(state, settings);
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, state.recipeJSON?.ingredients_seo?.filename || FILENAMES.ingredients);

    const aspect = this._aspectLabel(settings.ingredientsAspectRatio || 'PORTRAIT');
    const ok = await this.gemini.generate(prompt, bgPath, [], aspect, outputPath);
    if (!ok) throw new Error('Gemini ingredients generation failed after retries');

    // Save base64 for WP upload (same convention as Flow path)
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('ingredients', imgBuf.toString('base64'));
    await StateManager.updateState({
      status: STATES.GENERATING_STEPS,
      currentStepIndex: 0,
      ingredientsImage: { base64: true },
      backgroundQueueIndex: bgIndex + 1
    });
    Logger.success('[GeminiVisual] ingredients image generated');
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE: GENERATING_STEPS  (called once per pending step)
  // ───────────────────────────────────────────────────────────────────

  async _stepGeminiStep() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const idx = state.currentStepIndex;
    const step = state.steps[idx];
    const visualStep = state.visualPlan?.visual_steps?.[idx];

    if (step?.base64) { await this._advanceStep(); return; }
    if (!visualStep) throw new Error(`No visual state for step ${idx + 1}`);

    Logger.step('GeminiVisual', `Step ${idx + 1}/${state.steps.length}: ${visualStep.title}`);
    await this._ensureChatStarted(state);

    const isLastStep = idx === state.steps.length - 1;
    const isFirstStep = idx === 0;
    // Use VG's proven prompt builder; wrap with a small chat-aware prefix.
    // firstStep flag injects explicit anti-flatlay rules so Gemini doesn't
    // produce a near-duplicate of the ingredients photo for step 1.
    const vgPrompt = buildStepPrompt(visualStep, vgSettings, { isLastStep, firstStep: isFirstStep });
    const totalShots = 1 + (state.steps?.length || 0) + 1 + (state.pinterestPins?.length || 0);
    const prompt = this._wrapForChat(vgPrompt, 'step', {
      hasRefs: true,
      shotNumber: 2 + idx,        // ingredients = 1, step idx+1 starts at 2
      totalShots
    });

    // Background: serving step uses HERO bg, earlier steps use kitchen pool.
    let backgroundPath;
    let bgIndex = state.backgroundQueueIndex || 0;
    if (isLastStep && state.selectedHeroBackground?.base64) {
      backgroundPath = this._writeBgToTmp(state.selectedHeroBackground, `step-hero-bg-${Date.now()}.jpg`);
    } else {
      if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
      bgIndex = bgIndex % state.backgroundQueue.length;
      backgroundPath = this._prepareFile(state.backgroundQueue[bgIndex], `bg-${bgIndex + 1}`);
    }

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, step.seo?.filename || FILENAMES.stepDefault(idx));

    // Pass previous step image as an extra ref — even though Gemini already
    // saw it in the chat, including it explicitly reinforces consistency for
    // the food's appearance (sear, sauce, etc.).
    const refs = [];
    if (idx > 0) {
      const prev = this._findStepImage(state.steps, idx - 1, outputDir);
      if (prev && existsSync(prev)) refs.push(prev);
    }

    const aspect = this._aspectLabel(settings.stepAspectRatio || 'PORTRAIT');
    const ok = await this.gemini.generate(prompt, backgroundPath, refs, aspect, outputPath);
    if (!ok) throw new Error(`Gemini step ${idx + 1} generation failed after retries`);

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`step_${idx}`, imgBuf.toString('base64'));

    const steps = [...state.steps];
    steps[idx] = { ...steps[idx], base64: true, savedFilename: basename(outputPath) };
    await StateManager.updateState({ steps, backgroundQueueIndex: bgIndex + 1 });
    Logger.success(`[GeminiVisual] step ${idx + 1} generated`);
    await this._advanceStep();
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE: GENERATING_HERO
  // ───────────────────────────────────────────────────────────────────

  async _stepGeminiHero() {
    const state = await StateManager.getState();
    if (state.heroImage?.base64) {
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const heroState = state.visualPlan?.hero_image;
    if (!heroState) throw new Error('No hero_image in visual plan');

    Logger.step('GeminiVisual', 'Generating hero image...');
    await this._ensureChatStarted(state);

    // Use VG's proven prompt builder; wrap with chat-aware prefix
    const vgPrompt = buildHeroPrompt(heroState, vgSettings);
    const totalShots = 1 + (state.steps?.length || 0) + 1 + (state.pinterestPins?.length || 0);
    const prompt = this._wrapForChat(vgPrompt, 'hero', {
      hasRefs: true,
      shotNumber: 2 + (state.steps?.length || 0),
      totalShots
    });
    const bgPath = this._writeBgToTmp(state.selectedHeroBackground, `hero-bg-${Date.now()}.jpg`);

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.hero_seo?.filename || FILENAMES.hero);

    // Last step image as additional ref — gives the hero a "this is what
    // the user just made" anchor.
    const refs = [];
    if (state.steps?.length > 0) {
      const lastStepPath = this._findStepImage(state.steps, state.steps.length - 1, outputDir);
      if (lastStepPath && existsSync(lastStepPath)) refs.push(lastStepPath);
    }

    const aspect = this._aspectLabel(settings.heroAspectRatio || 'LANDSCAPE');
    const ok = await this.gemini.generate(prompt, bgPath, refs, aspect, outputPath);
    if (!ok) throw new Error('Gemini hero generation failed after retries');

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('hero', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.SAVING_FILES, heroImage: { base64: true } });
    Logger.success('[GeminiVisual] hero image generated');
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE: GENERATING_PINS  (in the SAME chat, after hero — full memory)
  // ───────────────────────────────────────────────────────────────────

  async _stepGeminiPins() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const pins = state.pinterestPins || [];

    if (!pins.length) {
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }
    const pendingIdx = pins.findIndex(p => !p.base64);
    if (pendingIdx === -1) {
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }
    const pin = pins[pendingIdx];

    // ── New pin design: 3 distinct LAYOUTS, hero image as the only ref. ──
    // We dropped the Pinterest-template-folder approach because:
    //   1. Templates were a manual maintenance burden and locked our pins to
    //      one visual style.
    //   2. With Gemini, the model designs better pins from a layout description
    //      + the hero food image than it does by overlaying text on a template.
    //   3. Each turn is now smaller and uses fewer chat refs, reducing the
    //      "send did not land" failures we saw on long Gemini chats.
    // The 3 layouts cycle by pendingIdx so a recipe with N>3 pins still rotates
    // cleanly through them.
    const PIN_LAYOUTS = [
      {
        name: 'TOP-TITLE',
        directive: 'TOP-TITLE layout — the full title text sits in a clean band across the TOP third of the pin (above the food). The subtitle goes directly under the title. The food fills the bottom two-thirds.',
      },
      {
        name: 'BOTTOM-BAND',
        directive: 'BOTTOM-BAND layout — the food fills the upper two-thirds. The title + subtitle sit in a clean ivory or off-white band across the bottom third. Title sizing is BIGGER than a top-title pin.',
      },
      {
        name: 'SPLIT-CENTER',
        directive: 'SPLIT-CENTER layout — the food fills the top half. A bold title in a colored rectangle (warm tone — terracotta, sage, or dusty rose) spans the middle third. A smaller flavor-copy strip + tiny website mark sit at the bottom.',
      },
    ];
    const layout = PIN_LAYOUTS[pendingIdx % PIN_LAYOUTS.length];

    Logger.step('GeminiVisual', `Pinterest pin ${pendingIdx + 1}/${pins.length} — layout: ${layout.name}`);
    await this._ensureChatStarted(state);

    // ── Hero as visual anchor (we MUST have a hero image at this point —
    // the pipeline runs hero gen before pin gen). ──
    const outputDir = this._getOutputDir(state, settings);
    const heroFilename = state.recipeJSON?.hero_seo?.filename || FILENAMES.hero;
    const heroPath = join(outputDir, heroFilename);
    if (!existsSync(heroPath)) {
      throw new Error(`Hero image missing at ${heroPath} — pin gen needs hero as visual anchor`);
    }

    // ── Subtitle picker (different per pin): category-flavored, time-flavored,
    // and a creative hook (use AI's pin.title which is meant to be a varied hook). ──
    const recipeTitle = state.recipeJSON?.post_title || state.recipeTitle || '';
    const websiteDomain = (settings.wpUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const category = state.recipeJSON?.category || '';
    const totalTimeHuman = parseTotalTimeHuman(state.recipeJSON?.total_time);
    const flavorHook = (pin.title && pin.title !== recipeTitle ? pin.title : '') ||
      state.recipeJSON?.focus_keyword ||
      'Better Than Anything Else';

    const subtitlesByLayout = [
      category ? `Easy ${category} Recipe` : 'Easy Recipe',
      totalTimeHuman ? `Ready in ${totalTimeHuman}` : 'Quick & Easy',
      flavorHook,
    ];
    const subtitle = subtitlesByLayout[pendingIdx % subtitlesByLayout.length];

    const prompt = [
      `Generate ONE Pinterest food pin using the uploaded hero food image as the visual anchor.`,
      `The food in the pin must match what's in that photo — no swapped garnishes, no added ingredients, no recomposition.`,
      ``,
      `LAYOUT: ${layout.directive}`,
      ``,
      `TITLE TEXT (exact): "${recipeTitle}"`,
      `SUBTITLE TEXT (exact): "${subtitle}"`,
      `WEBSITE MARK: small elegant text "${websiteDomain}" at the very bottom. Lowercase or sentence case. Never larger than the subtitle.`,
      ``,
      `DIMENSIONS: 2:3 vertical (1000×1500 equivalent). Pinterest mobile crops ~5% top and bottom — keep title and subtitle inside the safe middle 90%.`,
      ``,
      `TYPOGRAPHY: modern bold serif OR clean sans-serif. Title 60–80pt equivalent, subtitle 24–32pt. WHITE title with soft drop shadow when food is dark, DARK title on a light band when food is bright. High mobile readability. NO comic sans, NO outline fonts, NO emojis.`,
      ``,
      `STYLE: premium Pinterest food-blog aesthetic (think Pinch of Yum, Half Baked Harvest, Sally's Baking Addiction). Clean, minimal, appetite-first. NOT cluttered "Tasty"-style with stickers and arrows.`,
      ``,
      `VISUAL FIDELITY: realistic food, NOT AI-look. Slight color enhancement (warmer reds, brighter greens, glossier sauces) to make food more clickable but stay believable. Soft natural side light, NOT studio HDR or ring-light. Subtle shadows for depth, no over-sharpening. NO clutter, NO stickers, NO arrows, NO multiple fonts on one pin. The food is the hero; text supports it.`,
      ``,
      `PRODUCE EXACTLY ONE IMAGE in this turn. Do NOT generate variations.`,
    ].join('\n');

    const pinFilename = `pin-${pendingIdx + 1}.jpg`;
    const outputPath = join(outputDir, pinFilename);

    // Hero is the background/anchor. No additional context refs — keeps the
    // turn small for chat health. Visual continuity comes from the hero alone.
    const aspect = this._aspectLabel(settings.pinterestAspectRatio || 'PORTRAIT');
    const ok = await this.gemini.generate(prompt, heroPath, [], aspect, outputPath);
    if (!ok) throw new Error(`Gemini pin ${pendingIdx + 1} (${layout.name}) generation failed after retries`);

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`pin_${pendingIdx}`, imgBuf.toString('base64'));

    const updatedPins = [...pins];
    updatedPins[pendingIdx] = {
      ...pin,
      base64: true,
      savedFilename: basename(outputPath),
      // Pin metadata for logs / Sheet write-back
      layout: layout.name,
      subtitle,
    };
    await StateManager.updateState({ pinterestPins: updatedPins });
    Logger.success(`[GeminiVisual] pin ${pendingIdx + 1} (${layout.name}) generated`);

    if (updatedPins.every(p => p.base64)) {
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      Logger.success('[GeminiVisual] all pins generated');
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // STATE: GENERATING_RECIPE_JSON  (override VG's version)
  //
  // gemini-visual generates the recipe JSON via:
  //   1. Pinterest scrape → 3 reference photos for visual grounding
  //   2. ChatGPT (CDP-connected real Chrome, see project_cloudflare_cdp.md)
  //      with "Recherche sur le Web" toggle ON + 3 images attached
  //   3. Same JSON output schema as VG (recipe / visual_plan / pinterest_pins)
  //      so post-builder works without modification.
  //
  // Phase 1: same VG schema, no voice/transformation rules. Phase 2 adds those
  // adjustments inside prompts-gv.js without touching VG.
  // ───────────────────────────────────────────────────────────────────

  async _stepGenerateRecipeJSON() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const defaults = VERIFIED_GENERATOR_DEFAULTS;

    VGStats.chatgptStart();
    Logger.step('GV-Recipe', `Generating recipe + visual plan via Pinterest+ChatGPT-search for: ${state.recipeTitle}`);

    // ── 1. Pinterest scrape: 3 visual reference photos ──
    // IMPORTANT: save OUTSIDE data/tmp/ — base-orchestrator wipes data/tmp/ on
    // CREATING_FOLDERS step (only preserves backgroundQueue files), which would
    // delete our Pinterest refs before the Gemini chat phase even starts.
    const safeSlug = (state.recipeTitle || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    const refDir = join(__dirname, '..', '..', '..', 'output', '_gv-pinterest-cache', `${safeSlug}-${Date.now()}`);
    let pinterestImages = [];
    try {
      pinterestImages = await scrapePinterestImages(this.context, state.recipeTitle, refDir);
    } catch (e) {
      Logger.warn(`[GV-Recipe] Pinterest scrape failed (${e.message}) — proceeding with no visual refs`);
    }
    Logger.info(`[GV-Recipe] ${pinterestImages.length} Pinterest references ready`);
    // Save the absolute paths to state so _ensureChatStarted can re-attach them
    // when opening the Gemini chat for image generation.
    const pinterestRefPaths = pinterestImages.map(p => p.path);
    await StateManager.updateState({ gvPinterestRefs: pinterestRefPaths });

    // ── 2. Build prompt — same wiring as VG (intro/conclusion templates,
    //      structure randomization, related recipes), but enriched with the
    //      gemini-visual preamble (Pinterest refs + web-search instructions). ──
    let templateInstructions = '';
    const introTemplates = settings.introTemplates || [];
    const conclusionTemplates = settings.conclusionTemplates || [];
    const idx = (settings.templateRotationIndex || 0) % Math.max(introTemplates.length, conclusionTemplates.length, 1);

    if (introTemplates.length > 0) {
      const introIdx = idx % introTemplates.length;
      templateInstructions += `\n\nCRITICAL - INTRO REWRITE RULE:\nFor the "intro" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references. No AI cliches.\n\nINTRO TEMPLATE:\n${introTemplates[introIdx]}`;
      Logger.info(`[GV-Recipe] intro template #${introIdx + 1}/${introTemplates.length}`);
    }
    if (conclusionTemplates.length > 0) {
      const concIdx = idx % conclusionTemplates.length;
      templateInstructions += `\n\nCRITICAL - CONCLUSION REWRITE RULE:\nFor the "conclusion" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm.\n\nCONCLUSION TEMPLATE:\n${conclusionTemplates[concIdx]}`;
      Logger.info(`[GV-Recipe] conclusion template #${concIdx + 1}/${conclusionTemplates.length}`);
    }
    if (introTemplates.length > 0 || conclusionTemplates.length > 0) {
      settings.templateRotationIndex = idx + 1;
      await StateManager.saveSettings(settings);
    }

    // Reuse VG's structure-randomization helper (inherited) — same anti-scaled-content signal
    const { instructions: structureInstructions, titles: sectionTitles } = this._buildStructureRandomization();
    templateInstructions += structureInstructions;
    await StateManager.updateState({ sectionTitles });

    // Related recipes for internal linking (best-effort)
    let relatedRecipesBlock = 'No related recipes available — skip internal linking.';
    this._relatedPosts = [];
    try {
      const relatedPosts = await WordPressAPI.listPostsFromAllCategories(settings, 3);
      if (relatedPosts.length > 0) {
        this._relatedPosts = relatedPosts;
        relatedRecipesBlock = relatedPosts
          .map((p, i) => `${i + 1}. [${p.category}] "${p.title}" — ${p.url}${p.excerpt ? ` (${p.excerpt})` : ''}`)
          .join('\n');
        Logger.info(`[GV-Recipe] ${relatedPosts.length} related recipes for internal linking`);
      }
    } catch (e) {
      Logger.warn(`[GV-Recipe] related-recipes fetch failed: ${e.message}`);
    }

    // ── Phase 2 adjustments: pick voice, force transformations-only, why-per-step ──
    const gvSettings = settings.geminiVisual || {};
    const voice = pickVoice(settings, state.recipeTitle);
    Logger.info(`[GV-Recipe] voice for this recipe: "${voice.name}" (id=${voice.id})`);
    const gvMaxSteps = gvSettings.maxSteps || 5;

    // Resolve base template: GV-specific override → VG dashboard custom → built-in default.
    // GV's enhancements (preamble: voice, transformations, why-per-step) are layered on top.
    const baseDescription = describeBaseTemplate(settings);
    Logger.info(`[GV-Recipe] base template source: ${baseDescription.source} (${baseDescription.template.length} chars)`);

    const prompt = buildGVRecipePrompt({
      recipeTitle: state.recipeTitle,
      categories: settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert',
      minSteps: vgSettings.minVisualSteps || defaults.minVisualSteps,
      maxSteps: gvMaxSteps,
      relatedRecipesBlock,
      templateInstructions,
      baseTemplate: baseDescription.template,
      voice,
      transformationsOnly: gvSettings.transformationsOnly !== false, // default true
      whyPerStep: gvSettings.whyPerStep !== false,                   // default true
    });

    // ── 3. Send to Gemini (single-conversation mode — recipe + images in one chat) ──
    // GV is Gemini-only by design: recipe text + all images live in ONE Gemini
    // conversation, so the model "sees" the recipe it just wrote when generating
    // each image. This is what gives us visual fidelity that a two-chat split
    // (e.g. ChatGPT for text + Gemini for images) cannot match.
    const imageRefs = pinterestImages.map(p => p.path);
    Logger.info('[GV-Recipe] AI provider: gemini (single-conversation mode — recipe + images share the same chat)');
    await this.gemini.init();
    let responseText = '';
    try {
      // deepResearch:true activates Outils → "Deep Research" before sending,
      // so Gemini actually browses Food Network / Serious Eats / etc instead
      // of relying on training data. Without this, the prompt's "web search
      // is enabled" instruction is just a suggestion the model can ignore.
      responseText = await this.gemini.startNewChat(prompt, imageRefs, { deepResearch: true });
    } catch (e) {
      throw new Error(`GV-Recipe: Gemini chat failed: ${e.message.split('\n')[0]}`);
    }
    const { Parser } = await import('../../shared/utils/parser.js');
    const parsed = Parser.extractJSON(responseText);
    if (!parsed) {
      throw new Error(`GV-Recipe: Gemini did not return valid JSON. First 300 chars: ${(responseText || '').slice(0, 300)}`);
    }
    const result = { json: parsed, rawText: responseText, citations: [], searchToggle: 'gemini-grounded' };
    // Mark chat as already started — _ensureChatStarted will skip its own intro
    // (image gen continues in this exact same conversation), but it WILL send a
    // short consistency-rules follow-up turn (see _ensureChatStarted below).
    this._chatStarted = true;
    this._chatStartedFor = state.recipeTitle;
    this._consistencyRulesSent = false; // reset per recipe — will be sent before first image
    Logger.info('[GV-Recipe] response parsed (provider=gemini, single-conversation)');

    // ── 4. Parse: same logic as VG's _stepGenerateRecipeJSON ──
    const data = result.json;
    let recipe, rawVisualPlan, rawPins;

    if (data.recipe && data.visual_plan) {
      recipe = data.recipe;
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
    } else if (data.visual_plan) {
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
      recipe = { ...data };
      delete recipe.visual_plan;
      delete recipe.pinterest_pins;
    } else {
      throw new Error('GV-Recipe: response missing visual_plan');
    }

    recipe = sanitizeRecipeJSON(recipe);
    if (!recipe.post_title && recipe.title) recipe.post_title = recipe.title;
    if (!recipe.steps && recipe.instructions) recipe.steps = recipe.instructions;
    if (!recipe.pro_tips && recipe.tips) recipe.pro_tips = recipe.tips;
    if (!recipe.storage_notes && recipe.storage) recipe.storage_notes = recipe.storage;
    if (!recipe.steps || !Array.isArray(recipe.steps)) {
      Logger.error('[GV-Recipe] response keys:', Object.keys(recipe).join(', '));
      throw new Error('GV-Recipe: invalid recipe JSON — missing steps array');
    }

    // ── Step-count contract: recipe.steps and visual_plan.visual_steps MUST be 1:1 ──
    // The post-builder iterates state.steps (which is built from visual_steps).
    // If recipe.steps is longer, those extra cooking instructions never make it to the post.
    // If visual_steps is longer, image gen runs for steps with no description.
    // Throwing here forces a re-prompt so the AI sees the failure rather than us silently dropping content.
    const recipeStepCount = recipe.steps.length;
    const visualStepCount = rawVisualPlan?.visual_steps?.length ?? 0;
    if (recipeStepCount !== visualStepCount) {
      throw new Error(
        `GV-Recipe: step-count mismatch — recipe.steps=${recipeStepCount}, ` +
        `visual_plan.visual_steps=${visualStepCount}. These must be IDENTICAL (1:1 paired by index). ` +
        `Re-run the recipe — the prompt now enforces this invariant explicitly.`
      );
    }
    Logger.info(`[GV-Recipe] step-count contract OK: ${recipeStepCount} recipe steps == ${visualStepCount} visual steps`);

    if (recipe.post_title) {
      recipe.post_title = toTitleCase(recipe.post_title);
      Logger.info(`[GV-Recipe] post_title: "${recipe.post_title}"`);
    }

    // ── 5. Nutrition API (same as VG, optional) ──
    try {
      const accountKeys = await FlowAccountManager.getAllNutritionKeys();
      const nutritionKeys = [...new Set([...accountKeys, settings.nutritionApiKey].filter(Boolean))];
      if (nutritionKeys.length > 0) {
        const nutrition = await fetchNutrition(nutritionKeys, recipe.ingredients || [], recipe.servings || 4);
        if (nutrition) recipe.nutrition = nutrition;
      }
    } catch (e) {
      Logger.warn(`[GV-Recipe] nutrition fetch failed (non-fatal): ${e.message}`);
    }

    const visualPlan = validateVisualPlan(rawVisualPlan, vgSettings);

    // Build steps array (merge recipe step text + visual plan + SEO) — same as VG
    const recipeSteps = recipe.steps || [];
    const steps = visualPlan.visual_steps.map((vs, i) => {
      const recipeStep = recipeSteps[i] || {};
      const stepSeo = recipeStep.seo || {};
      return {
        number: vs.step_id || i + 1,
        title: recipeStep.title || vs.title || `Step ${i + 1}`,
        description: recipeStep.description || vs.food_state || '',
        tip: recipeStep.tip || '',
        prompt: '',
        seo: {
          filename: stepSeo.filename || FILENAMES.stepDefault(i),
          alt_text: stepSeo.alt_text || recipeStep.title || vs.title || `Step ${i + 1}`,
        },
        base64: null, wpImageId: null, wpImageUrl: null,
      };
    });

    const pinterestPins = (rawPins || []).map((pin, i) => ({
      title: pin.title || `Pin ${i + 1}`,
      description: pin.description || '',
      image_prompt: pin.image_prompt || pin.prompt || '',
      base64: null, wpImageId: null, wpImageUrl: null,
    }));

    await StateManager.updateState({
      status: STATES.CREATING_FOLDERS,
      recipeJSON: recipe,
      visualPlan,
      steps,
      currentStepIndex: 0,
      pinterestPins,
      _relatedPosts: this._relatedPosts || [],
      seoData: {
        post_title: recipe.post_title || state.recipeTitle,
        slug: recipe.slug || '',
        focus_keyword: recipe.focus_keyword || '',
        meta_title: recipe.meta_title || '',
        meta_description: recipe.meta_description || '',
      },
    });

    const nextIntroIdx = ((settings.introRotationIndex || 0) + 1) % (settings.introRotationTotal || 12);
    const currentVoiceIdx = settings.geminiVisual?.voiceRotationIndex || 0;
    const nextVoiceIdx = (currentVoiceIdx + 1) % GV_VOICES.length;
    await StateManager.saveSettings({
      introRotationIndex: nextIntroIdx,
      geminiVisual: {
        ...(settings.geminiVisual || {}),
        voiceRotationIndex: nextVoiceIdx,
      },
    });

    VGStats.chatgptEnd(steps.length);
    Logger.success(`[GV-Recipe] generated: ${steps.length} steps, ${pinterestPins.length} pins, ${pinterestImages.length} Pinterest refs, voice="${voice.name}"`);
  }
}
