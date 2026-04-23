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
export function buildStepPrompt(stepState, vgSettings, opts = {}) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const isServingStep = opts.isLastStep || false;

  const rules = [
    "Show only the specified container — no extra bowls, plates, utensils, or props",
    "No garnish unless listed in visible_ingredients",
    "No ingredients outside visible_ingredients list",
    "Show ONLY this step, not future steps",
    "All food must be inside the container",
    "No text, no watermark",
    isServingStep
      ? "REPLACE the uploaded background — render the food on a BRIGHT WHITE surface (white marble / white linen / white wood / clean white countertop). Bright natural daylight. Pinterest-style. Do NOT use the dark/wood/moody reference surface for this final serving shot."
      : "KEEP the uploaded background exactly — same surface, same texture, same color",
    "Food must look natural and homemade — slight imperfections, uneven sauce, casual placement",
    "Do NOT make food look perfectly arranged or symmetrical",
    "Follow the position_change description for food placement and movement",
    // IMAGE QUALITY RULES — apply to ALL steps
    "WARM COLOR TONES — food must have warm inviting colors. Golden-brown for cooked items. Rich deep colors for sauces. Vibrant greens for vegetables. NO grey or washed-out food",
    "SHARP FOCUS — the food must be in crisp sharp focus with visible texture detail. You should see grain in rice and fibers in meat and bubbles in sauce and flakes in pastry",
    "DEPTH AND DIMENSION — food must look 3D with volume. Not flat. Sauce should glisten. Cheese should stretch or melt unevenly. Meat should have visible sear marks",
    "MOISTURE AND FRESHNESS — food must look fresh and moist. Vegetables look crisp. Sauces look glossy. Nothing looks dried out or stale"
  ];

  // Serving/last step gets extra quality rules
  if (isServingStep) {
    rules.push(
      "This is the SERVING step — the food MUST look absolutely delicious and appetizing",
      "Show texture detail: glossy sauce and melted cheese and crispy edges and juicy interior",
      "The portion must look generous and satisfying — not flat or empty",
      "Professional food blog quality — the image a reader would save or share",
      "Close-up angle showing the best features of the dish",
      "This image must make someone immediately hungry when they see it"
    );
  }

  const jsonPrompt = {
    task: isServingStep ? "Photorealistic food photography — SERVING SHOT (must look delicious and appetizing)" : "Photorealistic food photography",
    step_id: stepState.step_id,
    image_type: isServingStep ? "serving_step" : "recipe_step",
    container: stepState.container || defaults.defaultContainer,
    camera: stepState.camera_angle || defaults.defaultCameraAngle,
    lighting: isServingStep
      ? "bright natural daylight from a large window, soft diffused highlights, very airy and luminous, Pinterest-style"
      : (vgSettings?.defaultLighting || defaults.defaultLighting),
    background: isServingStep
      ? "IGNORE the uploaded reference image for the background. Use a BRIGHT WHITE or pale light-grey photographic surface — white marble, white linen tablecloth, white wood plank, or clean white countertop. Blurred, slightly out-of-focus background. Pinterest / food-blog aesthetic — airy, luminous, clean."
      : "MUST match the uploaded reference image — keep the same surface, texture, and color. Do NOT change or replace the background.",
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
    rules
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
    layout: ingredientsState.layout || "Natural asymmetric scatter across the ENTIRE surface edge-to-edge. Mixed forms — whole items, standing packaged products, and only a few small ramekins for chopped/grated bits. Items at different heights and different distances apart. NO grid, NO circle, NO matching bowls.",
    camera: ingredientsState.camera_angle || defaults.defaultCameraAngle,
    lighting: vgSettings?.defaultLighting || defaults.defaultLighting,
    background: "MUST be the uploaded reference image filling the ENTIRE frame edge-to-edge. No blank space, no white borders, no cropping. Preserve exact grain, color, stripes, and texture.",
    ingredients: (ingredientsState.items || []).map(item => {
      const entry = {
        name: item.name,
        state: item.state,
        presentation: item.presentation || "whole or natural form"
      };
      if (item.brand) entry.brand = item.brand;
      if (item.placement) entry.placement = item.placement;
      return entry;
    }),
    forbidden: ingredientsState.forbidden || ["cooked food", "mixed items", "garnish", "utensils", "grid layout", "identical bowls for every item", "blank unlabeled packaging"],
    rules: [
      "NATURAL SCATTER — items placed organically with asymmetric spacing. NO grid, NO circle, NO straight lines, NO symmetric arrangement",
      "USE REAL FORMS — whole vegetables as-is (whole potatoes, whole garlic, whole onion), bottles upright, boxes and bags upright, jars with labels forward",
      "REAL PRODUCT PACKAGING — every packaged ingredient (oils, spices, flours, sugars, sauces, canned goods) MUST show believable brand-labeled packaging. Invent fake brand names like 'Heath Riles BBQ', 'Great Value Flour', 'Sun Harvest Sugar', 'GRAZA Oil' — labels face forward and are readable. NEVER blank/sterile unlabeled containers",
      "LIMITED SMALL RAMEKINS — ONLY finely chopped herbs, spices, grated cheese, or pre-diced items go in small ramekins (2-4 max). Everything else stays in its whole / packaged / plated form",
      "VARY CONTAINER SIZES — some large plates, some tiny ramekins, NEVER all identical bowls",
      "MIX HEIGHTS — tall standing bottles and boxes create depth alongside flat items",
      "FILL THE FRAME — items reach near all 4 edges, no empty void around the composition",
      "No ingredient is cooked or mixed (raw state only)",
      "No garnish, no utensils, no extra props",
      "No watermark, no floating text overlays — text on packaging is REQUIRED",
      "Authentic home-kitchen food-blog aesthetic, not a sterile commercial shoot"
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
    task: "Photorealistic food photography — HERO SHOT (the BEST image of the entire recipe — must be stunning and appetizing)",
    image_type: "hero",
    description: heroState.base_description || "finished dish",
    container: heroState.container || defaults.defaultContainer,
    camera: heroState.camera_angle || "45-degree angle",
    lighting: "bright natural daylight from a large window, soft diffused highlights, very airy and luminous, Pinterest-style",
    background: "IGNORE the uploaded reference image for the background. Use a BRIGHT WHITE or pale light-grey photographic surface — white marble, white linen tablecloth, white wood plank, white parchment paper, or clean white countertop. Blurred, slightly out-of-focus background to let the food pop. This is the Pinterest / food-blog hero aesthetic — airy, luminous, clean, magazine-quality.",
    arrangement: heroState.arrangement || "appetizing final presentation, magazine-quality plating",
    allowed_additions: heroState.allowed_additions || [],
    forbidden: heroState.forbidden || ["raw ingredients", "extra bowls", "utensils", "dark background", "wooden board (save for step images)", "moody/dark lighting"],
    rules: [
      "Show the FINISHED dish only — fully cooked and appetizing",
      "This is the HERO IMAGE — the Pinterest/food-blog cover shot. Bright, airy, luminous",
      "BACKGROUND MUST BE WHITE / LIGHT — white marble, white linen, white wood, or clean pale surface. NOT wood boards, NOT dark stone, NOT moody",
      "WARM RICH FOOD COLORS on the WHITE background — golden-brown searing, deep rich sauces, bright fresh herbs pop against the light surface",
      "VISIBLE TEXTURE in sharp focus — crispy edges and glossy sauce and melted cheese and caramelized surfaces",
      "DEPTH AND VOLUME — food 3D and abundant, sauce pooling, toppings piled generously",
      "MOISTURE — sauce glistens, meat juicy, vegetables fresh and crisp",
      "SOFT DIFFUSED DAYLIGHT — bright natural window light, very few hard shadows. Pinterest-bright, not studio-dark",
      "Magazine-cover quality — this single image must make someone want to cook this recipe",
      "Follow the arrangement description for garnish placement and sauce drizzle",
      "No raw ingredients visible, no extra containers or utensils, no text, no watermark"
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
