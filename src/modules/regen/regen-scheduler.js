/**
 * Regen Scheduler — drips post-regen events at natural-looking intervals.
 *
 * Why: updating 30 published posts in one batch leaves a sitemap
 * "lastmod" cluster that looks like content-freshness manipulation to Google
 * and to ad-network reviewers. We pace the updates over weeks at random
 * hours so the public crawl signal looks like a real editor maintaining
 * the site.
 *
 * Persistence: data/sites/{site}/regen-schedule.json — survives restart.
 * Tick: every 60 seconds the server checks for due items and triggers
 * a single-post regen if no other automation is running.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { Logger } from '../../shared/utils/logger.js';
import { StateManager } from '../../shared/utils/state-manager.js';
import { RegenOrchestrator } from './regen-orchestrator.js';

const TICK_INTERVAL_MS = 60_000;            // check every 60s
const DAY_HOUR_START = 8;                   // earliest local hour for an update
const DAY_HOUR_END = 22;                    // latest local hour for an update

let _tickTimer = null;
let _ctx = null;
let _running = false;                       // prevents overlapping ticks

function schedulePath(site) {
  return join(process.cwd(), 'data', 'sites', site, 'regen-schedule.json');
}

async function loadSchedule(site) {
  const path = schedulePath(site);
  if (!existsSync(path)) {
    return { items: [], settings: {}, createdAt: null, version: 1 };
  }
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { items: [], settings: {}, createdAt: null, version: 1 };
  }
}

async function saveSchedule(site, schedule) {
  const path = schedulePath(site);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(schedule, null, 2), 'utf8');
}

/**
 * Build a natural-looking schedule from a list of post IDs.
 * Returns array of { postId, scheduledAt: ISO } sorted by time.
 *
 * Algorithm:
 *   - spread postIds across `spreadDays` calendar days
 *   - per day: between 0 and dailyMax posts (random, biased towards dailyMax/2)
 *   - per day: random hours in [DAY_HOUR_START, DAY_HOUR_END] with min 90 min gap
 *   - randomly skip ~1 in 7 days entirely so the cadence has gaps like a real editor
 */
function buildPlan(postIds, opts = {}) {
  const dailyMax = Math.max(1, Math.min(5, opts.dailyMax || 3));
  const desiredDays = opts.spreadDays || Math.ceil(postIds.length / 1.5);

  // Skip ~1 in 7 days
  const dayList = [];
  for (let d = 0; d < desiredDays * 1.3; d++) {
    if (Math.random() > 0.86) continue; // skip day
    dayList.push(d);
    if (dayList.length >= desiredDays) break;
  }
  while (dayList.length < desiredDays) dayList.push(dayList.length);

  const remainingIds = [...postIds];
  const plan = [];
  const now = new Date();
  // First update at least 4 hours from now so the post we just edited
  // (post 2914 in the user's case) doesn't sit next to a new lastmod
  const earliest = new Date(now.getTime() + 4 * 3600_000);

  let dayIdx = 0;
  while (remainingIds.length > 0 && dayIdx < dayList.length) {
    const offsetDays = dayList[dayIdx];
    const baseDate = new Date(now);
    baseDate.setDate(baseDate.getDate() + offsetDays);

    // How many posts today: 1..dailyMax, biased toward middle
    const todayCount = Math.min(
      remainingIds.length,
      1 + Math.floor(Math.random() * dailyMax)
    );

    // Pick random hours, sort, ensure 90+ min gaps
    const hours = [];
    let attempts = 0;
    while (hours.length < todayCount && attempts < 30) {
      attempts++;
      const h = DAY_HOUR_START + Math.random() * (DAY_HOUR_END - DAY_HOUR_START);
      const minGapHours = 1.5;
      if (hours.every(existing => Math.abs(existing - h) >= minGapHours)) {
        hours.push(h);
      }
    }
    hours.sort((a, b) => a - b);

    for (const hourFloat of hours) {
      if (remainingIds.length === 0) break;
      const hour = Math.floor(hourFloat);
      const minute = Math.floor((hourFloat - hour) * 60);
      // Avoid clean :00, :15, :30 minutes for a more human feel
      const minuteJitter = 3 + Math.floor(Math.random() * 55);
      const scheduledAt = new Date(baseDate);
      scheduledAt.setHours(hour, minuteJitter, Math.floor(Math.random() * 60), 0);

      // Push into the future if needed
      if (scheduledAt < earliest) {
        scheduledAt.setTime(earliest.getTime() + Math.random() * 4 * 3600_000);
      }

      const postId = remainingIds.shift();
      plan.push({ postId, scheduledAt: scheduledAt.toISOString(), status: 'pending' });
    }

    dayIdx++;
  }

  // Any remaining IDs (overflow) get placed on day = dayList[length-1]+1, +2, ...
  let overflowDay = (dayList[dayList.length - 1] || 0) + 1;
  while (remainingIds.length > 0) {
    const d = new Date(now);
    d.setDate(d.getDate() + overflowDay);
    d.setHours(DAY_HOUR_START + Math.floor(Math.random() * (DAY_HOUR_END - DAY_HOUR_START)),
               5 + Math.floor(Math.random() * 50), 0, 0);
    plan.push({ postId: remainingIds.shift(), scheduledAt: d.toISOString(), status: 'pending' });
    overflowDay++;
  }

  plan.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return plan;
}

export const RegenScheduler = {
  /** Server bootstrap: store ctx + start the tick interval */
  init(ctx) {
    _ctx = ctx;
    if (_tickTimer) return;
    _tickTimer = setInterval(() => this._tick().catch(err => {
      Logger.warn(`[RegenScheduler] tick error: ${err.message}`);
    }), TICK_INTERVAL_MS);
    Logger.info('[RegenScheduler] background tick armed (every 60s)');
  },

  stop() {
    if (_tickTimer) clearInterval(_tickTimer);
    _tickTimer = null;
  },

  /** Public: schedule a list of post IDs with natural pacing */
  async schedulePosts(postIds, opts = {}) {
    const settings = await StateManager.getSettings();
    const site = settings._activeSite || 'leagueofcooking';
    const schedule = await loadSchedule(site);

    const newItems = buildPlan(postIds, opts);
    schedule.items = [...(schedule.items || []), ...newItems];
    schedule.items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    schedule.settings = { ...(schedule.settings || {}), ...opts };
    if (!schedule.createdAt) schedule.createdAt = new Date().toISOString();
    await saveSchedule(site, schedule);

    Logger.info(`[RegenScheduler] scheduled ${newItems.length} post(s) — first at ${newItems[0]?.scheduledAt}, last at ${newItems[newItems.length - 1]?.scheduledAt}`);
    return { added: newItems.length, total: schedule.items.length, items: newItems };
  },

  /** Public: get current schedule */
  async getSchedule() {
    const settings = await StateManager.getSettings();
    const site = settings._activeSite || 'leagueofcooking';
    return loadSchedule(site);
  },

  /** Public: clear all pending items */
  async clearPending() {
    const settings = await StateManager.getSettings();
    const site = settings._activeSite || 'leagueofcooking';
    const schedule = await loadSchedule(site);
    const before = schedule.items.length;
    schedule.items = schedule.items.filter(i => i.status !== 'pending');
    await saveSchedule(site, schedule);
    return { cleared: before - schedule.items.length, remaining: schedule.items.length };
  },

  /** Background: run any due item if no other automation is active */
  async _tick() {
    if (_running) return;
    if (!_ctx) return;
    if (_ctx.automationRunning) return;

    const settings = await StateManager.getSettings();
    const site = settings._activeSite || 'leagueofcooking';
    const schedule = await loadSchedule(site);

    const now = new Date();
    const due = schedule.items.find(i =>
      i.status === 'pending' && new Date(i.scheduledAt) <= now
    );
    if (!due) return;

    _running = true;
    Logger.info(`[RegenScheduler] DUE: post ${due.postId} (was scheduled for ${due.scheduledAt})`);

    // Mark in-progress + persist before launching browser
    due.status = 'in_progress';
    due.startedAt = now.toISOString();
    await saveSchedule(site, schedule);

    try {
      // Launch browser if needed (reuse existing if open)
      if (!_ctx.browserContext) {
        let profileOverride = null;
        try {
          const { FlowAccountManager } = await import('../../shared/utils/flow-account-manager.js');
          if (await FlowAccountManager.isEnabled()) {
            const account = await FlowAccountManager.getActiveAccount();
            if (account) profileOverride = FlowAccountManager.getProfileDir(account);
          }
        } catch {}
        await _ctx.launchBrowserWithProfile(profileOverride);
      }

      // Run a single-post regen via the orchestrator's _regenOne method
      const orch = new RegenOrchestrator(null, _ctx.browserContext, _ctx);
      const result = await orch._regenOne(due.postId, settings, false /* not dry-run */);

      due.status = 'done';
      due.finishedAt = new Date().toISOString();
      due.result = { editLink: result.editLink, link: result.link };
      Logger.success(`[RegenScheduler] ✓ post ${due.postId} updated → ${result.link}`);
    } catch (err) {
      due.status = 'error';
      due.finishedAt = new Date().toISOString();
      due.error = err.message;
      Logger.error(`[RegenScheduler] ✗ post ${due.postId} failed: ${err.message}`);
    } finally {
      // Save final state
      const fresh = await loadSchedule(site);
      const slot = fresh.items.find(i => i.postId === due.postId && i.scheduledAt === due.scheduledAt);
      if (slot) {
        slot.status = due.status;
        slot.startedAt = due.startedAt;
        slot.finishedAt = due.finishedAt;
        slot.result = due.result;
        slot.error = due.error;
        await saveSchedule(site, fresh);
      }
      _running = false;
    }
  }
};
