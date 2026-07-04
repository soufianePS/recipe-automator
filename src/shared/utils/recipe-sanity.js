/**
 * Recipe sanity fixes — catch "untested recipe" tells before publishing.
 *
 * Ad networks (Mediavine explicitly) terminate publishers for recipes that
 * were clearly never cooked. The two cheapest-to-catch tells this module
 * fixes on the recipe JSON right after generation:
 *
 *   1. Servings vs yield mismatch — recipe.servings says "6" while the
 *      steps say "divide into 12 muffin cups". Reviewers spot this in
 *      seconds, and it silently doubles per-serving nutrition values.
 *
 *   2. Missing oven preheat — steps bake at a temperature but no step
 *      ever turns the oven on ("Keep the oven at 375°F" with no preheat).
 *
 * Mutates the recipe in place and returns it. Never throws — every fix is
 * individually try/caught so a regex edge case can't kill a pipeline run.
 */

import { Logger } from './logger.js';

// Item-style yield units (plural form as written in step text). When the
// reconciled yield uses one of these, we also expose recipe.yield_unit so
// the recipe card can render "Servings: 12 muffins" instead of a bare "12".
const ITEM_UNITS = [
  'cookies', 'muffins', 'cupcakes', 'brownies', 'blondies', 'bars', 'squares',
  'rolls', 'buns', 'biscuits', 'scones', 'pancakes', 'waffles', 'crepes',
  'donuts', 'doughnuts', 'meatballs', 'patties', 'sliders', 'tacos',
  'empanadas', 'turnovers', 'pretzels', 'breadsticks', 'balls', 'truffles',
  'slices', 'wedges', 'pieces', 'ramekins', 'jars', 'glasses',
];
const COUNT_UNITS = ['servings', 'portions', 'people'];
const UNIT_ALT = [...ITEM_UNITS, ...COUNT_UNITS]
  // longest first so "muffin cups" style compounds can be added safely later
  .sort((a, b) => b.length - a.length)
  // also match the singular ("makes 1 loaf" style is rare for these units,
  // but "12 patty" vs "12 patties" needs the irregular form)
  .map(u => u === 'patties' ? 'patties|patty' : `${u}|${u.replace(/ies$/, 'y').replace(/s$/, '')}`)
  .join('|');

function _stepText(step) {
  if (typeof step === 'string') return step;
  if (!step || typeof step !== 'object') return '';
  return [step.title, step.description, step.tip].filter(Boolean).join(' ');
}

function _recipeCorpus(recipe) {
  const parts = [
    ...(Array.isArray(recipe.steps) ? recipe.steps.map(_stepText) : []),
    recipe.recipe_card_description,
    recipe.storage_notes,
    recipe.intro,
    recipe.conclusion,
  ];
  return parts.filter(Boolean).join('\n');
}

function _pluralizeUnit(u) {
  const w = u.toLowerCase();
  if (w === 'patty') return 'patties';
  if (ITEM_UNITS.includes(w) || COUNT_UNITS.includes(w)) return w;
  const plural = w.endsWith('y') ? w.slice(0, -1) + 'ies' : w + 's';
  return (ITEM_UNITS.includes(plural) || COUNT_UNITS.includes(plural)) ? plural : w;
}

/**
 * Scan recipe text for explicit yield statements and reconcile with
 * recipe.servings. Text wins over the servings field: the steps describe
 * what the cook physically does ("divide into 12 muffin cups"), while
 * servings is a free-standing number the model fills in independently —
 * when they disagree, the steps are the testable claim.
 */
function _reconcileServings(recipe) {
  const corpus = _recipeCorpus(recipe);
  if (!corpus) return;

  // number → { votes, unit, explicit } — explicit = stated with makes/yields
  const votes = new Map();
  const addVote = (n, unit, explicit) => {
    if (!Number.isFinite(n) || n < 1 || n > 96) return;
    const v = votes.get(n) || { votes: 0, unit: '', explicit: false };
    v.votes++;
    v.explicit = v.explicit || explicit;
    if (unit && !COUNT_UNITS.includes(unit)) v.unit = unit;
    votes.set(n, v);
  };

  // "makes/yields (about) 12 cookies"
  const makesRe = new RegExp(
    `\\b(?:makes?|yields?)\\s+(?:about\\s+|around\\s+|roughly\\s+|approximately\\s+)?(\\d{1,2})\\s+(?:large\\s+|small\\s+|medium\\s+|mini\\s+|jumbo\\s+|even\\s+|equal\\s+)?(${UNIT_ALT})\\b`, 'gi');
  for (const m of corpus.matchAll(makesRe)) addVote(parseInt(m[1]), _pluralizeUnit(m[2]), true);

  // "divide/portion/scoop ... into 12 muffin cups / 12 equal portions / 12 balls"
  const divideRe = new RegExp(
    `\\b(?:divide|portion|scoop|spoon|drop|shape|form|roll|press|pour|distribute)\\b[^.!?]{0,80}?\\binto\\s+(?:about\\s+)?(\\d{1,2})\\s+(?:greased\\s+|lined\\s+|prepared\\s+|equal(?:ly)?[-\\s](?:sized\\s+)?)?(muffin\\s+cups?|${UNIT_ALT})`, 'gi');
  for (const m of corpus.matchAll(divideRe)) {
    const unit = /^muffin/i.test(m[2]) ? 'muffins' : _pluralizeUnit(m[2]);
    addVote(parseInt(m[1]), unit, false);
  }

  // "12-cup muffin tin/pan"
  for (const m of corpus.matchAll(/\b(\d{1,2})[-\s]cup\s+muffin\s+(?:tin|pan)\b/gi)) {
    addVote(parseInt(m[1]), 'muffins', false);
  }

  // "serves 8"
  for (const m of corpus.matchAll(/\bserves\s+(?:about\s+)?(\d{1,2})\b/gi)) {
    addVote(parseInt(m[1]), 'servings', false);
  }

  if (votes.size === 0) return;

  // Pick the winner: explicit "makes N" beats inferred counts, then most
  // votes, then the larger number (a bigger stated yield is more likely the
  // physical batch count than a leftover default).
  const ranked = [...votes.entries()].sort((a, b) =>
    (b[1].explicit - a[1].explicit) || (b[1].votes - a[1].votes) || (b[0] - a[0]));
  const [bestN, best] = ranked[0];

  if (votes.size > 1) {
    Logger.info(`[Sanity] Multiple yield candidates: ${ranked.map(([n, v]) => `${n}${v.unit ? ' ' + v.unit : ''}(x${v.votes}${v.explicit ? ',explicit' : ''})`).join(', ')} — using ${bestN}`);
  }

  const current = parseInt(recipe.servings);
  if (best.unit) recipe.yield_unit = best.unit;
  if (!Number.isFinite(current) || current !== bestN) {
    Logger.warn(`[Sanity] Servings/yield mismatch: servings="${recipe.servings}" but recipe text says ${bestN}${best.unit ? ' ' + best.unit : ''} — fixing servings to ${bestN}`);
    recipe.servings = String(bestN);
    recipe._servings_reconciled = true;
  }
}

/**
 * If the steps use the oven at a temperature but never preheat it, inject a
 * preheat sentence. It goes at the END of the step BEFORE the first oven
 * step ("get the oven heating while you finish assembling") — the natural
 * place a real cook mentions it — or at the start of step 1 if the oven is
 * used immediately.
 */
function _ensureOvenPreheat(recipe) {
  const steps = recipe.steps;
  if (!Array.isArray(steps) || steps.length === 0) return;

  const texts = steps.map(_stepText);
  if (texts.some(t => /preheat/i.test(t))) return;

  const ovenIdx = texts.findIndex(t =>
    /\b(?:bake|baking|roast|roasting|broil|oven)\b/i.test(t));
  if (ovenIdx === -1) return;

  // Temperature: collect every degree-marked number in oven range (200-550°F
  // — skips food-safety temps like 165°F and fridge temps like 40°F),
  // preferring one whose sentence mentions the oven. Fallback: a bare
  // oven-range number right after bake/oven wording.
  let temp = null;
  let anyRangeTemp = null;
  for (const t of texts) {
    for (const sentence of t.split(/(?<=[.!?])\s+/)) {
      const deg = sentence.match(/\b(\d{2,3})\s*(?:°|degrees?\s*)F?\b/i);
      if (!deg) continue;
      const n = parseInt(deg[1]);
      if (n < 200 || n > 550) continue;
      if (anyRangeTemp === null) anyRangeTemp = n;
      if (/\b(?:bake|baking|oven|roast|roasting|broil)\b/i.test(sentence)) { temp = n; break; }
    }
    if (temp !== null) break;
  }
  if (temp === null) temp = anyRangeTemp;
  if (temp === null) {
    const ctx = texts[ovenIdx].match(/\b(?:bake|oven|roast|broil)\b[^.!?]{0,40}?\b([2-5]\d{2})\b/i);
    if (ctx) temp = parseInt(ctx[1]);
  }

  const sentence = temp !== null
    ? `Preheat the oven to ${temp}°F`
    : 'Preheat the oven';

  const setDescription = (idx, updater) => {
    const s = steps[idx];
    if (typeof s === 'string') steps[idx] = updater(s);
    else if (s && typeof s === 'object') s.description = updater(s.description || '');
  };

  if (ovenIdx > 0) {
    setDescription(ovenIdx - 1, d => {
      const base = d.trim().replace(/\s+$/, '');
      const glue = base && !/[.!?]$/.test(base) ? '. ' : ' ';
      return `${base}${base ? glue : ''}${sentence} now so it's fully hot by the time the pan goes in.`.trim();
    });
    Logger.warn(`[Sanity] No preheat step found — added "${sentence}" to the end of step ${ovenIdx} (oven first used in step ${ovenIdx + 1})`);
  } else {
    setDescription(0, d => `${sentence}. ${d}`.trim());
    Logger.warn(`[Sanity] No preheat step found — added "${sentence}" to the start of step 1`);
  }
  recipe._preheat_injected = true;
}

/**
 * Run all sanity fixes on a freshly generated/rewritten recipe JSON.
 * Call AFTER content-quality fixes (so re-prompted step text can't undo the
 * preheat injection) and BEFORE fetching nutrition (so per-serving values
 * divide by the reconciled count).
 */
export function applyRecipeSanityFixes(recipe) {
  if (!recipe || typeof recipe !== 'object') return recipe;
  try { _reconcileServings(recipe); } catch (e) { Logger.warn(`[Sanity] Servings reconciliation failed (non-fatal): ${e.message}`); }
  try { _ensureOvenPreheat(recipe); } catch (e) { Logger.warn(`[Sanity] Preheat check failed (non-fatal): ${e.message}`); }
  return recipe;
}
