/**
 * Day plan builder.
 *
 * Given the planifier config + a target date, produces a list of scheduled
 * items (recipe creations + Pinterest sessions) for that day, with realistic
 * timing that respects all gaps and active-hour windows.
 *
 * The builder is PURE — it doesn't read settings or persist anything. The
 * caller passes config + date, gets back items. This makes it trivial to
 * preview ("show me J+3 without committing").
 */

import { randomUUID } from 'crypto';
import { ACTION_TYPES, ITEM_STATUSES, ACCOUNT_STATUSES } from './default-config.js';

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

/**
 * Decide today's "volume profile" — biased to mid-range so we don't always
 * hit the max.
 */
function rollCount(min, max) {
  if (min === max) return min;
  // Triangular-ish bias: pick uniformly twice and take the average rounded
  const a = randInt(min, max);
  const b = randInt(min, max);
  return Math.round((a + b) / 2);
}

/**
 * Roll a random time inside [activeHourStart, activeHourEnd) for a date.
 * Returns an ISO string. Minute is jittered off "round" values (:00,:15,:30).
 *
 * IMPORTANT: when the target date is TODAY, the effective lower bound is
 * `max(activeHourStart, currentHour + 5min)` — otherwise a regen at 21:00
 * would create items scheduled for 8:00-21:00 (all in the past), which the
 * executor tick would immediately mark as `missed` (drop-after-30min rule).
 * Returns null if today is already past activeHourEnd (no future slots left).
 */
function rollTime(dateStr, rules) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const now = new Date();
  const isToday = now.getFullYear() === year && (now.getMonth() + 1) === month && now.getDate() === day;

  let lowerHour = rules.activeHourStart;
  let lowerMinute = 0;
  if (isToday) {
    // Use current local time + 5min buffer as the floor
    const futureFloor = new Date(now.getTime() + 5 * 60000);
    const fH = futureFloor.getHours();
    const fM = futureFloor.getMinutes();
    if (fH >= rules.activeHourEnd) return null;  // no active hours left today
    if (fH > lowerHour || (fH === lowerHour && fM > lowerMinute)) {
      lowerHour = fH;
      lowerMinute = fM;
    }
  }

  // Range in MINUTES from lowerHour:lowerMinute to activeHourEnd:00
  const lowerMin = lowerHour * 60 + lowerMinute;
  const upperMin = rules.activeHourEnd * 60;
  if (upperMin <= lowerMin) return null;
  const pickedMin = lowerMin + Math.floor(Math.random() * (upperMin - lowerMin));
  const hour = Math.floor(pickedMin / 60);
  let minute = pickedMin % 60;
  // Bias minutes away from round numbers
  if ([0, 15, 30, 45].includes(minute)) minute += randInt(2, 8);
  if (minute >= 60) minute = 59;
  const seconds = randInt(0, 59);
  const d = new Date(year, month - 1, day, hour, minute, seconds);
  return d.toISOString();
}

/**
 * Check if a candidate time respects all gap rules given existing items.
 *
 * Rules:
 *   - minGapBetweenActions (any two actions, anywhere)
 *   - minGapInterAccount (two accounts of same site, same day)
 *   - minGapIntraAccount (same account, two sessions)
 */
function passesGaps(candidateIso, candidate, items, rules) {
  const cand = new Date(candidateIso).getTime();

  for (const existing of items) {
    const ex = new Date(existing.scheduledAt).getTime();
    const gapMin = Math.abs(cand - ex) / 60000;

    if (gapMin < rules.minGapBetweenActions) return false;

    if (candidate.site && existing.site && candidate.site === existing.site
        && candidate.accountId && existing.accountId
        && candidate.accountId !== existing.accountId) {
      if (gapMin < rules.minGapInterAccount) return false;
    }

    if (candidate.accountId && existing.accountId && candidate.accountId === existing.accountId) {
      if (gapMin < rules.minGapIntraAccount) return false;
    }
  }
  return true;
}

/**
 * Roll time with backoff: try up to 30 times to find a slot that respects
 * all gaps. If none found, returns null (caller should drop this action).
 */
function findSlot(dateStr, rules, candidate, items, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const iso = rollTime(dateStr, rules);
    if (!iso) return null;  // today already past activeHourEnd — no slot possible
    if (passesGaps(iso, candidate, items, rules)) return iso;
  }
  return null;
}

/**
 * Main entry: build the day plan.
 *
 * @param {string} dateStr — 'YYYY-MM-DD'
 * @param {object} config — full planifier config (see plan-storage.loadConfig)
 * @param {object} [options]
 * @param {boolean} [options.forceNoSkip=false] — ignore skip-day probability
 * @returns {object} plan = { date, generatedAt, items: [...] }
 */
export function buildDayPlan(dateStr, config, options = {}) {
  const rules = config.rules;
  const items = [];

  // Day-level skip — entire day off?
  const globalSkip = !options.forceNoSkip && Math.random() < (rules.skipDayProbability || 0);

  for (const [siteName, siteCfg] of Object.entries(config.sites || {})) {
    if (!siteCfg.enabled) continue;
    if (siteName.startsWith('_')) continue;  // skip _template

    // Per-site skip: only one of the sites should skip per global-skip day
    // (avoid all sites being silent simultaneously)
    const siteShouldSkip = globalSkip && Math.random() < 0.5;
    if (siteShouldSkip) continue;

    // ── Recipes
    const recipeCount = rollCount(siteCfg.recipesPerDayMin || 0, siteCfg.recipesPerDayMax || 0);
    for (let i = 0; i < recipeCount; i++) {
      const candidate = { site: siteName, accountId: null };
      const slot = findSlot(dateStr, rules, candidate, items);
      if (!slot) break;
      items.push({
        id: randomUUID(),
        type: ACTION_TYPES.CREATE_RECIPE,
        site: siteName,
        accountId: null,
        scheduledAt: slot,
        status: ITEM_STATUSES.PENDING,
        willPost: false,
      });
    }

    // ── Pinterest sessions per account
    for (const account of siteCfg.pinterestAccounts || []) {
      const statusCfg = ACCOUNT_STATUSES[account.status] || ACCOUNT_STATUSES.disabled;
      if (statusCfg.pinMultiplier === 0 && !statusCfg.browseOnly) continue;

      const baseMin = account.pinsPerDayMin || 0;
      const baseMax = account.pinsPerDayMax || 0;
      const sessionTarget = Math.max(
        statusCfg.browseOnly ? 1 : Math.ceil(baseMin * statusCfg.pinMultiplier),
        rollCount(
          Math.ceil(baseMin * statusCfg.pinMultiplier),
          Math.ceil(baseMax * statusCfg.pinMultiplier)
        )
      );

      // Detect warming mode for this site. When sites-config has
      // warming_enabled === TRUE for this site, we emit warming-session items
      // instead of pinterest-session ones. Warming sites still create recipes
      // normally; the difference is only in the Pinterest action behavior.
      const warmingEnabled = !!(siteCfg.warming_enabled || siteCfg.warmingEnabled);

      for (let i = 0; i < sessionTarget; i++) {
        const candidate = { site: siteName, accountId: account.id };
        const slot = findSlot(dateStr, rules, candidate, items);
        if (!slot) break;

        if (warmingEnabled) {
          // Warming session: extended browse + saves to "I Like It" + 1
          // warming pin (no outbound link). No willPost concept — the warming
          // pin is the only thing posted (from warming-pin-list).
          items.push({
            id: randomUUID(),
            type: ACTION_TYPES.WARMING_SESSION,
            site: siteName,
            accountId: account.id,
            dolphinProfileId: account.dolphinProfileId || null,
            scheduledAt: slot,
            status: ITEM_STATUSES.PENDING,
          });
          continue;
        }

        // Normal pinterest-session
        const willPost = statusCfg.canPost
          && (Math.random() * 100) >= (rules.sessionsWithoutPostPct || 0);

        items.push({
          id: randomUUID(),
          type: ACTION_TYPES.PINTEREST_SESSION,
          site: siteName,
          accountId: account.id,
          dolphinProfileId: account.dolphinProfileId || null,
          scheduledAt: slot,
          status: ITEM_STATUSES.PENDING,
          willPost: !!willPost,
          browseOnly: statusCfg.browseOnly,
        });
      }
    }
  }

  items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  return {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    globalSkip,
    items,
    summary: summarize(items, config),
  };
}

/**
 * Build summary stats for a plan (used by the dashboard preview).
 */
export function summarize(items, config) {
  const out = {
    totalActions: items.length,
    recipes: 0,
    pinterestSessions: 0,
    pinterestPosts: 0,
    pinterestBrowseOnly: 0,
    bySite: {},
    byAccount: {},
  };

  for (const item of items) {
    if (item.type === ACTION_TYPES.CREATE_RECIPE) out.recipes++;
    if (item.type === ACTION_TYPES.PINTEREST_SESSION) {
      out.pinterestSessions++;
      if (item.willPost) out.pinterestPosts++;
      else out.pinterestBrowseOnly++;
    }
    out.bySite[item.site] = out.bySite[item.site] || { recipes: 0, sessions: 0, posts: 0 };
    if (item.type === ACTION_TYPES.CREATE_RECIPE) out.bySite[item.site].recipes++;
    if (item.type === ACTION_TYPES.PINTEREST_SESSION) {
      out.bySite[item.site].sessions++;
      if (item.willPost) out.bySite[item.site].posts++;
    }
    if (item.accountId) {
      const key = `${item.site}/${item.accountId}`;
      out.byAccount[key] = out.byAccount[key] || { sessions: 0, posts: 0 };
      out.byAccount[key].sessions++;
      if (item.willPost) out.byAccount[key].posts++;
    }
  }
  return out;
}
