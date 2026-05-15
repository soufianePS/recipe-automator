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
- Each step specifies its container. DEFAULT = same container as previous step. Containers ONLY change when the recipe physically transfers food (mixing bowl → baking pan when pouring batter, skillet → plate when serving). Two consecutive "mixing" steps share the SAME mixing bowl — not "a glass bowl" then "a ceramic bowl"
- Every step must list EXACT visible ingredients and FORBIDDEN ingredients
- Forbidden = anything that has NOT been added yet at this step + any garnish/decoration (unless it's the last step)
- For continuity: only allow previous image as context when same container + small change
- NEVER show ingredients from future steps
- Previously mixed ingredients cannot reappear separately
- The ingredients image must show ALL raw ingredients laid out separately
- The hero image must show the final finished dish

FOOD IDENTITY CANON (CRITICAL — prevents shape/identity drift across steps):
- If the recipe has a recognizable WHOLE-FOOD or DISTINCTIVE-SHAPE protagonist (whole ham, whole roast, whole chicken/turkey, brisket, fish fillet, salmon side, cake, pie, loaf, casserole, lasagna, taco/burrito, sandwich, dumpling, cookie batch, pasta dish with characteristic shape, etc.), generate a "food_identity_canon" object.
- If the food is AMORPHOUS (soup, sauce, scrambled mix, smoothie, dip, oatmeal, stew without recognizable shape), set food_identity_canon to null.
- The canon DEFINES the food's visual identity ONCE and every step that contains this food MUST repeat the silhouette + size descriptors verbatim in its food_state field.
- Generate the canon from the recipe (what cut of meat, what cake pan size, what fold for tacos, etc.).
- Also generate a "prep_search_query" — 3-6 word Pinterest search query that would return a real photo of the food in its RAW or PRE-COOK state. Example: "raw bone-in spiral ham scored uncooked", "unbaked layer cake batter pan", "raw uncooked tacos folded". The pipeline scrapes this to anchor step 1's silhouette.

COMPOSITION (CRITICAL — Flow won't position things unless told exactly where):
- Every step has a "composition" object describing WHERE everything goes in the frame.
- Use spatial language Flow respects: quadrants (top-left/top-right/center-left/center/center-right/bottom-left/bottom-right), frame coverage percent ("food fills 60% of frame width"), depth ("front of pan", "back-left corner"), counts ("4 visible orange slices fanning to lower-right"), orientation ("bone end angled top-right at 30°").
- The composition object is REQUIRED on every step. Vague terms like "scattered" or "loosely arranged" alone are NOT enough — name the quadrant AND the count AND the orientation.
- STRICT CONTAINMENT: when describing food_state, secondary_elements, or arrangement, NEVER say things like "berries scattered around the blender", "herbs scattered on the counter", "crumbs around the bowl", "ingredients on the marble", "stray items on the surface", "spilled X on the counter". Flow renders those phrases literally and produces images with food on the bare counter. ALL food MUST be inside the container. Negative_space should describe the empty surface as "completely bare — no food items".

CAMERA ANGLE SELECTION PER STEP:
- Choose the BEST angle for each step based on what needs to be visible:
  * "top-down": flat lays and ingredients and mixing bowls and sheet pans
  * "45-degree angle": most cooking steps and skillets and pots and plated dishes (shows depth and volume)
  * "slight overhead (30-degree)": baking dishes and casseroles and layered items
  * "eye-level": tall items like stacked pancakes and layered cakes and drinks
- Do NOT use the same angle for every step. Mix angles for visual variety.
- Ingredients image: "slight overhead (30-degree)" — shows 3D depth of standing bottles, whole produce, and packaged products; pure top-down is only acceptable when all items are genuinely flat (no standing packages)
- Hero image: "45-degree angle" (magazine style)

RECIPE JSON:
{{recipe_json}}

Output ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "food_identity_canon": {
    "primary_food": "name the recognizable whole-food protagonist, e.g. 'bone-in spiral-cut ham', 'round layer cake', 'soft folded tacos'. Set the entire canon to null if the food is amorphous (soup, sauce, scrambled mix).",
    "silhouette": "describe the OVERALL SHAPE/SILHOUETTE in 1-2 sentences: classic pear/teardrop for ham, 9-inch round 2-inch tall for cake, soft U-fold for tacos, log-shaped for meatloaf. Be specific.",
    "size": "describe size relative to its container: 'fills ~70% of a 13×9 roasting pan', '6-inch round cake', '5-inch tortilla folded',",
    "hallmark_features": ["array of 2-4 DISTINGUISHING visual features that identify this food: e.g. for ham — 'spiral cuts around wider end', 'diamond-scored top dome', 'bone protruding from wider end at angle'. These are what make it unmistakably this food."],
    "color_progression": "describe how color evolves across steps: 'raw pink → mahogany glaze' for ham, 'pale batter → golden top' for cake, 'raw beige tortilla → lightly charred' for tacos. Used to maintain identity at every cook stage.",
    "prep_search_query": "3-6 word Pinterest query that would return a real photo of this food in its RAW/PRE-COOK state. Examples: 'raw bone-in spiral ham scored', 'unbaked layer cake batter pan', 'raw folded soft tacos'. Used as identity anchor reference."
  },
  "ingredients_image": {
    "image_type": "ingredients",
    "layout": "Describe a NATURAL asymmetric scatter across the ENTIRE surface edge-to-edge. Specify WHICH items stay in their whole form (whole vegetables, bottles/boxes/jars standing upright WITH visible fake brand labels), WHICH are in small ramekins (ONLY finely chopped herbs, spices, grated cheese, diced small items). Explicitly say items are at DIFFERENT heights and DIFFERENT distances apart. NO grid, NO circle, NO matching bowls for every item.",
    "camera_angle": "slight overhead (30-degree)",
    "items": [
      { "name": "ingredient name", "state": "DEFAULT = whole/raw uncut as-purchased (whole apple, whole cucumber, whole banana, whole pineapple, whole head of garlic, whole onion). ONLY mark as 'chopped'/'diced'/'grated'/'sliced' when the item comes PRE-PROCESSED from the store (bagged pre-shredded cheese, canned diced tomatoes) OR when the image is of a mid-recipe PREPARATION step — NEVER for the initial ingredients image.", "presentation": "whole | small ramekin | standing bottle | standing box/bag | large plate — pick the most natural one, vary across items", "brand": "ONLY fill this for ingredients still IN their store packaging (bottles, jars, boxes, bags, cans, sealed wrappers). The brand label goes on the PACKAGE itself. For ingredients scooped into plain bowls/ramekins leave this EMPTY — no brand sticker on bowls. Example fake brands for packaged items: 'Heath Riles BBQ', 'Great Value', 'GRAZA'" }
    ],
    "forbidden": ["cooked food", "mixed items", "garnish", "utensils", "grid layout", "identical bowls for every item", "blank unlabeled packaging"]
  },
  "visual_steps": [
    {
      "step_id": 1,
      "title": "short action title",
      "container": "choose based on recipe type",
      "camera_angle": "choose best angle for this step",
      "visible_ingredients": [
        { "name": "ingredient", "state": "visual state description" }
      ],
      "forbidden_ingredients": ["list of ingredients NOT allowed in this image"],
      "food_state": "detailed description of food appearance at this exact moment. If food_identity_canon is non-null AND this step contains the primary_food, COPY-PASTE the silhouette + size + hallmark_features descriptors VERBATIM at the start of this field, then add what's specific to this step. Example: 'Classic pear/teardrop bone-in spiral ham, fills ~70% of roasting pan, diamond-scored top with cloves at every intersection — raw pink color, no glaze yet at this scoring stage.'",
      "shape_change": "true|false — true ONLY if this step physically transforms the food's silhouette (slicing, mashing, pouring batter into pan, folding tacos). false for cosmetic changes (basting, scoring, glazing, adding garnish).",
      "composition": {
        "subject_placement": "name the quadrant + frame coverage: 'center-left, fills 65% of frame width', 'bottom-center, fills 50% of frame'",
        "subject_orientation": "how the food is oriented: 'spiral-cut side facing camera', 'bone end angled top-right at 30°', 'cake cut-side up'",
        "secondary_elements": [
          { "what": "diamond score marks", "where": "entire top dome in 1.5-inch diagonal grid", "count": "~24 intersections visible" }
        ],
        "negative_space": "describe what's empty: 'top-right of pan empty', 'back of plate shows tile wall'",
        "depth": "front/back relationships: 'food sits 2 inches from front pan edge', 'garnish in foreground, food center'"
      },
      "continuity": {
        "uses_previous_image": false,
        "reason": "why or why not use previous image as context"
      }
    }
  ],
  "hero_image": {
    "image_type": "hero",
    "base_description": "final dish description. If food_identity_canon is non-null, INCLUDE the silhouette + hallmark_features VERBATIM here too.",
    "container": "choose based on recipe type",
    "camera_angle": "45-degree angle",
    "composition": {
      "subject_placement": "quadrant + frame coverage",
      "subject_orientation": "how oriented in the frame",
      "secondary_elements": [{ "what": "", "where": "", "count": "" }],
      "negative_space": "what's empty",
      "depth": "front/back relationships"
    },
    "allowed_additions": ["garnish if recipe includes it", "final presentation touches"],
    "forbidden": ["raw ingredients", "extra bowls", "utensils", "side dishes not in recipe"]
  }
}`;


// ─────────────────────────────────────────────────────────────
// 2. FLOW IMAGE PROMPT TEMPLATE — converts JSON state to Flow text
// ─────────────────────────────────────────────────────────────

export const DEFAULT_FLOW_IMAGE_PROMPT = `Photorealistic food photography — natural homemade kitchen-photo style. {{lighting}}.

SCENE:
- Background: PRESERVE the uploaded reference image surface EXACTLY — its exact color, marble veining, grain, texture, edges, and minor flaws. Do NOT replace, regenerate, lighten, darken, or stylize it.
- The lighting in this image MUST visually match the natural lighting already present in the uploaded reference (same direction, same softness, same warmth, same shadow length and angle). Treat it as a real continuation of that scene.
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

export const DEFAULT_FLOW_INGREDIENTS_PROMPT = `Photorealistic food photography, editorial style, natural soft daylight. {{lighting}}.

BACKGROUND — FILL ENTIRE FRAME:
- The ENTIRE frame from edge to edge must be the uploaded reference surface (wooden board, marble, linen, etc.)
- No blank space, no white borders, no cropping — the reference surface fills 100% of the image
- Preserve the exact grain, color, stripes, and texture of the uploaded reference

INGREDIENTS TO SHOW (each separate, not mixed):
{{ingredients_list}}

LAYOUT — NATURAL SCATTER, NOT A GRID:
- Items placed organically with asymmetric spacing — NO perfect grid, NO circle, NO straight line
- VARY the container types: 1-2 large plates or wooden boards for the star ingredients, a few small ceramic ramekins ONLY for finely chopped or grated items (herbs, spices, cheese)
- Use INGREDIENTS IN THEIR REAL FORM when possible: whole vegetables as-is (whole potatoes, whole garlic bulb, whole onion), bottles standing upright, boxes and bags standing upright, jars with labels facing forward
- MIX heights: tall bottles and boxes standing (upright) + flat items (bowls, herbs on surface) create visual depth
- VARY bowl and plate sizes — some large, some small, some tiny — never all identical
- Items should be DIFFERENT distances apart — some clustered together, some with gaps, none perfectly aligned
- Fill the composition edge-to-edge — ingredients reach near all 4 sides of the frame, not clustered in the center

REAL PRODUCT PACKAGING (CRITICAL FOR AUTHENTICITY):
- Packaged ingredients MUST show realistic product packaging with visible BRAND LABELS — invent believable brand names if needed (e.g., "Heath Riles BBQ", "Great Value Baking Soda", "GRAZA High Heat Oil", "Frontier Spice Co.", "Sun Harvest Flour")
- Bottles, jars, cans, boxes, bags, cartons MUST have full product labels with readable brand name + product type + typical packaging design elements (color bands, mascot, product photo on the box, etc.)
- Labels face forward toward camera so brand/product is readable
- Avoid blank, sterile, unlabeled containers — every packaged item must look like a real grocery-store product
- It's fine to invent brand names (fake brands are acceptable) — the goal is authentic grocery-product appearance, NOT real trademarks

{{layout}}

STRICT RULES:
- Every ingredient must be clearly visible and identifiable
- Raw ingredients only — nothing cooked or mixed
- No garnish unless it's an actual ingredient in the recipe
- No utensils, no cutting boards as separate items (the board IS the background)
- NO grid layout, NO circular arrangement, NO rows
- NO matching bowls for every ingredient — use the item's natural form whenever possible
- {{camera_angle}} angle
- No watermark
- No floating text overlays or captions
- Text on packaging is REQUIRED (brand names, product types, nutrition banners) — this is natural product photography, not blank containers`;


// ─────────────────────────────────────────────────────────────
// 4. FLOW HERO PROMPT TEMPLATE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_FLOW_HERO_PROMPT = `Photorealistic food photography — natural homemade kitchen-photo style, NOT a commercial studio shot. {{lighting}}.

SCENE:
- Background: PRESERVE the uploaded reference image surface EXACTLY — its exact color, marble veining, grain, texture, edges. Do NOT replace, regenerate, lighten, darken, or stylize it.
- The lighting MUST match the natural lighting in the uploaded reference (same direction, same softness, same warmth, same shadow shape). Treat it as the same scene, same hour of day.
- {{base_description}}
- {{container}}, {{camera_angle}} angle
- Appetizing but realistic — looks like a careful home cook's photo, not a magazine ad

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

export const DEFAULT_VERIFIER_PROMPT = `You are validating a recipe step image for ACCURACY and QUALITY.

EXPECTED STEP:
- Container: {{container}}
- Camera angle: {{camera_angle}}

ALLOWED visible ingredients:
{{visible_ingredients_list}}

FORBIDDEN ingredients (must NOT appear):
{{forbidden_ingredients_list}}

Expected food state: {{food_state}}

IMPORTANT: The background surface may contain elements like rings, cables, cloth edges, table texture, etc. These are part of the BACKGROUND — ignore them completely. Only check the FOOD and CONTAINER, not background surface elements.

ACCURACY CHECKS:
1. List every visible food element in the image
2. Check if the main container matches the expected type ({{container}})
3. Check if any FORBIDDEN ingredient appears
4. Check if any ingredient from a FUTURE step is visible
5. Check if previously mixed ingredients reappear separately
6. Check if the food state matches the expected description

IMAGE QUALITY CHECKS:
7. Does the food have warm rich colors? (golden-brown, deep sauces, vibrant vegetables — NOT grey, pale, or washed-out)
8. Is the food in sharp focus with visible texture? (you should see grain, fibers, bubbles, flakes)
9. Does the food look 3D with depth and volume? (NOT flat or compressed)
10. Does the food look moist and fresh? (NOT dried out or stale)
11. Would this image look professional on a food blog?

SEVERITY RULES:
- HARD_FAIL: forbidden ingredient found, future ingredient visible, food completely wrong state, totally wrong container type
- HARD_FAIL: food is grey or completely washed-out with no color
- HARD_FAIL: image is blurry or food is unrecognizable
- HARD_FAIL: identity_match is false (food does not match the food_identity_canon — wrong silhouette/shape/cut)
- SOFT_FAIL: framing slightly off, minor texture difference, container slightly different style but same category
- SOFT_FAIL: food is slightly pale but still recognizable
- SOFT_FAIL: composition_match is false (food is in the wrong quadrant / wrong orientation / secondary elements out of place) but identity is OK
- PASS: food matches expected state AND looks appetizing with good colors and texture AND matches identity canon

OUTPUT JSON ONLY (no markdown, no explanation):
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "container_count": 1,
  "state_match": true,
  "identity_match": true,
  "composition_match": true,
  "stray_items_outside_container": false,
  "quality_score": 8,
  "issues": []
}

quality_score: 1-10 rating of image quality (colors, texture, appeal). Below 5 = SOFT_FAIL.
identity_match: true unless a food_identity_canon was specified and the visible food does NOT match its silhouette/hallmark features. When no canon is specified, default to true.
composition_match: true unless a composition spec was specified and the food is in the WRONG QUADRANT or WRONG ORIENTATION. Only check the 2-3 most important spatial facts (subject quadrant, subject orientation, presence of secondary elements in their specified zones). Do NOT fail for small percentage differences. When no composition is specified, default to true.
stray_items_outside_container: true if you see ANY food items (berries, herbs, crumbs, droplets, slices, spilled ingredients) sitting on the bare counter/marble/surface OUTSIDE the container. The surface around the container should be completely bare. The ingredients flat-lay image is the ONLY image where items on the surface are allowed — for every other step/hero image, food on the surface around the container is a HARD_FAIL. Set this to false ONLY if the surface is genuinely bare around the container.`;


// ─────────────────────────────────────────────────────────────
// 6. VERIFIER PROMPT — INGREDIENTS IMAGE
// ─────────────────────────────────────────────────────────────

export const DEFAULT_VERIFIER_INGREDIENTS_PROMPT = `You are validating a recipe ingredients flat-lay image.

EXPECTED:
- All ingredients clearly visible and identifiable (in whatever form — whole, in bowls, in standing packaging — ALL acceptable)
- Camera angle: {{camera_angle}}

REQUIRED ingredients (must ALL be visible):
{{ingredients_list}}

ACCEPTABLE PRESENTATIONS (do NOT fail for any of these):
- Whole vegetables / meats / produce placed directly on the background
- Standing bottles, boxes, bags, jars with visible (even fake) brand labels
- Small ramekins or bowls for chopped/grated items
- Mixed scatter layouts with varied heights and spacing
- Items reaching near the frame edges

FORBIDDEN:
- No cooked food
- No mixed/combined ingredients
- No garnish
- No utensils or extra props

IMPORTANT:
- Text on packaging (brand names, product labels) is EXPECTED and fine — this is real-product aesthetic, NOT a watermark
- The background surface may contain elements like rings, cables, cloth, table texture. These are part of the BACKGROUND — ignore them. Only check the FOOD items.

VALIDATION CHECKS:
1. List every visible food item (ignore background surface elements)
2. Check if all required ingredients are present
3. Check if any ingredient appears cooked or mixed
4. Check for extra food items not in the required list
5. Presentation is FLEXIBLE — items may be whole on the surface, in bowls, or in standing packaging. Do NOT fail based on presentation style. Only fail if an ingredient is MISSING, COOKED, or clearly the wrong thing.

PASS CRITERIA — pass the image if:
- All required ingredients are visible (in any form: whole, bowl, packaged)
- Nothing is cooked or mixed
- No disallowed extra food items

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

export const DEFAULT_VERIFIER_HERO_PROMPT = `You are validating a recipe hero/final image. This is the MOST IMPORTANT image — it must look stunning and appetizing.

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
5. Does the food have rich vibrant colors (not washed-out or pale)?
6. Does the food look generous and abundant (not flat or sparse)?
7. Would this image make a reader hungry and want to cook this recipe?

SEVERITY RULES:
- HARD_FAIL: wrong food entirely, no food visible, forbidden elements, food looks raw/uncooked
- HARD_FAIL: food is washed-out or extremely pale with no color contrast
- HARD_FAIL: food looks flat or empty or unappetizing
- HARD_FAIL: identity_match is false (hero does not match food_identity_canon — wrong silhouette)
- SOFT_FAIL: food looks slightly pale but acceptable, minor presentation issue
- SOFT_FAIL: composition_match is false (subject in wrong quadrant) but identity is OK
- PASS: food looks delicious and appetizing AND matches the identity canon

OUTPUT JSON ONLY:
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "appetizing": true,
  "identity_match": true,
  "composition_match": true,
  "stray_items_outside_container": false,
  "issues": []
}

identity_match / composition_match: same rules as the step verifier — default to true when no canon/composition was specified.
stray_items_outside_container: true if food items (crumbs, herb leaves, droplets, slices) sit on the bare counter OUTSIDE the plate/serving dish. Garnish ON the plate edge is fine. Stray food on the bare counter around the plate is HARD_FAIL.`;


// ─────────────────────────────────────────────────────────────
// 8. CORRECTION PROMPT TEMPLATE — sent after verification fails
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 9. SIMILARITY CHECK PROMPT — compare step N vs step N-1
// ─────────────────────────────────────────────────────────────

export const DEFAULT_SIMILARITY_CHECK_PROMPT = `You are comparing two recipe step images. Each step MUST look visually distinct to a reader scrolling the blog.

IMAGE 1: Previous step (step {{prev_step}})
IMAGE 2: Current step (step {{current_step}})

The current step should show: {{expected_change}}

COMPARE THESE SPECIFIC ELEMENTS:
1. FOOD COLOR — is the color noticeably different? (raw white → golden brown? pale → sauced?)
2. FOOD TEXTURE — has the texture visibly changed? (chunky → smooth? dry → glossy? raw → cooked?)
3. FOOD POSITION — has the food moved, flipped, shifted, or transferred to a different container?
4. NEW INGREDIENTS — are there new visible ingredients that weren't in the previous step?
5. CONTAINER — did the container change? (bowl → skillet? pan → plate?)
6. VOLUME/AMOUNT — did the food visibly reduce, expand, or change shape?
7. READER TEST — would a food blog reader scrolling quickly see TWO clearly different photos or think it is the same photo shown twice?

STRICT SCORING (be harsh — blog readers notice when steps look the same):
- 0-30: Very different images (different container, major color change, clear transformation)
- 31-55: Moderately different (same container but clear food state change)
- 56-75: Somewhat similar (same container, slight change, reader might notice)
- 76-100: Too similar (looks like the same photo with minor tweaks)

OUTPUT JSON ONLY:
{
  "similarity_score": 0,
  "differences_found": [],
  "missing_changes": [],
  "verdict": "DISTINCT"
}

verdict must be: "DISTINCT" (0-55), "BORDERLINE" (56-75), or "TOO_SIMILAR" (76-100)`;


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
- The "category" field MUST be one of these: {{categories}}.

PUNCTUATION & HUMAN VOICE RULES (critical for anti-AI detection):
- NEVER use semicolons ( ; ) anywhere. Humans rarely use them. Replace with a period + new sentence OR with "and" / "but".
- Replace most commas inside paragraphs with linking words ("and", "but", "so", "then", "because", "while"). A few natural commas are fine (e.g. "For lunch, dinner, or snacks").
- AVOID Oxford commas in 3-item lists when natural — write "salt pepper and thyme" not "salt, pepper, and thyme".
- USE contractions everywhere: "don't" not "do not", "can't" not "cannot", "it's" not "it is", "you'll" not "you will", "I've" not "I have", "won't" not "will not".
- Mix sentence lengths: some short (5-7 words), most medium (10-15 words), occasionally long. Never uniform length.
- Occasional sentence fragments are welcome. Like this one. They feel natural and human.
- Start some sentences with "And", "But", "So" — this is how people actually write conversationally.
- Use em-dashes ( — ) for asides instead of parenthetical commas when possible.
- Each paragraph must end with a period (not an em-dash or comma).

OUTPUT ONE JSON with three sections: "recipe", "visual_plan", "pinterest_pins".

==============================
SECTION 1 — "recipe" (blog post content):

INTRO RULES:
- Write introduction with MINIMUM 3 paragraphs separated by \\n\\n.
- Each paragraph must feel natural and human with smooth transitions.
- No AI cliches (no "delve" "elevate" "mouthwatering" "culinary journey").

INTERNAL LINKING RULE (CRITICAL for SEO):
- You will receive a list of EXISTING recipes from this blog in the {{related_recipes}} variable.
- Pick 3 to 5 recipes that are topically related to "{{topic}}" and link to them naturally throughout the post.
- Required placements: 1 link in intro (2nd or 3rd paragraph), 1 link in "why_this_works" or the cooking tips section, 1 link in "substitutions" or "storage_notes" section, 1-2 links in conclusion.
- Use the EXACT markdown syntax: [Recipe Title](https://full-url) with the exact title and url from the list.
- Write natural sentences around the links like "If you love this recipe, try our [Easy Overnight Oats](url) for another quick breakfast."
- Do NOT invent recipes — only use what is provided in {{related_recipes}}.
- If the {{related_recipes}} list is empty, skip linking and write normally.
- Spread links across different sections — do NOT cluster them all in the intro or conclusion.

INGREDIENT RULES:
- List all ingredients with name and quantity and description (short functional role).
- Add a period at the end of each ingredient description.
- Every ingredient name MUST specify exact variety when one exists — e.g. "penne" not "pasta", "russet potato" not "potato", "sharp cheddar" not "cheese", "boneless chicken breast" not "chicken". Never use generic terms for pasta rice potato cheese meat bread tomato onion sugar flour or oil.

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

STEP DESCRIPTION RULE — TESTED-RECIPE SIGNALS (CRITICAL — humans-tested-this-in-a-real-kitchen feel):
- Each step.description MUST be 2-3 short paragraphs (not one wall of text). Use periods, not run-ons. Mix short and medium sentences.
- EVERY step description MUST include ALL SIX of these tested-recipe signals where they apply to that step:
  1. SPECIFIC TEMPERATURE — exact number, never vague. Examples: "375°F", "medium-low heat (about 4 on a 10-dial)", "350°F preheated oven", "medium-high heat until the pan is hot but not smoking".
  2. SPECIFIC TIME — exact range, never vague. Examples: "8 to 10 minutes", "exactly 90 seconds per side", "until minute 12", "rest for 15 minutes off the heat".
  3. SPECIFIC TECHNIQUE — the actual hand-motion or tool action. Examples: "fold gently with a rubber spatula in a J-shaped motion", "press the dough with the heel of your hand and turn 90 degrees between folds", "swirl the pan once at minute 3 to redistribute the butter", "scrape the bowl down with a spatula halfway through".
  4. ONE CONCRETE SENSORY CUE — what the cook sees, hears, or smells when this step is done. Examples: "the edges turn deep golden and a thin crust forms on the surface", "you'll hear the sugar stop sizzling and start crackling — that's the cue to remove from heat", "the sauce coats the back of a spoon and a finger drawn across leaves a clean line", "you'll smell the garlic toast right when the cloves are ready".
  5. WHAT GOES WRONG IF YOU MISS THE WINDOW — one short clause. Examples: "miss this and the proteins seize up and the sauce breaks", "go past 12 minutes and the bottom scorches", "skip the rest and the juices run out the moment you cut".
  6. WHY-CLAUSE AT END — the LAST sentence of the description must be ONE short clause (≤15 words) explaining WHY this temperature / time / technique matters. Naming the chemistry, the structural change, or the failure mode you're avoiding. Examples: "Sear 90 seconds without moving — the fond builds the sauce later.", "Rest 15 minutes before slicing — gives the juices time to redistribute so each slice stays moist.", "Bake at 325°F not 350°F — slow heat keeps the sugars from burning before the inside warms through.", "Boil hard at full heat — the convection finishes the gluten in 8 min, low heat leaves the center pasty."
- For every 4-5 steps, include ONE personal-testing first-person note inside the description (in parentheses or as its own sentence). Examples: "(I tried doubling the cheese the first time — it overflowed every ramekin. This is the goldilocks amount.)", "(My first batch went into a 400°F oven and the top set before the center cooked through. 375°F is the fix.)", "(I used to skip the rest. The first cut leaks half the sauce — don't skip it.)".
- Use contractions: "don't", "can't", "you'll", "it's". NO semicolons. NO em-dashes inside descriptions (em-dashes belong only to first-person notes wrapped in parentheses).
- BANNED phrases that scream AI: "easy to prepare and make", "trust me on this", "I honestly haven't really shared", "elevate your", "delve into", "culinary journey", "comes together quickly".
- The "tip" field is for an ADDITIONAL practical tip — never duplicate content from the description.

ACCURATE COOKING TEMPERATURES (CRITICAL — readers will follow this and ruin food otherwise):
- The temperature you write MUST actually cook the food properly. Not a "decorative low number" that sounds gentle but leaves the inside raw or the outside burnt.
- Match what working cooks and chef-tested recipes actually use. If web search is available, cross-reference real recipes for this dish.
- Standard targets to honor (don't deviate without reason):
  * Sears (steak, chicken cutlet): medium-high to high (≥400°F equivalent), 90 sec to 3 min per side
  * Roasts (whole chicken, pork loin, ham): 325–425°F + cite an INTERNAL TEMP target ("until 145°F internal" pork, "165°F" chicken thigh, "135°F" medium-rare beef)
  * Cookies: 350–375°F most styles, 10–14 min — avoid 400°F+ (burns)
  * Cakes: 325–350°F most styles, 25–35 min — avoid 400°F+
  * Bread/loaves: 350–425°F depending on type
  * Stews/braises: low to medium-low (~250–325°F oven, or stovetop simmer), 1.5–4 hours
  * Reductions/glazes: medium-low, 5–15 min until visibly thickened
- For roasts and large cuts: ALWAYS include an internal temperature target. "Bake 1 hour" without an internal-temp anchor is unsafe — readers' ovens vary.
- If you're unsure: pick the temperature most chef sources recommend for this exact dish. Do NOT round down to "feel safe" — undercooked food is a worse failure than slightly over.

TRANSFORMATION-ONLY STEP RULE:
- Each step in "recipe.steps" should be a cooking moment a food photographer would actually shoot. Some change is welcome (color, texture, container, volume, state) but SUBTLE progressions are perfectly fine — a sauce reducing slightly, a crust deepening one shade, a fold being added.
- Trivial single-line additions ("add salt", "splash water", "season to taste", "stir briefly") are NOT steps. Fold them INTO the description of the adjacent transformation. Example: instead of "season the meat" + "sear the meat", write a single SEAR step whose description begins "Season the meat right before it hits the pan, then sear..."
- Cap: keep step count tight. Most recipes need 4 to 5 steps. If your draft has more, MERGE adjacent low-impact steps into their nearest transformation.
- If you can't picture the photo for a step, it's not a step.

COOKING VISUAL PROGRESSION RULE:
- Food should naturally progress across steps. Reasonable arc: raw > combined > coated > softened > thickened > structured > melted > slightly browned > finished. Treat this as a HINT for the dish's overall journey, NOT a checklist that must be hit every step.
- Subtle progressions are encouraged: color deepening one shade, edges browning, sauce reducing, texture firming. Big jumps are NOT required — small visible changes are fine.

NO-SURPRISE-COMPONENT RULE (CRITICAL):
- NEVER introduce a major new component mid-recipe to create visual difference. If the dish ends with cream, frosting, glaze, sauce, garnish, or any topping, that component must appear in a step that EXPLICITLY assembles it (e.g., "spread the cream over the cooled cake"), not pop into existence between two cooking steps.
- The dish identity must hold across steps. A carrot cake without cream stays a carrot cake without cream until the recipe says to add cream — it does not silently gain cream just to look different in the next photo.
- If a step would feel "too similar" to the previous, prefer SUBTLE progression (deeper color, slight reduction, edges crisping) over inventing a new ingredient.

VISUAL UNIQUENESS RULE:
- Each step should be RECOGNIZABLE as different from the previous, but the difference can be subtle. ONE of: small color change / texture change / partial transformation / minor ingredient interaction is enough — full visual reinvention is not required.

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

WHY THIS RECIPE WORKS RULE:
- Write the why_this_works field as 2-3 genuine sentences showing expertise.
- Mention a specific technique, ingredient interaction, temperature, or timing trick that non-cooks would not know.
- Be concrete: "Cooking at 375°F instead of 400°F prevents the outer crust from setting before the center cooks through" NOT "the temperature is important for even cooking".
- This section signals E-E-A-T (experience and expertise) to Google.

SUBSTITUTIONS RULE:
- Provide 4-6 substitution entries covering dietary needs (dairy-free, gluten-free, egg-free) AND availability swaps (no buttermilk? use milk + vinegar).
- Each entry must have ingredient + swap + honest note about how it changes the result (texture, flavor, cook time).
- Be realistic: if a swap does NOT work well, say so. "Cream cheese for sour cream — works but the sauce becomes denser and slightly tangier. Good if that is what you want."
- Include at least 1 internal link to another recipe in one of the substitution notes (e.g., "If you prefer a lighter version try our [recipe name](url)").

STRUCTURE RANDOMIZATION RULE (CRITICAL anti-scaled-content signal):
- The blog post will be rendered from the JSON fields. Use the randomized section order and H2 titles provided below in {{section_structure}}.
- If {{section_structure}} is empty, use a default sensible order.
- NEVER use the same H2 titles in the same order as previous posts. Variation breaks the AI-templated-content signal Google flags.

SEO RULES:
- Generate SEO for hero image and ingredients image and each step image.
- Meta description must be under 155 characters.
- Add a period at the end of each equipment description.
- Add "?" at the end of each FAQ question.

READABILITY RULES (Yoast — non-negotiable, applies to ALL prose: intro, why_this_works, step descriptions, step tips, storage_notes, conclusion, fun_fact, faq answers, pro_tips, substitutions notes):
- SENTENCE LENGTH: average 15 words. NO MORE than 1 in 4 sentences (25%) may exceed 20 words. Break long sentences with a period — never with a comma splice. Re-read each sentence after writing: if it has more than 20 words OR more than 1 comma, split it.
- PARAGRAPH LENGTH: each paragraph 60 to 90 words. NEVER exceed 130 words. For multi-paragraph fields (intro, step description, storage_notes, conclusion) ALWAYS separate paragraphs with a literal "\\n\\n" (a blank line in the JSON string value). Single-blob multi-topic paragraphs are rejected by Yoast.
- STEP DESCRIPTION shape: write 2 to 3 SHORT paragraphs separated by "\\n\\n". Each paragraph 50 to 80 words. Don't merge "what to do" + "what you'll see" + "why it matters" into one giant paragraph — split them.
- TRANSITION WORDS: weave in 1 transition word per paragraph (then, next, meanwhile, finally, because, however, so, therefore). Yoast flags posts with under 30%.
- ACTIVE VOICE: ≥90% active voice ("Whisk the dressing" not "The dressing should be whisked"). Imperative for step descriptions and pro_tips.
- COMMA-SPLICE BAN: never join two independent clauses with a comma alone. Use a period or a coordinating conjunction (and / but / so / because / while).

RECIPE CARD DESCRIPTION RULE:
- Length must be 450 to 480 characters.
- Must include keywords: easy and ideas and quick and simple and best and healthy.
- Must mention events: weeknight dinner or meal prep or holiday or potluck or brunch or party.
- Must include 1 specific sensory hook (smell / texture / look) and 1 reason this version is different ("the trick is", "what makes this version", "the secret is"). Generic descriptions get penalized — aim to make a reader want to print the card.

FAQ RULE: Include 5 to 7 questions. Each ANSWER must be 2 to 3 sentences (40 to 80 words) with SPECIFIC details — temperatures, times, exact day-counts, concrete techniques. Cover a MIX of these categories so the FAQ isn't repetitive: (1) make-ahead / prep-ahead, (2) storage and shelf-life, (3) ingredient substitution / dietary swap, (4) common mistake or troubleshooting ("why is mine watery / why won't it set"), (5) scaling up or doubling, (6) serving suggestion or pairing, (7) reheating or freezing. NEVER answer with a single short sentence. NEVER repeat content already in pro_tips or storage_notes verbatim — paraphrase with new specifics.

PRO TIPS RULE: Include 6 to 8 tips. Each tip must be a COMPLETE 1 to 2 sentence instruction (15 to 35 words), not a fragment. Each tip must include AT LEAST ONE concrete data point: a temperature, a time window, a measurement, a brand, or a sensory cue. Mix categories across the tips: (1) technique / method, (2) ingredient quality or selection, (3) equipment trick, (4) timing or scheduling, (5) common mistake to avoid, (6) flavor-boost or finishing touch. NEVER write a tip that is just "salt your water" — write "Salt the boiling water heavily, about 1 tablespoon per quart, because this is the only chance to season the inside of the potato."

CONCLUSION RULE: Write 3 to 4 sentences. Wrap up with one personal moment, one reason this version is special, and one invitation (try it, share it, tag).

SECTION 2 — "visual_plan" (for AI image generation):
This tells the image generator EXACTLY what each photo should show.

FOOD IDENTITY CANON (CRITICAL — prevents shape/identity drift across steps):
- The visual_plan MUST start with a "food_identity_canon" object IF the recipe has a recognizable whole-food or distinctive-shape protagonist.
- Applies to: whole ham, whole roast, whole chicken/turkey, brisket, fish fillet, salmon side, cake, pie, loaf, bread, casserole, lasagna, tacos, burritos, sandwiches, dumplings, cookies, pasta with distinctive shape, etc.
- Set the entire food_identity_canon to null when the food is AMORPHOUS: soup, sauce, scrambled mix, smoothie, dip, oatmeal, stew without recognizable shape, scattered stir-fry.
- When non-null, every visual_step that contains the primary_food MUST COPY-PASTE the silhouette + size + hallmark_features descriptors VERBATIM at the start of its food_state. Do not paraphrase. Same copy-paste discipline as the container continuity rule.
- Also generate "prep_search_query" — a 3-6 word Pinterest search returning a real photo of the food's RAW or PRE-COOK state. Used by the pipeline as an identity-anchor reference image.

COMPOSITION OBJECT PER STEP (CRITICAL — Flow won't position things unless told exactly where):
- Every visual_step MUST have a "composition" object describing WHERE everything goes.
- Use spatial language Flow respects: quadrants (top-left, center-left, center, bottom-right, etc.), frame coverage percent ("food fills 60% of frame width"), depth ("front of pan", "back-left corner"), counts ("4 visible orange slices fanning to lower-right"), orientation ("bone end angled top-right at 30°").
- Vague terms like "scattered loosely" alone are NOT enough — name the quadrant AND the count AND the orientation.
- STRICT CONTAINMENT: NEVER write "berries scattered around the blender", "herbs on the counter", "crumbs around the bowl", "ingredients on the marble", or any phrase placing food OUTSIDE the container. Flow renders those literally. ALL food belongs INSIDE the container. Use negative_space to say "marble surface completely bare — no food items".
- The hero_image also gets a composition object — same schema.

SHAPE_CHANGE FLAG PER STEP:
- Each step MUST include "shape_change": true|false.
- true ONLY if this step physically transforms the food's silhouette (slicing, mashing, pouring batter into a different vessel, folding tacos, layering cake).
- false for cosmetic changes that keep the silhouette intact (basting, scoring, glazing, adding garnish, sprinkling toppings, reducing sauce).
- Used by the silhouette-drift detector to flag bad images when the food's shape changes without justification.

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
- Blender jar: blending smoothies, sauces, purees, soups — shows the appliance base + transparent jar filled with ingredients
- Food processor bowl: chopping, pureeing, pulse-mixing — shows the appliance with ingredients inside
- Air fryer basket: air-frying crispy items — shows the perforated basket with food
- Slow cooker / Instant Pot inner pot: slow-cooked stews, roasts, pressure-cooked dishes
- Grill pan / outdoor grill grate: grilled meats and vegetables with char marks
- Deep fryer basket: deep-fried items with hot oil visible
- Waffle iron: waffles cooking in the iron
CRITICAL: The container CAN and SHOULD change between steps when the recipe requires it.
Real cooking uses multiple containers: bowl (mix) → blender (puree) → glass (serve).
Each step MUST specify which container is used at that exact phase.
Do NOT force the same container for ALL steps unless the recipe truly uses only one.
APPLIANCE RULE: If the recipe truly needs a specific appliance (air fryer, blender, slow cooker, instant pot, grill, waffle iron, food processor), the step that uses it MUST use that appliance as the container — NEVER substitute with a generic bowl or pot.

CAMERA ANGLE SELECTION PER STEP:
- Choose the BEST angle for each step based on what needs to be visible:
  * "top-down": flat lays and mixing bowls and sheet pans (good for seeing all ingredients)
  * "45-degree angle": most cooking steps and skillets and pots and plated dishes (shows depth and volume)
  * "slight overhead (30-degree)": baking dishes and casseroles and layered items
  * "eye-level": tall items like stacked pancakes and layered cakes and drinks in glasses
- Do NOT use the same angle for every step. Mix angles for visual variety.
- Ingredients image: "slight overhead (30-degree)" by default to show 3D depth of standing bottles, whole produce, and packaged products. Only use pure "top-down" (90°) when every single item is genuinely flat (no standing packages, no whole 3D produce).
- Hero image: always "45-degree angle" (magazine style)
- Steps: vary between angles based on what shows the food best

VISUAL PLAN RULES:
- Create between {{min_steps}} and {{max_steps}} visual steps
- Each step = at least ONE visible change from previous, but it can be SUBTLE (color deepening, sauce reducing, texture firming) — big visual jumps are NOT required.
- List EXACT visible and FORBIDDEN ingredients per step
- visible_ingredients entries and every step/hero image prompt MUST repeat the exact ingredient variety used in the recipe (e.g., "cooked penne" not "cooked pasta", "shredded mozzarella" not "shredded cheese"). Flow needs the specific shape.
- Forbidden = anything NOT yet added + garnish (unless last step). NEVER add a major new component (cream, frosting, sauce, glaze, topping) to a step just to make it look distinct from the previous one — only add it if the recipe explicitly assembles it then.
- Steps should be recognizably different but a soft progression is preferred over a dramatic re-styling.
- Food progresses naturally: raw > combined > coated > softened > melted > browned > finished — use this as a HINT, not a rigid checklist that must be hit every step.
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
- Each step should have a NOTICEABLE visual difference from the previous step — subtle is fine (color deepening, texture firming, edges browning), dramatic is NOT required.
- If two consecutive steps would look NEARLY IDENTICAL (no progression at all, exact same image) then combine them. But mild differences are perfectly acceptable.

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

DETAILED VISUAL DESCRIPTORS PER STEP (CRITICAL — image generators only respect what you spell out):
- Every step's "food_state" AND every step's recipe.steps[].image_prompt MUST repeat — explicitly, every time — these visual anchors so the next image doesn't drift:
  1. EXACT COUNT: "3 chicken thighs" not "the chicken". Restate the number in every step that contains the item, even if obvious.
  2. EXACT SHAPE / CUT: "carrots halved lengthwise" not "carrots". If a previous step cut something into halves, every later step must say "halved" — never "whole" or "chopped".
  3. EXACT COLOR / COOKING DEGREE: name the color stage. "raw pale-pink chicken" → "edges golden, center still pink" → "deep amber crust, fully opaque inside" → "glossy lacquered mahogany finish". Do not use vague words like "cooked" or "browned".
  4. EXACT TEXTURE / SURFACE: "glossy", "matte", "wet", "crusted", "tacky", "slick with rendered fat", "sugar crystals visible". Spell it out — don't trust the model to guess.
  5. EXACT STATE OF EVERY VISIBLE INGREDIENT: list each ingredient with its current state in this step (raw / sweated / partially cooked / charred / set / melted / molten / drizzled / pooled).
- CONTINUITY ANCHOR: at the end of each step's food_state, include a short "matches step N-1 except for X" sentence. Example: "Same 3 thighs, halved carrots, and red onion wedges as step 1, but the chicken is now seared deep amber on top while the vegetables remain raw."
- Forbidden vague phrases in food_state and image_prompt: "cooked", "ready", "nicely browned", "looks delicious", "done". Replace with one of the specific descriptors above.
- The visual_plan visible_ingredients[].state field MUST mirror the same exact descriptor used in the recipe.steps description for that step. If recipe says "halved carrots", visible_ingredients must say "halved" — not "chopped" or "diced".
- DISH/CONTAINER SHAPE: name the EXACT container shape and size where helpful: "10-inch round cast-iron skillet", "9×13 ceramic baking dish", "small white pasta bowl with sloped rim". Reuse the exact same descriptor across steps that share the same container.

CONTAINER REALISM RULE:
- Each step uses the container that makes cooking sense for THAT phase.
- The container should look used and realistic not brand new.
- Container transitions must be logical: you mix in a bowl THEN transfer to a baking dish THEN serve on a plate.
- NEVER serve from the mixing bowl (transfer to the cooking vessel or serving plate).
- NEVER cook in a plate (plates are for serving only).

CONTAINER CONTINUITY RULE (CRITICAL — common failure):
- Default behavior: REUSE the EXACT same container across consecutive steps. Not "a similar bowl", not "another mixing bowl" — the SAME bowl with the same material, same color, same size, same descriptor.
- A container only changes when the recipe physically moves food to a different vessel. Acceptable transitions:
  * mixing bowl → baking pan (pouring batter)
  * baking pan → cooling rack → serving plate
  * skillet → plate (serving cooked food)
  * pot → bowl (ladling soup)
- Unacceptable container changes:
  * "glass mixing bowl" in step 1 → "ceramic mixing bowl" in step 2 (no transfer happened, just inconsistency)
  * "stainless skillet" in step 3 → "cast iron skillet" in step 4 (cooking continues in the SAME pan)
  * Any swap of material, color, or shape between steps where the food never actually left the vessel
- When the SAME container is reused: write the EXACT same descriptor in visual_steps[].container — copy-paste it. "large clear glass mixing bowl" must remain "large clear glass mixing bowl" across every step that uses it. Never paraphrase.
- The "position" field is where you describe what changed inside the SAME container (food shifted, color deepened, new ingredient folded in). Position changes ≠ container changes.

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

INGREDIENT RECONCILIATION RULE (CRITICAL — common failure):
- The "ingredients" array is generated AFTER "steps" in the JSON below for a reason. Write the steps first, completely, with all the techniques and ingredient mentions you naturally use. THEN derive "ingredients[]" by scanning every step text and listing every ingredient you referenced — each with a real quantity and unit.
- If a step says "Sift the flour and cinnamon and baking soda" — then flour AND cinnamon AND baking soda must each be a separate entry in ingredients[] with a measurement.
- If a step mentions salt, vanilla, water, oil for greasing, eggs to brush — they all belong in ingredients[] with quantities. Nothing is implied.
- After writing ingredients[], read every step ONE more time and check: every solid, liquid, spice, leavener, garnish, and aromatic mentioned in any step is in your list. If something is missing — add it.
- Do NOT use the unit "units" for eggs — write quantity as "4 large" with unit empty, or quantity "4" unit "large eggs". Same for whole-item things like "6 cookies", "1 lemon" — never "units".
- Frosting / glaze / sauce ratios must be realistic. Cream cheese frosting needs roughly 1 part sweetener to 4 parts cream cheese (e.g., 16 oz cream cheese pairs with about 1/2 cup of liquid sweetener PLUS 1-2 cups powdered sugar, NOT 2 tablespoons of syrup alone). Sense-check ratios before finalizing.

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
    "hero_prompt": "Describe the FULLY COOKED finished dish with natural imperfections.",
    "hero_seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []},
    "ingredients_prompt": "Natural asymmetric scatter of raw ingredients across the ENTIRE background edge-to-edge. Use each item in its real form when possible (whole vegetables, bottles and boxes standing upright). Only finely chopped/grated items go in small ramekins. Mix heights and distances. NO grid, NO matching bowls for every ingredient.",
    "ingredients_seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []},
    "steps": [{"number": 1, "title": "specific action", "description": "2 to 3 SHORT paragraphs SEPARATED BY \\n\\n (literal newline-newline in the JSON string). Each paragraph 50 to 80 words. Paragraph 1 = the actions to take (specific temps + times + technique). Paragraph 2 = the sensory cues to watch for (what you'll see, smell, hear). Optional paragraph 3 = the why-it-matters and the failure mode if you miss the window (max 60 words). Do NOT merge these into one block. Sentences max 20 words each. ~1 step in every 4 also carries a parenthetical first-person testing note (e.g., '(I tried 400°F first — top set before the center cooked. 375°F is the fix.)') in paragraph 1 or 2.", "tip": "ADDITIONAL practical tip — must NOT repeat anything from description. 15 to 30 words.", "image_prompt": "Describe natural imperfect food state after this step.", "seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []}}],
    "equipment": [{"name": "tool name", "notes": "1 sentence covering BOTH what it does for this recipe AND what to look for when buying or substituting (size in quarts/inches, material, the failure mode of using the wrong one). Example: 'A heavy-bottomed 6-quart Dutch oven distributes heat evenly so the bottom doesn't scorch — a thin-walled stockpot will hot-spot and burn the sugars.'"}],
    "ingredients": [{"name": "CLEAN ingredient name ONLY — no preparation, no state, no skin/peel notes. Examples GOOD: 'Yukon Gold potato', 'Duke's Mayonnaise', 'red onion', 'celery stalk', 'apple cider vinegar'. Examples BAD (do NOT do): 'Potato with skin', 'Onion, finely diced', 'Mayo (full-fat)', 'Eggs (room temp)'. The name is the LABEL a shopper would write. Capitalize sensibly (proper brand names yes, generic items lowercase or sentence-case).", "quantity": "amount + unit, e.g. '3 pounds', '1.5 cups', '2 tablespoons', '4 large'", "description": "PREPARATION + STATE detail goes here, never in the name. Sentence-style, ends with a period. Examples: 'Scrubbed, skin on, cut into 1-inch cubes for a waxier texture.', 'Hard-boiled and chopped to add richness to the base.', 'Finely diced for a necessary crunch.', 'Bring to room temperature before whisking.' If there's no special prep, write a short reason-to-use sentence instead of leaving empty."}],
    "why_this_works": "2 SHORT paragraphs SEPARATED BY \\n\\n. Each paragraph 50 to 80 words. Total 3 to 4 sentences explaining the science or technique that makes this recipe work — specific ingredient interactions, cooking temperatures, timing tricks. Mention 2 to 3 concrete details (e.g., 'Resting the dough for 30 minutes lets the gluten relax, so it rolls thinner without snapping back. Baking at 425°F triggers the Maillard reaction faster than 375°F'). Include 1 internal link to a related recipe naturally. Sentences max 20 words.",
    "substitutions": [{"ingredient": "ingredient name", "swap": "what to use instead", "note": "1-2 sentences on HOW the result differs (texture / flavor / outcome) AND a ratio or adjustment if needed (e.g., 'use 3/4 the amount because it's denser'). Be specific — never write 'works fine'."}],
    "pro_tips": ["6 to 8 entries — each a complete 1 to 2 sentence instruction (15 to 35 words) with at least ONE concrete data point (temperature, time, measurement, brand, sensory cue). Mix categories across the array: technique, ingredient selection, equipment, timing, common mistake, finishing touch. No fragments, no one-word tips."],
    "variations": ["3 to 4 entries — each a complete sentence describing a flavor twist, dietary adaptation, or seasonal swap with the actual change to make (e.g., 'Add 1 tablespoon of smoked paprika and 1/2 cup of bacon bites for a barbecue twist that pairs well with grilled meats')."],
    "faq": [{"question": "ends with ?", "answer": "2-3 sentences (40-80 words) with SPECIFIC details: temperatures, times, day-counts, techniques. Cover a MIX across the 5-7 questions: make-ahead, storage shelf-life, ingredient swap, troubleshooting, scaling, serving suggestion, reheating/freezing. NEVER repeat verbatim from pro_tips or storage_notes."}],
    "storage_notes": "2 SHORT paragraphs SEPARATED BY \\n\\n. Each paragraph 60 to 90 words. Paragraph 1 = fridge storage (exact day-count, container type) + freezing (yes/no, how to wrap, how long). Paragraph 2 = reheating (temp, time, add-back step like 'add 2 tablespoons of fresh cream') + spoilage signs to watch for. Be specific with numbers. Sentences max 20 words.",
    "fun_fact": "",
    "category": "",
    "cuisine": "",
    "prep_time": "PT15M", "cook_time": "PT30M", "total_time": "PT45M",
    "servings": "4",
    "conclusion": ""
  },
  "visual_plan": {
    "food_identity_canon": {
      "primary_food": "name the recognizable whole-food protagonist, e.g. 'bone-in spiral-cut ham', 'round layer cake', 'soft folded tacos'. Set entire canon to null if amorphous (soup, sauce, scrambled mix).",
      "silhouette": "overall shape in 1-2 sentences: 'classic pear/teardrop bone-in ham, ~9-inch length, bone protruding from wider end at 30°', '9-inch round cake, 2-inch tall, level top', 'soft U-fold tacos, 5-inch tortilla'.",
      "size": "relative to container: 'fills ~70% of a 13×9 roasting pan', '6-inch round cake takes up center of plate', '5-inch folded tortillas, 3 across the plate'.",
      "hallmark_features": ["2-4 DISTINGUISHING visual features that identify this food. For ham: 'spiral cuts around wider circumference', 'diamond-scored top dome', 'bone protruding from wider end at angle'. For cake: 'level top, no doming', '2 visible layers with frosting between'."],
      "color_progression": "describe how color evolves across cook stages: 'raw pink → mahogany glaze' for ham, 'pale batter → golden top' for cake, 'raw beige tortilla → lightly charred fold' for tacos.",
      "prep_search_query": "3-6 word Pinterest query for a real photo of the RAW/PRE-COOK state: 'raw bone-in spiral ham scored', 'unbaked layer cake batter pan', 'raw folded soft tacos uncooked'."
    },
    "ingredients_image": {
      "layout": "Natural asymmetric scatter edge-to-edge, NO grid, NO circle, NO matching bowls. Specify WHICH items stay in their whole form (whole vegetables, bottles/boxes/jars standing upright with visible brand labels) versus WHICH go in small ramekins (ONLY chopped herbs, spices, grated cheese). Items at different heights and different distances. For every packaged product (oils, spices, sauces, flours, sugars, canned goods) specify a believable fake brand name so the image shows real-looking packaging.",
      "camera_angle": "slight overhead (30-degree)",
      "items": [{"name": "", "state": "DEFAULT = whole/raw uncut as-purchased. Only mark as 'chopped'/'diced'/'grated' if the item is store-bought pre-processed (canned diced tomatoes, bagged shredded cheese). For the initial ingredients image, fresh produce stays WHOLE.", "presentation": "whole | small ramekin | standing bottle | standing box | large plate — choose the most natural per item, VARY across items", "brand": "ONLY for items still in STORE PACKAGING (bottle/jar/box/bag/can/sealed wrapper). Brand goes on the PACKAGE, never on a bowl or ramekin. Leave EMPTY for scooped/raw/fresh items. Example brands: 'Heath Riles BBQ', 'Great Value Flour', 'Sun Harvest Sugar'.", "placement": "position"}],
      "forbidden": ["cooked food", "mixed items", "garnish", "utensils", "grid layout", "identical bowls for every item", "blank unlabeled packaging"]
    },
    "visual_steps": [{
      "step_id": 1, "title": "specific action title", "container": "chosen container",
      "camera_angle": "choose best angle for this step",
      "visible_ingredients": [{"name": "", "state": "", "placement": "where in container"}],
      "forbidden_ingredients": ["ingredients NOT yet added"],
      "food_state": "detailed appearance. If food_identity_canon is non-null AND this step contains primary_food, COPY-PASTE the silhouette + size + hallmark_features descriptors VERBATIM at the start, then add what's specific to this step.",
      "shape_change": "true|false — true ONLY if step physically transforms the silhouette (slicing/mashing/pouring batter to new vessel/folding). false for cosmetic changes (basting/scoring/glazing/garnishing).",
      "composition": {
        "subject_placement": "quadrant + frame coverage: 'center-left, fills 65% of frame width'",
        "subject_orientation": "how oriented: 'spiral-cut side facing camera, bone end angled top-right at 30°'",
        "secondary_elements": [{"what": "thyme sprigs", "where": "scattered around the base of the ham, NOT on top", "count": "3-4 sprigs visible"}],
        "negative_space": "what's empty: 'top-right of pan empty', 'back-right shows tile wall'",
        "depth": "front/back: 'ham sits 2 inches from front pan edge, cast soft shadow back-left'"
      },
      "position": "how food moved from previous step (flipped/rotated/shifted/tilted) — KEEP for backward compat with prompt-builder",
      "arrangement": "overall composition — KEEP for backward compat"
    }],
    "hero_image": {
      "base_description": "finished dish, natural look. If food_identity_canon is non-null, INCLUDE the silhouette + hallmark_features VERBATIM here.",
      "container": "plate or serving dish",
      "camera_angle": "45-degree angle",
      "composition": {
        "subject_placement": "quadrant + frame coverage",
        "subject_orientation": "how oriented",
        "secondary_elements": [{"what": "", "where": "", "count": ""}],
        "negative_space": "what's empty",
        "depth": "front/back relationships"
      },
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

export const DEFAULT_VG_PINTEREST_PROMPT = `Generate a vertical Pinterest food pin (3:4 aspect). The first attached reference image is the DESIGN TEMPLATE — your output must reproduce its visual composition exactly. The second attached reference image is the REAL HERO PHOTO of the finished dish "{{recipe_title}}" — the food in your output comes ONLY from this image.

TEMPLATE FIDELITY (mandatory — read the first image carefully and match all of these):
1. SPATIAL LAYOUT: copy the template's exact spatial arrangement. If the template places the food photo on the RIGHT and the ingredients block on the LEFT, do the same. If it stacks them top/bottom, stack them. If it splits 50/50, split 50/50. Do NOT default to a top-text / bottom-photo Pinterest template — only use that arrangement if THIS template does.
2. BACKGROUND: copy the template's background texture and color palette (e.g. speckled granite, marble, linen, plain pastel — whatever it shows).
3. TYPOGRAPHY: copy the template's font family vibe (serif vs sans), weight (bold vs light), and color.
4. SECTION POSITIONS: the title, the ingredients block, the food photo zone, and the website footer must each be in the SAME ON-PAGE POSITION as the template shows them.

CONTENT FOR THE PIN (slot into the template positions above):
- Title (in the template's title position): "{{pin_title}}"
- If the template shows an ingredients section, use the literal header word "Ingredients:" (NOT the recipe name) and below it this exact bullet list (one item per line, keep the template's bullet style):
{{ingredients}}
- Food photo (in the template's photo zone): take it from the SECOND attached image. Preserve its background, colors, lighting, and composition unchanged. Do not redraw the food.
- Footer credit (in the template's footer position): "{{website}}"

CRITICAL RULES:
- The food shown in the final pin comes ONLY from image two, never from the template.
- Do not invent extra decorative elements the template doesn't have. Do not add watermarks or logos.
- The pin must be visually crave-worthy and clearly tied to "{{recipe_title}}" — a viewer should instantly recognize the dish.`;


// ─────────────────────────────────────────────────────────────
// DEFAULT SETTINGS
// ─────────────────────────────────────────────────────────────

export const VERIFIED_GENERATOR_DEFAULTS = {
  minVisualSteps: 4,
  maxVisualSteps: 8,
  maxVerificationRetries: 3,
  softFailAction: 'retry',        // 'accept' or 'retry' — retry soft fails for better quality
  defaultContainer: 'white ceramic bowl',
  defaultCameraAngle: 'slight overhead (30-degree)',
  defaultLighting: 'natural soft daylight matching the uploaded reference image — gentle ambient indoor light from a kitchen window with subtle directional softness, soft natural shadows under bowls and items, warm neutral tones (not orange), realistic iPhone-photo look. NO studio lighting, NO HDR, NO harsh shadows, NO dramatic spotlights, NO color grading, NO bokeh, NO commercial photo polish',
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
