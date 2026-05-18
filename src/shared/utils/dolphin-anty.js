/**
 * Dolphin{anty} client wrapper.
 *
 * Two APIs are exposed:
 *   - Cloud API  (https://dolphin-anty-api.com) — list/manage profiles
 *   - Local API  (http://localhost:3001) — start/stop profiles, returns CDP port
 *
 * Both use the same JWT token, generated at:
 *   https://dolphin-anty.com/panel/index.html#/api
 *
 * Token must be saved in site settings under settings.dolphinAnty.apiToken.
 * Never commit it — settings.json is gitignored.
 */

import { Logger } from './logger.js';

const DEFAULT_CLOUD = 'https://dolphin-anty-api.com';
const DEFAULT_LOCAL = 'http://localhost:3001';

export class DolphinAnty {
  constructor(settings) {
    const cfg = settings?.dolphinAnty || {};
    this.token = cfg.apiToken;
    this.cloudBase = cfg.cloudApi || DEFAULT_CLOUD;
    this.localBase = cfg.localApi || DEFAULT_LOCAL;
    if (!this.token) throw new Error('Dolphin Anty: settings.dolphinAnty.apiToken is missing');
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  async _req(base, path, opts = {}) {
    const url = base + path;
    const res = await fetch(url, { headers: this._headers(), ...opts });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      throw new Error(`Dolphin ${opts.method || 'GET'} ${path} → ${res.status}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`);
    }
    return body;
  }

  // ── Cloud API ────────────────────────────────────────────────

  /** List all browser profiles. Returns array of profile objects. */
  async listProfiles({ limit = 50, page = 1 } = {}) {
    const r = await this._req(this.cloudBase, `/browser_profiles?limit=${limit}&page=${page}`);
    return r.data || r;
  }

  /** Get one profile by id. */
  async getProfile(id) {
    const r = await this._req(this.cloudBase, `/browser_profiles/${id}`);
    return r.data || r;
  }

  // ── Local API ────────────────────────────────────────────────

  /**
   * Authenticate the local Dolphin app with the same JWT.
   * Required once before start/stop calls work.
   */
  async loginLocal() {
    return await this._req(this.localBase, '/v1.0/auth/login-with-token', {
      method: 'POST',
      body: JSON.stringify({ token: this.token }),
    });
  }

  /**
   * Start a profile. Returns { automation: { port, wsEndpoint }, ... }.
   * The CDP port is what Playwright connects to via chromium.connectOverCDP.
   */
  /**
   * Start a profile with automation enabled (CDP).
   * Per docs: POST → automation in JSON body. GET → ?automation=1.
   * On the FREE plan, automation=true returns HTTP 402 (Payment Required).
   */
  async startProfile(profileId, opts = {}) {
    const body = { automation: true, ...opts };
    const r = await this._req(this.localBase, `/v1.0/browser_profiles/${profileId}/start`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return r;
  }

  /** Stop a running profile. */
  async stopProfile(profileId) {
    return await this._req(this.localBase, `/v1.0/browser_profiles/${profileId}/stop`, {
      method: 'GET',
    });
  }

  /**
   * Convenience: ensure local app is authenticated, then start the profile
   * and return the CDP endpoint Playwright should connect to.
   * Falls back to inspecting common shapes the local API returns.
   */
  async startAndGetCDP(profileId) {
    try { await this.loginLocal(); } catch (e) { Logger.warn(`[Dolphin] loginLocal failed (${e.message.split('\n')[0]}) — trying start anyway`); }
    const r = await this.startProfile(profileId);
    const port = r?.automation?.port || r?.port || r?.data?.port;
    const wsEndpoint = r?.automation?.wsEndpoint || r?.wsEndpoint || r?.data?.wsEndpoint;
    if (!port && !wsEndpoint) {
      throw new Error(`Dolphin start: no port/wsEndpoint in response: ${JSON.stringify(r).slice(0, 300)}`);
    }
    return { port, wsEndpoint, raw: r };
  }
}
