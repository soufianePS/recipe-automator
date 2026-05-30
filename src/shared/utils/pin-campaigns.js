/**
 * PinCampaigns — calendar of scheduled pin-creation jobs.
 *
 * Each row = a campaign tied to a specific site + recipe + type:
 *   - 'regen-3pins'  → regenerate ALL 3 pins for a recipe over 3 dates
 *   - 'single-pin'   → 1 ad-hoc new pin on 1 date
 *   - 'warming-pin'  → reserved (driven by the warming pin list, not by user)
 *
 * Schema (pin-campaigns tab):
 *   campaign_id, site, recipe_url, recipe_title, type, template,
 *   scheduled_date_1, scheduled_date_2, scheduled_date_3,
 *   status_1, status_2, status_3, account_id, created_at, notes
 *
 * Status values per slot: 'pending', 'generated', 'posted', 'error', 'skip'
 *
 * The Planifier reads this tab on its tick and fires due slots whose
 * scheduled date is today and whose status is 'pending'.
 */

import {
  readTabAsObjects, appendObjects, patchRow, credentialsAvailable,
} from './sheets-client.js';
import { Logger } from './logger.js';

const TAB = 'pin-campaigns';
const SLOTS = [1, 2, 3];

function todayKey() { return new Date().toISOString().slice(0, 10); }

export const PinCampaigns = {
  /** All campaigns (raw rows). */
  async list() {
    if (!credentialsAvailable()) return [];
    try { return await readTabAsObjects(TAB); }
    catch (e) { Logger.warn(`[PinCampaigns] read failed: ${e.message}`); return []; }
  },

  /** Campaigns for one site (optionally filter by status). */
  async listForSite(siteId) {
    const all = await this.list();
    return all.filter(c => c.site === siteId);
  },

  /**
   * Build the list of due slots = (campaign, slotNumber) tuples whose
   * scheduled datetime is now or earlier AND whose status is still 'pending'.
   *
   * scheduled_date_N can be either:
   *   - "YYYY-MM-DD" → date only, fires any time that day (>= today)
   *   - "YYYY-MM-DDTHH:MM:SS" → exact datetime (ISO-T format)
   *   - "YYYY-MM-DD HH:MM:SS" → exact datetime (Google Sheets auto-converts
   *     T → space when USER_ENTERED — we accept both formats)
   *
   * Slots from different campaigns are returned independently so the
   * planifier can fire them one by one.
   */
  async listDueSlots({ date = null, siteFilter = null } = {}) {
    const all = await this.list();
    const target = date || todayKey();
    const nowMs = Date.now();
    const due = [];
    for (const c of all) {
      if (siteFilter && c.site !== siteFilter) continue;
      for (const n of SLOTS) {
        const scheduled = (c[`scheduled_date_${n}`] || '').trim();
        const status = (c[`status_${n}`] || 'pending').toLowerCase();
        if (!scheduled) continue;
        if (status !== 'pending') continue;
        // Detect time component (HH:MM after the date) — works for both
        // "YYYY-MM-DDTHH:MM" and "YYYY-MM-DD HH:MM" formats.
        const hasTime = /\d{2}:\d{2}/.test(scheduled);
        if (hasTime) {
          // Normalize space → T so Date.parse works reliably on all engines
          const normalized = scheduled.replace(' ', 'T');
          const ts = Date.parse(normalized);
          if (Number.isNaN(ts)) continue;
          if (ts > nowMs) continue;  // future — wait
        } else {
          // Date-only — fire any time on/after that day
          if (scheduled.slice(0, 10) > target) continue;
        }
        due.push({ campaign: c, slot: n, scheduledDate: scheduled });
      }
    }
    // oldest scheduled first
    due.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
    return due;
  },

  /** Create a new campaign. campaign_id auto-generated if omitted. */
  async create({
    site, recipe_url, recipe_title, type,
    template = '',
    scheduled_date_1 = '', scheduled_date_2 = '', scheduled_date_3 = '',
    account_id = '', notes = '',
  }) {
    if (!credentialsAvailable() || !site || !recipe_url || !type) {
      throw new Error('PinCampaigns.create: missing required fields (site/recipe_url/type)');
    }
    const row = {
      campaign_id: _uuid(),
      site, recipe_url, recipe_title: recipe_title || '', type,
      template,
      scheduled_date_1, scheduled_date_2, scheduled_date_3,
      status_1: scheduled_date_1 ? 'pending' : 'skip',
      status_2: scheduled_date_2 ? 'pending' : 'skip',
      status_3: scheduled_date_3 ? 'pending' : 'skip',
      account_id, created_at: new Date().toISOString(), notes,
    };
    await appendObjects(TAB, [row]);
    return row;
  },

  /**
   * Update one slot's status (e.g. 'pending' → 'generated' → 'posted').
   * Match by campaign_id.
   */
  async setSlotStatus(campaignId, slotNumber, status) {
    if (!credentialsAvailable()) return { updated: 0 };
    const key = `status_${slotNumber}`;
    try {
      return await patchRow(TAB, 'campaign_id', campaignId, { [key]: status });
    } catch (e) {
      Logger.warn(`[PinCampaigns] setSlotStatus failed: ${e.message}`);
      return { updated: 0 };
    }
  },

  /** Update multiple fields on a campaign. */
  async patch(campaignId, patch) {
    if (!credentialsAvailable()) return { updated: 0 };
    try { return await patchRow(TAB, 'campaign_id', campaignId, patch); }
    catch (e) { Logger.warn(`[PinCampaigns] patch failed: ${e.message}`); return { updated: 0 }; }
  },
};

function _uuid() {
  // Lightweight UUID-ish (timestamp + random). Avoid extra deps.
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
