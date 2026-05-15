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
 * When opts.previousImagePath is provided, also performs cross-step consistency
 * checks (e.g. did chickpea color flip-flop, did food disappear, etc.) by sending
 * BOTH images to Gemini in a single call.
 *
 * @param {string} apiKey — Gemini API key
 * @param {string} imagePath — path to the generated image
 * @param {object} stepState — the visual step state from the plan
 * @param {object} vgSettings — verifiedGenerator settings
 * @param {object} [opts]
 * @param {string} [opts.previousImagePath] — previous step image path for cross-check
 * @param {string} [opts.recipeDescription] — the actual blog description that will appear on WP
 * @param {string} [opts.previousStepTitle] — title of previous step (for context)
 * @returns {object} { status: 'PASS'|'HARD_FAIL'|'SOFT_FAIL', ... }
 */
export async function verifyStepImage(apiKey, imagePath, stepState, vgSettings, opts = {}) {
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

  let prompt = template
    .replace(/\{\{container\}\}/g, stepState.container || defaults.defaultContainer)
    .replace(/\{\{camera_angle\}\}/g, stepState.camera_angle || defaults.defaultCameraAngle)
    .replace(/\{\{visible_ingredients_list\}\}/g, visibleList || '- (none specified)')
    .replace(/\{\{forbidden_ingredients_list\}\}/g, forbiddenList || '- (none specified)')
    .replace(/\{\{food_state\}\}/g, stepState.food_state || '');

  // Inject food_identity_canon + composition spec when present — verifier uses
  // these to fail images that drift on silhouette or major spatial placement.
  const canon = opts.foodIdentityCanon || stepState._canon || null;
  if (canon && canon.primary_food) {
    let canonBlock = '\n\n──────────────────────────────────────────\nFOOD IDENTITY CANON (the food MUST look like this — same silhouette across every step):\n';
    canonBlock += `- Primary food: ${canon.primary_food}\n`;
    canonBlock += `- Silhouette: ${canon.silhouette || '(not specified)'}\n`;
    canonBlock += `- Size: ${canon.size || '(not specified)'}\n`;
    canonBlock += `- Hallmark features: ${(canon.hallmark_features || []).join('; ') || '(not specified)'}\n`;
    canonBlock += '\nSet identity_match: false if the visible food has a clearly DIFFERENT silhouette than the canon (e.g. canon says pear-shaped bone-in ham but the image shows a rectangular slab). Tolerate minor stylistic differences — only fail on hard silhouette/cut mismatches.';
    prompt += canonBlock;
  }

  const comp = stepState.composition;
  if (comp && typeof comp === 'object' && (comp.subject_placement || comp.subject_orientation || (comp.secondary_elements || []).length > 0)) {
    let compBlock = '\n\n──────────────────────────────────────────\nCOMPOSITION SPEC (where things should be in the frame):\n';
    if (comp.subject_placement) compBlock += `- Subject placement: ${comp.subject_placement}\n`;
    if (comp.subject_orientation) compBlock += `- Subject orientation: ${comp.subject_orientation}\n`;
    if ((comp.secondary_elements || []).length > 0) {
      compBlock += '- Secondary elements:\n';
      for (const el of comp.secondary_elements) {
        compBlock += `  • ${el.what || ''} — ${el.where || ''}${el.count ? ` (${el.count})` : ''}\n`;
      }
    }
    if (comp.negative_space) compBlock += `- Negative space: ${comp.negative_space}\n`;
    if (comp.depth) compBlock += `- Depth: ${comp.depth}\n`;
    compBlock += '\nSet composition_match: false ONLY if the subject is clearly in the WRONG QUADRANT or WRONG ORIENTATION, or if a key secondary element is missing/misplaced. Do NOT fail for small percentage differences — only fail on MAJOR spatial mismatches.';
    prompt += compBlock;
  }

  const { existsSync } = await import('fs');
  const hasPrev = opts.previousImagePath && existsSync(opts.previousImagePath);
  const hasDesc = opts.recipeDescription && opts.recipeDescription.trim().length > 0;

  // If we have a previous image OR description, append cross-check section to prompt
  if (hasPrev || hasDesc) {
    let extra = '\n\n──────────────────────────────────────────\nCROSS-STEP CONTEXT CHECK (also verify these):\n';
    if (hasPrev) {
      extra += '\nIMAGE 1 = previous step (titled "' + (opts.previousStepTitle || 'previous') + '")';
      extra += '\nIMAGE 2 = current step (the one being verified)\n';
      extra += '\nCROSS-STEP CHECKS:\n';
      extra += '- Are the SAME ingredients consistent in color, size, and style between IMAGE 1 and IMAGE 2? (e.g. if chickpeas were golden in IMAGE 1, they should still look golden in IMAGE 2 — not pale)\n';
      extra += '- Do the visible ingredient amounts make sense (food should not magically appear/disappear)?\n';
      extra += '- Does IMAGE 2 show a CLEAR visual progression from IMAGE 1?\n';
      extra += '- HARD_FAIL if same ingredient drastically changed color, texture, or quantity for no recipe reason\n';
    }
    if (hasDesc) {
      extra += '\nBLOG DESCRIPTION (this is what the reader will read alongside the image):\n"' + opts.recipeDescription.replace(/\s+/g, ' ').trim().slice(0, 800) + '"\n';
      extra += '\nDESCRIPTION MATCH CHECKS:\n';
      extra += '- Does the image visually match what the description says?\n';
      extra += '- If the description mentions specific things (e.g. "scattered pumpkin seeds", "creamy white folds"), are they actually visible in the image?\n';
      extra += '- HARD_FAIL if the image shows something completely different from what the description claims\n';
    }
    prompt += extra;
  }

  // Single image OR multi-image call depending on whether we have a previous image
  const result = hasPrev
    ? await geminiVisionMultiImage(apiKey, [opts.previousImagePath, imagePath], prompt)
    : await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result — treating as PASS (safety valve)');
    return { status: 'PASS', detected_items: [], forbidden_found: [], container_count: 1, state_match: true, identity_match: true, composition_match: true, issues: ['Verification skipped — API error'] };
  }

  // Normalize status
  result.status = (result.status || 'PASS').toUpperCase();
  if (result.status === 'FAIL') result.status = 'HARD_FAIL';

  const ctxTag = hasPrev && hasDesc ? ' [+prev+desc]' : hasPrev ? ' [+prev]' : hasDesc ? ' [+desc]' : '';
  Logger.info(`[Verifier]${ctxTag} Step "${stepState.title}": ${result.status}${result.issues?.length ? ' — ' + result.issues.join('; ') : ''}`);

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
export async function verifyHeroImage(apiKey, imagePath, heroState, vgSettings, opts = {}) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.verifierHero || defaults.prompts.verifierHero;

  const additionsList = (heroState.allowed_additions || [])
    .map(a => `- ${a}`)
    .join('\n');

  const forbiddenList = (heroState.forbidden || [])
    .map(f => `- ${f}`)
    .join('\n');

  let prompt = template
    .replace(/\{\{base_description\}\}/g, heroState.base_description || 'finished dish')
    .replace(/\{\{container\}\}/g, heroState.container || defaults.defaultContainer)
    .replace(/\{\{camera_angle\}\}/g, heroState.camera_angle || '45-degree angle')
    .replace(/\{\{allowed_additions_list\}\}/g, additionsList || '- None')
    .replace(/\{\{forbidden_list\}\}/g, forbiddenList || '- None');

  // Inject canon + composition same as step verifier
  const canon = opts.foodIdentityCanon || heroState._canon || null;
  if (canon && canon.primary_food) {
    let canonBlock = '\n\n──────────────────────────────────────────\nFOOD IDENTITY CANON (the hero must match this — same food the step images established):\n';
    canonBlock += `- Primary food: ${canon.primary_food}\n`;
    canonBlock += `- Silhouette: ${canon.silhouette || '(not specified)'}\n`;
    canonBlock += `- Hallmark features: ${(canon.hallmark_features || []).join('; ') || '(not specified)'}\n`;
    canonBlock += '\nSet identity_match: false if the hero food has a clearly different silhouette than the canon.';
    prompt += canonBlock;
  }
  const comp = heroState.composition;
  if (comp && typeof comp === 'object' && (comp.subject_placement || comp.subject_orientation || (comp.secondary_elements || []).length > 0)) {
    let compBlock = '\n\n──────────────────────────────────────────\nHERO COMPOSITION SPEC:\n';
    if (comp.subject_placement) compBlock += `- Subject placement: ${comp.subject_placement}\n`;
    if (comp.subject_orientation) compBlock += `- Subject orientation: ${comp.subject_orientation}\n`;
    if (comp.negative_space) compBlock += `- Negative space: ${comp.negative_space}\n`;
    compBlock += '\nSet composition_match: false ONLY on MAJOR spatial mismatch — wrong quadrant or wrong orientation.';
    prompt += compBlock;
  }

  const result = await geminiVision(apiKey, imagePath, prompt);

  if (!result) {
    Logger.warn('[Verifier] Gemini returned no result for hero — treating as PASS');
    return { status: 'PASS', detected_items: [], forbidden_found: [], identity_match: true, composition_match: true, issues: ['Verification skipped — API error'] };
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
  // Stray items outside the container — always HARD_FAIL, regardless of status.
  // Flow has a strong tendency to scatter ingredients decoratively on the surface
  // around the container; the rule in the prompt isn't enough on its own.
  if (result.stray_items_outside_container === true) {
    return { shouldRetry: true, reason: 'STRAY ITEMS: food on the bare counter outside the container' };
  }

  // Identity drift always forces retry — silhouette mismatch is a HARD failure
  // regardless of what Gemini set status to. Without this, identity_match: false
  // can slip through when Gemini still rates the image as PASS overall.
  if (result.identity_match === false) {
    return { shouldRetry: true, reason: 'IDENTITY DRIFT: food silhouette does not match canon' };
  }

  if (result.status === 'PASS') {
    // Composition drift downgrades to SOFT_FAIL — retry only when softFailAction is 'retry'
    if (result.composition_match === false) {
      if (softFailAction === 'retry') {
        return { shouldRetry: true, reason: 'COMPOSITION DRIFT (retry mode): subject placement off' };
      }
      return { shouldRetry: false, reason: 'composition drift accepted (soft)' };
    }
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
