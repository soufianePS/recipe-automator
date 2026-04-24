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
- SOFT_FAIL: framing slightly off, minor texture difference, container slightly different style but same category
- SOFT_FAIL: food is slightly pale but still recognizable
- PASS: food matches expected state AND looks appetizing with good colors and texture

OUTPUT JSON ONLY (no markdown, no explanation):
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "container_count": 1,
  "state_match": true,
  "quality_score": 8,
  "issues": []
}

quality_score: 1-10 rating of image quality (colors, texture, appeal). Below 5 = SOFT_FAIL.`;


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
- SOFT_FAIL: food looks slightly pale but acceptable, minor presentation issue
- PASS: food looks delicious and appetizing with good colors and texture

OUTPUT JSON ONLY:
{
  "status": "PASS",
  "detected_items": [],
  "forbidden_found": [],
  "appetizing": true,
  "issues": []
}`;


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
- Each step = ONE clear visual change from previous
- List EXACT visible and FORBIDDEN ingredients per step
- visible_ingredients entries and every step/hero image prompt MUST repeat the exact ingredient variety used in the recipe (e.g., "cooked penne" not "cooked pasta", "shredded mozzarella" not "shredded cheese"). Flow needs the specific shape.
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
    "ingredients_prompt": "Natural asymmetric scatter of raw ingredients across the ENTIRE background edge-to-edge. Use each item in its real form when possible (whole vegetables, bottles and boxes standing upright). Only finely chopped/grated items go in small ramekins. Mix heights and distances. NO grid, NO matching bowls for every ingredient.",
    "ingredients_seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []},
    "steps": [{"number": 1, "title": "specific action", "description": "1-2 paragraphs explaining visual change", "tip": "", "image_prompt": "Describe natural imperfect food state after this step.", "seo": {"filename": "", "alt_text": "", "title": "", "description": "", "keywords": []}}],
    "equipment": [{"name": "", "notes": "function."}],
    "why_this_works": "2-3 sentences explaining the science or technique that makes this recipe work — specific ingredient interactions, cooking temperatures, timing tricks. Mention 1-2 concrete details (e.g., 'Resting the dough for 30 minutes lets the gluten relax, so it rolls thinner without snapping back'). Include 1 internal link to a related recipe naturally.",
    "substitutions": [{"ingredient": "ingredient name", "swap": "what to use instead", "note": "how the result differs (texture, flavor, outcome) — be specific"}],
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

export const DEFAULT_VG_PINTEREST_PROMPT = `Create a Pinterest food pin using THREE uploaded reference images:

IMAGE ROLES:
1. FIRST image = DESIGN TEMPLATE (layout reference only — copy the text placement and section arrangement and color scheme and font style but NOT the food photos in it)
2. SECOND image = HERO PHOTO (the actual finished dish — use this REAL photo in the pin)
3. THIRD image = SERVING/SLICE PHOTO (close-up portion showing inside detail — use this REAL photo in the pin)

CRITICAL: The food in the SECOND and THIRD images are the REAL recipe photos. You MUST use BOTH of them in the final pin. Do NOT generate new food images. Do NOT use the food from the first template image. The template is ONLY for layout and style reference.

Title text on the pin: "{{pin_title}}"
Website: {{website}}

RULES:
- Copy the LAYOUT from the template: where text goes and where photos go and colors and fonts
- Place the HERO photo (image 2) and SERVING photo (image 3) into the photo areas of the layout
- If the template has two photo areas then put hero in one and serving in the other
- If the template has one photo area then split it to show both hero and serving photos
- The food must come from image 2 and image 3 ONLY — never from the template
- Do NOT replace or modify the background of the food photos
- Text must be readable and well-placed matching the template style
- Vertical Pinterest format
- Professional eye-catching design`;


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
  defaultLighting: 'bright natural window light from the left with warm tones and soft shadows',
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
