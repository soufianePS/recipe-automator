/**
 * Nutrition API — fetches real nutrition data from API Ninjas
 * Replaces ChatGPT-hallucinated nutrition values with USDA-backed data.
 */

import { Logger } from './logger.js';

const API_URL = 'https://api.api-ninjas.com/v1/nutrition';

/**
 * Fetch nutrition data for a list of ingredients.
 * Sends each ingredient line to API Ninjas, sums the totals.
 * Accepts one key or an array of keys — rotates when a key hits the monthly limit (429).
 *
 * @param {string|string[]} apiKey - API Ninjas API key (or array for rotation)
 * @param {Array<{name: string, amount?: string}>} ingredients - Ingredient list from recipe JSON
 * @param {string|number} servings - Number of servings (to calculate per-serving values)
 * @returns {object} Nutrition object matching WPRM/Tasty Recipes format
 */
export async function fetchNutrition(apiKey, ingredients, servings = 1) {
  // Normalize to array and filter empties
  const keys = (Array.isArray(apiKey) ? apiKey : [apiKey]).filter(Boolean);
  if (keys.length === 0) {
    Logger.warn('[Nutrition] No API key configured — skipping nutrition lookup');
    return null;
  }
  if (keys.length > 1) {
    Logger.info(`[Nutrition] Using ${keys.length} API keys with rotation on 429`);
  }

  let keyIdx = 0;
  const currentKey = () => keys[keyIdx];
  const rotateKey = (reason) => {
    if (keyIdx + 1 < keys.length) {
      keyIdx++;
      Logger.warn(`[Nutrition] Key ${keyIdx} rotated (${reason}) → trying key ${keyIdx + 1}/${keys.length}`);
      return true;
    }
    Logger.error(`[Nutrition] All ${keys.length} keys exhausted (${reason})`);
    return false;
  };

  const servingCount = parseInt(servings) || 1;
  const totals = {
    calories: 0,
    protein: 0,
    fat: 0,
    saturated_fat: 0,
    carbohydrates: 0,
    fiber: 0,
    sugar: 0,
    sodium: 0,
    cholesterol: 0
  };

  let successCount = 0;

  for (const ing of ingredients) {
    // Build query string: "2 cups cottage cheese" or "1 tablespoon honey".
    // Recipe JSON uses `quantity` (a free-form string like "1 tsp"); the older
    // amount+unit shape is kept as a fallback. Without a quantity, API Ninjas
    // defaults to 100g — which inflates sodium/cholesterol massively for things
    // like salt or soy sauce, so we skip qty-less object ingredients instead.
    let query;
    if (typeof ing === 'string') {
      query = ing.trim();
    } else {
      const name = ing.name || ing.ingredient || '';
      const qty = ing.quantity || `${ing.amount || ''} ${ing.unit || ''}`.trim();
      if (!qty) {
        Logger.debug(`[Nutrition] Skipped "${name}" — no quantity (would default to 100g)`);
        continue;
      }
      query = `${qty} ${name}`.replace(/\s+/g, ' ').trim();
    }

    if (!query) continue;

    // Try every key until one returns 2xx. Rotate on ANY failure (quota, invalid,
    // forbidden, server error, network error) — not just 429/402.
    let resp = null;
    let lastError = null;
    for (let attempt = 0; attempt < keys.length; attempt++) {
      try {
        resp = await fetch(`${API_URL}?query=${encodeURIComponent(query)}`, {
          headers: { 'X-Api-Key': currentKey() }
        });
        if (resp.ok) { lastError = null; break; }
        lastError = `HTTP ${resp.status}`;
        // Quota / rate-limit / unauthorized / forbidden / server error → rotate
        if ([401, 402, 403, 429, 500, 502, 503, 504].includes(resp.status)) {
          if (!rotateKey(`HTTP ${resp.status}`)) break;
          continue;
        }
        // Any other non-2xx → skip this ingredient, keep current key
        break;
      } catch (e) {
        lastError = 'network: ' + e.message;
        if (!rotateKey(lastError)) break;
      }
    }

    if (!resp || !resp.ok) {
      Logger.debug(`[Nutrition] Skipped "${query}" — ${lastError || 'unknown error'}`);
      continue;
    }

    try {
      const data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) {
        Logger.debug(`[Nutrition] No data for "${query}"`);
        continue;
      }

      // Sum all items returned (API may split "2 cups cottage cheese" into multiple items)
      // Note: Free tier returns "Only available for premium subscribers." for calories & protein
      const num = (v) => (typeof v === 'number' && !isNaN(v)) ? v : 0;
      for (const item of data) {
        totals.calories += num(item.calories);
        totals.protein += num(item.protein_g);
        totals.fat += num(item.fat_total_g);
        totals.saturated_fat += num(item.fat_saturated_g);
        totals.carbohydrates += num(item.carbohydrates_total_g);
        totals.fiber += num(item.fiber_g);
        totals.sugar += num(item.sugar_g);
        totals.sodium += num(item.sodium_mg);
        totals.cholesterol += num(item.cholesterol_mg);
      }
      successCount++;
    } catch (e) {
      Logger.debug(`[Nutrition] Fetch failed for "${query}": ${e.message}`);
    }

    // Small delay to respect rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  if (successCount === 0) {
    Logger.warn('[Nutrition] Could not fetch data for any ingredient');
    return null;
  }

  Logger.info(`[Nutrition] Got data for ${successCount}/${ingredients.length} ingredients`);

  // Free tier doesn't include calories/protein — estimate from macros if missing
  // Calories ≈ fat*9 + carbs*4 + protein*4
  if (totals.calories === 0 && (totals.fat > 0 || totals.carbohydrates > 0)) {
    totals.calories = Math.round(totals.fat * 9 + totals.carbohydrates * 4 + totals.protein * 4);
    Logger.info(`[Nutrition] Estimated calories from macros: ${totals.calories} kcal`);
  }

  // Calculate per-serving values and round.
  // Free tier returns strings for calories/protein → totals stay at 0. Emit "" so the recipe card hides the line instead of showing "0g".
  const perUnit = (total, unit) => total > 0 ? String(Math.round(total / servingCount)) + unit : '';
  const perServing = {
    serving_size: `1 serving (of ${servingCount})`,
    calories: totals.calories > 0 ? String(Math.round(totals.calories / servingCount)) : '',
    protein: perUnit(totals.protein, 'g'),
    fat: perUnit(totals.fat, 'g'),
    saturated_fat: perUnit(totals.saturated_fat, 'g'),
    carbohydrates: perUnit(totals.carbohydrates, 'g'),
    fiber: perUnit(totals.fiber, 'g'),
    sugar: perUnit(totals.sugar, 'g'),
    sodium: perUnit(totals.sodium, 'mg'),
    cholesterol: perUnit(totals.cholesterol, 'mg')
  };

  Logger.success(`[Nutrition] Per serving: ${perServing.calories} cal, ${perServing.protein} protein, ${perServing.fat} fat, ${perServing.carbohydrates} carbs`);
  return perServing;
}
