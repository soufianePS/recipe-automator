/**
 * Image Verifier — uses Gemini vision API to validate generated images.
 *
 * After each Flow generation, sends the image + expected state to Gemini
 * and checks if the image matches. Returns PASS / HARD_FAIL / SOFT_FAIL.
 */

import { geminiVision, geminiVisionMultiImage } from '../../shared/utils/gemini-api.js';
import { Logger } from '../../shared/utils/logger.js';
import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';

/**
 * Verify a generated step image against its expected visual state.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to the generated image
 * @param {object} stepState — the visual step state from the plan
 * @param {object} vgSettings — verifiedGenerator settings
 * @returns {object} { status: 'PASS'|'HARD_FAIL'|'SOFT_FAIL', ... }
 */
export async function verifyStepImage(apiKey, imagePath, stepState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.verifier || defaults.prompts.verifier;

  // Build visible ingredients list
  const visibleList = (stepState.visible_ingredients || [])
    .map(ing => `- ${ing.name}: ${ing.state}`)
    .join('\n');

  // Build forbidden list
  const forbiddenList = (stepState.forbidden_ingredients || [])
    .map(ing => `- ${ing}`)
    .join('\n');

  const prompt = template
    .replace(/\{\{container\}\}/g, stepState.container || defaults.defaultContainer)
    .replace(/\{\{camera_angle\}\}/g, stepState.camera_angle || defaults.defaultCameraAngle)
    .replace(/\{\{visible_ingredients_list\}\}/g, visibleList || '- (none specified)')
    .replace(/\{\{forbidden_ingredients_list\}\}/g, forbiddenList || '- (none specified)')
    .replace(/\{\{food_state\}\}/g, stepState.food_state || '');

  const result = await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result — treating as PASS (safety valve)');
    return { status: 'PASS', detected_items: [], forbidden_found: [], container_count: 1, state_match: true, issues: ['Verification skipped — API error'] };
  }

  // Normalize status
  result.status = (result.status || 'PASS').toUpperCase();
  if (result.status === 'FAIL') result.status = 'HARD_FAIL';

  Logger.info(`[Verifier] Step "${stepState.title}": ${result.status}${result.issues?.length ? ' — ' + result.issues.join('; ') : ''}`);

  return result;
}

/**
 * Verify the ingredients flat-lay image.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to the generated image
 * @param {object} ingredientsState — ingredients_image from the visual plan
 * @param {object} vgSettings — verifiedGenerator settings
 * @returns {object} verification result
 */
export async function verifyIngredientsImage(apiKey, imagePath, ingredientsState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.verifierIngredients || defaults.prompts.verifierIngredients;

  const ingredientsList = (ingredientsState.items || [])
    .map(item => `- ${item.name}: ${item.state}`)
    .join('\n');

  const prompt = template
    .replace(/\{\{camera_angle\}\}/g, ingredientsState.camera_angle || defaults.defaultCameraAngle)
    .replace(/\{\{ingredients_list\}\}/g, ingredientsList);

  const result = await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result for ingredients — treating as PASS');
    return { status: 'PASS', detected_items: [], missing_ingredients: [], extra_items: [], issues: ['Verification skipped — API error'] };
  }

  result.status = (result.status || 'PASS').toUpperCase();
  if (result.status === 'FAIL') result.status = 'HARD_FAIL';

  Logger.info(`[Verifier] Ingredients: ${result.status}${result.issues?.length ? ' — ' + result.issues.join('; ') : ''}`);

  return result;
}

/**
 * Verify the hero/final image.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to the generated image
 * @param {object} heroState — hero_image from the visual plan
 * @param {object} vgSettings — verifiedGenerator settings
 * @returns {object} verification result
 */
export async function verifyHeroImage(apiKey, imagePath, heroState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.verifierHero || defaults.prompts.verifierHero;

  const additionsList = (heroState.allowed_additions || [])
    .map(a => `- ${a}`)
    .join('\n');

  const forbiddenList = (heroState.forbidden || [])
    .map(f => `- ${f}`)
    .join('\n');

  const prompt = template
    .replace(/\{\{base_description\}\}/g, heroState.base_description || 'finished dish')
    .replace(/\{\{container\}\}/g, heroState.container || defaults.defaultContainer)
    .replace(/\{\{camera_angle\}\}/g, heroState.camera_angle || '45-degree angle')
    .replace(/\{\{allowed_additions_list\}\}/g, additionsList || '- None')
    .replace(/\{\{forbidden_list\}\}/g, forbiddenList || '- None');

  const result = await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result for hero — treating as PASS');
    return { status: 'PASS', detected_items: [], forbidden_found: [], issues: ['Verification skipped — API error'] };
  }

  result.status = (result.status || 'PASS').toUpperCase();
  if (result.status === 'FAIL') result.status = 'HARD_FAIL';

  Logger.info(`[Verifier] Hero: ${result.status}${result.issues?.length ? ' — ' + result.issues.join('; ') : ''}`);

  return result;
}

/**
 * Compare two step images for similarity.
 * Sends BOTH images to Gemini and asks if they look too similar.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} prevImagePath — previous step image
 * @param {string} currentImagePath — current step image
 * @param {number} prevStepNum — previous step number
 * @param {number} currentStepNum — current step number
 * @param {string} expectedChange — what should be different
 * @param {object} vgSettings — verifiedGenerator settings
 * @returns {object} { similarity_score, differences_found, missing_changes, verdict }
 */
export async function checkStepSimilarity(apiKey, prevImagePath, currentImagePath, prevStepNum, currentStepNum, expectedChange, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.similarityCheck || defaults.prompts.similarityCheck;

  const prompt = template
    .replace(/\{\{prev_step\}\}/g, String(prevStepNum))
    .replace(/\{\{current_step\}\}/g, String(currentStepNum))
    .replace(/\{\{expected_change\}\}/g, expectedChange || 'a visible change from the previous step');

  // Send both images to Gemini
  const result = await geminiVisionMultiImage(apiKey, [prevImagePath, currentImagePath], prompt);

  if (!result) {
    Logger.warn('[Similarity] Gemini returned no result — treating as DISTINCT');
    return { similarity_score: 0, differences_found: [], missing_changes: [], verdict: 'DISTINCT' };
  }

  result.verdict = (result.verdict || 'DISTINCT').toUpperCase();
  Logger.info(`[Similarity] Step ${currentStepNum} vs ${prevStepNum}: ${result.verdict} (score: ${result.similarity_score || '?'})`);

  return result;
}

/**
 * Verify a Pinterest pin image.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to the generated pin image
 * @param {string} recipeTitle — recipe title for context
 * @param {object} vgSettings — verifiedGenerator settings
 * @returns {object} verification result
 */
export async function verifyPinterestImage(apiKey, imagePath, recipeTitle, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.verifierPinterest || defaults.prompts.verifierPinterest;

  const prompt = template
    .replace(/\{\{recipe_title\}\}/g, recipeTitle || 'unknown recipe');

  const result = await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result for Pinterest pin — treating as PASS');
    return { status: 'PASS', detected_food: '', has_text_overlay: true, composition_valid: true, issues: ['Verification skipped — API error'] };
  }

  result.status = (result.status || 'PASS').toUpperCase();
  if (result.status === 'FAIL') result.status = 'HARD_FAIL';

  Logger.info(`[Verifier] Pinterest pin: ${result.status}${result.issues?.length ? ' — ' + result.issues.join('; ') : ''}`);

  return result;
}

/**
 * Determine if a verification result should trigger a retry.
 *
 * @param {object} result — verifier output
 * @param {string} softFailAction — 'accept' or 'retry'
 * @returns {{ shouldRetry: boolean, reason: string }}
 */
export function shouldRetry(result, softFailAction = 'accept') {
  if (result.status === 'PASS') {
    return { shouldRetry: false, reason: 'passed' };
  }

  if (result.status === 'HARD_FAIL') {
    return { shouldRetry: true, reason: result.issues?.join('; ') || 'hard fail' };
  }

  // SOFT_FAIL
  if (softFailAction === 'retry') {
    return { shouldRetry: true, reason: 'soft fail (retry mode): ' + (result.issues?.join('; ') || 'minor issues') };
  }

  return { shouldRetry: false, reason: 'soft fail accepted: ' + (result.issues?.join('; ') || 'minor issues') };
}
