/**
 * Recipe Validator — gate pin posting on recipe quality.
 *
 * Fetches the WP post + extracts Recipe JSON-LD (emitted by Yoast / WPRM /
 * Tasty Recipes — all major recipe plugins). Then runs a series of checks:
 *
 *   1. Ingredient reconciliation: scan each step's text for ingredient
 *      mentions that don't appear in ingredients[]. The carrot-cake post
 *      bug (cinnamon + baking soda in steps but not in ingredients) is the
 *      canonical example we're catching.
 *
 *   2. Minimum content: ingredients[] not empty, steps[] not empty,
 *      title present.
 *
 *   3. Suspicious ratios (future hook): cream cheese frosting with too
 *      little sweetener, etc. Disabled for now — requires domain rules.
 *
 * Returns { valid, issues, source } where source indicates whether the
 * data came from JSON-LD ('schema'), microdata ('microdata'), or wasn't
 * recoverable ('unknown' — defaults to valid so we don't block on every
 * post that doesn't expose schema).
 *
 * Cache: results stored in memory keyed by site+rowIndex. Re-validates
 * on server restart (acceptable — validator is cheap).
 */

import { Logger } from '../../shared/utils/logger.js';

const _validationCache = new Map();

/**
 * Extract the post ID from a draftUrl like
 *   https://thetastymama.com/wp-admin/post.php?post=1586&action=edit
 */
function _extractPostId(draftUrl) {
  try {
    const u = new URL(draftUrl);
    const id = u.searchParams.get('post');
    if (id && /^\d+$/.test(id)) return { origin: u.origin, postId: id };
  } catch {}
  return null;
}

/**
 * Try every reasonable place a Recipe schema could be embedded in the
 * post HTML and return the structured data.
 *   - JSON-LD blocks with @type Recipe (preferred)
 *   - WPRM JSON in `<script type="application/json" data-recipe-id>` (legacy)
 *
 * Returns { ingredients: string[], steps: string[], title } or null.
 */
function _parseRecipeFromHtml(html) {
  // JSON-LD path (most common with Yoast)
  const ldMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1].trim());
      const candidates = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const entry of candidates) {
        const types = Array.isArray(entry?.['@type']) ? entry['@type'] : [entry?.['@type']];
        if (!types.some(t => /^Recipe$/i.test(String(t || '')))) continue;

        const ingredients = (entry.recipeIngredient || []).map(s => String(s).trim()).filter(Boolean);
        let steps = [];
        if (Array.isArray(entry.recipeInstructions)) {
          for (const inst of entry.recipeInstructions) {
            if (typeof inst === 'string') steps.push(inst);
            else if (inst?.text) steps.push(String(inst.text));
            else if (inst?.itemListElement) {
              for (const sub of inst.itemListElement) {
                if (sub?.text) steps.push(String(sub.text));
              }
            }
          }
        }
        return {
          source: 'schema',
          title: entry.name || '',
          ingredients,
          steps,
        };
      }
    } catch (e) {
      // malformed JSON-LD — try next block
    }
  }

  // Microdata fallback — very approximate
  const ingMatches = [...html.matchAll(/itemprop=["']recipeIngredient["'][^>]*>([^<]+)</gi)];
  if (ingMatches.length > 0) {
    const ingredients = ingMatches.map(m => m[1].trim()).filter(Boolean);
    const stepMatches = [...html.matchAll(/itemprop=["']recipeInstructions["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)];
    const steps = stepMatches.map(m => m[1].replace(/<[^>]+>/g, ' ').trim()).filter(Boolean);
    return { source: 'microdata', title: '', ingredients, steps };
  }

  return null;
}

/**
 * Build a normalized lookup of ingredient "core names" — the substantive
 * noun(s) stripped of quantities, parentheticals, prep instructions, etc.
 *
 * Examples:
 *   "1 cup all-purpose flour"            → ["flour", "all-purpose flour"]
 *   "2 tbsp olive oil, divided"          → ["olive oil"]
 *   "3 large eggs, room temperature"     → ["eggs"]
 *   "1/2 tsp ground cinnamon"            → ["cinnamon", "ground cinnamon"]
 */
function _normalizeIngredient(raw) {
  let s = String(raw || '').toLowerCase();
  // Strip parentheticals — "(optional)", "(15 oz)", etc.
  s = s.replace(/\([^)]*\)/g, ' ');
  // Strip leading quantity + unit (numbers, fractions, common units)
  s = s.replace(/^[\d\s½¼¾⅓⅔⅛⅜⅝⅞.\/-]+/, ' ');
  s = s.replace(/^(cups?|cup|tablespoons?|tbsp|teaspoons?|tsp|ounces?|oz|pounds?|lbs?|lb|grams?|g|kg|kilograms?|ml|liters?|l|pinch|dash|cloves?|stick|sticks|slices?|cans?|packages?|pkgs?|bunch|bunches|large|medium|small|extra-large|xl)\s+/i, ' ');
  // Strip trailing prep instructions after comma
  s = s.replace(/,.*$/, '');
  s = s.replace(/\bdivided\b|\bto taste\b|\bfor serving\b|\bfor garnish\b|\boptional\b/gi, ' ');
  // Clean whitespace and punctuation
  s = s.replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return [];

  // Return both the full normalized form and tokens, so "ground cinnamon"
  // matches both "cinnamon" and "ground cinnamon" in step text
  const tokens = s.split(/\s+/).filter(t => t.length >= 3 && !COMMON_FILLER.has(t));
  const out = new Set([s]);
  if (tokens.length > 1) {
    // Last token usually carries the core noun ("ground cinnamon" → "cinnamon")
    out.add(tokens[tokens.length - 1]);
  }
  return [...out].filter(Boolean);
}

// Words that show up in ingredient lists but aren't actually ingredients
const COMMON_FILLER = new Set([
  // Prep adjectives
  'fresh', 'dried', 'frozen', 'chopped', 'minced', 'sliced', 'diced', 'cubed',
  'grated', 'ground', 'whole', 'crushed', 'finely', 'roughly', 'thinly',
  'cooked', 'raw', 'boneless', 'skinless', 'unsalted', 'salted', 'plain',
  'organic', 'extra', 'virgin', 'pure', 'natural', 'creamy', 'crunchy',
  'softened', 'melted', 'beaten', 'whipped', 'shredded', 'peeled', 'coated',
  // Quantifiers / hedge words
  'about', 'around', 'approximately', 'preferably', 'roughly', 'almost',
  'generous', 'generously', 'amount', 'amounts', 'lots', 'plenty', 'just',
  'enough', 'remaining', 'extra', 'more', 'less', 'half',
  // Connectives / pronouns
  'and', 'the', 'for', 'with', 'into', 'from', 'plus', 'optional',
  'them', 'they', 'this', 'that', 'these', 'those', 'such', 'each', 'every',
  'all', 'any', 'some', 'several',
  // Sensory / descriptive
  'visible', 'visibly', 'evenly', 'lightly', 'heavily', 'completely',
  'partially', 'fully', 'slightly', 'gently', 'carefully', 'quickly', 'slowly',
  'until', 'while', 'before', 'after', 'when', 'then', 'once',
  // Food appearance descriptors that look like nouns
  'texture', 'color', 'colour', 'consistency', 'flavor', 'flavour',
  'aroma', 'taste', 'look', 'looks', 'appearance', 'shape', 'shapes', 'size',
  'piece', 'pieces', 'bit', 'bits', 'part', 'parts', 'portion', 'portions',
  'mixture', 'batter', 'dough', 'mix', 'blend', 'combination',
  // Cooking nouns (not ingredients)
  'everything', 'something', 'nothing', 'anything',
  'side', 'sides', 'edge', 'edges', 'corner', 'corners', 'bottom', 'top',
  'middle', 'center', 'centre', 'inside', 'outside', 'surface',
  'crust', 'rim',
  // Action / state adverbs
  'freshly', 'recently', 'previously', 'directly',
]);

/**
 * Known food noun whitelist — only words on this list are flagged as
 * "potentially missing from ingredients[]". Without this filter the
 * validator hits too many false positives like "texture", "amount", etc.
 *
 * Coverage: the ~150 most commonly omitted ingredients in food recipes
 * (spices, dairy, common proteins, common produce, baking essentials).
 */
const KNOWN_FOOD_NOUNS = new Set([
  // Spices & herbs
  'cinnamon', 'nutmeg', 'ginger', 'cloves', 'allspice', 'cardamom',
  'oregano', 'basil', 'thyme', 'rosemary', 'parsley', 'cilantro',
  'dill', 'mint', 'sage', 'tarragon', 'chives', 'paprika', 'cumin',
  'turmeric', 'coriander', 'fennel', 'mustard', 'cayenne', 'chili',
  'pepper', 'saffron', 'bay',
  // Baking
  'flour', 'sugar', 'salt', 'yeast', 'cocoa', 'chocolate',
  'soda', 'powder', 'cornstarch', 'baking',
  // Dairy
  'milk', 'cream', 'butter', 'cheese', 'yogurt', 'mozzarella', 'cheddar',
  'parmesan', 'feta', 'ricotta', 'mascarpone',
  // Eggs (yolk/whites are parts — only flag if no egg in recipe at all)
  'eggs', 'egg',
  // Liquids
  'water', 'oil', 'vinegar', 'wine', 'broth', 'stock', 'juice', 'sauce',
  'ketchup', 'mayonnaise', 'mustard', 'syrup', 'honey', 'molasses',
  'soy', 'worcestershire', 'tabasco',
  // Produce — common
  'onion', 'onions', 'garlic', 'tomato', 'tomatoes', 'potato', 'potatoes',
  'carrot', 'carrots', 'celery', 'lettuce', 'spinach', 'broccoli',
  'cauliflower', 'cucumber', 'cucumbers', 'avocado', 'corn',
  'mushroom', 'mushrooms', 'zucchini', 'eggplant', 'bell',
  // Fruits
  'lemon', 'lemons', 'lime', 'limes', 'orange', 'apple', 'apples',
  'banana', 'bananas', 'berry', 'berries', 'blueberry', 'blueberries',
  'strawberry', 'strawberries', 'raspberry', 'raspberries',
  'peach', 'peaches', 'pear', 'pears', 'grape', 'grapes',
  // Proteins
  'chicken', 'beef', 'pork', 'lamb', 'turkey', 'duck', 'bacon', 'sausage',
  'ham', 'ground', 'steak',
  // Seafood
  'fish', 'salmon', 'tuna', 'shrimp', 'crab', 'lobster', 'cod', 'tilapia',
  // Grains & pasta
  'rice', 'pasta', 'noodles', 'noodle', 'bread', 'tortilla', 'tortillas',
  'oats', 'quinoa', 'couscous',
  // Beans & legumes
  'beans', 'lentils', 'chickpeas', 'peas',
  // Nuts & seeds
  'almonds', 'walnuts', 'pecans', 'cashews', 'peanuts', 'sesame', 'pine',
  // Sweeteners (only true ingredients — "brown" / "powdered" / "white" are modifiers)
  'maple', 'confectioners',
  // Misc
  'vanilla', 'extract', 'olives', 'capers', 'pickles', 'jam', 'jelly',
  'enchilada', 'enchiladas', 'taco', 'salsa', 'guacamole',
]);

/**
 * Extract candidate "noun phrases" from a step's text that LOOK like
 * ingredient references. Very rough — we just tokenize and look for nouns
 * that appear in cooking contexts (after "add", "stir in", "fold in", etc.)
 *
 * Approach: split on punctuation, get word tokens, lowercase. Then look
 * for tokens that aren't filler words and aren't action verbs.
 */
function _stepTokens(stepText) {
  const s = String(stepText || '').toLowerCase()
    .replace(/[^a-z\s-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const tokens = s.split(/\s+/).filter(t => t.length >= 4);
  return new Set(tokens.filter(t => !COMMON_FILLER.has(t) && !ACTION_VERBS.has(t)));
}

const ACTION_VERBS = new Set([
  'pour', 'mix', 'stir', 'fold', 'add', 'combine', 'whisk', 'beat', 'sift',
  'cook', 'bake', 'simmer', 'boil', 'fry', 'sauté', 'sautee', 'roast', 'grill',
  'brown', 'browned', 'browning',   // "brown the meat" is a verb
  'reduce', 'thicken', 'crisp',
  'place', 'spread', 'sprinkle', 'top', 'cover', 'transfer', 'remove',
  'cool', 'heat', 'warm', 'preheat', 'reduce', 'increase', 'serve', 'garnish',
  'minutes', 'minute', 'seconds', 'second', 'hours', 'hour', 'until', 'while',
  'over', 'medium', 'high', 'low', 'gentle', 'large', 'small', 'about',
  'mixture', 'batter', 'dough', 'sauce', 'liquid', 'mixture',
  'side', 'sides', 'pan', 'bowl', 'plate', 'dish', 'baking', 'oven',
  'this', 'that', 'these', 'those', 'each', 'every', 'into', 'onto',
  'before', 'after', 'when', 'then', 'next', 'first', 'second', 'last',
  'with', 'without', 'using', 'use', 'using', 'should', 'will', 'have',
]);

/**
 * Run validation checks. Returns { valid, issues: [{ kind, msg }] }.
 */
function _runChecks(recipe) {
  const issues = [];

  if (!recipe.ingredients || recipe.ingredients.length === 0) {
    issues.push({ kind: 'no-ingredients', msg: 'Empty ingredients list' });
  }
  if (!recipe.steps || recipe.steps.length === 0) {
    issues.push({ kind: 'no-steps', msg: 'Empty steps list' });
  }

  // Ingredient reconciliation
  if (recipe.ingredients?.length > 0 && recipe.steps?.length > 0) {
    const stem = (w) => {
      let s = String(w).toLowerCase();
      if (s.endsWith('ies') && s.length > 4) return s.slice(0, -3) + 'y';
      if (s.endsWith('es') && s.length > 4) return s.slice(0, -2);
      if (s.endsWith('s') && s.length > 3 && !s.endsWith('ss')) return s.slice(0, -1);
      return s;
    };

    // Build a set of stemmed ingredient tokens. Stemming on both sides makes
    // "blueberry" (in step) match "blueberries" (in ingredient).
    const ingredientStemSet = new Set();
    const ingredientHaystack = ' ' + recipe.ingredients.join(' | ').toLowerCase() + ' ';
    for (const line of recipe.ingredients) {
      const cleaned = String(line).toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ');
      for (const t of cleaned.split(/\s+/)) {
        if (t.length < 3) continue;
        ingredientStemSet.add(t);
        ingredientStemSet.add(stem(t));
      }
    }

    // Scan step text; flag tokens that:
    //   - are KNOWN food nouns (whitelist gate)
    //   - do NOT appear in haystack/stem-set
    const unmatchedMentions = new Set();
    for (const step of recipe.steps) {
      const text = String(step).toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ');
      const tokens = text.split(/\s+/).filter(Boolean);
      for (const raw of tokens) {
        if (raw.length < 4) continue;
        if (COMMON_FILLER.has(raw) || ACTION_VERBS.has(raw)) continue;
        if (!KNOWN_FOOD_NOUNS.has(raw) && !KNOWN_FOOD_NOUNS.has(stem(raw))) continue;
        if (ingredientStemSet.has(raw) || ingredientStemSet.has(stem(raw))) continue;
        if (ingredientHaystack.includes(raw)) continue;
        unmatchedMentions.add(raw);
      }
    }

    // Threshold: flag only if 2+ unique food nouns are unmatched.
    // 1 is allowed (could be a one-off mention or recipe title noise).
    if (unmatchedMentions.size >= 2) {
      issues.push({
        kind: 'ingredient-reconciliation',
        msg: `Steps mention ${unmatchedMentions.size} ingredient(s) not in ingredients[]: ${[...unmatchedMentions].slice(0, 8).join(', ')}`,
        unmatched: [...unmatchedMentions],
      });
    }
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Public entry point. Validates a recipe by fetching the WP post and
 * running checks. Caches the result.
 *
 * @param {object} recipeItem - pool entry with { rowIndex, site, draftUrl, ... }
 * @returns {Promise<{ valid, issues, source, fetchedAt }>}
 */
export async function validateRecipe(recipeItem) {
  if (!recipeItem?.draftUrl) {
    return { valid: false, issues: [{ kind: 'no-draft-url', msg: 'Recipe has no draftUrl' }], source: 'no-url' };
  }
  const cacheKey = `${recipeItem.site}|${recipeItem.rowIndex}`;
  const cached = _validationCache.get(cacheKey);
  // Cache for 24h — re-validate occasionally in case the post was edited
  if (cached && (Date.now() - cached.fetchedAt) < 24 * 3600_000) {
    return cached;
  }

  const parsed = _extractPostId(recipeItem.draftUrl);
  if (!parsed) {
    const r = { valid: true, issues: [], source: 'unparsable-url', fetchedAt: Date.now() };
    _validationCache.set(cacheKey, r);
    return r;
  }

  // Fetch the published post URL — but we don't know it yet. Use ?p=ID redirect.
  // Better: use WP REST to get content, which is JSON, not HTML, but does
  // not expose JSON-LD. So fetch the public HTML instead.
  const publicUrl = `${parsed.origin}/?p=${parsed.postId}`;
  let html;
  try {
    const res = await fetch(publicUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (RecipeAutomator-Validator)' },
    });
    if (!res.ok) {
      // FAIL CLOSED: a public URL we can't fetch must not be pinned — a missed
      // slot is cheaper than a pin to a dead page. NOT cached, so a transient
      // blip doesn't block this recipe for 24h; the next attempt re-validates.
      return { valid: false, issues: [{ kind: 'fetch-failed', msg: `HTTP ${res.status} on ${publicUrl}` }], source: 'fetch-error', fetchedAt: Date.now() };
    }
    html = await res.text();
  } catch (e) {
    Logger.warn(`[Validator] fetch failed for ${recipeItem.topic}: ${e.message}`);
    // Same FAIL CLOSED rule as HTTP errors above; uncached for quick retry.
    return { valid: false, issues: [{ kind: 'fetch-failed', msg: e.message }], source: 'fetch-error', fetchedAt: Date.now() };
  }

  const recipe = _parseRecipeFromHtml(html);
  if (!recipe) {
    // Couldn't find structured data — default to valid (don't block)
    const r = { valid: true, issues: [{ kind: 'no-schema', msg: 'Recipe schema not found in post (defaulted to valid)' }], source: 'unknown', fetchedAt: Date.now() };
    _validationCache.set(cacheKey, r);
    return r;
  }

  const checks = _runChecks(recipe);
  const r = {
    valid: checks.valid,
    issues: checks.issues,
    source: recipe.source,
    ingredientCount: recipe.ingredients.length,
    stepCount: recipe.steps.length,
    fetchedAt: Date.now(),
  };
  _validationCache.set(cacheKey, r);
  if (!checks.valid) {
    Logger.warn(`[Validator] ${recipeItem.topic} (row ${recipeItem.rowIndex}) INVALID: ${checks.issues.map(i => i.kind).join(', ')}`);
  }
  return r;
}

/** Clear the validation cache (admin endpoint). */
export function clearValidationCache() {
  _validationCache.clear();
}

/** Return cache snapshot for debugging. */
export function getValidationCache() {
  return Object.fromEntries(_validationCache);
}
