/**
 * PinHistory — append-only audit log of every pin created by the pipeline.
 *
 * Schema (pin-history tab):
 *   timestamp, site, type, recipe_topic, recipe_url, pin_slot, template,
 *   wp_image_url, pinterest_url, posted_at, account_id, notes
 *
 * `type` values:
 *   - 'initial'  → pin generated alongside the recipe creation
 *   - 'regen'    → pin regenerated as part of a campaign
 *   - 'single'   → ad-hoc single pin
 *   - 'warming'  → warming pin (no recipe link)
 *
 * `pin_slot` values: "1", "2", "3", "extra", "warming-1", "warming-2", ...
 *
 * Writes are best-effort: if credentials are missing or the sheet write
 * fails, we log and continue. Pin history is observability, not gate.
 */

import { appendObjects, patchRow, credentialsAvailable } from './sheets-client.js';
import { Logger } from './logger.js';

const TAB = 'pin-history';

export const PinHistory = {
  /**
   * Append a single entry. Caller provides whichever fields apply; missing
   * fields are written as empty strings. `timestamp` defaults to now.
   *
   * @param {Object} entry
   * @param {string} entry.site - site_id (required)
   * @param {string} entry.type - 'initial'|'regen'|'single'|'warming' (required)
   * @param {string} [entry.recipe_topic]
   * @param {string} [entry.recipe_url]
   * @param {string} [entry.pin_slot]
   * @param {string} [entry.template]
   * @param {string} [entry.wp_image_url]
   * @param {string} [entry.pinterest_url]
   * @param {string} [entry.posted_at] - ISO when posted (separate from row timestamp)
   * @param {string} [entry.account_id]
   * @param {string} [entry.notes]
   */
  async append(entry) {
    if (!entry || !entry.site || !entry.type) {
      Logger.warn('[PinHistory] append called without site or type — skipping');
      return { appended: 0 };
    }
    if (!credentialsAvailable()) {
      Logger.warn('[PinHistory] credentials missing — entry not persisted');
      return { appended: 0 };
    }
    const row = {
      timestamp: entry.timestamp || new Date().toISOString(),
      site: entry.site,
      type: entry.type,
      recipe_topic: entry.recipe_topic || '',
      recipe_url: entry.recipe_url || '',
      pin_slot: entry.pin_slot || '',
      template: entry.template || '',
      wp_image_url: entry.wp_image_url || '',
      pinterest_url: entry.pinterest_url || '',
      posted_at: entry.posted_at || '',
      account_id: entry.account_id || '',
      notes: entry.notes || '',
    };
    try {
      return await appendObjects(TAB, [row]);
    } catch (e) {
      Logger.warn(`[PinHistory] append failed: ${e.message}`);
      return { appended: 0 };
    }
  },

  /**
   * Patch an existing entry by wp_image_url (set when pin is posted to
   * Pinterest). Typical use: orchestrator appends a row at generation time
   * with wp_image_url filled + pinterest_url/posted_at empty, then the
   * Pinterest poster patches the same row with those final values.
   *
   * @param {string} wpImageUrl - the wp_image_url that identifies the row
   * @param {Object} patch - { pinterest_url, posted_at, account_id, ... }
   */
  async patchByImageUrl(wpImageUrl, patch) {
    if (!credentialsAvailable() || !wpImageUrl) return { updated: 0 };
    try {
      return await patchRow('pin-history', 'wp_image_url', wpImageUrl, patch);
    } catch (e) {
      Logger.warn(`[PinHistory] patchByImageUrl failed: ${e.message}`);
      return { updated: 0 };
    }
  },

  /** Bulk append. Same shape as append() but plural. */
  async appendMany(entries) {
    if (!entries || entries.length === 0) return { appended: 0 };
    if (!credentialsAvailable()) return { appended: 0 };
    const rows = entries.map(e => ({
      timestamp: e.timestamp || new Date().toISOString(),
      site: e.site,
      type: e.type,
      recipe_topic: e.recipe_topic || '',
      recipe_url: e.recipe_url || '',
      pin_slot: e.pin_slot || '',
      template: e.template || '',
      wp_image_url: e.wp_image_url || '',
      pinterest_url: e.pinterest_url || '',
      posted_at: e.posted_at || '',
      account_id: e.account_id || '',
      notes: e.notes || '',
    }));
    try {
      return await appendObjects(TAB, rows);
    } catch (e) {
      Logger.warn(`[PinHistory] appendMany failed: ${e.message}`);
      return { appended: 0 };
    }
  },
};
