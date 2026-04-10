/**
 * BaseOrchestrator — shared workflow steps for both generator and scraper modes
 *
 * Contains all steps that are common to both workflows:
 * - Background selection
 * - Folder creation
 * - Step/ingredients/hero image generation
 * - File saving, media upload, draft publishing, sheet update
 *
 * Subclasses (GeneratorOrchestrator, ScraperOrchestrator) extend this
 * with mode-specific steps (e.g. _stepLoadJob, _stepGenerateRecipeJSON).
 */

import { StateManager, STATES } from '../shared/utils/state-manager.js';
import { SheetsAPI } from '../shared/utils/sheets-api.js';
import { WordPressAPI } from '../shared/utils/wordpress-api.js';
import { Logger } from '../shared/utils/logger.js';
import { ChatGPTPage } from '../shared/pages/chatgpt.js';
import { FlowPage, FlowRateLimitError, FlowAccountBlockedError } from '../shared/pages/flow.js';
import {
  buildStyleDirective,
  buildIngredientSuffix, buildStepSuffix, buildHeroSuffix,
} from '../shared/utils/prompts.js';
import { FlowAccountManager } from '../shared/utils/flow-account-manager.js';
import { buildAndPublishPost } from './post-builder.js';
import { saveFiles, uploadMedia, updateSheet } from './save-upload.js';
import { writeFile, mkdir } from 'fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Default filenames (no more magic strings) ────────────────────────
export const FILENAMES = {
  heroBackground:  'background-hero.jpg',
  stepsBackground: 'background-steps.jpg',
  hero:            'hero.jpg',
  ingredients:     'ingredients.jpg',
  heroBgTemp:      'hero-bg.jpg',
  recipeJSON:      'recipe.json',
  stepDefault:     (i) => `step-${i + 1}.jpg`,
  fallbackBg:      (i) => `fallback-bg-${i}.jpg`,
};

// ── Shared helpers ───────────────────────────────────────────────────

/** Strip characters that are illegal in Windows paths, normalize accents, collapse whitespace. */
export function sanitizeFilename(s) {
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove accents (ê→e, é→e, ü→u)
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// AI text sanitizer
export const AI_BANNED_WORDS = /\b(delve|elevate|embark|tapestry|vibrant|bustling|landscape|realm|facilitate|leverage|encompass|robust|streamline|utilize|furthermore|moreover|additionally|consequently|noteworthy|arguably|undeniably|game-changer|mouthwatering|culinary journey|flavor profile|taste buds|take it to the next level|without further ado|let's dive in)\b/gi;

export function sanitizeAIText(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  result = result.replace(/\s*—\s*/g, ', ');
  result = result.replace(/\s*–\s*/g, ', ');
  result = result.replace(/;\s*/g, '. ');
  result = result.replace(AI_BANNED_WORDS, '');
  result = result.replace(/,\s*,/g, ',');
  result = result.replace(/\.\s*\./g, '.');
  result = result.replace(/\s{2,}/g, ' ');
  return result.trim();
}

export function sanitizeRecipeJSON(recipe) {
  if (!recipe) return recipe;
  if (recipe.intro) recipe.intro = sanitizeAIText(recipe.intro);
  if (recipe.conclusion) recipe.conclusion = sanitizeAIText(recipe.conclusion);
  if (recipe.meta_description) recipe.meta_description = sanitizeAIText(recipe.meta_description);
  // Normalize field names: ChatGPT may return "tips" or "pro_tips", "storage" or "storage_notes"
  if (!recipe.pro_tips && recipe.tips) recipe.pro_tips = recipe.tips;
  if (!recipe.storage_notes && recipe.storage) recipe.storage_notes = recipe.storage;
  if (!recipe.fun_fact && recipe.funFact) recipe.fun_fact = recipe.funFact;
  if (recipe.pro_tips) recipe.pro_tips = recipe.pro_tips.map(t => sanitizeAIText(t));
  if (recipe.variations) recipe.variations = recipe.variations.map(v => sanitizeAIText(v));
  if (recipe.storage_notes) recipe.storage_notes = sanitizeAIText(recipe.storage_notes);
  if (recipe.serving_suggestions) recipe.serving_suggestions = sanitizeAIText(recipe.serving_suggestions);
  if (recipe.make_ahead) recipe.make_ahead = sanitizeAIText(recipe.make_ahead);
  if (recipe.steps) {
    recipe.steps.forEach(step => {
      if (step.title) step.title = sanitizeAIText(step.title);
      if (step.description) step.description = sanitizeAIText(step.description);
      if (step.tip) step.tip = sanitizeAIText(step.tip);
    });
  }
  return recipe;
}

export class BaseOrchestrator {
  constructor(browser, context, serverCtx) {
    this.browser = browser;
    this.context = context;
    this.serverCtx = serverCtx; // Global server ctx with launchBrowserWithProfile
    this.chatgpt = new ChatGPTPage(browser, context);
    this.flow = new FlowPage(browser, context);
    this._running = false;
    this._paused = false;
    this._needsAccountRotation = false;

  }

  /**
   * Track a successful Flow image generation (increment counter for stats).
   */
  async _trackFlowGeneration() {
    const multiAccount = await FlowAccountManager.isEnabled();
    if (!multiAccount) return;
    await FlowAccountManager.incrementCount();
  }

  /**
   * Flag current account as rate-limited and rotate to the next one.
   * Returns true if rotation succeeded, throws if no accounts left.
   */
  async _rotateToNextAccount() {
    const multiAccount = await FlowAccountManager.isEnabled();
    if (!multiAccount) {
      throw new Error('Flow rate limit hit but multi-account is not enabled. Add more Flow accounts to continue.');
    }

    // Flag current account
    await FlowAccountManager.flagRateLimited();

    const next = await FlowAccountManager.rotate();
    if (next) {
      Logger.info(`[FlowAccounts] Rotating to account "${next.name}" with Nano Banana Pro`);
      try { await this.flow.closeSession(); } catch {}
      await StateManager.updateState({ flowAccountRotationNeeded: true });
  
      return true;
    }

    throw new Error('All Flow accounts are rate-limited. Try again later or add more accounts.');
  }

  /**
   * Handle rate-limit during generation.
   *
   * - FIRST IMAGE (isFirstImage=true): rotate to next account immediately (Nano Banana Pro)
   * - MIDDLE OF RECIPE (isFirstImage=false): switch to Nano Banana 2 to finish recipe,
   *   flag account as rate-limited, rotate after recipe completes
   */
  async _generateWithRateLimitRetry(generateFn, isFirstImage = false) {
    try {
      return await generateFn();
    } catch (err) {
      // ── ACCOUNT BLOCKED: skip recipe immediately ──
      if (err instanceof FlowAccountBlockedError) {
        Logger.error('[Flow] Account BLOCKED (unusual activity) — flagging and skipping recipe');
        await FlowAccountManager.flagRateLimited();
        // Re-throw as a regular error so the recipe fails and batch continues
        throw new Error('Flow account blocked (unusual activity) — recipe skipped. Account flagged for rotation.');
      }

      if (!(err instanceof FlowRateLimitError)) throw err;

      // ── FIRST IMAGE: rotate account immediately ──
      if (isFirstImage) {
        Logger.warn('[Flow] Rate limited on first image — rotating to next account...');
        await this._rotateToNextAccount();
        await this._ensureBrowserForAccount();
        this.flow.preferredModel = 'Nano Banana Pro';
        return await generateFn();
      }

      // ── MIDDLE OF RECIPE: switch to fallback model to finish ──
      const FALLBACK_MODELS = ['Nano Banana 2', 'Imagen 4'];

      for (const model of FALLBACK_MODELS) {
        Logger.info(`[Flow] Rate limited mid-recipe — trying "${model}" to finish...`);
        this.flow.preferredModel = model;

        try {
          const result = await generateFn();
          this._needsAccountRotation = true;
          await FlowAccountManager.flagRateLimited();
          Logger.info(`[Flow] Continuing with "${model}" — will rotate account after this recipe`);
          return result;
        } catch (retryErr) {
          // Account blocked mid-recipe: skip
          if (retryErr instanceof FlowAccountBlockedError) {
            Logger.error('[Flow] Account BLOCKED mid-recipe — flagging and skipping');
            await FlowAccountManager.flagRateLimited();
            throw new Error('Flow account blocked (unusual activity) — recipe skipped.');
          }
          if (!(retryErr instanceof FlowRateLimitError)) throw retryErr;
          Logger.warn(`[Flow] "${model}" also rate-limited...`);
        }
      }

      // All models exhausted — rotate account as last resort
      Logger.warn('[Flow] All models rate-limited mid-recipe — rotating account...');
      await this._rotateToNextAccount();
      await this._ensureBrowserForAccount();
      this.flow.preferredModel = 'Nano Banana Pro';
      return await generateFn();
    }
  }

  /**
   * Called at the start of every recipe.
   * ALWAYS rotates to the next account (round-robin) for even load distribution.
   * Recipe 1 → Account 1, Recipe 2 → Account 2, ... Recipe N → wraps around.
   */
  async _ensureProModelForNewRecipe() {
    const multiAccount = await FlowAccountManager.isEnabled();
    if (!multiAccount) {
      this.flow.preferredModel = 'Nano Banana Pro';
      return;
    }

    // Always rotate to next account (round-robin)
    this._needsAccountRotation = false;
    try {
      const next = await FlowAccountManager.rotateRoundRobin();
      if (next) {
        Logger.info(`[FlowAccounts] Round-robin → account "${next.name}" for this recipe`);
        try { await this.flow.closeSession(); } catch {}
        await StateManager.updateState({ flowAccountRotationNeeded: true });
        // Swap browser NOW so the first generation uses the correct profile
        await this._ensureBrowserForAccount();
      } else {
        Logger.warn('[FlowAccounts] No enabled accounts available — using current');
      }
    } catch (e) {
      Logger.warn(`[FlowAccounts] Round-robin rotation failed: ${e.message}`);
    }

    // Set Nano Banana Pro — will be applied in _setGenerationSettings during generation
    this.flow.preferredModel = 'Nano Banana Pro';
  }

  /**
   * Ensure the browser context matches the active Flow account's profile.
   * Called at the start of any image generation step.
   */
  async _ensureBrowserForAccount() {
    const state = await StateManager.getState();
    if (!state.flowAccountRotationNeeded) return false;

    const account = await FlowAccountManager.getActiveAccount();
    if (!account) return false;

    const ctx = this.serverCtx;
    if (!ctx?.launchBrowserWithProfile) {
      Logger.warn('[FlowAccounts] Server context not available — cannot swap browser');
      await StateManager.updateState({ flowAccountRotationNeeded: false });
      return false;
    }

    const profileDir = FlowAccountManager.getProfileDir(account);
    Logger.info(`[FlowAccounts] Switching browser to profile: ${profileDir}`);

    // Close old browser context
    if (ctx.browserContext) {
      try { await ctx.browserContext.close(); } catch {}
      ctx.browserContext = null;
    }

    // Launch with new profile
    await ctx.launchBrowserWithProfile(profileDir);

    // Update our reference to the new browser context
    this.context = ctx.browserContext;

    // Recreate Flow and ChatGPT page objects with new context
    // Preserve the preferred model across browser swaps
    const savedModel = this.flow?.preferredModel || 'Nano Banana Pro';
    this.flow = new FlowPage(null, ctx.browserContext);
    this.flow.preferredModel = savedModel;
    this.chatgpt = new ChatGPTPage(null, ctx.browserContext);

    await StateManager.updateState({ flowAccountRotationNeeded: false });
    Logger.success(`[FlowAccounts] Now using account "${account.name}"`);
    return true;
  }

  async start() {
    if (this._running) return;
    this._running = true;
    this._paused = false;

    const state = await StateManager.getState();

    if (state.status === STATES.IDLE || state.status === STATES.COMPLETED) {
      await StateManager.resetState();
      await StateManager.updateState({ status: STATES.LOADING_JOB });
      Logger.info('Fresh start: state reset');
    }

    if (state.status === STATES.ERROR || state.status === STATES.PAUSED) {
      const resumeState = state.statusBeforeError || state.status;
      await StateManager.updateState({ status: resumeState, error: null });
      Logger.info('Resuming from:', resumeState);
    }

    await this._runLoop();
  }

  async pause() {
    this._paused = true;
    this._running = false;
    const state = await StateManager.getState();
    await StateManager.updateState({ status: STATES.PAUSED, statusBeforeError: state.status });
    Logger.info('Paused');
  }

  async _runLoop() {
    while (this._running && !this._paused) {
      try {
        const state = await StateManager.getState();
        try {
          const handler = this._stepHandlers[state.status];
          if (handler) {
            await handler.call(this);
          } else {
            this._running = false;
            return;
          }
        } catch (error) {
          const shouldContinue = await this._handleError(error);
          if (!shouldContinue) return;
          // Batch mode: error was handled, next recipe queued — continue loop
        }
      } catch (fatalError) {
        // _handleError itself crashed or getState failed — try to keep batch alive
        Logger.error(`[RunLoop] Fatal error: ${fatalError.message}`);
        try {
          const state = await StateManager.getState();
          if (state?.batchMode && state.batchQueue?.length > 0) {
            const nextIndex = (state.batchCurrentIndex || 0) + 1;
            if (nextIndex < state.batchQueue.length) {
              Logger.warn(`[RunLoop] Recovering batch — skipping to recipe ${nextIndex + 1}/${state.batchQueue.length}`);
              await StateManager.resetState();
              await StateManager.updateState({
                status: STATES.LOADING_JOB,
                batchMode: true,
                batchQueue: state.batchQueue,
                batchCurrentIndex: nextIndex,
                batchResults: [...(state.batchResults || []), { topic: state.recipeTitle || 'Unknown', status: 'error', error: fatalError.message.substring(0, 200) }],
                batchStartedAt: Date.now()
              });
              await new Promise(r => setTimeout(r, 5000));
              continue;
            }
          }
        } catch {}
        this._running = false;
        return;
      }
    }
  }

  // ── Shared step handlers (subclasses merge these via _sharedHandlers) ──

  get _sharedHandlers() {
    return {
      [STATES.SELECTING_BACKGROUND]: () => this._stepSelectBackground(),
      [STATES.CREATING_FOLDERS]: () => this._stepCreateFolders(),
      [STATES.GENERATING_STEPS]: () => this._stepGenerateStep(),
      [STATES.GENERATING_INGREDIENTS]: () => this._stepGenerateIngredients(),
      [STATES.GENERATING_HERO]: () => this._stepGenerateHero(),
      [STATES.SAVING_FILES]: () => this._stepSaveFiles(),
      [STATES.UPLOADING_MEDIA]: () => this._stepUploadMedia(),
      [STATES.PUBLISHING_DRAFT]: () => this._stepPublishDraft(),
      [STATES.GENERATING_PINS]: () => this._stepGeneratePins(),
      [STATES.UPLOADING_PINS]: () => this._stepUploadPins(),
      [STATES.UPDATING_SHEET]: () => this._stepUpdateSheet(),
      [STATES.COMPLETED]: async () => {
        Logger.success('Job completed successfully!');
        const stateBeforeCleanup = await StateManager.getState();

        // === FULL CLEANUP FOR NEXT RECIPE ===
        // 1. Close browser tabs
        try { await this.chatgpt.close(); } catch {}
        try { await this.flow.closeSession(); } catch {}

        // 2. Clean ALL tmp files (originals, html, images) — delete files but keep folders
        try {
          const { readdirSync, unlinkSync } = await import('fs');
          const cleanDir = (dir) => {
            if (!existsSync(dir)) return;
            for (const f of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, f.name);
              if (f.isDirectory()) cleanDir(p);
              else try { unlinkSync(p); } catch {}
            }
          };
          const tmpDir = join(__dirname, '..', '..', 'data', 'tmp');
          cleanDir(tmpDir);
          Logger.info('Cleaned tmp files');
        } catch {}

        // 2b. Clean debug screenshots (they pile up fast)
        try {
          const { readdirSync, unlinkSync } = await import('fs');
          const ssDir = join(__dirname, '..', '..', 'screenshots');
          if (existsSync(ssDir)) {
            let count = 0;
            for (const f of readdirSync(ssDir)) {
              if (/\.(png|jpg|jpeg)$/i.test(f)) {
                try { unlinkSync(join(ssDir, f)); count++; } catch {}
              }
            }
            if (count > 0) Logger.info(`Cleaned ${count} debug screenshot(s)`);
          }
        } catch {}

        // 2c. Clean output folder (images already uploaded to WP, no need to keep)
        try {
          const settings = await StateManager.getSettings();
          const outputDir = this._getOutputDir(stateBeforeCleanup, settings);
          if (existsSync(outputDir)) {
            const { readdirSync, unlinkSync, rmdirSync } = await import('fs');
            for (const f of readdirSync(outputDir)) {
              try { unlinkSync(join(outputDir, f)); } catch {}
            }
            try { rmdirSync(outputDir); } catch {}
            Logger.info('Cleaned output folder (images already on WordPress)');
          }
        } catch {}

        // 3. Clear ALL cached images from state (hero, ingredients, steps, hero bg base64)
        try {
          await StateManager.clearImageData();
        } catch {}

        // ── Batch mode: record success, advance to next recipe ──
        if (stateBeforeCleanup.batchMode && stateBeforeCleanup.batchQueue?.length > 0) {
          const duration = stateBeforeCleanup.batchStartedAt ? Date.now() - stateBeforeCleanup.batchStartedAt : 0;
          const batchResults = [...(stateBeforeCleanup.batchResults || [])];
          batchResults.push({
            topic: stateBeforeCleanup.recipeTitle || 'Unknown',
            rowIndex: stateBeforeCleanup.sheetRowIndex,
            status: 'success',
            draftUrl: stateBeforeCleanup.draftUrl || null,
            draftPostId: stateBeforeCleanup.draftPostId || null,
            duration
          });

          const nextIndex = (stateBeforeCleanup.batchCurrentIndex || 0) + 1;
          const total = stateBeforeCleanup.batchQueue.length;
          const successes = batchResults.filter(r => r.status === 'success').length;
          const errors = batchResults.filter(r => r.status === 'error').length;

          if (nextIndex < total) {
            Logger.info(`Batch progress: ${nextIndex}/${total} done (${successes} success, ${errors} failed). Next recipe...`);
            await StateManager.resetState();
            await StateManager.updateState({
              status: STATES.LOADING_JOB,
              batchMode: true,
              batchQueue: stateBeforeCleanup.batchQueue,
              batchCurrentIndex: nextIndex,
              batchResults,
              batchStartedAt: Date.now()
            });
            await new Promise(r => setTimeout(r, 3000));
            return; // continues the _runLoop
          } else {
            // All recipes processed — batch complete!
            Logger.success(`═══ BATCH COMPLETE ═══`);
            Logger.success(`Total: ${total} | Success: ${successes} | Failed: ${errors}`);
            for (const r of batchResults) {
              const icon = r.status === 'success' ? '✓' : '✗';
              Logger.info(`  ${icon} ${r.topic} ${r.draftUrl ? '→ ' + r.draftUrl : r.error ? '— ' + r.error : ''}`);
            }
            await StateManager.resetState();
            await StateManager.updateState({
              batchMode: false,
              batchResults,
              batchQueue: stateBeforeCleanup.batchQueue,
              batchCurrentIndex: total,
            });
            this._running = false;
            return;
          }
        }

        // ── Continuous mode (legacy): re-scan sheet for next pending ──
        const settings = await StateManager.getSettings();
        if (settings.continuousMode !== false) {
          Logger.info('Checking for next pending recipe...');
          await StateManager.resetState();
          await StateManager.updateState({ status: STATES.LOADING_JOB });
          await new Promise(r => setTimeout(r, 3000));
          return; // continues the loop
        }

        this._running = false;
      },
      [STATES.IDLE]: async () => {
        // No more pending — close everything and stop
        Logger.info('No more recipes to process. Stopping.');
        try { await this.chatgpt.close(); } catch {}
        try { await this.flow.closeSession(); } catch {}
        this._running = false;
      },
      [STATES.ERROR]: async () => {
        try { await this.chatgpt.close(); } catch {}
        try { await this.flow.closeSession(); } catch {}
        this._running = false;
      },
      [STATES.PAUSED]: () => { this._running = false; }
    };
  }

  async _handleError(error) {
    Logger.error('Orchestrator error:', error.message);
    const state = await StateManager.getState();
    await StateManager.addLog(`Error in ${state.status}: ${error.message}`, 'error');

    // Mark sheet row as error
    if (state.sheetRowIndex > 0) {
      try {
        const settings = await StateManager.getSettings();
        const effectiveSettings = state.sheetSettings
          ? { ...settings, sheetTabName: state.sheetSettings.sheetTabName, statusColumn: state.sheetSettings.statusColumn }
          : settings;
        await SheetsAPI.markError(effectiveSettings, state.sheetRowIndex, error.message.substring(0, 100));
      } catch {}
    }

    // ── Batch mode: record failure, skip to next recipe ──
    if (state.batchMode && state.batchQueue?.length > 0) {
      const duration = state.batchStartedAt ? Date.now() - state.batchStartedAt : 0;
      const batchResults = [...(state.batchResults || [])];
      batchResults.push({
        topic: state.recipeTitle || 'Unknown',
        rowIndex: state.sheetRowIndex,
        status: 'error',
        error: error.message.substring(0, 200),
        duration
      });

      const nextIndex = (state.batchCurrentIndex || 0) + 1;
      Logger.warn(`Batch: recipe "${state.recipeTitle}" failed — skipping to next (${nextIndex + 1}/${state.batchQueue.length})`);

      // Clean up for next recipe — close tabs but keep browser alive
      try { await this.chatgpt.close(); } catch {}
      try { await this.flow.closeSession(); } catch {}
      try { await StateManager.clearImageData(); } catch {}

      // Verify browser context is still alive — if not, flag for relaunch
      try {
        if (this.serverCtx?.browserContext) {
          await this.serverCtx.browserContext.newPage().then(p => p.close());
        }
      } catch {
        Logger.warn('[Batch] Browser context dead after error — will relaunch for next recipe');
        if (this.serverCtx) this.serverCtx.browserContext = null;
        await StateManager.updateState({ flowAccountRotationNeeded: true });
      }

      if (nextIndex < state.batchQueue.length) {
        // More recipes in queue — reset state and continue
        await StateManager.resetState();
        await StateManager.updateState({
          status: STATES.LOADING_JOB,
          batchMode: true,
          batchQueue: state.batchQueue,
          batchCurrentIndex: nextIndex,
          batchResults,
          batchStartedAt: Date.now()
        });
        // Small delay before next recipe
        await new Promise(r => setTimeout(r, 5000));
        return true; // tell _runLoop to continue
      } else {
        // All recipes processed — batch complete
        Logger.success(`Batch complete! ${batchResults.length} recipes processed.`);
        const successes = batchResults.filter(r => r.status === 'success').length;
        const errors = batchResults.filter(r => r.status === 'error').length;
        Logger.info(`Results: ${successes} success, ${errors} failed`);
        await StateManager.updateState({
          status: STATES.IDLE,
          batchMode: false,
          batchResults,
          error: null
        });
        this._running = false;
        return false;
      }
    }

    // ── Normal mode: stop on error ──
    await StateManager.updateState({
      status: STATES.ERROR,
      statusBeforeError: state.status,
      error: `[${state.status}] ${error.message}`
    });
    this._running = false;
    return false;
  }

  // ── Shared utilities used by multiple steps ────────────────────────

  _getOutputDir(state, settings) {
    const folder = sanitizeFilename(state.recipeTitle);
    const basePath = settings.downloadFolder ? join(settings.downloadFolder, folder) : folder;
    return join(__dirname, '..', '..', 'output', basePath);
  }

  _resolvePromptPlaceholders(template, recipeJSON, extraVars = {}) {
    if (!template) return template;
    const ingredientsList = (recipeJSON?.ingredients || [])
      .map(i => `${i.quantity} ${i.name}`.trim()).join(', ');

    const vars = {
      '@title': recipeJSON?.post_title || '',
      '@ingredients': ingredientsList,
      '@intro': recipeJSON?.intro || '',
      '@conclusion': recipeJSON?.conclusion || '',
      '@keyword': recipeJSON?.focus_keyword || '',
      '@slug': recipeJSON?.slug || '',
      '@cuisine': recipeJSON?.cuisine || '',
      '@category': recipeJSON?.category || '',
      '@prompt': extraVars.prompt || extraVars['@prompt'] || '',
      '@step_title': extraVars.step_title || extraVars['@step_title'] || '',
      '@step_description': extraVars.step_description || extraVars['@step_description'] || '',
      '@step_number': extraVars.step_number || extraVars['@step_number'] || '',
      '@pin_title': extraVars.pin_title || extraVars['@pin_title'] || '',
      '@pin_description': extraVars.pin_description || extraVars['@pin_description'] || '',
      '@website': extraVars.website || extraVars['@website'] || '',
    };

    let result = template;
    for (const [placeholder, value] of Object.entries(vars)) {
      result = result.split(placeholder).join(value);
    }
    return result;
  }

  // Returns the right prefix/suffix based on mode (generator vs scraper)
  _getImagePrompts(settings, type) {
    const isScraper = settings.mode === 'scrape';
    const prefixMap = {
      steps: isScraper ? (settings.scraperStepsPromptPrefix || settings.scraperBackgroundPromptPrefix || settings.stepsPromptPrefix || settings.backgroundPromptPrefix || '') : (settings.stepsPromptPrefix || settings.backgroundPromptPrefix || ''),
      ingredients: isScraper ? (settings.scraperIngredientsPromptPrefix || settings.scraperBackgroundPromptPrefix || settings.ingredientsPromptPrefix || settings.backgroundPromptPrefix || '') : (settings.ingredientsPromptPrefix || settings.backgroundPromptPrefix || ''),
      hero: isScraper ? (settings.scraperHeroPromptPrefix || settings.scraperBackgroundPromptPrefix || settings.heroPromptPrefix || settings.backgroundPromptPrefix || '') : (settings.heroPromptPrefix || settings.backgroundPromptPrefix || '')
    };
    const suffixMap = {
      steps: isScraper ? (settings.scraperStepsPromptSuffix || settings.stepsPromptSuffix || settings.imagePromptSuffix || '') : (settings.stepsPromptSuffix || settings.imagePromptSuffix || ''),
      ingredients: isScraper ? (settings.scraperIngredientsPromptSuffix || settings.ingredientsPromptSuffix || settings.imagePromptSuffix || '') : (settings.ingredientsPromptSuffix || settings.imagePromptSuffix || ''),
      hero: isScraper ? (settings.scraperHeroPromptSuffix || settings.heroPromptSuffix || settings.imagePromptSuffix || '') : (settings.heroPromptSuffix || settings.imagePromptSuffix || '')
    };
    return { prefix: prefixMap[type] || '', suffix: suffixMap[type] || '' };
  }

  _buildImagePrompt(rawPrefix, rawSuffix, defaultPrompt, randomSuffix, recipeJSON, extraVars = {}) {
    return this._resolvePromptPlaceholders(rawPrefix, recipeJSON, extraVars)
      + this._resolvePromptPlaceholders(defaultPrompt, recipeJSON, extraVars)
      + this._resolvePromptPlaceholders(rawSuffix, recipeJSON, extraVars)
      + randomSuffix;
  }

  /**
   * Collect file paths of recently generated step images that exist on disk.
   * Limited to last MAX_CONTEXT steps for speed and reliability.
   */
  _collectStepContextPaths(steps, outputDir, upToIndex) {
    const contextPaths = [];
    const now = Date.now();
    for (let i = 0; i < upToIndex; i++) {
      const p = join(outputDir, steps[i].seo?.filename || FILENAMES.stepDefault(i));
      if (!existsSync(p)) continue;
      // Only use files from the current run (created within last 2 hours)
      try {
        const age = now - statSync(p).mtimeMs;
        if (age > 2 * 60 * 60 * 1000) {
          Logger.warn(`Skipping stale context image (${(age / 3600000).toFixed(1)}h old): ${basename(p)}`);
          continue;
        }
      } catch {}
      contextPaths.push(p);
    }
    return contextPaths;
  }

  // ═══════════════════════════════════════════════════════
  // STEP: SELECT BACKGROUND
  // ═══════════════════════════════════════════════════════

  async _stepSelectBackground() {
    const state = await StateManager.getState();
    if (state.selectedHeroBackground && state.backgroundQueue?.length) {
      await StateManager.updateState({ status: STATES.GENERATING_RECIPE_JSON });
      return;
    }

    Logger.step('Background', 'Selecting backgrounds...');
    const settings = await StateManager.getSettings();

    // Hero background (from uploaded backgrounds, or auto-load from folder)
    let heroBgs = await StateManager.getHeroBackgrounds();
    if (!heroBgs?.length && settings.backgroundsFolderPath && settings.selectedSubfolder) {
      // Auto-load from folder if no uploaded backgrounds
      const folderPath = join(settings.backgroundsFolderPath, settings.selectedSubfolder);
      const imagePaths = StateManager.listImagesInFolder(folderPath);
      if (imagePaths.length > 0) {
        const fss = await import('fs');
        const bgArray = imagePaths.map(imgPath => ({
          name: imgPath.split(/[/\\]/).pop(),
          base64: fss.readFileSync(imgPath).toString('base64')
        }));
        await StateManager.saveHeroBackgrounds(bgArray);
        heroBgs = bgArray;
        Logger.info(`Auto-loaded ${heroBgs.length} backgrounds from folder`);
      }
    }
    if (!heroBgs?.length) throw new Error('No hero backgrounds loaded. Set backgrounds folder in Settings.');
    const heroPick = heroBgs[Math.floor(Math.random() * heroBgs.length)];

    // Steps/ingredients backgrounds from folder
    let backgroundQueue = [];
    if (settings.backgroundsFolderPath && settings.selectedSubfolder) {
      const folderPath = join(settings.backgroundsFolderPath, settings.selectedSubfolder);
      backgroundQueue = StateManager.listImagesInFolder(folderPath);
      // Shuffle the queue
      for (let i = backgroundQueue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [backgroundQueue[i], backgroundQueue[j]] = [backgroundQueue[j], backgroundQueue[i]];
      }
    }

    if (!backgroundQueue.length) {
      // Fallback to old steps backgrounds
      const stepsBgs = await StateManager.getStepsBackgrounds();
      if (!stepsBgs?.length) throw new Error('No step backgrounds configured. Set a backgrounds folder in Settings.');
      // Write fallback to temp files
      const tmpDir = join(__dirname, '..', '..', 'data', 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      stepsBgs.forEach((bg, i) => {
        const p = join(tmpDir, FILENAMES.fallbackBg(i));
        writeFileSync(p, Buffer.from(bg.base64, 'base64'));
        backgroundQueue.push(p);
      });
    }

    await StateManager.updateState({
      status: STATES.GENERATING_RECIPE_JSON,
      selectedHeroBackground: { name: heroPick.name, base64: heroPick.base64 },
      backgroundQueue,
      backgroundQueueIndex: 0
    });
    Logger.success(`Hero: ${heroPick.name}, Backgrounds folder: ${backgroundQueue.length} images`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: CREATE FOLDERS
  // ═══════════════════════════════════════════════════════

  async _stepCreateFolders() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const fullPath = this._getOutputDir(state, settings);

    // Clean old images from output folder (prevent stale context images)
    if (existsSync(fullPath)) {
      try {
        const { readdirSync, unlinkSync } = await import('fs');
        let cleaned = 0;
        for (const f of readdirSync(fullPath)) {
          // Only delete image files — keep recipe.json and other data
          if (/\.(jpg|jpeg|png|webp)$/i.test(f)) {
            try { unlinkSync(join(fullPath, f)); cleaned++; } catch {}
          }
        }
        if (cleaned > 0) Logger.info(`Cleaned ${cleaned} old image(s) from output folder`);
      } catch {}
    } else {
      await mkdir(fullPath, { recursive: true });
    }

    // Clean tmp from previous recipe (prevent stale images)
    try {
      const tmpDir = join(__dirname, '..', '..', 'data', 'tmp');
      if (existsSync(tmpDir)) {
        const { readdirSync, unlinkSync } = await import('fs');
        const cleanDir = (dir) => {
          if (!existsSync(dir)) return;
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, f.name);
            if (f.isDirectory()) cleanDir(p);
            else try { unlinkSync(p); } catch {}
          }
        };
        cleanDir(tmpDir);
        Logger.info('Cleaned tmp files for fresh start');
      }
    } catch {}

    // Clean old Flow projects
    try {
      await this.flow.cleanupAllProjects();
    } catch (e) {
      Logger.warn('Flow cleanup failed (non-fatal):', e.message);
    }

    const nextStatus = this._getPostFoldersState(settings);
    await StateManager.updateState({ status: nextStatus, currentStepIndex: 0 });
    Logger.success('Folder created:', fullPath);
  }

  /**
   * Hook for subclasses to determine the next state after folder creation.
   * Generator goes to GENERATING_INGREDIENTS; Scraper goes to DOWNLOADING_IMAGES.
   * Order matches original extension: ingredients -> steps -> hero.
   */
  _getPostFoldersState(settings) {
    return STATES.GENERATING_INGREDIENTS;
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE STEP IMAGES
  // ═══════════════════════════════════════════════════════

  async _stepGenerateStep() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const idx = state.currentStepIndex;
    const step = state.steps[idx];

    if (step.base64) { await this._advanceStep(); return; }

    Logger.step('Flow', `Step ${idx + 1}/${state.steps.length}: ${step.title}`);

    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'steps');
    const aiPrompt = step.prompt || '';
    const stepVars = { '@prompt': aiPrompt, '@step_title': step.title || '', '@step_description': step.description || '', '@step_number': String(idx + 1) };
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, stepVars)
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, stepVars);

    // Get background from queue
    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];

    // Output path
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, step.seo?.filename || FILENAMES.stepDefault(idx));

    // Collect previous step image FILE PATHS as context
    const contextPaths = this._collectStepContextPaths(state.steps, outputDir, idx);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, backgroundPath, contextPaths, settings.stepAspectRatio || 'PORTRAIT', outputPath)
    );
    if (!ok) throw new Error(`Step ${idx + 1} image generation failed after 2 attempts`);
    await this._trackFlowGeneration();

    // Also store as base64 for WordPress upload
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`step_${idx}`, imgBuf.toString('base64'));

    const steps = [...state.steps];
    steps[idx] = { ...steps[idx], base64: true };
    await StateManager.updateState({ steps, backgroundQueueIndex: bgIndex + 1 });
    Logger.success(`Step ${idx + 1} image generated`);
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
  // STEP: GENERATE INGREDIENTS IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepGenerateIngredients() {
    const state = await StateManager.getState();
    if (state.ingredientsImage?.base64) {
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    const settings = await StateManager.getSettings();
    Logger.step('Flow', 'Generating ingredients image...');

    // First image of recipe — ensure fresh account with Nano Banana Pro
    await this._ensureProModelForNewRecipe();

    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'ingredients');
    const aiPrompt = state.recipeJSON?.ingredients_prompt || '';
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, { '@prompt': aiPrompt })
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, { '@prompt': aiPrompt });

    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.ingredients_seo?.filename || FILENAMES.ingredients);

    // Collect step image file paths as context (none generated yet at this point)
    const contextPaths = this._collectStepContextPaths(state.steps, outputDir, state.steps.length);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, backgroundPath, contextPaths, settings.ingredientAspectRatio || 'PORTRAIT', outputPath),
      true // first image of recipe — rotate account immediately on rate limit
    );
    if (!ok) throw new Error('Ingredients image generation failed after 2 attempts');
    await this._trackFlowGeneration();

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('ingredients', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0, ingredientsImage: { base64: true }, backgroundQueueIndex: bgIndex + 1 });
    Logger.success('Ingredients image generated');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE HERO IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepGenerateHero() {
    const state = await StateManager.getState();
    if (state.heroImage?.base64) {
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }

    const settings = await StateManager.getSettings();
    Logger.step('Flow', 'Generating hero image...');

    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'hero');
    const aiPrompt = state.recipeJSON?.hero_prompt || '';
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, { '@prompt': aiPrompt })
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, { '@prompt': aiPrompt });

    // Write hero background to temp file
    const tmpDir = join(__dirname, '..', '..', 'data', 'tmp');
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

    // Collect step image file paths as context
    const contextPaths = this._collectStepContextPaths(state.steps, outputDir, state.steps.length);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, heroTmpPath, contextPaths, settings.heroAspectRatio || 'LANDSCAPE', outputPath)
    );
    if (!ok) throw new Error('Hero image generation failed after 2 attempts');
    await this._trackFlowGeneration();

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('hero', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.SAVING_FILES, heroImage: { base64: true } });
    Logger.success('Hero image generated');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: SAVE FILES (delegates to save-upload.js)
  // ═══════════════════════════════════════════════════════

  async _stepSaveFiles() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const outputDir = this._getOutputDir(state, settings);
    await saveFiles(state, outputDir);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: UPLOAD MEDIA (delegates to save-upload.js)
  // ═══════════════════════════════════════════════════════

  async _stepUploadMedia() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    await uploadMedia(state, settings);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: PUBLISH DRAFT (delegates to post-builder.js)
  // ═══════════════════════════════════════════════════════

  async _stepPublishDraft() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const result = await buildAndPublishPost(state, settings, WordPressAPI, Logger);
    // Next: generate Pinterest pins if enabled, otherwise go straight to sheet update
    const nextStatus = (settings.pinterestEnabled && state.pinterestPins?.length > 0)
      ? STATES.GENERATING_PINS
      : STATES.UPDATING_SHEET;
    await StateManager.updateState({
      status: nextStatus,
      articleHTML: result.html,
      draftUrl: result.draftUrl,
      draftPostId: result.draftPostId
    });
    Logger.success(`Draft created: ${result.draftUrl}`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE PINTEREST PINS
  // ═══════════════════════════════════════════════════════

  async _stepGeneratePins() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const pins = state.pinterestPins || [];

    if (!pins.length) {
      Logger.info('No Pinterest pins to generate — skipping');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    // Find the first pin that hasn't been generated yet
    const pendingIdx = pins.findIndex(p => !p.base64);
    if (pendingIdx === -1) {
      Logger.success('All Pinterest pin images already generated');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const pin = pins[pendingIdx];
    Logger.step('Flow', `Pinterest pin ${pendingIdx + 1}/${pins.length}: ${pin.title}`);

    // Close Flow session before EACH pin — each pin uses a different template image,
    // and the picker gets polluted with previous templates + context images.
    // A fresh project ensures only the correct template is on canvas.
    Logger.info(`[Pinterest] Closing Flow session — fresh project for pin ${pendingIdx + 1}`);
    try { await this.flow.closeSession(); } catch {}

    // Pick template from the right folder (generator vs scraper)
    const isScraper = settings.mode === 'scrape';
    const templateFolder = isScraper
      ? settings.pinterestTemplateFolderScraper
      : settings.pinterestTemplateFolderGenerator;

    if (!templateFolder || !existsSync(templateFolder)) {
      Logger.warn(`Pinterest template folder not configured or missing: ${templateFolder || '(empty)'}. Skipping pins.`);
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const templateImages = StateManager.listImagesInFolder(templateFolder);
    if (!templateImages.length) {
      throw new Error(`No template images found in: ${templateFolder}`);
    }

    // Pick a different template for each pin (cycle through available templates)
    const templatePath = templateImages[pendingIdx % templateImages.length];
    Logger.info(`Using template: ${basename(templatePath)}`);

    // Build context images: hero + last step (generator) or hero only (scraper)
    // NOTE: ingredients passed as TEXT in prompt via @ingredients, not as image
    const contextPaths = [];
    const outputDir = this._getOutputDir(state, settings);

    // Add hero image as context
    const heroFilename = state.recipeJSON?.hero_seo?.filename || FILENAMES.hero;
    const heroPath = join(outputDir, heroFilename);
    if (existsSync(heroPath)) {
      contextPaths.push(heroPath);
    }

    // Generator mode: also add last step image
    if (!isScraper && state.steps?.length > 0) {
      const lastStep = state.steps[state.steps.length - 1];
      const lastStepFilename = lastStep.seo?.filename || FILENAMES.stepDefault(state.steps.length - 1);
      const lastStepPath = join(outputDir, lastStepFilename);
      if (existsSync(lastStepPath)) {
        contextPaths.push(lastStepPath);
      }
    }

    // Build prompt with pin-specific variables
    // If ChatGPT didn't provide image_prompt, build a default from the hero prompt + pin title
    const rawPrefix = settings.pinterestPromptPrefix || '';
    const rawSuffix = settings.pinterestPromptSuffix || '';
    const heroPrompt = state.recipeJSON?.hero_prompt || '';
    const recipeTitle = state.recipeJSON?.post_title || state.recipeTitle || '';
    const pinPrompt = pin.image_prompt
      || `Pinterest pin image for "${recipeTitle}". ${heroPrompt}. Title overlay: "${pin.title}". Styled like the uploaded template reference image.`;
    // Extract website domain from settings for template branding
    const websiteUrl = settings.wpUrl || '';
    const websiteDomain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const pinVars = {
      '@prompt': pinPrompt,
      '@pin_title': pin.title || '',
      '@pin_description': pin.description || '',
      '@website': websiteDomain
    };
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, pinVars)
      + pinPrompt
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, pinVars);
    Logger.info(`Pinterest prompt (${prompt.length} chars): ${prompt.substring(0, 120)}...`);

    // Output path
    const pinFilename = `pin-${pendingIdx + 1}.jpg`;
    const outputPath = join(outputDir, pinFilename);

    // Generate via Flow: template = background, hero + last step = context
    // skipSimilarityCheck: Pinterest pins SHOULD look similar to the template — don't reject them
    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(
        prompt,
        templatePath,
        contextPaths,
        settings.pinterestAspectRatio || 'PORTRAIT',
        outputPath,
        { skipSimilarityCheck: true }
      )
    );
    if (!ok) throw new Error(`Pinterest pin ${pendingIdx + 1} image generation failed`);
    await this._trackFlowGeneration();

    // Store image data
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`pin_${pendingIdx}`, imgBuf.toString('base64'));

    // Update pin state
    const updatedPins = [...pins];
    updatedPins[pendingIdx] = { ...updatedPins[pendingIdx], base64: true };
    await StateManager.updateState({ pinterestPins: updatedPins });
    Logger.success(`Pinterest pin ${pendingIdx + 1} image generated`);

    // Check if all pins are done
    const allDone = updatedPins.every(p => p.base64);
    if (allDone) {
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      Logger.success('All Pinterest pin images generated!');
    }
    // Otherwise, the loop will re-enter this state for the next pin
  }

  // ═══════════════════════════════════════════════════════
  // STEP: UPLOAD PINTEREST PINS TO WORDPRESS
  // ═══════════════════════════════════════════════════════

  async _stepUploadPins() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const pins = state.pinterestPins || [];

    if (!pins.length) {
      await StateManager.updateState({ status: STATES.UPDATING_SHEET });
      return;
    }

    Logger.step('WordPress', `Uploading ${pins.length} Pinterest pin images...`);

    const updatedPins = [...pins];
    for (let i = 0; i < updatedPins.length; i++) {
      if (updatedPins[i].wpImageId) continue; // already uploaded

      const base64 = await StateManager.getImageData(`pin_${i}`);
      if (!base64) {
        Logger.warn(`Pin ${i + 1}: no image data found, skipping upload`);
        continue;
      }

      Logger.info(`Uploading Pinterest pin ${i + 1}/${updatedPins.length}...`);
      const pin = updatedPins[i];
      const filename = `${state.recipeJSON?.slug || 'recipe'}-pin-${i + 1}.jpg`;
      const seoData = {
        alt_text: pin.title,
        title: pin.title,
        description: pin.description
      };

      const media = await WordPressAPI.uploadImage(settings, base64, filename, seoData, state.recipeJSON);
      updatedPins[i] = { ...updatedPins[i], wpImageId: media.id, wpImageUrl: media.url };
    }

    await StateManager.updateState({
      status: STATES.UPDATING_SHEET,
      pinterestPins: updatedPins
    });
    Logger.success('All Pinterest pin images uploaded to WordPress');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: UPDATE SHEET (delegates to save-upload.js)
  // ═══════════════════════════════════════════════════════

  async _stepUpdateSheet() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    await updateSheet(state, settings);
  }
}
