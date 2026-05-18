/**
 * Browse session simulator.
 *
 * Pure function that produces a step-by-step preview of what a single
 * "browse" Pinterest session would look like with the current config —
 * without launching any browser. Used by the dashboard "Preview Session"
 * button so the user can iterate on probabilities and see the resulting
 * cadence before any code actually runs.
 *
 * The Phase 3 executor will replay the same probability rolls inside
 * Playwright on a real Pinterest tab, so what you preview is what
 * actually runs.
 */

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

const ACTIONS = {
  OPEN: 'open',
  CLOSE: 'close',
  SCROLL: 'scroll',
  CLOSEUP: 'closeup',
  SAVE: 'save',
  SEARCH: 'search',
  VIDEO: 'video',
  VISIT: 'visit',
  PROFILE: 'profile',
  BACK: 'back',
  WAIT: 'wait',
};

/**
 * Generate a "scroll burst" — N consecutive scrolls with realistic pauses.
 * Returns [{ deltaSec, pixels }].
 */
function scrollBurst(totalSeconds) {
  const out = [];
  let elapsed = 0;
  while (elapsed < totalSeconds) {
    const pixels = Math.round(rand(300, 800));
    const pause = rand(1.5, 4);
    out.push({ deltaSec: pause, pixels });
    elapsed += pause;
  }
  return out;
}

/**
 * Build a list of events.
 *
 * @param {object} config — full planifier config (rules.browseBehaviors used)
 * @param {string} siteName — site whose searchKeywords/boards are used
 * @param {object} [override] — optional override for browseBehaviors
 * @param {string[]} [recipeTitles] — optional list of recipe titles to mix into the keyword pool
 * @returns {{events: Array, durationSeconds: number, summary: object}}
 */
export function simulateSession(config, siteName, override = {}, recipeTitles = []) {
  const bb = { ...(config.rules?.browseBehaviors || {}), ...override };
  const site = config.sites?.[siteName] || {};
  const manualKeywords = site.searchKeywords || [];
  // Merge keyword sources: manual + (optional) recipe names from sheet
  let keywords = [...manualKeywords];
  if (site.useRecipeNamesAsKeywords && recipeTitles.length > 0) {
    const sampleSize = Math.min(site.recipeNamesSampleSize || 30, recipeTitles.length);
    // Pick most-recent N titles, plus shuffle so picking via random index doesn't always hit the same ones
    const sampled = recipeTitles.slice(0, sampleSize);
    keywords = [...keywords, ...sampled];
  }
  // Boards from the FIRST active account (in a real run, the executor knows which acc)
  const account = (site.pinterestAccounts || []).find(a => a.status === 'active' || a.status === 'warmup_week_2');
  const boards = account?.boards || [];

  const events = [];
  let t = 0;
  const counters = { closeups: 0, saves: 0, searches: 0, videos: 0, visits: 0, profileGlances: 0, scrollBursts: 0 };

  const push = (action, detail, extra = {}) => {
    events.push({ t: Number(t.toFixed(1)), action, detail, ...extra });
  };

  // Target session length (informational — we may exit early if no activities consume time)
  const targetMinutes = rand(bb.sessionMinutesMin || 8, bb.sessionMinutesMax || 15);

  // 1. Open
  push(ACTIONS.OPEN, 'Navigate to pinterest.com (Dolphin profile + proxy)');
  t += rand(3, 7);
  push(ACTIONS.WAIT, 'Wait for feed to load');
  t += rand(2, 4);

  // 2. Initial feed scroll
  {
    const total = rand(bb.initialFeedScrollSecondsMin || 30, bb.initialFeedScrollSecondsMax || 90);
    counters.scrollBursts++;
    push(ACTIONS.SCROLL, `Feed scroll (~${Math.round(total)}s, ${Math.ceil(total/3)} wave(s))`);
    t += total;
  }

  // 3. Closeups (multiple pins)
  if (Math.random() * 100 < (bb.closeupProbability || 0)) {
    const count = randInt(bb.closeupCountMin || 1, bb.closeupCountMax || 3);
    for (let i = 0; i < count; i++) {
      counters.closeups++;
      push(ACTIONS.CLOSEUP, `Click pin #${i + 1} in feed → detail view`);
      const lingerSec = rand(bb.closeupLingerSecondsMin || 8, bb.closeupLingerSecondsMax || 20);
      t += lingerSec;
      push(ACTIONS.WAIT, `Linger ~${Math.round(lingerSec)}s reading description + comments`);

      // Save? (each closeup is a separate roll)
      if (Math.random() * 100 < (bb.savePinProbability || 0) && boards.length > 0) {
        counters.saves++;
        const board = pick(boards);
        push(ACTIONS.SAVE, `Re-pin → board "${board}"`);
        t += rand(4, 8);
      }

      // Visit external? (each closeup, low prob)
      if (Math.random() * 100 < (bb.visitExternalProbability || 0)) {
        counters.visits++;
        push(ACTIONS.VISIT, `Click "Visit" → external blog (new tab)`);
        const lingerExt = rand(5, 15);
        t += lingerExt;
        push(ACTIONS.WAIT, `Linger ~${Math.round(lingerExt)}s on blog page`);
      }

      push(ACTIONS.BACK, 'Back to feed');
      t += rand(2, 4);

      // Short scroll between closeups (not for the last one)
      if (i < count - 1) {
        counters.scrollBursts++;
        const interSec = rand(8, 18);
        push(ACTIONS.SCROLL, `Scroll feed ${Math.round(interSec)}s before next pin`);
        t += interSec;
      }
    }
  }

  // 4. Search
  if (Math.random() * 100 < (bb.searchProbability || 0) && keywords.length > 0) {
    counters.searches++;
    const kw = pick(keywords);
    push(ACTIONS.SEARCH, `Type search: "${kw}"`);
    t += rand(8, 14);  // typing + Enter + results load

    const resultScroll = rand(20, 45);
    counters.scrollBursts++;
    push(ACTIONS.SCROLL, `Scroll search results ~${Math.round(resultScroll)}s`);
    t += resultScroll;

    if (Math.random() * 100 < (bb.searchPinClickAfterProbability || 0)) {
      counters.closeups++;
      push(ACTIONS.CLOSEUP, 'Click result pin → detail view');
      t += rand(8, 15);
      // Maybe save from search too
      if (Math.random() * 100 < (bb.savePinProbability || 0) * 0.5 && boards.length > 0) {
        counters.saves++;
        push(ACTIONS.SAVE, `Re-pin search result → board "${pick(boards)}"`);
        t += rand(4, 8);
      }
      push(ACTIONS.BACK, 'Back to search results');
      t += rand(2, 3);
    }
  }

  // 5. Video pin
  if (Math.random() * 100 < (bb.videoPlayProbability || 0)) {
    counters.videos++;
    const playSec = rand(5, 15);
    push(ACTIONS.VIDEO, `Video pin auto-plays in feed (~${Math.round(playSec)}s view)`);
    t += playSec;
  }

  // 6. Profile glance
  if (Math.random() * 100 < (bb.profileGlanceProbability || 0)) {
    counters.profileGlances++;
    push(ACTIONS.PROFILE, 'Navigate to own profile → view boards');
    t += rand(15, 25);
    push(ACTIONS.BACK, 'Back to home feed');
    t += rand(2, 4);
  }

  // 7. Final feed scroll
  {
    const total = rand(bb.finalFeedScrollSecondsMin || 30, bb.finalFeedScrollSecondsMax || 60);
    counters.scrollBursts++;
    push(ACTIONS.SCROLL, `Final feed scroll ~${Math.round(total)}s`);
    t += total;
  }

  // 8. Close
  push(ACTIONS.CLOSE, 'Close browser (session complete)');

  return {
    events,
    durationSeconds: Math.round(t),
    durationMinutes: Number((t / 60).toFixed(1)),
    targetMinutes: Number(targetMinutes.toFixed(1)),
    summary: counters,
    siteName,
    keywordsCount: keywords.length,
    manualKeywordsCount: manualKeywords.length,
    recipeKeywordsCount: keywords.length - manualKeywords.length,
    boardsCount: boards.length,
    activityRatio: {
      // How "human-density" looks vs a bot baseline (1.0 = average human)
      saveToCloseupRatio: counters.closeups > 0 ? Number((counters.saves / counters.closeups).toFixed(2)) : 0,
    },
  };
}

/**
 * Run N independent simulations and aggregate stats — useful for "average
 * session look" without running once and getting a freak outlier.
 */
export function simulateMany(config, siteName, n = 50, override = {}, recipeTitles = []) {
  const runs = [];
  for (let i = 0; i < n; i++) {
    runs.push(simulateSession(config, siteName, override, recipeTitles));
  }
  const avg = (key) => Number((runs.reduce((s, r) => s + (r.summary[key] || 0), 0) / n).toFixed(2));
  const avgDuration = Number((runs.reduce((s, r) => s + r.durationSeconds, 0) / n / 60).toFixed(1));
  return {
    runs: n,
    avgDurationMinutes: avgDuration,
    avgCloseups: avg('closeups'),
    avgSaves: avg('saves'),
    avgSearches: avg('searches'),
    avgVideos: avg('videos'),
    avgVisits: avg('visits'),
    avgProfileGlances: avg('profileGlances'),
    minDuration: Math.round(Math.min(...runs.map(r => r.durationSeconds)) / 60 * 10) / 10,
    maxDuration: Math.round(Math.max(...runs.map(r => r.durationSeconds)) / 60 * 10) / 10,
  };
}
