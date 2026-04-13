/**
 * VerifiedGeneratorOrchestrator — AI-verified image generation workflow
 *
 * New module that extends BaseOrchestrator with:
 * 1. ChatGPT pass 2: structured visual production plan (4-8 steps)
 * 2. Structured JSON prompts → Flow image generation
 * 3. Gemini vision verification after each image
 * 4. Correction retry loop (max retries configurable)
 *
 * Does NOT modify generator or scraper modules.
 */

import { BaseOrchestrator, sanitizeRecipeJSON, FILENAMES } from '../base-orchestrator.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { Logger } from '../../shared/utils/logger.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { buildVisualPlanPrompt, validateVisualPlan } from './visual-planner.js';
import { buildStepPrompt, buildIngredientsPrompt, buildHeroPrompt, buildCorrectionPrompt } from './prompt-builder.js';
import { verifyStepImage, verifyIngredientsImage, verifyHeroImage, verifyPinterestImage, checkStepSimilarity, shouldRetry } from './image-verifier.js';
import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';
import { VGStats } from './vg-stats.js';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class VerifiedGeneratorOrchestrator extends BaseOrchestrator {
  constructor(browser, context, serverCtx) {
    super(browser, context, serverCtx);
  }

  /**
   * Get verifiedGenerator settings merged with defaults.
   */
  _getVGSettings(settings) {
    const vg = settings?.verifiedGenerator || {};
    const defaults = VERIFIED_GENERATOR_DEFAULTS;
    return {
      ...defaults,
      ...vg,
      prompts: { ...defaults.prompts, ...(vg.prompts || {}) }
    };
  }

  /**
   * Get a Gemini API key — rotates across all accounts' keys to distribute rate limits.
   */
  async _getGeminiApiKey() {
    // Get all available keys
    if (!this._geminiKeys) {
      this._geminiKeys = await FlowAccountManager.getAllGeminiKeys();
      this._geminiKeyIndex = 0;
    }

    if (this._geminiKeys.length === 0) {
      // Fallback to active account
      const key = await FlowAccountManager.getActiveGeminiKey();
      if (!key) Logger.warn('[VerifiedGen] No Gemini API key configured — skipping verification');
      return key;
    }

    // Round-robin through keys
    const key = this._geminiKeys[this._geminiKeyIndex % this._geminiKeys.length];
    this._geminiKeyIndex++;
    return key;
  }

  /**
   * Generate an image with Flow, verify with Gemini, retry on failure.
   * If retry generation fails (Flow download error), falls back to best previous image.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Flow prompt
   * @param {string} opts.backgroundPath - background image path
   * @param {string[]} opts.contextPaths - context image paths
   * @param {string} opts.aspectRatio - aspect ratio
   * @param {string} opts.outputPath - where to save image
   * @param {boolean} opts.isFirstImage - for rate limit handling
   * @param {boolean} opts.skipSimilarityCheck - for Pinterest pins
   * @param {Function} opts.verifyFn - async (outputPath) => verifier result
   * @param {Function} opts.correctionFn - (verifierResult) => correction prompt string
   * @param {string} opts.label - for logging (e.g. "Ingredients", "Step 3")
   * @param {string} opts.imageType - for stats ('ingredients', 'step', 'hero', 'pin')
   * @param {number} opts.stepNumber - step number for stats
   * @param {object} opts.vgSettings - verified generator settings
   */
  async _generateAndVerify(opts) {
    const {
      prompt, backgroundPath, contextPaths = [], aspectRatio, outputPath,
      isFirstImage = false, skipSimilarityCheck = false,
      verifyFn, correctionFn, label, vgSettings, imageType = '', stepNumber = 0,
      // Similarity check options
      prevImagePath = null, prevStepNum = 0, currentStepNum = 0, expectedChange = ''
    } = opts;

    const geminiKey = await this._getGeminiApiKey();
    const maxRetries = vgSettings?.maxVerificationRetries || 3;
    let bestImage = null;
    let bestIssueCount = Infinity;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Build prompt: original on first attempt, with correction on retries
      let currentPrompt = prompt;
      if (attempt > 0 && correctionFn && this._lastVerifyResult) {
        currentPrompt = prompt + '\n\n' + correctionFn(this._lastVerifyResult);
      }

      // Try to generate — if retry fails (Flow download error), fall back to best image
      try {
        // Close session before retry to get a fresh project
        if (attempt > 0) {
          try { await this.flow.closeSession(); } catch {}
        }

        const ok = await this._generateWithRateLimitRetry(() =>
          this.flow.generate(currentPrompt, backgroundPath, contextPaths, aspectRatio, outputPath, { skipSimilarityCheck })
        , isFirstImage && attempt === 0);

        if (!ok) throw new Error(`${label} image generation failed`);
        await this._trackFlowGeneration();
      } catch (genErr) {
        if (attempt === 0) throw genErr; // First attempt must succeed

        // Retry failed — use best previous image
        Logger.warn(`[VerifiedGen] ${label} retry ${attempt} generation failed: ${genErr.message}`);
        if (bestImage) {
          Logger.info(`[VerifiedGen] ${label}: falling back to best previous image`);
          writeFileSync(outputPath, bestImage);
        }
        break; // Accept what we have
      }

      // Save current image as potential best (ALWAYS, even before verification)
      const currentImage = readFileSync(outputPath);
      if (!bestImage) {
        bestImage = currentImage;
        bestIssueCount = 0;
      }

      // Skip verification if no Gemini key
      if (!geminiKey) {
        Logger.info(`[VerifiedGen] No Gemini key — skipping ${label} verification`);
        break;
      }

      // Verify ingredients/state
      this._lastVerifyResult = await verifyFn(outputPath);
      const { shouldRetry: retry, reason } = shouldRetry(this._lastVerifyResult, vgSettings?.softFailAction);

      if (!retry) {
        if (this._lastVerifyResult.status !== 'PASS') {
          Logger.warn(`[VerifiedGen] ${label} accepted with issues: ${reason}`);
        }

        // Similarity check: compare with previous step
        // Skip if verify was a safety PASS (Gemini was down — no point trying similarity too)
        const wasRealVerify = this._lastVerifyResult && !this._lastVerifyResult.issues?.some(i => i.includes('Verification skipped'));
        if (prevImagePath && geminiKey && existsSync(prevImagePath) && wasRealVerify) {
          // Wait 20s before similarity call to respect Gemini rate limit (20 req/min)
          await new Promise(r => setTimeout(r, 20000));
          const simResult = await checkStepSimilarity(
            geminiKey, prevImagePath, outputPath,
            prevStepNum, currentStepNum, expectedChange, vgSettings
          );

          if (simResult.verdict === 'TOO_SIMILAR' && attempt < maxRetries - 1) {
            Logger.warn(`[VerifiedGen] ${label} TOO SIMILAR to previous step (score: ${simResult.similarity_score}) — regenerating`);
            // Build differentiation prompt from missing changes
            const diffPrompt = (simResult.missing_changes || []).map(c => `- ${c}`).join('\n');
            this._lastVerifyResult = {
              status: 'HARD_FAIL',
              issues: [`Too similar to previous step. Required changes: ${diffPrompt || 'make visually distinct'}`],
              forbidden_found: [], container_count: 1, state_match: true
            };
            bestImage = currentImage;
            bestIssueCount = 1;
            continue; // retry with correction
          } else if (simResult.verdict === 'TOO_SIMILAR') {
            Logger.warn(`[VerifiedGen] ${label} similar but max retries reached — accepting`);
          }
        }

        break;
      }

      // Track best attempt (fewer issues = better)
      const issueCount = (this._lastVerifyResult.issues?.length || 0) +
        (this._lastVerifyResult.forbidden_found?.length || 0) +
        (this._lastVerifyResult.missing_ingredients?.length || 0) +
        (this._lastVerifyResult.extra_items?.length || 0);

      if (issueCount < bestIssueCount) {
        bestIssueCount = issueCount;
        bestImage = currentImage;
      }

      Logger.warn(`[VerifiedGen] ${label} attempt ${attempt + 1}/${maxRetries} FAILED: ${reason}`);

      if (attempt === maxRetries - 1) {
        Logger.warn(`[VerifiedGen] ${label}: max retries reached — accepting best attempt`);
        if (bestImage) writeFileSync(outputPath, bestImage);
      }
    }

    // Track stats
    VGStats.trackImage({
      type: imageType || label.toLowerCase().replace(/\s+\d+$/, ''),
      stepNumber,
      title: label,
      flowStarted: Date.now(),
      flowDuration: 0,
      geminiStatus: this._lastVerifyResult?.status || 'skipped',
      retries: bestIssueCount < Infinity ? 1 : 0,
      similarityScore: null,
      similarityVerdict: null,
      issues: this._lastVerifyResult?.issues || []
    });
  }

  get _stepHandlers() {
    return {
      ...this._sharedHandlers,
      [STATES.LOADING_JOB]: () => this._stepLoadJob(),
      [STATES.GENERATING_RECIPE_JSON]: () => this._stepGenerateRecipeJSON(),
      // Override image generation steps with verified versions
      [STATES.COMPLETED]: async () => {
        // Track recipe completion before base cleanup
        const st = await StateManager.getState();
        await VGStats.complete(st.draftUrl);
        // Call base COMPLETED handler
        await this._sharedHandlers[STATES.COMPLETED]();
      },
      [STATES.GENERATING_INGREDIENTS]: () => this._stepVerifiedIngredients(),
      [STATES.GENERATING_STEPS]: () => this._stepVerifiedStep(),
      [STATES.GENERATING_HERO]: () => this._stepVerifiedHero(),
      [STATES.GENERATING_PINS]: () => this._stepVerifiedPins(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // STEP: LOAD JOB (same as generator)
  // ═══════════════════════════════════════════════════════

  async _stepLoadJob() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    if (!settings.sheetId) throw new Error('Google Sheet ID not configured.');

    const sheetSettings = {
      ...settings,
      sheetTabName: settings.verifiedGenSheetTab || settings.generatorSheetTab || settings.sheetTabName || 'single post',
      topicColumn: settings.verifiedGenTopicColumn || settings.generatorTopicColumn || settings.topicColumn || 'A',
      statusColumn: settings.verifiedGenStatusColumn || settings.generatorStatusColumn || settings.statusColumn || 'B',
      startRow: settings.verifiedGenStartRow || settings.generatorStartRow || settings.startRow || 2
    };

    let pending;

    if (state.batchMode && state.batchQueue?.length > 0) {
      const idx = state.batchCurrentIndex || 0;
      if (idx >= state.batchQueue.length) {
        Logger.info('Batch queue exhausted — all done!');
        await StateManager.updateState({ status: STATES.IDLE });
        return;
      }
      pending = state.batchQueue[idx];
      Logger.step('LoadJob', `Batch ${idx + 1}/${state.batchQueue.length}: "${pending.topic}" (row ${pending.rowIndex})`);
    } else {
      Logger.step('LoadJob', 'Reading Google Sheet...');
      pending = await SheetsAPI.findPendingRow(sheetSettings);
      if (!pending) {
        Logger.info('No more pending rows — all done!');
        await StateManager.updateState({ status: STATES.IDLE });
        return;
      }
    }

    try {
      await SheetsAPI.markProcessing(sheetSettings, pending.rowIndex);
    } catch (e) {
      Logger.warn(`Failed to mark row as processing: ${e.message}`);
    }

    await StateManager.updateState({
      status: STATES.SELECTING_BACKGROUND,
      recipeTitle: pending.topic,
      sheetRowIndex: pending.rowIndex,
      sheetSettings: {
        sheetTabName: sheetSettings.sheetTabName,
        statusColumn: sheetSettings.statusColumn
      }
    });
    VGStats.startRecipe(pending.topic);
    Logger.success(`Found recipe: "${pending.topic}" (row ${pending.rowIndex})`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE RECIPE JSON + VISUAL PLAN (single prompt)
  // ═══════════════════════════════════════════════════════

  async _stepGenerateRecipeJSON() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const defaults = VERIFIED_GENERATOR_DEFAULTS;

    VGStats.chatgptStart();
    Logger.step('ChatGPT', `Generating recipe + visual plan for: ${state.recipeTitle}`);

    // Use verified generator's own ChatGPT URL if set, else fall back to generator's
    const gptUrl = vgSettings.chatGptUrl || settings.generatorGptUrl || null;
    const isCustomGpt = gptUrl && !gptUrl.match(/^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/?$/);
    await this.chatgpt.init(isCustomGpt ? gptUrl : null);

    // ── Build prompt from VG's own template ──
    const template = vgSettings.prompts?.recipeVisualPlan || defaults.prompts.recipeVisualPlan;

    // Build intro/conclusion template instructions
    let templateInstructions = '';
    const introTemplates = settings.introTemplates || [];
    const conclusionTemplates = settings.conclusionTemplates || [];
    const idx = (settings.templateRotationIndex || 0) % Math.max(introTemplates.length, conclusionTemplates.length, 1);

    if (introTemplates.length > 0) {
      const introIdx = idx % introTemplates.length;
      templateInstructions += `\n\nCRITICAL - INTRO REWRITE RULE:\nFor the "intro" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references. No AI cliches.\n\nINTRO TEMPLATE:\n${introTemplates[introIdx]}`;
      Logger.info(`Using intro template #${introIdx + 1}/${introTemplates.length}`);
    }

    if (conclusionTemplates.length > 0) {
      const concIdx = idx % conclusionTemplates.length;
      templateInstructions += `\n\nCRITICAL - CONCLUSION REWRITE RULE:\nFor the "conclusion" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm.\n\nCONCLUSION TEMPLATE:\n${conclusionTemplates[concIdx]}`;
      Logger.info(`Using conclusion template #${concIdx + 1}/${conclusionTemplates.length}`);
    }

    if (introTemplates.length > 0 || conclusionTemplates.length > 0) {
      settings.templateRotationIndex = idx + 1;
      await StateManager.saveSettings(settings);
    }

    // Fill placeholders in the VG prompt template
    const prompt = template
      .replace(/\{\{topic\}\}/g, state.recipeTitle)
      .replace(/\{\{categories\}\}/g, settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert')
      .replace(/\{\{min_steps\}\}/g, String(vgSettings.minVisualSteps || defaults.minVisualSteps))
      .replace(/\{\{max_steps\}\}/g, String(vgSettings.maxVisualSteps || defaults.maxVisualSteps))
      .replace(/\{\{default_camera_angle\}\}/g, vgSettings.defaultCameraAngle || defaults.defaultCameraAngle)
      .replace(/\{\{template_instructions\}\}/g, templateInstructions);

    const response = await this.chatgpt.sendPromptAndGetResponse(prompt, true);
    if (!response.success) throw new Error(`ChatGPT failed: ${response.error}`);

    // ── Parse the response: clear separation between recipe, visual_plan, pinterest_pins ──
    const data = response.data;

    // Extract recipe (may be nested under "recipe" key or at top level)
    let recipe, rawVisualPlan, rawPins;

    if (data.recipe && data.visual_plan) {
      // Clean structure: { recipe: {...}, visual_plan: {...}, pinterest_pins: [...] }
      recipe = data.recipe;
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
      Logger.info('[VerifiedGen] Parsed clean structure: recipe + visual_plan + pinterest_pins');
    } else if (data.visual_plan) {
      // Flat structure: recipe fields at top level + visual_plan key
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
      recipe = { ...data };
      delete recipe.visual_plan;
      delete recipe.pinterest_pins;
      Logger.info('[VerifiedGen] Parsed flat structure: extracted visual_plan from recipe');
    } else {
      throw new Error('ChatGPT response missing visual_plan — make sure the prompt asks for it');
    }

    recipe = sanitizeRecipeJSON(recipe);
    if (!recipe.post_title && recipe.title) recipe.post_title = recipe.title;
    if (!recipe.steps && recipe.instructions) recipe.steps = recipe.instructions;
    if (!recipe.pro_tips && recipe.tips) recipe.pro_tips = recipe.tips;
    if (!recipe.storage_notes && recipe.storage) recipe.storage_notes = recipe.storage;
    if (!recipe.steps || !Array.isArray(recipe.steps)) {
      Logger.error('ChatGPT returned keys:', Object.keys(recipe).join(', '));
      throw new Error('Invalid recipe JSON: missing steps array.');
    }

    const visualPlan = validateVisualPlan(rawVisualPlan, vgSettings);

    // Normalize ingredients format (support both array of strings and array of objects)
    if (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0 && typeof recipe.ingredients[0] === 'object') {
      // New format: {name, quantity, description} — keep as-is, post-builder handles both
    }

    // Build steps array: merge recipe step descriptions + visual plan titles + SEO
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
          alt_text: stepSeo.alt_text || recipeStep.title || vs.title || `Step ${i + 1}`
        },
        base64: null, wpImageId: null, wpImageUrl: null
      };
    });

    // Normalize pinterest_pins
    const pinterestPins = (rawPins || []).map((pin, i) => ({
      title: pin.title || `Pin ${i + 1}`,
      description: pin.description || '',
      image_prompt: pin.image_prompt || pin.prompt || '',
      base64: null, wpImageId: null, wpImageUrl: null
    }));

    await StateManager.updateState({
      status: STATES.CREATING_FOLDERS,
      recipeJSON: recipe,
      visualPlan,
      steps,
      currentStepIndex: 0,
      pinterestPins,
      seoData: {
        post_title: recipe.post_title || state.recipeTitle,
        slug: recipe.slug || '',
        focus_keyword: recipe.focus_keyword || '',
        meta_title: recipe.meta_title || '',
        meta_description: recipe.meta_description || ''
      }
    });

    // Advance intro rotation
    const nextIndex = ((settings.introRotationIndex || 0) + 1) % (settings.introRotationTotal || 12);
    await StateManager.saveSettings({ introRotationIndex: nextIndex });

    VGStats.chatgptEnd(steps.length);
    Logger.success(`Recipe + visual plan generated: ${steps.length} visual steps, ${pinterestPins.length} pins`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED INGREDIENTS IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedIngredients() {
    const state = await StateManager.getState();
    if (state.ingredientsImage?.base64) {
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const ingredientsState = state.visualPlan?.ingredients_image;

    if (!ingredientsState) throw new Error('No ingredients_image in visual plan');

    Logger.step('Flow', 'Generating verified ingredients image...');

    await this._ensureProModelForNewRecipe();

    const prompt = buildIngredientsPrompt(ingredientsState, vgSettings);

    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, FILENAMES.ingredients);

    await this._generateAndVerify({
      prompt, backgroundPath, contextPaths: [],
      aspectRatio: settings.ingredientAspectRatio || 'PORTRAIT',
      outputPath, isFirstImage: true, label: 'Ingredients', imageType: 'ingredients', vgSettings,
      verifyFn: async (path) => verifyIngredientsImage(await this._getGeminiApiKey(), path, ingredientsState, vgSettings),
      correctionFn: (result) => buildCorrectionPrompt(ingredientsState, result, vgSettings)
    });

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('ingredients', imgBuf.toString('base64'));
    await StateManager.updateState({
      status: STATES.GENERATING_STEPS,
      currentStepIndex: 0,
      ingredientsImage: { base64: true },
      backgroundQueueIndex: bgIndex + 1
    });
    Logger.success('Ingredients image generated (verified)');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED STEP IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedStep() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const idx = state.currentStepIndex;
    const step = state.steps[idx];
    const visualStep = state.visualPlan?.visual_steps?.[idx];

    if (step.base64) { await this._advanceStep(); return; }
    if (!visualStep) throw new Error(`No visual state for step ${idx + 1}`);

    Logger.step('Flow', `Step ${idx + 1}/${state.steps.length}: ${visualStep.title}`);

    // Build prompt from structured state
    const prompt = buildStepPrompt(visualStep, vgSettings);

    // Background
    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];

    // Output path
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, step.seo?.filename || FILENAMES.stepDefault(idx));

    // Context: always use last step image for visual consistency
    const contextPaths = [];
    if (idx > 0) {
      const prevPath = join(outputDir, state.steps[idx - 1]?.seo?.filename || FILENAMES.stepDefault(idx - 1));
      if (existsSync(prevPath)) {
        contextPaths.push(prevPath);
      }
    }

    // Similarity check: compare with previous step image
    let prevImagePath = null;
    if (idx > 0) {
      const prevPath = join(outputDir, state.steps[idx - 1]?.seo?.filename || FILENAMES.stepDefault(idx - 1));
      if (existsSync(prevPath)) prevImagePath = prevPath;
    }

    await this._generateAndVerify({
      prompt, backgroundPath, contextPaths,
      aspectRatio: settings.stepAspectRatio || 'PORTRAIT',
      outputPath, label: `Step ${idx + 1}`, imageType: 'step', stepNumber: idx + 1, vgSettings,
      verifyFn: async (path) => verifyStepImage(await this._getGeminiApiKey(), path, visualStep, vgSettings),
      correctionFn: (result) => buildCorrectionPrompt(visualStep, result, vgSettings),
      // Similarity detection
      prevImagePath,
      prevStepNum: idx,
      currentStepNum: idx + 1,
      expectedChange: visualStep.food_state || visualStep.title || ''
    });

    // Store as base64 for WordPress upload
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`step_${idx}`, imgBuf.toString('base64'));

    const steps = [...state.steps];
    steps[idx] = { ...steps[idx], base64: true };
    await StateManager.updateState({ steps, backgroundQueueIndex: bgIndex + 1 });
    Logger.success(`Step ${idx + 1} image generated (verified)`);
    await this._advanceStep();
  }

  async _advanceStep() {
    const state = await StateManager.getState();
    const next = state.currentStepIndex + 1;
    if (next < state.steps.length) {
      await StateManager.updateState({ currentStepIndex: next });
    } else {
      await StateManager.updateState({ status: STATES.GENERATING_HERO });
      Logger.success('All step images generated!');
    }
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED HERO IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedHero() {
    const state = await StateManager.getState();
    if (state.heroImage?.base64) {
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }

    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const heroState = state.visualPlan?.hero_image;

    if (!heroState) throw new Error('No hero_image in visual plan');

    Logger.step('Flow', 'Generating verified hero image...');

    // Build prompt from structured state
    const prompt = buildHeroPrompt(heroState, vgSettings);

    // Write hero background to temp file
    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const heroTmpPath = join(tmpDir, FILENAMES.heroBgTemp);
    if (!state.selectedHeroBackground?.base64) {
      throw new Error('Hero background image not loaded — re-run from start');
    }
    try {
      writeFileSync(heroTmpPath, Buffer.from(state.selectedHeroBackground.base64, 'base64'));
    } catch (e) {
      Logger.warn('Hero bg write failed, retrying with fresh path...');
      const altPath = join(tmpDir, 'hero_bg_alt.jpg');
      writeFileSync(altPath, Buffer.from(state.selectedHeroBackground.base64, 'base64'));
    }

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.hero_seo?.filename || FILENAMES.hero);

    // Context: all verified step images
    const contextPaths = this._collectStepContextPaths(state.steps, outputDir, state.steps.length);

    await this._generateAndVerify({
      prompt, backgroundPath: heroTmpPath, contextPaths,
      aspectRatio: settings.heroAspectRatio || 'LANDSCAPE',
      outputPath, label: 'Hero', imageType: 'hero', vgSettings,
      verifyFn: async (path) => verifyHeroImage(await this._getGeminiApiKey(), path, heroState, vgSettings),
      correctionFn: (result) => buildCorrectionPrompt(heroState, result, vgSettings)
    });

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('hero', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.SAVING_FILES, heroImage: { base64: true } });
    Logger.success('Hero image generated (verified)');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED PINTEREST PINS
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedPins() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const pins = state.pinterestPins || [];

    if (!pins.length) {
      Logger.info('No Pinterest pins to generate — skipping');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const pendingIdx = pins.findIndex(p => !p.base64);
    if (pendingIdx === -1) {
      Logger.success('All Pinterest pin images already generated');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const pin = pins[pendingIdx];
    Logger.step('Flow', `Pinterest pin ${pendingIdx + 1}/${pins.length}: ${pin.title}`);

    // Fresh project for each pin
    Logger.info(`[Pinterest] Closing Flow session — fresh project for pin ${pendingIdx + 1}`);
    try { await this.flow.closeSession(); } catch {}

    // Pick template
    const isScraper = settings.mode === 'scrape';
    const templateFolder = isScraper
      ? settings.pinterestTemplateFolderScraper
      : settings.pinterestTemplateFolderGenerator;

    if (!templateFolder || !existsSync(templateFolder)) {
      Logger.warn(`Pinterest template folder not configured or missing. Skipping pins.`);
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const templateImages = StateManager.listImagesInFolder(templateFolder);
    if (!templateImages.length) {
      throw new Error(`No template images found in: ${templateFolder}`);
    }

    const templatePath = templateImages[pendingIdx % templateImages.length];
    Logger.info(`Using template: ${basename(templatePath)}`);

    // Context: hero + last step
    const contextPaths = [];
    const outputDir = this._getOutputDir(state, settings);
    const heroFilename = state.recipeJSON?.hero_seo?.filename || FILENAMES.hero;
    const heroPath = join(outputDir, heroFilename);
    if (existsSync(heroPath)) contextPaths.push(heroPath);

    if (state.steps?.length > 0) {
      const lastStep = state.steps[state.steps.length - 1];
      const lastStepPath = join(outputDir, lastStep.seo?.filename || FILENAMES.stepDefault(state.steps.length - 1));
      if (existsSync(lastStepPath)) contextPaths.push(lastStepPath);
    }

    // Build prompt from VG's own Pinterest template
    const defaults = VERIFIED_GENERATOR_DEFAULTS;
    const recipeTitle = state.recipeJSON?.post_title || state.recipeTitle || '';
    const websiteUrl = settings.wpUrl || '';
    const websiteDomain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const pinterestTemplate = vgSettings.prompts?.pinterest || defaults.prompts.pinterest;
    const prompt = pinterestTemplate
      .replace(/\{\{pin_title\}\}/g, pin.title || recipeTitle)
      .replace(/\{\{pin_description\}\}/g, pin.description || '')
      .replace(/\{\{recipe_title\}\}/g, recipeTitle)
      .replace(/\{\{website\}\}/g, websiteDomain);

    const pinFilename = `pin-${pendingIdx + 1}.jpg`;
    const outputPath = join(outputDir, pinFilename);

    await this._generateAndVerify({
      prompt, backgroundPath: templatePath, contextPaths,
      aspectRatio: settings.pinterestAspectRatio || 'PORTRAIT',
      outputPath, skipSimilarityCheck: true,
      label: `Pin ${pendingIdx + 1}`, imageType: 'pin', stepNumber: pendingIdx + 1, vgSettings,
      verifyFn: async (path) => verifyPinterestImage(await this._getGeminiApiKey(), path, recipeTitle, vgSettings),
      correctionFn: null // No correction for pins — just retry with same prompt
    });

    // Store image data
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`pin_${pendingIdx}`, imgBuf.toString('base64'));

    const updatedPins = [...pins];
    updatedPins[pendingIdx] = { ...updatedPins[pendingIdx], base64: true };
    await StateManager.updateState({ pinterestPins: updatedPins });
    Logger.success(`Pinterest pin ${pendingIdx + 1} image generated (verified)`);
  }
}
