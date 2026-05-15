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

0b. STEP COUNT IS PURE COOKING — DO NOT INCLUDE PLATING/SERVING IN STEP COUNT:
   - The "recipe.steps" / "visual_steps" count is COOKING TRANSFORMATIONS ONLY — heat applied, food changing state, ingredients combining, sauce thickening, etc.
   - PLATING / SERVING / GARNISHING is NOT a cooking step. It belongs in a SEPARATE field called "serving_image" (see required visual_plan shape below).
   - HERO (the magazine-cover plated dish) is also SEPARATE.
   - Example: if you decide N=5, recipe.steps[] has exactly 5 cooking entries, AND there is also a separate "serving_image" object AND a separate "hero_image" object. Do NOT make step 5 = "Serve and garnish" — the serving moment lives in serving_image, not in steps.
   - The total images the pipeline will generate = ingredients_image + N step images + serving_image + hero_image + pinterest pins. The step count N is the cooking count only.

1. Web search is ENABLED for this turn. Use it to find the most well-regarded versions of this recipe on real food blogs, recipe sites, and chef pages (Food Network, Serious Eats, AllRecipes, NYT Cooking, etc.). Synthesize the BEST PARTS of what you find — never copy a single source verbatim. Ground every quantity, time, temperature, and technique in what real cooks recommend.

2. THREE Pinterest food photographs of this dish are attached to this message. They show how this dish typically looks plated and styled in real food photography. Use them as VISUAL REFERENCE when writing:
   - The "hero_prompt", "hero_image", "ingredients_image", and step "image_prompt" fields → describe what the dish ACTUALLY LOOKS LIKE in the photos (plating style, color of glaze/sauce, garnishes, container, lighting feel).
   - Step "food_state" descriptions → mirror the actual visual progression real cooks document (raw → seared → glazed, etc.).
   - Recipe "intro" if it benefits from sensory anchoring (the smell, the color, the way it looks coming out of the oven).

3. Don't describe what's NOT in the photos. If the photos all show a glossy mahogany glaze, write that — don't invent a "creamy white sauce" version.

IMAGE-GENERATION FOLLOW-UP (so you can plan the visual_plan accordingly):
After you produce the JSON, I will follow up IN THIS SAME CONVERSATION with one image-generation request per turn — first the ingredients flatlay, then each cooking step in order, then the HERO shot, then the SERVING close-up, then the Pinterest pins. Plan the visual_plan with these constraints in mind:
- The ingredients flatlay shows ONLY raw items on a counter — no cooking, no heat, no transformation.
- Every cooking-step image MUST be visually distinct from the ingredients flatlay AND from the serving/hero shots: show ACTIVE cooking (a pot on heat, food in mid-transformation, steam, motion, cookware in use) so it can never be confused with a still-life of raw ingredients OR a finished plated dish. Step images should NOT be plating shots.
- The serving image is a CLOSE-UP "money shot" of the finished dish — a tighter, more intimate angle than the hero. Think: a single forkful, a torn-open bun showing filling, a knife cutting into a glazed roast, sauce being poured. Designed to make the reader hungry.
- The hero image is the magazine-cover full plated shot — wider framing, all garnish in place, the dish at its most beautiful.
- All images must share the SAME kitchen surface, lighting direction, color grading, and cookware family. Continuity is non-negotiable.
- The "image_prompt" / "food_state" / "visible_ingredients" fields you write for each step are what I will send to you when asking for that step's image, so make them explicit, photographable, and clearly different from the ingredients / serving / hero photos.

CRITICAL — REQUIRED visual_plan SHAPE:
The "visual_plan" object in your JSON output MUST have EXACTLY these FOUR top-level keys, in this order:
  1. "ingredients_image" — object describing the raw-ingredients flatlay shot. REQUIRED. Must contain at minimum: items[] (array of {name, state, presentation}), camera_angle, layout. The downstream pipeline will REJECT the response if this key is missing.
  2. "visual_steps"      — array of step photo specs (one per cooking step, paired 1:1 with recipe.steps). PURE COOKING — no plating shots in this array.
  3. "serving_image"     — object describing the close-up SERVING shot (the "money shot" — tighter framing than the hero, designed to look immediately appetizing). REQUIRED. Must contain at minimum: base_description (what the close-up shows: e.g. "a fork lifting a strand of cheese-pulled pasta", "knife slicing a glazed ham revealing pink interior"), container (plate/bowl/board), camera_angle (recommend "eye-level close-up" or "45-degree close-up"), arrangement (sauce/garnish/steam details), allowed_additions (small props that make the shot mouth-watering — a corner of linen, a spoon mid-action, a herb sprig). The downstream pipeline will REJECT the response if this key is missing.
  4. "hero_image"        — object describing the final plated HERO shot (wider, magazine-cover framing of the whole dish). REQUIRED. Must contain at minimum: base_description, container, camera_angle, arrangement. The downstream pipeline will REJECT the response if this key is missing.
Do NOT collapse visual_plan into just visual_steps. Do NOT move ingredients_image / serving_image / hero_image elsewhere. All four keys must appear at visual_plan's top level.

Additionally, recipe.serving_seo MUST be present — same shape as recipe.hero_seo and recipe.ingredients_seo: { filename: "<slug>-serving.jpg", alt_text: "<alt text describing the close-up>" }.`;

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
   - Cap: a maximum of ${maxSteps} COOKING steps total. If your draft has more, MERGE adjacent low-value steps into their nearest transformation. ${maxSteps} does NOT include the serving or hero images — those are SEPARATE objects (serving_image, hero_image), not entries in visual_steps.
   - Plating / garnishing / "serve immediately" / "transfer to a platter" are NOT cooking steps. Do NOT add a final step for serving — describe the serving moment in serving_image instead.
   - Each step must be a moment a food photographer would actually shoot DURING cooking. If you can't picture an active-cooking photo, it's not a step.
   - REPEAT OF RULE 0 — recipe.steps.length === visual_plan.visual_steps.length, and BOTH are pure-cooking counts ≤ ${maxSteps}. After writing both arrays, count them once more before returning JSON. Mismatched counts are an automatic rejection.`;
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
/**
 * Build a Gemini-chat prompt for the SERVING close-up image.
 *
 * Lives in GV (not VG's prompt-builder) per the hard rule that VG modules stay
 * untouched. The serving shot is GV-specific — VG's pipeline implicitly bakes
 * "serving" into the last cooking step, so VG doesn't need this builder.
 *
 * @param {Object} servingState — visual_plan.serving_image from the recipe JSON
 * @param {Object} vgSettings   — VG settings (used for default lighting only)
 */
export function buildServingPrompt(servingState, vgSettings) {
  const defaults = VERIFIED_GENERATOR_DEFAULTS;
  const jsonPrompt = {
    task: "Photorealistic food photography — SERVING CLOSE-UP (the appetite-trigger shot — must look immediately mouth-watering)",
    image_type: "serving",
    description: servingState.base_description || "intimate close-up of the finished dish",
    container: servingState.container || defaults.defaultContainer,
    camera: servingState.camera_angle || "eye-level close-up",
    lighting: vgSettings?.defaultLighting || defaults.defaultLighting,
    background: "PRESERVE the uploaded reference image surface EXACTLY (color, marble veining, grain, texture, edges). Do NOT replace, regenerate, lighten, darken, or stylize. Same counter, same window light as the hero shot.",
    arrangement: servingState.arrangement || "intimate close-up — show texture, sauce gloss, steam, or motion that triggers appetite",
    allowed_additions: servingState.allowed_additions || [],
    forbidden: servingState.forbidden || ["raw ingredients", "cooking cookware (pots/pans on heat)", "wide overhead shots"],
    rules: [
      "This is a CLOSE-UP serving shot — frame TIGHTER than the hero. The dish should fill most of the frame; show ONE intimate detail (a forkful, a slice, a pour, a torn-open piece, a spoon mid-action).",
      "Differentiate from the hero — if the hero is wide overhead, this is eye-level close. If the hero is at 45°, this is more direct or top-down on a single portion. The two images must be DISTINCT views of the same finished dish.",
      "Show the FINISHED dish — fully cooked, plated, garnished. NOT mid-cooking. NOT raw ingredients. NOT a cooking-vessel scene.",
      "The food MUST look the SAME as in the hero/step images — same color, same garnish, same level of doneness. The only thing that changes is the angle and the framing.",
      "BACKGROUND IS SACRED — PRESERVE the uploaded reference surface EXACTLY (color, marble veining, grain, texture, edges). Looks like the same counter on the same day.",
      "NATURAL LIGHTING MATCH — same direction, softness, warmth, shadow shape as the hero. Soft diffused daylight, gentle ambient fill. NO studio HDR, NO harsh shadows, NO dramatic spotlights, NO commercial color grading.",
      "WARM RICH COLORS in sharp focus — golden-brown sears, glossy sauces, melted cheese, vibrant herbs. NO grey, NO washed-out food.",
      "VISIBLE TEXTURE — crispy edges, sauce viscosity, cheese pull, steam wisps, juice pooling. The viewer must SEE the appetizing detail.",
      "MOISTURE — sauce glistens, meat looks juicy, vegetables look fresh. Nothing dry.",
      "Natural and homemade — slight imperfections allowed (a sauce drip, a misaligned garnish, crumbs nearby). NOT sterile, NOT commercial.",
      "No text, no watermark, no logo overlays.",
      "PRODUCE EXACTLY ONE IMAGE in this turn. No grids. No alternates."
    ]
  };
  return JSON.stringify(jsonPrompt, null, 2);
}

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
