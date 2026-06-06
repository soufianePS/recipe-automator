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
 * Gap-relaxation ladder. When the remaining active window is too tight to
 * place an action at the configured gaps (e.g. a late-day regenerate), we
 * retry with progressively smaller gaps so the action still lands TODAY
 * rather than being silently dropped. Floors keep actions from bunching up
 * to a detectable degree.
 */
const RELAX_STEPS = [1.0, 0.66, 0.4];
const GAP_FLOORS = { minGapBetweenActions: 25, minGapInterAccount: 15, minGapIntraAccount: 35 };

function relaxRules(rules, factor) {
  if (factor === 1.0) return rules;
  return {
    ...rules,
    minGapBetweenActions: Math.max(GAP_FLOORS.minGapBetweenActions, Math.round(rules.minGapBetweenActions * factor)),
    minGapInterAccount: Math.max(GAP_FLOORS.minGapInterAccount, Math.round(rules.minGapInterAccount * factor)),
    minGapIntraAccount: Math.max(GAP_FLOORS.minGapIntraAccount, Math.round(rules.minGapIntraAccount * factor)),
  };
}

/**
 * Try to place one action today, relaxing gaps step by step if needed.
 * Returns { slot, relaxed } or null if it can't fit even at the floor gaps
 * (caller should overflow it to the next day).
 */
function allocate(dateStr, rules, candidate, items) {
  for (const factor of RELAX_STEPS) {
    const slot = findSlot(dateStr, relaxRules(rules, factor), candidate, items);
    if (slot) return { slot, relaxed: factor !== 1.0 };
  }
  return null;
}

/**
 * Round-robin two lists so neither category monopolizes the early slots.
 * Without this, recipes (allocated first) would claim every slot in a tight
 * window and Pinterest sessions would always be the ones dropped.
 */
function interleave(a, b) {
  const out = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

/**
 * Turn a placed proto + slot into a real plan item.
 */
function protoToItem(proto, slot, relaxed) {
  const item = {
    id: randomUUID(),
    type: proto.type,
    site: proto.site,
    accountId: proto.accountId || null,
    scheduledAt: slot,
    status: ITEM_STATUSES.PENDING,
  };
  if (proto.dolphinProfileId !== undefined) item.dolphinProfileId = proto.dolphinProfileId;
  if (proto.type === ACTION_TYPES.CREATE_RECIPE) item.willPost = false;
  if (proto.type === ACTION_TYPES.PINTEREST_SESSION) {
    item.willPost = !!proto.willPost;
    item.browseOnly = !!proto.browseOnly;
  }
  if (relaxed) item.relaxedGap = true;
  if (proto.overflowFrom) item.overflowFrom = proto.overflowFrom;
  return item;
}

/**
 * Allocate a batch of protos into `items` (mutated in place). Each proto that
 * fits becomes a real item; ones that can't fit even at floor gaps are
 * returned in `overflow` so the caller can cascade them to the next day.
 *
 * Exported so regeneratePlan can append a previous day's overflow onto an
 * existing plan using the exact same slotting logic.
 */
export function appendProtoItems(dateStr, rules, items, protos) {
  const overflow = [];
  let relaxedCount = 0;
  for (const proto of protos) {
    const candidate = { site: proto.site, accountId: proto.accountId || null };
    const res = allocate(dateStr, rules, candidate, items);
    if (!res) { overflow.push(proto); continue; }
    if (res.relaxed) relaxedCount++;
    items.push(protoToItem(proto, res.slot, res.relaxed));
  }
  return { overflow, relaxedCount };
}

/**
 * Remaining active window for a date, in minutes-from-midnight.
 * For TODAY the lower bound is floored to now+5min (can't schedule the past).
 */
function remainingWindow(dateStr, rules) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const now = new Date();
  const isToday = now.getFullYear() === year && (now.getMonth() + 1) === month && now.getDate() === day;
  let loMin = rules.activeHourStart * 60;
  const hiMin = rules.activeHourEnd * 60;
  if (isToday) {
    const f = new Date(now.getTime() + 5 * 60000);
    const fm = f.getHours() * 60 + f.getMinutes();
    if (fm > loMin) loMin = fm;
  }
  return { loMin, hiMin };
}

function minToIso(dateStr, posMin) {
  const [year, month, day] = dateStr.split('-').map(Number);
  let p = Math.max(0, Math.min(1439, Math.round(posMin)));
  const hour = Math.floor(p / 60);
  const minute = p % 60;
  const seconds = randInt(0, 59);
  return new Date(year, month - 1, day, hour, minute, seconds).toISOString();
}

/**
 * Place EVERY proto today — never drop, never overflow. This honours the
 * configured volume exactly when the user clicks Regenerate.
 *
 * Strategy:
 *   - If the window comfortably holds all actions at the configured gap, use
 *     the normal random gap-respecting placement (most natural spacing).
 *   - Otherwise the configured gap can't fit everything, so spread the actions
 *     EVENLY across the remaining window (gaps shrink just enough to fit). If
 *     the window is so small that even a small floor gap won't fit, the window
 *     is extended past the active-hour end as a last resort — the point is the
 *     full configured set still lands today.
 *
 * Returns { compressed } — how many items were placed with sub-configured gaps.
 */
function fitAllPlace(dateStr, rules, items, protos) {
  const n = protos.length;
  if (n === 0) return { compressed: 0 };

  const { loMin, hiMin } = remainingWindow(dateStr, rules);
  const FLOOR_GAP = 8;  // absolute minimum spacing (minutes) when compressing
  let endMin = hiMin;
  let span = endMin - loMin;
  // Last-resort: extend past active-hour end so the full set still fits today.
  if (span < (n - 1) * FLOOR_GAP) {
    endMin = Math.min(1439, loMin + (n - 1) * FLOOR_GAP);
    span = endMin - loMin;
  }
  const evenGap = n > 1 ? span / (n - 1) : span;

  // Enough room for natural, gap-respecting random placement.
  if (evenGap >= rules.minGapBetweenActions) {
    const { overflow, relaxedCount } = appendProtoItems(dateStr, rules, items, protos);
    if (overflow.length === 0) return { compressed: relaxedCount };
    // Shouldn't happen given the room check, but never drop: even-place leftovers.
    protos = overflow;
  }

  // Compressed even spread: position i at loMin + i*evenGap (+ jitter), in order.
  const gap = n > 1 ? span / (n - 1) : 0;
  let compressed = 0;
  for (let i = 0; i < protos.length; i++) {
    const base = loMin + i * gap;
    const jit = (Math.random() - 0.5) * gap * 0.35;
    const posMin = Math.max(loMin, Math.min(endMin, base + jit));
    items.push(protoToItem(protos[i], minToIso(dateStr, posMin), true));
    compressed++;
  }
  return { compressed };
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

  // Day-level skip — entire day off?
  const globalSkip = !options.forceNoSkip && Math.random() < (rules.skipDayProbability || 0);

  // ── Phase 1: collect "what we want to do today" as protos (no slots yet).
  // Recipes and Pinterest/warming sessions are gathered separately so we can
  // interleave them — otherwise recipes (allocated first) grab every slot in a
  // tight window and Pinterest is always the category that gets dropped.
  const recipeProtos = [];
  const sessionProtos = [];

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
      recipeProtos.push({ type: ACTION_TYPES.CREATE_RECIPE, site: siteName, accountId: null });
    }

    // Detect warming mode for this site. When sites-config has
    // warming_enabled === TRUE for this site, we emit warming-session protos
    // instead of pinterest-session ones. Warming sites still create recipes
    // normally; the difference is only in the Pinterest action behavior.
    const warmingEnabled = !!(siteCfg.warming_enabled || siteCfg.warmingEnabled);

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

      for (let i = 0; i < sessionTarget; i++) {
        if (warmingEnabled) {
          // Warming session: extended browse + saves to "I Like It" + 1
          // warming pin (no outbound link). No willPost concept — the warming
          // pin is the only thing posted (from warming-pin-list).
          sessionProtos.push({
            type: ACTION_TYPES.WARMING_SESSION,
            site: siteName,
            accountId: account.id,
            dolphinProfileId: account.dolphinProfileId || null,
          });
          continue;
        }

        // Normal pinterest-session — roll willPost now so it survives overflow.
        const willPost = statusCfg.canPost
          && (Math.random() * 100) >= (rules.sessionsWithoutPostPct || 0);

        sessionProtos.push({
          type: ACTION_TYPES.PINTEREST_SESSION,
          site: siteName,
          accountId: account.id,
          dolphinProfileId: account.dolphinProfileId || null,
          willPost: !!willPost,
          browseOnly: statusCfg.browseOnly,
        });
      }
    }
  }

  // ── Phase 2: interleave + place EVERYTHING. fitAllPlace honours the full
  // configured volume — it spreads actions across the remaining window with
  // the largest gaps that still fit (shrinking below the configured gap only
  // when there are too many actions for the window). Nothing is dropped or
  // pushed to another day: clicking Regenerate gives exactly what's configured.
  const ordered = interleave(recipeProtos, sessionProtos);
  const items = [];
  const { compressed } = fitAllPlace(dateStr, rules, items, ordered);

  items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));

  const summary = summarize(items, config);
  summary.compressed = compressed;  // # placed with sub-configured gaps

  return {
    date: dateStr,
    generatedAt: new Date().toISOString(),
    globalSkip,
    items,
    compressed,
    summary,
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
    warmingSessions: 0,
    bySite: {},
    byAccount: {},
  };

  for (const item of items) {
    if (item.type === ACTION_TYPES.CREATE_RECIPE) out.recipes++;
    if (item.type === ACTION_TYPES.WARMING_SESSION) out.warmingSessions++;
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
