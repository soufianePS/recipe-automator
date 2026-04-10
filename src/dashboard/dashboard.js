    // ================================================================
    // CONSTANTS
    // ================================================================
    const PHASE_LABELS = {
      'IDLE': 'Idle',
      'LOADING_JOB': 'Reading Google Sheet',
      'SELECTING_BACKGROUND': 'Selecting background',
      'SCRAPING_SITE': 'Scraping recipe page...',
      'DOWNLOADING_IMAGES': 'Downloading original images...',
      'GENERATING_RECIPE_JSON': 'Generating recipe (ChatGPT)',
      'CREATING_FOLDERS': 'Creating folders',
      'GENERATING_STEPS': 'Generating step images',
      'GENERATING_INGREDIENTS': 'Generating ingredients image',
      'GENERATING_HERO': 'Generating hero image',
      'SAVING_FILES': 'Saving files to disk',
      'UPLOADING_MEDIA': 'Uploading to WordPress',
      'PUBLISHING_DRAFT': 'Creating draft post',
      'GENERATING_PINS': 'Generating Pinterest pins',
      'UPLOADING_PINS': 'Uploading Pinterest pins',
      'UPDATING_SHEET': 'Updating Google Sheet',
      'COMPLETED': 'Completed!',
      'ERROR': 'Error',
      'PAUSED': 'Paused'
    };

    const STATUS_CATEGORIES = {
      'IDLE': 'idle',
      'COMPLETED': 'completed',
      'ERROR': 'error',
      'PAUSED': 'paused'
    };

    const STATE_ORDER = [
      'LOADING_JOB', 'SELECTING_BACKGROUND', 'GENERATING_RECIPE_JSON', 'CREATING_FOLDERS',
      'GENERATING_STEPS', 'GENERATING_INGREDIENTS', 'GENERATING_HERO',
      'SAVING_FILES', 'UPLOADING_MEDIA', 'PUBLISHING_DRAFT', 'GENERATING_PINS', 'UPLOADING_PINS', 'UPDATING_SHEET', 'COMPLETED'
    ];

    let currentSettings = {};
    let wprmEnabled = false;
    let pollTimer = null;
    let currentPage = 'dashboard';
    let settingsLoaded = false;

    // ================================================================
    // HASH-BASED ROUTING
    // ================================================================
    function navigateTo(page) {
      currentPage = page;

      // Update nav
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const activeNav = document.querySelector('.nav-item[data-page="' + page + '"]');
      if (activeNav) activeNav.classList.add('active');

      // Update pages
      document.querySelectorAll('.page-section').forEach(s => s.classList.remove('active'));
      const activeSection = document.getElementById('page-' + page);
      if (activeSection) activeSection.classList.add('active');

      // Close mobile sidebar
      document.getElementById('sidebar').classList.remove('open');

      // Load data for specific pages
      if (page === 'dashboard') loadDashboardData();
      if (page === 'settings' && !settingsLoaded) { loadSettings(); settingsLoaded = true; }
      if (page === 'sites') loadSites();
      if (page === 'generator' || page === 'scraper') checkLoginStatus();
    }

    // Listen for hash changes
    window.addEventListener('hashchange', () => {
      const hash = location.hash.replace('#', '') || 'dashboard';
      navigateTo(hash);
    });

    // Nav click handler
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const page = item.dataset.page;
        location.hash = '#' + page;
      });
    });

    // Settings sub-tabs
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('stab-' + tab.dataset.stab).classList.add('active');
        // Load Flow accounts data when switching to that tab
        if (tab.dataset.stab === 'flow-accounts') loadFlowAccounts();
      });
    });

    // ================================================================
    // TOAST
    // ================================================================
    function toast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => { if (el.parentNode) el.remove(); }, 4000);
    }

    // ================================================================
    // UTILITIES
    // ================================================================
    function escapeHtml(text) {
      if (!text) return '';
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function timeAgo(date) {
      const now = new Date();
      const d = new Date(date);
      const diffMs = now - d;
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) return diffSec + 's ago';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return diffMin + 'm ago';
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return diffHr + 'h ago';
      const diffDay = Math.floor(diffHr / 24);
      return diffDay + 'd ago';
    }

    // ================================================================
    // DASHBOARD PAGE
    // ================================================================
    async function loadDashboardData() {
      // Fetch stats
      try {
        const resp = await fetch('/api/stats');
        if (resp.ok) {
          const stats = await resp.json();
          document.getElementById('statPosts').textContent = stats.total ?? '--';
          document.getElementById('statImages').textContent = stats.total ? stats.total * 7 : '--';
          const rate = stats.total ? Math.round((stats.success / stats.total) * 100) : 0;
          document.getElementById('statRate').textContent = stats.total ? rate + '%' : '--';
          document.getElementById('statToday').textContent = stats.today ?? '--';
        }
      } catch {}

      // Fetch history
      try {
        const resp = await fetch('/api/history');
        if (resp.ok) {
          const history = await resp.json();
          renderHistory(history);
        }
      } catch {}
    }

    function renderHistory(items) {
      const list = document.getElementById('historyList');
      if (!items || items.length === 0) {
        list.innerHTML = '<li class="history-item"><div class="history-icon running">-</div><div class="history-title" style="color:#6a6a8a">No activity yet</div></li>';
        return;
      }
      const last10 = items.slice(-10).reverse();
      list.innerHTML = last10.map(item => {
        const isSuccess = item.status === 'COMPLETED' || item.status === 'success';
        const isError = item.status === 'ERROR' || item.status === 'error';
        const iconClass = isSuccess ? 'success' : isError ? 'error' : 'running';
        const iconChar = isSuccess ? '\u2713' : isError ? '\u2717' : '\u2022';
        const module = item.mode || item.module || '';
        const moduleClass = module === 'scrape' ? 'badge-scrape' : 'badge-generate';
        const moduleBadge = module ? '<span class="badge-module ' + moduleClass + '">' + escapeHtml(module) + '</span>' : '';

        return '<li class="history-item">' +
          '<div class="history-icon ' + iconClass + '">' + iconChar + '</div>' +
          '<div class="history-title">' + escapeHtml(item.title || item.recipeTitle || 'Untitled') + ' ' + moduleBadge + '</div>' +
          '<div class="history-time">' + (item.timestamp || item.completedAt ? timeAgo(item.timestamp || item.completedAt) : '') + '</div>' +
        '</li>';
      }).join('');
    }

    // ================================================================
    // POLLING (Generator / Scraper pages)
    // ================================================================
    async function pollState() {
      try {
        const resp = await fetch('/api/state');
        if (!resp.ok) return;
        const state = await resp.json();

        // Update sidebar status
        const status = state.status || 'IDLE';
        const cat = STATUS_CATEGORIES[status] || 'active';
        document.getElementById('sidebarDot').className = 'status-dot ' + cat;
        document.getElementById('sidebarStatus').textContent = PHASE_LABELS[status] || status;

        // Update Generator page
        updateModulePage('gen', state);
        // Update Scraper page
        updateModulePage('scr', state);
      } catch {}

      // Check if open-browser was closed manually
      try {
        const bResp = await fetch('/api/browser-status');
        if (bResp.ok) {
          const { open } = await bResp.json();
          ['gen', 'scr'].forEach(p => {
            const openBtn = document.getElementById(p + 'BtnOpenBrowser');
            const closeBtn = document.getElementById(p + 'BtnCloseBrowser');
            if (!open && closeBtn.style.display !== 'none') {
              closeBtn.style.display = 'none';
              openBtn.style.display = '';
              openBtn.disabled = false;
            }
          });
        }
      } catch {}

      // Fetch logs for active pages
      if (currentPage === 'generator' || currentPage === 'scraper') {
        try {
          const resp = await fetch('/api/logs');
          if (!resp.ok) return;
          const logs = await resp.json();
          updateActivityFeed('genActivityFeed', logs);
          updateActivityFeed('scrActivityFeed', logs);
        } catch {}
      }
    }

    function updateModulePage(prefix, state) {
      const status = state.status || 'IDLE';
      const cat = STATUS_CATEGORIES[status] || 'active';

      // Badge
      const badgeEl = document.getElementById(prefix + 'State');
      if (badgeEl) {
        badgeEl.textContent = status;
        badgeEl.className = 'badge badge-' + cat;
      }

      // Recipe
      const recipeEl = document.getElementById(prefix + 'Recipe');
      if (recipeEl) recipeEl.textContent = state.recipeTitle || '--';

      // Phase
      const phaseEl = document.getElementById(prefix + 'Phase');
      if (phaseEl) phaseEl.textContent = PHASE_LABELS[status] || status;

      // Step
      const stepEl = document.getElementById(prefix + 'Step');
      if (stepEl) {
        if (status === 'GENERATING_STEPS' && state.steps && state.steps[state.currentStepIndex]) {
          const idx = state.currentStepIndex;
          stepEl.textContent = (idx + 1) + '/' + state.steps.length + ' - ' + (state.steps[idx].title || 'Step ' + (idx + 1));
        } else {
          stepEl.textContent = '--';
        }
      }

      // Progress
      const totalSteps = (state.steps?.length || 0) + 6;
      let done = 0;
      const stateIdx = STATE_ORDER.indexOf(status);

      if (status === 'COMPLETED') {
        done = totalSteps;
      } else if (status === 'GENERATING_STEPS') {
        done = state.currentStepIndex || 0;
      } else if (status === 'GENERATING_INGREDIENTS') {
        done = state.steps?.length || 0;
      } else if (status === 'GENERATING_HERO') {
        done = (state.steps?.length || 0) + 1;
      } else if (stateIdx > 6) {
        done = (state.steps?.length || 0) + 2 + (stateIdx - 7);
      } else if (stateIdx >= 0 && stateIdx < 4) {
        done = 0;
      }

      const pct = totalSteps > 0 ? Math.min(100, Math.round(done / totalSteps * 100)) : 0;
      const progressEl = document.getElementById(prefix + 'Progress');
      const progressText = document.getElementById(prefix + 'ProgressText');
      if (progressEl) progressEl.style.width = pct + '%';
      if (progressText) progressText.textContent = pct + '%';

      // Error
      const errEl = document.getElementById(prefix + 'Error');
      if (errEl) {
        if (state.error) {
          errEl.textContent = state.error;
          errEl.classList.add('visible');
        } else {
          errEl.textContent = '';
          errEl.classList.remove('visible');
        }
      }

      // Buttons
      const isRunning = state.automationRunning;
      const isPaused = status === 'PAUSED';
      const isError = status === 'ERROR';

      const btnStart = document.getElementById(prefix + 'BtnStart');
      const btnPause = document.getElementById(prefix + 'BtnPause');
      const btnResume = document.getElementById(prefix + 'BtnResume');
      const btnReset = document.getElementById(prefix + 'BtnReset');

      if (btnStart) btnStart.disabled = isRunning;
      if (btnPause) btnPause.disabled = !isRunning;
      if (btnResume) btnResume.disabled = isRunning || (!isPaused && !isError);
      if (btnReset) btnReset.disabled = isRunning;
    }

    function updateActivityFeed(feedId, logs) {
      const feed = document.getElementById(feedId);
      if (!feed) return;
      const last = logs.slice(-30);
      if (last.length === 0) return;

      feed.innerHTML = last.map(l => {
        const time = new Date(l.timestamp).toLocaleTimeString();
        const cls = 'activity-' + (l.type || 'info');
        return '<div class="activity-item ' + cls + '">' +
          '<span class="time">' + time + '</span>' +
          '<span>' + escapeHtml(l.message) + '</span></div>';
      }).join('');
      feed.scrollTop = feed.scrollHeight;
    }

    // ================================================================
    // GOOGLE LOGIN
    // ================================================================
    async function checkLoginStatus() {
      try {
        const resp = await fetch('/api/login-status');
        const data = await resp.json();

        ['gen', 'scr'].forEach(prefix => {
          const bar = document.getElementById(prefix + 'LoginBar');
          const statusEl = document.getElementById(prefix + 'LoginStatus');
          const btnLogin = document.getElementById(prefix + 'BtnLogin');
          const btnDone = document.getElementById(prefix + 'BtnLoginDone');

          if (data.loggedIn) {
            bar.classList.add('logged-in');
            statusEl.textContent = '\u2713 Logged in to Google -- Flow is ready';
            btnLogin.style.display = 'none';
            btnDone.style.display = 'none';
          } else {
            bar.classList.remove('logged-in');
            statusEl.textContent = 'Not logged in to Google -- Flow won\'t work until you log in';
            btnLogin.style.display = '';
            btnDone.style.display = 'none';
          }
        });
      } catch {
        ['gen', 'scr'].forEach(prefix => {
          const statusEl = document.getElementById(prefix + 'LoginStatus');
          if (statusEl) statusEl.textContent = 'Could not check login status';
        });
      }
    }

    async function doLogin(prefix) {
      try {
        const btn = document.getElementById(prefix + 'BtnLogin');
        btn.disabled = true;
        const resp = await fetch('/api/login', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          toast('Browser opened -- log in to Google, then click Done', 'success');
          ['gen', 'scr'].forEach(p => {
            document.getElementById(p + 'BtnLogin').style.display = 'none';
            document.getElementById(p + 'BtnLoginDone').style.display = '';
          });
        } else {
          toast(data.error || 'Failed', 'error');
          btn.disabled = false;
        }
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        document.getElementById(prefix + 'BtnLogin').disabled = false;
      }
    }

    async function doLoginDone(prefix) {
      try {
        const btn = document.getElementById(prefix + 'BtnLoginDone');
        btn.disabled = true;
        const resp = await fetch('/api/login-done', { method: 'POST' });
        const data = await resp.json();
        if (data.loggedIn) {
          toast('Google login saved!', 'success');
        } else {
          toast(data.message || 'Login not detected', 'error');
        }
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnLoginDone').style.display = 'none';
          const loginBtn = document.getElementById(p + 'BtnLogin');
          loginBtn.style.display = '';
          loginBtn.disabled = false;
        });
        checkLoginStatus();
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        document.getElementById(prefix + 'BtnLoginDone').disabled = false;
      }
    }

    // ================================================================
    // OPEN BROWSER (for ChatGPT / Google / any login)
    // ================================================================
    async function openBrowser() {
      try {
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnOpenBrowser').disabled = true;
        });
        const resp = await fetch('/api/open-browser', { method: 'POST' });
        const data = await resp.json();
        if (resp.ok) {
          toast(data.message || 'Browser opened', 'success');
          ['gen', 'scr'].forEach(p => {
            document.getElementById(p + 'BtnOpenBrowser').style.display = 'none';
            document.getElementById(p + 'BtnCloseBrowser').style.display = '';
          });
        } else {
          toast(data.error || 'Failed to open browser', 'error');
          ['gen', 'scr'].forEach(p => {
            document.getElementById(p + 'BtnOpenBrowser').disabled = false;
          });
        }
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnOpenBrowser').disabled = false;
        });
      }
    }

    async function closeBrowser() {
      try {
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnCloseBrowser').disabled = true;
        });
        const resp = await fetch('/api/close-browser', { method: 'POST' });
        const data = await resp.json();
        toast(data.message || 'Browser closed', 'success');
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnCloseBrowser').style.display = 'none';
          const openBtn = document.getElementById(p + 'BtnOpenBrowser');
          openBtn.style.display = '';
          openBtn.disabled = false;
        });
        checkLoginStatus();
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        ['gen', 'scr'].forEach(p => {
          document.getElementById(p + 'BtnCloseBrowser').disabled = false;
        });
      }
    }

    // ================================================================
    // AUTOMATION CONTROLS
    // ================================================================
    async function doStart(mode) {
      // Set mode first
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: mode })
        });
      } catch (e) {
        toast('Failed to set mode: ' + e.message, 'error');
        return;
      }

      // Disable both start buttons
      const genBtn = document.getElementById('genBtnStart');
      const scrBtn = document.getElementById('scrBtnStart');
      if (genBtn) genBtn.disabled = true;
      if (scrBtn) scrBtn.disabled = true;

      try {
        const resp = await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: mode })
        });
        const data = await resp.json();
        if (data.ok) {
          const count = data.totalRecipes || 1;
          toast('Started: ' + count + ' recipe' + (count > 1 ? 's' : '') + ' queued (' + mode + ')', 'success');
          startBatchPoll();
        } else {
          toast(data.error || 'Failed to start', 'error');
          if (genBtn) genBtn.disabled = false;
          if (scrBtn) scrBtn.disabled = false;
        }
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        if (genBtn) genBtn.disabled = false;
        if (scrBtn) scrBtn.disabled = false;
      }
    }

    async function doPause() {
      try {
        const resp = await fetch('/api/pause', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) toast('Automation paused', 'warning');
        else toast(data.error || 'Failed to pause', 'error');
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
      }
    }

    async function doResume() {
      const genBtn = document.getElementById('genBtnResume');
      const scrBtn = document.getElementById('scrBtnResume');
      if (genBtn) genBtn.disabled = true;
      if (scrBtn) scrBtn.disabled = true;

      try {
        const resp = await fetch('/api/resume', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) toast('Automation resumed', 'success');
        else {
          toast(data.error || 'Failed to resume', 'error');
          if (genBtn) genBtn.disabled = false;
          if (scrBtn) scrBtn.disabled = false;
        }
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
        if (genBtn) genBtn.disabled = false;
        if (scrBtn) scrBtn.disabled = false;
      }
    }

    async function doReset() {
      if (!confirm('Reset will stop automation and clear all progress. Continue?')) return;
      try {
        const resp = await fetch('/api/reset', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) toast('Automation reset', 'info');
        else toast(data.error || 'Failed to reset', 'error');
      } catch (e) {
        toast('Request failed: ' + e.message, 'error');
      }
    }

    // ================================================================
    // BATCH MODE
    // ================================================================
    let batchPollTimer = null;

    function startBatchPoll() {
      if (batchPollTimer) clearInterval(batchPollTimer);
      batchPollTimer = setInterval(pollBatchStatus, 3000);
      pollBatchStatus();
    }

    async function pollBatchStatus() {
      try {
        const resp = await fetch('/api/batch/status');
        if (!resp.ok) return;
        const data = await resp.json();

        ['gen', 'scr'].forEach(prefix => {
          const card = document.getElementById(prefix + 'BatchCard');
          const el = document.getElementById(prefix + 'BatchProgress');
          if (!card || !el) return;

          if (!data.active && !data.results?.length) {
            card.style.display = 'none';
            return;
          }

          card.style.display = '';

          const pct = data.total > 0 ? Math.round(data.completed / data.total * 100) : 0;
          const etaMin = data.estimatedRemainingMs > 0 ? Math.round(data.estimatedRemainingMs / 60000) : 0;
          const avgMin = data.avgDurationMs > 0 ? (data.avgDurationMs / 60000).toFixed(1) : '--';

          let html = '<div style="margin-bottom:12px;">';
          html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">';
          html += '<span><strong>' + data.completed + '/' + data.total + '</strong> recipes</span>';
          html += '<span style="color:#4caf50;">' + data.successes + ' done</span>';
          if (data.errors > 0) html += '<span style="color:#f44336;">' + data.errors + ' failed</span>';
          html += '</div>';

          // Progress bar
          html += '<div style="background:#333;border-radius:8px;height:20px;overflow:hidden;">';
          html += '<div style="background:linear-gradient(90deg,#4caf50,#66bb6a);height:100%;width:' + pct + '%;transition:width 0.5s;border-radius:8px;"></div>';
          html += '</div>';

          // Current recipe + ETA
          if (data.active && data.currentRecipe) {
            html += '<div style="margin-top:8px;font-size:13px;color:#aaa;">';
            html += 'Now: <strong style="color:#fff;">' + escapeHtml(data.currentRecipe) + '</strong>';
            html += ' (' + (PHASE_LABELS[data.currentStatus] || data.currentStatus) + ')';
            if (etaMin > 0) html += ' &mdash; ~' + etaMin + 'min remaining';
            html += '</div>';
          }
          html += '</div>';

          // Results table
          if (data.results && data.results.length > 0) {
            html += '<div style="max-height:200px;overflow-y:auto;font-size:12px;">';
            html += '<table style="width:100%;border-collapse:collapse;">';
            for (const r of data.results) {
              const icon = r.status === 'success' ? '\u2713' : '\u2717';
              const color = r.status === 'success' ? '#4caf50' : '#f44336';
              const dur = r.duration ? (r.duration / 60000).toFixed(1) + 'min' : '';
              const detail = r.status === 'success' ? (r.draftUrl || '') : (r.error || '').substring(0, 60);
              html += '<tr style="border-bottom:1px solid #333;">';
              html += '<td style="padding:4px;color:' + color + ';">' + icon + '</td>';
              html += '<td style="padding:4px;">' + escapeHtml(r.topic || '') + '</td>';
              html += '<td style="padding:4px;color:#888;">' + dur + '</td>';
              html += '<td style="padding:4px;color:#888;font-size:11px;">' + escapeHtml(detail) + '</td>';
              html += '</tr>';
            }
            html += '</table></div>';
          }

          // Batch complete
          if (!data.active && data.completed >= data.total && data.total > 0) {
            html += '<div style="margin-top:10px;padding:8px;background:#1b3a1b;border-radius:6px;text-align:center;">';
            html += '<strong style="color:#4caf50;">Batch complete!</strong> ';
            html += data.successes + ' success, ' + data.errors + ' failed. Avg: ' + avgMin + 'min/recipe';
            html += '</div>';
            if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
          }

          el.innerHTML = html;
        });
      } catch {}
    }

    // ================================================================
    // TEMPLATE EDITOR
    // ================================================================
    const DEFAULT_TEMPLATE = [
      { type: 'paragraphs', from: 0, count: 2 },
      { type: 'hero' },
      { type: 'paragraphs', from: 2, count: 1 },
      { type: 'heading', text: 'Ingredients', level: 2 },
      { type: 'ingredients-image' },
      { type: 'ingredients-list' },
      { type: 'heading', text: 'Instructions', level: 2 },
      { type: 'steps', showTip: true },
      { type: 'heading', text: 'Pro Tips', level: 2 },
      { type: 'tips' },
      { type: 'storage' },
      { type: 'fun-fact' },
      { type: 'separator' },
      { type: 'recipe-card' },
      { type: 'heading', text: 'Frequently Asked Questions', level: 2 },
      { type: 'faq' },
      { type: 'heading', text: 'Final Thoughts', level: 2 },
      { type: 'note' }
    ];

    const BLOCK_META = {
      'intro':             { icon: '\u270d', label: 'Introduction' },
      'hero':              { icon: '\ud83d\uddbc', label: 'Hero Image' },
      'paragraphs':        { icon: '\u00b6', label: 'Paragraphs', hasConfig: true },
      'heading':           { icon: 'H', label: 'Heading', hasConfig: true },
      'ingredients-image': { icon: '\ud83d\udcf7', label: 'Ingredients Image' },
      'ingredients-list':  { icon: '\ud83e\udd55', label: 'Ingredients List' },
      'steps':             { icon: '\ud83d\udc63', label: 'Steps', hasConfig: true },
      'tips':              { icon: '\ud83d\udca1', label: 'Pro Tips', hasConfig: true },
      'faq':               { icon: '\u2753', label: 'FAQ', hasConfig: true },
      'storage':           { icon: '\u2744', label: 'Storage Info', hasConfig: true },
      'equipment':         { icon: '\ud83d\udd27', label: 'Equipment', hasConfig: true },
      'custom-text':       { icon: '\u270f', label: 'Custom Text', hasConfig: true },
      'spacer':            { icon: '\u2195', label: 'Spacer', hasConfig: true },
      'fun-fact':          { icon: '\u2b50', label: 'Fun Fact', hasConfig: true },
      'recipe-card':       { icon: '\ud83c\udf72', label: 'Recipe Card (WPRM)' },
      'note':              { icon: '\ud83d\udcdd', label: 'Final Notes', hasConfig: true },
      'separator':         { icon: '\u2500', label: 'Divider Line' }
    };

    let postTemplate = [];

    function renderTemplate() {
      const container = document.getElementById('templateBlocks');
      container.innerHTML = '';
      postTemplate.forEach((block, index) => {
        const meta = BLOCK_META[block.type] || { icon: '?', label: block.type };
        const el = document.createElement('div');
        el.className = 'template-block';
        el.draggable = true;
        el.dataset.index = index;

        let detail = '';
        if (block.type === 'heading' && block.text) detail = '"' + block.text + '"';
        if (block.type === 'paragraphs') detail = 'from ' + (block.from || 0) + ', count ' + (block.count || 'all');
        if (block.type === 'steps') detail = block.showTip !== false ? 'with tips' : 'no tips';
        if (block.type === 'custom-text' && block.text) detail = '"' + block.text.substring(0, 30) + (block.text.length > 30 ? '...' : '') + '"';
        if (block.type === 'spacer') detail = block.height || '30px';

        el.innerHTML =
          '<span class="template-block-icon">' + meta.icon + '</span>' +
          '<span class="template-block-label">' + meta.label + '</span>' +
          '<span class="template-block-detail">' + detail + '</span>' +
          '<span class="template-block-actions">' +
            (meta.hasConfig ? '<button class="template-block-btn edit" title="Edit">\u2699</button>' : '') +
            '<button class="template-block-btn up" title="Move up">\u25b2</button>' +
            '<button class="template-block-btn down" title="Move down">\u25bc</button>' +
            '<button class="template-block-btn delete" title="Remove">\u2715</button>' +
          '</span>';

        if (meta.hasConfig) {
          const cfg = document.createElement('div');
          cfg.className = 'template-block-config';
          cfg.innerHTML = buildBlockConfig(block);
          el.appendChild(cfg);
        }

        el.querySelector('.up')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (index > 0) {
            [postTemplate[index-1], postTemplate[index]] = [postTemplate[index], postTemplate[index-1]];
            renderTemplate();
          }
        });
        el.querySelector('.down')?.addEventListener('click', (e) => {
          e.stopPropagation();
          if (index < postTemplate.length-1) {
            [postTemplate[index], postTemplate[index+1]] = [postTemplate[index+1], postTemplate[index]];
            renderTemplate();
          }
        });
        el.querySelector('.delete')?.addEventListener('click', (e) => {
          e.stopPropagation();
          postTemplate.splice(index, 1);
          renderTemplate();
        });
        el.querySelector('.edit')?.addEventListener('click', (e) => {
          e.stopPropagation();
          el.querySelector('.template-block-config').classList.toggle('open');
        });

        el.addEventListener('dragstart', (e) => {
          el.classList.add('dragging');
          e.dataTransfer.setData('text/plain', String(index));
        });
        el.addEventListener('dragend', () => el.classList.remove('dragging'));
        el.addEventListener('dragover', (e) => {
          e.preventDefault();
          el.classList.add('drag-over');
        });
        el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          el.classList.remove('drag-over');
          const from = parseInt(e.dataTransfer.getData('text/plain'));
          if (from !== index) {
            const [moved] = postTemplate.splice(from, 1);
            postTemplate.splice(index, 0, moved);
            renderTemplate();
          }
        });

        container.appendChild(el);
      });
      syncTemplate();
    }

    function buildBlockConfig(block) {
      if (block.type === 'heading') {
        return '<div class="config-field"><label>Text</label><input type="text" value="' + (block.text||'') + '" data-prop="text" onchange="updateBlockConfig(this)" /></div>' +
          '<div class="config-field"><label>Level</label><select data-prop="level" onchange="updateBlockConfig(this)">' +
          '<option value="2" ' + (block.level===2?'selected':'') + '>H2</option>' +
          '<option value="3" ' + (block.level===3?'selected':'') + '>H3</option>' +
          '<option value="4" ' + (block.level===4?'selected':'') + '>H4</option></select></div>';
      }
      if (block.type === 'paragraphs') {
        return '<div class="config-field" style="display:flex;gap:12px;">' +
            '<div><label>Start from</label><input type="number" value="' + (block.from||0) + '" min="0" style="width:60px" data-prop="from" onchange="updateBlockConfig(this)" /></div>' +
            '<div><label>Count</label><input type="number" value="' + (block.count||999) + '" min="1" style="width:60px" data-prop="count" onchange="updateBlockConfig(this)" /></div>' +
            '<div><label>Space between</label><select data-prop="spacing" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.spacing?'selected':'') + '>None</option>' +
              '<option value="10px" ' + (block.spacing==='10px'?'selected':'') + '>10px</option>' +
              '<option value="20px" ' + (block.spacing==='20px'?'selected':'') + '>20px</option>' +
              '<option value="30px" ' + (block.spacing==='30px'?'selected':'') + '>30px</option>' +
              '<option value="50px" ' + (block.spacing==='50px'?'selected':'') + '>50px</option></select></div>' +
          '</div>' +
          '<div class="config-field" style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;">' +
            '<label>Bold</label><select data-prop="bold" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.bold?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.bold?'selected':'') + '>Yes</option></select>' +
            '<label>Italic</label><select data-prop="italic" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.italic?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.italic?'selected':'') + '>Yes</option></select>' +
            '<label>Size</label><select data-prop="fontSize" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.fontSize?'selected':'') + '>Default</option>' +
              '<option value="13px" ' + (block.fontSize==='13px'?'selected':'') + '>Small</option>' +
              '<option value="16px" ' + (block.fontSize==='16px'?'selected':'') + '>Normal</option>' +
              '<option value="20px" ' + (block.fontSize==='20px'?'selected':'') + '>Large</option>' +
              '<option value="24px" ' + (block.fontSize==='24px'?'selected':'') + '>X-Large</option></select>' +
            '<label>Align</label><select data-prop="align" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.align?'selected':'') + '>Left</option>' +
              '<option value="center" ' + (block.align==='center'?'selected':'') + '>Center</option>' +
              '<option value="right" ' + (block.align==='right'?'selected':'') + '>Right</option></select>' +
          '</div>' +
          '<div class="config-field" style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;">' +
            '<label>Color</label><input type="color" value="' + (block.textColor||'#000000') + '" data-prop="textColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />' +
            '<label>BG</label><input type="color" value="' + (block.bgColor||'#ffffff') + '" data-prop="bgColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />' +
            '<label>Drop Cap</label><select data-prop="dropCap" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.dropCap?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.dropCap?'selected':'') + '>Yes</option></select>' +
            '<label>Line H</label><select data-prop="lineHeight" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.lineHeight?'selected':'') + '>Default</option>' +
              '<option value="1.2" ' + (block.lineHeight==='1.2'?'selected':'') + '>Tight</option>' +
              '<option value="1.5" ' + (block.lineHeight==='1.5'?'selected':'') + '>Normal</option>' +
              '<option value="1.8" ' + (block.lineHeight==='1.8'?'selected':'') + '>Relaxed</option>' +
              '<option value="2.0" ' + (block.lineHeight==='2.0'?'selected':'') + '>Wide</option></select>' +
          '</div>';
      }
      if (block.type === 'custom-text') {
        return '<div class="config-field"><label>Text</label><textarea data-prop="text" rows="2" style="width:100%;background:#0f0f1a;border:1px solid #2a2a4a;border-radius:6px;color:#e0e0e0;padding:6px;font-size:12px;" onchange="updateBlockConfig(this)">' + (block.text||'') + '</textarea></div>' +
          '<div class="config-field" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<label>Bold</label><select data-prop="bold" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.bold?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.bold?'selected':'') + '>Yes</option></select>' +
            '<label>Italic</label><select data-prop="italic" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.italic?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.italic?'selected':'') + '>Yes</option></select>' +
            '<label>Size</label><select data-prop="fontSize" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.fontSize?'selected':'') + '>Default</option>' +
              '<option value="13px" ' + (block.fontSize==='13px'?'selected':'') + '>Small</option>' +
              '<option value="16px" ' + (block.fontSize==='16px'?'selected':'') + '>Normal</option>' +
              '<option value="20px" ' + (block.fontSize==='20px'?'selected':'') + '>Large</option>' +
              '<option value="24px" ' + (block.fontSize==='24px'?'selected':'') + '>X-Large</option></select>' +
            '<label>Align</label><select data-prop="align" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.align?'selected':'') + '>Left</option>' +
              '<option value="center" ' + (block.align==='center'?'selected':'') + '>Center</option>' +
              '<option value="right" ' + (block.align==='right'?'selected':'') + '>Right</option></select>' +
          '</div>' +
          '<div class="config-field" style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap;">' +
            '<label>Color</label><input type="color" value="' + (block.textColor||'#000000') + '" data-prop="textColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />' +
            '<label>BG</label><input type="color" value="' + (block.bgColor||'#ffffff') + '" data-prop="bgColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />' +
            '<label>Drop Cap</label><select data-prop="dropCap" onchange="updateBlockConfig(this)">' +
              '<option value="false" ' + (!block.dropCap?'selected':'') + '>No</option>' +
              '<option value="true" ' + (block.dropCap?'selected':'') + '>Yes</option></select>' +
            '<label>Line H</label><select data-prop="lineHeight" onchange="updateBlockConfig(this)">' +
              '<option value="" ' + (!block.lineHeight?'selected':'') + '>Default</option>' +
              '<option value="1.2" ' + (block.lineHeight==='1.2'?'selected':'') + '>Tight</option>' +
              '<option value="1.5" ' + (block.lineHeight==='1.5'?'selected':'') + '>Normal</option>' +
              '<option value="1.8" ' + (block.lineHeight==='1.8'?'selected':'') + '>Relaxed</option>' +
              '<option value="2.0" ' + (block.lineHeight==='2.0'?'selected':'') + '>Wide</option></select>' +
          '</div>';
      }
      if (block.type === 'spacer') {
        return '<div class="config-field" style="display:flex;gap:12px;align-items:center;">' +
            '<label>Height</label><select data-prop="height" onchange="updateBlockConfig(this)">' +
              '<option value="10px" ' + (block.height==='10px'?'selected':'') + '>10px</option>' +
              '<option value="20px" ' + (block.height==='20px'?'selected':'') + '>20px</option>' +
              '<option value="30px" ' + (block.height==='30px'||!block.height?'selected':'') + '>30px</option>' +
              '<option value="50px" ' + (block.height==='50px'?'selected':'') + '>50px</option>' +
              '<option value="80px" ' + (block.height==='80px'?'selected':'') + '>80px</option>' +
              '<option value="100px" ' + (block.height==='100px'?'selected':'') + '>100px</option></select>' +
          '</div>';
      }
      // Shared styling for text blocks: tips, storage, faq, equipment, fun-fact, note, steps
      if (['tips','storage','faq','equipment','fun-fact','note','steps'].includes(block.type)) {
        let html = '<div class="config-field" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
        if (block.type === 'steps') {
          html += '<label>Show tips</label><select data-prop="showTip" onchange="updateBlockConfig(this)">' +
            '<option value="true" ' + (block.showTip!==false?'selected':'') + '>Yes</option>' +
            '<option value="false" ' + (block.showTip===false?'selected':'') + '>No</option></select>';
        }
        html += '<label>Size</label><select data-prop="fontSize" onchange="updateBlockConfig(this)">' +
            '<option value="" ' + (!block.fontSize?'selected':'') + '>Default</option>' +
            '<option value="13px" ' + (block.fontSize==='13px'?'selected':'') + '>Small</option>' +
            '<option value="16px" ' + (block.fontSize==='16px'?'selected':'') + '>Normal</option>' +
            '<option value="20px" ' + (block.fontSize==='20px'?'selected':'') + '>Large</option></select>' +
          '<label>Color</label><input type="color" value="' + (block.textColor||'#000000') + '" data-prop="textColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />' +
          '<label>BG</label><input type="color" value="' + (block.bgColor||'#ffffff') + '" data-prop="bgColor" onchange="updateBlockConfig(this)" style="width:30px;height:24px;padding:0;border:1px solid #2a2a4a;background:transparent;cursor:pointer;" />';
        if (['storage','fun-fact','note'].includes(block.type)) {
          html += '<label>Italic</label><select data-prop="italic" onchange="updateBlockConfig(this)">' +
            '<option value="false" ' + (!block.italic?'selected':'') + '>No</option>' +
            '<option value="true" ' + (block.italic?'selected':'') + '>Yes</option></select>';
        }
        if (['storage','faq','fun-fact','note','steps'].includes(block.type)) {
          html += '<label>Line H</label><select data-prop="lineHeight" onchange="updateBlockConfig(this)">' +
            '<option value="" ' + (!block.lineHeight?'selected':'') + '>Default</option>' +
            '<option value="1.2" ' + (block.lineHeight==='1.2'?'selected':'') + '>Tight</option>' +
            '<option value="1.5" ' + (block.lineHeight==='1.5'?'selected':'') + '>Normal</option>' +
            '<option value="1.8" ' + (block.lineHeight==='1.8'?'selected':'') + '>Relaxed</option>' +
            '<option value="2.0" ' + (block.lineHeight==='2.0'?'selected':'') + '>Wide</option></select>';
        }
        if (['fun-fact','note'].includes(block.type)) {
          html += '<label>Align</label><select data-prop="align" onchange="updateBlockConfig(this)">' +
            '<option value="" ' + (!block.align?'selected':'') + '>Left</option>' +
            '<option value="center" ' + (block.align==='center'?'selected':'') + '>Center</option>' +
            '<option value="right" ' + (block.align==='right'?'selected':'') + '>Right</option></select>';
        }
        html += '</div>';
        return html;
      }
      return '';
    }

    function updateBlockConfig(input) {
      const blockEl = input.closest('.template-block');
      const idx = parseInt(blockEl.dataset.index);
      const prop = input.dataset.prop;
      let val = input.value;
      if (prop === 'level' || prop === 'from' || prop === 'count') val = parseInt(val) || 0;
      if (prop === 'showTip' || prop === 'bold' || prop === 'italic' || prop === 'dropCap') val = val === 'true';
      postTemplate[idx][prop] = val;
      syncTemplate();
      renderTemplate();
    }

    function addTemplateBlock(select) {
      const type = select.value;
      if (!type) return;
      const block = { type };
      if (type === 'heading') { block.text = 'New Section'; block.level = 2; }
      if (type === 'paragraphs') { block.from = 0; block.count = 2; }
      if (type === 'steps') { block.showTip = true; }
      if (type === 'custom-text') { block.text = 'Your text here'; block.bold = false; block.fontSize = ''; }
      if (type === 'spacer') { block.height = '30px'; }
      postTemplate.push(block);
      renderTemplate();
      select.value = '';
    }

    function resetTemplate() {
      postTemplate = JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
      renderTemplate();
    }

    function syncTemplate() {
      document.getElementById('postTemplate').value = JSON.stringify(postTemplate, null, 2);
    }

    // ================================================================
    // BACKGROUNDS FOLDER
    // ================================================================
    async function scanSubfolders(preselect) {
      const path = document.getElementById('sBackgroundsFolder').value.trim();
      const select = document.getElementById('sSubfolder');
      const info = document.getElementById('subfolderInfo');
      if (!path) { info.textContent = 'Enter a folder path first'; return; }

      try {
        const resp = await fetch('/api/backgrounds/subfolders?path=' + encodeURIComponent(path));
        const data = await resp.json();

        select.innerHTML = '<option value="">-- Select subfolder --</option>';
        if (data.subfolders && data.subfolders.length) {
          data.subfolders.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
          });
          info.textContent = data.subfolders.length + ' subfolder(s) found';
          if (preselect) select.value = preselect;

          select.onchange = async () => {
            if (select.value) {
              const preview = await fetch('/api/backgrounds/folder/preview').then(r => r.json());
              info.textContent = select.value + ': ' + (preview.count || 0) + ' image(s)';
            }
          };
          if (select.value) select.onchange();
        } else {
          info.textContent = 'No subfolders found at this path';
        }
      } catch (e) {
        info.textContent = 'Error: ' + e.message;
      }
    }

    // ================================================================
    // PINTEREST FOLDER SCANNER
    // ================================================================
    async function scanPinterestFolder(type, preselect) {
      const rootId = type === 'gen' ? 'sPinterestGenRoot' : 'sPinterestScrRoot';
      const selectId = type === 'gen' ? 'sPinterestGenSubfolder' : 'sPinterestScrSubfolder';
      const infoId = type === 'gen' ? 'pinterestGenInfo' : 'pinterestScrInfo';
      const hiddenId = type === 'gen' ? 'sPinterestTemplateFolderGenerator' : 'sPinterestTemplateFolderScraper';

      const path = document.getElementById(rootId).value.trim();
      const select = document.getElementById(selectId);
      const info = document.getElementById(infoId);
      if (!path) { info.textContent = 'Enter a folder path first'; return; }

      try {
        const resp = await fetch('/api/backgrounds/subfolders?path=' + encodeURIComponent(path));
        const data = await resp.json();

        select.innerHTML = '<option value="">-- Select subfolder --</option>';
        if (data.subfolders && data.subfolders.length) {
          data.subfolders.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            select.appendChild(opt);
          });
          info.textContent = data.subfolders.length + ' subfolder(s) found';
          if (preselect) select.value = preselect;

          select.onchange = () => {
            if (select.value) {
              const fullPath = path.replace(/[/\\]$/, '') + '\\' + select.value;
              document.getElementById(hiddenId).value = fullPath;
              // Count images by checking if subfolder has its own subfolders (it shouldn't, it's images)
              fetch('/api/pinterest/count?path=' + encodeURIComponent(fullPath))
                .then(r => r.json())
                .then(d => { info.textContent = select.value + ': ' + (d.count || 0) + ' template image(s)'; })
                .catch(() => { info.textContent = 'Selected: ' + select.value; });
            } else {
              document.getElementById(hiddenId).value = '';
              info.textContent = '';
            }
          };
          if (select.value) select.onchange();
        } else {
          // No subfolders — use root folder directly
          info.textContent = 'No subfolders found. Using root folder directly.';
          document.getElementById(hiddenId).value = path;
        }
      } catch (e) {
        info.textContent = 'Error: ' + e.message;
      }
    }

    // ================================================================
    // SETTINGS
    // ================================================================
    async function loadSettings() {
      try {
        const resp = await fetch('/api/settings');
        const settings = await resp.json();
        currentSettings = settings;

        document.getElementById('sSheetId').value = settings.sheetId || '';
        document.getElementById('sGeneratorSheetTab').value = settings.generatorSheetTab || 'single post';
        document.getElementById('sGeneratorTopicCol').value = settings.generatorTopicColumn || 'A';
        document.getElementById('sGeneratorStatusCol').value = settings.generatorStatusColumn || 'B';
        document.getElementById('sGeneratorStartRow').value = settings.generatorStartRow || 2;
        document.getElementById('sScraperSheetTab').value = settings.scraperSheetTab || 'Scraping';
        document.getElementById('sScraperUrlCol').value = settings.scraperUrlColumn || 'A';
        document.getElementById('sScraperStatusCol').value = settings.scraperStatusColumn || 'B';
        document.getElementById('sScraperStartRow').value = settings.scraperStartRow || 2;
        // Old shared column settings removed — now per-module above
        document.getElementById('sAppsScriptUrl').value = settings.appsScriptUrl || '';
        document.getElementById('sDownloadFolder').value = settings.downloadFolder || '';
        document.getElementById('sWpUrl').value = settings.wpUrl || '';
        document.getElementById('sWpUsername').value = settings.wpUsername || '';
        document.getElementById('sWpAppPassword').value = settings.wpAppPassword || '';
        // Custom GPT URLs + intro rotation
        document.getElementById('sGeneratorGptUrl').value = settings.generatorGptUrl || '';
        document.getElementById('sExtractionGptUrl').value = settings.extractionGptUrl || '';
        document.getElementById('sRewriteGptUrl').value = settings.rewriteGptUrl || '';
        // Intro templates
        window._introTemplates = settings.introTemplates || [];
        window._conclusionTemplates = settings.conclusionTemplates || [];
        renderIntroTemplates();
        renderConclusionTemplates();
        document.getElementById('templateRotationIdx').textContent = settings.templateRotationIndex || 0;

        document.getElementById('sRecipePrompt').value = settings.recipePromptTemplate || '';
        document.getElementById('sContentSelectors').value = settings.contentSelectors || '';
        document.getElementById('sExtractionProvider').value = settings.extractionProvider || 'chatgpt';
        document.getElementById('sExtractionPrompt').value = settings.extractionPromptTemplate || '';
        document.getElementById('sRewritePrompt').value = settings.rewritePromptTemplate || '';
        // Scraper image prompts
        document.getElementById('sScraperHeroPrefix').value = settings.scraperHeroPromptPrefix || '';
        document.getElementById('sScraperHeroSuffix').value = settings.scraperHeroPromptSuffix || '';
        document.getElementById('sScraperIngredientsPrefix').value = settings.scraperIngredientsPromptPrefix || '';
        document.getElementById('sScraperIngredientsSuffix').value = settings.scraperIngredientsPromptSuffix || '';
        document.getElementById('sScraperStepsPrefix').value = settings.scraperStepsPromptPrefix || '';
        document.getElementById('sScraperStepsSuffix').value = settings.scraperStepsPromptSuffix || '';
        document.getElementById('sScraperBgPrefix').value = settings.scraperBackgroundPromptPrefix || '';
        // Generator image prompts
        document.getElementById('sHeroPromptPrefix').value = settings.heroPromptPrefix || '';
        document.getElementById('sHeroPromptSuffix').value = settings.heroPromptSuffix || '';
        document.getElementById('sIngredientsPromptPrefix').value = settings.ingredientsPromptPrefix || '';
        document.getElementById('sIngredientsPromptSuffix').value = settings.ingredientsPromptSuffix || '';
        document.getElementById('sStepsPromptPrefix').value = settings.stepsPromptPrefix || '';
        document.getElementById('sStepsPromptSuffix').value = settings.stepsPromptSuffix || '';
        document.getElementById('sBackgroundPromptPrefix').value = settings.backgroundPromptPrefix || '';
        document.getElementById('sImagePromptSuffix').value = settings.imagePromptSuffix || '';
        document.getElementById('sSeoAuthor').value = settings.seoAuthor || '';
        document.getElementById('sSeoCopyright').value = settings.seoCopyright || '';
        document.getElementById('sBackgroundsFolder').value = settings.backgroundsFolderPath || '';
        document.getElementById('sHeroAspectRatio').value = settings.heroAspectRatio || 'LANDSCAPE';
        document.getElementById('sStepAspectRatio').value = settings.stepAspectRatio || 'PORTRAIT';
        document.getElementById('sIngredientAspectRatio').value = settings.ingredientAspectRatio || 'PORTRAIT';
        document.getElementById('sPinterestEnabled').checked = settings.pinterestEnabled || false;
        document.getElementById('sPinterestAspectRatio').value = settings.pinterestAspectRatio || 'PORTRAIT';
        document.getElementById('sPinterestPinCount').value = settings.pinterestPinCount || 3;
        document.getElementById('sPinterestPromptPrefix').value = settings.pinterestPromptPrefix || '';
        document.getElementById('sPinterestPromptSuffix').value = settings.pinterestPromptSuffix || '';
        // Pinterest folder: split saved full path into root + subfolder
        if (settings.pinterestTemplateFolderGenerator) {
          const genPath = settings.pinterestTemplateFolderGenerator.replace(/\//g, '\\');
          const genParts = genPath.split('\\');
          const genSub = genParts.pop();
          const genRoot = genParts.join('\\');
          document.getElementById('sPinterestGenRoot').value = genRoot;
          document.getElementById('sPinterestTemplateFolderGenerator').value = settings.pinterestTemplateFolderGenerator;
          await scanPinterestFolder('gen', genSub);
        }
        if (settings.pinterestTemplateFolderScraper) {
          const scrPath = settings.pinterestTemplateFolderScraper.replace(/\//g, '\\');
          const scrParts = scrPath.split('\\');
          const scrSub = scrParts.pop();
          const scrRoot = scrParts.join('\\');
          document.getElementById('sPinterestScrRoot').value = scrRoot;
          document.getElementById('sPinterestTemplateFolderScraper').value = settings.pinterestTemplateFolderScraper;
          await scanPinterestFolder('scr', scrSub);
        }
        document.getElementById('sWpCategories').value = settings.wpCategories || '';

        wprmEnabled = settings.wprmEnabled || false;
        const cardPlugin = settings.recipeCardPlugin || (wprmEnabled ? 'wprm' : 'none');
        document.getElementById('sRecipeCardPlugin').value = cardPlugin;

        postTemplate = settings.postTemplate || JSON.parse(JSON.stringify(DEFAULT_TEMPLATE));
        renderTemplate();

        if (settings.backgroundsFolderPath) {
          await scanSubfolders(settings.selectedSubfolder);
        }
      } catch (e) {
        toast('Failed to load settings: ' + e.message, 'error');
      }

      loadBackgrounds();
    }

    // === Intro Templates ===
    function renderIntroTemplates() {
      const list = document.getElementById('introTemplatesList');
      if (!list) return;
      const templates = window._introTemplates || [];
      list.innerHTML = templates.map((t, i) => {
        const preview = t.replace(/\n/g, '<br>');
        const short = t.length > 120 ? t.substring(0, 120) + '...' : t;
        return `
        <div style="margin-bottom:10px;padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="color:#4285f4;font-weight:600">Intro #${i + 1}</span>
            <div style="display:flex;gap:6px">
              <button onclick="editIntroTemplate(${i})" style="background:none;border:1px solid rgba(66,133,244,0.4);color:#4285f4;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">Edit</button>
              <button onclick="removeIntroTemplate(${i})" style="background:none;border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">Delete</button>
            </div>
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.5;white-space:pre-wrap">${short}</div>
        </div>`;
      }).join('');
      const rotEl = document.getElementById('templateRotationIdx');
      if (rotEl) rotEl.textContent = (window._introTemplates?.length || 0) + ' intro / ' + (window._conclusionTemplates?.length || 0) + ' conclusion';
    }
    window.renderIntroTemplates = renderIntroTemplates;

    function addIntroTemplate() {
      const input = document.getElementById('introTemplateInput');
      const text = input.value.trim();
      if (!text) return;
      window._introTemplates = window._introTemplates || [];
      window._introTemplates.push(text);
      input.value = '';
      renderIntroTemplates();
    }
    window.addIntroTemplate = addIntroTemplate;

    function removeIntroTemplate(idx) {
      window._introTemplates.splice(idx, 1);
      renderIntroTemplates();
    }
    window.removeIntroTemplate = removeIntroTemplate;

    function editIntroTemplate(idx) {
      const input = document.getElementById('introTemplateInput');
      input.value = window._introTemplates[idx];
      window._editingIntroIdx = idx;
      input.focus();
      const btn = input.parentElement.querySelector('button');
      btn.textContent = 'Save Edit';
      btn.onclick = function() {
        const text = input.value.trim();
        if (!text) return;
        window._introTemplates[window._editingIntroIdx] = text;
        input.value = '';
        btn.textContent = '+ Add Intro Template';
        btn.onclick = addIntroTemplate;
        delete window._editingIntroIdx;
        renderIntroTemplates();
      };
    }
    window.editIntroTemplate = editIntroTemplate;

    // === Conclusion Templates ===
    function renderConclusionTemplates() {
      const list = document.getElementById('conclusionTemplatesList');
      if (!list) return;
      const templates = window._conclusionTemplates || [];
      list.innerHTML = templates.map((t, i) => {
        const short = t.length > 120 ? t.substring(0, 120) + '...' : t;
        return `
        <div style="margin-bottom:10px;padding:12px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px solid rgba(255,255,255,0.06)">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <span style="color:#f4a142;font-weight:600">Conclusion #${i + 1}</span>
            <div style="display:flex;gap:6px">
              <button onclick="editConclusionTemplate(${i})" style="background:none;border:1px solid rgba(66,133,244,0.4);color:#4285f4;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">Edit</button>
              <button onclick="removeConclusionTemplate(${i})" style="background:none;border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;padding:2px 8px;border-radius:6px;cursor:pointer;font-size:11px">Delete</button>
            </div>
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.6);line-height:1.5;white-space:pre-wrap">${short}</div>
        </div>`;
      }).join('');
    }
    window.renderConclusionTemplates = renderConclusionTemplates;

    function addConclusionTemplate() {
      const input = document.getElementById('conclusionTemplateInput');
      const text = input.value.trim();
      if (!text) return;
      window._conclusionTemplates = window._conclusionTemplates || [];
      window._conclusionTemplates.push(text);
      input.value = '';
      renderConclusionTemplates();
    }
    window.addConclusionTemplate = addConclusionTemplate;

    function removeConclusionTemplate(idx) {
      window._conclusionTemplates.splice(idx, 1);
      renderConclusionTemplates();
    }
    window.removeConclusionTemplate = removeConclusionTemplate;

    function editConclusionTemplate(idx) {
      const input = document.getElementById('conclusionTemplateInput');
      input.value = window._conclusionTemplates[idx];
      window._editingConcIdx = idx;
      input.focus();
      const btn = input.parentElement.querySelector('button');
      btn.textContent = 'Save Edit';
      btn.onclick = function() {
        const text = input.value.trim();
        if (!text) return;
        window._conclusionTemplates[window._editingConcIdx] = text;
        input.value = '';
        btn.textContent = '+ Add Conclusion Template';
        btn.onclick = addConclusionTemplate;
        delete window._editingConcIdx;
        renderConclusionTemplates();
      };
    }
    window.editConclusionTemplate = editConclusionTemplate;

    async function saveSettings() {
      const settings = {
        sheetId: document.getElementById('sSheetId').value.trim(),
        generatorSheetTab: document.getElementById('sGeneratorSheetTab').value.trim() || 'single post',
        generatorTopicColumn: document.getElementById('sGeneratorTopicCol').value.trim() || 'A',
        generatorStatusColumn: document.getElementById('sGeneratorStatusCol').value.trim() || 'B',
        generatorStartRow: parseInt(document.getElementById('sGeneratorStartRow').value) || 2,
        scraperSheetTab: document.getElementById('sScraperSheetTab').value.trim() || 'Scraping',
        scraperUrlColumn: document.getElementById('sScraperUrlCol').value.trim() || 'A',
        scraperStatusColumn: document.getElementById('sScraperStatusCol').value.trim() || 'B',
        scraperStartRow: parseInt(document.getElementById('sScraperStartRow').value) || 2,
        appsScriptUrl: document.getElementById('sAppsScriptUrl').value.trim(),
        downloadFolder: document.getElementById('sDownloadFolder').value.trim(),
        wpUrl: document.getElementById('sWpUrl').value.trim().replace(/\/+$/, ''),
        wpUsername: document.getElementById('sWpUsername').value.trim(),
        wpAppPassword: document.getElementById('sWpAppPassword').value.trim(),
        // Custom GPT URLs + intro rotation
        generatorGptUrl: document.getElementById('sGeneratorGptUrl').value.trim(),
        extractionGptUrl: document.getElementById('sExtractionGptUrl').value.trim(),
        rewriteGptUrl: document.getElementById('sRewriteGptUrl').value.trim(),
        introTemplates: window._introTemplates || [],
        conclusionTemplates: window._conclusionTemplates || [],
        recipePromptTemplate: document.getElementById('sRecipePrompt').value,
        contentSelectors: document.getElementById('sContentSelectors').value.trim(),
        extractionProvider: document.getElementById('sExtractionProvider').value,
        extractionPromptTemplate: document.getElementById('sExtractionPrompt').value,
        rewritePromptTemplate: document.getElementById('sRewritePrompt').value,
        scraperHeroPromptPrefix: document.getElementById('sScraperHeroPrefix').value,
        scraperHeroPromptSuffix: document.getElementById('sScraperHeroSuffix').value,
        scraperIngredientsPromptPrefix: document.getElementById('sScraperIngredientsPrefix').value,
        scraperIngredientsPromptSuffix: document.getElementById('sScraperIngredientsSuffix').value,
        scraperStepsPromptPrefix: document.getElementById('sScraperStepsPrefix').value,
        scraperStepsPromptSuffix: document.getElementById('sScraperStepsSuffix').value,
        scraperBackgroundPromptPrefix: document.getElementById('sScraperBgPrefix').value,
        heroPromptPrefix: document.getElementById('sHeroPromptPrefix').value,
        heroPromptSuffix: document.getElementById('sHeroPromptSuffix').value,
        ingredientsPromptPrefix: document.getElementById('sIngredientsPromptPrefix').value,
        ingredientsPromptSuffix: document.getElementById('sIngredientsPromptSuffix').value,
        stepsPromptPrefix: document.getElementById('sStepsPromptPrefix').value,
        stepsPromptSuffix: document.getElementById('sStepsPromptSuffix').value,
        backgroundPromptPrefix: document.getElementById('sBackgroundPromptPrefix').value,
        imagePromptSuffix: document.getElementById('sImagePromptSuffix').value,
        seoAuthor: document.getElementById('sSeoAuthor').value.trim(),
        seoCopyright: document.getElementById('sSeoCopyright').value.trim(),
        wpCategories: document.getElementById('sWpCategories').value.trim(),
        recipeCardPlugin: document.getElementById('sRecipeCardPlugin').value,
        wprmEnabled: document.getElementById('sRecipeCardPlugin').value === 'wprm',
        backgroundsFolderPath: document.getElementById('sBackgroundsFolder').value.trim(),
        selectedSubfolder: document.getElementById('sSubfolder').value,
        heroAspectRatio: document.getElementById('sHeroAspectRatio').value,
        stepAspectRatio: document.getElementById('sStepAspectRatio').value,
        ingredientAspectRatio: document.getElementById('sIngredientAspectRatio').value,
        pinterestEnabled: document.getElementById('sPinterestEnabled').checked,
        pinterestTemplateFolderGenerator: document.getElementById('sPinterestTemplateFolderGenerator').value.trim() || (document.getElementById('sPinterestGenRoot').value.trim() || ''),
        pinterestTemplateFolderScraper: document.getElementById('sPinterestTemplateFolderScraper').value.trim() || (document.getElementById('sPinterestScrRoot').value.trim() || ''),
        pinterestAspectRatio: document.getElementById('sPinterestAspectRatio').value,
        pinterestPinCount: parseInt(document.getElementById('sPinterestPinCount').value) || 3,
        pinterestPromptPrefix: document.getElementById('sPinterestPromptPrefix').value,
        pinterestPromptSuffix: document.getElementById('sPinterestPromptSuffix').value,
        postTemplate: postTemplate
      };

      try {
        const resp = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        const data = await resp.json();
        if (data.ok) toast('Settings saved', 'success');
        else toast(data.error || 'Failed to save', 'error');
      } catch (e) {
        toast('Failed to save: ' + e.message, 'error');
      }
    }

    function toggleWprm() {
      wprmEnabled = !wprmEnabled;
      document.getElementById('sWprmToggle').classList.toggle('on', wprmEnabled);
    }

    function exportSettings() {
      const a = document.createElement('a');
      a.href = '/api/settings/export';
      a.download = 'recipe-automator-settings.json';
      a.click();
      toast('Settings exported', 'success');
    }

    async function importSettings(input) {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const settings = JSON.parse(text);
        const resp = await fetch('/api/settings/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings)
        });
        const data = await resp.json();
        if (data.ok) {
          toast('Settings imported! Reloading...', 'success');
          settingsLoaded = false;
          setTimeout(() => loadSettings(), 500);
        } else {
          toast(data.error || 'Import failed', 'error');
        }
      } catch (e) {
        toast('Invalid settings file: ' + e.message, 'error');
      }
      input.value = '';
    }

    // ================================================================
    // INTRO ROTATION RESET
    // ================================================================
    document.getElementById('btnResetRotation')?.addEventListener('click', async () => {
      try {
        await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ introRotationIndex: 0 })
        });
        const el = document.getElementById('templateRotationIdx');
        if (el) el.textContent = '0';
        toast('Template rotation reset to 0', 'success');
      } catch (e) {
        toast('Reset failed: ' + e.message, 'error');
      }
    });

    // ================================================================
    // CONNECTION TESTS
    // ================================================================
    async function testSheet() {
      const resultEl = document.getElementById('sheetTestResult');
      resultEl.className = 'test-result visible';
      resultEl.textContent = 'Testing...';
      resultEl.classList.remove('success', 'fail');

      try {
        const resp = await fetch('/api/test-sheet', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          let msg = 'Connected! ' + data.totalRows + ' rows found.';
          if (data.pendingTopic) msg += ' Next: "' + data.pendingTopic + '" (row ' + data.pendingRow + ')';
          else msg += ' No pending rows found.';
          resultEl.textContent = msg;
          resultEl.classList.add('success');
          toast('Sheet connection successful', 'success');
        } else {
          resultEl.textContent = 'Failed: ' + (data.error || 'Unknown error');
          resultEl.classList.add('fail');
          toast('Sheet test failed', 'error');
        }
      } catch (e) {
        resultEl.textContent = 'Error: ' + e.message;
        resultEl.classList.add('fail');
      }
    }

    async function testWP() {
      const resultEl = document.getElementById('wpTestResult');
      resultEl.className = 'test-result visible';
      resultEl.textContent = 'Testing...';
      resultEl.classList.remove('success', 'fail');

      await saveSettings();

      try {
        const resp = await fetch('/api/test-wp', { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          resultEl.textContent = 'Connected! Authenticated as: ' + (data.username || 'OK');
          resultEl.classList.add('success');
          toast('WordPress connection successful', 'success');
        } else {
          resultEl.textContent = 'Failed: ' + (data.error || 'Unknown error');
          resultEl.classList.add('fail');
          toast('WordPress test failed', 'error');
        }
      } catch (e) {
        resultEl.textContent = 'Error: ' + e.message;
        resultEl.classList.add('fail');
      }
    }

    // ================================================================
    // BACKGROUNDS
    // ================================================================
    async function loadBackgrounds() {
      try {
        const resp = await fetch('/api/backgrounds');
        const data = await resp.json();
        renderBackgroundList('heroFileList', data.hero || [], 'hero');
      } catch {}
    }

    function renderBackgroundList(containerId, items, type) {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (items.length === 0) {
        container.innerHTML = '<span style="color:#555;font-size:12px">No backgrounds loaded</span>';
        return;
      }
      container.innerHTML = items.map((item, idx) =>
        '<div class="file-chip">' +
          '<span>' + escapeHtml(item.name || ('Image ' + (idx + 1))) + '</span>' +
          '<button class="delete-btn" onclick="deleteBackground(\'' + type + '\',' + idx + ')" title="Remove">x</button>' +
        '</div>'
      ).join('');
    }

    async function deleteBackground(type, index) {
      try {
        const resp = await fetch('/api/backgrounds/' + type + '/' + index, { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          toast('Background removed', 'info');
          loadBackgrounds();
        } else {
          toast(data.error || 'Failed to remove', 'error');
        }
      } catch (e) {
        toast('Error: ' + e.message, 'error');
      }
    }

    function setupDropzone(dropzoneId, fileInputId, type) {
      const dropzone = document.getElementById(dropzoneId);
      const fileInput = document.getElementById(fileInputId);
      if (!dropzone || !fileInput) return;

      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files, type);
      });
      fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files, type);
        fileInput.value = '';
      });
    }

    async function handleFiles(fileList, type) {
      const files = [];
      for (const file of fileList) {
        if (!file.type.startsWith('image/')) continue;
        const base64 = await fileToBase64(file);
        files.push({ name: file.name, base64 });
      }
      if (files.length === 0) return;

      try {
        const resp = await fetch('/api/backgrounds/' + type, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ files })
        });
        const data = await resp.json();
        if (data.ok) {
          toast(files.length + ' background(s) uploaded', 'success');
          loadBackgrounds();
        } else {
          toast(data.error || 'Upload failed', 'error');
        }
      } catch (e) {
        toast('Upload error: ' + e.message, 'error');
      }
    }

    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result;
          const base64 = result.includes(',') ? result.split(',')[1] : result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    // ================================================================
    // LOGS
    // ================================================================
    async function clearLogs() {
      try {
        await fetch('/api/logs', { method: 'DELETE' });
        document.getElementById('genActivityFeed').innerHTML = '<div class="activity-item activity-info"><span class="time">--:--:--</span><span>Logs cleared</span></div>';
        document.getElementById('scrActivityFeed').innerHTML = '<div class="activity-item activity-info"><span class="time">--:--:--</span><span>Logs cleared</span></div>';
        toast('Logs cleared', 'info');
      } catch {}
    }

    // ================================================================
    // SITES MANAGEMENT
    // ================================================================

    // Cache of per-site settings (keyed by site name)
    let siteSettingsCache = {};

    async function loadSites() {
      try {
        const resp = await fetch('/api/sites');
        const data = await resp.json();

        // Fetch the active site's settings for domain display
        try {
          const sResp = await fetch('/api/settings');
          if (sResp.ok) {
            const s = await sResp.json();
            siteSettingsCache[data.active] = s;
          }
        } catch {}

        // Populate custom sidebar dropdown
        updateSiteSelector(data.sites, data.active);

        // Update active site banner
        updateActiveSiteBanner(data.active);

        // Populate sites page cards
        renderSitesList(data.sites, data.active);
      } catch (e) { console.error('Failed to load sites:', e); }
    }

    function extractDomain(url) {
      if (!url) return '';
      try {
        return new URL(url).hostname;
      } catch {
        return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      }
    }

    function updateSiteSelector(sites, active) {
      const nameEl = document.getElementById('siteSelectorName');
      const domainEl = document.getElementById('siteSelectorDomain');
      const dropdown = document.getElementById('siteDropdown');
      if (!nameEl || !dropdown) return;

      const activeSettings = siteSettingsCache[active] || {};
      const activeDomain = extractDomain(activeSettings.wpUrl);

      nameEl.textContent = activeSettings.siteName || active;
      domainEl.textContent = activeDomain || active;

      // Build dropdown options
      dropdown.innerHTML = sites.map(s => {
        const sSettings = siteSettingsCache[s] || {};
        const domain = extractDomain(sSettings.wpUrl);
        const isActive = s === active;
        return '<div class="site-option' + (isActive ? ' active' : '') + '" data-site="' + s + '" onclick="selectSiteFromDropdown(\'' + s + '\')">' +
          '<div class="site-option-dot"></div>' +
          '<div class="site-option-info">' +
            '<div class="site-option-name">' + escapeHtml(sSettings.siteName || s) + '</div>' +
            '<div class="site-option-domain">' + escapeHtml(domain || s) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function updateActiveSiteBanner(active) {
      const bannerName = document.getElementById('bannerSiteName');
      const bannerDomain = document.getElementById('bannerSiteDomain');
      if (!bannerName) return;

      const activeSettings = siteSettingsCache[active] || {};
      const domain = extractDomain(activeSettings.wpUrl);

      bannerName.textContent = activeSettings.siteName || active;
      bannerDomain.textContent = domain ? '(' + domain + ')' : '';
    }

    function toggleSiteDropdown() {
      const trigger = document.getElementById('siteSelectorTrigger');
      const dropdown = document.getElementById('siteDropdown');
      if (!trigger || !dropdown) return;

      const isOpen = dropdown.classList.contains('open');
      if (isOpen) {
        dropdown.classList.remove('open');
        trigger.classList.remove('open');
      } else {
        dropdown.classList.add('open');
        trigger.classList.add('open');
      }
    }

    function selectSiteFromDropdown(name) {
      const dropdown = document.getElementById('siteDropdown');
      const trigger = document.getElementById('siteSelectorTrigger');
      if (dropdown) dropdown.classList.remove('open');
      if (trigger) trigger.classList.remove('open');
      switchSite(name);
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      const selector = document.getElementById('siteSelector');
      const dropdown = document.getElementById('siteDropdown');
      if (selector && dropdown && !selector.contains(e.target)) {
        dropdown.classList.remove('open');
        const trigger = document.getElementById('siteSelectorTrigger');
        if (trigger) trigger.classList.remove('open');
      }
    });

    function renderSitesList(sites, active) {
      const container = document.getElementById('sitesList');
      if (!container) return;

      container.innerHTML = sites.map(s => {
        const sSettings = siteSettingsCache[s] || {};
        const domain = extractDomain(sSettings.wpUrl);
        const isActive = s === active;

        return '<div class="site-card' + (isActive ? ' active' : '') + '">' +
          '<div class="site-card-header">' +
            '<div class="site-card-dot"></div>' +
            '<div class="site-card-title">' + escapeHtml(sSettings.siteName || s) + '</div>' +
            (isActive ? '<span class="site-card-badge">Active</span>' : '') +
          '</div>' +
          '<div class="site-card-domain">' + escapeHtml(domain || s) + '</div>' +
          '<div class="site-card-stats">' +
            '<div class="site-card-stat">' +
              '<div class="site-card-stat-value" id="siteCardPosts-' + s + '">--</div>' +
              '<div class="site-card-stat-label">Posts</div>' +
            '</div>' +
          '</div>' +
          '<div class="site-card-actions">' +
            (!isActive ? '<button class="btn-switch" onclick="switchSite(\'' + s + '\')">Switch</button>' : '') +
            '<button class="btn-outline-secondary" onclick="duplicateSiteUI(\'' + s + '\')">Duplicate</button>' +
            '<a href="/api/sites/' + s + '/export" class="btn-outline-secondary" style="text-decoration:none;display:inline-flex;align-items:center;">Export</a>' +
            (!isActive && sites.length > 1 ? '<button class="btn-outline-danger" onclick="deleteSiteUI(\'' + s + '\')">Delete</button>' : '') +
          '</div>' +
        '</div>';
      }).join('');

      // Load stats for cards (use current stats for active site)
      loadSiteCardStats(active);
    }

    async function loadSiteCardStats(active) {
      try {
        const resp = await fetch('/api/stats');
        if (resp.ok) {
          const stats = await resp.json();
          const el = document.getElementById('siteCardPosts-' + active);
          if (el) el.textContent = stats.total ?? 0;
        }
      } catch {}
    }

    async function switchSite(name) {
      try {
        const resp = await fetch('/api/sites/active', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); loadSites(); return; }
        settingsLoaded = false;
        siteSettingsCache = {};
        await loadSites();
        await loadDashboardData();
        if (currentPage === 'settings') await loadSettings();
        toast('Switched to ' + name, 'success');
      } catch (e) { alert('Failed to switch site: ' + e.message); }
    }

    async function createSite() {
      const input = document.getElementById('newSiteName');
      const name = (input?.value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (!name) { alert('Enter a site name'); return; }
      try {
        const resp = await fetch('/api/sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        input.value = '';
        await loadSites();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    async function duplicateSiteUI(name) {
      const newName = prompt('New site name (slug):', name + '-copy');
      if (!newName) return;
      const clean = newName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      try {
        const resp = await fetch(`/api/sites/${name}/duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newName: clean })
        });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        await loadSites();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    async function deleteSiteUI(name) {
      if (!confirm(`Delete site "${name}" and all its data? This cannot be undone.`)) return;
      try {
        const resp = await fetch(`/api/sites/${name}`, { method: 'DELETE' });
        const data = await resp.json();
        if (!resp.ok) { alert(data.error); return; }
        await loadSites();
      } catch (e) { alert('Failed: ' + e.message); }
    }

    // ================================================================
    // FLOW ACCOUNTS
    // ================================================================

    async function loadFlowAccounts() {
      try {
        const resp = await fetch('/api/flow-accounts');
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(text.startsWith('<') ? 'Server needs restart — new routes not loaded yet' : text.substring(0, 100));
        }
        const data = await resp.json();

        // Update global settings inputs
        document.getElementById('faAutoReset').value = String(data.autoReset !== false);
        document.getElementById('faRateLimitResetHours').value = data.rateLimitResetHours || 4;
        document.getElementById('faCountResetHours').value = data.countResetHours || 24;

        const container = document.getElementById('flowAccountsList');
        if (!data.accounts || data.accounts.length === 0) {
          container.innerHTML = '<div style="color:#888;text-align:center;padding:20px;">No Flow accounts configured. Add one above to enable multi-account rotation.</div>';
          return;
        }

        container.innerHTML = data.accounts.map(acct => {
          const isActive = acct.id === data.activeAccountId;
          const isRateLimited = !!acct.rateLimitedAt;
          const statusLabel = !acct.enabled ? 'DISABLED'
            : isRateLimited ? 'RATE LIMITED'
            : isActive ? 'ACTIVE'
            : 'READY';
          const statusColor = !acct.enabled ? '#666'
            : isRateLimited ? '#f44336'
            : isActive ? '#4caf50'
            : '#4285f4';

          const lastGenTime = acct.lastGenAt
            ? new Date(acct.lastGenAt).toLocaleString()
            : 'Never';
          const rateLimitTime = acct.rateLimitedAt
            ? new Date(acct.rateLimitedAt).toLocaleString()
            : null;

          return `
            <div style="background:#12122a;border:1px solid ${isRateLimited ? '#f44336' : isActive ? '#4caf50' : '#2a2a4a'};border-radius:10px;padding:16px;margin-bottom:12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <input type="text" value="${acct.name}" id="faName_${acct.id}" style="background:#1a1a3a;border:1px solid #2a2a4a;color:#fff;padding:4px 8px;border-radius:5px;font-weight:600;font-size:14px;width:200px;" onchange="updateFlowAccount('${acct.id}', {name: this.value})" />
                  <span style="font-size:11px;color:${statusColor};font-weight:700;">${statusLabel}</span>
                </div>
                <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#aaa;cursor:pointer;">
                  <input type="checkbox" ${acct.enabled ? 'checked' : ''} onchange="toggleFlowAccount('${acct.id}', this.checked)" />
                  Enabled
                </label>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                <span style="font-size:12px;color:#666;">Profile:</span>
                <input type="text" value="${acct.profileDir}" id="faProfile_${acct.id}" style="background:#1a1a3a;border:1px solid #2a2a4a;color:#888;padding:3px 8px;border-radius:5px;font-size:12px;flex:1;" onchange="updateFlowAccount('${acct.id}', {profileDir: this.value})" />
              </div>
              <div style="font-size:12px;color:#aaa;margin-bottom:10px;">
                Images today: ${acct.generationCount || 0} &nbsp;|&nbsp; Last gen: ${lastGenTime}
                ${rateLimitTime ? `<br><span style="color:#f44336;">Rate limited at: ${rateLimitTime}</span>` : ''}
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn" onclick="openFlowAccountBrowser('${acct.id}')" style="background:#ff9800;padding:5px 12px;font-size:12px;">Open Browser</button>
                <button class="btn" onclick="closeBrowser()" style="background:#f44336;padding:5px 12px;font-size:12px;">Close Browser</button>
                <button class="btn" onclick="resetFlowAccountCount('${acct.id}')" style="background:#2196f3;padding:5px 12px;font-size:12px;">Reset</button>
                ${isRateLimited ? `<button class="btn" onclick="clearFlowAccountRateLimit('${acct.id}')" style="background:#9c27b0;padding:5px 12px;font-size:12px;">Clear Rate Limit</button>` : ''}
                ${!isActive && acct.enabled ? `<button class="btn" onclick="activateFlowAccount('${acct.id}')" style="background:#4caf50;padding:5px 12px;font-size:12px;">Set Active</button>` : ''}
                <button class="btn" onclick="removeFlowAccount('${acct.id}')" style="background:#333;padding:5px 12px;font-size:12px;margin-left:auto;">Remove</button>
              </div>
            </div>
          `;
        }).join('');
      } catch (e) {
        toast('Failed to load Flow accounts: ' + e.message, 'error');
      }
    }
    window.loadFlowAccounts = loadFlowAccounts;

    // ================================================================
    // APP UPDATE
    // ================================================================

    async function checkForUpdate() {
      const status = document.getElementById('updateStatus');
      const details = document.getElementById('updateDetails');
      const pullBtn = document.getElementById('updatePullBtn');
      status.textContent = 'Checking...';
      status.style.color = '#aaa';
      try {
        const resp = await fetch('/api/update/check');
        const data = await resp.json();
        if (!data.ok) {
          status.textContent = 'Git not initialized. Run "git init" first.';
          status.style.color = '#f44336';
          details.textContent = data.error || '';
          pullBtn.style.display = 'none';
          return;
        }
        if (data.hasUpdate) {
          status.textContent = `Update available! ${data.behind} commit(s) behind`;
          status.style.color = '#ff9800';
          pullBtn.style.display = 'inline-block';
        } else {
          status.textContent = 'Up to date';
          status.style.color = '#4caf50';
          pullBtn.style.display = 'none';
        }
        details.textContent = `Branch: ${data.branch} | Local: ${data.localCommit} | Last: ${data.lastCommit}`;
      } catch (e) {
        status.textContent = 'Check failed: ' + e.message;
        status.style.color = '#f44336';
        pullBtn.style.display = 'none';
      }
    }
    window.checkForUpdate = checkForUpdate;

    async function pullUpdate() {
      const status = document.getElementById('updateStatus');
      const pullBtn = document.getElementById('updatePullBtn');
      if (!confirm('This will update the app code. Settings and data will NOT be affected. Continue?')) return;
      status.textContent = 'Updating...';
      status.style.color = '#ff9800';
      pullBtn.style.display = 'none';
      try {
        const resp = await fetch('/api/update/pull', { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        status.textContent = 'Updated! Restart the app to apply.';
        status.style.color = '#4caf50';
        toast('Update complete. Restart the app to apply changes.', 'success');
      } catch (e) {
        status.textContent = 'Update failed: ' + e.message;
        status.style.color = '#f44336';
        toast('Update failed: ' + e.message, 'error');
      }
    }
    window.pullUpdate = pullUpdate;

    async function saveFlowAccountSettings() {
      try {
        const resp = await fetch('/api/flow-accounts-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoReset: document.getElementById('faAutoReset').value === 'true',
            rateLimitResetHours: parseInt(document.getElementById('faRateLimitResetHours').value) || 4,
            countResetHours: parseInt(document.getElementById('faCountResetHours').value) || 24
          })
        });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Flow account settings saved', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.saveFlowAccountSettings = saveFlowAccountSettings;

    async function addFlowAccount() {
      const name = document.getElementById('faNewName').value.trim();
      const profileDir = document.getElementById('faNewProfileDir').value.trim();
      if (!name || !profileDir) { toast('Name and profile directory are required', 'error'); return; }
      try {
        const resp = await fetch('/api/flow-accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, profileDir })
        });
        if (!resp.ok) {
          const text = await resp.text();
          try { throw new Error(JSON.parse(text).error); } catch { throw new Error(text.substring(0, 100)); }
        }
        document.getElementById('faNewName').value = '';
        document.getElementById('faNewProfileDir').value = '';
        toast('Account added! Open its browser to log in to Google.', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.addFlowAccount = addFlowAccount;

    async function toggleFlowAccount(id, enabled) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        if (!resp.ok) throw new Error((await resp.json()).error);
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.toggleFlowAccount = toggleFlowAccount;

    async function openFlowAccountBrowser(id) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}/open-browser`, { method: 'POST' });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error);
        toast(data.message, 'success');
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.openFlowAccountBrowser = openFlowAccountBrowser;

    async function resetFlowAccountCount(id) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}/reset`, { method: 'POST' });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Count & rate limit reset', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.resetFlowAccountCount = resetFlowAccountCount;

    async function clearFlowAccountRateLimit(id) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rateLimitedAt: null })
        });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Rate limit cleared', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.clearFlowAccountRateLimit = clearFlowAccountRateLimit;

    async function updateFlowAccount(id, updates) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Account updated', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.updateFlowAccount = updateFlowAccount;

    async function activateFlowAccount(id) {
      try {
        const resp = await fetch(`/api/flow-accounts/${id}/activate`, { method: 'POST' });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Account activated', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.activateFlowAccount = activateFlowAccount;

    async function removeFlowAccount(id) {
      if (!confirm('Remove this Flow account?')) return;
      try {
        const resp = await fetch(`/api/flow-accounts/${id}`, { method: 'DELETE' });
        if (!resp.ok) throw new Error((await resp.json()).error);
        toast('Account removed', 'success');
        loadFlowAccounts();
      } catch (e) { toast('Failed: ' + e.message, 'error'); }
    }
    window.removeFlowAccount = removeFlowAccount;

    // ================================================================
    // INIT
    // ================================================================
    // Set up dropzones
    setupDropzone('heroDropzone', 'heroFileInput', 'hero');

    // Navigate to initial page based on hash
    const initialHash = location.hash.replace('#', '') || 'dashboard';
    navigateTo(initialHash);

    // Check login on load
    checkLoginStatus();

    // Initial poll
    pollState();

    // Load sites
    loadSites();

    // Poll every 2 seconds
    pollTimer = setInterval(pollState, 2000);

    // Check if a batch is active and start polling batch status
    fetch('/api/batch/status').then(r => r.json()).then(data => {
      if (data.active || (data.results && data.results.length > 0)) {
        startBatchPoll();
      }
    }).catch(() => {});
