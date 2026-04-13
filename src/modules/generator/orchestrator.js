/**
 * GeneratorOrchestrator — generate-from-topic workflow
 *
 * Extends BaseOrchestrator with steps specific to generating recipes
 * from a topic/title (as opposed to scraping from a URL):
 * - _stepLoadJob()          — reads topic from Google Sheet
 * - _stepGenerateRecipeJSON() — ChatGPT generates recipe from topic
 */

import { BaseOrchestrator, sanitizeRecipeJSON, FILENAMES } from '../base-orchestrator.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { Logger } from '../../shared/utils/logger.js';
import { GeminiChatPage } from '../../shared/pages/gemini-chat.js';

export class GeneratorOrchestrator extends BaseOrchestrator {
  constructor(browser, context, serverCtx) {
    super(browser, context, serverCtx);
  }

  get _stepHandlers() {
    return {
      ...this._sharedHandlers,
      [STATES.LOADING_JOB]: () => this._stepLoadJob(),
      [STATES.GENERATING_RECIPE_JSON]: () => this._stepGenerateRecipeJSON(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // STEP: LOAD JOB (generator mode)
  // ═══════════════════════════════════════════════════════

  async _stepLoadJob() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    if (!settings.sheetId) throw new Error('Google Sheet ID not configured.');

    // Use generator-specific sheet settings
    const sheetSettings = {
      ...settings,
      sheetTabName: settings.generatorSheetTab || settings.sheetTabName || 'single post',
      topicColumn: settings.generatorTopicColumn || settings.topicColumn || 'A',
      statusColumn: settings.generatorStatusColumn || settings.statusColumn || 'B',
      startRow: settings.generatorStartRow || settings.startRow || 2
    };

    let pending;

    // ── Batch mode: use pre-loaded queue ──
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
      // ── Normal/continuous mode: scan sheet for next pending ──
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
    Logger.success(`Found recipe: "${pending.topic}" (row ${pending.rowIndex})`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE RECIPE JSON (generator mode)
  // ═══════════════════════════════════════════════════════

  async _stepGenerateRecipeJSON() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();

    // ── Choose AI provider: ChatGPT or Gemini browser ──
    const aiProvider = settings.aiProvider || 'chatgpt';
    const useGemini = aiProvider === 'gemini';

    if (useGemini) {
      Logger.step('Gemini', `Generating recipe for: ${state.recipeTitle}`);
      if (!this._geminiChat) this._geminiChat = new GeminiChatPage(null, this.context);
      await this._geminiChat.init();
    } else {
      Logger.step('ChatGPT', `Generating recipe for: ${state.recipeTitle}`);
      const isCustomGpt = settings.generatorGptUrl && !settings.generatorGptUrl.match(/^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/?$/);
      await this.chatgpt.init(isCustomGpt ? settings.generatorGptUrl : null);
    }

    let prompt;
    if (isCustomGpt) {
      // Custom GPT has instructions baked in — send thin prompt with dynamic data only
      const introIndex = (settings.introRotationIndex || 0) % (settings.introRotationTotal || 12);
      prompt = [
        `Topic: "${state.recipeTitle}"`,
        `Categories: ${settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert'}`,
        `Use intro template #${introIndex + 1}.`,
        `Output valid JSON only.`
      ].join('\n');
      Logger.info(`Using Custom GPT (intro template #${introIndex + 1})`);
    } else {
      // Build content template instructions (intro + conclusion)
      let templateInstructions = '';
      const introTemplates = settings.introTemplates || [];
      const conclusionTemplates = settings.conclusionTemplates || [];
      const idx = (settings.templateRotationIndex || 0) % Math.max(introTemplates.length, conclusionTemplates.length, 1);

      if (introTemplates.length > 0) {
        const introIdx = idx % introTemplates.length;
        templateInstructions += `\n\nCRITICAL - INTRO REWRITE RULE:\nFor the "intro" field in the JSON, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references and details. Do NOT add AI cliches. Keep it human and natural. Separate each paragraph with \\n\\n.\n\nINTRO TEMPLATE:\n${introTemplates[introIdx]}`;
        Logger.info(`Using intro template #${introIdx + 1}/${introTemplates.length}`);
      }

      if (conclusionTemplates.length > 0) {
        const concIdx = idx % conclusionTemplates.length;
        templateInstructions += `\n\nCRITICAL - CONCLUSION REWRITE RULE:\nFor the "conclusion" field in the JSON, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references and details. Do NOT add AI cliches. Keep it human and natural. Separate each paragraph with \\n\\n.\n\nCONCLUSION TEMPLATE:\n${conclusionTemplates[concIdx]}`;
        Logger.info(`Using conclusion template #${concIdx + 1}/${conclusionTemplates.length}`);
      }

      // Advance shared rotation counter
      if (introTemplates.length > 0 || conclusionTemplates.length > 0) {
        settings.templateRotationIndex = idx + 1;
        await StateManager.saveSettings(settings);
      }

      // Use full prompt template from settings
      const template = settings.recipePromptTemplate || '';
      prompt = template
        .replace(/@topic/gi, state.recipeTitle)
        .replace(/@categories/gi, settings.wpCategories || '');

      // Append template instructions
      if (templateInstructions) {
        prompt += templateInstructions;
      }
    }

    const aiChat = useGemini ? this._geminiChat : this.chatgpt;
    const response = await aiChat.sendPromptAndGetResponse(prompt, true);
    if (!response.success) throw new Error(`${useGemini ? 'Gemini' : 'ChatGPT'} failed: ${response.error}`);

    const recipe = sanitizeRecipeJSON(response.data);
    // Normalize key names (ChatGPT sometimes uses different keys)
    if (!recipe.post_title && recipe.title) recipe.post_title = recipe.title;
    if (!recipe.steps && recipe.instructions) recipe.steps = recipe.instructions;
    if (!recipe.pro_tips && recipe.tips) recipe.pro_tips = recipe.tips;
    if (!recipe.storage_notes && recipe.storage) recipe.storage_notes = recipe.storage;
    if (!recipe.steps || !Array.isArray(recipe.steps)) {
      Logger.error('ChatGPT returned keys:', Object.keys(recipe).join(', '));
      throw new Error('Invalid recipe JSON: missing steps array.');
    }

    const steps = recipe.steps.map((step, i) => ({
      number: step.number || i + 1,
      title: step.title || step.name || `Step ${i + 1}`,
      description: step.description || step.text || '',
      tip: step.tip || '',
      prompt: step.image_prompt || step.prompt || '',
      seo: step.seo || { filename: FILENAMES.stepDefault(i), alt_text: step.title || `Step ${i + 1}` },
      base64: null, wpImageId: null, wpImageUrl: null
    }));

    // Normalize pinterest_pins
    const pinterestPins = (recipe.pinterest_pins || []).map((pin, i) => ({
      title: pin.title || `Pin ${i + 1}`,
      description: pin.description || '',
      image_prompt: pin.image_prompt || pin.prompt || '',
      base64: null, wpImageId: null, wpImageUrl: null
    }));

    await StateManager.updateState({
      status: STATES.CREATING_FOLDERS,
      recipeJSON: recipe, steps, currentStepIndex: 0,
      pinterestPins,
      seoData: {
        post_title: recipe.post_title || state.recipeTitle,
        slug: recipe.slug || '',
        focus_keyword: recipe.focus_keyword || '',
        meta_title: recipe.meta_title || '',
        meta_description: recipe.meta_description || ''
      }
    });
    // Increment intro rotation for next run
    const nextIndex = ((settings.introRotationIndex || 0) + 1) % (settings.introRotationTotal || 12);
    await StateManager.saveSettings({ introRotationIndex: nextIndex });
    Logger.info(`Intro rotation: #${(settings.introRotationIndex || 0) + 1} → next will be #${nextIndex + 1}`);

    Logger.success(`Recipe JSON generated: ${steps.length} visual steps`);
  }
}
