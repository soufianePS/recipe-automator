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
  };

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
      if (state.activeTab === 'config') await plfRenderConfigPanel();
      if (state.activeTab === 'rules') plfRenderRulesPanel();
      if (state.activeTab === 'plan') await plfLoadUpcoming(7);
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
      const [config, meta] = await Promise.all([
        api('GET', '/api/planifier/config'),
        api('GET', '/api/planifier/meta'),
      ]);
      state.config = config;
      state.meta = meta;

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
    box.innerHTML = '<div class="plf-timeline">' + plan.items.map(item => {
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
      return `
        <div class="plf-timeline-item ${item.locked ? 'locked' : ''}" data-date="${escapeHtml(plan.date)}" data-id="${escapeHtml(item.id)}">
          <div class="plf-timeline-time">${fmtTime(item.scheduledAt)}</div>
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
    renderDiagnostics();
  }

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
              <label>Recipes / day (min)</label>
              <input type="number" class="plf-site-rmin" min="0" value="${Number(site.recipesPerDayMin) || 0}" />
            </div>
            <div class="plf-rule-field">
              <label>Recipes / day (max)</label>
              <input type="number" class="plf-site-rmax" min="0" value="${Number(site.recipesPerDayMax) || 0}" />
            </div>
            <div class="plf-rule-field">
              <label>Pin distribution</label>
              <select class="plf-site-strategy">${strategyOptions.replace(`value="${site.pinDistribution || 'strategy_A'}"`, `value="${site.pinDistribution || 'strategy_A'}" selected`)}</select>
            </div>
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
      </div>
    `;
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
      site.pinterestAccounts = $$('.plf-account-card', card).map(ac => ({
        id: $('.plf-acc-id', ac).value.trim() || 'acc',
        dolphinProfileId: $('.plf-acc-dolphin', ac).value || null,
        status: $('.plf-acc-status', ac).value,
        pinsPerDayMin: Number($('.plf-acc-pmin', ac).value) || 0,
        pinsPerDayMax: Number($('.plf-acc-pmax', ac).value) || 0,
        boards: $('.plf-acc-boards', ac).value.split(',').map(s => s.trim()).filter(Boolean),
      }));
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
    const subLabel = `${item.site}${item.accountId ? ' / ' + item.accountId : ''} — ${fmtDate(date)}`;
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
      // Build new scheduledAt — same date, new time
      const [y, m, d] = date.split('-').map(Number);
      const [hh, mm] = time.split(':').map(Number);
      const newDate = new Date(y, m - 1, d, hh, mm, 0);
      const patch = { scheduledAt: newDate.toISOString(), locked };
      if (willPostEl) patch.willPost = willPostEl.checked;
      await api('PUT', `/api/planifier/plan/${date}/items/${itemId}`, patch);
      $('.plf-modal-backdrop').remove();
      showToast('Slot updated', 'success');
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
  async function plfLoadPool() {
    const box = $('#plfPoolTable');
    if (!box) return;
    box.innerHTML = '<div style="padding:18px;color:#6a6a8e;font-size:13px;">Loading pin pool from Google Sheet…</div>';
    try {
      const r = await api('GET', '/api/planifier/pin-pool');
      _poolCache = r;
      // Stats
      $('#plfPoolRecipes').textContent = r.summary.totalRecipes;
      $('#plfPoolPosted').textContent = r.summary.pinsPosted;
      $('#plfPoolPending').textContent = r.summary.pinsPending;
      $('#plfPoolEligible').textContent = r.summary.pinsEligibleNow;
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
      return `
        <div class="plf-pool-row">
          <div class="plf-pool-rownum">${r.rowIndex}</div>
          <div class="topic">
            ${escapeHtml(r.topic || '—')}
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
