/**
 * Flow Account Manager — manages multiple Google accounts for Flow/ImageFX
 * to rotate around the daily image generation limit (~100/account/day).
 *
 * Accounts are stored globally in data/flow-accounts.json (shared across sites).
 * Each account has its own Playwright profile directory.
 */

import { StateManager } from './state-manager.js';
import { Logger } from './logger.js';
import { join } from 'path';

const DEFAULT_RATE_LIMIT_RESET_HOURS = 4;
const DEFAULT_COUNT_RESET_HOURS = 24;

export const FlowAccountManager = {

  /**
   * Get all accounts with computed status.
   * Auto-resets:
   * - Rate-limit flag: after rateLimitResetHours (default 4h)
   * - Generation count: after countResetHours (default 24h)
   */
  async getAccounts() {
    const data = await StateManager.getFlowAccounts();
    let changed = false;
    const now = Date.now();

    const rateLimitResetMs = (data.rateLimitResetHours || DEFAULT_RATE_LIMIT_RESET_HOURS) * 60 * 60 * 1000;
    const countResetMs = (data.countResetHours || DEFAULT_COUNT_RESET_HOURS) * 60 * 60 * 1000;

    for (const acct of data.accounts) {
      // Auto-reset generation count
      if (data.autoReset && acct.firstGenAt && (now - acct.firstGenAt) >= countResetMs) {
        acct.generationCount = 0;
        acct.firstGenAt = null;
        changed = true;
        Logger.info(`[FlowAccounts] Auto-reset count for "${acct.name}" (${data.countResetHours || DEFAULT_COUNT_RESET_HOURS}h elapsed)`);
      }
      // Auto-clear rate-limit flag
      if (acct.rateLimitedAt && (now - acct.rateLimitedAt) >= rateLimitResetMs) {
        acct.rateLimitedAt = null;
        changed = true;
        Logger.info(`[FlowAccounts] Rate-limit cleared for "${acct.name}" (${data.rateLimitResetHours || DEFAULT_RATE_LIMIT_RESET_HOURS}h elapsed)`);
      }
    }

    if (changed) await StateManager.saveFlowAccounts(data);
    return data;
  },

  /**
   * Get the currently active account (the one automation should use).
   * Returns null if no accounts are configured or all are exhausted/disabled.
   */
  async getActiveAccount() {
    const data = await this.getAccounts();
    if (!data.accounts.length) return null;

    // If there's an explicitly set active account that's enabled, return it
    if (data.activeAccountId) {
      const active = data.accounts.find(a => a.id === data.activeAccountId && a.enabled);
      if (active) return active;
    }

    // Find next available account
    const next = this._findNextAvailable(data);
    if (next) {
      data.activeAccountId = next.id;
      await StateManager.saveFlowAccounts(data);
      return next;
    }

    return null; // All accounts exhausted
  },

  /**
   * Get the profile directory path for an account.
   */
  getProfileDir(account) {
    return join(process.env.LOCALAPPDATA || '', account.profileDir);
  },

  /**
   * Increment the generation count for the active account.
   * Called after each successful Flow image generation.
   * Returns { exhausted, account } — exhausted=true means rotation needed.
   */
  async incrementCount() {
    const data = await this.getAccounts();
    const active = data.accounts.find(a => a.id === data.activeAccountId);
    if (!active) return { exhausted: false, account: null };

    // Set first generation timestamp if not set
    if (!active.firstGenAt) {
      active.firstGenAt = Date.now();
    }

    active.generationCount = (active.generationCount || 0) + 1;
    active.lastGenAt = Date.now();
    await StateManager.saveFlowAccounts(data);

    const exhausted = active.generationCount >= data.maxPerAccount;
    if (exhausted) {
      Logger.warn(`[FlowAccounts] Account "${active.name}" reached limit (${active.generationCount}/${data.maxPerAccount})`);
    }

    return { exhausted, account: active };
  },

  /**
   * Rotate to the next available account (skips rate-limited/blocked).
   * Returns the new active account, or null if all are exhausted.
   */
  async rotate() {
    const data = await this.getAccounts();
    const next = this._findNextAvailable(data);

    if (next) {
      Logger.info(`[FlowAccounts] Rotating to account "${next.name}"`);
      data.activeAccountId = next.id;
      await StateManager.saveFlowAccounts(data);
      return next;
    }

    Logger.error('[FlowAccounts] All accounts exhausted! No more accounts available.');
    return null;
  },

  /**
   * Round-robin rotation: always pick the NEXT account in order after the current one.
   * Skips blocked accounts (rateLimitedAt set). Wraps around at the end.
   * Used at the start of every recipe for even load distribution.
   */
  async rotateRoundRobin() {
    const data = await this.getAccounts();
    const enabled = data.accounts.filter(a => a.enabled);
    if (enabled.length === 0) return null;
    if (enabled.length === 1) {
      // Only one account — use it (even if flagged, no alternative)
      data.activeAccountId = enabled[0].id;
      await StateManager.saveFlowAccounts(data);
      return enabled[0];
    }

    // Find current account's position in the enabled list
    const currentIdx = enabled.findIndex(a => a.id === data.activeAccountId);

    // Try each account after current, wrapping around
    for (let i = 1; i <= enabled.length; i++) {
      const candidate = enabled[(currentIdx + i) % enabled.length];
      // Skip blocked accounts
      if (candidate.rateLimitedAt) {
        Logger.debug(`[FlowAccounts] Skipping "${candidate.name}" (blocked)`);
        continue;
      }
      data.activeAccountId = candidate.id;
      await StateManager.saveFlowAccounts(data);
      return candidate;
    }

    // All accounts blocked — use the next one anyway (least bad option)
    Logger.warn('[FlowAccounts] All accounts are flagged — using next in rotation');
    const fallback = enabled[(currentIdx + 1) % enabled.length];
    data.activeAccountId = fallback.id;
    await StateManager.saveFlowAccounts(data);
    return fallback;
  },

  /**
   * Check if rotation is needed (current account exhausted) and rotate if so.
   * Returns { rotated, account, allExhausted }.
   */
  async checkAndRotate() {
    const data = await this.getAccounts();
    if (!data.accounts.length) return { rotated: false, account: null, allExhausted: false };

    const active = data.accounts.find(a => a.id === data.activeAccountId && a.enabled);

    // No active account found
    if (!active) {
      const next = this._findNextAvailable(data);
      if (next) {
        data.activeAccountId = next.id;
        await StateManager.saveFlowAccounts(data);
        return { rotated: true, account: next, allExhausted: false };
      }
      return { rotated: false, account: null, allExhausted: true };
    }

    return { rotated: false, account: active, allExhausted: false };
  },

  /**
   * Add a new account.
   */
  async addAccount(name, profileDir) {
    const data = await this.getAccounts();
    const id = `flow_${Date.now()}`;
    const account = {
      id,
      name,
      profileDir,
      enabled: true,
      geminiApiKey: '',
      generationCount: 0,
      firstGenAt: null,
      lastGenAt: null,
      createdAt: Date.now()
    };
    data.accounts.push(account);

    // Auto-set as active if first account
    if (data.accounts.length === 1) {
      data.activeAccountId = id;
    }

    await StateManager.saveFlowAccounts(data);
    return account;
  },

  /**
   * Update an existing account.
   */
  async updateAccount(id, updates) {
    const data = await this.getAccounts();
    const idx = data.accounts.findIndex(a => a.id === id);
    if (idx === -1) throw new Error(`Account "${id}" not found`);
    data.accounts[idx] = { ...data.accounts[idx], ...updates };
    await StateManager.saveFlowAccounts(data);
    return data.accounts[idx];
  },

  /**
   * Remove an account.
   */
  async removeAccount(id) {
    const data = await this.getAccounts();
    data.accounts = data.accounts.filter(a => a.id !== id);
    if (data.activeAccountId === id) {
      data.activeAccountId = data.accounts[0]?.id || null;
    }
    await StateManager.saveFlowAccounts(data);
  },

  /**
   * Reset the generation count for a specific account.
   */
  async resetCount(id) {
    const data = await this.getAccounts();
    const acct = data.accounts.find(a => a.id === id);
    if (!acct) throw new Error(`Account "${id}" not found`);
    acct.generationCount = 0;
    acct.firstGenAt = null;
    acct.rateLimitedAt = null;
    await StateManager.saveFlowAccounts(data);
    Logger.info(`[FlowAccounts] Reset count & rate-limit for "${acct.name}"`);
  },

  /**
   * Flag the current active account as rate-limited.
   */
  async flagRateLimited() {
    const data = await this.getAccounts();
    const active = data.accounts.find(a => a.id === data.activeAccountId);
    if (!active) return;
    active.rateLimitedAt = Date.now();
    await StateManager.saveFlowAccounts(data);
    Logger.warn(`[FlowAccounts] Account "${active.name}" flagged as rate-limited at ${new Date().toLocaleString()}`);
  },

  /**
   * Check if the current active account is rate-limited.
   */
  async isActiveRateLimited() {
    const data = await this.getAccounts();
    const active = data.accounts.find(a => a.id === data.activeAccountId);
    return !!(active?.rateLimitedAt);
  },

  /**
   * Update global settings (autoReset).
   */
  async updateSettings(settings) {
    const data = await this.getAccounts();
    if (settings.autoReset !== undefined) data.autoReset = settings.autoReset;
    if (settings.rateLimitResetHours !== undefined) data.rateLimitResetHours = settings.rateLimitResetHours;
    if (settings.countResetHours !== undefined) data.countResetHours = settings.countResetHours;
    await StateManager.saveFlowAccounts(data);
  },

  /**
   * Check if multi-account mode is configured (at least 1 enabled account).
   */
  async isEnabled() {
    const data = await this.getAccounts();
    return data.accounts.some(a => a.enabled);
  },

  /**
   * Get the Gemini API key for the currently active account.
   * Returns empty string if not configured.
   */
  async getActiveGeminiKey() {
    const data = await this.getAccounts();
    const active = data.accounts.find(a => a.id === data.activeAccountId);
    return active?.geminiApiKey || '';
  },

  /**
   * Get ALL available Gemini API keys (for round-robin rotation).
   * Returns array of unique non-empty keys.
   */
  async getAllGeminiKeys() {
    const data = await this.getAccounts();
    const keys = data.accounts
      .filter(a => a.enabled && a.geminiApiKey)
      .map(a => a.geminiApiKey);
    // Deduplicate
    return [...new Set(keys)];
  },

  // ── Internal ──

  _findNextAvailable(data) {
    // Find an enabled account that isn't the current active one
    // and isn't rate-limited, preferring accounts with the fewest generations
    return data.accounts
      .filter(a => a.enabled && a.id !== data.activeAccountId && !a.rateLimitedAt)
      .sort((a, b) => (a.generationCount || 0) - (b.generationCount || 0))[0] || null;
  }
};
