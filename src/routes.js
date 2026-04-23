/**
 * Route handlers — all Express API endpoints
 * Extracted from server.js
 */

import { StateManager, STATES } from './shared/utils/state-manager.js';
import { SheetsAPI } from './shared/utils/sheets-api.js';
import { WordPressAPI } from './shared/utils/wordpress-api.js';
import { Logger } from './shared/utils/logger.js';
import { History } from './shared/utils/history.js';
import { FlowAccountManager } from './shared/utils/flow-account-manager.js';
import { GeneratorOrchestrator } from './modules/generator/orchestrator.js';
import { ScraperOrchestrator } from './modules/scraper/orchestrator.js';
import { VerifiedGeneratorOrchestrator } from './modules/verified-generator/orchestrator.js';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { VERIFIED_GENERATOR_DEFAULTS } from './modules/verified-generator/prompts-verified.js';
import { LIST_STYLES, getListStyleCSS, getListStyleOptions } from './shared/utils/list-styles.js';

/**
 * Register all route handlers on the Express app.
 *
 * @param {import('express').Application} app
 * @param {object} ctx - Shared mutable context with:
 *   orchestrator, browserContext, automationRunning, loginBrowserContext,
 *   cleanupBrowser, launchBrowserWithProfile, attachOrchestratorCallbacks,
 *   __dirname
 */
export function setupRoutes(app, ctx) {
  // Helper: kill leftover Playwright Chromium & clean profile locks
  async function cleanupProfileLocks() {
    const { existsSync, unlinkSync } = await import('fs');
    const { join } = await import('path');
    const profilePath = ctx.BROWSER_PROFILE;
    for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
      try { const p = join(profilePath, lockFile); if (existsSync(p)) unlinkSync(p); } catch {}
    }
    try {
      const { execSync } = await import('child_process');
      execSync(`wmic process where "executablepath like '%ms-playwright%'" call terminate 2>nul`, { stdio: 'ignore' });
      await new Promise(r => setTimeout(r, 3000));
      // Re-clean after kill
      for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
        try { const p = join(profilePath, lockFile); if (existsSync(p)) unlinkSync(p); } catch {}
      }
    } catch {}
  }

  // Serve dashboard HTML
  app.get('/', async (req, res) => {
    try {
      const html = await readFile(join(ctx.__dirname, 'dashboard', 'index.html'), 'utf-8');
      res.type('html').send(html);
    } catch (e) {
      res.status(500).send('Dashboard HTML not found: ' + e.message);
    }
  });

  // ── API: State ───────────────────────────────────────────────

  app.get('/api/state', async (req, res) => {
    try {
      const state = await StateManager.getState();
      state.automationRunning = ctx.automationRunning;
      res.json(state);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Settings ────────────────────────────────────────────

  app.get('/api/settings', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      res.json(settings);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/settings', async (req, res) => {
    try {
      await StateManager.saveSettings(req.body);
      Logger.info('Settings saved');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/vg-default-prompts', (req, res) => {
    res.json(VERIFIED_GENERATOR_DEFAULTS.prompts);
  });

  // List of all available list-marker styles (for dashboard dropdown)
  app.get('/api/list-styles', (req, res) => {
    res.json({ options: getListStyleOptions() });
  });

  // Get CSS for a specific style (for "Copy CSS" button)
  app.get('/api/list-styles/:styleKey/css', (req, res) => {
    const css = getListStyleCSS(req.params.styleKey);
    res.type('text/plain').send(css);
  });

  // Standalone Pinterest pin test — skips recipe generation, uses provided image paths
  // Generates 3 pins with 3 different templates, all in ONE Flow project (reusing hero + result)
  app.post('/api/test/pin-generation', async (req, res) => {
    try {
      const { heroPath, resultPath, templatePaths, pinTitle } = req.body || {};
      if (!heroPath || !resultPath || !Array.isArray(templatePaths) || templatePaths.length === 0) {
        return res.status(400).json({ error: 'heroPath, resultPath, templatePaths (array) required' });
      }
      const { existsSync } = await import('fs');
      if (!existsSync(heroPath)) return res.status(400).json({ error: `hero not found: ${heroPath}` });
      if (!existsSync(resultPath)) return res.status(400).json({ error: `result not found: ${resultPath}` });
      for (const t of templatePaths) {
        if (!existsSync(t)) return res.status(400).json({ error: `template not found: ${t}` });
      }

      const settings = await StateManager.getSettings();
      const { chromium } = await import('playwright');
      const { FlowPage } = await import('./shared/pages/flow.js');
      const { FlowAccountManager } = await import('./shared/utils/flow-account-manager.js');
      const account = await FlowAccountManager.getActiveAccount();
      const profileDir = FlowAccountManager.getProfileDir(account) || 'C:/Users/xassi/AppData/Local/soufiane flow';
      Logger.info(`[PinTest] Using account: ${account?.name || 'default'} at ${profileDir}`);

      Logger.info('[PinTest] Launching browser...');
      const context = await chromium.launchPersistentContext(profileDir, { headless: false, viewport: { width: 1366, height: 768 } });
      const browser = context.browser();
      const flow = new FlowPage(browser, context);

      const websiteUrl = settings.wpUrl || 'https://example.com';
      const websiteDomain = websiteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const title = pinTitle || 'Test Pin';
      const pinterestTemplate = settings.verifiedGenerator?.prompts?.pinterest || VERIFIED_GENERATOR_DEFAULTS.prompts.pinterest;
      const prompt = pinterestTemplate
        .replace(/\{\{pin_title\}\}/g, title)
        .replace(/\{\{pin_description\}\}/g, '')
        .replace(/\{\{recipe_title\}\}/g, title)
        .replace(/\{\{website\}\}/g, websiteDomain);

      const { join } = await import('path');
      const results = [];

      // Generate each pin in the SAME Flow project — hero + result stay on canvas, only template changes
      for (let i = 0; i < templatePaths.length; i++) {
        const templatePath = templatePaths[i];
        const outputPath = join(process.cwd(), 'data', `test-pin-${i + 1}.jpg`);
        Logger.info(`[PinTest] Pin ${i + 1}/${templatePaths.length} — template: ${templatePath}`);

        const ok = await flow.generate(
          prompt,
          templatePath,             // background = new template per pin
          [heroPath, resultPath],   // context = hero + result (stays on canvas from first pin)
          'PORTRAIT',
          outputPath,
          { skipSimilarityCheck: true }
        );

        results.push({ pin: i + 1, ok, outputPath, template: templatePath });
        if (!ok) Logger.warn(`[PinTest] Pin ${i + 1} failed`);
      }

      try { await flow.closeSession(); } catch {}
      await context.close().catch(() => {});

      const successCount = results.filter(r => r.ok).length;
      res.json({
        ok: successCount > 0,
        successCount,
        totalPins: templatePaths.length,
        results
      });
    } catch (e) {
      Logger.error('[PinTest] Error:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/settings/export', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      const heroBackgrounds = await StateManager.getHeroBackgrounds();
      const stepsBackgrounds = await StateManager.getStepsBackgrounds();
      const exportData = { settings, backgrounds: { hero: heroBackgrounds, steps: stepsBackgrounds } };
      res.setHeader('Content-Disposition', 'attachment; filename="recipe-automator-settings.json"');
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(exportData, null, 2));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/settings/import', async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'Invalid settings file' });
      }
      // Support both new format ({ settings, backgrounds }) and legacy (flat settings)
      if (req.body.settings) {
        await StateManager.saveSettings(req.body.settings);
        if (req.body.backgrounds) {
          if (req.body.backgrounds.hero) await StateManager.saveHeroBackgrounds(req.body.backgrounds.hero);
          if (req.body.backgrounds.steps) await StateManager.saveStepsBackgrounds(req.body.backgrounds.steps);
        }
      } else {
        await StateManager.saveSettings(req.body);
      }
      Logger.info('Settings imported');
      res.json({ ok: true, message: 'Settings imported successfully' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Backgrounds ─────────────────────────────────────────

  app.get('/api/backgrounds', async (req, res) => {
    try {
      const hero = await StateManager.getHeroBackgrounds();
      const steps = await StateManager.getStepsBackgrounds();
      res.json({ hero, steps });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/backgrounds/hero', async (req, res) => {
    try {
      const { files } = req.body;
      if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Expected { files: [{ name, base64 }] }' });
      }
      const existing = await StateManager.getHeroBackgrounds();
      const updated = [...existing, ...files];
      await StateManager.saveHeroBackgrounds(updated);
      Logger.info(`${files.length} hero background(s) uploaded (total: ${updated.length})`);
      res.json({ ok: true, count: updated.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/backgrounds/steps', async (req, res) => {
    try {
      const { files } = req.body;
      if (!files || !Array.isArray(files)) {
        return res.status(400).json({ error: 'Expected { files: [{ name, base64 }] }' });
      }
      const existing = await StateManager.getStepsBackgrounds();
      const updated = [...existing, ...files];
      await StateManager.saveStepsBackgrounds(updated);
      Logger.info(`${files.length} steps background(s) uploaded (total: ${updated.length})`);
      res.json({ ok: true, count: updated.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete a background by index — single handler for both hero and steps
  app.delete('/api/backgrounds/:type/:index', async (req, res) => {
    try {
      const { type, index } = req.params;
      const getter = type === 'hero' ? StateManager.getHeroBackgrounds : StateManager.getStepsBackgrounds;
      const saver  = type === 'hero' ? StateManager.saveHeroBackgrounds : StateManager.saveStepsBackgrounds;

      if (!getter) {
        return res.status(400).json({ error: 'Invalid background type' });
      }

      const idx = parseInt(index);
      const existing = await getter.call(StateManager);
      if (idx < 0 || idx >= existing.length) {
        return res.status(400).json({ error: 'Invalid index' });
      }
      const removed = existing.splice(idx, 1);
      await saver.call(StateManager, existing);
      Logger.info(`${type.charAt(0).toUpperCase() + type.slice(1)} background "${removed[0]?.name}" removed`);
      res.json({ ok: true, count: existing.length });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Kitchens (multi-kitchen background pools) ─────────────
  app.get('/api/kitchens', async (_req, res) => {
    try { res.json(await StateManager.getKitchens()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/kitchens', async (req, res) => {
    try {
      const { name } = req.body || {};
      const k = await StateManager.createKitchen(name);
      Logger.info(`Kitchen created: ${k.name} (${k.id})`);
      res.json({ ok: true, kitchen: k });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/kitchens/active', async (req, res) => {
    try {
      const { id } = req.body || {};
      await StateManager.setActiveKitchen(id);
      Logger.info(`Active kitchen: ${id}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/kitchens/:id', async (req, res) => {
    try {
      const { name } = req.body || {};
      const k = await StateManager.renameKitchen(req.params.id, name);
      res.json({ ok: true, kitchen: k });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/kitchens/:id', async (req, res) => {
    try {
      await StateManager.deleteKitchen(req.params.id);
      Logger.info(`Kitchen deleted: ${req.params.id}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/kitchens/:id/backgrounds', async (req, res) => {
    try {
      const { files } = req.body || {};
      if (!Array.isArray(files)) return res.status(400).json({ error: 'Expected { files: [{name, base64}] }' });
      const count = await StateManager.addKitchenBackgrounds(req.params.id, files);
      Logger.info(`${files.length} background(s) added to kitchen ${req.params.id} (total: ${count})`);
      res.json({ ok: true, count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/kitchens/:id/backgrounds/:index', async (req, res) => {
    try {
      await StateManager.deleteKitchenBackground(req.params.id, parseInt(req.params.index));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── API: Automation Controls ─────────────────────────────────

  app.post('/api/start', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Automation is already running' });
      }

      const settings = await StateManager.getSettings();
      if (!settings.sheetId) {
        return res.status(400).json({ error: 'Google Sheet ID is not configured. Go to Settings.' });
      }

      const mode = req.body?.mode || settings.mode || 'generate';

      // Build sheet settings based on mode
      const sheetSettings = mode === 'scrape' ? {
        ...settings,
        sheetTabName: settings.scraperSheetTab || settings.sheetTabName || 'Scraping',
        topicColumn: settings.scraperUrlColumn || 'A',
        statusColumn: settings.scraperStatusColumn || 'B',
        startRow: settings.scraperStartRow || 2
      } : {
        ...settings,
        sheetTabName: settings.generatorSheetTab || settings.sheetTabName || 'single post',
        topicColumn: settings.generatorTopicColumn || settings.topicColumn || 'A',
        statusColumn: settings.generatorStatusColumn || settings.statusColumn || 'B',
        startRow: settings.generatorStartRow || settings.startRow || 2
      };

      // Load ALL pending rows upfront (batch mode — skip on error)
      const pendingRows = await SheetsAPI.findAllPendingRows(sheetSettings);
      if (!pendingRows.length) {
        return res.json({ ok: false, error: 'No pending recipes found in the sheet.' });
      }

      Logger.info(`=== Starting Recipe Automator: ${pendingRows.length} recipes queued ===`);
      for (const row of pendingRows) {
        Logger.info(`  → "${row.topic}" (row ${row.rowIndex})`);
      }

      // Save mode
      if (mode !== settings.mode) {
        settings.mode = mode;
        await StateManager.saveSettings(settings);
      }

      // Reset state, clean image cache + tmp files
      await StateManager.resetState();
      try {
        const { readdirSync, unlinkSync, existsSync: ex } = await import('fs');
        const cleanDir = (dir) => {
          if (!ex(dir)) return;
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, f.name);
            if (f.isDirectory()) cleanDir(p);
            else try { unlinkSync(p); } catch {}
          }
        };
        cleanDir(join(ctx.__dirname, '..', 'data', 'tmp'));
        cleanDir(join(ctx.__dirname, '..', 'output'));
        Logger.info('Cleaned tmp + output before batch start');
      } catch {}
      await StateManager.updateState({
        status: STATES.LOADING_JOB,
        batchMode: true,
        batchQueue: pendingRows,
        batchCurrentIndex: 0,
        batchResults: [],
        batchStartedAt: Date.now()
      });

      // Launch browser (use active Flow account profile if multi-account enabled)
      Logger.info('Launching browser...');
      try {
        let profileOverride = null;
        if (await FlowAccountManager.isEnabled()) {
          const account = await FlowAccountManager.getActiveAccount();
          if (account) {
            profileOverride = FlowAccountManager.getProfileDir(account);
            Logger.info(`[FlowAccounts] Using account "${account.name}" (${account.generationCount} images today)`);
          }
        }
        await ctx.launchBrowserWithProfile(profileOverride);
      } catch (launchErr) {
        const msg = launchErr.message || '';
        Logger.error('Browser launch error:', msg);
        return res.status(500).json({ error: `Browser launch failed: ${msg}` });
      }
      Logger.success('Browser launched with your profile');

      const OrchestratorClass = mode === 'scrape' ? ScraperOrchestrator : mode === 'verified' ? VerifiedGeneratorOrchestrator : GeneratorOrchestrator;
      ctx.orchestrator = new OrchestratorClass(null, ctx.browserContext, ctx);
      ctx.automationRunning = true;
      ctx.attachOrchestratorCallbacks(ctx.orchestrator.start(), settings);

      res.json({
        ok: true,
        message: `Started: ${pendingRows.length} recipes queued`,
        totalRecipes: pendingRows.length,
        recipes: pendingRows.map(r => r.topic)
      });
    } catch (e) {
      ctx.automationRunning = false;
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/pause', async (req, res) => {
    try {
      if (!ctx.orchestrator || !ctx.automationRunning) {
        return res.status(400).json({ error: 'No automation is running' });
      }
      await ctx.orchestrator.pause();
      ctx.automationRunning = false;
      Logger.info('Automation paused');
      res.json({ ok: true, message: 'Automation paused' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/resume', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Automation is already running' });
      }

      const state = await StateManager.getState();
      if (state.status !== STATES.PAUSED && state.status !== STATES.ERROR) {
        return res.status(400).json({ error: `Cannot resume from status: ${state.status}` });
      }

      if (!ctx.browserContext) {
        try {
          let profileOverride = null;
          if (await FlowAccountManager.isEnabled()) {
            const account = await FlowAccountManager.getActiveAccount();
            if (account) profileOverride = FlowAccountManager.getProfileDir(account);
          }
          await ctx.launchBrowserWithProfile(profileOverride);
        } catch (launchErr) {
          return res.status(500).json({ error: `Browser launch failed: ${launchErr.message}` });
        }
      }

      const settings = await StateManager.getSettings();
      const OrchestratorClass = settings.mode === 'scrape' ? ScraperOrchestrator : settings.mode === 'verified' ? VerifiedGeneratorOrchestrator : GeneratorOrchestrator;
      ctx.orchestrator = new OrchestratorClass(null, ctx.browserContext, ctx);
      ctx.automationRunning = true;
      ctx.attachOrchestratorCallbacks(ctx.orchestrator.start(), settings);

      Logger.info('Automation resumed');
      res.json({ ok: true, message: 'Automation resumed' });
    } catch (e) {
      ctx.automationRunning = false;
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/reset', async (req, res) => {
    try {
      if (ctx.automationRunning && ctx.orchestrator) {
        await ctx.orchestrator.pause();
        ctx.automationRunning = false;
      }
      await ctx.cleanupBrowser();
      ctx.orchestrator = null;
      await StateManager.resetState();

      // Clean tmp files, output, and screenshots
      try {
        const { readdirSync, unlinkSync, existsSync: ex } = await import('fs');
        const cleanDir = (dir) => {
          if (!ex(dir)) return 0;
          let count = 0;
          for (const f of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, f.name);
            if (f.isDirectory()) { count += cleanDir(p); }
            else { try { unlinkSync(p); count++; } catch {} }
          }
          return count;
        };
        const tmpDir = join(ctx.__dirname, '..', 'data', 'tmp');
        const ssDir = join(ctx.__dirname, '..', 'screenshots');
        const outDir = join(ctx.__dirname, '..', 'output');
        const tmpCount = cleanDir(tmpDir);
        const ssCount = cleanDir(ssDir);
        const outCount = cleanDir(outDir);
        Logger.info(`Reset cleanup: ${tmpCount} tmp, ${ssCount} screenshots, ${outCount} output files`);
      } catch {}

      Logger.info('Automation reset');
      Logger.clearLogs();
      res.json({ ok: true, message: 'Reset complete — all temp files cleaned' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Batch Progress ────────────────────────────────────────

  /**
   * GET /api/batch/status — Get current batch progress.
   */
  app.get('/api/batch/status', async (req, res) => {
    try {
      const state = await StateManager.getState();

      if (!state.batchMode && !state.batchResults?.length) {
        return res.json({ active: false });
      }

      const queue = state.batchQueue || [];
      const results = state.batchResults || [];
      const currentIndex = state.batchCurrentIndex || 0;
      const total = queue.length;
      const completed = results.length;
      const successes = results.filter(r => r.status === 'success').length;
      const errors = results.filter(r => r.status === 'error').length;
      const remaining = Math.max(0, total - completed - (state.batchMode ? 1 : 0));

      // Estimate remaining time based on average duration of completed recipes
      const completedWithDuration = results.filter(r => r.duration > 0);
      const avgDuration = completedWithDuration.length > 0
        ? completedWithDuration.reduce((sum, r) => sum + r.duration, 0) / completedWithDuration.length
        : 0;
      const estimatedRemainingMs = avgDuration * (remaining + (state.batchMode ? 1 : 0));

      res.json({
        active: state.batchMode || false,
        total,
        completed,
        successes,
        errors,
        remaining,
        currentIndex,
        currentRecipe: state.batchMode ? (queue[currentIndex]?.topic || null) : null,
        currentStatus: state.status,
        avgDurationMs: Math.round(avgDuration),
        estimatedRemainingMs: Math.round(estimatedRemainingMs),
        results
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Connection Tests ────────────────────────────────────

  app.post('/api/test-sheet', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      if (!settings.sheetId) {
        return res.json({ ok: false, error: 'Sheet ID is empty' });
      }
      const rows = await SheetsAPI.readSheet(settings.sheetId, settings.sheetTabName || 'Sheet1');
      const pending = await SheetsAPI.findPendingRow(settings);
      res.json({
        ok: true,
        totalRows: rows.length,
        pendingTopic: pending?.topic || null,
        pendingRow: pending?.rowIndex || null
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.post('/api/test-wp', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      const result = await WordPressAPI.testConnection(settings);
      res.json(result);
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ── API: Backgrounds Folder ─────────────────────────────────

  app.get('/api/backgrounds/subfolders', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      const rootPath = req.query.path || settings.backgroundsFolderPath;
      if (!rootPath) return res.json({ subfolders: [] });
      const subfolders = StateManager.listSubfolders(rootPath);
      res.json({ subfolders, path: rootPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/backgrounds/folder/preview', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      if (!settings.backgroundsFolderPath || !settings.selectedSubfolder) {
        return res.json({ count: 0, images: [] });
      }
      const folderPath = join(settings.backgroundsFolderPath, settings.selectedSubfolder);
      const images = StateManager.listImagesInFolder(folderPath);
      res.json({
        count: images.length,
        images: images.map(p => ({ name: p.split(/[/\\]/).pop(), path: p }))
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── API: Pinterest Folder Count ──────────────────────────

  app.get('/api/pinterest/count', (req, res) => {
    try {
      const folderPath = req.query.path;
      if (!folderPath) return res.json({ count: 0 });
      const images = StateManager.listImagesInFolder(folderPath);
      res.json({ count: images.length });
    } catch (e) {
      res.json({ count: 0 });
    }
  });

  // ── API: Stats/History ───────────────────────────────────────

  app.get('/api/stats', async (req, res) => {
    const stats = await History.getStats();
    res.json(stats);
  });

  app.get('/api/history', async (req, res) => {
    const history = await History.getAll();
    res.json(history);
  });

  // ── API: Open Browser (manage logins) ──────────────────────

  app.post('/api/open-browser', async (req, res) => {
    try {
      if (ctx.loginBrowserContext) {
        return res.status(400).json({ error: 'Browser is already open.' });
      }
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Stop automation first.' });
      }

      await cleanupProfileLocks();

      // Clear crash recovery state (same as launchBrowserWithProfile)
      try {
        const { existsSync: ex2, readFileSync: rf, writeFileSync: wf } = await import('fs');
        const prefsPath = join(ctx.BROWSER_PROFILE, 'Default', 'Preferences');
        if (ex2(prefsPath)) {
          const prefs = JSON.parse(rf(prefsPath, 'utf-8'));
          if (prefs.profile) prefs.profile.exit_type = 'Normal';
          if (prefs.profile) prefs.profile.exited_cleanly = true;
          wf(prefsPath, JSON.stringify(prefs));
        }
      } catch {}

      Logger.info('Opening browser for account management...');

      // Use exact same launch config as the working automation
      ctx.loginBrowserContext = await ctx.chromium.launchPersistentContext(ctx.BROWSER_PROFILE, {
        headless: false,
        viewport: null,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-infobars',
          '--hide-crash-restore-bubble',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
      });

      // Listen for browser close (user closed it manually via X)
      ctx.loginBrowserContext.on('close', () => {
        ctx.loginBrowserContext = null;
        Logger.info('Browser was closed manually.');
      });

      Logger.info('Browser opened — change your logins, then click "Close Browser" when done.');
      res.json({ ok: true, message: 'Browser opened. Change your logins, then close when done.' });
    } catch (e) {
      ctx.loginBrowserContext = null;
      Logger.error('Browser open failed:', e.message);
      res.status(500).json({ error: `Browser failed to open. Make sure no other Chrome/Chromium is running. Error: ${e.message.split('\n')[0]}` });
    }
  });

  app.post('/api/close-browser', async (req, res) => {
    try {
      if (!ctx.loginBrowserContext) {
        return res.json({ ok: true, message: 'No browser open.' });
      }
      try { await ctx.loginBrowserContext.close(); } catch {}
      ctx.loginBrowserContext = null;
      Logger.info('Browser closed.');
      res.json({ ok: true, message: 'Browser closed. Sessions saved.' });
    } catch (e) {
      ctx.loginBrowserContext = null;
      res.json({ ok: true, message: 'Browser closed.' });
    }
  });

  app.get('/api/browser-status', (req, res) => {
    res.json({ open: !!ctx.loginBrowserContext });
  });

  // ── API: Google Login (one-time setup) ───────────────────────

  app.post('/api/login', async (req, res) => {
    try {
      if (ctx.loginBrowserContext) {
        return res.status(400).json({ error: 'Login browser is already open. Log in and close it.' });
      }
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Stop automation first.' });
      }

      await cleanupProfileLocks();

      // Clear crash recovery state
      try {
        const { existsSync: ex2, readFileSync: rf, writeFileSync: wf } = await import('fs');
        const prefsPath = join(ctx.BROWSER_PROFILE, 'Default', 'Preferences');
        if (ex2(prefsPath)) {
          const prefs = JSON.parse(rf(prefsPath, 'utf-8'));
          if (prefs.profile) prefs.profile.exit_type = 'Normal';
          if (prefs.profile) prefs.profile.exited_cleanly = true;
          wf(prefsPath, JSON.stringify(prefs));
        }
      } catch {}

      Logger.info('Opening browser for Google login...');

      ctx.loginBrowserContext = await ctx.chromium.launchPersistentContext(ctx.BROWSER_PROFILE, {
        headless: false,
        viewport: null,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-infobars',
          '--hide-crash-restore-bubble',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
      });

      const page = ctx.loginBrowserContext.pages()[0] || await ctx.loginBrowserContext.newPage();
      await page.goto('https://accounts.google.com');

      Logger.info('Browser opened — please log in to Google, then click "Done" in the dashboard.');
      res.json({ ok: true, message: 'Browser opened. Log in to Google, then click Done.' });
    } catch (e) {
      ctx.loginBrowserContext = null;
      Logger.error('Login browser failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/login-done', async (req, res) => {
    try {
      if (!ctx.loginBrowserContext) {
        return res.json({ ok: true, message: 'No login browser open.' });
      }

      const cookies = await ctx.loginBrowserContext.cookies('https://accounts.google.com');
      const loggedIn = cookies.some(c => c.name === 'SID' || c.name === 'SSID');

      await ctx.loginBrowserContext.close();
      ctx.loginBrowserContext = null;

      if (loggedIn) {
        Logger.success('Google login saved! You can now start automation.');
        res.json({ ok: true, loggedIn: true, message: 'Login saved successfully!' });
      } else {
        Logger.warn('No Google session detected. Did you log in?');
        res.json({ ok: true, loggedIn: false, message: 'No Google session found. Try again.' });
      }
    } catch (e) {
      ctx.loginBrowserContext = null;
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/login-status', async (req, res) => {
    try {
      const loginCtx = await ctx.chromium.launchPersistentContext(ctx.BROWSER_PROFILE, {
        headless: true, timeout: 10000,
      });
      const cookies = await loginCtx.cookies('https://accounts.google.com');
      const loggedIn = cookies.some(c => c.name === 'SID' || c.name === 'SSID');
      await loginCtx.close();
      res.json({ loggedIn });
    } catch {
      res.json({ loggedIn: false });
    }
  });

  // ── API: Logs ────────────────────────────────────────────────

  app.get('/api/logs', (req, res) => {
    res.json(Logger.getLogs());
  });

  app.delete('/api/logs', (req, res) => {
    Logger.clearLogs();
    res.json({ ok: true });
  });

  // ── API: Site Management ────────────────────────────────────

  // GET /api/sites — list all sites with active indicator
  app.get('/api/sites', (req, res) => {
    const sites = StateManager.listSites();
    const active = StateManager.getActiveSite();
    res.json({ sites, active });
  });

  // POST /api/sites — create new site
  app.post('/api/sites', (req, res) => {
    const { name } = req.body;
    if (!name || !/^[a-z0-9-]+$/.test(name)) return res.status(400).json({ error: 'Invalid name. Use lowercase letters, numbers, hyphens only.' });
    try { StateManager.createSite(name); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PUT /api/sites/active — switch active site
  app.put('/api/sites/active', (req, res) => {
    const { name } = req.body;
    if (ctx.orchestrator?.isRunning?.()) return res.status(400).json({ error: 'Stop automation before switching sites.' });
    try { StateManager.setActiveSite(name); res.json({ ok: true, site: name }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/sites/:name/duplicate — duplicate a site
  app.post('/api/sites/:name/duplicate', (req, res) => {
    const { newName } = req.body;
    if (!newName || !/^[a-z0-9-]+$/.test(newName)) return res.status(400).json({ error: 'Invalid name.' });
    try { StateManager.duplicateSite(req.params.name, newName); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // DELETE /api/sites/:name — delete a site
  app.delete('/api/sites/:name', (req, res) => {
    try { StateManager.deleteSite(req.params.name); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // GET /api/sites/:name/export — export site settings
  app.get('/api/sites/:name/export', async (req, res) => {
    try {
      const data = await StateManager.exportSite(req.params.name);
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}-settings.json"`);
      res.json(data);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/sites/:name/import — import site settings
  app.post('/api/sites/:name/import', async (req, res) => {
    try { await StateManager.importSite(req.params.name, req.body); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── API: Flow Accounts (multi-account rotation) ────────────

  // GET /api/flow-accounts — list all accounts with status
  app.get('/api/flow-accounts', async (req, res) => {
    try {
      const data = await FlowAccountManager.getAccounts();
      res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/flow-accounts — add new account
  app.post('/api/flow-accounts', async (req, res) => {
    try {
      const { name, profileDir } = req.body;
      if (!name || !profileDir) return res.status(400).json({ error: 'Name and profile directory are required.' });
      const account = await FlowAccountManager.addAccount(name, profileDir);
      res.json({ ok: true, account });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PUT /api/flow-accounts/:id — update account
  app.put('/api/flow-accounts/:id', async (req, res) => {
    try {
      const account = await FlowAccountManager.updateAccount(req.params.id, req.body);
      res.json({ ok: true, account });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // DELETE /api/flow-accounts/:id — remove account
  app.delete('/api/flow-accounts/:id', async (req, res) => {
    try {
      await FlowAccountManager.removeAccount(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/flow-accounts/:id/reset — reset generation count
  app.post('/api/flow-accounts/:id/reset', async (req, res) => {
    try {
      await FlowAccountManager.resetCount(req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/flow-accounts/:id/activate — set as active account
  app.post('/api/flow-accounts/:id/activate', async (req, res) => {
    try {
      const data = await FlowAccountManager.getAccounts();
      data.activeAccountId = req.params.id;
      await StateManager.saveFlowAccounts(data);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // PUT /api/flow-accounts-settings — update global settings (maxPerAccount, autoReset)
  app.put('/api/flow-accounts-settings', async (req, res) => {
    try {
      await FlowAccountManager.updateSettings(req.body);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // POST /api/flow-accounts/:id/open-browser — open browser with this account's profile
  app.post('/api/flow-accounts/:id/open-browser', async (req, res) => {
    try {
      if (ctx.loginBrowserContext) {
        return res.status(400).json({ error: 'Browser is already open. Close it first.' });
      }
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Stop automation first.' });
      }

      const data = await FlowAccountManager.getAccounts();
      const account = data.accounts.find(a => a.id === req.params.id);
      if (!account) return res.status(404).json({ error: 'Account not found.' });

      const profileDir = FlowAccountManager.getProfileDir(account);

      // Clean up profile locks
      await cleanupProfileLocks();
      const { existsSync: ex2, readFileSync: rf, writeFileSync: wf, mkdirSync: md } = await import('fs');
      if (!ex2(profileDir)) md(profileDir, { recursive: true });

      // Clear crash recovery
      try {
        const prefsPath = join(profileDir, 'Default', 'Preferences');
        if (ex2(prefsPath)) {
          const prefs = JSON.parse(rf(prefsPath, 'utf-8'));
          if (prefs.profile) prefs.profile.exit_type = 'Normal';
          if (prefs.profile) prefs.profile.exited_cleanly = true;
          wf(prefsPath, JSON.stringify(prefs));
        }
      } catch {}

      Logger.info(`[FlowAccounts] Opening browser for account "${account.name}" (profile: ${profileDir})`);

      ctx.loginBrowserContext = await ctx.chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: null,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-session-crashed-bubble',
          '--disable-infobars',
          '--hide-crash-restore-bubble',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        timeout: 60000,
      });

      // Navigate to Flow so user can verify the Google login
      const page = ctx.loginBrowserContext.pages()[0] || await ctx.loginBrowserContext.newPage();
      await page.goto('https://labs.google/fx/tools/flow');

      ctx.loginBrowserContext.on('close', () => {
        ctx.loginBrowserContext = null;
        Logger.info('[FlowAccounts] Browser was closed manually.');
      });

      res.json({ ok: true, message: `Browser opened for "${account.name}". Log in to Google, then close when done.` });
    } catch (e) {
      ctx.loginBrowserContext = null;
      Logger.error('[FlowAccounts] Browser open failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // LIGHTHOUSE AUDIT
  // ═══════════════════════════════════════════════════════════

  app.get('/api/lighthouse', async (req, res) => {
    try {
      const url = req.query.url;
      if (!url) return res.status(400).json({ error: 'Missing url query param' });
      const { runLighthouseAudit } = await import('./shared/utils/lighthouse-audit.js');
      const result = await runLighthouseAudit(url);
      if (!result) return res.status(500).json({ error: 'Audit failed — see server log' });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ═══════════════════════════════════════════════════════════
  // APP UPDATE (git pull)
  // ═══════════════════════════════════════════════════════════

  // GET /api/vg-stats — VG verification statistics
  app.get('/api/vg-stats', async (req, res) => {
    try {
      const { VGStats } = await import('./modules/verified-generator/vg-stats.js');
      const summary = await VGStats.getSummary();
      res.json(summary);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/vg-stats/all — all VG recipe details
  app.get('/api/vg-stats/all', async (req, res) => {
    try {
      const { VGStats } = await import('./modules/verified-generator/vg-stats.js');
      const all = await VGStats.getAll();
      res.json(all);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/vg-stats/current — current recipe in progress
  app.get('/api/vg-stats/current', async (req, res) => {
    try {
      const { VGStats } = await import('./modules/verified-generator/vg-stats.js');
      const current = VGStats.getCurrent();
      res.json(current || { status: 'idle' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // DELETE /api/wp-post/:id — delete a WP post and all its media
  app.delete('/api/wp-post/:id', async (req, res) => {
    try {
      const settings = await StateManager.getSettings();
      const postId = parseInt(req.params.id);
      if (!postId) return res.status(400).json({ error: 'Invalid post ID' });
      const result = await WordPressAPI.deletePostWithMedia(settings, postId);
      Logger.info(`Deleted WP post ${postId}: ${result.mediaDeleted}/${result.totalMedia} media files removed`);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/vg-recipe/:index — delete VG recipe: WP post+media, mark sheet pending, remove from stats
  app.delete('/api/vg-recipe/:index', async (req, res) => {
    try {
      const { VGStats } = await import('./modules/verified-generator/vg-stats.js');
      const index = parseInt(req.params.index);
      const all = await VGStats.getAll();
      if (isNaN(index) || index < 0 || index >= all.length) {
        return res.status(400).json({ error: 'Invalid recipe index' });
      }

      const recipe = all[index];
      const settings = await StateManager.getSettings();
      const results = { wpDeleted: false, sheetReset: false, statsRemoved: false };

      // 1. Delete WP post + media
      if (recipe.draftUrl) {
        const match = recipe.draftUrl.match(/post=(\d+)/);
        if (match) {
          const postId = parseInt(match[1]);
          try {
            const wpResult = await WordPressAPI.deletePostWithMedia(settings, postId);
            results.wpDeleted = true;
            results.mediaDeleted = wpResult.mediaDeleted;
            Logger.info(`[VG Delete] WP post ${postId} deleted: ${wpResult.mediaDeleted} media removed`);
          } catch (e) {
            Logger.warn(`[VG Delete] WP delete failed: ${e.message}`);
            results.wpError = e.message;
          }
        }
      }

      // 2. Mark sheet row back to "pending"
      if (recipe.sheetRowIndex && recipe.sheetSettings) {
        try {
          const sheetSettings = {
            ...settings,
            sheetTabName: recipe.sheetSettings.sheetTabName,
            statusColumn: recipe.sheetSettings.statusColumn
          };
          await SheetsAPI.markPending(sheetSettings, recipe.sheetRowIndex);
          results.sheetReset = true;
          Logger.info(`[VG Delete] Sheet row ${recipe.sheetRowIndex} reset to pending`);
        } catch (e) {
          Logger.warn(`[VG Delete] Sheet reset failed: ${e.message}`);
          results.sheetError = e.message;
        }
      }

      // 3. Remove from vg-stats
      await VGStats.removeRecipe(index);
      results.statsRemoved = true;
      Logger.success(`[VG Delete] Recipe "${recipe.title}" fully deleted`);

      res.json({ ok: true, title: recipe.title, ...results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/update/check — check if updates are available
  app.get('/api/update/check', async (req, res) => {
    try {
      const { execSync } = await import('child_process');
      const cwd = join(ctx.__dirname, '..');

      // Fetch latest from remote
      try { execSync('git fetch', { cwd, stdio: 'pipe', timeout: 15000 }); } catch {}

      // Check if behind remote
      const local = execSync('git rev-parse HEAD', { cwd, stdio: 'pipe' }).toString().trim();
      const remote = execSync('git rev-parse @{u}', { cwd, stdio: 'pipe' }).toString().trim();
      const behind = execSync('git rev-list HEAD..@{u} --count', { cwd, stdio: 'pipe' }).toString().trim();

      // Get current version info
      const branch = execSync('git branch --show-current', { cwd, stdio: 'pipe' }).toString().trim();
      const lastCommit = execSync('git log -1 --format="%s (%ar)"', { cwd, stdio: 'pipe' }).toString().trim();

      res.json({
        ok: true,
        hasUpdate: local !== remote,
        behind: parseInt(behind) || 0,
        branch,
        localCommit: local.substring(0, 7),
        remoteCommit: remote.substring(0, 7),
        lastCommit
      });
    } catch (e) {
      res.json({ ok: false, error: e.message, hasUpdate: false });
    }
  });

  // POST /api/update/pull — pull latest code and restart
  app.post('/api/update/pull', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(400).json({ error: 'Stop automation first before updating.' });
      }

      const { exec } = await import('child_process');
      const cwd = join(ctx.__dirname, '..');

      Logger.info('[Update] Pulling latest code from GitHub...');

      // Run git pull + npm install
      const result = await new Promise((resolve, reject) => {
        exec('git pull && npm install --production', { cwd, timeout: 120000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr || err.message));
          else resolve(stdout);
        });
      });

      Logger.success('[Update] Code updated: ' + result.trim().split('\n').slice(0, 3).join(' | '));

      res.json({
        ok: true,
        message: 'Update complete. Restarting in 2 seconds...',
        output: result.trim()
      });

      // Auto-restart the process after sending response
      Logger.info('[Update] Restarting app in 2 seconds...');
      setTimeout(() => {
        // Clean up browser before exit
        try { if (ctx.browserContext) ctx.browserContext.close(); } catch {}
        try { if (ctx.loginBrowserContext) ctx.loginBrowserContext.close(); } catch {}
        // Exit with code 0 — start.bat or PM2 will restart the process
        process.exit(0);
      }, 2000);
    } catch (e) {
      Logger.error('[Update] Failed:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

}
