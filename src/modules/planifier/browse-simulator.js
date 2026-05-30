/**
 * Browse session simulator (v2 — high-variability human model).
 *
 * Pure function that produces a step-by-step preview of a single Pinterest
 * "browse" session with the current config — without launching any browser.
 * Used by the dashboard "Preview Session" button AND replayed verbatim by the
 * executor (pinterest.js → humanBrowseSession), so what you preview is what
 * actually runs.
 *
 * v2 goals (more human, harder to fingerprint):
 *   - Session length varies A LOT (e.g. 3 min one day, 20 min the next). The
 *     session is a LOOP that fills a random target duration with weighted
 *     "beats", not a fixed linear script.
 *   - Irregular scrolling, random backtracking, idle/hesitation, image zoom.
 *   - Short pauses (1-5s) vs long reading pauses (8-25s).
 *   - Not every action leads to engagement (lots of looking, few saves).
 *   - SAVES are constrained: a pin is only saved after SEARCHING a recipe
 *     from the sheet, and it is saved to the board matching THAT recipe's
 *     category (1-to-1). No random feed saves. Often a session saves nothing.
 *
 * Each emitted event carries an explicit `durSec` = how many seconds the
 * executor should spend on/after that action. Total session ≈ Σ durSec.
 */

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const chance = pct => Math.random() * 100 < (pct || 0);

const ACTIONS = {
  OPEN: 'open', CLOSE: 'close', WAIT: 'wait',
  SCROLL: 'scroll', BACKTRACK: 'backtrack',
  CLOSEUP: 'closeup', ZOOM: 'zoom', SAVE: 'save',
  SEARCH: 'search', VIDEO: 'video', VISIT: 'visit',
  PROFILE: 'profile', BACK: 'back', IDLE: 'idle', HESITATE: 'hesitate',
};

/**
 * @param {object} config — full planifier config (rules.browseBehaviors used)
 * @param {string} siteName — site whose searchKeywords/categories are used
 * @param {object} [override] — optional override for browseBehaviors
 * @param {string[]} [recipeTitles] — legacy: recipe titles only (no category)
 * @param {object} [extras] — { categories: string[], recipes: [{title, category}] }
 */
export function simulateSession(config, siteName, override = {}, recipeTitles = [], extras = {}) {
  const bb = { ...(config.rules?.browseBehaviors || {}), ...override };
  const site = config.sites?.[siteName] || {};

  // ── Keyword / recipe / board sources ────────────────────────────
  const categories = Array.isArray(extras.categories) ? extras.categories.filter(Boolean) : [];
  const manualKeywords = site.searchKeywords || [];

  // Prefer {title, category} pairs (extras.recipes); fall back to titles-only.
  let recipes = Array.isArray(extras.recipes) && extras.recipes.length
    ? extras.recipes.filter(r => r && r.title)
    : recipeTitles.filter(Boolean).map(t => ({ title: t, category: '' }));
  if (!site.useRecipeNamesAsKeywords) {
    recipes = [];
  } else if (recipes.length) {
    recipes = recipes.slice(0, Math.min(site.recipeNamesSampleSize || 30, recipes.length));
  }
  // Recipe searches use ONLY recipes that have a (non-blank) category. Every
  // recipe search can lead to a save, and the save needs the category to map to
  // a board, so blank-category recipes are never picked for a search at all.
  const recipesWithCategory = recipes.filter(r => (r.category || '').trim());

  // Boards from the FIRST active account (the live executor knows the exact acc)
  const account = (site.pinterestAccounts || []).find(a => a.status === 'active' || a.status === 'warmup_week_2');
  const boards = account?.boards || [];

  const events = [];
  let t = 0;
  const counters = {
    closeups: 0, saves: 0, searches: 0, recipeSearches: 0, videos: 0, visits: 0,
    profileGlances: 0, scrollBursts: 0, backtracks: 0, zooms: 0, idles: 0, hesitations: 0,
  };

  const push = (action, detail, durSec, extra = {}) => {
    const d = Math.max(0, Number(durSec) || 0);
    events.push({ t: Number(t.toFixed(1)), action, detail, durSec: Number(d.toFixed(1)), ...extra });
    t += d;
  };
  const longRead = () => rand(bb.longReadSecondsMin ?? 8, bb.longReadSecondsMax ?? 25);

  // Highly variable target session length (the core of "varies a lot")
  const targetMinutes = rand(bb.sessionMinutesMin ?? 3, bb.sessionMinutesMax ?? 20);
  const targetSeconds = targetMinutes * 60;
  // Per-session save budget — often 0 (so "sometimes no saves"); capped 0..max
  const saveBudget = randInt(0, bb.maxSavesPerSession ?? 3);

  // ── Beat implementations (function declarations → mutually hoisted) ──
  function scrollBeat(totalSec, label) {
    counters.scrollBursts++;
    push(ACTIONS.SCROLL, `${label} (~${Math.round(totalSec)}s, irregular speed)`, totalSec, { irregular: true });
    // Random backtracking — scroll back up to re-look, then resume
    if (chance(bb.backtrackProbability ?? 35)) {
      counters.backtracks++;
      push(ACTIONS.BACKTRACK, 'Scroll back up to re-look at a pin', rand(2, 6));
      push(ACTIONS.SCROLL, 'Resume scrolling down', rand(4, 12), { irregular: true });
    }
  }

  function closeupBeat() {
    const count = randInt(bb.closeupCountMin ?? 1, bb.closeupCountMax ?? 3);
    for (let i = 0; i < count; i++) {
      counters.closeups++;
      push(ACTIONS.CLOSEUP, `Open pin #${i + 1} → detail view`, rand(2, 4));
      push(ACTIONS.WAIT, 'Read title & description', longRead(), { reading: true });
      if (chance(bb.zoomProbability ?? 35)) {
        counters.zooms++;
        push(ACTIONS.ZOOM, 'Zoom into the image to look closer', rand(2, 6));
      }
      // Occasionally open the external blog in a new tab and leave it idle
      if (chance(bb.visitExternalProbability ?? 10)) {
        counters.visits++;
        push(ACTIONS.VISIT, 'Open "Visit" link in a new tab', rand(2, 4));
        push(ACTIONS.IDLE, 'Glance at the blog, leave the tab idle', rand(5, 15), { tab: true });
      }
      // NOTE: no save here — saves only happen via recipe-search flow.
      push(ACTIONS.BACK, 'Back to feed', rand(1, 3));
      if (i < count - 1) scrollBeat(rand(6, 16), 'Scroll to the next pin');
    }
  }

  function searchBeat() {
    counters.searches++;
    const useRecipe = recipesWithCategory.length > 0 && chance(bb.recipeSearchShare ?? 80);
    let keyword, recipeCategory = '', isRecipe = false;
    if (useRecipe) {
      // ONLY recipes that have a category — never a blank-category recipe.
      const r = pick(recipesWithCategory);
      keyword = r.title; recipeCategory = (r.category || '').trim(); isRecipe = true;
      counters.recipeSearches++;
    } else if (categories.length) {
      keyword = pick(categories);
    } else {
      keyword = pick(manualKeywords) || 'easy recipes';
    }
    push(ACTIONS.SEARCH, `Search "${keyword}"${isRecipe ? ' (recipe from sheet)' : ''}`,
      rand(6, 12), { keyword, isRecipe, recipeCategory });
    scrollBeat(rand(12, 30), 'Scroll search results');

    if (chance(bb.searchPinClickAfterProbability ?? 65)) {
      counters.closeups++;
      push(ACTIONS.CLOSEUP, 'Open a search-result pin', rand(2, 4));
      push(ACTIONS.WAIT, 'Read the result', longRead(), { reading: true });
      if (chance(bb.zoomProbability ?? 35)) {
        counters.zooms++;
        push(ACTIONS.ZOOM, 'Zoom into the result image', rand(2, 5));
      }
      // SAVE — only after a recipe search where we KNOW the category, only
      // while the per-session budget remains. The board hint IS the category;
      // the executor saves to any board whose name CONTAINS it (case-insensitive),
      // e.g. category "Dinner" → board "Best Dinner Family". No category → no save.
      if (isRecipe && recipeCategory && counters.saves < saveBudget && chance(bb.savePinProbability ?? 40)) {
        counters.saves++;
        push(ACTIONS.SAVE, `Save to the board containing "${recipeCategory}"`,
          rand(4, 9), { boardHint: recipeCategory });
      }
      push(ACTIONS.BACK, 'Back to results', rand(1, 3));
    }
  }

  function videoBeat() {
    counters.videos++;
    push(ACTIONS.VIDEO, 'Pause on an auto-playing video pin', rand(5, 15));
  }

  function idleBeat() {
    counters.idles++;
    push(ACTIONS.IDLE, 'Idle — distracted for a few seconds', rand(bb.idleSecondsMin ?? 3, bb.idleSecondsMax ?? 12));
  }

  function profileBeat() {
    counters.profileGlances++;
    push(ACTIONS.PROFILE, 'Open own profile → glance at boards', rand(10, 25));
    push(ACTIONS.BACK, 'Back to home feed', rand(1, 3));
  }

  function hesitateBeat() {
    counters.hesitations++;
    push(ACTIONS.HESITATE, "Move toward a pin, hesitate, don't click", rand(2, 6));
  }

  function pickBeat() {
    const w = bb.beatWeights || {};
    const pool = [
      ['scroll', w.scroll ?? 34],
      ['closeup', w.closeup ?? 24],
      ['video', w.video ?? 8],
      ['idle', w.idle ?? 9],
      ['hesitate', w.hesitate ?? 5],
    ];
    if (recipes.length || categories.length || manualKeywords.length) pool.push(['search', w.search ?? 15]);
    if (counters.profileGlances < 1) pool.push(['profile', w.profile ?? 5]);  // at most one profile glance
    const total = pool.reduce((s, [, wt]) => s + wt, 0);
    let r = Math.random() * total;
    for (const [name, wt] of pool) { if ((r -= wt) < 0) return name; }
    return 'scroll';
  }

  function runBeat(beat) {
    switch (beat) {
      case 'scroll':   return scrollBeat(rand(8, 35), 'Browse the feed');
      case 'closeup':  return closeupBeat();
      case 'search':   return searchBeat();
      case 'video':    return videoBeat();
      case 'idle':     return idleBeat();
      case 'profile':  return profileBeat();
      case 'hesitate': return hesitateBeat();
      default:         return scrollBeat(rand(8, 20), 'Browse the feed');
    }
  }

  // ── Session flow ────────────────────────────────────────────────
  // 1. Open + settle on the home feed
  push(ACTIONS.OPEN, 'Open Pinterest → land on home feed', rand(3, 7));
  push(ACTIONS.WAIT, 'Wait for feed to render, glance at top', rand(2, 5));

  // 2. Initial feed scroll
  scrollBeat(rand(bb.initialFeedScrollSecondsMin ?? 15, bb.initialFeedScrollSecondsMax ?? 60), 'Initial feed scroll');

  // 3. Main loop — fill the (variable) target duration with weighted beats
  let guard = 0;
  while (t < targetSeconds && guard++ < 200) {
    runBeat(pickBeat());
  }

  // 4. Wind down + close
  scrollBeat(rand(bb.finalFeedScrollSecondsMin ?? 15, bb.finalFeedScrollSecondsMax ?? 45), 'Final wind-down scroll');
  push(ACTIONS.CLOSE, 'Close browser (session complete)', 0);

  return {
    events,
    durationSeconds: Math.round(t),
    durationMinutes: Number((t / 60).toFixed(1)),
    targetMinutes: Number(targetMinutes.toFixed(1)),
    summary: counters,
    siteName,
    recipesAvailable: recipes.length,
    categoriesCount: categories.length,
    boardsCount: boards.length,
    saveBudget,
    activityRatio: {
      // saves per closeup — humans look far more than they save (≈0 is normal)
      saveToCloseupRatio: counters.closeups > 0 ? Number((counters.saves / counters.closeups).toFixed(2)) : 0,
    },
  };
}

/**
 * Run N independent simulations and aggregate stats — useful for "average
 * session look" without running once and getting a freak outlier.
 */
export function simulateMany(config, siteName, n = 50, override = {}, recipeTitles = [], extras = {}) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(simulateSession(config, siteName, override, recipeTitles, extras));
  }
  const avg = (key) => Number((runs.reduce((s, r) => s + (r.summary[key] || 0), 0) / n).toFixed(2));
  const avgDuration = Number((runs.reduce((s, r) => s + r.durationSeconds, 0) / n / 60).toFixed(1));
  return {
    runs: n,
    avgDurationMinutes: avgDuration,
    minDuration: Math.round(Math.min(...runs.map(r => r.durationSeconds)) / 60 * 10) / 10,
    maxDuration: Math.round(Math.max(...runs.map(r => r.durationSeconds)) / 60 * 10) / 10,
    avgCloseups: avg('closeups'),
    avgSaves: avg('saves'),
    avgSearches: avg('searches'),
    avgRecipeSearches: avg('recipeSearches'),
    avgVideos: avg('videos'),
    avgVisits: avg('visits'),
    avgProfileGlances: avg('profileGlances'),
    avgZooms: avg('zooms'),
    avgIdles: avg('idles'),
    avgBacktracks: avg('backtracks'),
    avgHesitations: avg('hesitations'),
    pctSessionsWithNoSaves: Number((runs.filter(r => r.summary.saves === 0).length / n * 100).toFixed(0)),
  };
}
