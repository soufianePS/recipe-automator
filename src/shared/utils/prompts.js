/**
 * Default Prompt Templates — migrated from extension
 * Same logic: randomized styles, anti-AI rules, image prompt rules
 *
 * Scraper-specific prompts (EXTRACTION_PROMPT, buildRewritePrompt)
 * are in ./prompts-scraper.js and re-exported below.
 */

// Re-export scraper prompts so existing `import { EXTRACTION_PROMPT } from './prompts.js'` still works
export { EXTRACTION_PROMPT, buildRewritePrompt } from './prompts-scraper.js';

const TONES = [
  'Write like a home cook sharing with a friend. Casual, warm, a bit chatty.',
  'Write like a busy parent who found a great weeknight recipe. Practical and to the point.',
  'Write like a food enthusiast who just discovered something amazing. Excited but not over the top.',
  'Write like someone writing in a personal journal about a meal they loved. Reflective, simple.',
  'Write like a grandma passing down a family recipe. Gentle, nostalgic, with small personal touches.',
  'Write like a college student who figured out a cheap and tasty meal. Casual, relatable, a little funny.',
  'Write like a health-conscious person sharing a guilt-free recipe. Straightforward, encouraging.',
  'Write like a weekend cook who enjoys the process. Relaxed, descriptive about textures and smells.',
];

const INTRO_STYLES = [
  'Start with a short personal anecdote about when you first tried or made this dish.',
  'Start with a fun or surprising fact about one of the main ingredients.',
  'Start with a question that hooks the reader, like "Ever had one of those nights where..."',
  'Start with a seasonal or weather reference, like "When the cold hits..." or "Perfect for a summer evening..."',
  'Start with the cultural or regional origin of the dish in a casual way.',
  'Start by mentioning who you made this for, like family, friends, or a weeknight dinner.',
  'Start with what makes this recipe different or special compared to the usual version.',
  'Start by describing the taste or smell in one vivid sentence, then lead into the recipe.',
];

const CONCLUSION_STYLES = [
  'End with a storage tip or how long leftovers last.',
  'End with a serving suggestion, like what goes well on the side.',
  'End with a personal note, like "This one is a regular at our place now."',
  'End with an invitation to try a variation, like swapping one ingredient.',
  'End with a short tip about making it ahead of time or meal prepping.',
  'End with who would love this recipe, like kids, guests, picky eaters.',
  'End with a casual sign-off, like "Give it a shot and let me know how it turns out."',
  'End by mentioning your favorite part of the dish, like the texture or a specific flavor.',
];

const OPTIONAL_SECTIONS = [
  '"pro_tips": ["one short practical cooking tip", "another quick tip"]',
  '"variations": ["one alternative ingredient or method", "another easy swap"]',
  '"storage_notes": "One or two sentences about storing or reheating."',
  '"serving_suggestions": "One or two sentences about what to serve alongside."',
  '"make_ahead": "One or two sentences about prepping in advance."',
];

const INTRO_LENGTHS = ['1-2 sentences', '2-3 sentences', '3-4 sentences'];
const CONCLUSION_LENGTHS = ['1-2 sentences', '2-3 sentences', '2-4 sentences'];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandomN(arr, min, max) {
  const count = min + Math.floor(Math.random() * (max - min + 1));
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export function buildStyleDirective() {
  const tone = pickRandom(TONES);
  const introStyle = pickRandom(INTRO_STYLES);
  const conclusionStyle = pickRandom(CONCLUSION_STYLES);
  const introLength = pickRandom(INTRO_LENGTHS);
  const conclusionLength = pickRandom(CONCLUSION_LENGTHS);
  const extraSections = pickRandomN(OPTIONAL_SECTIONS, 1, 2);
  const extraFieldsJSON = extraSections.join(',\n  ');

  return {
    styleBlock: `
WRITING STYLE (follow this closely):
- ${tone}
- ${introStyle}
- ${conclusionStyle}
- Introduction length: ${introLength}.
- Conclusion length: ${conclusionLength}.
- Vary your sentence lengths. Mix short punchy sentences with longer ones.
- Do NOT start more than one sentence with the same word in a row.
- Use simple, everyday vocabulary. Avoid fancy or academic words.`,

    antiAIBlock: `
CRITICAL ANTI-AI-DETECTION RULES (you MUST follow ALL of these):
- NEVER use em dashes or en dashes (the characters — or –). Use commas, periods, or rewrite the sentence instead.
- NEVER use these overused AI words: delve, elevate, embark, tapestry, vibrant, bustling, landscape, realm, facilitate, leverage, encompass, robust, streamline, utilize, furthermore, moreover, additionally, consequently, noteworthy, arguably, undeniably, game-changer, mouthwatering, culinary journey, flavor profile, taste buds, take it to the next level.
- NEVER start the intro with "Are you looking for", "If you're looking for", "Whether you", "In this recipe", "This recipe is", "Looking for".
- NEVER use the phrase "Let's dive in" or "without further ado".
- Do NOT use a semicolon. Break it into two sentences.
- Do NOT overuse exclamation marks. Maximum one in the entire text.
- Write like a real person, not a content mill. Real people use contractions (I'm, it's, don't, you'll). Real people sometimes start sentences with "And" or "But". Real people write unevenly, not every paragraph the same length.
- Avoid parallel structure in lists where every item follows the same grammatical pattern. Mix it up.
- Each step description should sound slightly different in structure. Not all "Verb the noun" patterns.
- Keep it grounded. No exaggeration, no "perfect", no "amazing", no "absolutely delicious".`,

    extraFieldsJSON
  };
}

export function buildRecipePrompt(topic, styleDirective) {
  const { styleBlock, antiAIBlock, extraFieldsJSON } = styleDirective;

  return `You are writing a food blog post. Generate ONE valid JSON object only, with no explanations, no markdown, and no extra text.

Topic: "${topic}"
${styleBlock}
${antiAIBlock}

Content instructions:
- Create a catchy, SEO-friendly recipe title.
- Write the introduction following the style instructions above.
- List all ingredients with quantities.
- Analyze the cooking instructions and extract VISUAL preparation steps only.
- IMPORTANT: Steps must show preparation scenes ONLY. NO stove, NO fire, NO frying pans on heat, NO ovens, NO boiling pots.
- Allowed scenes: chopping, seasoning, mixing, coating, arranging on tray, plating, garnishing.
- If a step requires heat cooking, replace it with the preparation or assembly scene before it.
- Minimum 3 steps, maximum 8 steps.
- Generate image prompts for: hero (finished dish), ingredients (raw ingredients laid out), and each step.
- Create SEO metadata for each image (alt text, title, description, keywords).
- Create post SEO: meta title, meta description (max 155 chars), focus keyword, slug.
- Write the conclusion following the style instructions above.

CRITICAL IMAGE PROMPT RULES:
- A kitchen background reference image will be provided separately to the AI image generator.
- Image prompts must ONLY describe the FOOD and what CONTAINER it is in (bowl, plate, cutting board, baking tray).
- EVERY ingredient and food item MUST be in a container (bowl, plate, tray, jar). NEVER describe food placed directly on the surface.
- Do NOT describe any background, surface, table, countertop, kitchen, lighting, or environment.
- Do NOT add any decorations, flowers, props, or garnishes that are not part of the actual recipe.
- Do NOT mention camera angle, photography style, or lighting.
- Do NOT mention hands or fingers in any image prompt.
- Be SPECIFIC about what the food looks like: color, texture, size, shape, how it is arranged.
- Pick ONE plate style for the hero image and describe it specifically.
- For ingredients: each ingredient must be in its own small bowl or container. Describe the bowl color/type.

STEP IMAGE VARIETY (CRITICAL — each step must look visually DIFFERENT):
- Each step image must use a DIFFERENT container appropriate to the action: mixing bowl, cutting board, sheet pan, baking dish, plate, colander, skillet (cold), etc.
- Steps should show DIFFERENT stages of cooking: raw prep, mixing, seasoning, assembling, shaping, arranging, final plating.
- NEVER show the same dish from above with just one more ingredient added. Each step must be a clearly different scene.
- Think like a food blogger: step 1 might be dry ingredients in a bowl, step 2 might be diced vegetables on a cutting board, step 3 might be shaped meatballs on a sheet pan, step 4 might be the assembled dish in a baking tray.
- Food items should be placed CASUALLY and NATURALLY, not in geometric patterns or perfect circles. Real cooks scatter, pile, and toss things.
- Example GOOD step sequence for a pasta bake: "Seasoned ground meat mixture in a glass mixing bowl" → "Penne pasta tossed with red sauce in a large pot" → "Rolled meatballs scattered on a parchment-lined baking sheet" → "Assembled pasta bake in a white ceramic dish with cheese sprinkled unevenly on top"
- Example BAD step sequence: "Pasta in a white dish" → "Pasta in a white dish with meatballs added in a ring" → "Pasta in a white dish with cheese on top" (too similar, unnatural placement)

Return JSON in this exact structure:

{
  "post_title": "SEO-friendly recipe title",
  "slug": "recipe-url-slug",
  "focus_keyword": "main keyword",
  "meta_title": "SEO meta title",
  "meta_description": "SEO meta description under 155 chars",
  "intro": "Introduction following the style above",
  "ingredients": [
    { "name": "ingredient name", "quantity": "amount", "description": "What this ingredient does in the recipe (1 sentence)" }
  ],
  "hero_prompt": "Describe the finished dish on a specific plate: what it looks like, color, texture, arrangement. Be detailed and specific.",
  "hero_seo": {
    "filename": "recipe-name-hero.jpg",
    "alt_text": "alt text",
    "title": "image title",
    "description": "image description",
    "keywords": ["kw1", "kw2", "kw3"]
  },
  "ingredients_prompt": "List ONLY the raw uncooked ingredients in their BEFORE-COOKING state, each one visible separately, not mixed or assembled. Describe each ingredient by its real color, shape, and size. Example: 'Two raw chicken breasts (pink, smooth), a small glass bowl of yellow olive oil, 3 whole brown eggs, a pile of white flour, one whole lemon (yellow), a small pile of red paprika powder, 4 cloves of garlic (white, unpeeled)'. NEVER describe the finished dish here.",
  "ingredients_seo": {
    "filename": "recipe-name-ingredients.jpg",
    "alt_text": "alt text",
    "title": "image title",
    "description": "image description",
    "keywords": ["kw1", "kw2", "kw3"]
  },
  "steps": [
    {
      "number": 1,
      "title": "Step title",
      "description": "What to do in this step",
      "tip": "One short practical tip for this specific step (e.g. 'Use a sharp knife for cleaner cuts' or 'Let the dough rest 5 minutes before rolling')",
      "image_prompt": "Describe the RESULT of this step in a DIFFERENT container than other steps (bowl, board, pan, dish, plate). Show a visually distinct scene with specific colors, textures, and natural casual placement. No hands.",
      "seo": {
        "filename": "recipe-name-step-1.jpg",
        "alt_text": "alt text",
        "title": "image title",
        "description": "image description",
        "keywords": ["kw1", "kw2"]
      }
    }
  ],
  "equipment": [
    { "name": "Kitchen tool needed", "notes": "optional detail" }
  ],
  "category": "Recipe category (e.g. Main Course, Appetizer, Dessert, Breakfast, Snack, Soup, Salad, Side Dish)",
  "cuisine": "Cuisine type (e.g. Italian, Mexican, Asian, French, American, Mediterranean)",
  "prep_time": "ISO 8601 duration (e.g. PT15M)",
  "cook_time": "ISO 8601 duration (e.g. PT30M)",
  "total_time": "ISO 8601 duration (e.g. PT45M)",
  "servings": "Number of servings",
  ${extraFieldsJSON},
  "pinterest_pins": [
    {
      "title": "Pinterest-optimized title with keywords (max 100 chars)",
      "description": "Engaging description with relevant Pinterest hashtags at the end. #recipe #foodie #cooking #dinnerideas #easyrecipes",
      "image_prompt": "Describe a visually striking Pinterest-style image of this dish. Vertical composition, close-up, vibrant colors, appetizing presentation."
    },
    {
      "title": "Different angle/benefit title for the same recipe",
      "description": "Different description highlighting another aspect. #hashtags",
      "image_prompt": "Different visual angle or presentation of the dish for variety."
    },
    {
      "title": "Third unique title variation",
      "description": "Third description with different hook. #hashtags",
      "image_prompt": "Third visual variation, different styling or focus."
    }
  ],
  "conclusion": "Conclusion following the style above"
}

PINTEREST PIN RULES:
- Generate exactly 3 pins with DIFFERENT titles, descriptions, and image prompts.
- Each title should highlight a different benefit or angle (e.g. "Easy 30-Min Dinner", "Family-Approved Recipe", "Best Homemade Version").
- Each description should be 2-3 sentences + 5-8 relevant Pinterest hashtags that exist on Pinterest.
- Each image_prompt should describe a different visual presentation of the dish for the AI image generator.
- Hashtags must be popular food-related Pinterest tags (e.g. #easyrecipes #dinnerideas #healthymeals #comfortfood #mealprep).

Rules:
- Output valid JSON only.
- No comments, no markdown, no code fences.
- ABSOLUTELY NO em dashes or en dashes anywhere.
- Image prompts must ONLY describe the food itself.
- Keep meta description under 155 characters.
- Image keywords 3-5 maximum.`;
}

export const RECIPE_PROMPT = `You are writing a food blog post. Generate ONE valid JSON object only, with no explanations, no markdown, and no extra text.

Topic: "@topic"

Content instructions:
- Create a catchy, SEO-friendly recipe title.
- Write the introduction as exactly 3 separate paragraphs separated by blank lines.
- List all ingredients with quantities.
- Analyze the cooking instructions and extract VISUAL preparation steps only.
- IMPORTANT: Steps must show preparation scenes ONLY. NO stove, NO fire, NO frying pans on heat, NO ovens, NO boiling pots.
- Allowed scenes: chopping, seasoning, mixing, coating, arranging on tray, plating, garnishing.
- If a step requires heat cooking, replace it with the preparation or assembly scene before it.
- Minimum 3 steps, maximum 8 steps.
- Generate image prompts for: hero (finished dish), ingredients (raw ingredients laid out), and each step.
- Create SEO metadata for each image (alt text, title, description, keywords).
- Create post SEO: meta title, meta description (max 155 chars), focus keyword, slug.
- Write the conclusion as 2-3 sentences.

CRITICAL IMAGE PROMPT RULES:
- A kitchen background reference image will be provided separately to the AI image generator.
- Image prompts must ONLY describe the FOOD and what CONTAINER it is in (bowl, plate, cutting board, baking tray).
- EVERY ingredient and food item MUST be in a container (bowl, plate, tray, jar). NEVER describe food placed directly on the surface.
- Do NOT describe any background, surface, table, countertop, kitchen, lighting, or environment.
- Do NOT add any decorations, flowers, props, or garnishes that are not part of the actual recipe.
- Do NOT mention camera angle, photography style, or lighting.
- Do NOT mention hands or fingers in any image prompt.
- Be SPECIFIC about what the food looks like: color, texture, size, shape, how it is arranged.
- Pick ONE plate style for the hero image and describe it specifically.
- For ingredients: each ingredient must be in its own small bowl or container.

STEP IMAGE VARIETY (CRITICAL — each step must look visually DIFFERENT):
- Each step image must use a DIFFERENT container appropriate to the action: mixing bowl, cutting board, sheet pan, baking dish, plate, colander, skillet (cold), etc.
- Steps should show DIFFERENT stages of cooking: raw prep, mixing, seasoning, assembling, shaping, arranging, final plating.
- NEVER show the same dish from above with just one more ingredient added. Each step must be a clearly different scene.
- Food items should be placed CASUALLY and NATURALLY, not in geometric patterns or perfect circles. Real cooks scatter, pile, and toss things.
- Example GOOD sequence: "Seasoned meat in a glass bowl" → "Diced veggies on a cutting board" → "Shaped meatballs on a sheet pan" → "Assembled bake with cheese scattered unevenly"
- Example BAD sequence: "Food in a dish" → "Same dish with one thing added" → "Same dish with cheese on top"

IMPORTANT: The "category" field MUST be one of these: @categories. Pick the best match.

Return JSON in this exact structure:

{
  "post_title": "SEO-friendly recipe title",
  "slug": "recipe-url-slug",
  "focus_keyword": "main keyword",
  "meta_title": "SEO meta title",
  "meta_description": "SEO meta description under 155 chars",
  "intro": "Introduction (3 paragraphs separated by blank lines)",
  "ingredients": [
    { "name": "ingredient name", "quantity": "amount", "description": "What this ingredient does in the recipe (1 sentence)" }
  ],
  "hero_prompt": "Describe the finished dish on a specific plate",
  "hero_seo": { "filename": "recipe-name-hero.jpg", "alt_text": "alt text", "title": "image title", "description": "image description", "keywords": ["kw1", "kw2", "kw3"] },
  "ingredients_prompt": "List ONLY the raw uncooked ingredients in their BEFORE-COOKING state, each one visible separately",
  "ingredients_seo": { "filename": "recipe-name-ingredients.jpg", "alt_text": "alt text", "title": "image title", "description": "image description", "keywords": ["kw1", "kw2", "kw3"] },
  "steps": [
    {
      "number": 1,
      "title": "Step title",
      "description": "What to do in this step",
      "tip": "One short practical tip for this specific step",
      "image_prompt": "Describe the RESULT of this step in a DIFFERENT container than other steps. Show a visually distinct scene with specific colors and textures. Natural casual placement, no hands.",
      "seo": { "filename": "recipe-name-step-1.jpg", "alt_text": "alt text", "title": "image title", "description": "image description", "keywords": ["kw1", "kw2"] }
    }
  ],
  "equipment": [
    { "name": "Kitchen tool needed", "notes": "optional detail" }
  ],
  "pro_tips": ["practical cooking tip 1", "practical cooking tip 2"],
  "faq": [
    { "question": "Common question", "answer": "2-3 sentence answer" }
  ],
  "storage_notes": "How to store leftovers, fridge/freezer duration, reheating",
  "fun_fact": "Short interesting fact about the dish",
  "category": "Recipe category",
  "cuisine": "Cuisine type",
  "prep_time": "PT15M",
  "cook_time": "PT30M",
  "total_time": "PT45M",
  "servings": "4",
  "pinterest_pins": [
    {
      "title": "Pinterest-optimized title with keywords (max 100 chars)",
      "description": "Engaging description with relevant Pinterest hashtags. #recipe #foodie #cooking #dinnerideas #easyrecipes",
      "image_prompt": "Describe a visually striking Pinterest-style image of this dish. Vertical, close-up, vibrant."
    },
    {
      "title": "Second unique title variation",
      "description": "Different hook and hashtags. #hashtags",
      "image_prompt": "Different visual angle of the dish."
    },
    {
      "title": "Third unique title variation",
      "description": "Third description with different hook. #hashtags",
      "image_prompt": "Third visual variation."
    }
  ],
  "conclusion": "Conclusion (2-3 sentences)"
}

PINTEREST PIN RULES:
- Generate exactly 3 pins with DIFFERENT titles, descriptions, and image prompts.
- Each title highlights a different benefit or angle (max 100 chars).
- Each description: 2-3 sentences + 5-8 popular Pinterest hashtags.
- Each image_prompt: different visual presentation for the AI image generator.

Rules:
- Output valid JSON only.
- No comments, no markdown, no code fences.
- ABSOLUTELY NO em dashes or en dashes anywhere.
- Image prompts must ONLY describe the food itself.
- Keep meta description under 155 characters.`;

export const BACKGROUND_PROMPT_PREFIX = 'On the exact same surface from the uploaded reference image, matching the natural lighting and angle. No extra props, no decoration. @prompt';
export const INGREDIENTS_PROMPT_PREFIX = 'On the exact same surface from the uploaded reference image. Show ONLY raw uncooked ingredients laid out separately BEFORE any cooking. Each ingredient in its own small bowl, plate, or container. Never place food directly on the surface. Raw state only: @prompt';
export const STEPS_PROMPT_PREFIX = 'On the exact same surface from the uploaded reference image. Show the result of this preparation step. Food placed naturally and casually, not in patterns or perfect arrangements. No human hands, no decoration: @prompt';
export const HERO_PROMPT_PREFIX = 'On the exact same surface from the uploaded reference image. The finished dish plated and ready to serve. @prompt';
export const HERO_PROMPT_SUFFIX = ', top view angle, overhead shot';

const REALISM_RULES = 'Smartphone photo quality, slight natural shadows, no dramatic lighting, no bokeh, no color grading, no studio setup, no HDR look, no perfect symmetry. Small imperfections are good: a tiny crumb, slightly uneven cut, natural color variation. Do NOT show any human hands or fingers. Do NOT add flowers, herbs for decoration, napkins, or any prop that is not part of the recipe. CRITICAL: ALL food and ingredients MUST be inside a container (bowl, plate, cutting board, baking tray, glass, jar). NEVER place food or ingredients directly on the surface or background. Every item needs its own bowl or container. Food placement must look NATURAL and CASUAL, not arranged in geometric patterns, perfect circles, or symmetrical grids. Scatter, pile, and toss items the way a real cook would.';

const INGREDIENT_VIEWS = [
  'overhead top-down angle, ingredients spread naturally on the surface, some in small bowls and some loose',
  'slightly angled from above, ingredients grouped together casually, not perfectly organized',
  'top view, ingredients placed like someone just took them out of the fridge and set them down',
  'overhead shot, some ingredients in their original packaging or containers, others loose',
  'top-down angle, ingredients in a rough cluster, slightly overlapping, natural placement',
  'overhead view, ingredients in mismatched bowls and plates, like a real kitchen prep',
];

const STEP_VIEWS = [
  'overhead top-down angle, food in a mixing bowl, showing the texture clearly',
  'slightly angled from above, food on a wooden cutting board, zoomed in',
  'top-down view, food spread on a parchment-lined baking sheet',
  'overhead angle, food in a deep ceramic baking dish, casually arranged',
  'top view, food in a glass bowl, slightly zoomed to show detail',
  'overhead shot, food on a large round plate, natural scattered placement',
  'slightly angled, food in a colander or strainer, showing draining',
  'top-down view, food shaped and arranged on a flat wooden board',
];

const STEP_CONTEXTS = [
  'A used wooden spoon resting beside the bowl, some sauce on it.',
  'A small sprinkle of flour or spice visible on the surface nearby.',
  'The edge of a kitchen towel visible in one corner of the frame.',
  'A few loose pieces of ingredient scattered naturally near the main container.',
  'A knife resting to the side with some food residue on the blade.',
  'A small bowl of seasoning sits beside the main container, half-empty.',
  'A measuring cup or spoon tipped over casually next to the food.',
  'Nothing extra, just the food in its container, clean and simple.',
];

const HERO_VIEWS = [
  'top-down overhead angle, the full finished dish on a plate, centered',
  'overhead shot, slightly off-center, showing the full plate with a bit of the surface around it',
  'top view, plate takes up most of the frame, a fork or spoon resting beside it',
  'overhead angle, the dish plated simply on a round plate, no garnish beyond what belongs to the recipe',
  'top-down view, the finished dish looking like it was just served, still steaming slightly',
];

const HERO_DETAILS = [
  'The plate has a small imperfection like a sauce drip on the rim.',
  'A serving spoon rests beside the plate.',
  'The food portions look normal, not overly styled or stacked.',
  'A few crumbs or small pieces visible on the surface near the plate.',
  'The plate is simple and plain, not fancy or decorative.',
];

function _buildSuffix(viewsArrays) {
  const parts = viewsArrays.map(arr => pickRandom(arr));
  return `. ${parts.join('. ')} ${REALISM_RULES}`;
}

export function buildIngredientSuffix() {
  return _buildSuffix([INGREDIENT_VIEWS]);
}

export function buildStepSuffix() {
  return _buildSuffix([STEP_VIEWS, STEP_CONTEXTS]);
}

export function buildHeroSuffix() {
  return _buildSuffix([HERO_VIEWS, HERO_DETAILS]);
}
