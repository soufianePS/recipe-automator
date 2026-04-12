/**
 * Visual Planner — ChatGPT pass 2
 *
 * Takes the recipe JSON and asks ChatGPT to produce a structured
 * visual production plan (ingredients image, 4-8 visual steps, hero image).
 * Each step has exact visible/forbidden ingredients, food state, and context policy.
 */

import { Logger } from '../../shared/utils/logger.js';
import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';

/**
 * Build the visual plan prompt from template + recipe data.
 *
 * @param {object} recipeJSON — the recipe JSON from ChatGPT pass 1
 * @param {object} vgSettings — verifiedGenerator settings from settings.json
 * @returns {string} the prompt to send to ChatGPT
 */
export function buildVisualPlanPrompt(recipeJSON, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.visualPlan || defaults.prompts.visualPlan;

  const minSteps = vgSettings?.minVisualSteps || defaults.minVisualSteps;
  const maxSteps = vgSettings?.maxVisualSteps || defaults.maxVisualSteps;
  const container = vgSettings?.defaultContainer || defaults.defaultContainer;
  const cameraAngle = vgSettings?.defaultCameraAngle || defaults.defaultCameraAngle;

  // Replace placeholders
  let prompt = template
    .replace(/\{\{min_steps\}\}/g, String(minSteps))
    .replace(/\{\{max_steps\}\}/g, String(maxSteps))
    .replace(/\{\{default_container\}\}/g, container)
    .replace(/\{\{default_camera_angle\}\}/g, cameraAngle)
    .replace(/\{\{recipe_json\}\}/g, JSON.stringify(recipeJSON, null, 2));

  return prompt;
}

/**
 * Parse and validate the visual plan JSON returned by ChatGPT.
 *
 * @param {object} rawPlan — parsed JSON from ChatGPT response
 * @param {object} vgSettings — for min/max step validation
 * @returns {object} validated plan: { ingredients_image, visual_steps, hero_image }
 * @throws {Error} if the plan is invalid
 */
export function validateVisualPlan(rawPlan, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const minSteps = vgSettings?.minVisualSteps || defaults.minVisualSteps;
  const maxSteps = vgSettings?.maxVisualSteps || defaults.maxVisualSteps;

  if (!rawPlan) throw new Error('Visual plan is empty');

  // Validate ingredients_image
  if (!rawPlan.ingredients_image) {
    throw new Error('Visual plan missing ingredients_image');
  }
  if (!Array.isArray(rawPlan.ingredients_image.items) || rawPlan.ingredients_image.items.length === 0) {
    throw new Error('Visual plan ingredients_image has no items');
  }

  // Validate visual_steps
  if (!Array.isArray(rawPlan.visual_steps) || rawPlan.visual_steps.length === 0) {
    throw new Error('Visual plan has no visual_steps');
  }
  if (rawPlan.visual_steps.length < minSteps || rawPlan.visual_steps.length > maxSteps) {
    Logger.warn(`[VisualPlan] Step count ${rawPlan.visual_steps.length} outside range ${minSteps}-${maxSteps} — accepting anyway`);
  }

  // Validate each step has required fields
  for (let i = 0; i < rawPlan.visual_steps.length; i++) {
    const step = rawPlan.visual_steps[i];
    if (!step.title) step.title = `Step ${i + 1}`;
    if (!step.container) step.container = vgSettings?.defaultContainer || defaults.defaultContainer;
    if (!step.camera_angle) step.camera_angle = vgSettings?.defaultCameraAngle || defaults.defaultCameraAngle;
    if (!Array.isArray(step.visible_ingredients)) step.visible_ingredients = [];
    if (!Array.isArray(step.forbidden_ingredients)) step.forbidden_ingredients = [];
    if (!step.food_state) step.food_state = '';
    if (!step.continuity) step.continuity = { uses_previous_image: false, reason: 'not specified' };
    step.step_id = i + 1;
  }

  // Validate hero_image
  if (!rawPlan.hero_image) {
    throw new Error('Visual plan missing hero_image');
  }

  Logger.info(`[VisualPlan] Validated: ${rawPlan.ingredients_image.items.length} ingredients, ${rawPlan.visual_steps.length} visual steps`);

  return {
    ingredients_image: rawPlan.ingredients_image,
    visual_steps: rawPlan.visual_steps,
    hero_image: rawPlan.hero_image
  };
}
