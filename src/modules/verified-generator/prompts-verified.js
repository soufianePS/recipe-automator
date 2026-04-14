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
- Each step specifies its own container (containers CAN change between steps when the recipe requires it)
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
      "container": "choose based on recipe type",
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
    "container": "choose based on recipe type",
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
- Container: {{container}}
- Camera angle: {{camera_angle}}

ALLOWED visible ingredients:
{{visible_ingredients_list}}

FORBIDDEN ingredients (must NOT appear):
{{forbidden_ingredients_list}}

Expected food state: {{food_state}}

IMPORTANT: The background surface may contain elements like rings, cables, cloth edges, table texture, etc. These are part of the BACKGROUND — ignore them completely. Only check the FOOD and CONTAINER, not background surface elements.

VALIDATION CHECKS:
1. List every visible food element in the image
2. Check if the main container matches the expected type ({{container}})
3. Check if any FORBIDDEN ingredient appears
4. Check if any ingredient from a FUTURE step is visible
5. Check if previously mixed ingredients reappear separately
6. Check if the food state matches the expected description

SEVERITY RULES:
- HARD_FAIL: forbidden ingredient found, future ingredient visible, food completely wrong state, totally wrong container type
- SOFT_FAIL: framing slightly off, minor texture difference, container slightly different style but same category
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

export const DEFAULT_RECIPE_VISUAL_PROMPT = `You are writing a food blog post AND a visual production plan for AI image generation. Generate ONE valid JSON object only with no explanations no markdown and no extra text.

Topic: "{{topic}}"

GLOBAL RULES:
- Use "{{topic}}" exactly as the Article Title.
- Replace 100% all commas and periods with linking words and transition words inside all paragraphs.
- Each paragraph must end with a period.
- The "category" field MUST be one of these: {{categories}}.

OUTPUT ONE JSON with three sections: "recipe", "visual_plan", "pinterest_pins".

==============================
SECTION 1 — "recipe" (blog post content):

INTRO RULES:
- Write introduction with MINIMUM 3 paragraphs separated by \\n\\n.
- Each paragraph must feel natural and human with smooth transitions.
- No AI cliches (no "delve" "elevate" "mouthwatering" "culinary journey").

INGREDIENT RULES:
- List all ingredients with name and quantity and description (short functional role).
- Add a period at the end of each ingredient description.

STEP SYSTEM (DYNAMIC FLOW):
- Steps MUST represent the FULL recipe journey from raw ingredients to final plated dish.
- NEVER skip stages. NEVER repeat stages.
- Minimum steps: {{min_steps}}. Maximum steps: {{max_steps}}.
- Use ONLY the number of steps the recipe truly needs.
- Do NOT add filler steps.

CRITICAL ANTI-DUPLICATION RULE:
- Each step MUST introduce a NEW visual transformation.
- NEVER repeat the same action even with different wording.
- If a step does not introduce a clear visual change then DO NOT include it.
- DO NOT split one transformation into multiple steps.
- Each step must answer: "What NEW visual change happened compared to the previous step?"
- If nothing new then REMOVE the step.

DYNAMIC STEP FLOW RULE:
- Steps must follow the natural flow of the specific recipe NOT a fixed structure.
- Use ONLY the phases that are logically required:
  ingredient preparation (cutting slicing measuring) / mixing or combining / coating or seasoning / resting or marinating (if needed) / forming or shaping (if needed) / layering or assembling / transformation (softening thickening melting browning) / final assembly (if multi-component) / plating and finishing.
- Do NOT force all phases.

NO FORCED RAW STEP RULE:
- Do NOT create a step that only shows raw ingredients unless real preparation happens such as cutting or slicing.
- Do NOT create steps for: heating oil or preheating pan or boiling water or any step without food visible.

STEP TITLE RULE:
- Each step title MUST describe a real and specific action.
- Do NOT use generic titles like "Prepare Ingredients" or "Raw Ingredients" or "Start Cooking".
- Use clear action-based titles like "Slice the strawberries" or "Mix the batter" or "Layer the filling".

COOKING VISUAL PROGRESSION RULE:
- Food MUST visually evolve across steps: raw > combined > coated > softened > thickened > structured > melted > slightly browned > finished.
- Allowed transformations: sauce thickening and cheese melting unevenly and texture softening and slight browning and folding or layering.

VISUAL UNIQUENESS RULE:
- Each step MUST include at least ONE of: color change / texture change / structure change / ingredient interaction change.

HUMAN REALISM RULE:
- Food must NEVER look perfect.
- Always include: uneven placement and irregular sizes and natural spacing and slight overlap.
- Avoid: symmetry and grid layout and centered arrangement and identical shapes.

INGREDIENT INTERACTION RULE:
- Each step MUST visually describe how ingredients interact: poured over / partially mixed / fully mixed / layered / scattered / folded.
- Do NOT fully cover food unless logically mixed.

NO EQUIPMENT RULE:
- Do NOT mention cooking tools in image prompts. Describe transformation only.

FINAL DISH RULE:
- Final step MUST show: fully cooked dish with visible browning or melting and natural imperfections and uneven textures and non-uniform color.
- The dish must look homemade not commercial.

IMAGE PROMPT RULES:
- Image prompts must ONLY describe: food and container.
- Never describe: background or lighting or surface or camera.

SEO RULES:
- Generate SEO for hero image and ingredients image and each step image.
- Meta description must be under 155 characters.
- Add a period at the end of each equipment description.
- Add "?" at the end of each FAQ question.

RECIPE CARD DESCRIPTION RULE:
- Length must be 450 to 480 characters.
- Must include keywords: easy and ideas and quick and simple and best and healthy.
- Must mention events: weeknight dinner or meal prep or holiday or potluck or brunch or party.

FAQ RULE: Include 3 to 4 questions.
CONCLUSION RULE: Write 2 to 3 sentences.

SECTION 2 — "visual_plan" (for AI image generation):
This tells the image generator EXACTLY what each photo should show.

CONTAINER SELECTION PER STEP — use the container a REAL cook would use at EACH phase:
- Mixing bowl: mixing batters and marinades and doughs
- Cast iron skillet: searing and pan-frying and sautéing
- Large pot: soups and stews and boiling pasta
- Saucepan: sauces and melting chocolate and heating liquids
- Glass/ceramic baking dish: casseroles and lasagna and baked dishes
- Sheet pan/baking tray: roasting vegetables and baking cookies
- Muffin tin/ramekins: cupcakes and muffins and lava cakes and egg bites
- Cake pan: cakes and cheesecakes
- White plate: final serving/plating step
- Wooden cutting board: slicing bread and charcuterie
- Wok: stir-fry dishes
CRITICAL: The container CAN and SHOULD change between steps when the recipe requires it.
Real cooking uses multiple containers: bowl (mix) → skillet (cook) → plate (serve).
Each step MUST specify which container is used at that exact phase.
Do NOT force the same container for ALL steps unless the recipe truly uses only one.

VISUAL PLAN RULES:
- Create between {{min_steps}} and {{max_steps}} visual steps
- Each step = ONE clear visual change from previous
- List EXACT visible and FORBIDDEN ingredients per step
- Forbidden = anything NOT yet added + garnish (unless last step)
- Each step VISUALLY DISTINCT - different color, texture, sauce amount, state
- Food must evolve: raw > combined > coated > softened > melted > browned > finished
- Do NOT create steps for: heating oil, preheating pan, boiling water, or any step without food visible. Every step must show food in the container

NO SKIPPED TRANSFORMATION RULE (CRITICAL):
- Steps MUST cover EVERY major visual transformation from raw to served.
- NEVER jump from mixing to final plated dish — show the cooking phase in between.
- If food goes into an oven or pan or pot then show it INSIDE that vessel before showing the result.
- Example for lava cake: mix batter → pour into ramekins → baked ramekins (cracked tops) → served portion on plate.
- Example for pasta: boil pasta → sauté sauce → combine pasta with sauce → served bowl.
- Example for fried chicken: coat chicken → fry in skillet (golden pieces) → served plate.
- If you cannot think of a clear visual for a cooking phase then describe what it looks like MID-COOK (bubbling and browning and rising and melting).

STEP MERGING RULE:
- If adding an ingredient does NOT create a visible change (salt and vanilla extract and oil spray) then merge it into the NEXT step that DOES create a visible change.
- Each step MUST have an OBVIOUS visual difference from the previous step.
- If two consecutive steps would look nearly identical then combine them into one step.

FOOD SHUFFLING BETWEEN STEPS (CRITICAL):
- A real cook moves food while cooking. The food MUST NOT stay frozen in the same position.
- Between EVERY two consecutive steps at least ONE of these must happen:
  * Food shifted to different position in container
  * Pieces flipped showing other side
  * Ingredients rearranged or spread differently
  * New ingredient poured or scattered changes the layout
  * Food transferred to a different container
- Describe the shuffle in the "position" field: "chicken pieces flipped showing golden-brown underside and shifted toward center" or "batter poured from bowl into 4 greased ramekins filling each 3/4 full"
- The position field is MANDATORY for every step — never leave it empty

QUANTITY CONSISTENCY RULE (CRITICAL):
- The NUMBER of items in step images MUST match the recipe ingredients quantity.
- If recipe says "2 chicken breasts" then ALL step images must show exactly 2 chicken breasts not 4 or 8.
- If recipe says "4 chicken thighs" then show exactly 4 in every step.
- The SIZE of items must stay consistent across steps. Do not make items bigger or smaller between steps.
- Include the exact quantity in each step's visible_ingredients field.

CONTAINER REALISM RULE:
- Each step uses the container that makes cooking sense for THAT phase.
- The container should look used and realistic not brand new.
- Container transitions must be logical: you mix in a bowl THEN transfer to a baking dish THEN serve on a plate.
- NEVER serve from the mixing bowl (transfer to the cooking vessel or serving plate).
- NEVER cook in a plate (plates are for serving only).

FOOD MOVEMENT RULE (CRITICAL):
- Between cooking steps food MUST change position or change container. A chef moves food while cooking.
- NEVER keep food in the exact same position across two consecutive steps.
- Types of movement:
  * SAME container: flipped / rotated / shifted / tilted / rearranged / spread out / folded over / stirred
  * DIFFERENT container: transferred / poured / scooped / placed / unmolded
- The "position" field MUST describe BOTH where food sits AND how it changed from the previous step.
- Example same container: "chicken pieces flipped showing golden-brown bottom side and shifted toward center of skillet"
- Example container change: "batter poured from mixing bowl into 4 greased ramekins filling each 3/4 full"
- Example container change: "baked lava cake unmolded onto white plate and tilted to show molten center flowing out"

THE LAST STEP - "serving/portion":
- Show a SINGLE PORTION served on a plate (not the cooking container).
- If the dish can be cut or sliced then show the INSIDE: a cut piece revealing texture and layers and melted cheese and juicy interior.
- If it cannot be cut (soup or stir-fry) then show a served portion in a bowl with garnish.
- Garnished and restaurant-ready but natural look.
- Different from hero: this is a close-up of one portion showing detail while hero is the full dish at 45 degrees.

ARRANGEMENT per step:
- Where each ingredient sits (center or edges or scattered or layered).
- How food moved from previous step (rotated or flipped or shifted).
- Natural imperfections (not symmetrical and casual home cooking look).
- Use natural wording: "loosely spread" and "unevenly scattered" and "casually arranged".

INGREDIENTS IMAGE:
- EVERY ingredient MUST be in its own small container. NEVER directly on the background surface.
- Proteins on small white plates and liquids in small glass bowls and spices in small ceramic dishes and vegetables on small plates.
- Arranged in clean grid or circular pattern with clear spacing between containers.
- The background surface should be visible between the containers.

SECTION 3 - "pinterest_pins": 3 pins with title, description, image_prompt.

OUTPUT THIS EXACT JSON (no markdown, no explanation):
{
  "recipe": {
    "post_title": "",
    "slug": "",
    "focus_keyword": "",
    "meta_title": "",
    "meta_description": "max 155 chars",
    "recipe_card_description": "450-480 chars, include: easy, quick, simple, best, healthy",
    "intro": "3+ paragraphs separated by newlines",
    "ingredients": [{"name": "", "quantity": "", "description": ""}],
    "hero_prompt": "Describe the FULLY COOKED finished dish with natural imperfections.",
    "hero_seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []},
    "ingredients_prompt": "All raw ingredients in separate containers.",
    "ingredients_seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []},
    "steps": [{"number": 1, "title": "specific action", "description": "1-2 paragraphs explaining visual change", "tip": "", "image_prompt": "Describe natural imperfect food state after this step.", "seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []}}],
    "equipment": [{"name": "", "notes": "function."}],
    "pro_tips": ["", "", "", ""],
    "faq": [{"question": "?", "answer": ""}],
    "storage_notes": "1-2 paragraphs.",
    "fun_fact": "",
    "category": "",
    "cuisine": "",
    "prep_time": "PT15M", "cook_time": "PT30M", "total_time": "PT45M",
    "servings": "4",
    "conclusion": ""
  },
  "visual_plan": {
    "ingredients_image": {
      "layout": "describe arrangement",
      "camera_angle": "{{default_camera_angle}}",
      "items": [{"name": "", "state": "", "presentation": "in small glass bowl", "placement": "position"}],
      "forbidden": ["cooked food", "mixed items", "garnish", "utensils"]
    },
    "visual_steps": [{
      "step_id": 1, "title": "specific action title", "container": "chosen container",
      "camera_angle": "{{default_camera_angle}}",
      "visible_ingredients": [{"name": "", "state": "", "placement": "where in container"}],
      "forbidden_ingredients": ["ingredients NOT yet added"],
      "food_state": "detailed appearance with natural imperfections",
      "position": "how food moved from previous step (flipped/rotated/shifted/tilted)",
      "arrangement": "overall composition with casual non-symmetrical layout"
    }],
    "hero_image": {
      "base_description": "finished dish, natural look",
      "container": "plate or serving dish",
      "camera_angle": "45-degree angle",
      "arrangement": "natural plating, casual garnish",
      "allowed_additions": [],
      "forbidden": ["raw ingredients", "extra bowls", "utensils"]
    }
  },
  "pinterest_pins": [{"title": "", "description": "", "image_prompt": ""}]
}

{{template_instructions}}`;


// ─────────────────────────────────────────────────────────────
// 12. PINTEREST PROMPT — dedicated to verified generator
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VG_PINTEREST_PROMPT = `Recreate the EXACT same layout, style, colors, text placement, and design from the first uploaded reference image (the Pinterest template).

Use the food from BOTH reference images:
- The second image is the HERO (full finished dish)
- The third image is the SERVING STEP (close-up portion/slice showing inside detail)
Combine BOTH food images into the pin layout — show the hero AND the serving/slice view together for maximum visual appeal.

Title text on the pin: "{{pin_title}}"
Website: {{website}}

RULES:
- Match the template layout exactly
- Use BOTH food photos (hero + serving step) not just one
- If the template has two photo areas use hero in one and serving in the other
- If the template has one photo area combine both views creatively
- Text must be readable and well-placed
- Vertical Pinterest format
- Professional eye-catching design`;


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
