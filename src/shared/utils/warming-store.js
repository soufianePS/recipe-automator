/**
 * WarmingPool + WarmingPinList — helpers for the two warming-related tabs.
 *
 * warming-pool      → curated list of Pinterest pin URLs to re-save during
 *                     warming sessions (you fill this manually).
 * warming-pin-list  → recipe topics ("Banana Bread") the bot will search
 *                     Pinterest for, scrape inspiration from, then generate
 *                     a fresh warming pin via Flow.
 *
 * Both tabs use a `site` column so the same sheet supports multiple sites.
 */

import { readTabAsObjects, patchRow, appendObjects, credentialsAvailable } from './sheets-client.js';
import { Logger } from './logger.js';

const POOL_TAB = 'warming-pool';
const PINLIST_TAB = 'warming-pin-list';

function _bool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// ── WarmingPool ────────────────────────────────────────────────────

export const WarmingPool = {
  /**
   * List entries for a site. Optionally filter by status.
   * Returns rows with original row index so patchRow can target them.
   */
  async listForSite(siteId, { status = null } = {}) {
    if (!credentialsAvailable()) return [];
    try {
      const all = await readTabAsObjects(POOL_TAB);
      return all
        .filter(r => r.site === siteId)
        .filter(r => status == null || (r.status || 'pending').toLowerCase() === status.toLowerCase());
    } catch (e) {
      Logger.warn(`[WarmingPool] read failed: ${e.message}`);
      return [];
    }
  },

  /**
   * Pick the next pending pin URL for a site. Returns null if pool empty.
   * Caller should call markSaved() afterwards.
   */
  async pickNext(siteId) {
    const pending = await this.listForSite(siteId, { status: 'pending' });
    return pending[0] || null;
  },

  /**
   * Mark a pin as saved (status=saved, saved_at=now, saved_by_account=accId).
   * Match by pin_url (assumed unique within a site).
   */
  async markSaved(pinUrl, accountId) {
    if (!credentialsAvailable()) return { updated: 0 };
    try {
      return await patchRow(POOL_TAB, 'pin_url', pinUrl, {
        status: 'saved',
        saved_at: new Date().toISOString(),
        saved_by_account: accountId || '',
      });
    } catch (e) {
      Logger.warn(`[WarmingPool] markSaved failed: ${e.message}`);
      return { updated: 0 };
    }
  },

  /** Add a new pin URL to the pool (manual curation aid for the dashboard). */
  async add({ site, pin_url, keyword = '', notes = '' }) {
    if (!credentialsAvailable() || !site || !pin_url) return { appended: 0 };
    try {
      return await appendObjects(POOL_TAB, [{
        site, pin_url, keyword, status: 'pending',
        saved_at: '', saved_by_account: '', notes,
      }]);
    } catch (e) {
      Logger.warn(`[WarmingPool] add failed: ${e.message}`);
      return { appended: 0 };
    }
  },
};

// ── WarmingPinList ─────────────────────────────────────────────────

export const WarmingPinList = {
  /**
   * Topics for a site, skipping rows where skip=TRUE.
   * Optionally filter by status (default: not 'done').
   */
  async listForSite(siteId, { onlyPending = true } = {}) {
    if (!credentialsAvailable()) return [];
    try {
      const all = await readTabAsObjects(PINLIST_TAB);
      return all
        .filter(r => r.site === siteId && !_bool(r.skip))
        .filter(r => !onlyPending || (r.status || 'pending').toLowerCase() !== 'done');
    } catch (e) {
      Logger.warn(`[WarmingPinList] read failed: ${e.message}`);
      return [];
    }
  },

  /**
   * Pick the next topic for a site. Round-robin by least-recently-generated,
   * then by row order.
   */
  async pickNext(siteId, { accountId = null } = {}) {
    const candidates = await this.listForSite(siteId, { onlyPending: false });
    if (candidates.length === 0) return null;
    // Prefer rows with no last_generated_at, then oldest. Also respect
    // assigned_account if set.
    const eligible = candidates.filter(c =>
      !c.assigned_account || !accountId || c.assigned_account === accountId
    );
    if (eligible.length === 0) return null;
    eligible.sort((a, b) => {
      const ta = a.last_generated_at || '';
      const tb = b.last_generated_at || '';
      if (!ta && !tb) return 0;
      if (!ta) return -1;
      if (!tb) return 1;
      return ta.localeCompare(tb);
    });
    return eligible[0];
  },

  /**
   * Mark a topic as generated (status=done, last_generated_at=now).
   */
  async markGenerated(topic, accountId) {
    if (!credentialsAvailable()) return { updated: 0 };
    try {
      return await patchRow(PINLIST_TAB, 'topic', topic, {
        status: 'done',
        last_generated_at: new Date().toISOString(),
        assigned_account: accountId || '',
      });
    } catch (e) {
      Logger.warn(`[WarmingPinList] markGenerated failed: ${e.message}`);
      return { updated: 0 };
    }
  },

  /** Reset a topic so the bot can re-use it. */
  async markPending(topic) {
    if (!credentialsAvailable()) return { updated: 0 };
    try {
      return await patchRow(PINLIST_TAB, 'topic', topic, { status: 'pending' });
    } catch (e) {
      Logger.warn(`[WarmingPinList] markPending failed: ${e.message}`);
      return { updated: 0 };
    }
  },

  async add({ site, topic, assigned_account = '', notes = '' }) {
    if (!credentialsAvailable() || !site || !topic) return { appended: 0 };
    try {
      return await appendObjects(PINLIST_TAB, [{
        site, topic, status: 'pending',
        last_generated_at: '', assigned_account, skip: false, notes,
      }]);
    } catch (e) {
      Logger.warn(`[WarmingPinList] add failed: ${e.message}`);
      return { appended: 0 };
    }
  },
};
