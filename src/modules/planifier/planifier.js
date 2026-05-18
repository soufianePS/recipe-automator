/**
 * Planifier service (Phase 1: planning + observability only).
 *
 * In this phase the service:
 *   - regenerates the multi-day plan on demand
 *   - exposes config + plans + history to the dashboard
 *   - does NOT execute anything yet
 *
 * Phase 2+ will add a tick loop that picks due items and runs them.
 */

import { buildDayPlan } from './day-plan-builder.js';
import {
  loadConfig, saveConfig, ensureSiteConfig,
  loadPlan, savePlan, listPlanDates, deletePlan,
  loadHistory, appendHistory, clearHistory,
} from './plan-storage.js';
import { readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../shared/utils/logger.js';

let _weeklyTickTimer = null;
let _executorTickTimer = null;
let _serverCtx = null;
let _executorRunning = false;   // re-entrancy guard for the executor tick itself
const WEEKLY_TICK_INTERVAL_MS = 30 * 60 * 1000;  // check twice per hour
const EXECUTOR_TICK_INTERVAL_MS = 60 * 1000;     // check every minute

/**
 * ISO week key — "YYYY-Wnn". Two timestamps in the same ISO week share this
 * key, so we use it to detect "did we already regen this week".
 */
function isoWeekKey(d = new Date()) {
  const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(__dirname, '..', '..', '..', 'data', 'sites');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Discover sites by reading data/sites/* directories.
 * Returns array of site names.
 */
async function discoverSites() {
  if (!existsSync(SITES_DIR)) return [];
  const entries = await readdir(SITES_DIR, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => e.name);
}

/**
 * Background tick: pick the next due plan item and run it.
 *
 * Guards (in order, all required):
 *   1. Master switch enabled
 *   2. No other automation running (serverCtx.automationRunning false)
 *   3. No previous executor tick still running (re-entrancy)
 *   4. Found a pending item with scheduledAt <= now
 *   5. Item not more than missedSlotDropAfterMinutes late (else mark missed)
 *
 * Items "outside the active hour window" still fire if pending and due — the
 * window only affects PLANNING, not execution. Once an item is in the plan,
 * we honor its scheduledAt.
 */
async function executorTick() {
  if (_executorRunning) return;
  if (!_serverCtx) return;
  if (_serverCtx.automationRunning) return;

  try {
    const config = await loadConfig();
    if (!config.enabled) return;

    const todayDate = todayKey();
    // Look at today + yesterday (in case the tick fires shortly after midnight
    // and yesterday has a pending item that was due just before midnight).
    const dates = [addDays(todayDate, -1), todayDate];
    const dropAfterMin = config.rules?.missedSlotDropAfterMinutes ?? 30;
    const now = Date.now();

    for (const date of dates) {
      const plan = await loadPlan(date);
      if (!plan) continue;
      // Find oldest pending item that is due (scheduledAt <= now)
      const due = plan.items
        .filter(i => i.status === 'pending' && new Date(i.scheduledAt).getTime() <= now)
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
      if (!due) continue;

      const lateMin = (now - new Date(due.scheduledAt).getTime()) / 60000;
      if (lateMin > dropAfterMin) {
        // Skip: too late — mark missed (anti-burst on crash recovery)
        Logger.warn(`[Planifier] item ${due.id} is ${Math.round(lateMin)} min late — marking missed`);
        try {
          await Planifier.updatePlanItem(date, due.id, { status: 'missed' });
          await appendHistory({
            type: due.type, site: due.site, accountId: due.accountId,
            itemId: due.id, date, status: 'missed',
            message: `Slot ${Math.round(lateMin)} min late, exceeded drop threshold of ${dropAfterMin} min`,
          });
        } catch {}
        return;  // try again next tick
      }

      // Run it. We import the executor lazily to avoid a require-cycle since
      // action-executor imports from this module.
      _executorRunning = true;
      Logger.info(`[Planifier] AUTO-FIRING: ${due.type} ${due.site}${due.accountId ? '/'+due.accountId : ''} (was due at ${due.scheduledAt})`);
      const { runPlanItem } = await import('./action-executor.js');
      runPlanItem(date, due.id, _serverCtx, { manual: false })
        .then(r => Logger.info(`[Planifier] auto-fired ${due.id} done — ${JSON.stringify(r.result || {}).slice(0,200)}`))
        .catch(e => Logger.error(`[Planifier] auto-fired ${due.id} failed — ${e.message}`))
        .finally(() => { _executorRunning = false; });
      return;
    }
  } catch (e) {
    Logger.warn(`[Planifier] executorTick error: ${e.message}`);
    _executorRunning = false;
  }
}

/**
 * Background tick: if it's Sunday past the regenerate-at-hour AND we haven't
 * regenerated this ISO week yet, wipe-and-rebuild J→J+(horizonDays-1).
 *
 * Skips entirely if the master switch is off.
 */
async function weeklyTick() {
  try {
    const config = await loadConfig();
    if (!config.enabled) return;
    const now = new Date();
    if (now.getDay() !== 0) return;  // 0 = Sunday
    const regenHour = config.rules?.regenerateAtHour ?? 0;
    if (now.getHours() < regenHour) return;
    const wk = isoWeekKey(now);
    if (config._lastWeeklyRegenWeek === wk) return;
    Logger.info(`[Planifier] weekly auto-regen firing (Sunday ${now.toLocaleTimeString()}, week ${wk})`);
    const days = Math.max(1, Math.min(14, config.rules?.horizonDays || 7));
    const fresh = await loadConfig();
    fresh._lastWeeklyRegenWeek = wk;
    fresh._lastWeeklyRegenAt = now.toISOString();
    await saveConfig(fresh);
    await Planifier.randomizeWeek(days);
    await appendHistory({
      type: 'auto-weekly-regen',
      site: null,
      status: 'done',
      message: `Auto-regenerated ${days} days at ${now.toLocaleTimeString()}`,
    });
  } catch (e) {
    Logger.warn(`[Planifier] weeklyTick error: ${e.message}`);
  }
}

export const Planifier = {
  /**
   * Start background timers. Call once at server bootstrap.
   * @param {object} [serverCtx] - shared server context. Required for the
   *   executor tick to actually launch automation (without it, the executor
   *   tick is a no-op).
   */
  init(serverCtx) {
    if (serverCtx) _serverCtx = serverCtx;
    if (!_weeklyTickTimer) {
      _weeklyTickTimer = setInterval(() => weeklyTick().catch(() => {}), WEEKLY_TICK_INTERVAL_MS);
      Logger.info('[Planifier] weekly auto-regen tick armed (every 30 min)');
      weeklyTick().catch(() => {});
    }
    if (!_executorTickTimer && _serverCtx) {
      _executorTickTimer = setInterval(() => executorTick().catch(() => {}), EXECUTOR_TICK_INTERVAL_MS);
      Logger.info('[Planifier] executor tick armed (every 60s, fires due slots when master switch ON)');
    }
  },

  stop() {
    if (_weeklyTickTimer) { clearInterval(_weeklyTickTimer); _weeklyTickTimer = null; }
    if (_executorTickTimer) { clearInterval(_executorTickTimer); _executorTickTimer = null; }
  },

  // ── Config ──────────────────────────────────────────────────

  /**
   * Get the full config, auto-seeding entries for any newly-discovered site.
   */
  async getConfig() {
    const config = await loadConfig();
    const sites = await discoverSites();
    let mutated = false;
    for (const siteName of sites) {
      if (!config.sites[siteName]) {
        ensureSiteConfig(config, siteName);
        mutated = true;
      }
    }
    if (mutated) await saveConfig(config);
    return config;
  },

  async saveConfig(newConfig) {
    await saveConfig(newConfig);
    Logger.info('[Planifier] config saved');
    return newConfig;
  },

  async setEnabled(enabled) {
    const config = await loadConfig();
    config.enabled = !!enabled;
    await saveConfig(config);
    Logger.info(`[Planifier] global enabled: ${config.enabled}`);
    return config;
  },

  // ── Plans ───────────────────────────────────────────────────

  /**
   * Get the plan for a date. If it doesn't exist, returns null. To preview
   * what a plan WOULD be without persisting, use previewPlan().
   */
  async getPlan(date) {
    return await loadPlan(date);
  },

  /**
   * Generate-and-save the plan for a date (overwrites any existing).
   */
  async regeneratePlan(date) {
    const config = await loadConfig();
    const plan = buildDayPlan(date, config);
    await savePlan(date, plan);
    Logger.info(`[Planifier] regenerated plan for ${date} — ${plan.items.length} action(s)`);
    return plan;
  },

  /**
   * Preview a plan without saving (for dashboard "what would tomorrow look like?")
   */
  async previewPlan(date, options = {}) {
    const config = await loadConfig();
    return buildDayPlan(date, config, options);
  },

  /**
   * Generate plans for the next N days (skips dates that already exist).
   */
  async ensureHorizon(days) {
    const config = await loadConfig();
    const generated = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(todayKey(), i);
      const existing = await loadPlan(date);
      if (existing) continue;
      const plan = buildDayPlan(date, config);
      await savePlan(date, plan);
      generated.push(date);
    }
    return generated;
  },

  /**
   * Return the plans for [today, today+days-1]. Missing days are auto-generated.
   */
  async getUpcoming(days = 7) {
    await this.ensureHorizon(days);
    const out = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(todayKey(), i);
      const plan = await loadPlan(date);
      if (plan) out.push(plan);
    }
    return out;
  },

  async deletePlan(date) {
    await deletePlan(date);
    Logger.info(`[Planifier] plan deleted for ${date}`);
  },

  async listPlanDates() {
    return await listPlanDates();
  },

  /**
   * Modify a single item in a plan. Body can include scheduledAt (ISO),
   * locked (bool), or status. Preserves "locked" items on regeneration.
   */
  async updatePlanItem(date, itemId, patch) {
    const plan = await loadPlan(date);
    if (!plan) throw new Error(`No plan for ${date}`);
    const item = plan.items.find(i => i.id === itemId);
    if (!item) throw new Error(`Item ${itemId} not found in ${date}`);
    const allowed = ['scheduledAt', 'locked', 'status', 'willPost'];
    for (const k of allowed) {
      if (patch[k] !== undefined) item[k] = patch[k];
    }
    plan.items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    await savePlan(date, plan);
    return item;
  },

  async deletePlanItem(date, itemId) {
    const plan = await loadPlan(date);
    if (!plan) throw new Error(`No plan for ${date}`);
    const before = plan.items.length;
    plan.items = plan.items.filter(i => i.id !== itemId);
    if (plan.items.length === before) throw new Error(`Item ${itemId} not found`);
    await savePlan(date, plan);
    return { removed: 1, remaining: plan.items.length };
  },

  /**
   * Wipe + regenerate plans for the next N days. Preserves any items
   * marked `locked: true` by carrying them over to the new plan.
   */
  async randomizeWeek(days = 7) {
    const config = await loadConfig();
    const today = todayKey();
    const generated = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      // Carry over locked items from existing plan
      const existing = await loadPlan(date);
      const locked = (existing?.items || []).filter(it => it.locked && it.status === 'pending');
      const fresh = (await import('./day-plan-builder.js')).buildDayPlan(date, config);
      // Merge locked items, then re-sort, drop duplicates by time/site/account
      fresh.items = [...locked, ...fresh.items.filter(f =>
        !locked.some(l => l.scheduledAt === f.scheduledAt && l.type === f.type && l.site === f.site && l.accountId === f.accountId)
      )].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      await savePlan(date, fresh);
      generated.push(date);
    }
    Logger.info(`[Planifier] randomized week — ${days} days regenerated`);
    return generated;
  },

  // ── History ─────────────────────────────────────────────────

  async getHistory({ range = 'all', limit = 500 } = {}) {
    const hist = await loadHistory();
    let items = [...hist.items].reverse();  // newest first
    if (range === 'today') {
      const today = todayKey();
      items = items.filter(it => (it.loggedAt || '').startsWith(today));
    }
    if (range === 'week') {
      const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
      items = items.filter(it => (it.loggedAt || '') >= cutoff);
    }
    return { items: items.slice(0, limit), total: hist.items.length };
  },

  async appendHistory(entry) {
    await appendHistory(entry);
  },

  async clearHistory() {
    await clearHistory();
  },

  // ── Discovery helpers ───────────────────────────────────────

  async discoverSites() {
    return await discoverSites();
  },
};
