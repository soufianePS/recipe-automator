/**
 * ScraperOrchestrator — scrape-from-URL workflow
 *
 * Extends BaseOrchestrator with steps specific to scraping recipes
 * from a URL (as opposed to generating from a topic):
 * - _stepLoadJob()           — reads URL from Google Sheet
 * - _stepScrapeSite()        — scrapes the page content
 * - _stepGenerateRecipeJSON() — extraction + rewrite via ChatGPT
 * - _stepDownloadImages()    — downloads original images from scraped page
 */

import { BaseOrchestrator, sanitizeRecipeJSON, FILENAMES } from '../base-orchestrator.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { Logger } from '../../shared/utils/logger.js';
import {
  buildStyleDirective,
  EXTRACTION_PROMPT, buildRewritePrompt,
} from '../../shared/utils/prompts.js';
import { ScraperPage } from './scraper-page.js';
import { Downloader } from './downloader.js';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ScraperOrchestrator extends BaseOrchestrator {
  constructor(browser, context, serverCtx) {
    super(browser, context, serverCtx);
    this.scraper = new ScraperPage(browser, context);
  }

  get _stepHandlers() {
    return {
      ...this._sharedHandlers,
      [STATES.LOADING_JOB]: () => this._stepLoadJob(),
      [STATES.SCRAPING_SITE]: () => this._stepScrapeSite(),
      [STATES.GENERATING_RECIPE_JSON]: () => this._stepGenerateRecipeJSON(),
      [STATES.DOWNLOADING_IMAGES]: () => this._stepDownloadImages(),
      // Override image generation: scraper uses background + original only (no context accumulation)
      [STATES.GENERATING_STEPS]: () => this._stepGenerateStep(),
      [STATES.GENERATING_INGREDIENTS]: () => this._stepGenerateIngredients(),
      [STATES.GENERATING_HERO]: () => this._stepGenerateHero(),
    };
  }

  /**
   * After folder creation, scraper mode goes to DOWNLOADING_IMAGES
   * instead of GENERATING_STEPS.
   */
  _getPostFoldersState(settings) {
    return STATES.DOWNLOADING_IMAGES;
  }

  // ═══════════════════════════════════════════════════════
  // STEP: LOAD JOB (scraper mode)
  // ═══════════════════════════════════════════════════════

  async _stepLoadJob() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    if (!settings.sheetId) throw new Error('Google Sheet ID not configured.');

    // Use scraper-specific sheet settings
    const sheetSettings = {
      ...settings,
      sheetTabName: settings.scraperSheetTab || settings.sheetTabName || 'Scraping',
      topicColumn: settings.scraperUrlColumn || 'A',
      statusColumn: settings.scraperStatusColumn || 'B',
      startRow: settings.scraperStartRow || 2
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
      status: STATES.SCRAPING_SITE,
      recipeUrl: pending.topic,
      sheetRowIndex: pending.rowIndex,
      sheetSettings: {
        sheetTabName: sheetSettings.sheetTabName,
        statusColumn: sheetSettings.statusColumn
      }
    });
    Logger.success(`Found URL to scrape: "${pending.topic}" (row ${pending.rowIndex})`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: SCRAPE SITE (scraper mode only)
  // ═══════════════════════════════════════════════════════

  async _stepScrapeSite() {
    const state = await StateManager.getState();
    if (state.scrapedHTML) {
      await StateManager.updateState({ status: STATES.SELECTING_BACKGROUND });
      return;
    }

    const settings = await StateManager.getSettings();
    Logger.step('Scraper', 'Scraping recipe page...');

    const result = await this.scraper.scrape(state.recipeUrl, settings.contentSelectors);
    if (!result.html || result.html.length < 100) {
      throw new Error('Failed to scrape content from URL');
    }

    // Store scraped HTML
    await StateManager.storeImageData('scraped_html', Buffer.from(result.html).toString('base64'));

    await StateManager.updateState({
      status: STATES.SELECTING_BACKGROUND,
      recipeTitle: result.pageTitle || state.recipeUrl,
      scrapedHTML: true,
      scrapedImageUrls: result.imageUrls || []
    });
    Logger.success(`Scraped: "${result.pageTitle}" (${result.imageUrls?.length || 0} images found)`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE RECIPE JSON (scraper mode)
  // ═══════════════════════════════════════════════════════

  async _stepGenerateRecipeJSON() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const provider = settings.extractionProvider || 'chatgpt';
    Logger.step('Recipe', `Extracting with ${provider.toUpperCase()}, rewriting with ChatGPT for: ${state.recipeTitle}`);

    const vanillaPattern = /^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/?$/;
    const extractionUrl = (settings.extractionGptUrl && !vanillaPattern.test(settings.extractionGptUrl)) ? settings.extractionGptUrl : null;
    const rewriteUrl = (settings.rewriteGptUrl && !vanillaPattern.test(settings.rewriteGptUrl)) ? settings.rewriteGptUrl : null;
    const needsSeparateConversations = extractionUrl !== rewriteUrl;

    await this.chatgpt.init(extractionUrl);

    // ── Scrape mode: extract from HTML then rewrite ──────────────
    const scrapedBase64 = await StateManager.getImageData('scraped_html');
    if (!scrapedBase64) throw new Error('No scraped HTML found in storage');
    const scrapedHTML = Buffer.from(scrapedBase64, 'base64').toString('utf-8');

    // Step 1: Write HTML to temp file
    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, 'recipe-page.txt');
    writeFileSync(tmpFile, scrapedHTML);
    Logger.info(`Wrote scraped HTML to temp file (${scrapedHTML.length} chars)`);

    // Step 2: Download scraped images and save with mapped filenames
    // (like the extension: img1--domain--filename.jpg)
    const imageUrls = state.scrapedImageUrls || [];
    const imageMapping = []; // { url, mappedName, tmpPath }
    const imgTmpDir = join(tmpDir, 'scraped-images');
    mkdirSync(imgTmpDir, { recursive: true });

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        const mappedName = this._buildImageFilename(url, i);
        const downloaded = await Downloader.fetchImageAsBase64(url);
        if (downloaded) {
          const imgPath = join(imgTmpDir, mappedName);
          writeFileSync(imgPath, Buffer.from(downloaded, 'base64'));
          imageMapping.push({ url, mappedName, tmpPath: imgPath });
          Logger.info(`Downloaded image ${i + 1}/${imageUrls.length}: ${mappedName}`);
        }
      } catch (e) {
        Logger.debug(`Failed to download image ${i + 1}: ${e.message}`);
      }
    }
    Logger.success(`Downloaded ${imageMapping.length}/${imageUrls.length} scraped images`);

    // Build extraction prompt
    let extractionPrompt;
    if (extractionUrl) {
      // Custom GPT has extraction instructions baked in — send thin prompt
      extractionPrompt = 'Extract the recipe data from the uploaded HTML file and images. Output valid JSON only.';
      if (settings.contentSelectors) {
        extractionPrompt += `\nContent selectors: ${settings.contentSelectors}`;
      }
      Logger.info('Using Custom Extraction GPT');
    } else {
      // Fallback: full extraction prompt template (existing behavior)
      extractionPrompt = settings.extractionPromptTemplate?.trim()
        ? settings.extractionPromptTemplate
        : EXTRACTION_PROMPT;
      extractionPrompt = extractionPrompt.replace(/@content_selectors\b/gi, settings.contentSelectors || '');
    }

    // Append image mapping text so ChatGPT knows which file = which URL
    if (imageMapping.length > 0) {
      let mappingText = `\n\nI have uploaded ${imageMapping.length} images from the recipe page. Each image filename contains the original URL so you can identify them:\n`;
      for (const img of imageMapping) {
        mappingText += `- "${img.mappedName}" → original URL: ${img.url}\n`;
      }
      mappingText += '\nUse these uploaded images to visually identify which image is the hero, which belongs to each step, and which is the ingredients image. Assign the correct original URL to each field in the JSON.';
      extractionPrompt += mappingText;
    }

    if (provider === 'gemini') {
      Logger.info('Gemini selected — using ChatGPT as fallback (Gemini automation coming soon)');
    }

    // Step 3: Upload HTML file + images to ChatGPT
    await this.chatgpt.screenshot('before-upload');
    const allFiles = [tmpFile, ...imageMapping.map(m => m.tmpPath)];
    await this._uploadFilesToChatGPT(allFiles);
    await this.chatgpt.screenshot('after-upload');

    // Step 4: Send extraction prompt
    const extractResponse = await this.chatgpt.sendPromptAndGetResponse(extractionPrompt, true);
    if (!extractResponse.success) throw new Error(`Extraction failed: ${extractResponse.error}`);

    const extracted = extractResponse.data;
    // Normalize key names
    if (!extracted.steps && extracted.instructions) extracted.steps = extracted.instructions;
    if (!extracted.steps || !Array.isArray(extracted.steps)) {
      Logger.error('Extraction returned keys:', Object.keys(extracted).join(', '));
      throw new Error('Extraction failed: missing steps array.');
    }
    Logger.success(`Extracted recipe data: ${extracted.steps.length} steps`);

    // Step 5: Switch to rewrite GPT if needed
    if (needsSeparateConversations) {
      Logger.info('Switching to Rewrite GPT...');
      await this.chatgpt.close();
      await this.chatgpt.init(rewriteUrl);
    }

    // Step 6: Rewrite for SEO
    let rewritePrompt;
    if (rewriteUrl) {
      // Custom GPT has rewrite instructions baked in — send thin prompt
      const introIndex = (settings.introRotationIndex || 0) % (settings.introRotationTotal || 12);
      rewritePrompt = [
        `Rewrite this recipe JSON for SEO.`,
        `Categories: ${settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert'}`,
        `Use intro template #${introIndex + 1}.`,
        `Output valid JSON only.`,
        ``,
        JSON.stringify(extracted, null, 2)
      ].join('\n');
      Logger.info(`Using Custom Rewrite GPT (intro template #${introIndex + 1})`);
    } else if (settings.rewritePromptTemplate?.trim()) {
      rewritePrompt = settings.rewritePromptTemplate
        .replace(/@categories\b/gi, settings.wpCategories || '')
        + '\n\n' + JSON.stringify(extracted, null, 2);
    } else {
      const style = buildStyleDirective();
      rewritePrompt = buildRewritePrompt(extracted, style);
      if (settings.wpCategories) {
        rewritePrompt += `\n\nIMPORTANT: The "category" field MUST be one of these: ${settings.wpCategories}. Pick the best match.`;
      }
    }
    // Inject content templates (intro + conclusion) with shared rotation
    const introTemplates = settings.introTemplates || [];
    const conclusionTemplates = settings.conclusionTemplates || [];
    const idx = (settings.templateRotationIndex || 0) % Math.max(introTemplates.length, conclusionTemplates.length, 1);

    if (introTemplates.length > 0) {
      const introIdx = idx % introTemplates.length;
      rewritePrompt += `\n\nCRITICAL - INTRO REWRITE RULE:\nFor the "intro" field in the JSON, you MUST rewrite the template below to match this recipe. Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references and details. Do NOT add AI cliches. Keep it human and natural. Separate each paragraph with \\n\\n.\n\nINTRO TEMPLATE:\n${introTemplates[introIdx]}`;
      Logger.info(`Using intro template #${introIdx + 1}/${introTemplates.length}`);
    }

    if (conclusionTemplates.length > 0) {
      const concIdx = idx % conclusionTemplates.length;
      rewritePrompt += `\n\nCRITICAL - CONCLUSION REWRITE RULE:\nFor the "conclusion" field in the JSON, you MUST rewrite the template below to match this recipe. Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references and details. Do NOT add AI cliches. Keep it human and natural. Separate each paragraph with \\n\\n.\n\nCONCLUSION TEMPLATE:\n${conclusionTemplates[concIdx]}`;
      Logger.info(`Using conclusion template #${concIdx + 1}/${conclusionTemplates.length}`);
    }

    if (introTemplates.length > 0 || conclusionTemplates.length > 0) {
      settings.templateRotationIndex = idx + 1;
      await StateManager.saveSettings(settings);
    }

    const rewriteResponse = await this.chatgpt.sendPromptAndGetResponse(rewritePrompt, true);
    if (!rewriteResponse.success) throw new Error(`ChatGPT rewrite failed: ${rewriteResponse.error}`);

    const rewritten = sanitizeRecipeJSON(rewriteResponse.data);
    // Normalize key names (ChatGPT sometimes uses different keys)
    if (!rewritten.post_title && rewritten.title) rewritten.post_title = rewritten.title;
    if (!rewritten.steps && rewritten.instructions) rewritten.steps = rewritten.instructions;
    if (!rewritten.pro_tips && rewritten.tips) rewritten.pro_tips = rewritten.tips;
    if (!rewritten.storage_notes && rewritten.storage) rewritten.storage_notes = rewritten.storage;
    if (!rewritten.steps || !Array.isArray(rewritten.steps)) {
      Logger.error('Rewrite returned keys:', Object.keys(rewritten).join(', '));
      throw new Error('Rewrite failed: missing steps array.');
    }

    // Map to generate-mode format, preserving image URLs from extraction
    const recipe = {
      ...rewritten,
      hero_image_url: extracted.hero_image_url || rewritten.hero_image_url || null,
      ingredients_image_url: extracted.ingredients_image_url || rewritten.ingredients_image_url || null,
      hero_seo: rewritten.hero_seo || extracted.hero_seo || { filename: FILENAMES.hero, alt_text: rewritten.post_title || state.recipeTitle },
      ingredients_seo: rewritten.ingredients_seo || extracted.ingredients_seo || { filename: FILENAMES.ingredients, alt_text: 'Ingredients' },
      pro_tips: rewritten.pro_tips || rewritten.tips || extracted.tips || [],
      storage_notes: rewritten.storage_notes || rewritten.storage || extracted.storage || '',
      faq: rewritten.faq || extracted.faq || [],
      fun_fact: rewritten.fun_fact || extracted.fun_fact || '',
      equipment: rewritten.equipment || extracted.equipment || []
    };

    const steps = recipe.steps.map((step, i) => ({
      number: step.number || i + 1,
      title: step.title || step.name || `Step ${i + 1}`,
      description: step.description || step.text || '',
      tip: step.tip || '',
      prompt: step.image_prompt || step.prompt || '',
      image_url: step.image_url || (extracted.steps?.[i]?.image_url) || null,
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

    Logger.success(`Recipe JSON generated (scrape mode): ${steps.length} visual steps`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: DOWNLOAD IMAGES (scraper mode only)
  // ═══════════════════════════════════════════════════════

  async _stepDownloadImages() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    Logger.step('Download', 'Downloading original recipe images...');

    const recipe = state.recipeJSON;
    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals');
    // Clean old originals from previous run to avoid stale images
    if (existsSync(tmpDir)) {
      const oldFiles = readdirSync(tmpDir);
      for (const f of oldFiles) unlinkSync(join(tmpDir, f));
      Logger.info(`Cleaned ${oldFiles.length} old original images`);
    }
    mkdirSync(tmpDir, { recursive: true });

    let totalDownloaded = 0;

    // Download hero original
    if (recipe?.hero_image_url) {
      const b64 = await Downloader.fetchImageAsBase64(recipe.hero_image_url);
      if (b64) {
        writeFileSync(join(tmpDir, 'orig_hero.jpg'), Buffer.from(b64, 'base64'));
        await StateManager.storeImageData('orig_hero', b64);
        totalDownloaded++;
      }
    }

    // Download ingredients original
    if (recipe?.ingredients_image_url) {
      const b64 = await Downloader.fetchImageAsBase64(recipe.ingredients_image_url);
      if (b64) {
        writeFileSync(join(tmpDir, 'orig_ingredients.jpg'), Buffer.from(b64, 'base64'));
        await StateManager.storeImageData('orig_ingredients', b64);
        totalDownloaded++;
      }
    }

    // Download each step's original image
    for (let i = 0; i < (state.steps || []).length; i++) {
      const url = state.steps[i].image_url;
      if (url) {
        const b64 = await Downloader.fetchImageAsBase64(url);
        if (b64) {
          writeFileSync(join(tmpDir, `orig_step_${i}.jpg`), Buffer.from(b64, 'base64'));
          await StateManager.storeImageData(`orig_step_${i}`, b64);
          totalDownloaded++;
        }
      }
    }

    // Log what was found
    Logger.info(`Image URLs from JSON: hero=${recipe?.hero_image_url ? 'YES' : 'NULL'}, ingredients=${recipe?.ingredients_image_url ? 'YES' : 'NULL'}`);
    for (let i = 0; i < (state.steps || []).length; i++) {
      Logger.info(`  Step ${i + 1}: ${state.steps[i].image_url ? 'YES' : 'NULL'}`);
    }
    Logger.success(`Downloaded ${totalDownloaded} original images`);
    // Go to ingredients first (same order as generator: ingredients → steps → hero)
    await StateManager.updateState({ status: STATES.GENERATING_INGREDIENTS, currentStepIndex: 0 });
  }

  // ═══════════════════════════════════════════════════════
  // SCRAPER OVERRIDES: background + original only (no context accumulation)
  // ═══════════════════════════════════════════════════════

  async _stepGenerateStep() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const idx = state.currentStepIndex;
    const step = state.steps[idx];

    if (step.base64) { await this._advanceStep(); return; }

    // Scraper mode: skip generation if no original image exists for this step
    const origPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals', `orig_step_${idx}.jpg`);
    if (!step.image_url && !existsSync(origPath)) {
      Logger.info(`Step ${idx + 1}: No original image (null in JSON) — skipping generation`);
      await this._advanceStep();
      return;
    }

    Logger.step('Flow', `Step ${idx + 1}/${state.steps.length}: ${step.title}`);

    // Scraper mode: only use prefix + suffix from settings (user controls the prompt)
    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'steps');
    const aiPrompt = step.prompt || '';
    const stepVars = { '@prompt': aiPrompt, '@step_title': step.title || '', '@step_description': step.description || '', '@step_number': String(idx + 1) };
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, stepVars)
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, stepVars);

    // Background (random from folder)
    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, step.seo?.filename || FILENAMES.stepDefault(idx));

    // Scraper mode: only original image as context
    const contextPaths = [];
    if (existsSync(origPath)) contextPaths.push(origPath);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, backgroundPath, contextPaths, settings.stepAspectRatio || 'PORTRAIT', outputPath)
    );
    if (!ok) throw new Error(`Step ${idx + 1} image generation failed after 2 attempts`);

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`step_${idx}`, imgBuf.toString('base64'));

    const steps = [...state.steps];
    steps[idx] = { ...steps[idx], base64: true };
    await StateManager.updateState({ steps, backgroundQueueIndex: bgIndex + 1 });
    Logger.success(`Step ${idx + 1} image generated`);
    await this._advanceStep();
  }

  async _stepGenerateIngredients() {
    const state = await StateManager.getState();
    if (state.ingredientsImage?.base64) {
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    // First image of recipe — ensure fresh account with Nano Banana Pro (round-robin)
    await this._ensureProModelForNewRecipe();

    // Scraper mode: skip if no original ingredients image
    const ingOrigPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals', 'orig_ingredients.jpg');
    if (!state.recipeJSON?.ingredients_image_url && !existsSync(ingOrigPath)) {
      Logger.info('Ingredients: No original image (null in JSON) — skipping generation');
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    const settings = await StateManager.getSettings();
    Logger.step('Flow', 'Generating ingredients image...');

    // Scraper mode: only use prefix + suffix from settings (user controls the prompt)
    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'ingredients');
    const aiPrompt = state.recipeJSON?.ingredients_prompt || '';
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, { '@prompt': aiPrompt })
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, { '@prompt': aiPrompt });

    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = state.backgroundQueue[bgIndex];
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.ingredients_seo?.filename || FILENAMES.ingredients);

    // Scraper mode: only original ingredients image as context
    const contextPaths = [];
    const origPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals', 'orig_ingredients.jpg');
    if (existsSync(origPath)) contextPaths.push(origPath);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, backgroundPath, contextPaths, settings.ingredientAspectRatio || 'PORTRAIT', outputPath),
      true // first image — rotate immediately on rate limit
    );
    if (!ok) throw new Error('Ingredients image generation failed after 2 attempts');

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('ingredients', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0, ingredientsImage: { base64: true }, backgroundQueueIndex: bgIndex + 1 });
    Logger.success('Ingredients image generated');
  }

  async _stepGenerateHero() {
    const state = await StateManager.getState();
    if (state.heroImage?.base64) {
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }

    // Scraper mode: skip if no original hero image
    const heroOrigPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals', 'orig_hero.jpg');
    if (!state.recipeJSON?.hero_image_url && !existsSync(heroOrigPath)) {
      Logger.info('Hero: No original image (null in JSON) — skipping generation');
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }

    const settings = await StateManager.getSettings();
    Logger.step('Flow', 'Generating hero image...');

    // Scraper mode: only use prefix + suffix from settings (user controls the prompt)
    const { prefix: rawPrefix, suffix: rawSuffix } = this._getImagePrompts(settings, 'hero');
    const aiPrompt = state.recipeJSON?.hero_prompt || '';
    const prompt = this._resolvePromptPlaceholders(rawPrefix, state.recipeJSON, { '@prompt': aiPrompt })
      + this._resolvePromptPlaceholders(rawSuffix, state.recipeJSON, { '@prompt': aiPrompt });

    // Hero uses its own background
    if (!state.selectedHeroBackground?.base64) throw new Error('No hero background selected');
    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const heroTmpPath = join(tmpDir, FILENAMES.heroBgTemp);
    writeFileSync(heroTmpPath, Buffer.from(state.selectedHeroBackground.base64, 'base64'));

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.hero_seo?.filename || FILENAMES.hero);

    // Scraper mode: only original hero image as context
    const contextPaths = [];
    const origPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'originals', 'orig_hero.jpg');
    if (existsSync(origPath)) contextPaths.push(origPath);

    const ok = await this._generateWithRateLimitRetry(() =>
      this.flow.generate(prompt, heroTmpPath, contextPaths, settings.heroAspectRatio || 'LANDSCAPE', outputPath)
    );
    if (!ok) throw new Error('Hero image generation failed after 2 attempts');

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('hero', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.SAVING_FILES, heroImage: { base64: true } });
    Logger.success('Hero image generated');
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

  /**
   * Build a descriptive filename from URL: img1--domain--filename.jpg
   * (matches the Chrome extension approach)
   */
  _buildImageFilename(url, index) {
    try {
      const parsed = new URL(url);
      const domain = parsed.hostname.replace(/^www\./, '').replace(/[^a-zA-Z0-9.-]/g, '_');
      let filename = parsed.pathname.split('/').pop() || 'image';
      filename = filename.split('?')[0].replace(/[^a-zA-Z0-9._-]/g, '_');
      // Ensure image extension
      if (!/\.(jpg|jpeg|png|webp|gif|svg)$/i.test(filename)) {
        filename += '.jpg';
      }
      return `img${index + 1}--${domain}--${filename}`;
    } catch {
      return `img${index + 1}--unknown.jpg`;
    }
  }

  /**
   * Upload multiple files to ChatGPT (HTML + images).
   * Uses Playwright's setInputFiles which supports multiple files at once.
   */
  async _uploadFilesToChatGPT(filePaths) {
    if (!filePaths.length) return;

    Logger.info(`Uploading ${filePaths.length} files to ChatGPT...`);

    // Strategy 1: Find file input and set all files directly
    try {
      const fileInput = await this.chatgpt.page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(filePaths);
        await new Promise(r => setTimeout(r, 3000));
        Logger.info(`Uploaded ${filePaths.length} files via direct input`);
        return;
      }
    } catch (e) {
      Logger.debug('Direct file input failed:', e.message);
    }

    // Strategy 2: Use filechooser event with button click
    try {
      const [fileChooser] = await Promise.all([
        this.chatgpt.page.waitForEvent('filechooser', { timeout: 10000 }),
        this.chatgpt.page.evaluate(() => {
          const btns = document.querySelectorAll('button');
          for (const btn of btns) {
            const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (ariaLabel.includes('attach') || ariaLabel.includes('upload') ||
                ariaLabel.includes('file') || ariaLabel.includes('joindre')) {
              btn.click(); return;
            }
          }
          for (const btn of btns) {
            if (btn.textContent.trim() === '+') { btn.click(); return; }
          }
        })
      ]);
      await fileChooser.setFiles(filePaths);
      await new Promise(r => setTimeout(r, 3000));
      Logger.info(`Uploaded ${filePaths.length} files via filechooser`);
      return;
    } catch (e) {
      Logger.debug('Filechooser strategy failed:', e.message);
    }

    // Strategy 3: Click the file input directly
    try {
      await this.chatgpt.page.evaluate(() => {
        const input = document.querySelector('input[type="file"]');
        if (input) input.click();
      });
      const fileChooser = await this.chatgpt.page.waitForEvent('filechooser', { timeout: 5000 });
      await fileChooser.setFiles(filePaths);
      await new Promise(r => setTimeout(r, 3000));
      Logger.info(`Uploaded ${filePaths.length} files via input click`);
      return;
    } catch (e) {
      Logger.debug('Input click fallback failed:', e.message);
    }

    Logger.warn('All file upload strategies failed — extraction will proceed without images');
  }
}
