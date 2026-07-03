/**
 * VerifiedGeneratorOrchestrator — AI-verified image generation workflow
 *
 * New module that extends BaseOrchestrator with:
 * 1. ChatGPT pass 2: structured visual production plan (4-8 steps)
 * 2. Structured JSON prompts → Flow image generation
 * 3. Gemini vision verification after each image
 * 4. Correction retry loop (max retries configurable)
 *
 * Does NOT modify generator or scraper modules.
 */

import { BaseOrchestrator, sanitizeRecipeJSON, FILENAMES } from '../base-orchestrator.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { WordPressAPI } from '../../shared/utils/wordpress-api.js';
import { Logger } from '../../shared/utils/logger.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { GeminiChatPage } from '../../shared/pages/gemini-chat.js';
import { buildVisualPlanPrompt, validateVisualPlan } from './visual-planner.js';
import { buildStepPrompt, buildIngredientsPrompt, buildHeroPrompt, buildCorrectionPrompt } from './prompt-builder.js';
import { verifyStepImage, verifyIngredientsImage, verifyHeroImage, verifyPinterestImage, checkStepSimilarity, shouldRetry } from './image-verifier.js';
import { VERIFIED_GENERATOR_DEFAULTS } from './prompts-verified.js';
import { VGStats } from './vg-stats.js';
import { fetchNutrition } from '../../shared/utils/nutrition-api.js';
import { checkContentQuality, applyContentFixes } from '../../shared/utils/content-quality.js';
import { readFileSync, mkdirSync, writeFileSync, existsSync, copyFileSync, statSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Convert a string to Title Case, preserving small words like "and", "of", "with" */
function toTitleCase(str) {
  if (!str) return str;
  const smallWords = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'in', 'of', 'with', 'by', 'from', 'as', 'is', 'vs']);
  return str.split(/\s+/).map((word, i) => {
    if (i === 0 || !smallWords.has(word.toLowerCase())) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.toLowerCase();
  }).join(' ');
}

function parseManualKeywords(value) {
  return String(value || '')
    .split(/[,;\n\t]+/)
    .map(k => k.trim())
    .filter(Boolean)
    .filter((k, i, arr) => arr.findIndex(x => x.toLowerCase() === k.toLowerCase()) === i)
    .slice(0, 12);
}

function mergeKeywords(existing, manualKeywords, limit = 8) {
  const current = Array.isArray(existing)
    ? existing
    : String(existing || '').split(/[,;\n\t]+/);
  return [...current, ...manualKeywords]
    .map(k => String(k || '').trim())
    .filter(Boolean)
    .filter((k, i, arr) => arr.findIndex(x => x.toLowerCase() === k.toLowerCase()) === i)
    .slice(0, limit);
}

function keywordWindow(keywords, start = 0, count = 3) {
  const list = (keywords || []).map(k => String(k || '').trim()).filter(Boolean);
  if (!list.length) return [];
  const out = [];
  for (let i = 0; i < list.length && out.length < count; i++) {
    out.push(list[(start + i) % list.length]);
  }
  return out;
}

function textIncludesPhrase(text, phrase) {
  return String(text || '').toLowerCase().includes(String(phrase || '').toLowerCase());
}

function appendKeywordSentence(text, keywords, { prefix = 'SEO focus', maxKeywords = 3, maxLength = 0 } = {}) {
  const base = String(text || '').trim();
  const phrases = (keywords || [])
    .map(k => String(k || '').trim())
    .filter(Boolean)
    .filter(k => !textIncludesPhrase(base, k))
    .slice(0, maxKeywords);
  if (!phrases.length) return base;
  let out = `${base}${base ? ' ' : ''}${prefix}: ${phrases.join(', ')}.`;
  if (maxLength && out.length > maxLength) {
    const required = `${prefix}: ${phrases[0]}.`;
    const room = Math.max(0, maxLength - required.length - 1);
    const trimmedBase = base.slice(0, room).replace(/\s+\S*$/, '').trim();
    out = `${trimmedBase}${trimmedBase ? ' ' : ''}${required}`.slice(0, maxLength);
  }
  return out;
}

function ensureSeoObject(seo, fallbackTitle, manualKeywords, limit = 8) {
  const out = (seo && typeof seo === 'object') ? { ...seo } : {};
  out.filename = out.filename || '';
  out.alt_text = appendKeywordSentence(out.alt_text || fallbackTitle || '', manualKeywords, {
    prefix: 'Recipe focus',
    maxKeywords: 1,
    maxLength: 160
  });
  out.title = appendKeywordSentence(out.title || fallbackTitle || out.alt_text || '', manualKeywords, {
    prefix: 'SEO',
    maxKeywords: 1,
    maxLength: 120
  });
  out.description = appendKeywordSentence(
    out.description || `${fallbackTitle || out.title || 'Recipe image'} featuring ${manualKeywords.slice(0, 3).join(', ')}.`,
    manualKeywords,
    { prefix: 'Related search phrases', maxKeywords: Math.min(3, limit) }
  );
  out.keywords = mergeKeywords(out.keywords, manualKeywords, limit);
  return out;
}

/**
 * Guarantee the recipe title (= sheet topic, the primary SEO keyword) appears
 * in an image seo object's alt_text / title / description. The prompt asks the
 * model to do this; this is the deterministic backstop for WP media metadata.
 */
function injectTitleIntoImageSeo(seo, recipeTitle) {
  const t = String(recipeTitle || '').trim();
  if (!seo || !t) return seo;
  const has = v => String(v || '').toLowerCase().includes(t.toLowerCase());
  if (!has(seo.alt_text)) seo.alt_text = seo.alt_text ? `${t} — ${seo.alt_text}` : t;
  if (!has(seo.title)) seo.title = seo.title ? `${t} — ${seo.title}` : t;
  if (!has(seo.description)) {
    seo.description = `${String(seo.description || '').trim()} Part of this ${t} recipe.`.trim();
  }
  return seo;
}

function trimPinterestBody(text, maxLength) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength)).replace(/\s+\S*$/, '').replace(/[,\s]+$/, '').trim();
}

function expandPinterestDescription(pin, recipeTitle, manualKeywords, index) {
  const base = String(pin.description || '').trim();
  // The verified prompt asks the model for complete descriptions (2-3 natural
  // sentences ending in 5-8 hashtags). When we got one, use it as-is: wrapping
  // it below restates the title (which the prompt bans), doubles the hashtag
  // block, and pushes past Pinterest's 500-char description limit. Everything
  // below is only a fallback for missing/thin descriptions.
  if (base.length >= 120 && base.includes('#')) {
    let body = base;
    // Sheet column Z keywords are mandatory in every pin description. The
    // prompt asks for them, but if the model dropped the primary phrase,
    // splice one natural sentence in just before the hashtag block.
    const primary = (manualKeywords[0] || '').trim();
    if (primary && !textIncludesPhrase(body, primary)) {
      const hashIdx = body.search(/#\w/);
      const sentence = `Save this ${primary} idea for later.`;
      body = hashIdx > 0
        ? `${body.slice(0, hashIdx).trim()} ${sentence} ${body.slice(hashIdx)}`
        : `${body} ${sentence}`;
    }
    return trimPinterestBody(body, 500);
  }
  const keywords = keywordWindow(manualKeywords, index * 3, 4);
  const primaryKeyword = manualKeywords[0] || keywords[0] || '';
  const keywordSentence = keywords.length
    ? `Save this ${recipeTitle} idea when you want ${keywords.join(', ')}.`
    : `Save this ${recipeTitle} idea for whenever you need it.`;
  const titleSentence = pin.title ? `Pin this if "${pin.title}" is exactly the idea you were looking for.` : '';
  // Matches the 3-intent split enforced in the pin-title prompt: search, curiosity, benefit/occasion.
  const angles = [
    `Save it now so it is ready the next time you are searching for exactly this.`,
    `The kind of trick that is worth remembering, not just scrolling past.`,
    `A practical save for planning the week, not just admiring the photo.`,
  ];
  const hashtags = mergeKeywords([], manualKeywords, 8)
    .map(k => `#${k.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 35)}`)
    .filter(tag => tag.length > 1)
    .slice(0, 8);
  const fallbackTags = ['#easyrecipes', '#recipeideas', '#pinterestrecipes', '#foodblog', '#homemaderecipes'];
  const tagLine = [...hashtags, ...fallbackTags]
    .filter((tag, i, arr) => arr.indexOf(tag) === i)
    .slice(0, 8)
    .join(' ');

  let body = [keywordSentence, base, titleSentence, angles[index % angles.length]]
    .filter(Boolean)
    .join(' ');
  if (primaryKeyword && !textIncludesPhrase(body, primaryKeyword)) {
    body = `${keywordSentence} ${body}`.trim();
  }

  const expanders = [
    `The full recipe explains the timing, texture cues, storage tips, and serving details so readers can decide quickly if it fits their table.`,
    `It gives Pinterest users a clear reason to click through instead of saving another generic idea, while keeping the description natural.`,
    `Use it for seasonal baking plans, weeknight inspiration, holiday menus, or saving a recipe that feels specific instead of copied.`,
  ];
  let expanderIndex = index % expanders.length;
  while (body.length < 520) {
    body = `${body} ${expanders[expanderIndex % expanders.length]}`.trim();
    expanderIndex++;
  }

  const tags = tagLine ? ` ${tagLine}` : '';
  const maxBodyLength = Math.max(0, 700 - tags.length);
  body = trimPinterestBody(body, maxBodyLength);
  let description = `${body}${tags}`.trim();
  if (description.length > 700) {
    body = trimPinterestBody(body, Math.max(0, 700 - tags.length));
    description = `${body}${tags}`.trim();
  }
  return description;
}

function ensurePinterestPinCoverage(pinterestPins, recipe, manualKeywords, targetCount = 3) {
  const title = recipe.post_title || recipe.title || 'Recipe';
  const category = recipe.category || 'recipe';
  const keywords = manualKeywords.length
    ? manualKeywords
    : [recipe.focus_keyword, title].filter(Boolean);
  const pins = Array.isArray(pinterestPins) ? [...pinterestPins] : [];
  const angles = [
    {
      label: 'finished serving',
      prompt: `A Pinterest vertical image of ${title} as the finished serving, styled for ${category}, appetizing texture, clean food blog composition.`
    },
    {
      label: 'texture close up',
      prompt: `A Pinterest vertical close-up of ${title}, emphasizing texture, color, and the most craveable detail, clean recipe photography.`
    },
    {
      label: 'easy recipe idea',
      prompt: `A Pinterest vertical image of ${title} as an easy save-worthy recipe idea, clear focal food, bright readable food blog style.`
    }
  ];

  while (pins.length < targetCount) {
    const i = pins.length;
    const keyword = keywords[i % Math.max(1, keywords.length)] || title;
    const angle = angles[i % angles.length];
    pins.push({
      title: `${title} - ${keyword}`,
      description: `${title} is a ${angle.label} idea for readers searching ${keyword}. Save it when you want a practical ${category} recipe with a clear result and useful details.`,
      image_prompt: angle.prompt,
      keywords: keywords.slice(0, 8),
      seo: {
        title: `${title} ${angle.label}`,
        description: `${title} Pinterest pin for ${keyword}.`,
        keywords: keywords.slice(0, 8),
      },
      base64: null,
      wpImageId: null,
      wpImageUrl: null,
    });
  }

  return pins.slice(0, targetCount);
}

function applyManualSeoKeywords(recipe, pinterestPins, manualKeywords) {
  const title = recipe.post_title || recipe.title || 'Recipe';
  const pinterestKeywords = manualKeywords.length
    ? manualKeywords
    : [recipe.focus_keyword || title].filter(Boolean);
  if (!manualKeywords.length) {
    return {
      recipe,
      pinterestPins: (pinterestPins || []).map((pin, i) => ({
        ...pin,
        description: expandPinterestDescription(pin, title, pinterestKeywords, i),
        seo: pin.seo || null,
      })),
    };
  }

  const primary = manualKeywords[0];

  recipe.focus_keyword = recipe.focus_keyword || primary;
  if (!String(recipe.focus_keyword || '').toLowerCase().includes(primary.toLowerCase())) {
    recipe.focus_keyword = `${primary}, ${recipe.focus_keyword}`.replace(/,\s*$/, '');
  }
  recipe.meta_title = appendKeywordSentence(recipe.meta_title || `${title} - ${primary}`, [primary], {
    prefix: 'SEO',
    maxKeywords: 1,
    maxLength: 70
  });
  recipe.meta_description = appendKeywordSentence(
    recipe.meta_description || `${title} made with ${manualKeywords.slice(0, 3).join(', ')}.`,
    [primary],
    { prefix: 'Search focus', maxKeywords: 1, maxLength: 155 }
  );
  recipe.intro = appendKeywordSentence(recipe.intro, manualKeywords.slice(0, 2), {
    prefix: 'This recipe is especially useful for',
    maxKeywords: 3
  });
  recipe.conclusion = appendKeywordSentence(recipe.conclusion, keywordWindow(manualKeywords, 3, 4), {
    prefix: 'Readers also use it for',
    maxKeywords: 4
  });
  recipe.recipe_card_description = appendKeywordSentence(recipe.recipe_card_description, [primary], {
    prefix: 'Search focus',
    maxKeywords: 1,
    maxLength: 480
  });

  recipe.hero_seo = ensureSeoObject(recipe.hero_seo, title, keywordWindow(manualKeywords, 0, 4));
  recipe.ingredients_seo = ensureSeoObject(recipe.ingredients_seo, `${title} ingredients`, keywordWindow(manualKeywords, 3, 4));
  if (Array.isArray(recipe.steps)) {
    recipe.steps = recipe.steps.map((step, i) => ({
      ...step,
      seo: ensureSeoObject(step.seo, step.title || `${title} step ${i + 1}`, keywordWindow(manualKeywords, i + 5, 4), 6),
    }));
  }
  recipe.pinterest_pins = (pinterestPins || []).map((pin, i) => ({
    ...pin,
    title: pin.title || `${title} - ${manualKeywords[Math.min(i, manualKeywords.length - 1)] || primary}`,
    description: expandPinterestDescription(pin, title, manualKeywords, i),
    keywords: mergeKeywords(pin.keywords, manualKeywords, 8),
    seo: ensureSeoObject(pin.seo, pin.title || `${title} pin ${i + 1}`, manualKeywords, 8),
  }));
  return { recipe, pinterestPins: recipe.pinterest_pins };
}

function _normalizeStepText(step) {
  if (typeof step === 'string') return { title: '', description: step };
  return step && typeof step === 'object' ? step : {};
}

function _synthesizeVisualStep(recipeStep, index, vgSettings) {
  const step = _normalizeStepText(recipeStep);
  const title = step.title || step.name || `Step ${index + 1}`;
  const description = step.description || step.text || step.instructions || title;
  const cameraAngles = ['45-degree angle', 'top-down', 'slight overhead (30-degree)', '45-degree angle'];
  return {
    step_id: index + 1,
    title,
    container: vgSettings?.defaultContainer || 'white ceramic bowl',
    camera_angle: cameraAngles[index % cameraAngles.length],
    visible_ingredients: [],
    forbidden_ingredients: [],
    food_state: description,
    shape_change: false,
    composition: {
      subject_placement: 'center, fills 60% of frame width',
      subject_orientation: 'natural recipe-prep orientation for this step',
      secondary_elements: [],
      negative_space: 'clean background surface with no loose food outside the container',
    },
    continuity: {
      uses_previous_image: index > 0,
      reason: index > 0 ? 'continues the same recipe process from the previous step' : 'first visual cooking step',
    },
  };
}

function ensureVisualStepCoverage(rawVisualPlan, recipeSteps, vgSettings) {
  if (!rawVisualPlan) return rawVisualPlan;
  if (!Array.isArray(rawVisualPlan.visual_steps)) rawVisualPlan.visual_steps = [];
  const normalizedRecipeSteps = Array.isArray(recipeSteps) ? recipeSteps : [];
  const before = rawVisualPlan.visual_steps.length;
  const target = Math.max(before, normalizedRecipeSteps.length, vgSettings?.minVisualSteps || 0);
  for (let i = before; i < target; i++) {
    rawVisualPlan.visual_steps.push(_synthesizeVisualStep(normalizedRecipeSteps[i], i, vgSettings));
  }
  if (rawVisualPlan.visual_steps.length > before) {
    Logger.warn(`[VerifiedGen] Visual plan had ${before} step(s), recipe has ${normalizedRecipeSteps.length}; synthesized ${rawVisualPlan.visual_steps.length - before} missing visual step(s) so Flow/WP stay complete.`);
  }
  return rawVisualPlan;
}

export class VerifiedGeneratorOrchestrator extends BaseOrchestrator {
  constructor(browser, context, serverCtx) {
    super(browser, context, serverCtx);
  }

  /**
   * Get verifiedGenerator settings merged with defaults.
   */
  _getVGSettings(settings) {
    const vg = settings?.verifiedGenerator || {};
    const defaults = VERIFIED_GENERATOR_DEFAULTS;
    return {
      ...defaults,
      ...vg,
      prompts: { ...defaults.prompts, ...(vg.prompts || {}) }
    };
  }

  /**
   * Get a Gemini API key — rotates across all accounts' keys to distribute rate limits.
   */
  async _getGeminiApiKey() {
    // Get all available keys
    if (!this._geminiKeys) {
      this._geminiKeys = await FlowAccountManager.getAllGeminiKeys();
      this._geminiKeyIndex = 0;
    }

    if (this._geminiKeys.length === 0) {
      // Fallback to active account
      const key = await FlowAccountManager.getActiveGeminiKey();
      if (!key) Logger.warn('[VerifiedGen] No Gemini API key configured — skipping verification');
      return key;
    }

    // Round-robin through keys
    const key = this._geminiKeys[this._geminiKeyIndex % this._geminiKeys.length];
    this._geminiKeyIndex++;
    return key;
  }

  /**
   * Build a randomized H2 section structure for this specific post.
   * Picks random synonyms for each H2 + randomly includes 1-3 optional sections
   * + shuffles order (within constraints). Prevents "scaled content abuse"
   * detection from Google when all posts have identical H2 structures.
   */
  _buildStructureRandomization(recipeTitle = '') {
    const pick = arr => arr[Math.floor(Math.random() * arr.length)];
    const pickN = (arr, n) => {
      const copy = [...arr];
      const out = [];
      for (let i = 0; i < n && copy.length; i++) {
        const idx = Math.floor(Math.random() * copy.length);
        out.push(copy[idx]);
        copy.splice(idx, 1);
      }
      return out;
    };

    // H2 name variants per required section. Most pools mix recipe-name
    // variants (SEO: the sheet topic repeats in headings) with generic ones so
    // structure still varies post-to-post. The instructions pool ALWAYS names
    // the recipe ("How to Make It" alone wastes the highest-value H2).
    const name = String(recipeTitle || '').trim();
    const pools = name ? {
      why_this_works: [`Why This ${name} Recipe Works`, `Why You'll Love This ${name}`, `The Secret to Perfect ${name}`, `What Makes This ${name} Work`, "The Science Behind It"],
      ingredients: [`Ingredients for ${name}`, `${name} Ingredients`, "What You'll Need", "Shopping List", "Ingredient List"],
      equipment: ["Kitchen Equipment", "Tools You'll Need", "Equipment", "What You'll Use", "The Gear"],
      instructions: [`How to Make ${name}`, `How to Make ${name} Step by Step`, `Let's Make ${name}`, `How to Make ${name} at Home`, `Making ${name}: Step-by-Step`],
      tips: [`Pro Tips for the Best ${name}`, `Tips for Perfect ${name}`, "Pro Tips", "Chef's Notes", "Tips and Tricks"],
      substitutions: ["Substitutions & Variations", "Substitutions", "Ingredient Swaps", "Make It Your Own", "Variations to Try"],
      storage: [`How to Store ${name}`, `Storing and Reheating ${name}`, "Storage Instructions", "How to Store & Reheat", "Storage Tips"],
      faq: [`${name} FAQ`, `Common Questions About ${name}`, "Frequently Asked Questions", "Questions I Get Asked", "Reader Questions"],
      conclusion: ["Final Thoughts", "Before You Go", "In Conclusion", "A Final Note", "Let Me Know"]
    } : {
      why_this_works: ["Why This Recipe Works", "Why You'll Love It", "The Secret to This Recipe", "What Makes It Work", "The Science Behind It"],
      ingredients: ["Ingredients", "What You'll Need", "The Ingredients", "Shopping List", "Ingredient List"],
      equipment: ["Kitchen Equipment", "Tools You'll Need", "Equipment", "What You'll Use", "The Gear"],
      instructions: ["How to Make It", "Step-by-Step Instructions", "Method", "Let's Make It", "Directions", "How to"],
      tips: ["Pro Tips", "Tips for Success", "My Favorite Tips", "Chef's Notes", "Recipe Notes", "Tips and Tricks"],
      substitutions: ["Substitutions & Variations", "Substitutions", "Ingredient Swaps", "Make It Your Own", "Variations to Try"],
      storage: ["Storage Instructions", "How to Store & Reheat", "How to Store", "Storage Tips", "Keeping Leftovers"],
      faq: ["Frequently Asked Questions", "FAQ", "Questions I Get Asked", "Common Questions", "Reader Questions"],
      conclusion: ["Final Thoughts", "Before You Go", "In Conclusion", "A Final Note", "Let Me Know"]
    };

    const optionalPools = {
      make_ahead: ["Make Ahead", "Meal Prep Notes", "Prep Ahead Tips"],
      serving: ["Serving Suggestions", "What to Serve With This", "Pairings"],
      nutrition: ["A Note on Nutrition", "Nutritional Notes"],
    };

    // Required H2s (content is always generated; only the title varies)
    const selected = {
      why_this_works: pick(pools.why_this_works),
      ingredients: pick(pools.ingredients),
      equipment: pick(pools.equipment),
      instructions: pick(pools.instructions),
      tips: pick(pools.tips),
      substitutions: pick(pools.substitutions),
      storage: pick(pools.storage),
      faq: pick(pools.faq),
      conclusion: pick(pools.conclusion)
    };

    // Randomly pick 0-2 optional sections
    const optionalCount = Math.floor(Math.random() * 3);
    const optionalChosen = pickN(Object.keys(optionalPools), optionalCount)
      .map(key => ({ key, title: pick(optionalPools[key]) }));

    // Core order (with some flex — swap tips/substitutions position randomly)
    const order = [
      { key: 'intro', title: '(post intro — no H2)' },
      { key: 'why_this_works', title: selected.why_this_works },
      { key: 'ingredients', title: selected.ingredients },
      { key: 'equipment', title: selected.equipment },
      { key: 'instructions', title: selected.instructions },
      ...(Math.random() < 0.5
        ? [{ key: 'tips', title: selected.tips }, { key: 'substitutions', title: selected.substitutions }]
        : [{ key: 'substitutions', title: selected.substitutions }, { key: 'tips', title: selected.tips }]),
      ...optionalChosen,
      { key: 'storage', title: selected.storage },
      { key: 'recipe_card', title: '(Tasty/WPRM recipe card block)' },
      { key: 'faq', title: selected.faq },
      { key: 'conclusion', title: selected.conclusion }
    ];

    const orderList = order.map((s, i) => `${i + 1}. H2: "${s.title}"`).join('\n');

    // Return both the prompt text AND the selected titles (post-builder uses them)
    return {
      instructions: `\n\nSTRUCTURE RANDOMIZATION (this specific post):\nUse EXACTLY these H2 titles in this order when the content is rendered. Any section names used in the blog_content field MUST match these exact titles.\n\n${orderList}\n\nSection title keys (for reference): ${JSON.stringify(selected)}`,
      titles: { ...selected, optional: optionalChosen }
    };
  }

  /**
   * Copy a file to data/tmp/ with a unique prefix to avoid filename collisions in Flow project.
   * E.g. "photo.jpg" → "data/tmp/bg-1-photo.jpg" or "data/tmp/pin-2-photo.jpg"
   * Returns the new path. If already prepared with same prefix, returns cached path.
   */
  _prepareFile(originalPath, prefix) {
    if (!this._preparedFiles) this._preparedFiles = new Map();

    // Check cache — same prefix = same file already prepared
    if (this._preparedFiles.has(prefix)) return this._preparedFiles.get(prefix);

    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
    mkdirSync(tmpDir, { recursive: true });

    const ext = extname(originalPath) || '.jpg';
    const newName = `${prefix}${ext}`;
    const newPath = join(tmpDir, newName);

    copyFileSync(originalPath, newPath);
    this._preparedFiles.set(prefix, newPath);
    Logger.debug(`[VG] Prepared file: ${basename(originalPath)} → ${newName}`);
    return newPath;
  }

  /**
   * Generate an image with Flow, verify with Gemini, retry on failure.
   * If retry generation fails (Flow download error), falls back to best previous image.
   *
   * @param {object} opts
   * @param {string} opts.prompt - Flow prompt
   * @param {string} opts.backgroundPath - background image path
   * @param {string[]} opts.contextPaths - context image paths
   * @param {string} opts.aspectRatio - aspect ratio
   * @param {string} opts.outputPath - where to save image
   * @param {boolean} opts.isFirstImage - for rate limit handling
   * @param {boolean} opts.skipSimilarityCheck - for Pinterest pins
   * @param {Function} opts.verifyFn - async (outputPath) => verifier result
   * @param {Function} opts.correctionFn - (verifierResult) => correction prompt string
   * @param {string} opts.label - for logging (e.g. "Ingredients", "Step 3")
   * @param {string} opts.imageType - for stats ('ingredients', 'step', 'hero', 'pin')
   * @param {number} opts.stepNumber - step number for stats
   * @param {object} opts.vgSettings - verified generator settings
   */
  async _generateAndVerify(opts) {
    const {
      prompt, backgroundPath, contextPaths = [], aspectRatio, outputPath,
      isFirstImage = false, skipSimilarityCheck = false,
      verifyFn, correctionFn, label, vgSettings, imageType = '', stepNumber = 0,
      // Similarity check options
      prevImagePath = null, prevStepNum = 0, currentStepNum = 0, expectedChange = ''
    } = opts;

    // Every image gets its own fresh shot at Nano Banana Pro, regardless of
    // whether an earlier image in this recipe fell back to NB2 — Pro's rate
    // limit can clear between images, so don't carry a previous image's
    // fallback forward.
    this.flow.preferredModel = 'Nano Banana Pro';

    const geminiKey = await this._getGeminiApiKey();
    const maxRetries = vgSettings?.maxVerificationRetries || 3;
    let bestImage = null;
    let bestIssueCount = Infinity;
    let switchedToNB2 = false; // tracks NB2 fallback within this image

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Build prompt: original on first attempt, with correction on retries
      let currentPrompt = prompt;
      if (attempt > 0 && correctionFn && this._lastVerifyResult) {
        currentPrompt = prompt + '\n\n' + correctionFn(this._lastVerifyResult);
      }

      // NANO BANANA 2 FALLBACK — on the LAST attempt, if we've already failed verification
      // on Pro and haven't switched yet, fall back to Nano Banana 2 for THIS image only.
      // Pro may be silently degraded near its rate limit (returning bad images without a
      // hard rate-limit error). The next image still starts fresh on Pro (see the reset
      // at the top of this function).
      const isLastAttempt = attempt === maxRetries - 1;
      if (isLastAttempt && attempt > 0 && !switchedToNB2 && this.flow.preferredModel === 'Nano Banana Pro') {
        Logger.warn(`[VerifiedGen] ${label}: ${attempt}× failed on Nano Banana Pro — falling back to Nano Banana 2 (Pro may be rate-degraded)`);
        try {
          await this.flow.switchFlowModel('Nano Banana 2');
        } catch (e) {
          Logger.warn(`[VerifiedGen] In-flight model switch failed (${e.message.split('\n')[0]}) — setting preferredModel anyway`);
          this.flow.preferredModel = 'Nano Banana 2';
        }
        switchedToNB2 = true;
      }

      // Try to generate — if retry fails (Flow download error), fall back to best image
      try {
        // Stay in same project on retry — network sniffer guarantees we capture
        // only the new generation, regardless of how many images are on canvas.

        const ok = await this._generateWithRateLimitRetry(() =>
          this.flow.generate(currentPrompt, backgroundPath, contextPaths, aspectRatio, outputPath, { skipSimilarityCheck })
        , isFirstImage && attempt === 0);

        if (!ok) throw new Error(`${label} image generation failed`);
        await this._trackFlowGeneration();
      } catch (genErr) {
        if (attempt === 0) throw genErr; // First attempt must succeed

        // GenErr on retry — try Nano Banana 2 once before falling back to best image
        if (!switchedToNB2 && this.flow.preferredModel === 'Nano Banana Pro') {
          Logger.warn(`[VerifiedGen] ${label}: Pro generation error (${genErr.message.split('\n')[0]}) — trying Nano Banana 2`);
          try { await this.flow.switchFlowModel('Nano Banana 2'); }
          catch (e) { this.flow.preferredModel = 'Nano Banana 2'; }
          switchedToNB2 = true;
          continue; // retry with NB2
        }

        // Retry failed — use best previous image
        Logger.warn(`[VerifiedGen] ${label} retry ${attempt} generation failed: ${genErr.message}`);
        if (bestImage) {
          Logger.info(`[VerifiedGen] ${label}: falling back to best previous image`);
          try { writeFileSync(outputPath, bestImage); } catch (e) {
            // Windows UNKNOWN error — check if file was written anyway
            if (!existsSync(outputPath)) throw new Error(`Failed to write fallback image: ${e.message}`);
          }
        }
        break; // Accept what we have
      }

      // Save current image as potential best (ALWAYS, even before verification)
      const currentImage = readFileSync(outputPath);
      if (!bestImage) {
        bestImage = currentImage;
        bestIssueCount = 0;
      }

      // Skip verification if no Gemini key
      if (!geminiKey) {
        Logger.info(`[VerifiedGen] No Gemini key — skipping ${label} verification`);
        break;
      }

      // Verify ingredients/state
      this._lastVerifyResult = await verifyFn(outputPath);
      const { shouldRetry: retry, reason } = shouldRetry(this._lastVerifyResult, vgSettings?.softFailAction);

      if (!retry) {
        if (this._lastVerifyResult.status !== 'PASS') {
          Logger.warn(`[VerifiedGen] ${label} accepted with issues: ${reason}`);
        }

        // Similarity check: compare with previous step
        // Skip if verify was a safety PASS (Gemini was down — no point trying similarity too)
        const wasRealVerify = this._lastVerifyResult && !this._lastVerifyResult.issues?.some(i => i.includes('Verification skipped'));
        if (prevImagePath && geminiKey && existsSync(prevImagePath) && wasRealVerify) {
          // Wait 20s before similarity call to respect Gemini rate limit (20 req/min)
          await new Promise(r => setTimeout(r, 20000));
          const simResult = await checkStepSimilarity(
            geminiKey, prevImagePath, outputPath,
            prevStepNum, currentStepNum, expectedChange, vgSettings
          );

          if (simResult.verdict === 'TOO_SIMILAR' && attempt < maxRetries - 1) {
            Logger.warn(`[VerifiedGen] ${label} TOO SIMILAR to previous step (score: ${simResult.similarity_score}) — regenerating`);
            // Build differentiation prompt from missing changes
            const diffPrompt = (simResult.missing_changes || []).map(c => `- ${c}`).join('\n');
            this._lastVerifyResult = {
              status: 'HARD_FAIL',
              issues: [`Too similar to previous step. Required changes: ${diffPrompt || 'make visually distinct'}`],
              forbidden_found: [], container_count: 1, state_match: true
            };
            bestImage = currentImage;
            bestIssueCount = 1;
            continue; // retry with correction
          } else if (simResult.verdict === 'TOO_SIMILAR') {
            Logger.warn(`[VerifiedGen] ${label} similar but max retries reached — accepting`);
          }
        }

        break;
      }

      // Track best attempt (fewer issues = better)
      const issueCount = (this._lastVerifyResult.issues?.length || 0) +
        (this._lastVerifyResult.forbidden_found?.length || 0) +
        (this._lastVerifyResult.missing_ingredients?.length || 0) +
        (this._lastVerifyResult.extra_items?.length || 0);

      if (issueCount < bestIssueCount) {
        bestIssueCount = issueCount;
        bestImage = currentImage;
      }

      Logger.warn(`[VerifiedGen] ${label} attempt ${attempt + 1}/${maxRetries} FAILED: ${reason}`);

      if (attempt === maxRetries - 1) {
        Logger.warn(`[VerifiedGen] ${label}: max retries reached — accepting best attempt`);
        if (bestImage) {
          try { writeFileSync(outputPath, bestImage); } catch (e) {
            // Windows UNKNOWN error — file may already be written by generate()
            if (!existsSync(outputPath)) throw new Error(`Failed to write best image: ${e.message}`);
            Logger.debug(`[VG] Write threw but file exists: ${e.message}`);
          }
        }
      }
    }

    if (switchedToNB2 && this._lastVerifyResult?.status === 'PASS') {
      Logger.info(`[VerifiedGen] Nano Banana 2 fallback PASSED for ${label} — next image will retry Nano Banana Pro`);
    }

    // Track stats
    // Get file size if exists
    let fileSizeKB = 0;
    try { if (existsSync(outputPath)) fileSizeKB = Math.round(statSync(outputPath).size / 1024); } catch {}

    VGStats.trackImage({
      type: imageType || label.toLowerCase().replace(/\s+\d+$/, ''),
      stepNumber,
      title: label,
      flowStarted: Date.now(),
      flowDuration: 0,
      fileSizeKB,
      geminiStatus: this._lastVerifyResult?.status || 'skipped',
      geminiDetectedItems: this._lastVerifyResult?.detected_items || [],
      geminiForbiddenFound: this._lastVerifyResult?.forbidden_found || [],
      retries: bestIssueCount < Infinity ? 1 : 0,
      similarityScore: null,
      similarityVerdict: null,
      issues: this._lastVerifyResult?.issues || []
    });
  }

  get _stepHandlers() {
    return {
      ...this._sharedHandlers,
      [STATES.LOADING_JOB]: () => this._stepLoadJob(),
      [STATES.GENERATING_RECIPE_JSON]: () => this._stepGenerateRecipeJSON(),
      // Override image generation steps with verified versions
      [STATES.COMPLETED]: async () => {
        // Track recipe completion before base cleanup
        try {
          const st = await StateManager.getState();
          await VGStats.complete(st.draftUrl);
        } catch (e) { Logger.warn(`VGStats save error: ${e.message}`); }
        // Call base COMPLETED handler
        await this._sharedHandlers[STATES.COMPLETED]();
      },
      [STATES.GENERATING_INGREDIENTS]: () => this._stepVerifiedIngredients(),
      [STATES.GENERATING_STEPS]: () => this._stepVerifiedStep(),
      [STATES.GENERATING_HERO]: () => this._stepVerifiedHero(),
      [STATES.GENERATING_PINS]: () => this._stepVerifiedPins(),
    };
  }

  // ═══════════════════════════════════════════════════════
  // STEP: LOAD JOB (same as generator)
  // ═══════════════════════════════════════════════════════

  async _stepLoadJob() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    if (!settings.sheetId) throw new Error('Google Sheet ID not configured.');

    const sheetSettings = {
      ...settings,
      sheetTabName: settings.verifiedGenSheetTab || settings.generatorSheetTab || settings.sheetTabName || 'single post',
      topicColumn: settings.verifiedGenTopicColumn || settings.generatorTopicColumn || settings.topicColumn || 'A',
      statusColumn: settings.verifiedGenStatusColumn || settings.generatorStatusColumn || settings.statusColumn || 'B',
      startRow: settings.verifiedGenStartRow || settings.generatorStartRow || settings.startRow || 2
    };

    let pending;

    if (state.batchMode && state.batchQueue?.length > 0) {
      const idx = state.batchCurrentIndex || 0;
      if (idx >= state.batchQueue.length) {
        Logger.info('Batch queue exhausted — all done!');
        await StateManager.updateState({ status: STATES.IDLE });
        return;
      }
      pending = state.batchQueue[idx];
      Logger.step('LoadJob', `Batch ${idx + 1}/${state.batchQueue.length}: "${pending.topic}" (row ${pending.rowIndex})`);
    } else {
      Logger.step('LoadJob', 'Reading Google Sheet...');
      pending = await SheetsAPI.findPendingRow(sheetSettings);
      if (!pending) {
        Logger.info('No more pending rows — all done!');
        await StateManager.updateState({ status: STATES.IDLE });
        return;
      }
    }

    try {
      await SheetsAPI.markProcessing(sheetSettings, pending.rowIndex);
    } catch (e) {
      Logger.warn(`Failed to mark row as processing: ${e.message}`);
    }

    await StateManager.updateState({
      status: STATES.SELECTING_BACKGROUND,
      recipeTitle: pending.topic,
      sheetRowIndex: pending.rowIndex,
      seoKeywords: pending.seoKeywords || '',
      sheetSettings: {
        sheetTabName: sheetSettings.sheetTabName,
        statusColumn: sheetSettings.statusColumn
      },
      // Reset Pinterest project flag — without this, the Pin 1 closeSession is skipped
      // on subsequent recipes (because the flag stayed true from the previous recipe),
      // and the recipe project keeps accumulating images until Pin 3 → context crash.
      pinterestProjectReady: false
    });
    if (pending.seoKeywords) {
      Logger.info(`[SEO] Manual keywords from sheet Z: ${pending.seoKeywords}`);
    }
    // Clear prepared files cache for new recipe
    this._preparedFiles = new Map();

    VGStats.startRecipe(pending.topic, pending.rowIndex, {
      sheetTabName: sheetSettings.sheetTabName,
      statusColumn: sheetSettings.statusColumn
    });
    Logger.success(`Found recipe: "${pending.topic}" (row ${pending.rowIndex})`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: GENERATE RECIPE JSON + VISUAL PLAN (single prompt)
  // ═══════════════════════════════════════════════════════

  async _stepGenerateRecipeJSON() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const defaults = VERIFIED_GENERATOR_DEFAULTS;

    VGStats.chatgptStart();

    // ── Pinterest scrape: top 3 visual refs for the dish.
    //    Saved OUTSIDE data/tmp (which gets wiped on CREATING_FOLDERS) so the
    //    files survive into the Flow image-gen phase. Used as additional Flow
    //    refs on the hero step + step 1 so the visual style matches what real
    //    food blogs actually publish for this dish. ──
    let pinterestRefPaths = [];
    try {
      const { scrapePinterestImages } = await import('../gemini-visual/pinterest-scraper.js');
      const safeSlug = (state.recipeTitle || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
      const refDir = join(__dirname, '..', '..', '..', 'output', '_vg-pinterest-cache', `${safeSlug}-${Date.now()}`);
      const pinterestImages = await scrapePinterestImages(this.context, state.recipeTitle, refDir);
      pinterestRefPaths = pinterestImages.map(p => p.path);
      Logger.info(`[VerifiedGen] ${pinterestRefPaths.length} Pinterest visual refs saved for image-gen phase`);
    } catch (e) {
      Logger.warn(`[VerifiedGen] Pinterest scrape failed (non-fatal): ${e.message.split('\n')[0]}`);
    }
    await StateManager.updateState({ vgPinterestRefs: pinterestRefPaths, vgIdentityAnchorRefs: [] });

    // ── Choose AI provider: ChatGPT or Gemini browser ──
    const aiProvider = vgSettings.aiProvider || settings.aiProvider || 'chatgpt';
    const useGemini = aiProvider === 'gemini';
    let recipeAiChat = null;
    let recipeChatContextToClose = null;

    if (useGemini) {
      Logger.step('Gemini', `Generating recipe + visual plan for: ${state.recipeTitle}`);
      if (!this._geminiChat) this._geminiChat = new GeminiChatPage(null, this.context);
      await this._geminiChat.init();
      recipeAiChat = this._geminiChat;
    } else {
      Logger.step('ChatGPT', `Generating recipe + visual plan for: ${state.recipeTitle}`);
      const cfg = settings.chatgptPin || {};
      const profilePath = (cfg.profilePath || '').trim()
        || join(__dirname, '..', '..', '..', 'data', 'chatgpt-pin-profile');
      const { chromium } = await import('playwright');
      const { ChatGPTPage } = await import('../../shared/pages/chatgpt.js');
      Logger.info(`[ChatGPT] launching dedicated recipe/profile context: ${profilePath}`);
      recipeChatContextToClose = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      recipeAiChat = new ChatGPTPage(recipeChatContextToClose.browser(), recipeChatContextToClose);
      const gptUrl = vgSettings.chatGptUrl || settings.generatorGptUrl || cfg.gptUrl || null;
      const isCustomGpt = gptUrl && !gptUrl.match(/^https?:\/\/(chat\.openai\.com|chatgpt\.com)\/?$/);
      await recipeAiChat.init(isCustomGpt ? gptUrl : null);
    }

    // ── Build prompt from VG's own template ──
    const template = vgSettings.prompts?.recipeVisualPlan || defaults.prompts.recipeVisualPlan;

    // Build intro/conclusion template instructions
    let templateInstructions = '';
    const manualSeoKeywords = parseManualKeywords(state.seoKeywords);

    // If we successfully scraped Pinterest refs and they were attached to the AI,
    // tell it to actually use them when writing visual prompt fields.
    // Gemini is currently text-only here: attaching images to the large recipe
    // JSON prompt can trigger Gemini UI error 1155 on slower/limited sessions.
    if (!useGemini && pinterestRefPaths.length > 0) {
      templateInstructions += `\n\nVISUAL REFERENCE IMAGES (CRITICAL): ${pinterestRefPaths.length} Pinterest food photographs of "${state.recipeTitle}" are attached to this message. Use them as the canonical visual reference when writing every visual field — hero_prompt, hero_image, ingredients_image, every step's image_prompt, every step's food_state. Match the actual plating style, garnishes, glaze color, container type, and lighting feel you SEE in those photos. Do not invent a different visual style. If a photo shows a glossy mahogany glaze, write that — do not write "creamy white sauce" or some other invented look.`;
    } else if (useGemini && pinterestRefPaths.length > 0) {
      Logger.info(`[Gemini] Recipe prompt will be text-only; skipping ${pinterestRefPaths.length} Pinterest reference image(s) to avoid Gemini UI 1155/truncated JSON`);
    }
    if (manualSeoKeywords.length > 0) {
      templateInstructions += `\n\nMANUAL SEO KEYWORDS FROM SHEET COLUMN Z (CRITICAL - EXACT PHRASES):\n${manualSeoKeywords.map(k => `- ${k}`).join('\n')}\nYou MUST use these exact phrases, preserving spelling and word order. Do not rewrite, singularize, pluralize, or paraphrase them.\nRequired placement rules:\n1. recipe.focus_keyword MUST start with the first keyword phrase exactly.\n2. recipe.meta_title and recipe.meta_description MUST include the first keyword phrase exactly.\n3. recipe.intro MUST include at least the first 2 keyword phrases exactly, naturally inside sentences.\n4. recipe.conclusion MUST include at least 2 different keyword phrases exactly.\n5. hero_seo.description, ingredients_seo.description, and each step.seo.description MUST include 1-3 exact keyword phrases.\n6. Every pinterest_pins[].description MUST stay 2-3 natural sentences (under 480 characters total including hashtags), weave in 2-3 exact keyword phrases so they read like normal speech (never a stacked keyword list), then end with 5-8 hashtags.\n7. Each pinterest_pins[] item MUST have its own distinct angle: different title, different description emphasis, and different image_prompt composition.\n8. Every pinterest_pins[].seo.description MUST include 2-4 exact keyword phrases.\n9. Distribute keyword phrases across blog text, image SEO metadata, and Pinterest metadata without keyword stuffing.`;
      Logger.info(`[SEO] Injecting ${manualSeoKeywords.length} manual keyword(s) into recipe prompt`);
    }
    const introTemplates = settings.introTemplates || [];
    const conclusionTemplates = settings.conclusionTemplates || [];
    const idx = (settings.templateRotationIndex || 0) % Math.max(introTemplates.length, conclusionTemplates.length, 1);

    if (introTemplates.length > 0) {
      const introIdx = idx % introTemplates.length;
      templateInstructions += `\n\nCRITICAL - INTRO REWRITE RULE:\nFor the "intro" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm, paragraph count, and personality. Only change the food references. No AI cliches.\n\nINTRO TEMPLATE:\n${introTemplates[introIdx]}`;
      Logger.info(`Using intro template #${introIdx + 1}/${introTemplates.length}`);
    }

    if (conclusionTemplates.length > 0) {
      const concIdx = idx % conclusionTemplates.length;
      templateInstructions += `\n\nCRITICAL - CONCLUSION REWRITE RULE:\nFor the "conclusion" field, you MUST rewrite the template below to match the recipe "${state.recipeTitle}". Keep the EXACT same tone, structure, sentence rhythm.\n\nCONCLUSION TEMPLATE:\n${conclusionTemplates[concIdx]}`;
      Logger.info(`Using conclusion template #${concIdx + 1}/${conclusionTemplates.length}`);
    }

    if (introTemplates.length > 0 || conclusionTemplates.length > 0) {
      settings.templateRotationIndex = idx + 1;
      await StateManager.saveSettings(settings);
    }

    // ── Structure randomization: shuffle H2 titles + pick optional sections ──
    // Anti-scaled-content signal — each post looks editorially unique to Google
    const { instructions: structureInstructions, titles: sectionTitles } = this._buildStructureRandomization(state.recipeTitle);
    templateInstructions += structureInstructions;
    // Persist randomized titles so post-builder can render with the same H2s
    await StateManager.updateState({ sectionTitles });

    // Fetch related recipes from ALL categories for internal linking (best-effort; failures are non-fatal)
    let relatedRecipesBlock = 'No related recipes available — skip internal linking.';
    this._relatedPosts = []; // store for post-processing auto-linker
    try {
      const relatedPosts = await WordPressAPI.listPostsFromAllCategories(settings, 3);
      if (relatedPosts.length > 0) {
        this._relatedPosts = relatedPosts;
        relatedRecipesBlock = relatedPosts
          .map((p, i) => `${i + 1}. [${p.category}] "${p.title}" — ${p.url}${p.excerpt ? ` (${p.excerpt})` : ''}`)
          .join('\n');
        Logger.info(`[VerifiedGen] Fetched ${relatedPosts.length} related recipes across all categories for internal linking`);
      } else {
        Logger.info('[VerifiedGen] No related recipes found on site — skipping internal linking');
      }
    } catch (e) {
      Logger.warn(`[VerifiedGen] Failed to fetch related recipes: ${e.message}`);
    }

    // Fill placeholders in the VG prompt template. The template references
    // {{section_structure}} twice (prompts-verified.js:632-633) for the
    // randomized H2 plan — same payload as the structureInstructions block
    // appended to templateInstructions. We substitute it explicitly so Gemini
    // doesn't see the raw placeholder text (which it would otherwise echo back
    // and corrupt the JSON output).
    const prompt = template
      .replace(/\{\{topic\}\}/g, state.recipeTitle)
      .replace(/\{\{categories\}\}/g, settings.wpCategories || 'Breakfast, Lunch, Dinner, Dessert')
      .replace(/\{\{min_steps\}\}/g, String(vgSettings.minVisualSteps || defaults.minVisualSteps))
      .replace(/\{\{max_steps\}\}/g, String(vgSettings.maxVisualSteps || defaults.maxVisualSteps))
      .replace(/\{\{default_camera_angle\}\}/g, 'choose best angle for this step')
      .replace(/\{\{related_recipes\}\}/g, relatedRecipesBlock)
      .replace(/\{\{section_structure\}\}/g, structureInstructions || '')
      .replace(/\{\{template_instructions\}\}/g, templateInstructions);

    const aiChat = recipeAiChat;

    // Attach Pinterest reference images BEFORE sending the recipe prompt.
    // For now, this is ChatGPT-only. Gemini gets text-only because image refs
    // in the huge JSON prompt have caused Gemini UI 1155/truncated responses.
    if (!useGemini && pinterestRefPaths.length > 0 && typeof aiChat.attachFiles === 'function') {
      try {
        await aiChat.attachFiles(pinterestRefPaths);
      } catch (e) {
        Logger.warn(`[VerifiedGen] Pinterest attach to ${useGemini ? 'Gemini' : 'ChatGPT'} failed (non-fatal): ${e.message.split('\n')[0]}`);
      }
    }

    let response = await aiChat.sendPromptAndGetResponse(prompt, true);
    if (!response.success) throw new Error(`${useGemini ? 'Gemini' : 'ChatGPT'} failed: ${response.error}`);
    if (useGemini && !(response.data?.visual_plan || response.data?.visualPlan)) {
      Logger.warn('[Gemini] Response missing visual_plan after parse - requesting one complete JSON retry');
      const retryPrompt = [
        'Your previous JSON response was incomplete and missing "visual_plan".',
        'Return ONE complete valid JSON object only, with exactly these top-level keys: "recipe", "visual_plan", "pinterest_pins".',
        'Do not explain. Do not use markdown. Do not truncate. Include all recipe steps and matching visual_plan.visual_steps.',
        'Keep the same recipe topic and manual SEO keyword requirements from the previous prompt.'
      ].join('\n');
      response = await aiChat.sendPromptAndGetResponse(retryPrompt, true);
      if (!response.success) throw new Error(`Gemini retry failed: ${response.error}`);
    }
    if (!useGemini && typeof aiChat.deleteCurrentChat === 'function') {
      try {
        Logger.info('[ChatGPT] Recipe JSON response captured; deleting chat from history');
        await aiChat.deleteCurrentChat();
      } catch (e) {
        Logger.warn(`[ChatGPT] Recipe chat cleanup failed (non-fatal): ${e.message}`);
      }
    }

    // ── Parse the response: clear separation between recipe, visual_plan, pinterest_pins ──
    const data = response.data;

    // Extract recipe (may be nested under "recipe" key or at top level)
    let recipe, rawVisualPlan, rawPins;

    if (data.recipe && data.visual_plan) {
      // Clean structure: { recipe: {...}, visual_plan: {...}, pinterest_pins: [...] }
      recipe = data.recipe;
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
      // Gemini frequently splits the recipe across top-level + recipe.{}.
      // It puts article_title, meta_description, intro, category, etc. AT TOP
      // LEVEL while keeping cooking-specific fields (ingredients, steps) in
      // recipe.{}. We HOIST every top-level field that isn't a known wrapper
      // (recipe / visual_plan / pinterest_pins) into recipe.{} so downstream
      // code finds everything in one place. recipe.{} wins on conflict.
      const WRAPPER_KEYS = new Set(['recipe', 'visual_plan', 'pinterest_pins', 'visualPlan', 'pinterestPins']);
      const hoisted = [];
      for (const [k, v] of Object.entries(data)) {
        if (WRAPPER_KEYS.has(k)) continue;
        if (recipe[k] == null && v != null) {
          recipe[k] = v;
          hoisted.push(k);
        }
      }
      if (hoisted.length) Logger.info(`[VerifiedGen] Hoisted ${hoisted.length} top-level field(s) into recipe: ${hoisted.join(', ')}`);
      Logger.info('[VerifiedGen] Parsed clean structure: recipe + visual_plan + pinterest_pins');
    } else if (data.visual_plan) {
      // Flat structure: recipe fields at top level + visual_plan key
      rawVisualPlan = data.visual_plan;
      rawPins = data.pinterest_pins || [];
      recipe = { ...data };
      delete recipe.visual_plan;
      delete recipe.pinterest_pins;
      Logger.info('[VerifiedGen] Parsed flat structure: extracted visual_plan from recipe');
    } else {
      throw new Error('ChatGPT response missing visual_plan — make sure the prompt asks for it');
    }

    recipe = sanitizeRecipeJSON(recipe);
    // ── Schema normalization for AI free-form field naming ──────
    // Gemini (especially) is inconsistent — it variates between post_title /
    // title / article_title / article. Same for steps / instructions /
    // recipeInstructions. Normalize all known variations to the canonical
    // names expected by the rest of the pipeline.
    if (!recipe.post_title) {
      recipe.post_title = recipe.title || recipe.article_title || recipe.article || recipe.recipe_title || recipe.name;
    }
    if (!recipe.steps || !Array.isArray(recipe.steps) || recipe.steps.length === 0) {
      const stepsCandidate = recipe.instructions || recipe.recipeInstructions || recipe.directions || recipe.method;
      if (Array.isArray(stepsCandidate) && stepsCandidate.length > 0) recipe.steps = stepsCandidate;
    }
    if (!recipe.ingredients || !Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
      const ingCandidate = recipe.recipeIngredient || recipe.ingredients_list;
      if (Array.isArray(ingCandidate) && ingCandidate.length > 0) recipe.ingredients = ingCandidate;
    }
    if (!recipe.pro_tips && recipe.tips) recipe.pro_tips = recipe.tips;
    if (!recipe.storage_notes && recipe.storage) recipe.storage_notes = recipe.storage;

    // Gemini sometimes returns string-array fields as object-array
    // (e.g. [{title, body}, ...] or [{tip: "..."}]). The renderer's
    // <li>${item}</li> would then coerce each object to "[object Object]".
    // Flatten to plain strings, picking the most informative field.
    const _flattenToStringArray = (arr) => {
      if (!Array.isArray(arr)) return arr;
      return arr.map(item => {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        if (typeof item === 'object') {
          const t = item.title || item.name || item.heading || item.label;
          const b = item.body || item.description || item.text || item.content || item.tip || item.note;
          if (t && b) return `<strong>${t}:</strong> ${b}`;
          return b || t || item.tip || Object.values(item).filter(v => typeof v === 'string').join(': ') || '';
        }
        return String(item);
      }).filter(Boolean);
    };
    // NOTE: do NOT flatten `substitutions` here — post-builder has a
    // dedicated object-aware renderer that expects {ingredient, swap, note}.
    // Flattening would break that custom layout. Same for `faq` (uses
    // {question, answer}) and `equipment` (uses {name, description}).
    if (Array.isArray(recipe.pro_tips))    recipe.pro_tips    = _flattenToStringArray(recipe.pro_tips);
    if (Array.isArray(recipe.variations))  recipe.variations  = _flattenToStringArray(recipe.variations);

    if (!recipe.steps || !Array.isArray(recipe.steps)) {
      Logger.error('AI returned keys:', Object.keys(recipe).join(', '));
      Logger.error('Tried fallbacks: instructions, recipeInstructions, directions, method — none worked.');
      throw new Error('Invalid recipe JSON: missing steps array.');
    }
    Logger.info(`[VerifiedGen] Normalized: post_title="${(recipe.post_title || '').slice(0, 60)}" · ${recipe.steps.length} steps · ${(recipe.ingredients || []).length} ingredients`);

    // ── Title Case fix ──
    if (recipe.post_title) {
      recipe.post_title = toTitleCase(recipe.post_title);
      Logger.info(`[TitleCase] "${recipe.post_title}"`);
    }

    // ── Content Quality Gate: check per-section, re-prompt only bad parts ──
    if (settings.contentQualityEnabled !== false) {
      try {
        const qualityResult = await checkContentQuality(recipe, settings);
        if (!qualityResult.passed && qualityResult.fixPrompts.length > 0) {
          const aiChat = recipeAiChat;
          recipe = await applyContentFixes(recipe, qualityResult.fixPrompts, aiChat);
          if (!useGemini && typeof aiChat?.deleteCurrentChat === 'function') {
            try {
              Logger.info('[ChatGPT] Content quality fixes complete; deleting cleanup chat from history');
              await aiChat.deleteCurrentChat();
            } catch (e) {
              Logger.warn(`[ChatGPT] Quality cleanup chat delete failed (non-fatal): ${e.message}`);
            }
          }
        }
      } catch (e) {
        Logger.warn(`[Quality] Content quality check failed (non-fatal): ${e.message}`);
      }
    }

    if (recipeChatContextToClose) {
      try {
        await recipeChatContextToClose.close();
        Logger.info('[ChatGPT] Dedicated recipe/profile context closed');
      } catch (e) {
        Logger.warn(`[ChatGPT] Failed to close dedicated recipe/profile context (non-fatal): ${e.message}`);
      } finally {
        recipeChatContextToClose = null;
      }
    }

    // ── Nutrition API: fetch real nutrition data ──
    // Collect keys from every Flow account (for rotation) + settings fallback.
    const accountNutritionKeys = await FlowAccountManager.getAllNutritionKeys();
    const nutritionKeys = [...new Set([...accountNutritionKeys, settings.nutritionApiKey].filter(Boolean))];
    if (nutritionKeys.length > 0) {
      try {
        const nutrition = await fetchNutrition(
          nutritionKeys,
          recipe.ingredients || [],
          recipe.servings || 4
        );
        if (nutrition) {
          recipe.nutrition = nutrition;
        }
      } catch (e) {
        Logger.warn(`[Nutrition] API call failed (non-fatal): ${e.message}`);
      }
    }

    // ── Auto-recovery: synthesize ingredients_image.items from recipe.ingredients
    //    if the visual plan returned them empty/missing. This happens when the AI
    //    chat session lost context (often after a Flow account rotation reset the
    //    browser, or when Gemini truncated the response). We have the recipe's real
    //    ingredients list — derive presentation hints from each ingredient name. ──
    if (rawVisualPlan && !rawVisualPlan.ingredients_image) {
      Logger.warn('[VerifiedGen] Visual plan missing ingredients_image object entirely — synthesizing default');
      rawVisualPlan.ingredients_image = {
        image_type: 'ingredients',
        layout: 'Natural asymmetric scatter across the entire surface edge-to-edge. Mixed forms with whole items, standing packaged products, and a few small ramekins for chopped or grated bits. Items at different heights and different distances apart.',
        camera_angle: 'slight overhead (30-degree)',
        items: [],
        forbidden: ['cooked food', 'mixed items', 'garnish', 'utensils']
      };
    }
    if (rawVisualPlan?.ingredients_image &&
        (!Array.isArray(rawVisualPlan.ingredients_image.items) || rawVisualPlan.ingredients_image.items.length === 0)) {
      const recipeIngs = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      if (recipeIngs.length > 0) {
        Logger.warn(`[VerifiedGen] Visual plan returned empty ingredients_image.items — auto-deriving from ${recipeIngs.length} recipe ingredient(s)`);
        rawVisualPlan.ingredients_image.items = recipeIngs.map(ing => {
          const name = (typeof ing === 'string') ? ing : (ing.name || ing.ingredient || '');
          const lower = (name || '').toLowerCase();
          let presentation = 'whole';
          let brand = '';
          if (/oil|vinegar|sauce|syrup|extract|wine|stock|broth|milk|cream|honey|maple|soy|hot sauce|mustard|mayo/.test(lower)) {
            presentation = 'standing bottle'; brand = 'GRAZA';
          } else if (/flour|sugar|baking soda|baking powder|cocoa|cornstarch|breadcrumb|oat|cereal/.test(lower)) {
            presentation = 'standing box/bag'; brand = 'Great Value';
          } else if (/spice|pepper|cinnamon|paprika|cumin|garlic powder|onion powder|herb|salt|nutmeg|cardamom|thyme|oregano|basil/.test(lower)) {
            presentation = 'small ramekin';
          } else if (/cheese|butter|egg|yogurt/.test(lower)) {
            presentation = 'large plate';
          }
          return {
            name,
            state: 'whole/raw uncut as-purchased',
            presentation,
            brand,
            placement: ''
          };
        });
      } else {
        Logger.warn('[VerifiedGen] ingredients_image.items empty AND recipe.ingredients empty — using minimal placeholder');
        rawVisualPlan.ingredients_image.items = [{ name: 'main ingredient', state: 'whole/raw', presentation: 'whole', brand: '', placement: '' }];
      }
    }

    const rawVisualCount = Array.isArray(rawVisualPlan?.visual_steps) ? rawVisualPlan.visual_steps.length : 0;
    const recipeStepCount = Array.isArray(recipe.steps) ? recipe.steps.length : 0;
    Logger.info(`[VerifiedGen] Count check before visual validation: recipe.steps=${recipeStepCount}, visual_plan.visual_steps=${rawVisualCount}, pinterest_pins=${(rawPins || []).length}`);
    ensureVisualStepCoverage(rawVisualPlan, recipe.steps, vgSettings);
    const visualPlan = validateVisualPlan(rawVisualPlan, vgSettings);
    Logger.info(`[VerifiedGen] Count check after visual validation: recipe.steps=${recipeStepCount}, visual_plan.visual_steps=${visualPlan.visual_steps.length}`);

    // ── Identity-anchor Pinterest scrape ──
    // If the visual plan has a food_identity_canon, scrape ONE additional Pinterest
    // ref for the RAW/PRE-COOK state of the food using canon.prep_search_query.
    // This anchor is attached to every step that contains the primary food — gives
    // Flow a real photo of the correct silhouette so step 1 doesn't invent a wrong
    // shape that then cascades through the chain.
    let identityAnchorRefs = [];
    const canon = visualPlan.food_identity_canon;
    if (canon && canon.prep_search_query && canon.primary_food) {
      try {
        const { scrapePinterestImages } = await import('../gemini-visual/pinterest-scraper.js');
        const safeSlug = (state.recipeTitle || 'recipe').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
        const anchorDir = join(__dirname, '..', '..', '..', 'output', '_vg-identity-anchor-cache', `${safeSlug}-${Date.now()}`);
        const anchorImages = await scrapePinterestImages(this.context, canon.prep_search_query, anchorDir);
        identityAnchorRefs = anchorImages.map(p => p.path).slice(0, 1);
        Logger.info(`[VerifiedGen] Identity anchor (raw "${canon.primary_food}") scraped: ${identityAnchorRefs.length} ref`);
      } catch (e) {
        Logger.warn(`[VerifiedGen] Identity anchor scrape failed (non-fatal): ${e.message.split('\n')[0]}`);
      }
    } else {
      Logger.info('[VerifiedGen] No food_identity_canon — skipping identity anchor scrape (amorphous food or null canon)');
    }

    // Normalize ingredients format (support both array of strings and array of objects)
    if (Array.isArray(recipe.ingredients) && recipe.ingredients.length > 0 && typeof recipe.ingredients[0] === 'object') {
      // New format: {name, quantity, description} — keep as-is, post-builder handles both
    }

    // Build steps array: merge recipe step descriptions + visual plan titles + SEO
    const recipeSteps = (recipe.steps || []).map(_normalizeStepText);
    let steps = visualPlan.visual_steps.map((vs, i) => {
      const recipeStep = recipeSteps[i] || {};
      const stepSeo = recipeStep.seo || {};
      return {
        number: vs.step_id || i + 1,
        title: recipeStep.title || vs.title || `Step ${i + 1}`,
        description: recipeStep.description || vs.food_state || '',
        tip: recipeStep.tip || '',
        prompt: '',
        seo: {
          filename: stepSeo.filename || FILENAMES.stepDefault(i),
          alt_text: stepSeo.alt_text || recipeStep.title || vs.title || `Step ${i + 1}`,
          title: stepSeo.title || recipeStep.title || vs.title || `Step ${i + 1}`,
          description: stepSeo.description || recipeStep.description || vs.food_state || '',
          keywords: stepSeo.keywords || []
        },
        base64: null, wpImageId: null, wpImageUrl: null
      };
    });

    // Normalize pinterest_pins
    let pinterestPins = (rawPins || []).map((pin, i) => ({
      title: pin.title || `Pin ${i + 1}`,
      description: pin.description || '',
      image_prompt: pin.image_prompt || pin.prompt || '',
      keywords: pin.keywords || [],
      seo: pin.seo || null,
      base64: null, wpImageId: null, wpImageUrl: null
    }));
    const desiredPinCount = Math.max(3, Number(vgSettings.pinterestPinCount || 3));
    const beforePinCoverage = pinterestPins.length;
    pinterestPins = ensurePinterestPinCoverage(pinterestPins, recipe, manualSeoKeywords, desiredPinCount);
    if (pinterestPins.length !== beforePinCoverage) {
      Logger.info(`[Pinterest] Completed pin plan coverage: ${beforePinCoverage} -> ${pinterestPins.length}`);
    }
    ({ recipe, pinterestPins } = applyManualSeoKeywords(recipe, pinterestPins, manualSeoKeywords));
    recipe.pinterest_pins = pinterestPins;
    if (manualSeoKeywords.length) {
      steps = steps.map((step, i) => ({
        ...step,
        seo: ensureSeoObject(step.seo, step.title || `Step ${i + 1}`, keywordWindow(manualSeoKeywords, i + 5, 4), 6)
      }));
    }
    // Sheet topic (= primary keyword) must be present in every WP image's
    // alt/title/description — hero, ingredients, and each step.
    const seoTopic = recipe.post_title || state.recipeTitle || '';
    injectTitleIntoImageSeo(recipe.hero_seo, seoTopic);
    injectTitleIntoImageSeo(recipe.ingredients_seo, seoTopic);
    steps.forEach(step => injectTitleIntoImageSeo(step.seo, seoTopic));

    await StateManager.updateState({
      status: STATES.CREATING_FOLDERS,
      recipeJSON: recipe,
      visualPlan,
      vgIdentityAnchorRefs: identityAnchorRefs,
      steps,
      currentStepIndex: 0,
      pinterestPins,
      _relatedPosts: this._relatedPosts || [],
      seoData: {
        post_title: recipe.post_title || state.recipeTitle,
        slug: recipe.slug || '',
        focus_keyword: recipe.focus_keyword || '',
        meta_title: recipe.meta_title || '',
        meta_description: recipe.meta_description || ''
      }
    });

    // Advance intro rotation
    const nextIndex = ((settings.introRotationIndex || 0) + 1) % (settings.introRotationTotal || 12);
    await StateManager.saveSettings({ introRotationIndex: nextIndex });

    VGStats.chatgptEnd(steps.length);
    Logger.success(`Recipe + visual plan generated: ${steps.length} visual steps, ${pinterestPins.length} pins`);
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED INGREDIENTS IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedIngredients() {
    const state = await StateManager.getState();
    if (state.ingredientsImage?.base64) {
      await StateManager.updateState({ status: STATES.GENERATING_STEPS, currentStepIndex: 0 });
      return;
    }

    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const ingredientsState = state.visualPlan?.ingredients_image;

    if (!ingredientsState) throw new Error('No ingredients_image in visual plan');

    Logger.step('Flow', 'Generating verified ingredients image...');

    await this._ensureProModelForNewRecipe();

    const prompt = buildIngredientsPrompt(ingredientsState, vgSettings);

    if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
    const bgIndex = (state.backgroundQueueIndex || 0) % state.backgroundQueue.length;
    const backgroundPath = this._prepareFile(state.backgroundQueue[bgIndex], `bg-${bgIndex + 1}`);
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, FILENAMES.ingredients);

    await this._generateAndVerify({
      prompt, backgroundPath, contextPaths: [],
      aspectRatio: settings.ingredientAspectRatio || 'PORTRAIT',
      outputPath, isFirstImage: true, label: 'Ingredients', imageType: 'ingredients', vgSettings,
      verifyFn: async (path) => verifyIngredientsImage(await this._getGeminiApiKey(), path, ingredientsState, vgSettings),
      correctionFn: (result) => buildCorrectionPrompt(ingredientsState, result, vgSettings)
    });

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('ingredients', imgBuf.toString('base64'));
    await StateManager.updateState({
      status: STATES.GENERATING_STEPS,
      currentStepIndex: 0,
      ingredientsImage: { base64: true },
      backgroundQueueIndex: bgIndex + 1
    });
    Logger.success('Ingredients image generated (verified)');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED STEP IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedStep() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const idx = state.currentStepIndex;
    const step = state.steps[idx];
    const visualStep = state.visualPlan?.visual_steps?.[idx];

    if (step.base64) { await this._advanceStep(); return; }
    if (!visualStep) throw new Error(`No visual state for step ${idx + 1}`);

    Logger.step('Flow', `Step ${idx + 1}/${state.steps.length}: ${visualStep.title}`);

    // Build prompt later — we need to know which refs got attached so the prompt
    // can label each ref's role explicitly (per Google's "explicit role per image"
    // best practice when attaching 3+ refs).
    const isLastStep = idx === state.steps.length - 1;
    const foodIdentityCanon = state.visualPlan?.food_identity_canon || null;

    // Background — serving step uses the HERO background (same surface as hero image),
    // earlier steps use the kitchen pool so each step has a distinct surface.
    let backgroundPath;
    let bgIndex = state.backgroundQueueIndex || 0;
    if (isLastStep && state.selectedHeroBackground?.base64) {
      const heroBgTmpPath = join(__dirname, '..', '..', '..', 'data', 'tmp', 'hero-bg.jpg');
      try { writeFileSync(heroBgTmpPath, Buffer.from(state.selectedHeroBackground.base64, 'base64')); } catch {}
      backgroundPath = this._prepareFile(heroBgTmpPath, 'bg-hero');
      Logger.info('[Step] Final serving step using HERO background');
    } else {
      if (!state.backgroundQueue?.length) throw new Error('No backgrounds in queue');
      bgIndex = bgIndex % state.backgroundQueue.length;
      backgroundPath = this._prepareFile(state.backgroundQueue[bgIndex], `bg-${bgIndex + 1}`);
    }

    // Output path
    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, step.seo?.filename || FILENAMES.stepDefault(idx));

    // Context refs — order matters: Flow's picker weights the LAST-attached ref most.
    // Total kept up to 5 refs (3-5 sweet spot per Google's guidance, picking top end).
    // Ordering rules per step type:
    //   STEP 1:    pinterest hero refs (low) → identity anchor (mid) → ingredients flatlay (high)
    //   STEP 2:    pinterest (low) → identity anchor (mid) → step 1 (high)
    //   STEP 3:    pinterest (low) → identity anchor (low-mid) → step 1 (mid) → step 2 (high)
    //   STEP N≥4:  pinterest (low) → identity anchor (low-mid) → step N-3 (mid-low) → step N-2 (mid) → step N-1 (high)
    const contextPaths = [];
    const refRoles = []; // parallel array used to build role labels in the prose prompt

    // CLASSIC mode (Agent deselected) has NO conversational memory between
    // generations, so we MUST re-attach prior images as references for visual
    // continuity. Order matters: Flow's picker weights the LAST-attached ref most.
    if (idx === 0) {
      // Step 1 has no previous step — anchor on Pinterest style (low weight) +
      // the ingredients flat-lay (high, the immediately-preceding generated image).
      const pinterestRefs = [];
      if (pinterestRefs.length > 0) {
        contextPaths.push(...pinterestRefs);
        refRoles.push(`Pinterest reference photos of the finished dish — use ONLY for the dish's typical color palette and food-blog style. Do NOT copy plating or composition — this is the FIRST cooking step, the food is raw`);
      }
      const ingredientsImg = join(outputDir, FILENAMES.ingredients);
      if (existsSync(ingredientsImg)) {
        contextPaths.push(ingredientsImg);
        refRoles.push(`The ingredients flat-lay for THIS recipe — keep the SAME ingredients, colors and kitchen surface`);
      }
      Logger.info(`[Step 1] Refs attached: ${contextPaths.length} (ingredients only)`);
    } else {
      // SERVING step (the LAST step) is the finished plated dish — also attach
      // Pinterest style refs FIRST (low weight) so its plating/palette/garnish
      // matches the food-blog look, exactly like the hero. Earlier steps skip
      // Pinterest (the food is still mid-cook).
      if (isLastStep) {
        const pinterestRefs = (state.vgPinterestRefs || []).filter(p => p && existsSync(p)).slice(0, 1);
        if (pinterestRefs.length > 0) {
          contextPaths.push(...pinterestRefs);
          refRoles.push(`Pinterest reference photos of the finished dish — use ONLY for the dish's plating style, color palette and garnish; this is the finished, plated serving shot`);
        }
      }
      // Steps 2+: attach up to the LAST 2 step images (older → newer = highest
      // weight) so the dish identity, vessel, plating, surface and lighting
      // carry forward without any chat memory.
      const prevIdxs = [];
      if (idx - 2 >= 0) prevIdxs.push(idx - 2);
      prevIdxs.push(idx - 1);
      for (const pIdx of prevIdxs) {
        const p = this._findStepImage(state.steps, pIdx, outputDir);
        if (p && existsSync(p)) {
          contextPaths.push(p);
          refRoles.push(`Previous cooking step image (step ${pIdx + 1}) — keep the SAME dish identity, bowl/vessel, plating, kitchen surface and lighting; only ADVANCE the cooking progress to this step`);
        }
      }
      Logger.info(`[Step ${idx + 1}${isLastStep ? ' / serving' : ''}] Refs attached: ${contextPaths.length}${isLastStep ? ' (pinterest + last steps)' : ' previous step image(s)'}`);
    }

    // Now build the prompt with refRoles so the prose can label each ref explicitly
    const prompt = buildStepPrompt(visualStep, vgSettings, { isLastStep, foodIdentityCanon, refRoles, firstStep: idx === 0 });

    // Similarity check + cross-step verifier: previous step image (saved-name aware)
    const prevImagePath = idx > 0 ? this._findStepImage(state.steps, idx - 1, outputDir) : null;
    const prevStepTitle = idx > 0 ? (state.steps[idx - 1]?.title || `Step ${idx}`) : '';

    // Description that the reader will actually see in the blog post (helps Gemini cross-check)
    const recipeDescription = step?.description || visualStep.food_state || '';

    // Pass canon into verifier (via stepState) so it can run identity/composition checks
    // AND into correction-prompt builder via _canon side-channel.
    const stepStateWithCanon = { ...visualStep, _canon: foodIdentityCanon };

    await this._generateAndVerify({
      prompt, backgroundPath, contextPaths,
      aspectRatio: settings.stepAspectRatio || 'PORTRAIT',
      outputPath, label: `Step ${idx + 1}`, imageType: 'step', stepNumber: idx + 1, vgSettings,
      verifyFn: async (path) => verifyStepImage(
        await this._getGeminiApiKey(),
        path,
        stepStateWithCanon,
        vgSettings,
        { previousImagePath: prevImagePath, recipeDescription, previousStepTitle: prevStepTitle, foodIdentityCanon }
      ),
      correctionFn: (result) => buildCorrectionPrompt(stepStateWithCanon, result, vgSettings),
      // Similarity detection (still runs separately for the overall similarity score)
      prevImagePath,
      prevStepNum: idx,
      currentStepNum: idx + 1,
      expectedChange: visualStep.food_state || visualStep.title || ''
    });

    // Store as base64 for WordPress upload
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`step_${idx}`, imgBuf.toString('base64'));

    const steps = [...state.steps];
    steps[idx] = { ...steps[idx], base64: true, savedFilename: basename(outputPath) };
    await StateManager.updateState({ steps, backgroundQueueIndex: bgIndex + 1 });
    Logger.success(`Step ${idx + 1} image generated (verified)`);
    await this._advanceStep();
  }

  async _advanceStep() {
    const state = await StateManager.getState();
    const next = state.currentStepIndex + 1;
    if (next < state.steps.length) {
      await StateManager.updateState({ currentStepIndex: next });
    } else {
      await StateManager.updateState({ status: STATES.GENERATING_HERO });
      Logger.success('All step images generated!');
    }
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED HERO IMAGE
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedHero() {
    const state = await StateManager.getState();
    if (state.heroImage?.base64) {
      await StateManager.updateState({ status: STATES.SAVING_FILES });
      return;
    }

    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const heroState = state.visualPlan?.hero_image;

    if (!heroState) throw new Error('No hero_image in visual plan');

    Logger.step('Flow', 'Generating verified hero image...');

    // Build prompt LATER — need to know which refs got attached for role-labeling
    const foodIdentityCanon = state.visualPlan?.food_identity_canon || null;

    // Write hero background to temp file with unique prefix
    const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const heroTmpPath = join(tmpDir, 'hero-bg.jpg');
    if (!state.selectedHeroBackground?.base64) {
      throw new Error('Hero background image not loaded — re-run from start');
    }
    writeFileSync(heroTmpPath, Buffer.from(state.selectedHeroBackground.base64, 'base64'));

    const outputDir = this._getOutputDir(state, settings);
    const outputPath = join(outputDir, state.recipeJSON?.hero_seo?.filename || FILENAMES.hero);

    // Context refs for hero (max 4, in order from lowest to highest weight):
    //   1. Pinterest hero refs (low) — style/color anchor
    //   2. Middle step image (mid) — recipe trajectory continuity (3+ step recipes only)
    //   3. Last step / serving image (high) — direct continuity, the food just left this state
    // Note: identity anchor is intentionally skipped here — at hero stage the food is
    // fully cooked, and the raw anchor would conflict with the finished look.
    const contextPaths = [];
    const refRoles = [];

    // CLASSIC mode (no chat memory): the hero references ONLY the serving-plate
    // image (the last cooking step — the finished, plated dish) plus the Pinterest
    // style photos. Order low→high weight: Pinterest (style) → serving plate (high).
    const heroPinterest = (state.vgPinterestRefs || []).filter(p => p && existsSync(p)).slice(0, 1);
    if (heroPinterest.length > 0) {
      contextPaths.push(...heroPinterest);
      refRoles.push(`Pinterest reference photos of the finished dish — use for the dish's color palette, garnish and food-blog plating style`);
    }
    const servingIdx = state.steps.length - 1; // last step = serving / plated dish
    const servingImg = servingIdx >= 0 ? this._findStepImage(state.steps, servingIdx, outputDir) : null;
    if (servingImg && existsSync(servingImg)) {
      contextPaths.push(servingImg);
      refRoles.push(`The serving-plate image (final step) — the hero must show the SAME finished, plated dish: same plating, garnish, vessel and lighting, just reframed as the beauty hero shot`);
    }
    Logger.info(`[Hero] Refs attached: ${contextPaths.length} (pinterest + serving plate)`);

    // Now build the hero prompt with the refRoles labels embedded
    const prompt = buildHeroPrompt(heroState, vgSettings, { foodIdentityCanon, refRoles });
    const heroStateWithCanon = { ...heroState, _canon: foodIdentityCanon };

    await this._generateAndVerify({
      prompt, backgroundPath: heroTmpPath, contextPaths,
      aspectRatio: settings.heroAspectRatio || 'LANDSCAPE',
      outputPath, label: 'Hero', imageType: 'hero', vgSettings,
      verifyFn: async (path) => verifyHeroImage(await this._getGeminiApiKey(), path, heroStateWithCanon, vgSettings, { foodIdentityCanon }),
      correctionFn: (result) => buildCorrectionPrompt(heroStateWithCanon, result, vgSettings)
    });

    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData('hero', imgBuf.toString('base64'));
    await StateManager.updateState({ status: STATES.SAVING_FILES, heroImage: { base64: true } });
    Logger.success('Hero image generated (verified)');
  }

  // ═══════════════════════════════════════════════════════
  // STEP: VERIFIED PINTEREST PINS
  // ═══════════════════════════════════════════════════════

  async _stepVerifiedPins() {
    const state = await StateManager.getState();
    const settings = await StateManager.getSettings();
    const vgSettings = this._getVGSettings(settings);
    const pins = state.pinterestPins || [];

    if (!pins.length) {
      Logger.info('No Pinterest pins to generate — skipping');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const pendingIdx = pins.findIndex(p => !p.base64);
    if (pendingIdx === -1) {
      Logger.success('All Pinterest pin images already generated');
      await StateManager.updateState({ status: STATES.UPLOADING_PINS });
      return;
    }

    const pin = pins[pendingIdx];
    Logger.step('Flow', `Pinterest pin ${pendingIdx + 1}/${pins.length}: ${pin.title}`);

    // CLEAN SLATE FOR PINS: close recipe project, open fresh Pinterest project on first pin.
    // This prevents the picker from showing step images and only keeps hero + last step as refs.
    if (pendingIdx === 0 && !state.pinterestProjectReady) {
      Logger.info('[Pinterest] Closing recipe project, opening fresh Pinterest project...');
      try { await this.flow.closeSession(); } catch {}
      // Clear prepared files cache so bg-*, hero-bg etc. get re-copied with fresh picker names
      this._preparedFiles = new Map();
      await StateManager.updateState({ pinterestProjectReady: true });
    }

    // Pick template — dashboard-managed (backgrounds.json) takes priority,
    // falls back to legacy folder for older installs. Mirrors hero backgrounds
    // UX: upload templates via Dashboard → Settings → Images.
    const isScraper = settings.mode === 'scrape';
    const pinMode = isScraper ? 'scraper' : 'generator';
    const dashboardTemplates = await StateManager.getPinterestTemplates(pinMode);

    let originalTemplatePath;
    const rotation = settings.pinterestTemplateRotationIndex || {};
    const rotationStart = Number(rotation[pinMode] || 0);

    if (dashboardTemplates.length > 0) {
      const templateIdx = (rotationStart + pendingIdx) % dashboardTemplates.length;
      const picked = dashboardTemplates[templateIdx];
      const tmpDir = join(__dirname, '..', '..', '..', 'data', 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      const ext = picked.name?.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      originalTemplatePath = join(tmpDir, `pin-template-src-${Date.now()}-${pendingIdx}.${ext}`);
      writeFileSync(originalTemplatePath, Buffer.from(picked.base64, 'base64'));
      Logger.info(`Using dashboard template ${templateIdx + 1}/${dashboardTemplates.length}: ${picked.name}`);
    } else {
      const legacyFolder = isScraper
        ? settings.pinterestTemplateFolderScraper
        : settings.pinterestTemplateFolderGenerator;
      if (!legacyFolder || !existsSync(legacyFolder)) {
        Logger.warn(`No Pinterest templates configured for ${pinMode} (dashboard or folder). Skipping pins.`);
        await StateManager.updateState({ status: STATES.UPLOADING_PINS });
        return;
      }
      const templateImages = StateManager.listImagesInFolder(legacyFolder);
      if (!templateImages.length) {
        throw new Error(`No template images found in: ${legacyFolder}`);
      }
      const templateIdx = (rotationStart + pendingIdx) % templateImages.length;
      originalTemplatePath = templateImages[templateIdx];
      Logger.info(`Using legacy folder template ${templateIdx + 1}/${templateImages.length}: ${basename(originalTemplatePath)}`);
    }

    const templatePath = this._prepareFile(originalTemplatePath, `pin-${pendingIdx + 1}`);

    // Context: HERO ONLY. The hero is the canonical finished-dish visual —
    // every pin remixes it (different framing, crop, or cut-view). Mixing in
    // mid-cooking step photos used to leak raw/half-cooked appearance into
    // the pin output (= bad Pinterest CTR).
    const contextPaths = [];
    const outputDir = this._getOutputDir(state, settings);
    const heroFilename = state.recipeJSON?.hero_seo?.filename || FILENAMES.hero;
    const heroPath = join(outputDir, heroFilename);
    if (existsSync(heroPath)) contextPaths.push(heroPath);

    // Build prompt from VG's own Pinterest template
    const defaults = VERIFIED_GENERATOR_DEFAULTS;
    const recipeTitle = state.recipeJSON?.post_title || state.recipeTitle || '';
    const websiteUrl = settings.wpUrl || '';
    const websiteDomain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Bullet-formatted ingredient list for templates that show ingredients.
    // The default VG prompt embeds {{ingredients}} with a conditional — if
    // the template has an ingredients section, the AI fills it; otherwise
    // the data is ignored. Cap at 8 lines to avoid cramming the layout.
    const formatIng = (ing) => {
      const qty = (ing?.quantity || '').toString().trim();
      const name = (ing?.name || '').toString().trim();
      if (qty && name) return `${qty} ${name}`;
      return name || qty;
    };
    const ingredientsList = (state.recipeJSON?.ingredients || [])
      .slice(0, 8)
      .map(formatIng)
      .filter(Boolean)
      .map(s => `• ${s}`)
      .join('\n');

    const pinterestTemplate = vgSettings.prompts?.pinterest || defaults.prompts.pinterest;
    let prompt = pinterestTemplate
      .replace(/\{\{pin_title\}\}/g, pin.title || recipeTitle)
      .replace(/\{\{pin_description\}\}/g, pin.description || '')
      .replace(/\{\{recipe_title\}\}/g, recipeTitle)
      .replace(/\{\{website\}\}/g, websiteDomain)
      .replace(/\{\{ingredients\}\}/g, ingredientsList || '(none specified)');

    // Pin #2 is a money-shot variation: instead of placing the standard hero
    // in the template's photo zone, ask for a close-up reveal (cut/sliced/
    // forked/poured). This boosts series diversity — Pinterest favors visual
    // variety within a recipe's pins.
    if (pendingIdx === 1) {
      prompt += `\n\nMONEY-SHOT VARIATION: in the template's main photo zone, render the dish from image two as a tighter close-up that REVEALS the interior or texture — a knife slicing through, a fork lifting a bite, the dish split in half showing the filling/layers, sauce being poured, or steam rising. Keep the SAME dish, plating, and lighting as the hero, just reframe to be appetizing and crave-worthy.`;
    }

    const pinFilename = `pin-${pendingIdx + 1}.jpg`;
    const outputPath = join(outputDir, pinFilename);

    const useChatGPT = (settings.pinGenerator || 'flow').toLowerCase() === 'chatgpt';
    if (useChatGPT) {
      Logger.info(`[PinGen] Routing pin ${pendingIdx + 1} to ChatGPT image gen (settings.pinGenerator=chatgpt)`);
      // Build pinVars for the user's chatgptPin.promptTemplate wrapper. Resolves
      // @title / @website / @pin_title / @pin_description / @ingredients in the
      // wrapper so they reach ChatGPT with actual values (not literal "@title").
      const pinVars = {
        '@title': recipeTitle,
        '@pin_title': pin.title || '',
        '@pin_description': pin.description || '',
        '@website': websiteDomain,
        '@ingredients': ingredientsList || '',
      };
      const ok = await this._generatePinViaChatGPT({
        prompt,
        templatePath,
        contextPaths,
        outputPath,
        settings,
        pinVars,
      });
      if (!ok) throw new Error(`Pinterest pin ${pendingIdx + 1} image generation failed (ChatGPT)`);
    } else {
      await this._generateAndVerify({
        prompt, backgroundPath: templatePath, contextPaths,
        aspectRatio: settings.pinterestAspectRatio || 'PORTRAIT',
        outputPath, skipSimilarityCheck: true,
        label: `Pin ${pendingIdx + 1}`, imageType: 'pin', stepNumber: pendingIdx + 1, vgSettings,
        verifyFn: async (path) => verifyPinterestImage(await this._getGeminiApiKey(), path, recipeTitle, vgSettings),
        correctionFn: null // No correction for pins — just retry with same prompt
      });
    }

    // NO post-crop normalization — keep native ratio (9:16 from ChatGPT picker).
    // See base-orchestrator for rationale.

    // Store image data
    const imgBuf = readFileSync(outputPath);
    await StateManager.storeImageData(`pin_${pendingIdx}`, imgBuf.toString('base64'));

    const updatedPins = [...pins];
    updatedPins[pendingIdx] = { ...updatedPins[pendingIdx], base64: true };
    await StateManager.updateState({ pinterestPins: updatedPins });
    Logger.success(`Pinterest pin ${pendingIdx + 1} image generated (verified)`);

    const allDone = updatedPins.every(p => p.base64);
    if (allDone) {
      const templateCount = dashboardTemplates.length > 0
        ? dashboardTemplates.length
        : (() => {
            const legacyFolder = isScraper ? settings.pinterestTemplateFolderScraper : settings.pinterestTemplateFolderGenerator;
            if (!legacyFolder || !existsSync(legacyFolder)) return 0;
            return StateManager.listImagesInFolder(legacyFolder).length;
          })();
      if (templateCount > 0) {
        const nextIndex = (rotationStart + updatedPins.length) % templateCount;
        await StateManager.saveSettings({
          pinterestTemplateRotationIndex: {
            ...(settings.pinterestTemplateRotationIndex || {}),
            [pinMode]: nextIndex,
          }
        });
        Logger.info(`[Pinterest] Template rotation ${pinMode}: ${rotationStart} -> ${nextIndex} (${updatedPins.length} pin(s), ${templateCount} template(s))`);
      }
    }
  }

  /**
   * Find a step image on disk — tries savedFilename (guaranteed), then SEO name, then step-N.jpg.
   * If the target step isn't found, scans backwards to find the closest existing step.
   * @returns {string|null} absolute path to the image, or null if nothing found
   */
  _findStepImage(steps, targetIdx, outputDir) {
    for (let i = targetIdx; i >= 0; i--) {
      const step = steps[i];
      // 1. savedFilename — the actual filename written to disk (most reliable)
      if (step.savedFilename) {
        const p = join(outputDir, step.savedFilename);
        if (existsSync(p)) return p;
      }
      // 2. SEO filename from ChatGPT
      if (step.seo?.filename) {
        const p = join(outputDir, step.seo.filename);
        if (existsSync(p)) return p;
      }
      // 3. Default step-N.jpg
      const p = join(outputDir, FILENAMES.stepDefault(i));
      if (existsSync(p)) return p;

      // Only scan backwards if target step wasn't found
      if (i === targetIdx) {
        Logger.warn(`[Context] Step ${i + 1} image not found — scanning backwards`);
      }
    }
    return null;
  }
}
