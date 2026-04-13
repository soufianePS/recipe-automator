/**
 * Prompt Builder — converts structured visual state JSON into Flow text prompts.
 *
 * Sends structured JSON to Flow with arrangement details so Nano Banana
 * knows exactly WHERE and HOW to place each ingredient.
 */

import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';

/**
 * Build a Flow prompt for a recipe step image.
 */
export function buildStepPrompt(stepState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;

  const jsonPrompt = {
    task: "Photorealistic food photography",
    step_id: stepState.step_id,
    image_type: "recipe_step",
    container: stepState.container || defaults.defaultContainer,
    camera: stepState.camera_angle || defaults.defaultCameraAngle,
    lighting: vgSettings?.defaultLighting || defaults.defaultLighting,
    background: "MUST match the uploaded reference image — keep the same surface, texture, and color. Do NOT change or replace the background.",
    visible_ingredients: (stepState.visible_ingredients || []).map(ing => {
      if (typeof ing === 'string') return ing;
      let desc = `${ing.name}: ${ing.state}`;
      if (ing.placement) desc += ` (${ing.placement})`;
      return desc;
    }),
    forbidden_ingredients: stepState.forbidden_ingredients || [],
    state: stepState.food_state || '',
    position_change: stepState.position || '',
    arrangement: stepState.arrangement || '',
    rules: [
      "Only 1 container visible",
      "No extra bowls, plates, utensils, or props",
      "No garnish unless listed in visible_ingredients",
      "No ingredients outside visible_ingredients list",
      "Show ONLY this step, not future steps",
      "All food must be inside the container",
      "No text, no watermark",
      "KEEP the uploaded background exactly — same surface, same texture, same color",
      "Food must look natural and homemade — slight imperfections, uneven sauce, casual placement",
      "Do NOT make food look perfectly arranged or symmetrical",
      "Follow the arrangement description for composition"
    ]
  };

  // Remove empty arrangement to keep prompt clean
  if (!jsonPrompt.arrangement) delete jsonPrompt.arrangement;

  return JSON.stringify(jsonPrompt, null, 2);
}

/**
 * Build a Flow prompt for the ingredients flat-lay image.
 */
export function buildIngredientsPrompt(ingredientsState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;

  const jsonPrompt = {
    task: "Photorealistic food photography — ingredients flat lay",
    image_type: "ingredients",
    layout: ingredientsState.layout || "flat lay arrangement on background",
    camera: ingredientsState.camera_angle || defaults.defaultCameraAngle,
    lighting: vgSettings?.defaultLighting || defaults.defaultLighting,
    background: "MUST match the uploaded reference image — keep the same surface, texture, color",
    ingredients: (ingredientsState.items || []).map(item => {
      const entry = {
        name: item.name,
        state: item.state,
        presentation: item.presentation || "separate"
      };
      if (item.placement) entry.placement = item.placement;
      return entry;
    }),
    forbidden: ingredientsState.forbidden || ["cooked food", "mixed items", "garnish", "utensils"],
    rules: [
      "CRITICAL: Every single ingredient MUST be inside its own small bowl, plate, or dish — NOTHING placed directly on the background surface",
      "Proteins on small white plates, liquids in small glass bowls, spices in small ceramic ramekins, herbs in tiny dishes",
      "Arrange containers in a clean grid or circular pattern with clear spacing",
      "Nothing touching or overlapping — each container fully visible",
      "No ingredient is cooked or mixed",
      "No garnish, no utensils, no extra props",
      "No text, no watermark",
      "Professional food magazine quality — clean, organized, appetizing"
    ]
  };

  return JSON.stringify(jsonPrompt, null, 2);
}

/**
 * Build a Flow prompt for the hero/final image.
 */
export function buildHeroPrompt(heroState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;

  const jsonPrompt = {
    task: "Photorealistic food photography — hero shot",
    image_type: "hero",
    description: heroState.base_description || "finished dish",
    container: heroState.container || defaults.defaultContainer,
    camera: heroState.camera_angle || "45-degree angle",
    lighting: vgSettings?.defaultLighting || defaults.defaultLighting,
    background: "MUST match the uploaded reference image — keep the same surface, texture, color",
    arrangement: heroState.arrangement || "appetizing final presentation, magazine-quality plating",
    allowed_additions: heroState.allowed_additions || [],
    forbidden: heroState.forbidden || ["raw ingredients", "extra bowls", "utensils"],
    rules: [
      "Show the FINISHED dish only — fully cooked, appetizing",
      "Magazine-quality presentation and plating",
      "Follow the arrangement description for garnish placement and sauce drizzle",
      "No raw ingredients visible",
      "No extra containers or utensils",
      "No text, no watermark"
    ]
  };

  return JSON.stringify(jsonPrompt, null, 2);
}

/**
 * Build a correction prompt after a failed verification.
 */
export function buildCorrectionPrompt(stepState, verifierResult, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const template = vgSettings?.prompts?.correction || defaults.prompts.correction;

  const issuesList = (verifierResult.issues || [])
    .map(issue => `- ${issue}`)
    .join('\n');

  const fixes = [];
  if (verifierResult.forbidden_found?.length > 0) {
    for (const item of verifierResult.forbidden_found) {
      fixes.push(`- REMOVE: ${item}`);
    }
  }
  if (verifierResult.container_count > 1) {
    fixes.push(`- Show only 1 container (found ${verifierResult.container_count})`);
  }
  if (verifierResult.state_match === false) {
    fixes.push(`- Fix food state: must show "${stepState.food_state}"`);
  }
  if (verifierResult.missing_ingredients?.length > 0) {
    for (const item of verifierResult.missing_ingredients) {
      fixes.push(`- ADD missing: ${item}`);
    }
  }
  if (verifierResult.extra_items?.length > 0) {
    for (const item of verifierResult.extra_items) {
      fixes.push(`- REMOVE extra: ${item}`);
    }
  }

  return template
    .replace(/\{\{issues_list\}\}/g, issuesList || '- Unknown issue')
    .replace(/\{\{fixes_list\}\}/g, fixes.join('\n') || '- Re-generate following all previous rules');
}
