/**
 * Planifier default configuration.
 *
 * EVERY value here is just a starting point — the user can override any of
 * them via the dashboard UI. Nothing in the runtime references these
 * constants directly; the saved config in `data/planifier.json` is the
 * source of truth. These defaults are only used to seed a fresh install.
 */

export const PLANIFIER_DEFAULTS = {
  version: 1,
  enabled: false,

  // Dolphin Anty connection — global (not per-site). Multiple sites can share
  // one Dolphin team/token, with one profile per Pinterest account.
  dolphinAnty: {
    apiToken: '',           // JWT from https://dolphin-anty.com/panel/index.html#/api
    cloudApi: 'https://dolphin-anty-api.com',
    localApi: 'http://localhost:3001',
    lastTestedAt: null,
    lastTestResult: null,   // { ok, plan, expiresInDays, profileCount, error? }
  },

  // Notifications — alerts sent on slot failures / important events
  notifications: {
    telegram: {
      enabled: false,
      botToken: '',           // from @BotFather (e.g. "1234567890:AAExxx...")
      chatId: '',             // auto-fetched from getUpdates after first /start to the bot
      notifyOnError: true,
      notifyOnSuccess: false,
    },
  },

  // Global anti-detection rules
  rules: {
    // Active window — actions only scheduled inside this range (local time)
    activeHourStart: 8,
    activeHourEnd: 22,

    // Gaps (minutes)
    minGapBetweenActions: 90,        // any two actions, all sites/accounts
    minGapInterAccount: 45,          // two accounts of the same site
    minGapIntraAccount: 120,         // same account, two sessions

    // Per-day jitter
    skipDayProbability: 0.14,        // ≈ 1 day in 7 fully skipped
    minuteJitterAtTickTime: 5,       // ± minutes added at execution

    // Anti-burst safety
    missedSlotDropAfterMinutes: 30,  // if slot > N min late at tick, mark missed
    // How stale a PREVIOUS-DAY leftover "missed" slot can be and still get
    // retried (in minutes). Only applies cross-day — a slot missed earlier
    // TODAY is always retried regardless of this value, so a crash/downtime
    // stretch during the active window doesn't permanently lose that day's
    // planned pins. Set to 0 to disable cross-day catch-up entirely.
    catchUpMaxAgeMinutes: 120,

    // Humanization
    sessionsWithoutPostPct: 18,      // % of pinterest sessions that only browse
    pinSpreadDaysFromRecipe: [0, 2, 5],  // (legacy) initial eligibility offset per pin index
    // Rolling gap (days) between consecutive pins of the SAME article. After a
    // pin is posted for an article, its next pin waits this many days. This is
    // anchored to the LAST pin actually posted (not the recipe publish date),
    // so two pins of one article are never posted close together.
    pinGapDays: 2,

    // Bulk Publish — how many DRAFT articles to auto-publish/schedule per day
    // (random count in this range each day). The rest are scheduled to later
    // days as WP `future` posts at random times within active hours.
    publishPerDayMin: 2,
    publishPerDayMax: 3,

    // Plan generation horizon
    horizonDays: 7,
    regenerateAtHour: 0,             // each night, regenerate plan for J+horizon

    // ── Browse behaviors ────────────────────────────────────────
    // What a Pinterest "browse" session looks like. Each session randomly
    // mixes these activities. Probabilities are 0-100 (rolled once per session).
    browseBehaviors: {
      // Session total length (real time, including all activities)
      sessionMinutesMin: 8,
      sessionMinutesMax: 15,

      // 1. Feed scroll on arrival (always happens — pre-action warmup)
      initialFeedScrollSecondsMin: 30,
      initialFeedScrollSecondsMax: 90,

      // 2. Click pins (closeup view)
      closeupProbability: 85,         // % chance the session does any closeup
      closeupCountMin: 1,
      closeupCountMax: 3,
      closeupLingerSecondsMin: 8,
      closeupLingerSecondsMax: 20,

      // 3. Save/re-pin after a closeup
      savePinProbability: 75,         // % chance to save a searched recipe to its category board
      maxSavesPerSession: 5,          // cap on saves per session

      // 4. Search — SEARCH-DRIVEN browsing: the session mostly searches SHEET
      //    recipes (and saves them to their category board), not just feed scroll.
      searchProbability: 60,          // % chance to do a search in the session
      searchPinClickAfterProbability: 90, // % chance to open a result pin (so we can save)
      recipeSearchShare: 92,          // % of searches that target a SHEET recipe (with category)

      // Action mix per browse beat (search dominates; scroll is secondary).
      beatWeights: { scroll: 18, closeup: 18, search: 42, video: 4, idle: 8, profile: 4, hesitate: 6 },

      // 5. Watch a video pin (only fires if one appears in feed)
      videoPlayProbability: 70,

      // 6. Visit external (clicks "Visit" → opens blog URL)
      visitExternalProbability: 12,   // per closeup

      // 7. Glance at own profile
      profileGlanceProbability: 15,

      // Final feed scroll before close
      finalFeedScrollSecondsMin: 30,
      finalFeedScrollSecondsMax: 60,
    },
  },

  // Per-site configuration. New sites can be added at runtime.
  // The keys must match site names in `data/sites/{siteName}/`.
  sites: {
    // sample structure — seeded for any new site
    _template: {
      enabled: true,
      recipesPerDayMin: 2,
      recipesPerDayMax: 2,
      pinDistribution: 'strategy_A',  // 'strategy_A' | 'strategy_B' | 'strategy_C'

      // Sheet tab override — which tab in the Google Sheet the Planifier
      // reads pin data + recipe rows from. If empty, falls back to the
      // site's settings.sheetTabName (default). Useful when the site has
      // multiple tabs (Gen / Scraper / etc.) and you want the Planifier
      // to read from a specific one.
      sheetTab: '',

      // Niche-specific search terms used during browse sessions.
      // The browse executor picks 1 random keyword from:
      //   (recipe titles from sheet if useRecipeNamesAsKeywords=true)
      //   + this manual list
      useRecipeNamesAsKeywords: true,
      recipeNamesSampleSize: 30,  // # of most-recent recipe titles to mix in
      searchKeywords: [
        'easy dinner ideas', 'quick weeknight meals', 'comfort food recipes',
        'one pan dinner', '30 minute meals', 'healthy lunch ideas',
        'meal prep ideas', 'crockpot recipes', 'easy pasta recipe',
        'baked chicken recipe', 'family dinner ideas', 'budget meals',
        'kid friendly dinner', 'low carb dinner', 'air fryer recipes',
      ],

      pinterestAccounts: [
        {
          id: 'acc1',
          dolphinProfileId: null,
          status: 'active',           // 'active' | 'warmup_week_1' | 'warmup_week_2' | 'warmup_week_3' | 'disabled'
          createdAt: null,            // ISO date — when this account was added to the system. Drives auto-progression.
          autoProgress: true,         // if true, daily tick promotes W1→W2→W3→active based on age
          pinsPerDayMin: 2,
          pinsPerDayMax: 3,
          boards: [],                 // string[] of board names (Pinterest picks first matching)
          categoryBoardMap: {},        // { [wpCategory]: pinterestBoardName } manual override
        },
        {
          id: 'acc2',
          dolphinProfileId: null,
          status: 'disabled',
          createdAt: null,
          autoProgress: false,
          pinsPerDayMin: 0,
          pinsPerDayMax: 0,
          boards: [],
          categoryBoardMap: {},
        },
      ],
    },
  },
};

/**
 * Account status tiers — drive what the planifier allows the account to do.
 *
 * Aligned with 2026 Pinterest warmup consensus (multiple sources, see brainstorm):
 *   W1 (days 0-7):   browse only, 0 pins. Build human-like activity baseline.
 *   W2 (days 7-14):  1 pin/day max (0.3 multiplier on 2-3 baseline ≈ 1).
 *   W3 (days 14-28): 2 pins/day (0.6 multiplier ≈ 2).
 *   Active (28+):    full rate (multiplier 1.0 = 2-3 pins/day).
 *
 * Auto-progression by daily tick when account.autoProgress === true.
 */
export const ACCOUNT_STATUSES = {
  disabled:        { label: 'Disabled',     canPost: false, browseOnly: false, pinMultiplier: 0 },
  warmup_week_1:   { label: 'Warmup W1',    canPost: false, browseOnly: true,  pinMultiplier: 0 },
  warmup_week_2:   { label: 'Warmup W2',    canPost: true,  browseOnly: false, pinMultiplier: 0.3 },
  warmup_week_3:   { label: 'Warmup W3',    canPost: true,  browseOnly: false, pinMultiplier: 0.6 },
  active:          { label: 'Active',       canPost: true,  browseOnly: false, pinMultiplier: 1.0 },
};

/**
 * Days-since-creation thresholds for auto-progression. An account at status X
 * is promoted when daysSince(createdAt) >= NEXT_TIER_AT_DAYS[X].
 */
export const PROGRESSION_THRESHOLDS_DAYS = {
  warmup_week_1: 7,    // W1 → W2 at day 7
  warmup_week_2: 14,   // W2 → W3 at day 14
  warmup_week_3: 28,   // W3 → active at day 28
};

export const NEXT_STATUS = {
  warmup_week_1: 'warmup_week_2',
  warmup_week_2: 'warmup_week_3',
  warmup_week_3: 'active',
};

export const PIN_DISTRIBUTION_STRATEGIES = {
  strategy_A: 'Sealed accounts (Recommended)',
  strategy_B: 'Pin-level split between accounts',
  strategy_C: 'Full duplication across accounts (Risky)',
};

export const ACTION_TYPES = {
  CREATE_RECIPE: 'create-recipe',
  PINTEREST_SESSION: 'pinterest-session',
  WARMING_SESSION: 'warming-session',
};

export const ITEM_STATUSES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  ERROR: 'error',
  MISSED: 'missed',
  SKIPPED: 'skipped',
};
