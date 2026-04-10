/**
 * Scraper-specific prompt templates — split from prompts.js
 * Contains: EXTRACTION_PROMPT, buildRewritePrompt()
 */

// ─── Scraper Mode: Extraction Prompt ─────────────────────────────────
export const EXTRACTION_PROMPT = `You are a **Recipe Data Specialist AI**. Extract structured recipe data from the provided HTML and return ONLY a valid JSON object.

---

## GLOBAL EXTRACTION RULES

* Return ONLY JSON. No explanations, no markdown.
* Extract ALL URLs as absolute URLs.
* If missing data → use null or reasonable defaults.
* Do NOT hallucinate.
* Prefer null over incorrect data.

---

## TITLE & BASIC DATA

* post_title: Extract from the first <h1>
* slug: Generate SEO-friendly slug from title
* focus_keyword: Main recipe keyword (usually title)
* meta_title: Under 60 characters
* meta_description: Under 155 characters

---

## INTRO

* Extract 2–3 <p> after <h1> and before main content
* If empty → use JSON-LD description
* The intro MUST be exactly 3 separate paragraphs. Separate each paragraph with a blank line.

---

## HERO IMAGE (ANCHOR)

1. First try JSON-LD:
   * recipe.image OR primaryImageOfPage
2. Fallback:
   * First <img> after <h1> with width >= 600px

---

## CONTENT ISOLATION (SAFE ZONE)

ONLY extract content from:
@content_selectors

IGNORE:
* header, footer, sidebar
* ads, videos, recommendations
* social/share sections

---

## RECIPE DATA (STRUCTURED)

Extract from JSON-LD OR recipe card:
* ingredients → recipeIngredient
* steps → recipeInstructions.text
* prep_time, cook_time, total_time
* servings
* category
* cuisine

---

## IMAGE EXTRACTION STRATEGY (VISUAL + STRUCTURE)

You may receive REAL uploaded image files along with HTML.
You MUST analyze images visually.

### 1. HERO IMAGE (ANCHOR)
* Extract from JSON-LD or HTML as defined above
* This represents the final dish

### 2. IMAGE COLLECTION
Collect images that:
* Are inside the Safe Zone
* Are part of recipe content
* Ignore ads, logos, UI elements

### 3. VISUAL CLASSIFICATION (PRIMARY LOGIC)
For EACH image, analyze its visual content.
Classify into ONE:
* "hero" → Fully assembled dish, ready to serve
* "ingredient" → Raw ingredients, separate, not mixed
* "step" → Cooking process (mixing, spreading, baking, layering, etc.)

IMPORTANT:
* Always prioritize what you SEE in the image
* Do NOT rely on filename alone

### 4. URL / FILENAME USAGE (SECONDARY)
* Use URL or filename ONLY to: Group images from same recipe, Support ordering if needed
* NEVER classify based only on filename

### 5. FILTERING
Ignore images that:
* Are < 500px
* Are icons, logos, UI, ads
* Are duplicates

### 6. ORDER
* Keep images in original HTML order
* Do NOT reorder

### 7. INGREDIENT IMAGE
* Select FIRST image classified as "ingredient"
* MUST show multiple raw ingredients clearly separated
* If none → null

### 8. STEP IMAGE MAPPING
* Use ONLY images classified as "step"
* Map sequentially: step 1 → first step image, step 2 → second step image
* If fewer images than steps → remaining = null
* NEVER reuse images

### PRIORITY RULE
Visual understanding > HTML structure > filename hints
If uncertain → null

---

## INGREDIENTS FORMAT
[{ "name": "string", "quantity": "string", "notes": "string", "description": "What this ingredient does in the recipe (1 sentence)" }]

---

## STEPS FORMAT
Each step MUST include:
{ "number": 1, "title": "short action title", "description": "clean step text", "image_url": "url or null", "tip": "practical tip for this step" }

---

## GENERATED CONTENT (SMART)

Tips: 3–6 cooking tips based on recipe
Step Tips: EACH step must have a useful tip
FAQ: 4–6 entries [{ "question": "...", "answer": "2–3 sentences" }]
Equipment: [{ "name": "tool", "notes": "optional" }]
Storage: Fridge/freezer duration + reheating
Fun Fact: Short interesting fact
Conclusion: 2–3 sentence wrap-up (3 separate paragraphs with blank lines)

---

## FINAL JSON STRUCTURE

{
  "post_title": "string",
  "slug": "string",
  "focus_keyword": "string",
  "meta_title": "string",
  "meta_description": "string",
  "intro": "string",
  "hero_image_url": "url",
  "ingredients_image_url": "url or null",
  "ingredients": [{ "name": "string", "quantity": "string", "notes": "string", "description": "What this ingredient does in the recipe" }],
  "steps": [{ "number": 1, "title": "string", "description": "string", "image_url": "url or null", "tip": "string" }],
  "tips": ["string"],
  "faq": [{ "question": "string", "answer": "string" }],
  "equipment": [{ "name": "string", "notes": "string" }],
  "conclusion": "string",
  "storage": "string",
  "fun_fact": "string",
  "cost": "$0",
  "prep_time": "PT0M",
  "cook_time": "PT0M",
  "total_time": "PT0M",
  "servings": "string",
  "category": "string",
  "cuisine": "string",
  "pinterest_pins": [
    { "title": "Pinterest-optimized title (max 100 chars)", "description": "2-3 sentences + #hashtags", "image_prompt": "Visual description for AI image generator" },
    { "title": "Second variation", "description": "Different angle + #hashtags", "image_prompt": "Different visual" },
    { "title": "Third variation", "description": "Third hook + #hashtags", "image_prompt": "Third visual" }
  ]
}

PINTEREST PIN RULES:
- Generate exactly 3 pins with DIFFERENT titles, descriptions, and image prompts.
- Each title highlights a different benefit or angle of the recipe.
- Each description: 2-3 sentences + 5-8 popular Pinterest hashtags (e.g. #easyrecipes #dinnerideas #healthymeals).
- Each image_prompt: different visual presentation of the dish for AI image generation.

I have attached the recipe page HTML as a .txt file. Read it and extract the recipe data.`;

// ─── Scraper Mode: Rewrite Prompt ────────────────────────────────────
export function buildRewritePrompt(extractedJSON, styleDirective) {
  const { styleBlock, antiAIBlock } = styleDirective;

  return `You are an SEO content rewriter for a recipe blog. I will give you a recipe JSON. Rewrite ALL text fields for SEO optimization and make them sound natural, engaging, and human-written.

IMPORTANT — FILL IN MISSING FIELDS:
If any of the following fields are empty, null, or missing, you MUST create them from scratch based on the recipe title, ingredients, steps, and cuisine. Stay accurate to the actual recipe — do not invent ingredients or steps that don't exist.

- "tips": If empty or missing, write 3-5 practical general tips for this specific recipe (cooking tricks, common mistakes to avoid, ingredient substitutions that work). Base tips on the actual ingredients and steps provided.
- "faq": If empty or missing, write 4-6 FAQ entries that people commonly search for about this type of dish. Questions should be natural Google-style queries. Answers should be 2-3 sentences, genuinely helpful, and accurate to this recipe's ingredients and method.
- "storage": If empty or missing, write storage instructions for this specific dish (how to store leftovers, fridge/freezer duration, reheating tips). Be specific to the actual ingredients used.
- "fun_fact": If empty or missing, write one interesting "Did you know?" fact about the dish, its origin, or a key ingredient. Keep it short and engaging.
- "equipment": If empty or missing, list 3-6 kitchen tools actually needed for this recipe based on the steps. Format: [{"name": "Tool Name", "notes": "optional detail"}]. Only include equipment that makes sense for the recipe.
- Step "tip" fields: Every step MUST have a tip. If a step is missing its tip, create a useful one specific to what that step does. Relate tips to the actual technique or ingredient in that step.
- Ingredient "description" fields: EVERY ingredient MUST have a "description" explaining what this ingredient does in the recipe (1 sentence). Example: "Adds richness and binds the sauce together" or "Creates a sturdy base that balances the creamy filling". Be specific to this recipe.

REWRITE THESE FIELDS (improve text quality, SEO, readability):
- post_title, meta_title, meta_description, intro, conclusion
- Step titles, step descriptions, step tips
- Ingredient names (keep them recognizable, keep quantities exact)
- Ingredient descriptions (what each ingredient does in the recipe)
- General tips array
- FAQ questions and answers
- Storage instructions
- Fun fact
- Equipment notes
- Pinterest pin titles, descriptions, and image prompts (rewrite for SEO + engagement)

PINTEREST PIN RULES:
- If pinterest_pins is missing or empty, CREATE 3 pins from scratch.
- Each pin needs a unique title (max 100 chars), description (2-3 sentences + 5-8 Pinterest hashtags), and image_prompt.
- Hashtags must be popular Pinterest food tags (e.g. #easyrecipes #dinnerideas #healthymeals #comfortfood).

DO NOT CHANGE (keep exactly as-is):
- Any image URLs (hero_image_url, ingredients_image_url, step image_url fields)
- slug, focus_keyword, prep_time, cook_time, total_time, servings, category, cuisine, cost
- Step numbers
- Ingredient quantities and notes
- Equipment names (only rewrite the notes, not the tool name)
- JSON structure

RESPECT THE RECIPE:
- All generated content MUST match the actual recipe. Do not reference ingredients, techniques, or flavors that are not part of this recipe.
- Tips and FAQ answers must be relevant to the specific ingredients and cooking method used.
- Storage advice must make sense for the type of dish (don't say "freeze the salad").
- Equipment must be tools actually needed for the steps described.
${styleBlock}
${antiAIBlock}

Return the SAME JSON structure with all fields filled. Output valid JSON only, no markdown, no code fences.

Here is the recipe JSON:
${JSON.stringify(extractedJSON, null, 2)}`;
}
