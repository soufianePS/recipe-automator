/**
 * SitesConfig — high-level helpers for the `sites-config` tab.
 *
 * Each row = one site, shared across all users of the app. This is the
 * source of truth for which sites exist + their cross-PC metadata. Local
 * per-user data (WP credentials, Dolphin tokens, local file paths, prompt
 * templates) stays in data/sites/{site_id}/settings.json.
 *
 * Usage:
 *   import { SitesConfig } from '../utils/sites-config.js';
 *   const sites = await SitesConfig.list();           // all sites
 *   const active = await SitesConfig.listActive();    // active only
 *   const loc = await SitesConfig.get('leagueofcooking');
 *   await SitesConfig.setWarmingEnabled('thetastymama', true);
 *
 * The cache TTL is 30s — sheet reads are quota-limited (60/min) so we don't
 * re-fetch on every single planifier tick. Call invalidate() after any write
 * to force the next read to be fresh.
 */

import { readTabAsObjects, patchRow, credentialsAvailable } from './sheets-client.js';
import { Logger } from './logger.js';

const TAB = 'sites-config';
const CACHE_TTL_MS = 30 * 1000;

let _cache = null;
let _cacheAt = 0;

/** Parse TRUE/FALSE strings (Sheet returns booleans as text). */
function _bool(v) {
  if (typeof v === 'boolean') return v;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function _normalize(row) {
  return {
    site_id:          row.site_id || '',
    display_name:     row.display_name || row.site_id || '',
    wp_url:           row.wp_url || '',
    active:           _bool(row.active),
    warming_enabled:  _bool(row.warming_enabled),
    recipes_tab:      row.recipes_tab || '',
    scraper_tab:      row.scraper_tab || '',
    created_at:       row.created_at || '',
    notes:            row.notes || '',
  };
}

export const SitesConfig = {
  /**
   * Read all sites from the sheet. Cached for 30s.
   * Returns [] if credentials are not configured (graceful degradation).
   */
  async list({ noCache = false } = {}) {
    if (!credentialsAvailable()) return [];
    const fresh = noCache || !_cache || (Date.now() - _cacheAt > CACHE_TTL_MS);
    if (!fresh) return _cache;
    try {
      const raw = await readTabAsObjects(TAB);
      _cache = raw.filter(r => r.site_id).map(_normalize);
      _cacheAt = Date.now();
      return _cache;
    } catch (e) {
      Logger.warn(`[SitesConfig] read failed: ${e.message}`);
      return _cache || [];  // fall back to previous cache if any
    }
  },

  /** Sites where active === TRUE. */
  async listActive(opts = {}) {
    const all = await this.list(opts);
    return all.filter(s => s.active);
  },

  /** Sites with warming_enabled === TRUE (and active). */
  async listWarming(opts = {}) {
    const all = await this.list(opts);
    return all.filter(s => s.active && s.warming_enabled);
  },

  /** Get one site by id (or null). */
  async get(siteId, opts = {}) {
    const all = await this.list(opts);
    return all.find(s => s.site_id === siteId) || null;
  },

  /**
   * Update arbitrary columns for a site. Bypasses cache for the write but
   * invalidates so next read is fresh.
   */
  async update(siteId, patch) {
    if (!credentialsAvailable()) {
      throw new Error('Cannot update sites-config: google-credentials.json missing');
    }
    const res = await patchRow(TAB, 'site_id', siteId, patch);
    this.invalidate();
    return res;
  },

  /** Convenience setters. */
  async setActive(siteId, active) {
    return this.update(siteId, { active: !!active });
  },
  async setWarmingEnabled(siteId, enabled) {
    return this.update(siteId, { warming_enabled: !!enabled });
  },
  async setNotes(siteId, notes) {
    return this.update(siteId, { notes: notes || '' });
  },

  /** Force next read to refetch. Call after external/manual edit. */
  invalidate() {
    _cache = null;
    _cacheAt = 0;
  },
};
