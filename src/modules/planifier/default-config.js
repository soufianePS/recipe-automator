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

    // Humanization
    sessionsWithoutPostPct: 18,      // % of pinterest sessions that only browse
    pinSpreadDaysFromRecipe: [0, 2, 5],  // pin #1 same day, #2 +2d, #3 +5d (±12h jitter)

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
      savePinProbability: 40,         // % chance per closeup

      // 4. Search keywords
      searchProbability: 60,          // % chance to do a search in the session
      searchPinClickAfterProbability: 60, // % chance to closeup a result pin

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
          status: 'active',           // 'active' | 'warmup_week_1' | 'warmup_week_2' | 'disabled'
          pinsPerDayMin: 2,
          pinsPerDayMax: 3,
          boards: [],                 // string[] of board names (Pinterest picks first matching)
        },
        {
          id: 'acc2',
          dolphinProfileId: null,
          status: 'disabled',
          pinsPerDayMin: 0,
          pinsPerDayMax: 0,
          boards: [],
        },
      ],
    },
  },
};

export const ACCOUNT_STATUSES = {
  disabled:        { label: 'Disabled',     canPost: false, browseOnly: false, pinMultiplier: 0 },
  warmup_week_1:   { label: 'Warmup W1',    canPost: false, browseOnly: true,  pinMultiplier: 0 },
  warmup_week_2:   { label: 'Warmup W2',    canPost: true,  browseOnly: false, pinMultiplier: 0.4 },
  active:          { label: 'Active',       canPost: true,  browseOnly: false, pinMultiplier: 1.0 },
};

export const PIN_DISTRIBUTION_STRATEGIES = {
  strategy_A: 'Sealed accounts (Recommended)',
  strategy_B: 'Pin-level split between accounts',
  strategy_C: 'Full duplication across accounts (Risky)',
};

export const ACTION_TYPES = {
  CREATE_RECIPE: 'create-recipe',
  PINTEREST_SESSION: 'pinterest-session',
};

export const ITEM_STATUSES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
  ERROR: 'error',
  MISSED: 'missed',
  SKIPPED: 'skipped',
};
