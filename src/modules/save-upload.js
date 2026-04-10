/**
 * Save & Upload — file saving, media upload, and sheet update steps
 * Extracted from BaseOrchestrator._stepSaveFiles(), _stepUploadMedia(), _stepUpdateSheet()
 */

import { StateManager, STATES } from '../shared/utils/state-manager.js';
import { SheetsAPI } from '../shared/utils/sheets-api.js';
import { WordPressAPI } from '../shared/utils/wordpress-api.js';
import { Logger } from '../shared/utils/logger.js';
import { sanitizeFilename, FILENAMES } from './base-orchestrator.js';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';

/**
 * Save all generated images and recipe JSON to disk.
 *
 * @param {object} state     - Current automation state
 * @param {string} outputDir - Target directory path
 */
export async function saveFiles(state, outputDir) {
  Logger.step('Save', 'Saving files to disk...');

  try {
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
  } catch (e) {
    Logger.warn('Folder create error (retrying):', e.message);
    await new Promise(r => setTimeout(r, 2000));
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
  }

  // Save backgrounds
  if (state.selectedHeroBackground?.base64) {
    await writeFile(join(outputDir, FILENAMES.heroBackground), Buffer.from(state.selectedHeroBackground.base64, 'base64'));
  }
  if (state.selectedStepsBackground?.base64) {
    await writeFile(join(outputDir, FILENAMES.stepsBackground), Buffer.from(state.selectedStepsBackground.base64, 'base64'));
  }

  // Helper: safe save — skip if file already exists (already saved during generation)
  const safeSave = async (filePath, data) => {
    if (existsSync(filePath)) {
      Logger.debug(`Already exists, skipping: ${basename(filePath)}`);
      return;
    }
    try {
      await writeFile(filePath, data);
    } catch (e) {
      Logger.warn(`Save retry for ${basename(filePath)}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
      try { await writeFile(filePath, data); } catch {}
    }
  };

  // Save hero
  const heroBase64 = await StateManager.getImageData('hero');
  if (heroBase64) {
    const name = sanitizeFilename(state.recipeJSON?.hero_seo?.filename || FILENAMES.hero);
    await safeSave(join(outputDir, name), Buffer.from(heroBase64, 'base64'));
  }

  // Save ingredients
  const ingBase64 = await StateManager.getImageData('ingredients');
  if (ingBase64) {
    const name = sanitizeFilename(state.recipeJSON?.ingredients_seo?.filename || FILENAMES.ingredients);
    await safeSave(join(outputDir, name), Buffer.from(ingBase64, 'base64'));
  }

  // Save steps
  for (let i = 0; i < state.steps.length; i++) {
    const stepBase64 = await StateManager.getImageData(`step_${i}`);
    if (stepBase64) {
      const name = sanitizeFilename(state.steps[i]?.seo?.filename || FILENAMES.stepDefault(i));
      await safeSave(join(outputDir, name), Buffer.from(stepBase64, 'base64'));
    }
  }

  // Save pin images
  for (let i = 0; i < (state.pinterestPins || []).length; i++) {
    const pinBase64 = await StateManager.getImageData(`pin_${i}`);
    if (pinBase64) {
      await safeSave(join(outputDir, `pin-${i + 1}.jpg`), Buffer.from(pinBase64, 'base64'));
    }
  }

  // Save recipe.json
  if (state.recipeJSON) {
    await writeFile(join(outputDir, FILENAMES.recipeJSON), JSON.stringify(state.recipeJSON, null, 2));
  }

  await StateManager.updateState({ status: STATES.UPLOADING_MEDIA });
  Logger.success('All files saved to:', outputDir);
}

/**
 * Upload all recipe images to WordPress.
 *
 * @param {object} state    - Current automation state
 * @param {object} settings - User settings
 */
export async function uploadMedia(state, settings) {
  Logger.step('WordPress', 'Uploading images...');

  if (!settings.wpUrl || !settings.wpUsername || !settings.wpAppPassword) {
    throw new Error('WordPress credentials not configured.');
  }

  // Verify all required images exist before uploading to WordPress
  const heroOk = !!await StateManager.getImageData('hero');
  const stepsOk = state.steps.every((s, i) => !s.base64 || !!s.base64);
  if (!heroOk && !state.heroImage?.base64) {
    Logger.warn('Hero image missing — skipping WordPress upload');
  }

  const uploads = await WordPressAPI.uploadAllRecipeImages(
    settings, state, (msg) => Logger.info(msg)
  );

  await StateManager.updateState({
    status: STATES.PUBLISHING_DRAFT,
    heroImage: uploads.heroImage || state.heroImage,
    ingredientsImage: uploads.ingredientsImage || state.ingredientsImage,
    steps: uploads.steps || state.steps
  });
  Logger.success('All images uploaded to WordPress');
}

/**
 * Mark the Google Sheet row as done.
 *
 * @param {object} state    - Current automation state
 * @param {object} settings - User settings
 */
export async function updateSheet(state, settings) {
  Logger.step('Sheet', 'Updating Google Sheet...');

  // Use stored sheet settings from loadJob if available, otherwise fall back to global settings
  const effectiveSettings = state.sheetSettings
    ? { ...settings, sheetTabName: state.sheetSettings.sheetTabName, statusColumn: state.sheetSettings.statusColumn }
    : settings;

  try {
    if (!effectiveSettings.appsScriptUrl) {
      Logger.warn('Apps Script URL not set. Sheet not updated.');
    } else {
      // Build pinterest pin data for sheet columns
      const pinData = {
        category: state.recipeJSON?.category || '',
        pins: (state.pinterestPins || []).map(pin => ({
          imageUrl: pin.wpImageUrl || '',
          description: pin.description || '',
          title: pin.title || '',
          tags: (pin.description || '').match(/#\w+/g)?.join(' ') || ''
        }))
      };
      await SheetsAPI.markDone(effectiveSettings, state.sheetRowIndex, state.draftUrl || '', pinData);
      Logger.success(`Sheet row ${state.sheetRowIndex} marked as done (tab: ${effectiveSettings.sheetTabName})`);
    }
  } catch (e) {
    Logger.error(`Sheet update failed: ${e.message}`);
  }

  await StateManager.updateState({ status: STATES.COMPLETED });
}
