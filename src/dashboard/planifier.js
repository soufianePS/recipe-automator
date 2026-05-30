/**
 * Planifier dashboard module.
 *
 * Self-contained: hooks into hashchange + DOMContentLoaded, manages its
 * own state, calls /api/planifier/* endpoints. Does not modify globals
 * from dashboard.js.
 */
(function () {
  'use strict';

  // ── Module state ─────────────────────────────────────────────
  const state = {
    initialized: false,
    config: null,
    meta: null,                 // account-statuses + pin-strategies enums
    dolphinProfiles: [],        // [{id, name, proxy, ...}]
    dolphinWarnings: [],
    activeTab: 'overview',
    uiState: {},                // server-side persisted UI state (filters etc.)
  };

  // Debounce helper — coalesces rapid updates into a single fetch
  function debounce(fn, ms = 400) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ── Utilities ────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(iso) {
    if (!iso) return '--:--';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtTimeFull(iso) {
    if (!iso) return '--:--:--';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  /** Returns a human-readable relative time: "in 2h 15m", "5 min ago", "now". */
  function fmtRelative(iso) {
    if (!iso) return '';
    const diff = new Date(iso).getTime() - Date.now();
    const absMin = Math.abs(Math.round(diff / 60000));
    const future = diff > 0;
    if (absMin < 1) return future ? 'now' : 'just now';
    if (absMin < 60) return future ? `in ${absMin}m` : `${absMin}m ago`;
    const h = Math.floor(absMin / 60);
    const m = absMin % 60;
    return future ? `in ${h}h ${m}m` : `${h}h ${m}m ago`;
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], {
      weekday: 'long', day: 'numeric', month: 'short',
    });
  }

  function relativeDay(dateStr) {
    const today = new Date().toISOString().slice(0, 10);
    if (dateStr === today) return 'Today';
    const [y1, m1, d1] = today.split('-').map(Number);
    const [y2, m2, d2] = dateStr.split('-').map(Number);
    const days = Math.round((new Date(y2, m2-1, d2) - new Date(y1, m1-1, d1)) / 86400000);
    if (days === 1) return 'Tomorrow';
    if (days < 0) return `${-days}d ago`;
    return `J+${days}`;
  }

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  function todayKey() { return new Date().toISOString().slice(0, 10); }

  // ── Routing ──────────────────────────────────────────────────
  function handleHashChange() {
    const hash = (location.hash || '').replace('#', '');
    if (hash === 'planifier' && !state.initialized) {
      plfInit();
    } else if (hash === 'planifier') {
      // Already initialized — refresh active tab
      plfLoadActiveTab();
    }
  }
  window.addEventListener('hashchange', handleHashChange);
  window.addEventListener('DOMContentLoaded', () => {
    if ((location.hash || '').replace('#', '') === 'planifier') plfInit();
  });

  // ── Sub-tab nav ──────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.plf-tab');
    if (!tab) return;
    const name = tab.dataset.plftab;
    if (!name) return;
    plfShowTab(name);
  });

  function plfShowTab(name) {
    state.activeTab = name;
    $$('.plf-tab').forEach(t => t.classList.toggle('active', t.dataset.plftab === name));
    $$('.plf-panel').forEach(p => {
      const match = p.dataset.plfpanel === name;
      p.classList.toggle('active', match);
      p.style.display = match ? '' : 'none';
    });
    plfLoadActiveTab();
  }

  async function plfLoadActiveTab() {
    try {
      if (state.activeTab === 'overview') await plfLoadOverview();
      if (state.activeTab === 'sites') await plfLoadSites();
      if (state.activeTab === 'calendar') await plfLoadCalendar();
      if (state.activeTab === 'config') await plfRenderConfigPanel();
      if (state.activeTab === 'rules') plfRenderRulesPanel();
      if (state.activeTab === 'plan') await plfLoadUpcoming(7);
      if (state.activeTab === 'recipes') await plfLoadRecipes();
      if (state.activeTab === 'pool') await plfLoadPool();
      if (state.activeTab === 'history') await plfLoadHistory();
    } catch (e) {
      console.error('[Planifier] load error:', e);
    }
  }

  // ── Init ─────────────────────────────────────────────────────
  async function plfInit() {
    if (state.initialized) return;
    state.initialized = true;
    try {
      const [config, meta, uiState] = await Promise.all([
        api('GET', '/api/planifier/config'),
        api('GET', '/api/planifier/meta'),
        api('GET', '/api/planifier/ui-state').catch(() => ({})),
      ]);
      state.config = config;
      state.meta = meta;
      state.uiState = uiState || {};

      // Master switch
      $('#plfEnabledToggle').checked = !!config.enabled;
      $('#plfEnabledToggle').addEventListener('change', plfToggleEnabled);
      updateMasterBadge();

      await plfLoadDolphinProfiles({ silent: true });
      await plfLoadOverview();
    } catch (e) {
      console.error('[Planifier] init error:', e);
      showToast('Planifier init failed: ' + e.message, 'error');
    }
  }

  function updateMasterBadge() {
    const badge = $('#plfMasterBadge');
    if (!badge) return;
    const on = !!state.config?.enabled;
    badge.textContent = on ? 'AUTO-PILOT ON' : 'AUTO-PILOT OFF';
    badge.style.background = on ? 'rgba(0,214,143,0.15)' : 'rgba(120,120,150,0.15)';
    badge.style.color = on ? '#00d68f' : '#9a9ab8';
    badge.style.border = on ? '1px solid rgba(0,214,143,0.3)' : '1px solid rgba(120,120,150,0.25)';
  }

  async function plfToggleEnabled() {
    try {
      const enabled = $('#plfEnabledToggle').checked;
      await api('POST', '/api/planifier/enabled', { enabled });
      state.config.enabled = enabled;
      updateMasterBadge();
      showToast(enabled ? 'Auto-pilot enabled' : 'Auto-pilot disabled', 'success');
    } catch (e) {
      showToast('Failed to toggle: ' + e.message, 'error');
      $('#plfEnabledToggle').checked = state.config?.enabled || false;
    }
  }

  // ── Dolphin profiles ─────────────────────────────────────────
  async function plfLoadDolphinProfiles({ silent = false } = {}) {
    const target = $('#plfDolphinList');
    try {
      const r = await api('GET', '/api/planifier/dolphin-profiles');
      state.dolphinProfiles = r.profiles || [];
      state.dolphinWarnings = r.warnings || [];
      if (r.error) state.dolphinWarnings.push(r.error);
      renderDiagnostics();
      if (target) {
        if (state.dolphinProfiles.length === 0) {
          target.innerHTML = '<div style="padding:8px;color:#ffb347;">No Dolphin profiles found. Open Dolphin Anty, create profiles, then click Reload.</div>';
        } else {
          target.innerHTML = '<div class="plf-dolphin-grid">' + state.dolphinProfiles.map(p => `
            <div class="plf-dolphin-item ${p.proxy ? '' : 'no-proxy'}">
              <strong>${escapeHtml(p.name)}</strong>
              <span class="id">#${escapeHtml(p.id)}</span>
              <div class="meta">${p.proxy ? 'Proxy: ' + escapeHtml(p.proxy) : 'No proxy assigned'} · ${escapeHtml(p.platform || 'unknown')}</div>
            </div>
          `).join('') + '</div>';
        }
      }
      if (!silent) showToast(`Loaded ${state.dolphinProfiles.length} Dolphin profile(s)`, 'success');
      // Re-render the site config cards so their account dropdowns pick up
      // the newly loaded profiles. Without this, dropdowns stay stuck on
      // "— none —" if profiles weren't available at first render.
      if (state.activeTab === 'config' && state.dolphinProfiles.length > 0 && document.getElementById('plfSitesConfig')) {
        plfReadFormIntoConfig();   // preserve in-flight edits
        plfRenderSitesConfig();
      }
    } catch (e) {
      if (target) target.innerHTML = '<div style="padding:8px;color:#ff6b6b;">Failed: ' + escapeHtml(e.message) + '</div>';
      if (!silent) showToast('Dolphin load failed: ' + e.message, 'error');
    }
  }

  function renderDiagnostics() {
    const box = $('#plfDiagnostics');
    if (!box) return;
    const issues = [];
    state.dolphinWarnings.forEach(w => issues.push(w));

    // Check: any account with status≠disabled but no dolphinProfileId
    if (state.config) {
      for (const [siteName, site] of Object.entries(state.config.sites || {})) {
        if (siteName.startsWith('_')) continue;
        if (!site.enabled) continue;
        for (const acc of site.pinterestAccounts || []) {
          if (acc.status && acc.status !== 'disabled' && !acc.dolphinProfileId) {
            issues.push(`Site <strong>${escapeHtml(siteName)}</strong> account <strong>${escapeHtml(acc.id)}</strong> is "${escapeHtml(acc.status)}" but has no Dolphin profile assigned.`);
          }
        }
      }
      // Check: any active account whose profile has no proxy
      const byId = new Map(state.dolphinProfiles.map(p => [p.id, p]));
      for (const [siteName, site] of Object.entries(state.config.sites || {})) {
        if (siteName.startsWith('_')) continue;
        for (const acc of site.pinterestAccounts || []) {
          if (!acc.dolphinProfileId) continue;
          const p = byId.get(String(acc.dolphinProfileId));
          if (p && !p.proxy) {
            issues.push(`Dolphin profile <strong>${escapeHtml(p.name)}</strong> (assigned to ${escapeHtml(siteName)}/${escapeHtml(acc.id)}) has no proxy. Add a residential proxy in the Dolphin panel before going live.`);
          }
        }
      }
    }

    if (issues.length === 0) {
      box.style.display = 'none';
      return;
    }
    box.style.display = '';
    box.innerHTML = issues.map(msg => `<div class="plf-diagnostic-item">${msg}</div>`).join('');
  }

  // ── Multi-Site ───────────────────────────────────────────────
  //
  // Renders an editable table of all sites stored in the shared Google Sheet's
  // sites-config tab. Toggles for active + warming_enabled write back to the
  // sheet (and refresh the Planifier config cache on next tick).
  async function plfLoadSites({ fresh = false } = {}) {
    const tbody = document.getElementById('sitesTableBody');
    const statusEl = document.getElementById('sitesStatus');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">Loading${fresh ? ' (forced refresh)' : ''}...</td></tr>`;
    try {
      const r = await api('GET', `/api/sites-config${fresh ? '?fresh=1' : ''}`);
      const sites = r.sites || [];
      if (sites.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px;">No sites yet. Add one in the sheet directly, then refresh.</td></tr>`;
        return;
      }
      tbody.innerHTML = sites.map(s => `
        <tr data-site="${escapeHtml(s.site_id)}">
          <td><code>${escapeHtml(s.site_id)}</code></td>
          <td><input type="text" class="site-input" data-field="display_name" value="${escapeHtml(s.display_name || '')}" /></td>
          <td><input type="text" class="site-input" data-field="wp_url" value="${escapeHtml(s.wp_url || '')}" /></td>
          <td style="text-align:center;"><input type="checkbox" class="site-toggle" data-field="active" ${s.active ? 'checked' : ''}></td>
          <td style="text-align:center;"><input type="checkbox" class="site-toggle" data-field="warming_enabled" ${s.warming_enabled ? 'checked' : ''}></td>
          <td><input type="text" class="site-input" data-field="notes" value="${escapeHtml(s.notes || '')}" placeholder="optional" /></td>
          <td><button class="btn btn-primary btn-small site-save-btn" type="button">Save</button></td>
        </tr>
      `).join('');
      if (statusEl) statusEl.textContent = `${sites.length} site(s) loaded · ${sites.filter(s => s.active).length} active · ${sites.filter(s => s.warming_enabled).length} warming`;
      // Also load the boards-validation widget right after
      plfLoadBoardsValidation().catch(() => {});
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#f88;padding:24px;">Failed to load: ${escapeHtml(e.message)}</td></tr>`;
      if (e.message.includes('Missing') || e.message.includes('credentials')) {
        if (statusEl) statusEl.innerHTML = `<span style="color:#f88;">Google service-account credentials are missing.</span> See <code>scripts/init-sheet-v2.mjs</code> for setup.`;
      }
    }
  }

  // ── Boards validation widget ─────────────────────────────────
  //
  // For every active site x Pinterest account, fetches the cached validation
  // result (Pinterest boards vs site.wpCategories). Renders per-account cards.
  // Cache populates automatically when warming/Pinterest sessions run.
  async function plfLoadBoardsValidation() {
    const grid = document.getElementById('boardsValGrid');
    if (!grid) return;
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">Loading...</div>`;
    try {
      // Load sites + planifier config (for accounts)
      const [sitesRes, configRes] = await Promise.all([
        api('GET', '/api/sites-config'),
        api('GET', '/api/planifier/config'),
      ]);
      const sites = (sitesRes.sites || []).filter(s => s.active);
      const cfgSites = configRes?.sites || {};
      // Build (site, account) tuples
      const pairs = [];
      for (const s of sites) {
        const accs = cfgSites[s.site_id]?.pinterestAccounts || [];
        for (const a of accs) {
          if (a.status === 'disabled') continue;
          pairs.push({ site: s.site_id, displayName: s.display_name || s.site_id, accountId: a.id, accountStatus: a.status });
        }
      }
      if (pairs.length === 0) {
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-muted);padding:24px;font-size:13px;">No active accounts to validate. Configure Pinterest accounts in the Configuration tab.</div>`;
        return;
      }
      // Fetch all validations in parallel
      const results = await Promise.all(pairs.map(async p => {
        try {
          const r = await api('GET', `/api/planifier/boards-validation/${encodeURIComponent(p.site)}/${encodeURIComponent(p.accountId)}`);
          return { ...p, validation: r.validation };
        } catch { return { ...p, validation: null }; }
      }));
      // Render cards
      grid.innerHTML = results.map(r => _renderBoardsValCard(r)).join('');
    } catch (e) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:#f88;padding:24px;font-size:13px;">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function _renderBoardsValCard(r) {
    const { site, displayName, accountId, accountStatus, validation } = r;
    const runBtn = `<button class="btn btn-secondary btn-small boards-val-run-btn" data-site="${escapeHtml(site)}" data-account="${escapeHtml(accountId)}" type="button" title="Launch Dolphin + scrape Pinterest profile now (~30-60s)">↻ Run now</button>`;
    if (!validation) {
      return `
        <div class="boards-val-card boards-val-unchecked">
          <div class="boards-val-head">
            <strong>${escapeHtml(displayName)} / ${escapeHtml(accountId)}</strong>
            <span class="boards-val-badge unknown">— never run</span>
          </div>
          <div class="boards-val-meta">Account status: <code>${escapeHtml(accountStatus)}</code></div>
          <div class="boards-val-body" style="color:var(--text-muted);font-size:12px;">
            Will run automatically the next time a warming or Pinterest session fires for this account.
          </div>
          <div style="margin-top:8px;">${runBtn}</div>
        </div>
      `;
    }
    const present = validation.present || [];
    const missing = validation.missing || [];
    const extras  = validation.extras || [];
    const total = present.length + missing.length;
    const ratio = total > 0 ? Math.round((present.length / total) * 100) : 0;
    const status = missing.length === 0 ? 'ok' : (present.length === 0 ? 'bad' : 'warn');
    const ageMin = Math.floor((Date.now() - new Date(validation.validatedAt).getTime()) / 60000);
    const ageDisplay = ageMin < 60 ? `${ageMin}m ago` : ageMin < 1440 ? `${Math.floor(ageMin/60)}h ago` : `${Math.floor(ageMin/1440)}d ago`;
    return `
      <div class="boards-val-card boards-val-${status}">
        <div class="boards-val-head">
          <strong>${escapeHtml(displayName)} / ${escapeHtml(accountId)}</strong>
          <span class="boards-val-badge ${status}">${present.length}/${total} ok</span>
        </div>
        <div class="boards-val-meta">Status: <code>${escapeHtml(accountStatus)}</code> · last check: ${escapeHtml(ageDisplay)}</div>
        ${missing.length > 0 ? `
          <div class="boards-val-row missing">
            <span class="boards-val-row-label">⚠ Missing boards:</span>
            <span>${missing.map(m => `<span class="boards-val-pill missing">${escapeHtml(m)}</span>`).join('')}</span>
          </div>
        ` : ''}
        ${present.length > 0 ? `
          <div class="boards-val-row present">
            <span class="boards-val-row-label">✓ Present:</span>
            <span>${present.map(p => `<span class="boards-val-pill present">${escapeHtml(p)}</span>`).join('')}</span>
          </div>
        ` : ''}
        ${extras.length > 0 ? `
          <div class="boards-val-row extras">
            <span class="boards-val-row-label">＋ Extra boards (not used as keywords):</span>
            <span style="color:var(--text-muted);font-size:11px;">${extras.slice(0,8).map(e => escapeHtml(e)).join(' · ')}${extras.length > 8 ? ` … +${extras.length - 8} more` : ''}</span>
          </div>
        ` : ''}
        ${missing.length > 0 ? `
          <div class="boards-val-tip">
            <strong>How to fix:</strong> Open Pinterest, create boards named exactly like the missing categories. Match is case-insensitive partial so "Dinner Ideas" matches category "Dinner".
          </div>
        ` : ''}
        <div style="margin-top:6px;display:flex;justify-content:flex-end;">${runBtn}</div>
      </div>
    `;
  }

  // Delegated handlers for the sites table (refresh + per-row save)
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'sitesRefreshBtn') {
      e.preventDefault();
      await plfLoadSites({ fresh: true });
      return;
    }
    if (e.target.id === 'boardsValRefreshBtn') {
      e.preventDefault();
      await plfLoadBoardsValidation();
      return;
    }
    if (e.target.id === 'forceClearBusyBtn') {
      e.preventDefault();
      if (!confirm('Force-clear the "busy" flag?\n\nOnly do this if NOTHING is actually running (a previous job crashed without unwinding). If a session IS running, clearing this could let two browsers race.')) return;
      try {
        const r = await api('POST', '/api/force-clear-busy');
        _showToast(`Cleared (was=${r.wasBusy}${r.startedAt ? ', stuck since ' + new Date(r.startedAt).toLocaleTimeString() : ''})`);
      } catch (err) {
        _showToast('Failed: ' + err.message, true);
      }
      return;
    }
    const runBtn = e.target.closest('.boards-val-run-btn');
    if (runBtn) {
      e.preventDefault();
      const site = runBtn.dataset.site;
      const acc  = runBtn.dataset.account;
      if (!confirm(`Run validation for ${site}/${acc}?\n\nThis will launch the Dolphin profile and open Pinterest (~30-60s). Don't trigger if another automation is currently running.`)) return;
      const original = runBtn.textContent;
      runBtn.disabled = true;
      runBtn.textContent = '⏳ Running…';
      try {
        const r = await api('POST', `/api/planifier/boards-validation/${encodeURIComponent(site)}/${encodeURIComponent(acc)}/run`);
        _showToast(`Validation done: ${r.validation.present.length}/${r.validation.present.length + r.validation.missing.length} boards ok`);
        await plfLoadBoardsValidation();
      } catch (err) {
        _showToast('Validation failed: ' + err.message, true);
        runBtn.disabled = false;
        runBtn.textContent = original;
      }
      return;
    }
    const saveBtn = e.target.closest('.site-save-btn');
    if (!saveBtn) return;
    e.preventDefault();
    const row = saveBtn.closest('tr[data-site]');
    if (!row) return;
    const siteId = row.dataset.site;
    const patch = {};
    row.querySelectorAll('.site-input').forEach(inp => { patch[inp.dataset.field] = inp.value; });
    row.querySelectorAll('.site-toggle').forEach(inp => { patch[inp.dataset.field] = !!inp.checked; });
    const original = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api('PUT', `/api/sites-config/${encodeURIComponent(siteId)}`, patch);
      saveBtn.textContent = '✓ Saved';
      setTimeout(() => { saveBtn.textContent = original; saveBtn.disabled = false; }, 1500);
    } catch (err) {
      saveBtn.textContent = '✗ Error';
      setTimeout(() => { saveBtn.textContent = original; saveBtn.disabled = false; }, 2500);
      console.error('Save site failed:', err);
    }
  });

  // Tiny HTML escape for safe inline templating
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ── Calendar (FullCalendar) ──────────────────────────────────
  //
  // Renders pin-campaigns slots + planifier plan items on a unified month view.
  // Drag/drop reschedules campaign slots. Click a day to create. Click an
  // event to edit/delete. Color-coded by type.

  let _calInstance = null;   // FullCalendar instance, cached after init

  async function plfLoadCalendar() {
    const el = document.getElementById('planifierCalendar');
    if (!el) return;
    if (typeof FullCalendar === 'undefined') {
      el.innerHTML = '<p style="color:#f88;padding:20px;">FullCalendar library failed to load (check internet/CDN).</p>';
      return;
    }
    // Populate site filter once
    await _ensureCalSiteFilter();
    if (_calInstance) {
      _calInstance.refetchEvents();
      return;
    }
    _calInstance = new FullCalendar.Calendar(el, {
      initialView: 'timeGridWeek',   // default = Week view (shows time grid + "now" red line)
      headerToolbar: {
        left: 'prev,next today',
        center: 'title',
        right: 'timeGridWeek,timeGridDay,dayGridMonth,listWeek',
      },
      height: 'auto',
      firstDay: 1,                   // Monday
      editable: true,                // drag/drop ON
      droppable: false,
      dayMaxEvents: 4,
      eventDisplay: 'block',
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      nowIndicator: true,            // red "now" line in timeGrid views (like Google Calendar)
      scrollTime: '08:00:00',        // when entering week/day view, scroll to 8am by default
      slotDuration: '00:30:00',
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      allDaySlot: true,
      events: _calFetchEvents,
      eventClick: _calOnEventClick,
      dateClick: _calOnDateClick,
      eventDrop: _calOnEventDrop,
    });
    _calInstance.render();
    // Wire filter selectors → refetch on change
    document.getElementById('calSiteFilter')?.addEventListener('change', () => _calInstance.refetchEvents());
    document.getElementById('calTypeFilter')?.addEventListener('change', () => _calInstance.refetchEvents());
    document.getElementById('calNewCampaignBtn')?.addEventListener('click', () => _calOpenCampaignModal(null));
    // Type cards delegation
    document.getElementById('campaignTypeCards')?.addEventListener('change', _calOnTypeChange);
    document.getElementById('campaignSiteInput')?.addEventListener('change', _calOnSiteChange);
    document.getElementById('campaignSaveBtn')?.addEventListener('click', _calSaveCampaign);
    document.getElementById('campaignDeleteBtn')?.addEventListener('click', _calDeleteCampaign);
  }

  // Build event list from pin-campaigns + planifier 7-day plan items.
  async function _calFetchEvents(info, success, failure) {
    try {
      const siteFilter = document.getElementById('calSiteFilter')?.value || '';
      const typeFilter = document.getElementById('calTypeFilter')?.value || '';
      const events = [];

      // 1. Pin-campaigns from sheet → up to 3 events per campaign
      try {
        const r = await api('GET', `/api/pin-campaigns${siteFilter ? '?site=' + encodeURIComponent(siteFilter) : ''}`);
        for (const c of (r.campaigns || [])) {
          if (typeFilter && c.type !== typeFilter) continue;
          for (const slot of [1, 2, 3]) {
            const dateRaw = (c[`scheduled_date_${slot}`] || '').trim();
            const status = (c[`status_${slot}`] || 'pending').toLowerCase();
            if (!dateRaw || status === 'skip' || status === 'cancelled') continue;
            // Detect time component — works for "YYYY-MM-DDTHH:MM" AND
            // "YYYY-MM-DD HH:MM" (Google Sheets auto-converts T → space).
            const isDateTime = /\d{2}:\d{2}/.test(dateRaw);
            // Normalize space → T for FullCalendar (ISO 8601 strict)
            const date = isDateTime ? dateRaw.replace(' ', 'T') : dateRaw;
            events.push({
              id: `camp:${c.campaign_id}:${slot}`,
              title: `${c.type === 'regen-3pins' ? '🔄' : '＋'} ${c.recipe_title || '(untitled)'} · pin ${slot}`,
              start: date,
              allDay: !isDateTime,
              backgroundColor: _calColorByType(c.type, status),
              borderColor: _calColorByType(c.type, status),
              textColor: '#fff',
              extendedProps: {
                kind: 'campaign',
                campaignId: c.campaign_id,
                slot,
                campaign: c,
              },
              editable: status === 'pending',  // can't drag once posted
            });
          }
        }
      } catch (e) { console.warn('campaigns fetch failed', e); }

      // 2. Planifier 7-day plan items (read-only on calendar, just for awareness)
      try {
        const up = await api('GET', '/api/planifier/upcoming?days=14');
        for (const plan of (up.plans || up || [])) {
          for (const it of (plan.items || [])) {
            if (siteFilter && it.site !== siteFilter) continue;
            if (typeFilter && it.type !== typeFilter) continue;
            const done = (it.status === 'done' || it.status === 'posted');
            events.push({
              id: `plan:${plan.date}:${it.id}`,
              title: _calItemTitle(it),
              start: it.scheduledAt,
              allDay: false,
              backgroundColor: _calColorByType(it.type, it.status),
              borderColor: _calColorByType(it.type, it.status),
              textColor: '#fff',
              editable: false,
              extendedProps: { kind: 'planitem', planDate: plan.date, item: it },
            });
          }
        }
      } catch (e) { console.warn('upcoming fetch failed', e); }

      success(events);
    } catch (e) { failure(e); }
  }

  function _calItemTitle(it) {
    const iconByType = {
      'create-recipe': '🍳',
      'pinterest-session': '📌',
      'warming-session': '🔥',
    };
    const icon = iconByType[it.type] || '•';
    const acc = it.accountId ? `/${it.accountId}` : '';
    return `${icon} ${it.site}${acc} (${it.type})`;
  }

  function _calColorByType(type, status) {
    // Greyed-out for done/posted/error
    const s = (status || '').toLowerCase();
    if (s === 'done' || s === 'posted' || s === 'completed') return '#888';
    if (s === 'error' || s === 'failed') return '#f44336';
    const colors = {
      'regen-3pins': '#7c4dff',
      'single-pin': '#2196f3',
      'warming-session': '#ffc107',
      'pinterest-session': '#00c853',
      'create-recipe': '#ff7043',
    };
    return colors[type] || '#7c4dff';
  }

  // Drag/drop handler — only campaign slots are editable; updates one date in the sheet.
  async function _calOnEventDrop(info) {
    const ev = info.event;
    const props = ev.extendedProps;
    if (props.kind !== 'campaign') { info.revert(); return; }
    const slot = props.slot;
    // Preserve the time component if the event had one (timed → timed)
    const hadTime = !ev.allDay && ev.start;
    const newScheduled = hadTime
      ? `${ev.startStr.slice(0, 10)}T${ev.start.toTimeString().slice(0, 5)}:00`
      : ev.startStr.slice(0, 10);
    try {
      await api('PUT', `/api/pin-campaigns/${encodeURIComponent(props.campaignId)}`, {
        [`scheduled_date_${slot}`]: newScheduled,
      });
      _showToast(`Moved to ${hadTime ? newScheduled.replace('T', ' ') : newScheduled}`);
    } catch (e) {
      info.revert();
      _showToast(`Move failed: ${e.message}`, true);
    }
  }

  async function _calOnEventClick(info) {
    const props = info.event.extendedProps;
    if (props.kind === 'campaign') {
      _calOpenCampaignModal(props.campaign);
    } else if (props.kind === 'planitem') {
      // Read-only info popup — clicking a planifier item shows details
      const it = props.item;
      const ok = confirm(
        `Plan item details:\n\n` +
        `Type: ${it.type}\n` +
        `Site: ${it.site}\n` +
        `Account: ${it.accountId || '—'}\n` +
        `Scheduled: ${new Date(it.scheduledAt).toLocaleString()}\n` +
        `Status: ${it.status}\n\n` +
        `Open in Plan 7j to edit?`
      );
      if (ok) plfShowTab('plan');
    }
  }

  function _calOnDateClick(info) {
    // Pre-fill date 1 with the clicked day
    _calOpenCampaignModal(null, info.dateStr);
  }

  async function _ensureCalSiteFilter() {
    const sel = document.getElementById('calSiteFilter');
    const modalSel = document.getElementById('campaignSiteInput');
    if (!sel || sel.options.length > 1) return;
    try {
      const r = await api('GET', '/api/sites-config');
      for (const s of (r.sites || [])) {
        if (!s.active) continue;
        sel.appendChild(new Option(s.display_name || s.site_id, s.site_id));
        if (modalSel) modalSel.appendChild(new Option(s.display_name || s.site_id, s.site_id));
      }
    } catch {}
  }

  // Public entry point — opens calendar modal pre-filled for Create Pin.
  // Called from the Recipes tab's "＋ New Pin" button. Routes the user
  // through the calendar UI for date selection + template + slot.
  window.plfNewPinForRecipe = async function (site, draftUrl, topic) {
    // Switch to calendar tab first (initializes modal handlers if not loaded)
    plfShowTab('calendar');
    // Wait for the tab to render
    await new Promise(r => setTimeout(r, 250));
    // Pre-select Create Pin
    const radio = document.querySelector('input[name="campaignKind"][value="single-pin"]');
    if (radio) radio.checked = true;
    // Set site (triggers dropdowns refresh)
    const siteSel = document.getElementById('campaignSiteInput');
    if (siteSel) {
      siteSel.value = site;
      // Open modal first so the visibility logic kicks in
      _calOpenCampaignModal(null, new Date().toISOString().slice(0, 10));
      // Manually trigger refresh + pre-select the recipe after dropdown loads
      setTimeout(async () => {
        await _calRefreshRecipeDropdown();
        const recSel = document.getElementById('campaignRecipeSelect');
        if (recSel && draftUrl) {
          recSel.value = draftUrl;
          // If the URL isn't an exact match (legacy format diff), add it
          if (recSel.value !== draftUrl) {
            const opt = new Option(topic + ' (custom)', draftUrl, true, true);
            opt.dataset.title = topic;
            recSel.appendChild(opt);
            recSel.value = draftUrl;
          }
        }
        await _calRefreshTemplateGallery();
      }, 100);
    }
  };

  // ── Unified campaign modal — 4 action types ─────────────────
  //
  // The modal supports scheduling ANY of these via one form:
  //   - create-recipe   → POST /api/planifier/plan/:date/items     (planifier plan)
  //   - single-pin      → POST /api/pin-campaigns                  (sheet pin-campaigns)
  //   - regen-3pins     → POST /api/pin-campaigns                  (sheet pin-campaigns)
  //   - warming-session → POST /api/planifier/plan/:date/items     (planifier plan)
  //
  // Fields are conditionally shown based on selected type. Recipe/topic
  // dropdowns are loaded lazily when the site selection changes.

  let _recipeCache = new Map();   // siteId → { recipes, topics, at }
  const RECIPE_CACHE_TTL_MS = 60_000;

  function _calCurrentKind() {
    return document.querySelector('input[name="campaignKind"]:checked')?.value || '';
  }

  function _calApplyTypeVisibility(kind) {
    const map = {
      'create-recipe':   { topic: true,  recipe: false, account: false, template: false, slot: false, prefix: false, tags: false, dates2: false, time: true,  date1Label: 'Date' },
      'single-pin':      { topic: false, recipe: true,  account: false, template: true,  slot: true,  prefix: true,  tags: true,  dates2: false, time: true,  date1Label: 'Date' },
      'warming-session': { topic: false, recipe: false, account: true,  template: false, slot: false, prefix: false, tags: false, dates2: false, time: true,  date1Label: 'Date' },
    };
    const cfg = map[kind] || { topic: false, recipe: false, account: false, template: false, slot: false, prefix: false, tags: false, dates2: false, time: false };
    document.getElementById('campaignTopicWrap').style.display = cfg.topic ? '' : 'none';
    document.getElementById('campaignRecipeRecipeWrap').style.display = cfg.recipe ? '' : 'none';
    document.getElementById('campaignAccountWrap').style.display = cfg.account ? '' : 'none';
    document.getElementById('campaignTemplateWrap').style.display = cfg.template ? '' : 'none';
    document.getElementById('campaignSlotWrap').style.display = cfg.slot ? '' : 'none';
    const prefixWrap = document.getElementById('campaignPrefixWrap');
    if (prefixWrap) prefixWrap.style.display = cfg.prefix ? '' : 'none';
    const tagsWrap = document.getElementById('campaignTagsWrap');
    if (tagsWrap) tagsWrap.style.display = cfg.tags ? '' : 'none';
    document.getElementById('campaignDate2Wrap').style.display = cfg.dates2 ? '' : 'none';
    document.getElementById('campaignDate3Wrap').style.display = cfg.dates2 ? '' : 'none';
    document.getElementById('campaignTimeWrap').style.display = cfg.time ? '' : 'none';
    const lbl = document.getElementById('campaignDate1Label');
    if (lbl) lbl.textContent = cfg.date1Label || 'Date';

    // Visually highlight the active card
    document.querySelectorAll('.cal-type-card').forEach(card => {
      card.classList.toggle('active', card.dataset.type === kind);
    });
  }

  async function _calOnTypeChange() {
    const kind = _calCurrentKind();
    _calApplyTypeVisibility(kind);
    // For recipe-dependent types, refresh dropdowns
    if (kind === 'single-pin') { await _calRefreshRecipeDropdown(); await _calRefreshTemplateGallery(); }
    if (kind === 'create-recipe') await _calRefreshTopicDropdown();
    if (kind === 'warming-session') await _calRefreshAccountDropdown();
  }

  async function _calOnSiteChange() {
    const kind = _calCurrentKind();
    _recipeCache.clear();    // site changed, invalidate cache
    if (kind === 'single-pin') { await _calRefreshRecipeDropdown(); await _calRefreshTemplateGallery(); }
    if (kind === 'create-recipe') await _calRefreshTopicDropdown();
    if (kind === 'warming-session') await _calRefreshAccountDropdown();
  }

  async function _calLoadRecipes(siteId) {
    if (!siteId) return { recipes: [], topics: [] };
    const cached = _recipeCache.get(siteId);
    if (cached && Date.now() - cached.at < RECIPE_CACHE_TTL_MS) return cached;
    try {
      const r = await api('GET', `/api/sites/${encodeURIComponent(siteId)}/recipes`);
      const recipes = r.recipes || [];
      const data = {
        recipes: recipes.filter(x => x.draftUrl),  // recipes with a draft URL (post created)
        topics:  recipes.filter(x => x.isPending), // pending topics for create-recipe
        at: Date.now(),
      };
      _recipeCache.set(siteId, data);
      return data;
    } catch (e) {
      console.warn('Recipe fetch failed:', e);
      return { recipes: [], topics: [] };
    }
  }

  async function _calRefreshRecipeDropdown() {
    const sel = document.getElementById('campaignRecipeSelect');
    const loadEl = document.getElementById('campaignRecipeLoad');
    if (!sel) return;
    const siteId = document.getElementById('campaignSiteInput')?.value || '';
    if (!siteId) { sel.innerHTML = '<option value="">— pick a site first —</option>'; return; }
    loadEl.textContent = 'Loading posted recipes...';
    const { recipes } = await _calLoadRecipes(siteId);
    // POSTED ONLY — must be status=done AND have a draftUrl. Pinning to drafts
    // or pending recipes would 404. Hard guard at the source.
    const posted = recipes.filter(r => r.isDone && r.draftUrl);
    if (posted.length === 0) {
      sel.innerHTML = '<option value="">— no posted recipes for this site —</option>';
      loadEl.textContent = 'Only recipes with status=done and a draft URL appear here';
      return;
    }
    // Sort: most recent first (rowIndex descending)
    posted.sort((a, b) => (b.rowIndex || 0) - (a.rowIndex || 0));
    sel.innerHTML = '<option value="">— pick a posted recipe —</option>' +
      posted.map(r => `<option value="${escapeHtml(r.draftUrl)}" data-title="${escapeHtml(r.topic)}">${escapeHtml(r.topic)}</option>`).join('');
    loadEl.textContent = `${posted.length} posted recipes available · only published ones can receive new pins`;
  }

  // ── Template thumbnail gallery (uses /api/planifier/regen-assets) ───
  async function _calRefreshTemplateGallery() {
    const box = document.getElementById('campaignTemplateGallery');
    const hidden = document.getElementById('campaignTemplateInput');
    if (!box) return;
    const siteId = document.getElementById('campaignSiteInput')?.value || '';
    if (!siteId) {
      box.innerHTML = '<div class="cal-template-empty">Pick a site first to load templates...</div>';
      hidden.value = '';
      return;
    }
    box.innerHTML = '<div class="cal-template-empty">Loading templates…</div>';
    try {
      const r = await api('GET', `/api/planifier/regen-assets/${encodeURIComponent(siteId)}`);
      const pool = (r.templatesGenerator?.length ? r.templatesGenerator : r.templatesScraper) || [];
      if (pool.length === 0) {
        box.innerHTML = '<div class="cal-template-empty" style="color:#ffb347;">⚠ No templates in backgrounds.json — add some via Settings → Images.</div>';
        return;
      }
      const randomOption = `
        <div class="cal-template-thumb" data-name="" title="Random pick at generation time">
          <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:rgba(124,77,255,0.08);font-size:11px;text-align:center;padding:8px;color:#b8a4ff;">🎲<br>Random<br>(any template)</div>
          <div class="caption">Random</div>
        </div>`;
      box.innerHTML = randomOption + pool.map(t => `
        <div class="cal-template-thumb" data-name="${escapeHtml(t.name)}" title="${escapeHtml(t.name)}">
          <img src="${escapeHtml(t.thumbDataUrl)}" alt="${escapeHtml(t.name)}" />
          <div class="caption">${escapeHtml(t.name)}</div>
        </div>
      `).join('');
      // Wire selection
      box.querySelectorAll('.cal-template-thumb').forEach(thumb => {
        thumb.addEventListener('click', () => {
          box.querySelectorAll('.cal-template-thumb').forEach(t => t.classList.remove('selected'));
          thumb.classList.add('selected');
          hidden.value = thumb.dataset.name;
        });
      });
    } catch (e) {
      box.innerHTML = `<div class="cal-template-empty" style="color:#f88;">Failed to load: ${escapeHtml(e.message)}</div>`;
    }
  }

  async function _calRefreshTopicDropdown() {
    const sel = document.getElementById('campaignTopicSelect');
    const loadEl = document.getElementById('campaignTopicLoad');
    if (!sel) return;
    const siteId = document.getElementById('campaignSiteInput')?.value || '';
    if (!siteId) { sel.innerHTML = '<option value="">— pick a site first —</option>'; return; }
    loadEl.textContent = 'Loading pending topics...';
    const { topics } = await _calLoadRecipes(siteId);
    if (topics.length === 0) {
      sel.innerHTML = '<option value="">— no pending topics — orchestrator will create from sheet —</option>';
      loadEl.textContent = 'No pending topics in sheet (will pick auto when scheduled fires)';
      return;
    }
    sel.innerHTML = '<option value="">— auto-pick next pending —</option>' +
      topics.map(t => `<option value="${escapeHtml(t.topic)}" data-row="${t.rowIndex}">${escapeHtml(t.topic)}</option>`).join('');
    loadEl.textContent = `${topics.length} pending topics in sheet`;
  }

  async function _calRefreshAccountDropdown() {
    const sel = document.getElementById('campaignAccountSelect');
    if (!sel) return;
    const siteId = document.getElementById('campaignSiteInput')?.value || '';
    sel.innerHTML = '<option value="">— pick a site first —</option>';
    if (!siteId) return;
    try {
      const cfg = await api('GET', '/api/planifier/config');
      const accs = cfg?.sites?.[siteId]?.pinterestAccounts || [];
      sel.innerHTML = accs.length === 0
        ? '<option value="">— no Pinterest accounts configured —</option>'
        : accs.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.id)} · ${escapeHtml(a.status || '')}${a.dolphinProfileId ? ' · dolphin#' + a.dolphinProfileId : ''}</option>`).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">— failed to load accounts —</option>';
    }
  }

  function _calOpenCampaignModal(campaign, defaultDate = '') {
    const modal = document.getElementById('campaignModal');
    if (!modal) return;
    const isEdit = !!campaign;
    document.getElementById('campaignModalTitle').textContent = isEdit ? 'Edit Event' : 'New Event';
    document.getElementById('campaignIdInput').value = campaign?.campaign_id || '';
    document.getElementById('campaignSiteInput').value = campaign?.site || '';
    // Edits only work on pin-campaigns rows for now (single-pin / regen-3pins)
    const initialKind = campaign?.type || 'create-recipe';
    const radio = document.querySelector(`input[name="campaignKind"][value="${initialKind}"]`);
    if (radio) radio.checked = true;
    document.getElementById('campaignTemplateInput').value = campaign?.template || '';
    document.getElementById('campaignDate1Input').value = (campaign?.scheduled_date_1 || defaultDate || '').slice(0, 10);
    document.getElementById('campaignDate2Input').value = (campaign?.scheduled_date_2 || '').slice(0, 10);
    document.getElementById('campaignDate3Input').value = (campaign?.scheduled_date_3 || '').slice(0, 10);
    // Extract time component from scheduled_date_1 — accepts both
    // "YYYY-MM-DDTHH:MM:SS" and "YYYY-MM-DD HH:MM:SS" (Sheets auto-converts T → space)
    const date1Raw = campaign?.scheduled_date_1 || '';
    const timeMatch = date1Raw.match(/[T ](\d{2}:\d{2})/);
    document.getElementById('campaignTimeInput').value = timeMatch ? timeMatch[1] : '';
    // Strip the slot=X, prefix=X, tags=X markers from notes display
    const rawNotes = campaign?.notes || '';
    const cleanNotes = rawNotes
      .replace(/\s*·?\s*slot=[^·]+/g, '')
      .replace(/\s*·?\s*prefix=[^·]+/g, '')
      .replace(/\s*·?\s*tags=[^·]+/g, '')
      .trim();
    document.getElementById('campaignNotesInput').value = cleanNotes;
    const slotMatch = rawNotes.match(/slot=([^\s·]+)/);
    const slotEl = document.getElementById('campaignSlotInput');
    if (slotEl && slotMatch) slotEl.value = slotMatch[1];
    // Extract prefix (everything after "prefix=" up to next ·)
    const prefixMatch = rawNotes.match(/prefix=([^·]+)/);
    const prefixEl = document.getElementById('campaignPrefixInput');
    if (prefixEl) prefixEl.value = prefixMatch ? prefixMatch[1].trim() : '';
    // Extract tags (everything after "tags=" up to next ·)
    const tagsMatch = rawNotes.match(/tags=([^·]+)/);
    const tagsEl = document.getElementById('campaignTagsInput');
    if (tagsEl) tagsEl.value = tagsMatch ? tagsMatch[1].trim() : '';
    document.getElementById('campaignDeleteBtn').style.display = isEdit ? '' : 'none';

    // Disable type switching when editing (the event is bound to a type)
    document.querySelectorAll('input[name="campaignKind"]').forEach(r => {
      r.disabled = isEdit && r.value !== initialKind;
    });

    _calApplyTypeVisibility(initialKind);
    modal.style.display = 'flex';
    // Scroll modal-body to TOP each open so user sees the type cards first
    const modalBody = modal.querySelector('.plf-modal-body');
    if (modalBody) modalBody.scrollTop = 0;

    // After paint, refresh dropdowns + gallery if the site is already set
    setTimeout(() => {
      if (initialKind === 'single-pin') {
        _calRefreshRecipeDropdown().then(() => {
          if (campaign?.recipe_url) document.getElementById('campaignRecipeSelect').value = campaign.recipe_url;
        });
        _calRefreshTemplateGallery().then(() => {
          if (campaign?.template) {
            const thumb = document.querySelector(`.cal-template-thumb[data-name="${campaign.template.replace(/"/g, '\\"')}"]`);
            if (thumb) thumb.click();
          }
        });
      } else if (initialKind === 'create-recipe') {
        _calRefreshTopicDropdown();
      } else if (initialKind === 'warming-session') {
        _calRefreshAccountDropdown();
      }
    }, 50);
  }

  /**
   * Save — routes to the right backend based on the selected kind.
   */
  async function _calSaveCampaign() {
    const id = document.getElementById('campaignIdInput').value;
    const kind = _calCurrentKind();
    const site = document.getElementById('campaignSiteInput').value;
    const notes = document.getElementById('campaignNotesInput').value.trim();
    const date1 = document.getElementById('campaignDate1Input').value;
    if (!site) { _showToast('Site required', true); return; }
    if (!kind) { _showToast('Pick an event type', true); return; }
    if (!date1) { _showToast('Date is required', true); return; }

    try {
      // ── pin-campaigns backend (single-pin only — creates NEW pin, no overwrite) ──
      if (kind === 'single-pin') {
        const recipeSel = document.getElementById('campaignRecipeSelect');
        const recipe_url = recipeSel.value;
        const recipe_title = recipeSel.options[recipeSel.selectedIndex]?.dataset.title || '';
        if (!recipe_url) { _showToast('Pick a posted recipe', true); return; }
        const slot = document.getElementById('campaignSlotInput')?.value || 'extra';
        const prefix = (document.getElementById('campaignPrefixInput')?.value || '').trim();
        const tagsRaw = (document.getElementById('campaignTagsInput')?.value || '').trim();
        // Combine date + time → ISO datetime (so executor honors the time)
        const time = (document.getElementById('campaignTimeInput')?.value || '').trim();
        const scheduled1 = time
          ? `${date1}T${time}:00`            // e.g. "2026-05-24T14:30:00"
          : date1;                            // date only (fires anytime that day)
        // Encode slot + prefix + tags in notes (parsed by campaigns-executor)
        // Tags format: "tags=A,B,C" — pipe-separator used so commas in tag names survive
        const notesParts = [];
        if (notes) notesParts.push(notes);
        notesParts.push(`slot=${slot}`);
        if (prefix) notesParts.push(`prefix=${prefix}`);
        if (tagsRaw) notesParts.push(`tags=${tagsRaw.replace(/·/g, '')}`);  // strip · which is our separator
        const payload = {
          site, type: kind,
          recipe_url, recipe_title,
          template: document.getElementById('campaignTemplateInput').value.trim(),
          scheduled_date_1: scheduled1,
          scheduled_date_2: '',
          scheduled_date_3: '',
          notes: notesParts.join(' · '),
        };
        if (id) await api('PUT', `/api/pin-campaigns/${encodeURIComponent(id)}`, payload);
        else    await api('POST', '/api/pin-campaigns', payload);
        _showToast(id ? 'Pin update saved' : `New pin scheduled${time ? ' for ' + time : ''}`);
      }
      // ── planifier plan backend (create-recipe / warming-session) ─
      else if (kind === 'create-recipe' || kind === 'warming-session') {
        const time = document.getElementById('campaignTimeInput').value || '';  // HH:MM optional
        const accountId = kind === 'warming-session'
          ? document.getElementById('campaignAccountSelect').value
          : null;
        if (kind === 'warming-session' && !accountId) { _showToast('Pick a Pinterest account', true); return; }
        const payload = {
          type: kind,
          site,
          accountId: accountId || null,
          scheduledAt: time,    // HH:MM — server converts to ISO using :date param
          locked: true,         // manually-scheduled events are locked (survive plan regen)
        };
        await api('POST', `/api/planifier/plan/${encodeURIComponent(date1)}/items`, payload);
        _showToast(`Scheduled ${kind} on ${date1}`);
      }
      document.getElementById('campaignModal').style.display = 'none';
      _calInstance?.refetchEvents();
    } catch (e) {
      _showToast('Save failed: ' + e.message, true);
    }
  }

  async function _calDeleteCampaign() {
    const id = document.getElementById('campaignIdInput').value;
    if (!id) return;
    if (!confirm('Cancel all 3 slots of this campaign? (soft delete — row stays in sheet)')) return;
    try {
      await api('DELETE', `/api/pin-campaigns/${encodeURIComponent(id)}`);
      document.getElementById('campaignModal').style.display = 'none';
      _calInstance?.refetchEvents();
      _showToast('Campaign cancelled');
    } catch (e) {
      _showToast('Delete failed: ' + e.message, true);
    }
  }

  // Lightweight toast (no dependency). Bottom-right, fades out.
  function _showToast(msg, isError = false) {
    let host = document.getElementById('plfToastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'plfToastHost';
      host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `padding:10px 16px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,0.3);max-width:340px;background:${isError ? '#f44336' : '#7c4dff'};opacity:0;transform:translateY(10px);transition:opacity 0.2s,transform 0.2s;`;
    host.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
    setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; setTimeout(() => t.remove(), 250); }, 3500);
  }

  // ── Overview ─────────────────────────────────────────────────
  async function plfLoadOverview() {
    try {
      const today = todayKey();
      const config = state.config || await api('GET', '/api/planifier/config');
      state.config = config;

      // Stat aggregates
      let recipesPerDay = 0;
      let pinsPerDay = 0;
      let activeAccounts = 0;
      for (const [siteName, site] of Object.entries(config.sites || {})) {
        if (siteName.startsWith('_')) continue;
        if (!site.enabled) continue;
        const minR = Number(site.recipesPerDayMin) || 0;
        const maxR = Number(site.recipesPerDayMax) || 0;
        recipesPerDay += (minR + maxR) / 2;
        for (const acc of site.pinterestAccounts || []) {
          if (acc.status === 'active' || acc.status === 'warmup_week_2') {
            activeAccounts++;
            const minP = Number(acc.pinsPerDayMin) || 0;
            const maxP = Number(acc.pinsPerDayMax) || 0;
            pinsPerDay += (minP + maxP) / 2;
          }
        }
      }

      // Today's plan (auto-generate if missing)
      let plan = await api('GET', `/api/planifier/plan/${today}`);
      if (plan.notFound) {
        const r = await api('POST', `/api/planifier/plan/${today}/regenerate`);
        plan = r.plan;
      }

      $('#plfStatToday').textContent = plan.items.length;
      $('#plfStatRecipes').textContent = recipesPerDay.toFixed(1);
      $('#plfStatPins').textContent = pinsPerDay.toFixed(1);
      $('#plfStatAccounts').textContent = activeAccounts;

      renderTodayTimeline(plan);
      renderDiagnostics();
    } catch (e) {
      console.error('[Planifier] overview error:', e);
      $('#plfTodayTimeline').innerHTML = `<div class="plf-timeline-empty">Load failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderTodayTimeline(plan) {
    const box = $('#plfTodayTimeline');
    if (!box) return;
    if (!plan.items || plan.items.length === 0) {
      box.innerHTML = `<div class="plf-timeline-empty">No actions scheduled for today${plan.globalSkip ? ' (global skip day)' : ''}.</div>`;
      return;
    }
    // Find the next pending slot for the countdown header
    const nextPending = plan.items.find(i => i.status === 'pending');
    const headerCountdown = nextPending
      ? `<div style="padding:10px 14px;background:rgba(110,168,254,0.06);border:1px solid rgba(110,168,254,0.18);border-radius:8px;margin-bottom:12px;font-size:12px;color:#9a9ab8;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;">
           <span>⏱ <strong style="color:#6ea8fe;">Next slot:</strong> ${escapeHtml(fmtTimeFull(nextPending.scheduledAt))} <span style="color:#6a6a8e;">(${escapeHtml(fmtRelative(nextPending.scheduledAt))})</span></span>
           <span style="color:#6a6a8e;">Now: ${new Date().toLocaleTimeString()} · TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
         </div>`
      : `<div style="padding:10px 14px;background:rgba(120,120,150,0.06);border:1px solid rgba(120,120,150,0.18);border-radius:8px;margin-bottom:12px;font-size:12px;color:#9a9ab8;">No more pending slots today · Now: ${new Date().toLocaleTimeString()}</div>`;

    box.innerHTML = headerCountdown + '<div class="plf-timeline">' + plan.items.map(item => {
      const typeIcon = item.type === 'create-recipe'
        ? '<div class="plf-timeline-icon recipe">R</div>'
        : (item.willPost
            ? '<div class="plf-timeline-icon pinterest">P</div>'
            : '<div class="plf-timeline-icon browse">B</div>');
      const meta = item.type === 'create-recipe'
        ? `Recipe creation — <strong>${escapeHtml(item.site)}</strong>`
        : `Pinterest — <strong>${escapeHtml(item.site)}</strong> / <span class="small">${escapeHtml(item.accountId)}</span>${item.willPost ? '' : ' <span class="small">(browse only)</span>'}`;
      const isDone = item.status === 'done';
      const isError = item.status === 'error';
      const isRunning = item.status === 'in_progress';
      const runIcon = isDone || isError ? '🔁' : '▶';
      const runLabel = isDone ? 'Re-run' : (isError ? 'Retry' : 'Run now');
      const runBg = isDone
        ? 'background:rgba(184,164,255,0.15);color:#b8a4ff;border:1px solid rgba(184,164,255,0.3);'
        : isError
        ? 'background:rgba(255,179,71,0.15);color:#ffb347;border:1px solid rgba(255,179,71,0.3);'
        : 'background:rgba(0,214,143,0.15);color:#00d68f;border:1px solid rgba(0,214,143,0.3);';
      const runBtn = isRunning
        ? '<span class="plf-quick-run" style="background:rgba(33,150,243,0.12);color:#6ea8fe;border:1px solid rgba(33,150,243,0.3);">⏳ Running</span>'
        : `<button class="plf-quick-run" data-date="${escapeHtml(plan.date)}" data-id="${escapeHtml(item.id)}" data-force="${isDone || isError ? '1' : '0'}" style="${runBg}" title="${runLabel}">${runIcon} ${runLabel}</button>`;
      const rel = item.status === 'pending' ? fmtRelative(item.scheduledAt) : '';
      return `
        <div class="plf-timeline-item ${item.locked ? 'locked' : ''}" data-date="${escapeHtml(plan.date)}" data-id="${escapeHtml(item.id)}">
          <div class="plf-timeline-time" title="${escapeHtml(fmtTimeFull(item.scheduledAt))} · ${escapeHtml(item.scheduledAt)}">
            ${fmtTime(item.scheduledAt)}
            ${rel ? `<div style="font-size:10px;color:#6a6a8e;font-weight:500;margin-top:1px;font-family:inherit;">${escapeHtml(rel)}</div>` : ''}
          </div>
          ${typeIcon}
          <div class="plf-timeline-meta">${meta}${item.locked ? ' <span style="color:#ffb347;font-size:10px;">🔒 locked</span>' : ''}</div>
          <span class="plf-timeline-badge ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>
          ${runBtn}
        </div>
      `;
    }).join('') + '</div>';

    // Wire clicks to open edit modal (whole row) + inline Run button
    $$('.plf-timeline-item', box).forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.plf-quick-run')) return;  // let button handler run
        openSlotModal(el.dataset.date, el.dataset.id);
      });
    });
    $$('.plf-quick-run', box).forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const date = btn.dataset.date;
        const itemId = btn.dataset.id;
        const force = btn.dataset.force === '1';
        if (force && !confirm('This slot is already done. Re-run it?')) return;
        try {
          await api('POST', `/api/planifier/plan/${date}/items/${itemId}/run`, { force });
          showToast('Started — opening live view…', 'success');
          openSlotModal(date, itemId);
          // The modal's pollItemStatus kicks in automatically when Run Now is clicked
          // — but here we triggered via inline. Reach into the polling helper:
          setTimeout(() => {
            const sb = document.getElementById('plfModalRunStatus');
            if (sb) {
              sb.style.display = '';
              sb.textContent = '🚀 Running — live status below';
              pollItemStatus(date, itemId);
            }
          }, 300);
        } catch (err) {
          showToast('Run failed: ' + err.message, 'error');
        }
      });
    });
  }

  async function plfRegenToday() {
    try {
      const r = await api('POST', `/api/planifier/plan/${todayKey()}/regenerate`);
      renderTodayTimeline(r.plan);
      showToast('Today\'s plan regenerated', 'success');
      plfLoadOverview();
    } catch (e) {
      showToast('Regenerate failed: ' + e.message, 'error');
    }
  }

  // ── Configuration panel ──────────────────────────────────────
  async function plfRenderConfigPanel() {
    if (!state.config) state.config = await api('GET', '/api/planifier/config');
    await plfLoadDolphinConnection();
    if (state.dolphinProfiles.length === 0) await plfLoadDolphinProfiles({ silent: true });
    plfRenderSitesConfig();
    plfRenderRulesPanel();   // also populate rules tab fields
    plfRenderWhatsAppConfig();
    renderDiagnostics();
  }

  function plfRenderWhatsAppConfig() {
    // Renamed conceptually to Telegram — kept the function name to avoid touching the call site
    const tg = state.config?.notifications?.telegram || {};
    if ($('#plfTgToken')) {
      const t = tg.botToken || '';
      if (t) $('#plfTgToken').placeholder = t.slice(0, 12) + '...' + t.slice(-4);
    }
    if ($('#plfTgChatId')) $('#plfTgChatId').value = tg.chatId || '';
    if ($('#plfTgEnabled')) $('#plfTgEnabled').checked = !!tg.enabled;
    if ($('#plfTgNotifyError')) $('#plfTgNotifyError').checked = tg.notifyOnError !== false;
    if ($('#plfTgNotifySuccess')) $('#plfTgNotifySuccess').checked = !!tg.notifyOnSuccess;
  }

  window.plfFetchChatId = async function () {
    const statusEl = $('#plfTgStatus');
    if (statusEl) { statusEl.textContent = 'Fetching…'; statusEl.style.color = '#9a9ab8'; }
    const botToken = $('#plfTgToken').value.trim();
    if (!botToken) {
      statusEl.textContent = '✗ Paste bot token first';
      statusEl.style.color = '#ff8585';
      return;
    }
    try {
      const r = await api('POST', '/api/planifier/notifications/fetch-chatid', { botToken });
      if (r.ok) {
        $('#plfTgChatId').value = r.chatId;
        statusEl.textContent = `✓ Found chat: ${r.chatName} (id ${r.chatId})`;
        statusEl.style.color = '#00d68f';
      } else {
        statusEl.textContent = '✗ ' + (r.error || 'failed');
        statusEl.style.color = '#ffb347';
      }
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = '#ff8585';
    }
  };

  window.plfTestTelegram = async function () {
    const statusEl = $('#plfTgStatus');
    if (statusEl) { statusEl.textContent = 'Sending…'; statusEl.style.color = '#9a9ab8'; }
    const botToken = $('#plfTgToken').value.trim();
    const chatId = $('#plfTgChatId').value.trim();
    if (!botToken || !chatId) {
      statusEl.textContent = '✗ Token + chat ID required';
      statusEl.style.color = '#ff8585';
      return;
    }
    try {
      const r = await api('POST', '/api/planifier/notifications/test-telegram', { botToken, chatId });
      if (r.ok) {
        statusEl.textContent = '✓ Sent! Check your Telegram.';
        statusEl.style.color = '#00d68f';
        plfReadFormIntoConfig();
        await api('POST', '/api/planifier/config', state.config);
      } else {
        statusEl.textContent = '✗ ' + (r.error || 'Failed');
        statusEl.style.color = '#ff8585';
      }
    } catch (e) {
      statusEl.textContent = '✗ ' + e.message;
      statusEl.style.color = '#ff8585';
    }
  };

  // ── Dolphin connection card ──────────────────────────────────
  async function plfLoadDolphinConnection() {
    try {
      const r = await api('GET', '/api/planifier/dolphin/config');
      const cloudEl = $('#plfDolphinCloud');
      const localEl = $('#plfDolphinLocal');
      const tokenEl = $('#plfDolphinToken');
      if (cloudEl) cloudEl.value = r.cloudApi || '';
      if (localEl) localEl.value = r.localApi || '';
      // Pre-fill the masked token as placeholder so user sees something
      if (tokenEl && r.hasToken) {
        tokenEl.placeholder = `Saved: ${r.masked} (paste to replace)`;
      }
      renderDolphinStatus(r.lastTestResult, r);
    } catch (e) {
      console.warn('[Planifier] dolphin config load failed:', e.message);
    }
  }

  function renderDolphinStatus(lastResult, cfg = {}) {
    const box = $('#plfDolphinStatus');
    if (!box) return;
    if (!cfg.hasToken) {
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:10px;height:10px;border-radius:50%;background:#ff6b6b;"></div>
          <strong style="color:#ff6b6b;">No token configured</strong>
          <span style="color:#9a9ab8;">— Paste your Dolphin JWT below and click Test.</span>
        </div>
      `;
      return;
    }
    if (!lastResult) {
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:10px;height:10px;border-radius:50%;background:#888;"></div>
          <strong>Token saved</strong>
          <span style="color:#9a9ab8;">— Click <strong>Test Connection</strong> to verify.</span>
          <span style="margin-left:auto;font-size:11px;color:#6a6a8e;">Source: ${escapeHtml(cfg.source || 'unknown')}</span>
        </div>
      `;
      return;
    }
    const planColor = lastResult.plan === 'free' ? '#ffb347' : '#00d68f';
    const dot = lastResult.ok ? '#00d68f' : '#ffb347';
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="width:10px;height:10px;border-radius:50%;background:${dot};box-shadow:0 0 8px ${dot};"></div>
        <strong style="color:${dot};">${lastResult.ok ? '✓ Connected' : '⚠ Issue'}</strong>
        <span style="padding:3px 10px;border-radius:999px;background:rgba(${lastResult.plan==='free'?'255,179,71':'0,214,143'},0.12);color:${planColor};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;">
          Plan: ${escapeHtml(lastResult.plan || 'unknown')}
        </span>
        <span style="font-size:12px;color:#c8c8e8;">${lastResult.profileCount} profiles</span>
        ${lastResult.expiresInDays != null ? `<span style="font-size:11px;color:#6a6a8e;">Expires in ${lastResult.expiresInDays} days</span>` : ''}
      </div>
    `;
  }

  window.plfToggleTokenVisibility = function () {
    const el = $('#plfDolphinToken');
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  };

  window.plfTestDolphin = async function () {
    const statusEl = $('#plfDolphinTestStatus');
    if (statusEl) statusEl.textContent = 'Testing…';
    const tokenInput = $('#plfDolphinToken').value.trim();
    const cloudApi = $('#plfDolphinCloud').value.trim() || undefined;
    const localApi = $('#plfDolphinLocal').value.trim() || undefined;
    try {
      const body = { cloudApi, localApi };
      if (tokenInput) body.apiToken = tokenInput;
      const diag = await api('POST', '/api/planifier/dolphin/test', body);
      renderDolphinDiagnostic(diag);
      if (statusEl) statusEl.textContent = diag.ok ? '✓ Test passed' : '⚠ See details';
    } catch (e) {
      if (statusEl) statusEl.textContent = '✗ Failed: ' + e.message;
      showToast('Test failed: ' + e.message, 'error');
    }
  };

  function renderDolphinDiagnostic(diag) {
    const box = $('#plfDolphinStatus');
    if (!box) return;
    const dot = diag.ok ? '#00d68f' : (diag.error ? '#ff6b6b' : '#ffb347');
    const planColor = diag.plan === 'free' ? '#ffb347' : '#00d68f';
    const warningsHtml = (diag.warnings || []).map(w => `<div class="plf-diagnostic-item">${escapeHtml(w)}</div>`).join('');
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:${warningsHtml ? '12px' : '0'};">
        <div style="width:10px;height:10px;border-radius:50%;background:${dot};box-shadow:0 0 8px ${dot};"></div>
        <strong style="color:${dot};">${diag.ok ? '✓ Connection healthy' : (diag.error ? '✗ Failed' : '⚠ Issues found')}</strong>
        ${diag.plan ? `<span style="padding:3px 10px;border-radius:999px;background:rgba(${diag.plan==='free'?'255,179,71':'0,214,143'},0.12);color:${planColor};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;">Plan: ${escapeHtml(diag.plan)}</span>` : ''}
        <span style="font-size:12px;color:#c8c8e8;">${diag.profileCount} profiles</span>
        ${diag.expiresInDays != null ? `<span style="font-size:11px;color:#6a6a8e;">Expires in ${diag.expiresInDays}d</span>` : ''}
        <span style="font-size:11px;color:#6a6a8e;margin-left:auto;">
          Cloud: ${diag.cloudReachable ? '<span style="color:#00d68f;">✓</span>' : '<span style="color:#ff6b6b;">✗</span>'} ·
          Local app: ${diag.localReachable ? '<span style="color:#00d68f;">✓</span>' : '<span style="color:#ffb347;">○</span>'}
        </span>
      </div>
      ${warningsHtml}
    `;
  }

  window.plfSaveDolphinToken = async function () {
    const statusEl = $('#plfDolphinTestStatus');
    const token = $('#plfDolphinToken').value.trim();
    const cloudApi = $('#plfDolphinCloud').value.trim() || undefined;
    const localApi = $('#plfDolphinLocal').value.trim() || undefined;
    if (!token) {
      showToast('Paste a token first', 'error');
      return;
    }
    if (statusEl) statusEl.textContent = 'Saving + testing…';
    try {
      const r = await api('POST', '/api/planifier/dolphin/save-token', { apiToken: token, cloudApi, localApi });
      renderDolphinDiagnostic(r.diagnostic);
      if (statusEl) statusEl.textContent = r.diagnostic.ok ? '✓ Saved and verified' : '✓ Saved (with warnings)';
      $('#plfDolphinToken').value = '';
      $('#plfDolphinToken').placeholder = `Saved: ${token.slice(0,18)}…${token.slice(-12)} (paste to replace)`;
      showToast('Dolphin token saved', 'success');
      // Reload profiles + diagnostics
      plfLoadDolphinProfiles({ silent: true });
    } catch (e) {
      if (statusEl) statusEl.textContent = '✗ ' + e.message;
      showToast('Save failed: ' + e.message, 'error');
    }
  };

  function plfRenderSitesConfig() {
    const container = $('#plfSitesConfig');
    if (!container) return;
    const dolphinOptions = state.dolphinProfiles.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} #${escapeHtml(p.id)}${p.proxy ? '' : ' (no proxy)'}</option>`
    ).join('');
    const statusOptions = state.meta.accountStatuses.map(s =>
      `<option value="${escapeHtml(s.key)}">${escapeHtml(s.label)}</option>`
    ).join('');
    const strategyOptions = state.meta.pinStrategies.map(s =>
      `<option value="${escapeHtml(s.key)}">${escapeHtml(s.label)}</option>`
    ).join('');

    const sites = Object.entries(state.config.sites || {})
      .filter(([name]) => !name.startsWith('_'));

    if (sites.length === 0) {
      container.innerHTML = '<div class="card"><div class="card-body" style="color:#9a9ab8;">No sites found. Create a site in the Sites tab first.</div></div>';
      return;
    }

    container.innerHTML = sites.map(([siteName, site]) => `
      <div class="plf-site-card" data-site="${escapeHtml(siteName)}">
        <div class="plf-site-header">
          <label class="plf-switch" style="width:46px;height:26px;">
            <input type="checkbox" class="plf-site-enabled" ${site.enabled ? 'checked' : ''} />
            <span class="plf-switch-slider"></span>
          </label>
          <div class="plf-site-name">${escapeHtml(siteName)}</div>
        </div>
        <div class="plf-site-body">
          <div class="plf-site-row">
            <div class="plf-rule-field">
              <label>Sheet tab <small style="color:#6a6a8e;font-weight:400;text-transform:none;">— which Google Sheet tab to read for this site</small></label>
              <select class="plf-site-sheetTab" data-current="${escapeHtml(site.sheetTab || '')}"><option value="">(loading…)</option></select>
            </div>
            <div class="plf-rule-field">
              <label>Pin distribution</label>
              <select class="plf-site-strategy">${strategyOptions.replace(`value="${site.pinDistribution || 'strategy_A'}"`, `value="${site.pinDistribution || 'strategy_A'}" selected`)}</select>
            </div>
          </div>
          <div class="plf-site-row">
            <div class="plf-rule-field">
              <label>Recipes / day (min)</label>
              <input type="number" class="plf-site-rmin" min="0" value="${Number(site.recipesPerDayMin) || 0}" />
            </div>
            <div class="plf-rule-field">
              <label>Recipes / day (max)</label>
              <input type="number" class="plf-site-rmax" min="0" value="${Number(site.recipesPerDayMax) || 0}" />
            </div>
            <div></div>
          </div>

          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:11.5px;color:#9a9ab8;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;">Pinterest Accounts</div>
            <button class="btn btn-outline-secondary" onclick="plfAddAccount('${escapeHtml(siteName)}')">+ Add Account</button>
          </div>

          <div class="plf-accounts-list">
            ${(site.pinterestAccounts || []).map((acc, idx) => renderAccountCard(siteName, acc, idx, dolphinOptions, statusOptions)).join('')}
          </div>
        </div>
      </div>
    `).join('');

    // Lazy-populate sheet tab dropdowns from each site's settings.json
    sites.forEach(([siteName]) => {
      const sel = container.querySelector(`.plf-site-card[data-site="${siteName}"] .plf-site-sheetTab`);
      if (!sel) return;
      const current = sel.dataset.current || '';
      api('GET', `/api/planifier/sheet-tabs/${encodeURIComponent(siteName)}`)
        .then(r => {
          const opts = [
            `<option value="">(default: ${escapeHtml(r.defaultTab || '—')})</option>`,
            ...(r.tabs || []).map(t => `<option value="${escapeHtml(t)}"${t === current ? ' selected' : ''}>${escapeHtml(t)}</option>`),
          ];
          // If current is set but not in the list, add it as a custom entry so we don't lose it
          if (current && !(r.tabs || []).includes(current)) {
            opts.push(`<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (custom)</option>`);
          }
          sel.innerHTML = opts.join('');
        })
        .catch(e => {
          sel.innerHTML = `<option value="">(error: ${escapeHtml(e.message)})</option>`;
        });
    });
  }

  function renderAccountCard(siteName, acc, idx, dolphinOptions, statusOptions) {
    const profileSelected = dolphinOptions.replace(
      `value="${escapeHtml(acc.dolphinProfileId || '')}"`,
      `value="${escapeHtml(acc.dolphinProfileId || '')}" selected`
    );
    const statusSelected = statusOptions.replace(
      `value="${escapeHtml(acc.status || 'disabled')}"`,
      `value="${escapeHtml(acc.status || 'disabled')}" selected`
    );
    return `
      <div class="plf-account-card" data-acc-idx="${idx}">
        <div class="plf-account-header">
          <input type="text" class="plf-acc-id" value="${escapeHtml(acc.id || '')}" style="background:transparent;border:none;color:#b8a4ff;font-weight:700;font-size:12px;padding:0;letter-spacing:0.6px;text-transform:uppercase;flex:1;" />
          <span class="plf-status-pill plf-status-${escapeHtml(acc.status || 'disabled')}">${escapeHtml(acc.status || 'disabled')}</span>
          <button class="btn btn-outline-danger" style="padding:4px 10px;font-size:11px;" onclick="plfRemoveAccount('${escapeHtml(siteName)}', ${idx})">Remove</button>
        </div>
        <div class="plf-account-body">
          <div class="plf-rule-field">
            <label>Dolphin profile</label>
            <select class="plf-acc-dolphin">
              <option value="">— none —</option>
              ${profileSelected}
            </select>
          </div>
          <div class="plf-rule-field">
            <label>Status</label>
            <select class="plf-acc-status">${statusSelected}</select>
          </div>
          <div class="plf-rule-field">
            <label>Pins/day min</label>
            <input type="number" class="plf-acc-pmin" min="0" value="${Number(acc.pinsPerDayMin) || 0}" />
          </div>
          <div class="plf-rule-field">
            <label>Pins/day max</label>
            <input type="number" class="plf-acc-pmax" min="0" value="${Number(acc.pinsPerDayMax) || 0}" />
          </div>
        </div>
        <div class="plf-rule-field" style="grid-column:1/-1;">
          <label>Boards (comma-separated)</label>
          <input type="text" class="plf-acc-boards" placeholder="dinner-ideas, easy-recipes, comfort-food" value="${escapeHtml((acc.boards || []).join(', '))}" />
        </div>
        <div class="plf-account-body">
          <div class="plf-rule-field">
            <label>Created at <span style="color:var(--text-muted);font-weight:400;">(account age)</span></label>
            <input type="date" class="plf-acc-createdat" value="${acc.createdAt ? new Date(acc.createdAt).toISOString().slice(0,10) : ''}" />
          </div>
          <div class="plf-rule-field">
            <label>Auto-progress <span style="color:var(--text-muted);font-weight:400;">(W1→W2→W3→active)</span></label>
            <label style="display:flex;align-items:center;gap:8px;padding-top:6px;">
              <input type="checkbox" class="plf-acc-autoprogress" ${acc.autoProgress !== false ? 'checked' : ''} />
              <span style="font-size:12px;color:var(--text-muted);">${acc.createdAt ? _agingHint(acc) : 'Set createdAt first'}</span>
            </label>
          </div>
          <div class="plf-rule-field">
            <label>Warming board <span style="color:var(--text-muted);font-weight:400;">(for "I like it" saves)</span></label>
            <input type="text" class="plf-acc-warmingboard" placeholder="I Like It" value="${escapeHtml(acc.warmingBoard || '')}" />
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Build a small hint string showing days-since-creation + days-to-next-promotion.
   * Returns "" if account has no createdAt.
   */
  function _agingHint(acc) {
    if (!acc.createdAt) return '';
    const days = Math.floor((Date.now() - new Date(acc.createdAt).getTime()) / 86400000);
    const thresholds = { warmup_week_1: 7, warmup_week_2: 14, warmup_week_3: 28 };
    const next = thresholds[acc.status];
    if (!next) return `${days}d old · no auto-promotion (status: ${acc.status})`;
    const remaining = Math.max(0, next - days);
    return `${days}d old · next promotion in ${remaining}d`;
  }

  window.plfAddAccount = function (siteName) {
    if (!state.config?.sites?.[siteName]) return;
    const accs = state.config.sites[siteName].pinterestAccounts = state.config.sites[siteName].pinterestAccounts || [];
    accs.push({
      id: `acc${accs.length + 1}`,
      dolphinProfileId: null,
      status: 'disabled',
      pinsPerDayMin: 0,
      pinsPerDayMax: 0,
      boards: [],
      createdAt: new Date().toISOString(),
      autoProgress: true,
      warmingBoard: 'I Like It',
    });
    plfReadFormIntoConfig();   // preserve other edits
    plfRenderSitesConfig();
  };

  window.plfRemoveAccount = function (siteName, idx) {
    if (!confirm('Remove this account from config? (Dolphin profile NOT deleted.)')) return;
    plfReadFormIntoConfig();
    state.config.sites[siteName].pinterestAccounts.splice(idx, 1);
    plfRenderSitesConfig();
  };

  /**
   * Read all DOM inputs into state.config (does NOT POST — only mutates memory).
   * Called before re-rendering so user edits aren't lost.
   */
  function plfReadFormIntoConfig() {
    // Sites
    $$('.plf-site-card').forEach(card => {
      const siteName = card.dataset.site;
      const site = state.config.sites[siteName];
      if (!site) return;
      site.enabled = $('.plf-site-enabled', card).checked;
      site.recipesPerDayMin = Number($('.plf-site-rmin', card).value) || 0;
      site.recipesPerDayMax = Number($('.plf-site-rmax', card).value) || 0;
      site.pinDistribution = $('.plf-site-strategy', card).value;
      const tabSel = $('.plf-site-sheetTab', card);
      if (tabSel) site.sheetTab = tabSel.value || '';
      site.pinterestAccounts = $$('.plf-account-card', card).map(ac => {
        const createdInput = $('.plf-acc-createdat', ac);
        const dateVal = createdInput?.value || '';
        // Convert YYYY-MM-DD to ISO datetime (midnight UTC) for consistent storage
        const createdAt = dateVal ? new Date(dateVal + 'T00:00:00.000Z').toISOString() : null;
        return {
          id: $('.plf-acc-id', ac).value.trim() || 'acc',
          dolphinProfileId: $('.plf-acc-dolphin', ac).value || null,
          status: $('.plf-acc-status', ac).value,
          pinsPerDayMin: Number($('.plf-acc-pmin', ac).value) || 0,
          pinsPerDayMax: Number($('.plf-acc-pmax', ac).value) || 0,
          boards: $('.plf-acc-boards', ac).value.split(',').map(s => s.trim()).filter(Boolean),
          createdAt,
          autoProgress: $('.plf-acc-autoprogress', ac)?.checked ?? true,
          warmingBoard: ($('.plf-acc-warmingboard', ac)?.value || '').trim() || 'I Like It',
        };
      });
    });

    // Rules (if rules panel was rendered, fields exist in DOM)
    const rulesFields = {
      activeHourStart: '#plfRuleStart',
      activeHourEnd: '#plfRuleEnd',
      minGapBetweenActions: '#plfRuleGapAny',
      minGapInterAccount: '#plfRuleGapInter',
      minGapIntraAccount: '#plfRuleGapIntra',
      skipDayProbability: '#plfRuleSkip',
      sessionsWithoutPostPct: '#plfRuleBrowse',
      missedSlotDropAfterMinutes: '#plfRuleMissed',
      horizonDays: '#plfRuleHorizon',
    };
    for (const [key, sel] of Object.entries(rulesFields)) {
      const el = $(sel);
      if (!el || el.value === '') continue;
      state.config.rules[key] = Number(el.value);
    }
    const spread = $('#plfRulePinSpread');
    if (spread && spread.value) {
      state.config.rules.pinSpreadDaysFromRecipe = spread.value
        .split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
    }

    // Browse behaviors
    if (!state.config.rules.browseBehaviors) state.config.rules.browseBehaviors = {};
    const bbMap = {
      sessionMinutesMin: '#plfBBSessionMin',
      sessionMinutesMax: '#plfBBSessionMax',
      initialFeedScrollSecondsMin: '#plfBBInitScrollMin',
      initialFeedScrollSecondsMax: '#plfBBInitScrollMax',
      closeupProbability: '#plfBBCloseupProb',
      closeupCountMin: '#plfBBCloseupMin',
      closeupCountMax: '#plfBBCloseupMax',
      closeupLingerSecondsMin: '#plfBBCloseupLingerMin',
      closeupLingerSecondsMax: '#plfBBCloseupLingerMax',
      savePinProbability: '#plfBBSaveProb',
      searchProbability: '#plfBBSearchProb',
      searchPinClickAfterProbability: '#plfBBSearchClickProb',
      videoPlayProbability: '#plfBBVideoProb',
      visitExternalProbability: '#plfBBVisitProb',
      profileGlanceProbability: '#plfBBProfileProb',
      finalFeedScrollSecondsMin: '#plfBBFinalScrollMin',
      finalFeedScrollSecondsMax: '#plfBBFinalScrollMax',
    };
    for (const [key, sel] of Object.entries(bbMap)) {
      const el = $(sel);
      if (!el || el.value === '') continue;
      state.config.rules.browseBehaviors[key] = Number(el.value);
    }

    // Per-site keywords
    plfReadKeywordsIntoConfig();

    // Telegram notifications
    if (!state.config.notifications) state.config.notifications = {};
    if (!state.config.notifications.telegram) state.config.notifications.telegram = {};
    const tg = state.config.notifications.telegram;
    const newToken = $('#plfTgToken')?.value.trim();
    const chatId = $('#plfTgChatId')?.value.trim();
    if (newToken) tg.botToken = newToken;     // only update if user typed something
    if (chatId !== undefined) tg.chatId = chatId;
    if ($('#plfTgEnabled')) tg.enabled = $('#plfTgEnabled').checked;
    if ($('#plfTgNotifyError')) tg.notifyOnError = $('#plfTgNotifyError').checked;
    if ($('#plfTgNotifySuccess')) tg.notifyOnSuccess = $('#plfTgNotifySuccess').checked;
  }

  function plfRenderRulesPanel() {
    if (!state.config) return;
    const r = state.config.rules || {};
    const map = {
      '#plfRuleStart': r.activeHourStart,
      '#plfRuleEnd': r.activeHourEnd,
      '#plfRuleGapAny': r.minGapBetweenActions,
      '#plfRuleGapInter': r.minGapInterAccount,
      '#plfRuleGapIntra': r.minGapIntraAccount,
      '#plfRuleSkip': r.skipDayProbability,
      '#plfRuleBrowse': r.sessionsWithoutPostPct,
      '#plfRuleMissed': r.missedSlotDropAfterMinutes,
      '#plfRuleHorizon': r.horizonDays,
    };
    for (const [sel, val] of Object.entries(map)) {
      const el = $(sel); if (el && val != null) el.value = val;
    }
    const sp = $('#plfRulePinSpread');
    if (sp) sp.value = (r.pinSpreadDaysFromRecipe || []).join(',');

    // Browse behaviors
    const bb = r.browseBehaviors || {};
    const bbMap = {
      '#plfBBSessionMin': bb.sessionMinutesMin,
      '#plfBBSessionMax': bb.sessionMinutesMax,
      '#plfBBInitScrollMin': bb.initialFeedScrollSecondsMin,
      '#plfBBInitScrollMax': bb.initialFeedScrollSecondsMax,
      '#plfBBCloseupProb': bb.closeupProbability,
      '#plfBBCloseupMin': bb.closeupCountMin,
      '#plfBBCloseupMax': bb.closeupCountMax,
      '#plfBBCloseupLingerMin': bb.closeupLingerSecondsMin,
      '#plfBBCloseupLingerMax': bb.closeupLingerSecondsMax,
      '#plfBBSaveProb': bb.savePinProbability,
      '#plfBBSearchProb': bb.searchProbability,
      '#plfBBSearchClickProb': bb.searchPinClickAfterProbability,
      '#plfBBVideoProb': bb.videoPlayProbability,
      '#plfBBVisitProb': bb.visitExternalProbability,
      '#plfBBProfileProb': bb.profileGlanceProbability,
      '#plfBBFinalScrollMin': bb.finalFeedScrollSecondsMin,
      '#plfBBFinalScrollMax': bb.finalFeedScrollSecondsMax,
    };
    for (const [sel, val] of Object.entries(bbMap)) {
      const el = $(sel); if (el && val != null) el.value = val;
    }

    plfRenderKeywordsPerSite();
    plfPopulatePreviewSiteSelect();
  }

  function plfRenderKeywordsPerSite() {
    const box = $('#plfKeywordsPerSite');
    if (!box || !state.config) return;
    const sites = Object.entries(state.config.sites || {}).filter(([n]) => !n.startsWith('_'));
    if (sites.length === 0) {
      box.innerHTML = '<div style="color:#9a9ab8;font-size:12px;">No sites configured.</div>';
      return;
    }
    box.innerHTML = sites.map(([siteName, site]) => {
      const kws = (site.searchKeywords || []).join('\n');
      const useRecipes = site.useRecipeNamesAsKeywords !== false; // default true
      const sampleSize = site.recipeNamesSampleSize || 30;
      return `
        <div class="plf-keywords-site" data-site-kw="${escapeHtml(siteName)}">
          <h4>${escapeHtml(siteName)}</h4>
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px;padding:10px 12px;background:rgba(0,214,143,0.04);border:1px solid rgba(0,214,143,0.15);border-radius:8px;">
            <label class="plf-switch" style="width:40px;height:22px;">
              <input type="checkbox" class="plf-kw-use-recipes" ${useRecipes ? 'checked' : ''} />
              <span class="plf-switch-slider"></span>
            </label>
            <div style="flex:1;min-width:180px;">
              <div style="color:#00d68f;font-weight:700;font-size:12px;">🎲 Also search recipe names from your sheet</div>
              <div style="color:#9a9ab8;font-size:11px;margin-top:2px;">Mixes the last <span class="plf-kw-sample-display">${sampleSize}</span> published recipe titles into the keyword pool (more relevant searches = stronger Pinterest topical signal)</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <label style="font-size:11px;color:#9a9ab8;">Sample:</label>
              <input type="number" class="plf-kw-sample-size" value="${sampleSize}" min="1" max="200" style="width:64px;background:rgba(8,8,18,0.6);border:1px solid rgba(255,255,255,0.06);color:#e0e4f0;padding:5px 8px;border-radius:6px;font-size:12px;" />
            </div>
          </div>
          <label style="font-size:11px;color:#9a9ab8;display:block;margin-bottom:4px;">Manual keywords (always used, one per line):</label>
          <textarea rows="5" placeholder="One keyword per line (or comma-separated)">${escapeHtml(kws)}</textarea>
          <div class="count">${(site.searchKeywords || []).length} manual keyword(s)${useRecipes ? ' + recipe titles from sheet' : ''}</div>
        </div>
      `;
    }).join('');

    // Wire inputs
    $$('.plf-keywords-site', box).forEach(card => {
      const ta = card.querySelector('textarea');
      const useRec = card.querySelector('.plf-kw-use-recipes');
      const sample = card.querySelector('.plf-kw-sample-size');
      const sampleDisplay = card.querySelector('.plf-kw-sample-display');
      const count = card.querySelector('.count');
      ta.addEventListener('input', () => {
        const lines = ta.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        count.textContent = `${lines.length} manual keyword(s)${useRec.checked ? ' + recipe titles from sheet' : ''}`;
      });
      useRec.addEventListener('change', () => {
        const lines = ta.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
        count.textContent = `${lines.length} manual keyword(s)${useRec.checked ? ' + recipe titles from sheet' : ''}`;
      });
      sample.addEventListener('input', () => {
        sampleDisplay.textContent = sample.value;
      });
    });
  }

  function plfPopulatePreviewSiteSelect() {
    const sel = $('#plfPreviewSite');
    if (!sel || !state.config) return;
    const sites = Object.keys(state.config.sites || {}).filter(n => !n.startsWith('_'));
    const prev = sel.value;
    sel.innerHTML = sites.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (prev && sites.includes(prev)) sel.value = prev;
  }

  window.plfRunSimulation = async function () {
    const out = $('#plfSimulationOutput');
    if (!out) return;
    // First sync DOM → state so the preview reflects unsaved edits
    plfReadFormIntoConfig();
    plfReadKeywordsIntoConfig();
    const site = $('#plfPreviewSite')?.value;
    out.innerHTML = '<div style="color:#9a9ab8;">Simulating…</div>';
    try {
      // Save first so the server uses the latest config (the simulator reads from disk)
      await api('POST', '/api/planifier/config', state.config);
      const r = await api('POST', '/api/planifier/simulate-browse', { site, runs: 100 });
      renderSimulationOutput(r);
    } catch (e) {
      out.innerHTML = `<div style="color:#ff6b6b;">Simulation failed: ${escapeHtml(e.message)}</div>`;
    }
  };

  function plfReadKeywordsIntoConfig() {
    $$('.plf-keywords-site').forEach(card => {
      const siteName = card.dataset.siteKw;
      if (!state.config.sites[siteName]) return;
      const site = state.config.sites[siteName];
      const ta = card.querySelector('textarea');
      const useRec = card.querySelector('.plf-kw-use-recipes');
      const sample = card.querySelector('.plf-kw-sample-size');
      site.searchKeywords = ta.value.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
      if (useRec) site.useRecipeNamesAsKeywords = useRec.checked;
      if (sample && sample.value) site.recipeNamesSampleSize = Math.max(1, Math.min(200, Number(sample.value) || 30));
    });
  }

  function renderSimulationOutput(r) {
    const out = $('#plfSimulationOutput');
    if (!out) return;
    const one = r.one;
    const agg = r.aggregate;
    out.innerHTML = `
      <div style="font-size:11px;color:#9a9ab8;margin-bottom:14px;">
        📊 <strong>Average across ${agg.runs} simulated sessions</strong> for <strong>${escapeHtml(one.siteName)}</strong> — durations range ${agg.minDuration}–${agg.maxDuration} min.
      </div>
      <div class="plf-sim-summary">
        <div class="plf-sim-stat"><div class="label">Avg duration</div><div class="value">${agg.avgDurationMinutes}<span class="unit">min</span></div></div>
        <div class="plf-sim-stat"><div class="label">Avg closeups</div><div class="value">${agg.avgCloseups}</div></div>
        <div class="plf-sim-stat"><div class="label">Avg saves (re-pins)</div><div class="value">${agg.avgSaves}</div></div>
        <div class="plf-sim-stat"><div class="label">Avg searches</div><div class="value">${agg.avgSearches}</div></div>
        <div class="plf-sim-stat"><div class="label">Avg video views</div><div class="value">${agg.avgVideos}</div></div>
        <div class="plf-sim-stat"><div class="label">Avg "Visit" clicks</div><div class="value">${agg.avgVisits}</div></div>
      </div>

      <div style="margin-bottom:8px;font-size:11px;color:#9a9ab8;">
        🎬 <strong>One sample session</strong> — ${one.durationMinutes} min, ${one.events.length} events.
        Keyword pool: <strong style="color:#c8c8e8;">${one.manualKeywordsCount} manual + ${one.recipeKeywordsCount} from sheet</strong>
        ${one.boardsCount === 0 ? '<span style="color:#ffb347;"> · ⚠ No boards configured — saves disabled.</span>' : ''}
        ${one.keywordsCount === 0 ? '<span style="color:#ffb347;"> · ⚠ No keywords — search disabled.</span>' : ''}
      </div>
      <div class="plf-sim-events">
        ${one.events.map(e => `
          <div class="plf-sim-event">
            <div class="t">${formatT(e.t)}</div>
            <div class="action ${escapeHtml(e.action)}">${escapeHtml(e.action)}</div>
            <div class="detail">${escapeHtml(e.detail)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  function formatT(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  window.plfSaveConfig = async function () {
    try {
      plfReadFormIntoConfig();
      await api('POST', '/api/planifier/config', state.config);
      $('#plfConfigSaveStatus') && ($('#plfConfigSaveStatus').textContent = '✓ Saved ' + new Date().toLocaleTimeString());
      $('#plfRulesSaveStatus') && ($('#plfRulesSaveStatus').textContent = '✓ Saved ' + new Date().toLocaleTimeString());
      showToast('Configuration saved', 'success');
      renderDiagnostics();
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  };

  // ── 7-day outlook ────────────────────────────────────────────
  async function plfLoadUpcoming(days) {
    const box = $('#plfUpcoming');
    if (!box) return;
    box.innerHTML = '<div style="padding:18px;color:#6a6a8e;font-size:13px;">Loading…</div>';
    try {
      const r = await api('GET', `/api/planifier/upcoming?days=${days}`);
      if (!r.plans || r.plans.length === 0) {
        box.innerHTML = '<div class="plf-timeline-empty">No plans found.</div>';
        return;
      }
      const rules = state.config?.rules || { activeHourStart: 8, activeHourEnd: 22 };
      const windowStart = rules.activeHourStart;
      const windowEnd = rules.activeHourEnd;
      box.innerHTML = r.plans.map(plan => renderDayBar(plan, windowStart, windowEnd)).join('');
      // Wire slot clicks
      $$('.plf-day-slot', box).forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openSlotModal(el.dataset.date, el.dataset.id);
        });
      });
    } catch (e) {
      box.innerHTML = `<div class="plf-timeline-empty">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ── Slot edit modal ──────────────────────────────────────────
  async function openSlotModal(date, itemId) {
    if (!date || !itemId) return;
    let plan;
    try {
      plan = await api('GET', `/api/planifier/plan/${date}`);
    } catch (e) {
      showToast('Load failed: ' + e.message, 'error');
      return;
    }
    const item = (plan.items || []).find(i => i.id === itemId);
    if (!item) {
      showToast('Slot not found in plan', 'error');
      return;
    }
    showSlotModal(date, item);
  }

  function showSlotModal(date, item) {
    const existing = $('.plf-modal-backdrop');
    if (existing) existing.remove();
    const typeLabel = item.type === 'create-recipe'
      ? `Recipe creation`
      : `Pinterest session ${item.willPost ? '(post)' : '(browse only)'}`;
    const subLabel = `${item.site}${item.accountId ? ' / ' + item.accountId : ''} — ${fmtDate(date)} · ${fmtTimeFull(item.scheduledAt)} (${fmtRelative(item.scheduledAt)})`;
    const d = new Date(item.scheduledAt);
    const timeValue = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    const statusBadge = `<span class="plf-timeline-badge ${escapeHtml(item.status)}" style="margin-left:8px;font-size:10px;">${escapeHtml(item.status)}</span>`;
    const isDone = item.status === 'done';
    const isError = item.status === 'error';
    const isRunning = item.status === 'in_progress';
    const runLabel = isDone ? '🔁 Re-run' : (isError ? '🔁 Retry' : '▶ Run Now');
    const runStyle = 'background:linear-gradient(135deg,#00c853,#00d68f);color:#003300;padding:9px 22px;font-size:12.5px;font-weight:700;';
    const modal = document.createElement('div');
    modal.className = 'plf-modal-backdrop';
    modal.innerHTML = `
      <div class="plf-modal" onclick="event.stopPropagation()">
        <div class="plf-modal-title">${escapeHtml(typeLabel)} ${statusBadge}</div>
        <div class="plf-modal-sub">${escapeHtml(subLabel)}</div>
        <div class="plf-modal-fields">
          <div class="plf-rule-field">
            <label>Time (HH:MM)</label>
            <input type="time" id="plfModalTime" value="${timeValue}" />
          </div>
          ${(isDone || isError) ? `
          <div class="plf-rule-field">
            <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:10px 12px;background:rgba(0,214,143,0.06);border:1px solid rgba(0,214,143,0.2);border-radius:8px;">
              <input type="checkbox" id="plfModalResetPending" style="width:auto;margin-top:2px;" />
              <span>
                <strong style="color:#00d68f;">Reset to pending</strong>
                <br/><span style="font-size:11px;color:#9a9ab8;">This slot is currently <em>${escapeHtml(item.status)}</em>. Check to reset its status to pending so it fires again at the new scheduled time (instead of staying done/error).</span>
              </span>
            </label>
          </div>
          ` : ''}
          <div class="plf-rule-field">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="plfModalLock" ${item.locked ? 'checked' : ''} style="width:auto;" />
              <span>Lock this slot (preserved when running "Random Week")</span>
            </label>
          </div>
          ${item.type === 'pinterest-session' ? `
          <div class="plf-rule-field">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="plfModalWillPost" ${item.willPost ? 'checked' : ''} style="width:auto;" />
              <span>Actually post a pin (uncheck = browse only)</span>
            </label>
          </div>
          ` : ''}
        </div>
        <div id="plfModalRunStatus" style="display:none;padding:10px 14px;background:rgba(33,150,243,0.08);border:1px solid rgba(33,150,243,0.2);border-radius:8px;margin-bottom:14px;font-size:12px;color:#6ea8fe;"></div>
        <div class="plf-modal-actions">
          <button class="btn btn-outline-danger" onclick="plfDeleteSlot('${escapeHtml(date)}', '${escapeHtml(item.id)}')">Delete</button>
          <div class="plf-modal-actions-right">
            <button class="btn" onclick="plfRunSlot('${escapeHtml(date)}', '${escapeHtml(item.id)}', ${isDone || isError})" style="${runStyle}" ${isRunning ? 'disabled' : ''}>${runLabel}</button>
            <button class="btn btn-outline-secondary" onclick="document.querySelector('.plf-modal-backdrop').remove()">Close</button>
            <button class="btn btn-save" onclick="plfSaveSlot('${escapeHtml(date)}', '${escapeHtml(item.id)}')" style="padding:9px 22px;font-size:12.5px;">Save edits</button>
          </div>
        </div>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  }

  window.plfOpenAddSlotModal = function (date) {
    if (!state.config) return showToast('Config not loaded', 'error');
    const targetDate = date || todayKey();
    const sites = Object.entries(state.config.sites || {})
      .filter(([n, s]) => !n.startsWith('_') && s.enabled);
    if (sites.length === 0) return showToast('No enabled site. Configure one first.', 'error');

    const existing = $('.plf-modal-backdrop');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.className = 'plf-modal-backdrop';
    const siteOptions = sites.map(([n]) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    const now = new Date();
    const nowTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    modal.innerHTML = `
      <div class="plf-modal" onclick="event.stopPropagation()">
        <div class="plf-modal-title">+ Add Slot</div>
        <div class="plf-modal-sub">Manually add a one-off action to ${escapeHtml(fmtDate(targetDate))}</div>
        <div class="plf-modal-fields">
          <div class="plf-rule-field">
            <label>Action type</label>
            <select id="plfAddType" onchange="plfAddSlotTypeChanged()">
              <option value="pinterest-session">Pinterest session</option>
              <option value="create-recipe">Create recipe (next pending in sheet)</option>
            </select>
          </div>
          <div class="plf-rule-field">
            <label>Site</label>
            <select id="plfAddSite" onchange="plfAddSlotSiteChanged()">${siteOptions}</select>
          </div>
          <div class="plf-rule-field" id="plfAddAccountField">
            <label>Account</label>
            <select id="plfAddAccount"></select>
          </div>
          <div class="plf-rule-field" id="plfAddWillPostField">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="plfAddWillPost" checked style="width:auto;" />
              <span>Post a pin (uncheck = browse only)</span>
            </label>
          </div>
          <div class="plf-rule-field">
            <label>Time (HH:MM) — leave for "in 1 min"</label>
            <input type="time" id="plfAddTime" value="${nowTime}" />
          </div>
        </div>
        <div class="plf-modal-actions">
          <span></span>
          <div class="plf-modal-actions-right">
            <button class="btn btn-outline-secondary" onclick="document.querySelector('.plf-modal-backdrop').remove()">Cancel</button>
            <button class="btn btn-save" onclick="plfAddSlotCreate('${escapeHtml(targetDate)}', false)" style="padding:9px 18px;font-size:12.5px;">Add</button>
            <button class="btn" onclick="plfAddSlotCreate('${escapeHtml(targetDate)}', true)" style="background:linear-gradient(135deg,#00c853,#00d68f);color:#003300;padding:9px 18px;font-size:12.5px;font-weight:700;">Add + Run Now</button>
          </div>
        </div>
      </div>
    `;
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    plfAddSlotSiteChanged();
    plfAddSlotTypeChanged();
  };

  window.plfAddSlotTypeChanged = function () {
    const type = $('#plfAddType').value;
    const isPin = type === 'pinterest-session';
    $('#plfAddAccountField').style.display = isPin ? '' : 'none';
    $('#plfAddWillPostField').style.display = isPin ? '' : 'none';
  };

  window.plfAddSlotSiteChanged = function () {
    const site = $('#plfAddSite').value;
    const accs = (state.config?.sites?.[site]?.pinterestAccounts || [])
      .filter(a => a.status !== 'disabled');
    const sel = $('#plfAddAccount');
    if (sel) {
      sel.innerHTML = accs.length === 0
        ? '<option value="">(no active accounts)</option>'
        : accs.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.id)} · ${escapeHtml(a.status)}</option>`).join('');
    }
  };

  window.plfAddSlotCreate = async function (date, runNow) {
    const type = $('#plfAddType').value;
    const site = $('#plfAddSite').value;
    const accountId = $('#plfAddAccount')?.value || null;
    const willPost = $('#plfAddWillPost')?.checked !== false;
    const scheduledAt = $('#plfAddTime').value || null;
    if (type === 'pinterest-session' && !accountId) {
      showToast('Pick an account', 'error');
      return;
    }
    try {
      const r = await api('POST', `/api/planifier/plan/${date}/items`, {
        type, site, accountId, scheduledAt, willPost,
      });
      $('.plf-modal-backdrop').remove();
      showToast('Slot added', 'success');
      plfLoadActiveTab();
      if (runNow) {
        await new Promise(r => setTimeout(r, 300));
        // Open the slot modal so the user can see live status while it runs
        openSlotModal(date, r.item.id);
        await new Promise(r => setTimeout(r, 200));
        plfRunSlot(date, r.item.id, false);
      }
    } catch (e) {
      showToast('Add failed: ' + e.message, 'error');
    }
  };

  window.plfRunSlot = async function (date, itemId, force) {
    const statusBox = $('#plfModalRunStatus');
    if (statusBox) {
      statusBox.style.display = '';
      statusBox.textContent = '⏳ Launching… ' + (force ? '(re-run)' : '');
    }
    try {
      await api('POST', `/api/planifier/plan/${date}/items/${itemId}/run`, { force: !!force });
      if (statusBox) statusBox.textContent = '🚀 Running — this can take 30s to 25 min depending on the action. Status updates live below.';
      pollItemStatus(date, itemId);
      showToast('Action started — watch the live status', 'success');
    } catch (e) {
      if (statusBox) {
        statusBox.style.background = 'rgba(244,67,54,0.08)';
        statusBox.style.borderColor = 'rgba(244,67,54,0.2)';
        statusBox.style.color = '#ff8585';
        statusBox.textContent = '✗ ' + e.message;
      }
    }
  };

  // Poll until item reaches a terminal state. Updates the modal status line
  // + refreshes the underlying timeline/timeline-bar.
  async function pollItemStatus(date, itemId) {
    const statusBox = $('#plfModalRunStatus');
    const start = Date.now();
    const tick = async () => {
      // Stop polling if modal closed
      if (!document.querySelector('.plf-modal-backdrop')) return;
      try {
        const plan = await api('GET', `/api/planifier/plan/${date}`);
        const item = (plan.items || []).find(i => i.id === itemId);
        if (!item) return;
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (statusBox) {
          if (item.status === 'in_progress') {
            statusBox.textContent = `⚙ In progress… ${elapsedSec}s elapsed`;
          } else if (item.status === 'done') {
            statusBox.style.background = 'rgba(0,214,143,0.08)';
            statusBox.style.borderColor = 'rgba(0,214,143,0.25)';
            statusBox.style.color = '#00d68f';
            statusBox.textContent = `✓ Done — ${elapsedSec}s`;
            // Check history for fallback reason
            try {
              const h = await api('GET', '/api/planifier/history?range=today&limit=10');
              const last = (h.items || []).find(it => it.itemId === itemId && it.status === 'done');
              if (last?.result?.wantedToPost && !last.result.posted && last.result.reason === 'no-eligible-pin') {
                statusBox.style.background = 'rgba(255,179,71,0.08)';
                statusBox.style.borderColor = 'rgba(255,179,71,0.25)';
                statusBox.style.color = '#ffb347';
                statusBox.innerHTML = `⚠ Done in ${elapsedSec}s — but <strong>no pin was posted</strong> (no eligible pin found for this account). Check: sheet tab, validation, pinSpreadDays. Browsed only.`;
              }
            } catch {}
          } else if (item.status === 'error') {
            statusBox.style.background = 'rgba(244,67,54,0.08)';
            statusBox.style.borderColor = 'rgba(244,67,54,0.2)';
            statusBox.style.color = '#ff8585';
            statusBox.textContent = `✗ Error after ${elapsedSec}s — check History for details`;
          }
        }
        if (item.status === 'done' || item.status === 'error') {
          plfLoadActiveTab();
          return;  // stop polling
        }
        setTimeout(tick, 2500);
      } catch (e) {
        if (statusBox) statusBox.textContent = 'Poll error: ' + e.message;
        setTimeout(tick, 5000);
      }
    };
    setTimeout(tick, 1500);
  }

  window.plfSaveSlot = async function (date, itemId) {
    try {
      const time = $('#plfModalTime').value;
      const locked = $('#plfModalLock').checked;
      const willPostEl = $('#plfModalWillPost');
      const resetEl = $('#plfModalResetPending');
      // Build new scheduledAt — same date, new time
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      const newDate = new Date(y, m - 1, d, hh, mm, 0);
      const patch = { scheduledAt: newDate.toISOString(), locked };
      if (willPostEl) patch.willPost = willPostEl.checked;
      if (resetEl && resetEl.checked) patch.status = 'pending';
      await api('PUT', `/api/planifier/plan/${date}/items/${itemId}`, patch);
      $('.plf-modal-backdrop').remove();
      showToast(resetEl?.checked ? 'Slot updated + reset to pending' : 'Slot updated', 'success');
      plfLoadActiveTab();
    } catch (e) {
      showToast('Save failed: ' + e.message, 'error');
    }
  };

  window.plfDeleteSlot = async function (date, itemId) {
    if (!confirm('Delete this slot from the plan?')) return;
    try {
      await api('DELETE', `/api/planifier/plan/${date}/items/${itemId}`);
      $('.plf-modal-backdrop').remove();
      showToast('Slot deleted', 'success');
      plfLoadActiveTab();
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  function renderDayBar(plan, hStart, hEnd) {
    const totalMin = (hEnd - hStart) * 60;
    const slots = plan.items.map(item => {
      const d = new Date(item.scheduledAt);
      const min = d.getHours() * 60 + d.getMinutes() - hStart * 60;
      const left = Math.max(0, Math.min(100, (min / totalMin) * 100));
      const cls = item.type === 'create-recipe' ? 'recipe' : (item.willPost ? 'pinterest' : 'browse');
      const lockedCls = item.locked ? ' locked' : '';
      const label = item.type === 'create-recipe'
        ? `${fmtTime(item.scheduledAt)} — Recipe (${item.site})`
        : `${fmtTime(item.scheduledAt)} — ${item.willPost ? 'Pin' : 'Browse'} (${item.site}/${item.accountId})`;
      return `<div class="plf-day-slot ${cls}${lockedCls}" data-date="${escapeHtml(plan.date)}" data-id="${escapeHtml(item.id)}" style="left:${left}%;width:6px;" title="${escapeHtml(label)}${item.locked ? ' [locked]' : ''}"></div>`;
    }).join('');
    const summary = plan.summary || {};
    return `
      <div class="plf-day-card">
        <div class="plf-day-header">
          <div>
            <span class="plf-day-date">${escapeHtml(fmtDate(plan.date))}</span>
            <span class="plf-day-relative">${escapeHtml(relativeDay(plan.date))}</span>
          </div>
          <div class="plf-day-summary">
            <span><strong>${plan.items.length}</strong> actions</span>
            <span><strong>${summary.recipes || 0}</strong> recipes</span>
            <span><strong>${summary.pinterestPosts || 0}</strong> pin posts</span>
            <span><strong>${summary.pinterestBrowseOnly || 0}</strong> browse-only</span>
          </div>
        </div>
        ${plan.globalSkip && plan.items.length === 0
          ? '<div class="plf-day-skipped">Global skip day — no activity</div>'
          : `<div class="plf-day-bar">${slots || '<div style="margin:auto;color:#6a6a8e;font-size:11px;">empty</div>'}</div>`}
      </div>
    `;
  }

  window.plfLoadUpcoming = plfLoadUpcoming;

  window.plfRandomizeWeek = async function () {
    if (!confirm('Re-roll all upcoming plans? Locked items are preserved, everything else is randomized.')) return;
    try {
      const days = Number(state.config?.rules?.horizonDays) || 7;
      await api('POST', '/api/planifier/randomize-week', { days });
      showToast(`Randomized ${days} days`, 'success');
      plfLoadUpcoming(days);
    } catch (e) {
      showToast('Randomize failed: ' + e.message, 'error');
    }
  };

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  // ── History ──────────────────────────────────────────────────
  async function plfLoadHistory() {
    const box = $('#plfHistoryList');
    if (!box) return;
    const range = $('#plfHistoryRange')?.value || 'all';
    box.innerHTML = '<div style="padding:18px;color:#6a6a8e;font-size:13px;">Loading…</div>';
    try {
      const r = await api('GET', `/api/planifier/history?range=${encodeURIComponent(range)}`);
      if (!r.items || r.items.length === 0) {
        box.innerHTML = '<div class="plf-history-empty">No history entries yet. As the planifier executes actions, they will appear here.</div>';
        return;
      }
      box.innerHTML = r.items.map(it => {
        const iconCls = it.type === 'create-recipe' ? 'recipe' : (it.willPost ? 'pinterest' : 'browse');
        const iconChar = it.type === 'create-recipe' ? 'R' : (it.willPost ? 'P' : 'B');
        const ts = it.loggedAt ? new Date(it.loggedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '--';
        const meta = it.type === 'create-recipe'
          ? `Recipe — ${escapeHtml(it.site)}${it.recipeTitle ? ' · ' + escapeHtml(it.recipeTitle) : ''}`
          : `Pinterest — ${escapeHtml(it.site)} / ${escapeHtml(it.accountId || '')}${it.willPost ? '' : ' (browse)'}`;
        return `
          <div class="plf-history-item">
            <div class="plf-history-time">${escapeHtml(ts)}</div>
            <div class="plf-timeline-icon ${iconCls}">${iconChar}</div>
            <div>
              <div style="color:#c8c8e8;">${meta}</div>
              ${it.error ? `<div style="color:#ff8585;font-size:11px;margin-top:2px;">${escapeHtml(it.error)}</div>` : ''}
            </div>
            <span class="plf-timeline-badge ${escapeHtml(it.status || 'done')}">${escapeHtml(it.status || 'done')}</span>
          </div>
        `;
      }).join('');
    } catch (e) {
      box.innerHTML = `<div class="plf-history-empty" style="color:#ff6b6b;">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  // ── Pin Pool ─────────────────────────────────────────────────
  let _poolCache = null;
  async function plfLoadPool(opts = {}) {
    const box = $('#plfPoolTable');
    if (!box) return;
    const url = opts.validate ? '/api/planifier/pin-pool?validate=1' : '/api/planifier/pin-pool';
    const loadMsg = opts.validate
      ? 'Validating recipes — fetching each WP post to check ingredients vs steps. Takes a few seconds…'
      : 'Loading pin pool from Google Sheet…';
    box.innerHTML = `<div style="padding:18px;color:#6a6a8e;font-size:13px;">${loadMsg}</div>`;
    try {
      const r = await api('GET', url);
      _poolCache = r;
      // Stats
      $('#plfPoolRecipes').textContent = r.summary.totalRecipes;
      $('#plfPoolPosted').textContent = r.summary.pinsPosted;
      $('#plfPoolPending').textContent = r.summary.pinsPending;
      $('#plfPoolEligible').textContent = r.summary.pinsEligibleNow;
      // Validation line under "Recipes" stat
      const validLine = $('#plfPoolValidLine');
      if (validLine) {
        if (r.summary.recipesValid != null) {
          const v = r.summary.recipesValid;
          const i = r.summary.recipesInvalid;
          const total = v + i;
          const pct = total > 0 ? Math.round(v/total*100) : 0;
          validLine.innerHTML = `<span style="color:#00d68f;">${v} ✓ valid</span> · <span style="color:#ffb347;">${i} ⚠ invalid</span> (${pct}%)`;
        } else {
          validLine.innerHTML = '<span style="color:#6a6a8e;">Click "Validate All" to check quality</span>';
        }
      }
      // Populate filter
      const sites = [...new Set(r.pool.map(p => p.site))].sort();
      const sel = $('#plfPoolFilterSite');
      const prev = sel.value;
      sel.innerHTML = '<option value="">All sites</option>' +
        sites.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      sel.value = prev;
      // Render
      plfRenderPool();
      renderPoolByAccount(r.summary.byAccount);
      if (opts.validate) {
        showToast(`Validated ${r.summary.totalRecipes} recipes — ${r.summary.recipesInvalid || 0} invalid`, r.summary.recipesInvalid ? 'warning' : 'success');
      }
    } catch (e) {
      box.innerHTML = `<div class="plf-pool-empty" style="color:#ff6b6b;">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  function plfRenderPool() {
    if (!_poolCache) return;
    const filterSite = $('#plfPoolFilterSite')?.value || '';
    const filterStatus = $('#plfPoolFilterStatus')?.value || '';
    const today = todayKey();
    let recipes = _poolCache.pool;
    if (filterSite) recipes = recipes.filter(r => r.site === filterSite);

    const box = $('#plfPoolTable');
    if (!box) return;
    if (recipes.length === 0) {
      box.innerHTML = '<div class="plf-pool-empty">No recipes match filter. Check that posts are marked "published" (col R) in the Google Sheet.</div>';
      return;
    }

    const header = `
      <div class="plf-pool-header" style="display:grid;grid-template-columns:40px 1fr 100px 100px 1fr 1fr 1fr;gap:12px;">
        <div>Row</div><div>Recipe</div><div>Published</div><div>Account</div>
        <div>Pin 1 (col F)</div><div>Pin 2 (col J)</div><div>Pin 3 (col N)</div>
      </div>
    `;
    const rowsHtml = recipes.map(r => {
      // Status filter: keep recipe only if ANY pin matches the filter
      if (filterStatus) {
        const anyMatch = r.pins.some(p => {
          if (filterStatus === 'posted') return !!p.postedAt;
          if (filterStatus === 'pending') return !p.postedAt;
          if (filterStatus === 'eligible') return !p.postedAt && p.imageUrl && (!p.eligibleAt || p.eligibleAt <= today);
        });
        if (!anyMatch) return '';
      }
      const pinCells = r.pins.map(p => renderPinCell(r, p, today)).join('');
      const accountLabel = r.assignedAccountId
        ? `<span class="plf-status-pill plf-status-active" style="font-size:10px;">${escapeHtml(r.assignedAccountId)}</span>`
        : '<span style="color:#ffb347;font-size:11px;">unassigned</span>';
      // Validation badge (only when ?validate=1 was used)
      let validationBadge = '';
      if (r.validation) {
        if (r.validation.valid) {
          validationBadge = '<span class="plf-validation-badge valid" title="Recipe passed validator">✓</span>';
        } else {
          const issuesText = (r.validation.issues || []).map(i => `${i.kind}: ${i.msg}`).join(' • ');
          validationBadge = `<span class="plf-validation-badge invalid" title="${escapeHtml(issuesText)}">⚠</span>`;
        }
      }
      return `
        <div class="plf-pool-row${r.validation && !r.validation.valid ? ' invalid-recipe' : ''}">
          <div class="plf-pool-rownum">${r.rowIndex}</div>
          <div class="topic">
            ${escapeHtml(r.topic || '—')} ${validationBadge}
            <small><a href="${escapeHtml(r.draftUrl || '#')}" target="_blank" rel="noopener" style="color:#6a6a8e;">${escapeHtml(r.site)}</a></small>
          </div>
          <div class="date">${escapeHtml(r.publishedAt || '—')}</div>
          <div>${accountLabel}</div>
          ${pinCells}
        </div>
      `;
    }).filter(Boolean).join('');

    box.innerHTML = header + (rowsHtml || '<div class="plf-pool-empty">No pins match the filter.</div>');
  }

  function renderPinCell(recipe, pin, today) {
    if (!pin.imageUrl) {
      return `<div class="plf-pin-cell no-image"><div class="pin-status">no image</div><div class="pin-detail">not generated</div></div>`;
    }
    if (pin.postedAt) {
      const date = (pin.postedAt || '').slice(0, 10);
      return `
        <div class="plf-pin-cell posted" onclick="plfTogglePostedPin('${escapeHtml(recipe.site)}', ${recipe.rowIndex}, ${pin.pinIndex}, true)" title="${escapeHtml(pin.title || '')}">
          <div class="pin-status">✓ posted</div>
          <div class="pin-detail">${escapeHtml(date)}</div>
          <div class="pin-title">${escapeHtml(pin.title || '')}</div>
        </div>
      `;
    }
    if (pin.eligibleAt && pin.eligibleAt > today) {
      return `
        <div class="plf-pin-cell eligible-future" onclick="plfTogglePostedPin('${escapeHtml(recipe.site)}', ${recipe.rowIndex}, ${pin.pinIndex}, false)" title="${escapeHtml(pin.title || '')}">
          <div class="pin-status">⏱ eligible ${escapeHtml(pin.eligibleAt)}</div>
          <div class="pin-detail">spread rule</div>
          <div class="pin-title">${escapeHtml(pin.title || '')}</div>
        </div>
      `;
    }
    return `
      <div class="plf-pin-cell pending" onclick="plfTogglePostedPin('${escapeHtml(recipe.site)}', ${recipe.rowIndex}, ${pin.pinIndex}, false)" title="${escapeHtml(pin.title || '')}">
        <div class="pin-status">pending</div>
        <div class="pin-detail">eligible now</div>
        <div class="pin-title">${escapeHtml(pin.title || '')}</div>
      </div>
    `;
  }

  function renderPoolByAccount(byAccount) {
    const box = $('#plfPoolByAccount');
    if (!box) return;
    const entries = Object.entries(byAccount || {});
    if (entries.length === 0) {
      box.innerHTML = '<div style="color:#6a6a8e;font-size:13px;">No accounts have assigned recipes yet.</div>';
      return;
    }
    box.innerHTML = '<div class="plf-account-breakdown">' + entries.map(([key, stat]) => {
      const total = stat.recipes * 3;
      const pct = total > 0 ? Math.round((stat.posted / total) * 100) : 0;
      return `
        <div class="plf-account-stat">
          <div class="label">${escapeHtml(key)}</div>
          <div class="row"><span>Recipes assigned</span><span class="v">${stat.recipes}</span></div>
          <div class="row"><span>Pins posted</span><span class="v" style="color:#00d68f;">${stat.posted}</span></div>
          <div class="row"><span>Pins pending</span><span class="v" style="color:#9a9ab8;">${stat.pending}</span></div>
          <div class="row"><span>Eligible now</span><span class="v" style="color:#ffb347;">${stat.eligibleNow}</span></div>
          <div class="progress"><div class="fill" style="width:${pct}%;"></div></div>
        </div>
      `;
    }).join('') + '</div>';
  }

  // ── Recipes tab ──────────────────────────────────────────────
  let _recipesCache = null;

  // Persist filter changes server-side (debounced 400ms)
  const _saveRecipesFilters = debounce(async () => {
    const filters = {
      search: $('#plfRecSearch')?.value || '',
      site: $('#plfRecFilterSite')?.value || '',
      status: $('#plfRecFilterStatus')?.value || '',
      validation: $('#plfRecFilterValid')?.value || '',
    };
    state.uiState.recipesFilters = filters;
    try {
      await api('POST', '/api/planifier/ui-state', { recipesFilters: filters });
    } catch (e) {
      console.warn('[Planifier] save filters failed:', e.message);
    }
  }, 400);

  function _wireRecipesFilterListeners() {
    ['plfRecSearch', 'plfRecFilterSite', 'plfRecFilterStatus', 'plfRecFilterValid'].forEach(id => {
      const el = $('#' + id);
      if (!el) return;
      const handler = () => { plfRenderRecipes(); _saveRecipesFilters(); };
      // Replace existing handler if already wired
      if (el.dataset.plfWired) return;
      el.dataset.plfWired = '1';
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    });
  }

  function _restoreRecipesFilters() {
    const saved = state.uiState?.recipesFilters || {};
    if ($('#plfRecSearch')) $('#plfRecSearch').value = saved.search || '';
    if ($('#plfRecFilterSite')) $('#plfRecFilterSite').value = saved.site || '';
    if ($('#plfRecFilterStatus')) $('#plfRecFilterStatus').value = saved.status || '';
    if ($('#plfRecFilterValid')) $('#plfRecFilterValid').value = saved.validation || '';
  }

  async function plfLoadRecipes() {
    const box = $('#plfRecipesTable');
    if (!box) return;
    box.innerHTML = '<div style="padding:18px;color:#6a6a8e;font-size:13px;">Loading all recipes from sheet…</div>';
    try {
      // Refresh UI state from server in case another tab/session changed it
      try { state.uiState = await api('GET', '/api/planifier/ui-state'); } catch {}
      const r = await api('GET', '/api/planifier/recipes');
      _recipesCache = r;
      // Stat cards. WP REST returns 'publish' (singular); also accept legacy
      // 'published' from manually-filled sheet col R. Counts FUTURE separately
      // so user sees scheduled recipes at a glance.
      $('#plfRecStatTotal').textContent = r.summary.total;
      const byWp = r.summary.byWpStatus || {};
      const pubCount = (byWp.publish || 0) + (byWp.published || 0);
      const draftCount = (byWp.draft || 0) + (byWp['auto-draft'] || 0);
      const futureCount = byWp.future || 0;
      // Show "X publish · Y draft · Z scheduled" so all 3 states are visible
      $('#plfRecStatPublished').textContent = futureCount
        ? `${pubCount} · ${draftCount}d · ${futureCount}📅`
        : `${pubCount}${draftCount ? ' · ' + draftCount + ' draft' : ''}`;
      $('#plfRecStatPending').textContent = (r.summary.byStatus?.pending) || 0;
      $('#plfRecStatValid').textContent = r.summary.validationStats?.valid || 0;
      // Populate site filter
      const sites = Object.keys(r.summary.bySite || {}).sort();
      const sel = $('#plfRecFilterSite');
      const prevDom = sel.value;
      sel.innerHTML = '<option value="">All sites</option>' +
        sites.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)} (${r.summary.bySite[s]})</option>`).join('');
      // Restore saved filters (overrides DOM defaults)
      _restoreRecipesFilters();
      _wireRecipesFilterListeners();
      // Render with applied filters
      plfRenderRecipes();
    } catch (e) {
      box.innerHTML = `<div class="plf-rec-empty" style="color:#ff6b6b;">Failed: ${escapeHtml(e.message)}</div>`;
    }
  }

  // Render WP status as a colored badge. Maps live WP statuses to readable
  // labels with a color cue: publish=green, draft=red, future=violet, etc.
  // Empty/null = grey "—" so the user knows it wasn't fetched.
  function _renderWpBadge(wpStatus) {
    const s = (wpStatus || '').toLowerCase();
    const labelMap = {
      publish: 'PUBLISH',
      published: 'PUBLISH',
      draft: 'DRAFT',
      future: 'SCHEDULED',
      pending: 'PENDING',
      private: 'PRIVATE',
      trash: 'TRASH',
      'auto-draft': 'AUTO-DRAFT',
    };
    const clsMap = {
      publish: 'plf-rec-wp-publish',
      published: 'plf-rec-wp-publish',
      draft: 'plf-rec-wp-draft',
      future: 'plf-rec-wp-future',
      pending: 'plf-rec-wp-pending',
      private: 'plf-rec-wp-private',
      trash: 'plf-rec-wp-trash',
      'auto-draft': 'plf-rec-wp-draft',
    };
    if (!s || s === '—' || s === '(none)') {
      return '<span class="plf-rec-wp-badge plf-rec-wp-none">—</span>';
    }
    const label = labelMap[s] || s.toUpperCase();
    const cls = clsMap[s] || 'plf-rec-wp-none';
    return `<span class="plf-rec-wp-badge ${cls}">${escapeHtml(label)}</span>`;
  }

  function plfRenderRecipes() {
    if (!_recipesCache) return;
    const box = $('#plfRecipesTable');
    if (!box) return;

    const search = ($('#plfRecSearch')?.value || '').toLowerCase().trim();
    const filterSite = $('#plfRecFilterSite')?.value || '';
    const filterStatus = $('#plfRecFilterStatus')?.value || '';
    const filterValid = $('#plfRecFilterValid')?.value || '';

    // Tag each recipe with isNonLive — visible flag for recipes that
    // shouldn't receive Pinterest pins (recipe page is draft/future/trashed
    // OR sheet says done but no draftUrl was ever written).
    const _isNonLive = r => {
      const status = (r.status || '').toLowerCase();
      const wp = (r.wpStatus || '').toLowerCase();
      // Orphan: marked done but no draftUrl
      if (status === 'done' && !r.draftUrl) return true;
      // Done but WP says non-public (only if R column populated)
      if (status === 'done' && wp && wp !== 'publish' && wp !== 'published') return true;
      return false;
    };

    let list = _recipesCache.recipes.map(r => ({ ...r, isNonLive: _isNonLive(r) }));
    if (search) list = list.filter(r => (r.topic || '').toLowerCase().includes(search));
    if (filterSite) list = list.filter(r => r.site === filterSite);
    if (filterStatus) list = list.filter(r => (r.status || '') === filterStatus);
    if (filterValid) {
      if (filterValid === 'valid') list = list.filter(r => r.validation?.valid === true);
      else if (filterValid === 'invalid') list = list.filter(r => r.validation?.valid === false);
      else if (filterValid === 'none') list = list.filter(r => !r.validation);
      else if (filterValid === 'nonlive') list = list.filter(r => r.isNonLive);
    }

    if (list.length === 0) {
      box.innerHTML = '<div class="plf-rec-empty">No recipes match the current filters.</div>';
      return;
    }

    const header = `
      <div class="plf-rec-header">
        <div>Row</div>
        <div>Recipe</div>
        <div>Status</div>
        <div>WP</div>
        <div>Validation</div>
        <div>Pins</div>
        <div style="text-align:right;">Actions</div>
      </div>
    `;
    const rowsHtml = list.map(r => {
      const status = r.status || '';
      const statusClass = status ? `plf-rec-status-${status}` : 'plf-rec-status-pending';
      const wpStatus = r.wpStatus || '—';
      let validationHtml = '<span style="color:#6a6a8e;font-size:11px;">— not yet</span>';
      if (r.validation?.valid === true) {
        validationHtml = `<span class="plf-validation-badge valid" title="Recipe valid">✓</span> <span style="color:#00d68f;font-size:11px;">valid</span> <button class="plf-validation-clear" onclick="event.stopPropagation();plfClearValidation('${escapeHtml(r.site)}', ${r.rowIndex})" title="Clear validation (revert col X)">×</button>`;
      } else if (r.validation?.valid === false) {
        const tip = (r.validation.issues || []).map(i => i.msg || i.kind).join(' / ');
        validationHtml = `<span class="plf-validation-badge invalid" title="${escapeHtml(tip)}">⚠</span> <span style="color:#ffb347;font-size:11px;">invalid</span> <button class="plf-validation-clear" onclick="event.stopPropagation();plfClearValidation('${escapeHtml(r.site)}', ${r.rowIndex})" title="Clear validation (revert col X)">×</button>`;
      }
      const pinsHtml = r.pins.map((p, idx) => {
        if (!p.imageUrl) return `<div class="plf-rec-pin-thumb empty" title="Pin #${idx+1} — no image">${idx+1}</div>`;
        const postedCls = p.postedAt ? ' posted' : '';
        return `<a href="${escapeHtml(p.imageUrl)}" target="_blank" rel="noopener" class="plf-rec-pin-thumb${postedCls}" title="Pin #${idx+1}${p.postedAt ? ' — posted ' + p.postedAt.slice(0,10) : ''}"><img src="${escapeHtml(p.imageUrl)}" loading="lazy" /></a>`;
      }).join('');
      const draftUrl = r.draftUrl || '';
      const isOrphan = status === 'done' && !draftUrl;
      const isNonLive = r.isNonLive;
      const rowCls = (r.validation?.valid === false ? 'invalid ' : '') + (isOrphan ? 'orphan ' : '') + (isNonLive && !isOrphan ? 'nonlive ' : '');

      // Action buttons depend on state
      let actionsHtml = '';
      if (isOrphan) {
        // Orphan: done in sheet but no URL written. Offer to reset.
        actionsHtml = `
          <span class="plf-rec-orphan-badge" title="Marked 'done' in col B but no draftUrl in col C — the orchestrator likely crashed between WP create and sheet write. Click Reset to re-process.">⚠ no URL</span>
          <button class="reset" onclick="plfResetRecipe('${escapeHtml(r.site)}', ${r.rowIndex}, '${escapeHtml(r.topic||'')}')" title="Reset status to 'pending' so the orchestrator reprocesses it">↻ Reset</button>
          <button class="delete" onclick="plfDeleteRecipe('${escapeHtml(r.site)}', ${r.rowIndex}, '${escapeHtml(r.topic||'')}')" title="HARD DELETE: WP post + media + reset sheet row to pending">Delete</button>
        `;
      } else {
        // "New Pin" button only for posted recipes (status=done + draftUrl)
        const canCreatePin = status === 'done' && !!draftUrl;
        actionsHtml = `
          <button onclick="plfValidateOneRecipe('${escapeHtml(r.site)}', ${r.rowIndex}, '${escapeHtml(draftUrl)}')" title="Re-validate via WP REST" ${draftUrl ? '' : 'disabled style="opacity:0.4;cursor:not-allowed;"'}>Validate</button>
          ${canCreatePin ? `<button class="new-pin" onclick="plfNewPinForRecipe('${escapeHtml(r.site)}', '${escapeHtml(draftUrl)}', '${escapeHtml((r.topic || '').replace(/'/g, "\\'"))}')" title="Schedule a new pin for this recipe via calendar">＋ New Pin</button>` : ''}
          ${draftUrl ? `<a href="${escapeHtml(draftUrl)}" target="_blank" rel="noopener" title="Open in WP admin">Edit</a>` : ''}
          <button class="delete" onclick="plfDeleteRecipe('${escapeHtml(r.site)}', ${r.rowIndex}, '${escapeHtml(r.topic||'')}')" title="HARD DELETE: WP post + media + reset sheet row to pending (topic kept)">Delete</button>
        `;
      }

      return `
        <div class="plf-rec-row ${rowCls}" data-rec-key="${escapeHtml(r.site)}-${r.rowIndex}" onclick="plfToggleRecipeDetail('${escapeHtml(r.site)}-${r.rowIndex}', event)">
          <div class="rownum">${r.rowIndex}</div>
          <div class="topic">
            ${escapeHtml(r.topic || '(empty)')}
            ${isNonLive && !isOrphan ? `<span class="rec-nonlive-flag" title="WP status: ${escapeHtml(r.wpStatus || 'unknown')} — recipe not public, pin posting will skip this">🔴 NOT LIVE (${escapeHtml(r.wpStatus || 'unknown')})</span>` : ''}
            <span class="site-tag">${escapeHtml(r.site)}${r.publishedAt ? ' · ' + escapeHtml(r.publishedAt) : ''}</span>
          </div>
          <div><span class="plf-rec-status-badge ${statusClass}">${escapeHtml(status || '—')}</span></div>
          <div>${_renderWpBadge(wpStatus)}</div>
          <div>${validationHtml}</div>
          <div class="plf-rec-pins" onclick="event.stopPropagation()">${pinsHtml}</div>
          <div class="plf-rec-actions" onclick="event.stopPropagation()">
            ${actionsHtml}
          </div>
        </div>
        <div class="plf-rec-detail" id="plfRecDetail-${escapeHtml(r.site)}-${r.rowIndex}">
          ${renderRecipeDetail(r)}
        </div>
      `;
    }).join('');

    box.innerHTML = header + rowsHtml;
  }

  function renderRecipeDetail(r) {
    const validationBlock = r.validation
      ? `<div class="validation-box ${r.validation.valid ? 'valid' : ''}" style="display:flex;align-items:flex-start;gap:12px;justify-content:space-between;">
           <div style="flex:1;">
             ${r.validation.valid ? '✓ Recipe valid' : '⚠ Recipe invalid'} · <span style="opacity:0.7;font-size:11px;">source: ${escapeHtml(r.validation.source || 'unknown')}</span>
             ${!r.validation.valid ? '<br/>' + (r.validation.issues || []).map(i => '• ' + escapeHtml(i.msg || i.kind)).join('<br/>') : ''}
           </div>
           <button onclick="event.stopPropagation();plfClearValidation('${escapeHtml(r.site)}', ${r.rowIndex})" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#c8c8e8;padding:5px 12px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit;flex-shrink:0;" title="Clear validation (sheet col X)">× Clear</button>
         </div>`
      : `<div class="validation-box" style="background:rgba(120,120,150,0.05);border-color:rgba(120,120,150,0.2);color:#9a9ab8;">Not yet validated — click <strong>Validate</strong> to check.</div>`;

    const linksHtml = `
      <div class="links-row">
        ${r.draftUrl ? `<a href="${escapeHtml(r.draftUrl)}" target="_blank" rel="noopener">Open in WP admin</a>` : ''}
        ${r.draftUrl ? `<a href="${escapeHtml(_publicUrlFromDraft(r.draftUrl))}" target="_blank" rel="noopener">View public post</a>` : ''}
      </div>
    `;

    const pinsHtml = r.pins.map((p, idx) => {
      const isPosted = !!p.postedAt;
      const cols = ['U', 'V', 'W'];
      const toggleBtn = p.imageUrl
        ? `<button class="pin-toggle ${isPosted ? 'posted' : ''}"
            onclick="plfTogglePinPostedFromRecipes('${escapeHtml(r.site)}', ${r.rowIndex}, ${idx}, ${isPosted})"
            title="Sheet col ${cols[idx]} row ${r.rowIndex}">
            ${isPosted ? '↺ Unmark posted' : '✓ Mark as posted'}
          </button>`
        : '';
      const regenBtn = `<button class="pin-regen"
          onclick="plfOpenRegenModal('${escapeHtml(r.site)}', ${r.rowIndex}, ${idx}, '${escapeHtml(r.topic||'')}', '${escapeHtml(p.imageUrl||'')}')"
          title="Regenerate this pin image">
          🔄 Regenerate
        </button>`;
      return `
        <div class="pin-card">
          <div class="pin-img">
            ${p.imageUrl
              ? `<a href="${escapeHtml(p.imageUrl)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.imageUrl)}" loading="lazy" /></a>`
              : '<div class="empty">No image</div>'}
          </div>
          <div class="title">Pin #${idx+1}: ${escapeHtml(p.title || '—')}</div>
          <div class="desc">${escapeHtml((p.description || '').slice(0,160))}${(p.description||'').length>160 ? '…' : ''}</div>
          ${isPosted ? `<span class="posted-tag">✓ posted ${escapeHtml(p.postedAt.slice(0,10))}</span>` : ''}
          ${toggleBtn}
          ${regenBtn}
        </div>
      `;
    }).join('');

    return `
      ${validationBlock}
      ${linksHtml}
      <div class="pin-detail-grid">${pinsHtml}</div>
    `;
  }

  function _publicUrlFromDraft(draftUrl) {
    try {
      const u = new URL(draftUrl);
      const postId = u.searchParams.get('post');
      if (postId) return `${u.origin}/?p=${postId}`;
    } catch {}
    return draftUrl;
  }

  window.plfToggleRecipeDetail = function (key, event) {
    if (event?.target?.tagName === 'BUTTON' || event?.target?.tagName === 'A') return;
    const el = document.getElementById(`plfRecDetail-${key}`);
    const row = document.querySelector(`.plf-rec-row[data-rec-key="${key}"]`);
    if (!el) return;
    el.classList.toggle('show');
    if (row) row.classList.toggle('expanded', el.classList.contains('show'));
  };

  window.plfClearValidation = async function (site, rowIndex) {
    if (!confirm(`Clear validation for row ${rowIndex}? (Erases col X in the sheet — recipe goes back to "not yet validated")`)) return;
    try {
      await api('DELETE', `/api/planifier/validate-recipe/${encodeURIComponent(site)}/${rowIndex}`);
      showToast('Validation cleared', 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Clear failed: ' + e.message, 'error');
    }
  };

  window.plfValidateOneRecipe = async function (site, rowIndex, draftUrl) {
    if (!draftUrl) {
      showToast('No draftUrl — recipe not yet published', 'error');
      return;
    }
    showToast('Validating…', 'info');
    try {
      await api('POST', '/api/planifier/validate-recipe', { site, rowIndex, draftUrl });
      showToast('Validation updated in sheet', 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Validation failed: ' + e.message, 'error');
    }
  };

  window.plfTogglePinPostedFromRecipes = async function (site, rowIndex, pinIndex, currentlyPosted) {
    const cols = ['U', 'V', 'W'];
    const msg = currentlyPosted
      ? `Unmark pin #${pinIndex + 1} of row ${rowIndex} (clears col ${cols[pinIndex]} — the planifier will re-post it)?`
      : `Mark pin #${pinIndex + 1} of row ${rowIndex} as POSTED (writes today's date to col ${cols[pinIndex]})?`;
    if (!confirm(msg)) return;
    try {
      const endpoint = currentlyPosted ? 'unmark-posted' : 'mark-posted';
      await api('POST', `/api/planifier/pin-pool/${endpoint}`, { site, rowIndex, pinIndex });
      showToast(currentlyPosted ? 'Unmarked' : 'Marked as posted', 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Update failed: ' + e.message, 'error');
    }
  };

  window.plfResetRecipe = async function (site, rowIndex, topic) {
    if (!confirm(`Reset "${topic}" (row ${rowIndex}) to 'pending'? The orchestrator will reprocess this recipe on its next batch run.`)) return;
    try {
      await api('PUT', `/api/planifier/recipes/${encodeURIComponent(site)}/${rowIndex}/reset`);
      showToast('Recipe reset to pending', 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Reset failed: ' + e.message, 'error');
    }
  };

  // ── Pin regeneration ─────────────────────────────────────────
  window.plfOpenRegenModal = async function (site, rowIndex, pinIndex, topic, currentImageUrl) {
    const existing = $('.plf-modal-backdrop');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.className = 'plf-modal-backdrop';
    modal.innerHTML = `
      <div class="plf-modal" style="width:min(820px, 96vw);max-height:90vh;overflow-y:auto;" onclick="event.stopPropagation()">
        <div class="plf-modal-title">🔄 Regenerate Pin #${pinIndex + 1}</div>
        <div class="plf-modal-sub">${escapeHtml(topic)} · row ${rowIndex} · ${escapeHtml(site)}</div>

        ${currentImageUrl ? `
        <div style="margin-bottom:14px;padding:12px;background:rgba(255,179,71,0.06);border:1px solid rgba(255,179,71,0.2);border-radius:8px;display:flex;gap:14px;align-items:center;">
          <img src="${escapeHtml(currentImageUrl)}" style="width:70px;height:70px;object-fit:cover;border-radius:6px;" />
          <div style="flex:1;font-size:12.5px;color:#ffd99b;">Current pin will be <strong>REPLACED</strong>. The old WP media will be deleted, sheet row updated.</div>
        </div>
        ` : ''}

        <!-- Hero info: auto-fetched from recipe's WP featured image -->
        <div style="margin-bottom:18px;padding:12px;background:rgba(0,214,143,0.05);border:1px solid rgba(0,214,143,0.2);border-radius:8px;display:flex;gap:14px;align-items:center;">
          <div style="width:42px;height:42px;border-radius:8px;background:rgba(0,214,143,0.15);display:flex;align-items:center;justify-content:center;font-size:20px;">🍽</div>
          <div style="flex:1;font-size:12.5px;color:#c8c8e8;">
            <div style="color:#00d68f;font-weight:700;">Hero = recipe's existing hero photo (from WP)</div>
            <div style="color:#9a9ab8;font-size:11.5px;margin-top:2px;">Auto-fetched at generation time — same logic as the Verified Generator (no need to choose).</div>
          </div>
        </div>

        <div style="font-size:11px;color:#9a9ab8;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Choose pin template</div>
        <div id="plfRegenTemplates" style="margin-bottom:18px;">
          <div style="color:#6a6a8e;font-size:12px;">Loading…</div>
        </div>

        <div id="plfRegenStatus" style="display:none;padding:10px 14px;background:rgba(33,150,243,0.08);border:1px solid rgba(33,150,243,0.2);border-radius:8px;margin-bottom:14px;font-size:12px;color:#6ea8fe;"></div>

        <div class="plf-modal-actions">
          <span style="font-size:11px;color:#6a6a8e;">Flow may take 1–4 min — watch progress below</span>
          <div class="plf-modal-actions-right">
            <button class="btn btn-outline-secondary" onclick="document.querySelector('.plf-modal-backdrop').remove()">Cancel</button>
            <button class="btn btn-save" id="plfRegenSubmitBtn" onclick="plfRegenSubmit('${escapeHtml(site)}', ${rowIndex}, ${pinIndex})" style="padding:9px 22px;font-size:12.5px;" disabled>✓ Validate &amp; Regenerate</button>
          </div>
        </div>
      </div>
    `;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);

    // Load templates only — hero is auto-fetched server-side
    try {
      const r = await api('GET', `/api/planifier/regen-assets/${encodeURIComponent(site)}`);
      _renderRegenGallery($('#plfRegenTemplates'), r.templatesGenerator.length ? r.templatesGenerator : r.templatesScraper, 'template');
      _updateRegenSubmitState();
    } catch (e) {
      $('#plfRegenTemplates').innerHTML = `<div style="color:#ff6b6b;font-size:12px;">Failed: ${escapeHtml(e.message)}</div>`;
    }
  };

  function _renderRegenGallery(box, items, kind) {
    if (!box) return;
    if (!items || items.length === 0) {
      box.innerHTML = `<div style="color:#ffb347;font-size:12px;padding:10px;background:rgba(255,179,71,0.06);border:1px solid rgba(255,179,71,0.2);border-radius:8px;">⚠ No ${kind} images found in backgrounds.json. Add some via Settings → Images.</div>`;
      return;
    }
    box.innerHTML = `
      <div class="plf-regen-gallery">
        ${items.map(it => `
          <div class="plf-regen-thumb" data-kind="${kind}" data-idx="${it.idx}" onclick="plfRegenPick(this)">
            <img src="${escapeHtml(it.thumbDataUrl)}" alt="${escapeHtml(it.name)}" />
            <div class="caption">${escapeHtml(it.name)}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  window.plfRegenPick = function (el) {
    const kind = el.dataset.kind;
    // Deselect siblings of the same kind
    document.querySelectorAll(`.plf-regen-thumb[data-kind="${kind}"]`).forEach(t => t.classList.remove('selected'));
    el.classList.add('selected');
    _updateRegenSubmitState();
  };

  function _updateRegenSubmitState() {
    const tmpl = document.querySelector('.plf-regen-thumb[data-kind="template"].selected');
    const btn = $('#plfRegenSubmitBtn');
    if (btn) btn.disabled = !tmpl;
  }

  window.plfRegenSubmit = async function (site, rowIndex, pinIndex) {
    const tmplEl = document.querySelector('.plf-regen-thumb[data-kind="template"].selected');
    if (!tmplEl) return;
    const templateIdx = Number(tmplEl.dataset.idx);
    const statusEl = $('#plfRegenStatus');
    const btn = $('#plfRegenSubmitBtn');
    if (btn) btn.disabled = true;
    if (statusEl) {
      statusEl.style.display = '';
      statusEl.textContent = '⏳ Starting regeneration… fetching recipe hero from WP + launching Flow…';
    }
    try {
      const r = await api('POST', '/api/planifier/regenerate-pin', {
        site, rowIndex, pinIndex, templateIdx,
      });
      statusEl.textContent = `🚀 Job ${r.job.id.slice(0,8)} queued — polling status…`;
      pollRegenJob(r.job.id, statusEl);
    } catch (e) {
      if (statusEl) {
        statusEl.style.background = 'rgba(244,67,54,0.08)';
        statusEl.style.borderColor = 'rgba(244,67,54,0.2)';
        statusEl.style.color = '#ff8585';
        statusEl.textContent = '✗ ' + e.message;
      }
      if (btn) btn.disabled = false;
    }
  };

  async function pollRegenJob(jobId, statusEl) {
    const start = Date.now();
    const tick = async () => {
      try {
        const job = await api('GET', `/api/planifier/regen-job/${jobId}`);
        const elapsed = Math.round((Date.now() - start) / 1000);
        const lastMsg = (job.log || []).slice(-1)[0]?.msg || '';
        if (statusEl) {
          if (job.status === 'queued' || job.status === 'in_progress') {
            statusEl.textContent = `⚙ ${job.status} · ${elapsed}s elapsed · ${lastMsg}`;
          } else if (job.status === 'done') {
            statusEl.style.background = 'rgba(0,214,143,0.08)';
            statusEl.style.borderColor = 'rgba(0,214,143,0.25)';
            statusEl.style.color = '#00d68f';
            statusEl.innerHTML = `✓ Done in ${elapsed}s · <a href="${escapeHtml(job.newPinUrl)}" target="_blank" style="color:#00d68f;text-decoration:underline;">View new pin</a> · Sheet updated.`;
            setTimeout(() => { plfLoadRecipes(); }, 1000);
            return;
          } else if (job.status === 'error') {
            statusEl.style.background = 'rgba(244,67,54,0.08)';
            statusEl.style.borderColor = 'rgba(244,67,54,0.2)';
            statusEl.style.color = '#ff8585';
            statusEl.textContent = `✗ Error after ${elapsed}s: ${job.error}`;
            return;
          }
        }
        if (job.status === 'queued' || job.status === 'in_progress') {
          setTimeout(tick, 3000);
        }
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Poll error: ' + e.message;
        setTimeout(tick, 6000);
      }
    };
    setTimeout(tick, 2000);
  }

  window.plfDeleteRecipe = async function (site, rowIndex, topic) {
    const msg = `Hard-delete "${topic}" (row ${rowIndex})?\n\nThis will:\n  • DELETE the WordPress post + all its media (irreversible)\n  • Reset sheet row to status=pending\n  • Clear all fields (draftUrl, pins, posted_at, validation…)\n  • KEEP only the topic name (col A)\n\nThe orchestrator will then re-process this recipe from scratch.\n\nContinue?`;
    if (!confirm(msg)) return;
    try {
      const r = await api('DELETE', `/api/planifier/recipes/${encodeURIComponent(site)}/${rowIndex}`);
      const detail = r.wpDeleted
        ? `WP post deleted (${r.mediaDeleted} media removed) · sheet reset`
        : (r.wpError ? `WP delete failed: ${r.wpError} · sheet reset` : 'Sheet reset (no WP post linked)');
      showToast(detail, 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  window.plfOpenAddRecipeModal = function () {
    if (!state.config) return showToast('Config not loaded', 'error');
    const sites = Object.keys(state.config.sites || {}).filter(n => !n.startsWith('_'));
    if (sites.length === 0) return showToast('No sites configured', 'error');
    const existing = $('.plf-modal-backdrop');
    if (existing) existing.remove();
    const siteOptions = sites.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    const modal = document.createElement('div');
    modal.className = 'plf-modal-backdrop';
    modal.innerHTML = `
      <div class="plf-modal" onclick="event.stopPropagation()">
        <div class="plf-modal-title">+ Add Recipe</div>
        <div class="plf-modal-sub">Writes a new row to the site's Google Sheet with status=pending. The orchestrator picks it up on next run.</div>
        <div class="plf-modal-fields">
          <div class="plf-rule-field">
            <label>Site</label>
            <select id="plfNewRecSite">${siteOptions}</select>
          </div>
          <div class="plf-rule-field">
            <label>Topic / Title</label>
            <input type="text" id="plfNewRecTopic" placeholder="e.g. Easy One-Pot Chicken Pasta" autofocus />
          </div>
        </div>
        <div class="plf-modal-actions">
          <span></span>
          <div class="plf-modal-actions-right">
            <button class="btn btn-outline-secondary" onclick="document.querySelector('.plf-modal-backdrop').remove()">Cancel</button>
            <button class="btn btn-save" onclick="plfCreateRecipe()" style="padding:9px 22px;font-size:12.5px;">Add to sheet</button>
          </div>
        </div>
      </div>
    `;
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
    setTimeout(() => $('#plfNewRecTopic')?.focus(), 100);
  };

  window.plfCreateRecipe = async function () {
    const site = $('#plfNewRecSite').value;
    const topic = $('#plfNewRecTopic').value.trim();
    if (!topic) { showToast('Topic required', 'error'); return; }
    try {
      const r = await api('POST', '/api/planifier/recipes', { site, topic });
      $('.plf-modal-backdrop')?.remove();
      showToast(`Added "${topic}" at row ${r.rowIndex}`, 'success');
      plfLoadRecipes();
    } catch (e) {
      showToast('Add failed: ' + e.message, 'error');
    }
  };

  window.plfLoadRecipes = plfLoadRecipes;
  window.plfRenderRecipes = plfRenderRecipes;

  window.plfCopyAppsScript = function () {
    const snippet = `function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.openById(body.spreadsheetId);
  const range = ss.getRange(body.range);

  if (body.values) range.setValues(body.values);
  if (body.bgColor) range.setBackground(body.bgColor);

  return ContentService.createTextOutput("OK");
}`;
    navigator.clipboard.writeText(snippet).then(
      () => showToast('Apps Script snippet copied — paste it into your script editor', 'success'),
      () => showToast('Clipboard copy failed', 'error')
    );
  };

  window.plfLoadPool = plfLoadPool;
  window.plfRenderPool = plfRenderPool;
  window.plfTogglePostedPin = async function (site, rowIndex, pinIndex, currentlyPosted) {
    const msg = currentlyPosted
      ? `Mark pin#${pinIndex + 1} of row ${rowIndex} as NOT posted? (Clears col ${['U','V','W'][pinIndex]} in the sheet — the planifier will re-post it.)`
      : `Mark pin#${pinIndex + 1} of row ${rowIndex} as POSTED? (Writes today's date to col ${['U','V','W'][pinIndex]}.)`;
    if (!confirm(msg)) return;
    try {
      const endpoint = currentlyPosted ? 'unmark-posted' : 'mark-posted';
      await api('POST', `/api/planifier/pin-pool/${endpoint}`, { site, rowIndex, pinIndex });
      showToast(currentlyPosted ? 'Unmarked' : 'Marked as posted', 'success');
      plfLoadPool();
    } catch (e) {
      showToast('Update failed: ' + e.message, 'error');
    }
  };

  window.plfLoadHistory = plfLoadHistory;
  window.plfClearHistory = async function () {
    if (!confirm('Permanently clear the planifier history? This cannot be undone.')) return;
    try {
      await api('DELETE', '/api/planifier/history');
      showToast('History cleared', 'success');
      plfLoadHistory();
    } catch (e) {
      showToast('Clear failed: ' + e.message, 'error');
    }
  };

  window.plfRegenToday = plfRegenToday;
  window.plfLoadOverview = plfLoadOverview;
  window.plfLoadDolphinProfiles = plfLoadDolphinProfiles;

  // ── Toast helper (falls back to console if dashboard.js's showToast is missing) ─
  function showToast(msg, kind) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, kind);
    } else {
      console.log('[Planifier]', kind || '', msg);
    }
  }
})();
