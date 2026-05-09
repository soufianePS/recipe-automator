/**
 * gemini-visual recipe-generation prompt.
 *
 * Strategy: USE VG's stable, well-structured prompt as the base — no verbatim
 * copy. Whenever VG's prompt evolves (default or dashboard-customized), GV
 * automatically picks up the improvements.
 *
 * On top of that base, this module prepends a GV-specific PREAMBLE block with
 * the gemini-visual-only enhancements:
 *   1. Web-search is enabled — ground every quantity/time in real sources
 *   2. 3 Pinterest reference photos are attached — describe what's in them
 *   3. Don't describe what's NOT in the photos
 *   4. WRITING VOICE — rotated from the 8-voice pool (voice-pool.js)
 *   5. TRANSFORMATION-ONLY STEPS — cap 4-5, "add salt" goes inline
 *   6. WHY-PER-STEP — every step ends with one short reason clause
 *
 * Resolution order for the base template (highest priority first):
 *   1. settings.geminiVisual.prompts.recipeVisualPlan — GV-specific override
 *   2. settings.verifiedGenerator.prompts.recipeVisualPlan — VG dashboard custom
 *   3. VERIFIED_GENERATOR_DEFAULTS.prompts.recipeVisualPlan — built-in default
 */

import { VERIFIED_GENERATOR_DEFAULTS } from '../verified-generator/prompts-verified.js';

/**
 * Resolve the effective base template using the priority chain above.
 * @param {Object} settings — full settings object
 */
export function resolveBaseTemplate(settings) {
  return (
    settings?.geminiVisual?.prompts?.recipeVisualPlan ||
    settings?.verifiedGenerator?.prompts?.recipeVisualPlan ||
    VERIFIED_GENERATOR_DEFAULTS.prompts.recipeVisualPlan
  );
}

/**
 * Inspect the resolution result without running the full builder.
 * Returns { template, source: 'gv' | 'vg' | 'default' }.
 */
export function describeBaseTemplate(settings) {
  if (settings?.geminiVisual?.prompts?.recipeVisualPlan) {
    return { template: settings.geminiVisual.prompts.recipeVisualPlan, source: 'gv' };
  }
  if (settings?.verifiedGenerator?.prompts?.recipeVisualPlan) {
    return { template: settings.verifiedGenerator.prompts.recipeVisualPlan, source: 'vg' };
  }
  return { template: VERIFIED_GENERATOR_DEFAULTS.prompts.recipeVisualPlan, source: 'default' };
}

// ─────────────────────────────────────────────────────────────────────────
// GV-specific preamble (sits ABOVE the base prompt — sets gemini-visual rules)
// ─────────────────────────────────────────────────────────────────────────

const GV_BASE_PREAMBLE = `BEFORE YOU START WRITING THE RECIPE — IMPORTANT CONTEXT FOR THIS GENERATION:

0. HARD INVARIANT — STEP-COUNT MATCH (THE MOST IMPORTANT RULE — DO NOT VIOLATE):
   - The "recipe.steps" array and the "visual_plan.visual_steps" array MUST have IDENTICAL length.
   - They are paired 1:1 by index: recipe.steps[i] is the cooking instruction for step i+1, and visual_plan.visual_steps[i] is the photograph of that exact same moment.
   - If you decide on N steps, BOTH arrays must have exactly N entries — never N in one and N±1 in the other.
   - The downstream pipeline iterates these arrays by index. Any mismatch makes recipe instructions disappear from the post or generates step images with no description. The system will REJECT your response if these counts differ.
   - Before returning JSON, count both arrays yourself and confirm they match.

1. Web search is ENABLED for this turn. Use it to find the most well-regarded versions of this recipe on real food blogs, recipe sites, and chef pages (Food Network, Serious Eats, AllRecipes, NYT Cooking, etc.). Synthesize the BEST PARTS of what you find — never copy a single source verbatim. Ground every quantity, time, temperature, and technique in what real cooks recommend.

2. THREE Pinterest food photographs of this dish are attached to this message. They show how this dish typically looks plated and styled in real food photography. Use them as VISUAL REFERENCE when writing:
   - The "hero_prompt", "hero_image", "ingredients_image", and step "image_prompt" fields → describe what the dish ACTUALLY LOOKS LIKE in the photos (plating style, color of glaze/sauce, garnishes, container, lighting feel).
   - Step "food_state" descriptions → mirror the actual visual progression real cooks document (raw → seared → glazed, etc.).
   - Recipe "intro" if it benefits from sensory anchoring (the smell, the color, the way it looks coming out of the oven).

3. Don't describe what's NOT in the photos. If the photos all show a glossy mahogany glaze, write that — don't invent a "creamy white sauce" version.

IMAGE-GENERATION FOLLOW-UP (so you can plan the visual_plan accordingly):
After you produce the JSON, I will follow up IN THIS SAME CONVERSATION with one image-generation request per turn — first the ingredients flatlay, then each cooking step in order, then the hero shot, then the Pinterest pins. Plan the visual_plan with these constraints in mind:
- The ingredients flatlay shows ONLY raw items on a counter — no cooking, no heat, no transformation.
- Every cooking-step image MUST be visually distinct from the ingredients flatlay: show ACTIVE cooking (a pot on heat, food in mid-transformation, steam, motion, cookware in use) so it can never be confused with the still-life of raw ingredients.
- All images must share the SAME kitchen surface, lighting direction, color grading, and cookware family. Continuity is non-negotiable.
- The "image_prompt" / "food_state" / "visible_ingredients" fields you write for each step are what I will send to you when asking for that step's image, so make them explicit, photographable, and clearly different from the ingredients photo.

CRITICAL — REQUIRED visual_plan SHAPE:
The "visual_plan" object in your JSON output MUST have EXACTLY these three top-level keys, in this order:
  1. "ingredients_image" — object describing the raw-ingredients flatlay shot. REQUIRED. Must contain at minimum: items[] (array of {name, state, presentation}), camera_angle, layout. The downstream pipeline will REJECT the response if this key is missing.
  2. "visual_steps"      — array of step photo specs (one per cooking step, paired 1:1 with recipe.steps).
  3. "hero_image"        — object describing the final plated hero shot. REQUIRED. Must contain at minimum: base_description, container, camera_angle, arrangement. The downstream pipeline will REJECT the response if this key is missing.
Do NOT collapse visual_plan into just visual_steps. Do NOT move ingredients_image or hero_image elsewhere. All three keys must appear at visual_plan's top level.`;

function buildVoiceBlock(voice) {
  if (!voice) return '';
  return `

4. WRITING VOICE FOR THIS POST — "${voice.name}":
${voice.description}
   - For the "intro" field specifically: ${voice.intro_signal}
   - For step descriptions and tips: ${voice.step_signal}
   - This voice applies to: intro, conclusion, why_this_works, fun_fact, step descriptions, tips, FAQ answers. Do NOT apply it to ingredient names, recipe metadata, or visual_plan technical fields.
   - Do not name the voice or break character. Just write in it.`;
}

function buildTransformationsOnlyBlock(maxSteps) {
  return `

5. TRANSFORMATION-ONLY STEP RULE — non-negotiable:
   - Each step in "recipe.steps" AND "visual_plan.visual_steps" MUST be a real cooking transformation: something visibly changes (color, texture, container, volume, or state — raw to seared, liquid to thickened, smooth to chunky, etc.).
   - Trivial additions like "add salt", "splash water", "season to taste", "stir briefly", "deglaze with a splash" — these are NOT steps. Fold them INTO the description of the adjacent transformative step. Example: instead of one step "season the meat" + next step "sear", write a single sear step whose description begins "Season the meat right before it hits the pan, then sear..."
   - Cap: a maximum of ${maxSteps} steps total. If your draft has more, MERGE adjacent low-value steps into their nearest transformation.
   - Each step must be a moment a food photographer would actually shoot. If you can't picture the photo, it's not a step.
   - REPEAT OF RULE 0 — recipe.steps.length === visual_plan.visual_steps.length. After writing both arrays, count them once more before returning JSON. Mismatched counts are an automatic rejection.`;
}

function buildWhyPerStepBlock() {
  return `

6. WHY-PER-STEP CLAUSE:
   - Every step's "description" field must end with ONE short clause (max ~15 words) explaining WHY this temperature / time / technique matters. Examples:
     • "Sear 90 seconds without moving — the fond builds the sauce later."
     • "Rest 15 minutes before slicing — gives the juices time to redistribute so each slice stays moist."
     • "Bake at 325°F not 350°F — slow heat keeps the sugars from burning before the inside warms through."
   - The why-clause must follow naturally from the step content (not a separate sentence dump). It's the cook's reason, not a textbook quote.
   - Keep it specific — name the temp, the time, the chemical reaction, or the failure mode you're avoiding.`;
}

function buildPreamble(opts) {
  let preamble = GV_BASE_PREAMBLE;
  if (opts.voice) preamble += buildVoiceBlock(opts.voice);
  if (opts.transformationsOnly !== false) preamble += buildTransformationsOnlyBlock(opts.maxSteps || 5);
  if (opts.whyPerStep !== false) preamble += buildWhyPerStepBlock();
  preamble += `\n\nNow follow the full recipe-generation instructions below, producing the same JSON schema (recipe + visual_plan + pinterest_pins).\n\n═══════════════════════════════════════════════════════════════════════════\n`;
  return preamble;
}

// ─────────────────────────────────────────────────────────────────────────
// Public builder
// ─────────────────────────────────────────────────────────────────────────

/**
 * Build the full prompt string for gemini-visual recipe-JSON generation.
 *
 * @param {Object} opts
 * @param {string} opts.recipeTitle
 * @param {string} opts.categories
 * @param {number} opts.minSteps
 * @param {number} opts.maxSteps — Phase 2 default: 5 (transformation-only cap)
 * @param {string} opts.relatedRecipesBlock — "1. [cat] title — url" lines, or "No related..." sentinel
 * @param {string} opts.templateInstructions — extra rules (intro/conclusion templates, structure randomization)
 * @param {string} opts.baseTemplate — REQUIRED — caller passes the result of resolveBaseTemplate(settings)
 * @param {Object} [opts.voice] — voice from voice-pool.js. Default: omitted = no voice block
 * @param {boolean} [opts.transformationsOnly=true] — enforce transformation-only step rule
 * @param {boolean} [opts.whyPerStep=true] — require why-per-step clause
 */
export function buildGVRecipePrompt(opts) {
  const base = opts.baseTemplate || VERIFIED_GENERATOR_DEFAULTS.prompts.recipeVisualPlan;
  const maxSteps = opts.maxSteps || 5;
  const filled = base
    .replace(/\{\{topic\}\}/g, opts.recipeTitle)
    .replace(/\{\{categories\}\}/g, opts.categories || 'Breakfast, Lunch, Dinner, Dessert')
    .replace(/\{\{min_steps\}\}/g, String(opts.minSteps || 4))
    .replace(/\{\{max_steps\}\}/g, String(maxSteps))
    .replace(/\{\{default_camera_angle\}\}/g, 'choose best angle for this step')
    .replace(/\{\{related_recipes\}\}/g, opts.relatedRecipesBlock || 'No related recipes available — skip internal linking.')
    .replace(/\{\{template_instructions\}\}/g, opts.templateInstructions || '');

  const preamble = buildPreamble({
    voice: opts.voice,
    transformationsOnly: opts.transformationsOnly,
    whyPerStep: opts.whyPerStep,
    maxSteps,
  });

  return `${preamble}\n${filled}`;
}
