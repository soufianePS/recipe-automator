/**
 * Default prompt templates for the verified-generator module.
 *
 * All templates use {{placeholder}} syntax for dynamic values.
 * These are stored as defaults — the user can override any of them
 * in the dashboard settings (verifiedGenerator.prompts.*).
 */

// ─────────────────────────────────────────────────────────────
// 1. VISUAL PLAN PROMPT — ChatGPT pass 2
//    Converts recipe JSON into structured visual states
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VISUAL_PLAN_PROMPT = `You are a food photography director planning a step-by-step recipe photo shoot.

Given the recipe JSON below, create a VISUAL PRODUCTION PLAN — a structured JSON that describes exactly what each photo should show.

CRITICAL RULES:
- Create between {{min_steps}} and {{max_steps}} visual steps (adapt to recipe complexity)
- Each step must show ONE clear visual change from the previous step
- Use the SAME container throughout all steps: "{{default_container}}"
- Every step must list EXACT visible ingredients and FORBIDDEN ingredients
- Forbidden = anything that has NOT been added yet at this step + any garnish/decoration (unless it's the last step)
- For continuity: only allow previous image as context when same container + small change
- NEVER show ingredients from future steps
- Previously mixed ingredients cannot reappear separately
- The ingredients image must show ALL raw ingredients laid out separately
- The hero image must show the final finished dish

RECIPE JSON:
{{recipe_json}}

Output ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "ingredients_image": {
    "image_type": "ingredients",
    "layout": "flat lay arrangement on background",
    "camera_angle": "top-down",
    "items": [
      { "name": "ingredient name", "state": "visual description", "presentation": "how displayed" }
    ],
    "forbidden": ["cooked food", "mixed items", "garnish", "utensils"]
  },
  "visual_steps": [
    {
      "step_id": 1,
      "title": "short action title",
      "container": "{{default_container}}",
      "camera_angle": "{{default_camera_angle}}",
      "visible_ingredients": [
        { "name": "ingredient", "state": "visual state description" }
      ],
      "forbidden_ingredients": ["list of ingredients NOT allowed in this image"],
      "food_state": "detailed description of food appearance at this exact moment",
      "continuity": {
        "uses_previous_image": false,
        "reason": "why or why not use previous image as context"
      }
    }
  ],
  "hero_image": {
    "image_type": "hero",
    "base_description": "final dish description",
    "container": "{{default_container}}",
    "camera_angle": "45-degree angle",
    "allowed_additions": ["garnish if recipe includes it", "final presentation touches"],
    "forbidden": ["raw ingredients", "extra bowls", "utensils", "side dishes not in recipe"]
  }
}`;


// ─────────────────────────────────────────────────────────────
// 2. FLOW IMAGE PROMPT TEMPLATE — converts JSON state to Flow text
// ─────────────────────────────────────────────────────────────

export const DEFAULT_FLOW_IMAGE_PROMPT = `Photorealistic food photography. {{lighting}}.

SCENE:
- Background: exact same as the uploaded reference image
- One {{container}}, {{camera_angle}} angle
- Entire container visible in frame

SHOW EXACTLY:
{{visible_ingredients_list}}

CURRENT STATE: {{food_state}}

STRICT RULES:
- Only 1 container visible in the image
- No extra bowls, plates, utensils, or props
- No garnish or decoration unless explicitly listed above
- No ingredients outside the list above
- Show ONLY this step, not future steps
- Previously mixed ingredients cannot reappear separately
- All food must be inside the container
- No text, no watermark`;


// ─────────────────────────────────────────────────────────────
// 3. FLOW INGREDIENTS PROMPT TEMPLATE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_FLOW_INGREDIENTS_PROMPT = `Photorealistic food photography. {{lighting}}.

SCENE:
- Background: exact same as the uploaded reference image
- {{layout}}
- {{camera_angle}} angle

INGREDIENTS TO SHOW (each separate, not mixed):
{{ingredients_list}}

STRICT RULES:
- Every ingredient must be clearly visible and separate
- No ingredient is cooked or mixed
- No garnish, no utensils, no extra props
- All items arranged neatly on the background
- No text, no watermark`;


// ─────────────────────────────────────────────────────────────
// 4. FLOW HERO PROMPT TEMPLATE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_FLOW_HERO_PROMPT = `Photorealistic food photography. {{lighting}}.

SCENE:
- Background: exact same as the uploaded reference image
- {{base_description}}
- {{container}}, {{camera_angle}} angle
- Appetizing, magazine-quality presentation

ALLOWED ADDITIONS:
{{allowed_additions_list}}

STRICT RULES:
- Show the FINISHED dish only
- No raw ingredients visible
- No extra containers or utensils
- No text, no watermark
{{forbidden_list}}`;


// ─────────────────────────────────────────────────────────────
// 5. VERIFIER PROMPT TEMPLATE — Gemini vision check
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VERIFIER_PROMPT = `You are validating a recipe step image for accuracy.

EXPECTED STEP:
- Container: {{container}} (exactly 1 allowed)
- Camera angle: {{camera_angle}}

ALLOWED visible ingredients:
{{visible_ingredients_list}}

FORBIDDEN ingredients (must NOT appear):
{{forbidden_ingredients_list}}

Expected food state: {{food_state}}

IMPORTANT: The background surface may contain elements like rings, cables, cloth edges, table texture, etc. These are part of the BACKGROUND — ignore them completely. Only check the FOOD and CONTAINER, not background surface elements.

VALIDATION CHECKS:
1. List every visible food element in the image
2. Count how many food containers/bowls/plates are visible (ignore background objects)
3. Check if any FORBIDDEN ingredient appears
4. Check if any ingredient from a FUTURE step is visible
5. Check if previously mixed ingredients reappear separately
6. Check if the food state matches the expected description

SEVERITY RULES:
- HARD_FAIL: forbidden ingredient found, wrong container count, future ingredient visible, food completely wrong state
- SOFT_FAIL: framing slightly off, minor texture difference, bowl not perfectly centered
- PASS: everything matches expected state

OUTPUT JSON ONLY (no markdown, no explanation):
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "container_count": 1,
  "state_match": true,
  "issues": []
}`;


// ─────────────────────────────────────────────────────────────
// 6. VERIFIER PROMPT — INGREDIENTS IMAGE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VERIFIER_INGREDIENTS_PROMPT = `You are validating a recipe ingredients flat-lay image.

EXPECTED:
- All ingredients laid out separately on the background
- Camera angle: {{camera_angle}}

REQUIRED ingredients (must ALL be visible):
{{ingredients_list}}

FORBIDDEN:
- No cooked food
- No mixed/combined ingredients
- No garnish
- No utensils or extra props

IMPORTANT: The background surface may contain elements like rings, cables, cloth, table texture. These are part of the BACKGROUND — ignore them. Only check the FOOD items.

VALIDATION CHECKS:
1. List every visible food item (ignore background surface elements)
2. Check if all required ingredients are present
3. Check if any ingredient appears cooked or mixed
4. Check for extra food items not in the required list
5. Check if EVERY ingredient is in its own small bowl, plate, or dish — NOT placed directly on the background surface. Ingredients directly on the surface = HARD_FAIL

OUTPUT JSON ONLY:
{
  "status": "PASS",
  "detected_items": [],
  "missing_ingredients": [],
  "extra_items": [],
  "issues": []
}`;


// ─────────────────────────────────────────────────────────────
// 7. VERIFIER PROMPT — HERO IMAGE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VERIFIER_HERO_PROMPT = `You are validating a recipe hero/final image.

EXPECTED:
- Finished dish: {{base_description}}
- Container: {{container}}
- Camera angle: {{camera_angle}}

ALLOWED additions: {{allowed_additions_list}}

FORBIDDEN:
{{forbidden_list}}

VALIDATION CHECKS:
1. Does the image show a finished, appetizing dish?
2. Does it match the expected description?
3. Are there any forbidden elements?
4. Is the presentation clean and professional?

OUTPUT JSON ONLY:
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "issues": []
}`;


// ─────────────────────────────────────────────────────────────
// 8. CORRECTION PROMPT TEMPLATE — sent after verification fails
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 9. SIMILARITY CHECK PROMPT — compare step N vs step N-1
// ─────────────────────────────────────────────────────────────

export const DEFAULT_SIMILARITY_CHECK_PROMPT = `You are comparing two recipe step images to check if they look too similar.

IMAGE 1: Previous step (step {{prev_step}})
IMAGE 2: Current step (step {{current_step}})

The current step should show: {{expected_change}}

COMPARE:
1. Is the food color noticeably different?
2. Is the sauce/liquid amount or consistency visibly different?
3. Are ingredients arranged differently or have new items appeared?
4. Is there a clear visual transformation (raw→cooked, dry→sauced, etc.)?
5. Would a reader scrolling see TWO distinct images or feel like the same photo?

SCORING:
- 0-40: Very different images (clearly distinct steps)
- 41-60: Moderately different (acceptable)
- 61-80: Somewhat similar (borderline)
- 81-100: Too similar (looks like the same photo)

OUTPUT JSON ONLY:
{
  "similarity_score": 0,
  "differences_found": [],
  "missing_changes": [],
  "verdict": "DISTINCT"
}

verdict must be: "DISTINCT" (0-60), "BORDERLINE" (61-80), or "TOO_SIMILAR" (81-100)`;


// ─────────────────────────────────────────────────────────────
// 10. VERIFIER PROMPT — PINTEREST PIN
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VERIFIER_PINTEREST_PROMPT = `You are validating a Pinterest food pin image.

EXPECTED:
- Recipe: {{recipe_title}}
- Pin should show the finished dish matching this recipe
- Pin should follow a Pinterest-style layout (vertical, eye-catching)
- Food should look appetizing and match the recipe described

VALIDATION CHECKS:
1. Does the image show food that matches the recipe title?
2. Is there text overlay visible (title or branding)?
3. Is the composition vertical and Pinterest-appropriate?
4. Does the food look appetizing and well-presented?
5. Are there any wrong or unrelated food items?

SEVERITY RULES:
- HARD_FAIL: wrong food entirely, no food visible, image is broken/blank
- SOFT_FAIL: text slightly cut off, minor composition issue, food slightly different from expected
- PASS: food matches recipe, layout is Pinterest-appropriate, looks professional

OUTPUT JSON ONLY (no markdown, no explanation):
{
  "status": "PASS",
  "detected_food": "",
  "has_text_overlay": true,
  "composition_valid": true,
  "issues": []
}`;


// ─────────────────────────────────────────────────────────────
// 10. CORRECTION PROMPT TEMPLATE — sent after verification fails
// ─────────────────────────────────────────────────────────────

export const DEFAULT_CORRECTION_PROMPT = `CORRECTION — the previous image was rejected by quality control.

Issues found:
{{issues_list}}

FIXES REQUIRED:
{{fixes_list}}

Generate the image again with these corrections. All previous rules still apply.`;


// ─────────────────────────────────────────────────────────────
// 11. RECIPE + VISUAL PLAN PROMPT — single ChatGPT call
//     Dedicated to verified generator (independent from generator module)
// ─────────────────────────────────────────────────────────────

export const DEFAULT_RECIPE_VISUAL_PROMPT = `You are a professional food blogger and food photography director.

Generate a COMPLETE recipe blog post AND a visual production plan for image generation.

RECIPE TOPIC: {{topic}}
CATEGORIES TO CHOOSE FROM: {{categories}}

OUTPUT ONE JSON OBJECT with THREE sections:

SECTION 1 — "recipe" (for the blog post):
- post_title, slug, focus_keyword, meta_title, meta_description
- intro (2-3 paragraphs, human tone, no AI cliches, separate with \\n\\n)
- ingredients (array of strings with quantities)
- steps (array of {number, title, description, tip})
- prep_time, cook_time, total_time, servings, calories
- pro_tips (array of 3-4 tips)
- variations (array of 2-3 variations)
- storage_notes, serving_suggestions, make_ahead
- conclusion (1-2 paragraphs, human tone)
- category (pick ONE from the categories list)

SECTION 2 — "visual_plan" (for AI image generation):
This tells the image generator exactly what each photo should show.

CONTAINER SELECTION — choose the BEST container for this recipe:
- White ceramic bowl: soups, salads, pasta, stir-fry, rice bowls, mixed dishes
- Glass/ceramic baking dish: casseroles, lasagna, baked pasta, gratins
- Cast iron skillet: pan-fried, seared meats, one-pan dishes
- Sheet pan/baking tray: roasted vegetables, sheet pan dinners, cookies
- White plate: plated dishes, sandwiches, steaks, finished presentations
- Wooden cutting board: breads, charcuterie, sliced items
Use the SAME container for ALL visual steps (not the ingredients image).

VISUAL PLAN RULES:
- Create between {{min_steps}} and {{max_steps}} visual steps
- Each step = ONE clear visual change from previous step
- List EXACT visible ingredients and FORBIDDEN ingredients per step
- Forbidden = anything NOT yet added + garnish (unless last step)
- NEVER show ingredients from future steps
- The LAST visual step MUST be a "serving/plating" step: the finished dish served on a nice plate or in an appropriate serving dish (NOT the cooking pan/skillet unless it's a one-pan recipe meant to be served from it). Add garnish, make it look restaurant-ready. This is different from the hero — the serving step is top-down showing a plated portion, while hero is a 45-degree beauty shot of the full dish
- Each step must look VISUALLY DISTINCT from the previous step — different color, texture, amount of sauce, ingredient count, or state

ARRANGEMENT — for each step, describe HOW ingredients are placed:
- Where each ingredient sits in the container (center, edges, scattered, layered)
- How they're oriented (fanned out, stacked neatly, poured from side)
- Spacing between elements (not piled up, each item visible and distinct)
- The overall visual composition (what the viewer sees from top-down)

INGREDIENTS IMAGE ARRANGEMENT:
- EVERY ingredient MUST be in its own small container — NEVER directly on the background surface
- Proteins on small white plates, liquids in small glass bowls, spices in small ceramic dishes, vegetables on small plates
- Arranged in a clean grid or circular pattern with clear spacing between containers
- Nothing touching or overlapping — each ingredient fully visible and identifiable
- The background surface should be visible between the containers (clean, organized look)

SECTION 3 — "pinterest_pins" (for Pinterest):
- 3 pins with title, description, image_prompt

OUTPUT THIS EXACT JSON STRUCTURE (no markdown, no explanation):
{
  "recipe": {
    "post_title": "",
    "slug": "",
    "focus_keyword": "",
    "meta_title": "",
    "meta_description": "",
    "intro": "",
    "ingredients": [],
    "steps": [{"number": 1, "title": "", "description": "", "tip": ""}],
    "prep_time": "", "cook_time": "", "total_time": "", "servings": "", "calories": "",
    "pro_tips": [],
    "variations": [],
    "storage_notes": "",
    "serving_suggestions": "",
    "make_ahead": "",
    "conclusion": "",
    "category": ""
  },
  "visual_plan": {
    "ingredients_image": {
      "layout": "describe the exact arrangement pattern",
      "camera_angle": "{{default_camera_angle}}",
      "items": [{"name": "", "state": "", "presentation": "in small glass bowl / on small white plate / directly on background", "placement": "top-left / center / bottom-right etc."}],
      "forbidden": ["cooked food", "mixed items", "garnish", "utensils"]
    },
    "visual_steps": [
      {
        "step_id": 1,
        "title": "short action title",
        "container": "chosen container type",
        "camera_angle": "{{default_camera_angle}}",
        "visible_ingredients": [{"name": "", "state": "", "placement": "where and how in the container"}],
        "forbidden_ingredients": [],
        "food_state": "detailed description of food appearance at this exact moment",
        "arrangement": "describe the overall visual composition — how everything is laid out, spacing, orientation"
      }
    ],
    "hero_image": {
      "base_description": "final dish description with presentation details",
      "container": "chosen container type",
      "camera_angle": "45-degree angle",
      "arrangement": "describe final plating — garnish position, sauce drizzle pattern, steam effect",
      "allowed_additions": [],
      "forbidden": ["raw ingredients", "extra bowls", "utensils"]
    }
  },
  "pinterest_pins": [
    {"title": "", "description": "", "image_prompt": ""}
  ]
}

{{template_instructions}}`;


// ─────────────────────────────────────────────────────────────
// 12. PINTEREST PROMPT — dedicated to verified generator
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VG_PINTEREST_PROMPT = `Recreate the EXACT same layout, style, colors, text placement, and design from the first uploaded reference image (the Pinterest template).

Use the food from the second reference image (the hero/recipe photo).

Title text on the pin: "{{pin_title}}"
Website: {{website}}

RULES:
- Match the template layout exactly
- Use the actual food photo, not a different dish
- Text must be readable and well-placed
- Vertical Pinterest format
- Professional, eye-catching design`;


// ─────────────────────────────────────────────────────────────
// DEFAULT SETTINGS
// ─────────────────────────────────────────────────────────────

export const VERIFIED_GENERATOR_DEFAULTS = {
  minVisualSteps: 4,
  maxVisualSteps: 8,
  maxVerificationRetries: 3,
  softFailAction: 'accept',       // 'accept' or 'retry'
  defaultContainer: 'white ceramic bowl',
  defaultCameraAngle: 'top-down',
  defaultLighting: 'natural soft light',
  prompts: {
    visualPlan: DEFAULT_VISUAL_PLAN_PROMPT,
    flowImage: DEFAULT_FLOW_IMAGE_PROMPT,
    flowIngredients: DEFAULT_FLOW_INGREDIENTS_PROMPT,
    flowHero: DEFAULT_FLOW_HERO_PROMPT,
    verifier: DEFAULT_VERIFIER_PROMPT,
    verifierIngredients: DEFAULT_VERIFIER_INGREDIENTS_PROMPT,
    verifierHero: DEFAULT_VERIFIER_HERO_PROMPT,
    similarityCheck: DEFAULT_SIMILARITY_CHECK_PROMPT,
    verifierPinterest: DEFAULT_VERIFIER_PINTEREST_PROMPT,
    correction: DEFAULT_CORRECTION_PROMPT,
    recipeVisualPlan: DEFAULT_RECIPE_VISUAL_PROMPT,
    pinterest: DEFAULT_VG_PINTEREST_PROMPT,
  }
};
