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
import { ScraperOrchestrator } from './modules/scraper/orchestrator.js';
import { VerifiedGeneratorOrchestrator } from './modules/verified-generator/orchestrator.js';
import { Planifier } from './modules/planifier/planifier.js';
import { SitesConfig } from './shared/utils/sites-config.js';
import { PinCampaigns } from './shared/utils/pin-campaigns.js';
import { DolphinAnty } from './shared/utils/dolphin-anty.js';
import { ACCOUNT_STATUSES, PIN_DISTRIBUTION_STRATEGIES } from './modules/planifier/default-config.js';
import { readAllPools, summarizePool, markPinPosted, unmarkPinPosted, pickNextEligiblePin, writeValidationToSheet, readAllRecipes, addRecipeToSheet, deleteRecipeFromSheet, resetRecipeToPending, getAvailableSheetTabs } from './modules/planifier/pin-pool.js';
import { validateRecipe, clearValidationCache } from './modules/planifier/recipe-validator.js';
import { simulateSession, simulateMany } from './modules/planifier/browse-simulator.js';
import { runPlanItem } from './modules/planifier/action-executor.js';
import { startInternalLinkScan, getInternalLinkJob, startInternalLinkApply } from './modules/planifier/internal-link-auditor.js';
import { randomUUID } from 'crypto';
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

  // ── Per-site settings (control tower) — read/write ANY site's settings.json
  // without making it the active site. Powers the "Configure" panel on Sites.
  app.get('/api/sites/:name/settings', async (req, res) => {
    try {
      const settings = await StateManager.getSettingsForSite(req.params.name);
      res.json(settings);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/sites/:name/settings', async (req, res) => {
    try {
      await StateManager.saveSettingsForSite(req.params.name, req.body || {});
      Logger.info(`Settings saved for site "${req.params.name}"`);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
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
      // Validate explicitly: the old `!getter` guard was dead because the
      // ternary below always resolves to the steps getter for any non-"hero"
      // type, so `DELETE /api/backgrounds/foo/0` silently deleted a steps bg.
      if (type !== 'hero' && type !== 'steps') {
        return res.status(400).json({ error: 'Invalid background type' });
      }
      const getter = type === 'hero' ? StateManager.getHeroBackgrounds : StateManager.getStepsBackgrounds;
      const saver  = type === 'hero' ? StateManager.saveHeroBackgrounds : StateManager.saveStepsBackgrounds;

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

  // ── API: Pinterest pin templates (mirrors /api/backgrounds) ────
  app.get('/api/pinterest-templates', async (_req, res) => {
    try {
      const generator = await StateManager.getPinterestTemplates('generator');
      const scraper = await StateManager.getPinterestTemplates('scraper');
      res.json({ generator, scraper });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/pinterest-templates/:mode', async (req, res) => {
    try {
      const mode = req.params.mode;
      if (!['generator', 'scraper'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be "generator" or "scraper"' });
      }
      const { files } = req.body || {};
      if (!Array.isArray(files)) {
        return res.status(400).json({ error: 'Expected { files: [{ name, base64 }] }' });
      }
      const count = await StateManager.addPinterestTemplates(mode, files);
      Logger.info(`${files.length} Pinterest template(s) added to ${mode} (total: ${count})`);
      res.json({ ok: true, count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/pinterest-templates/:mode/:index', async (req, res) => {
    try {
      const { mode, index } = req.params;
      if (!['generator', 'scraper'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be "generator" or "scraper"' });
      }
      const removed = await StateManager.deletePinterestTemplate(mode, parseInt(index));
      Logger.info(`Pinterest template "${removed?.name}" removed from ${mode}`);
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

      // Load pending rows upfront (batch mode - skip on error). Optional
      // rowIndexes lets us run a controlled one-row smoke test from the UI/API.
      let pendingRows = await SheetsAPI.findAllPendingRows(sheetSettings);
      const requestedRowIndexes = Array.isArray(req.body?.rowIndexes)
        ? req.body.rowIndexes.map(Number).filter(Number.isFinite)
        : [];
      if (requestedRowIndexes.length) {
        const allowedRows = new Set(requestedRowIndexes);
        pendingRows = pendingRows.filter(row => allowedRows.has(Number(row.rowIndex)));
      }
      if (!pendingRows.length) {
        return res.json({
          ok: false,
          error: requestedRowIndexes.length
            ? `No pending recipes found for row(s): ${requestedRowIndexes.join(', ')}.`
            : 'No pending recipes found in the sheet.'
        });
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

      const OrchestratorClass =
        mode === 'scrape' ? ScraperOrchestrator
                          : VerifiedGeneratorOrchestrator;  // default = verified
      ctx.orchestrator = new OrchestratorClass(null, ctx.browserContext, ctx);
      ctx.automationRunning = true;
      // Stamp start time so _isActuallyBusy() can auto-clear a stuck flag if the
      // orchestrator dies without unwinding. Without this the 15-min safety net
      // never fires and every "wait for it to finish" endpoint blocks forever.
      ctx.automationStartedAt = Date.now();
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

  // ══════════════════════════════════════════════════════════════
  // PLANIFIER API
  // ══════════════════════════════════════════════════════════════

  // Metadata: account statuses, pin strategies (for dropdowns)
  app.get('/api/planifier/meta', (req, res) => {
    res.json({
      accountStatuses: Object.entries(ACCOUNT_STATUSES).map(([key, v]) => ({ key, ...v })),
      pinStrategies: Object.entries(PIN_DISTRIBUTION_STRATEGIES).map(([key, label]) => ({ key, label })),
    });
  });

  app.get('/api/planifier/config', async (req, res) => {
    try {
      const config = await Planifier.getConfig();
      res.json(config);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/config', async (req, res) => {
    try {
      if (!req.body || typeof req.body !== 'object') {
        return res.status(400).json({ error: 'body must be a config object' });
      }
      // PRESERVE protected fields from existing config that the dashboard
      // doesn't include in its payload — without this, sensitive sections
      // like the Dolphin token get wiped on every Save Configuration click.
      const existing = await Planifier.getConfig();
      const PROTECTED_KEYS = ['dolphinAnty', 'notifications', '_lastWeeklyRegenWeek', '_lastWeeklyRegenAt'];
      const merged = { ...req.body };
      for (const k of PROTECTED_KEYS) {
        if (existing[k] !== undefined && (merged[k] === undefined || merged[k] === null)) {
          merged[k] = existing[k];
        }
      }
      const saved = await Planifier.saveConfig(merged);
      res.json({ ok: true, config: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/enabled', async (req, res) => {
    try {
      const config = await Planifier.setEnabled(!!req.body?.enabled);
      res.json({ ok: true, enabled: config.enabled });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Plans
  app.get('/api/planifier/plan/:date', async (req, res) => {
    try {
      const plan = await Planifier.getPlan(req.params.date);
      res.json(plan || { date: req.params.date, items: [], notFound: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/plan/:date/regenerate', async (req, res) => {
    try {
      const plan = await Planifier.regeneratePlan(req.params.date);
      res.json({ ok: true, plan });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/planifier/plan/:date', async (req, res) => {
    try {
      await Planifier.deletePlan(req.params.date);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/planifier/plan/:date/items/:itemId', async (req, res) => {
    try {
      const updated = await Planifier.updatePlanItem(req.params.date, req.params.itemId, req.body || {});
      res.json({ ok: true, item: updated });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/planifier/plan/:date/items/:itemId', async (req, res) => {
    try {
      const r = await Planifier.deletePlanItem(req.params.date, req.params.itemId);
      res.json({ ok: true, ...r });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Run a plan item NOW (manual trigger). Fire-and-forget so the HTTP
  // response returns immediately; the UI polls the plan endpoint for status.
  app.post('/api/planifier/plan/:date/items/:itemId/run', async (req, res) => {
    try {
      const { date, itemId } = req.params;
      const force = !!req.body?.force;
      // Pre-check (synchronous) — same checks as runPlanItem but without side effects,
      // so we can return a clear error to the user before the async run starts.
      if (ctx.automationRunning) {
        return res.status(409).json({ error: 'Another automation is running. Pause or wait for it to finish.' });
      }
      const plan = await Planifier.getPlan(date);
      if (!plan) return res.status(404).json({ error: `No plan for ${date}` });
      const item = plan.items.find(i => i.id === itemId);
      if (!item) return res.status(404).json({ error: 'Item not found' });
      if (item.status === 'in_progress') return res.status(409).json({ error: 'Already running' });
      if (item.status === 'done' && !force) {
        return res.status(409).json({ error: 'Already done. Use {force:true} to re-run.', alreadyDone: true });
      }

      // Kick off async execution
      runPlanItem(date, itemId, ctx, { force, manual: true })
        .then((r) => Logger.info(`[Planifier] manual run done — ${itemId}: ${JSON.stringify(r.result || {}).slice(0, 200)}`))
        .catch(e => Logger.error(`[Planifier] manual run failed — ${itemId}: ${e.message}`));

      res.json({ ok: true, started: true, itemId, type: item.type, site: item.site });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Add a new item to an existing day's plan (manual entry)
  app.post('/api/planifier/plan/:date/items', async (req, res) => {
    try {
      const { date } = req.params;
      const { type, site, accountId, scheduledAt, willPost, locked } = req.body || {};
      if (!type || !site) return res.status(400).json({ error: 'type and site are required' });
      if (!['create-recipe', 'pinterest-session', 'warming-session'].includes(type)) {
        return res.status(400).json({ error: 'type must be create-recipe / pinterest-session / warming-session' });
      }
      if ((type === 'pinterest-session' || type === 'warming-session') && !accountId) {
        return res.status(400).json({ error: 'accountId required for pinterest/warming session' });
      }
      let plan = await Planifier.getPlan(date);
      if (!plan) {
        // Create empty plan for the date so we can append
        plan = await Planifier.regeneratePlan(date);
        // Wipe items so we start with just the manual one
        plan.items = [];
      }
      // Resolve scheduledAt — accept "HH:MM" or full ISO
      let scheduledIso = scheduledAt;
      if (scheduledAt && /^\d{2}:\d{2}$/.test(scheduledAt)) {
        const [y, m, d] = date.split('-').map(Number);
        const [hh, mm] = scheduledAt.split(':').map(Number);
        scheduledIso = new Date(y, m - 1, d, hh, mm, 0).toISOString();
      } else if (!scheduledAt) {
        // Default: now + 1 minute
        scheduledIso = new Date(Date.now() + 60_000).toISOString();
      }
      // Lookup dolphinProfileId from config if pinterest/warming session
      let dolphinProfileId = null;
      if (type === 'pinterest-session' || type === 'warming-session') {
        const cfg = await Planifier.getConfig();
        const account = (cfg.sites?.[site]?.pinterestAccounts || []).find(a => a.id === accountId);
        dolphinProfileId = account?.dolphinProfileId || null;
      }
      const newItem = {
        id: randomUUID(),
        type,
        site,
        accountId: accountId || null,
        dolphinProfileId,
        scheduledAt: scheduledIso,
        status: 'pending',
        willPost: willPost !== false && type === 'pinterest-session',
        locked: !!locked,
        manuallyAdded: true,
      };
      plan.items.push(newItem);
      plan.items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
      // Save (overwrites the file)
      const { savePlan } = await import('./modules/planifier/plan-storage.js');
      await savePlan(date, plan);
      res.json({ ok: true, item: newItem });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/planifier/randomize-week', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(14, Number(req.body?.days) || 7));
      const dates = await Planifier.randomizeWeek(days);
      res.json({ ok: true, dates });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/planifier/upcoming', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(31, Number(req.query.days) || 7));
      const plans = await Planifier.getUpcoming(days);
      res.json({ plans });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/preview', async (req, res) => {
    try {
      const { date, forceNoSkip } = req.body || {};
      if (!date) return res.status(400).json({ error: 'date is required' });
      const plan = await Planifier.previewPlan(date, { forceNoSkip: !!forceNoSkip });
      res.json(plan);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // History
  app.get('/api/planifier/history', async (req, res) => {
    try {
      const range = req.query.range || 'all';
      const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));
      const out = await Planifier.getHistory({ range, limit });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/planifier/history', async (req, res) => {
    try {
      await Planifier.clearHistory();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Internal link maintenance: scan first, then apply only after UI confirmation.
  app.post('/api/planifier/internal-links/scan', async (req, res) => {
    try {
      const { site, statuses, maxPosts } = req.body || {};
      const job = await startInternalLinkScan({ site, statuses, maxPosts });
      res.json({ ok: true, job });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/planifier/internal-links/job/:jobId', async (req, res) => {
    try {
      const job = getInternalLinkJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      res.json({ ok: true, job });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/internal-links/apply', async (req, res) => {
    try {
      const { jobId } = req.body || {};
      const job = await startInternalLinkApply({ jobId });
      res.json({ ok: true, job });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── Boards validator — cached pre-flight check per account ─────
  // GET /api/planifier/boards-validation/:site/:accountId
  //   Returns the latest cached validation (or null if never run).
  app.get('/api/planifier/boards-validation/:site/:accountId', async (req, res) => {
    try {
      const { readValidation } = await import('./modules/planifier/boards-validator.js');
      const v = await readValidation(req.params.site, req.params.accountId);
      res.json({ ok: true, validation: v });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/planifier/board-mapping/:site/:accountId', async (req, res) => {
    try {
      const { site, accountId } = req.params;
      const config = await Planifier.getConfig();
      const siteCfg = config.sites?.[site];
      if (!siteCfg) return res.status(400).json({ error: `Site ${site} not in planifier config` });
      const account = (siteCfg.pinterestAccounts || []).find(a => a.id === accountId);
      if (!account) return res.status(400).json({ error: `Account ${accountId} not found` });

      const settings = JSON.parse(await readFile(join(process.cwd(), 'data', 'sites', site, 'settings.json'), 'utf8'));
      const categories = (settings.wpCategories || '').split(',').map(s => s.trim()).filter(Boolean);
      const { readValidation, buildCategoryBoardMapping } = await import('./modules/planifier/boards-validator.js');
      const validation = await readValidation(site, accountId);
      const boards = validation?.boards?.length ? validation.boards : (account.boards || []);
      const categoryBoardMap = account.categoryBoardMap || {};
      res.json({
        ok: true,
        site,
        accountId,
        categories,
        boards,
        categoryBoardMap,
        mappings: buildCategoryBoardMapping(categories, boards, categoryBoardMap),
        validation,
        boardsSource: validation?.boards?.length ? 'cached-scrape' : ((account.boards || []).length ? 'manual-config' : 'none'),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/planifier/board-mapping/:site/:accountId', async (req, res) => {
    try {
      const { site, accountId } = req.params;
      const config = await Planifier.getConfig();
      const siteCfg = config.sites?.[site];
      if (!siteCfg) return res.status(400).json({ error: `Site ${site} not in planifier config` });
      const account = (siteCfg.pinterestAccounts || []).find(a => a.id === accountId);
      if (!account) return res.status(400).json({ error: `Account ${accountId} not found` });

      const settings = JSON.parse(await readFile(join(process.cwd(), 'data', 'sites', site, 'settings.json'), 'utf8'));
      const categories = (settings.wpCategories || '').split(',').map(s => s.trim()).filter(Boolean);
      const allowed = new Set(categories.map(c => c.toLowerCase()));
      const incoming = req.body?.categoryBoardMap || {};
      const clean = {};
      for (const [category, board] of Object.entries(incoming)) {
        const cat = String(category || '').trim();
        const val = String(board || '').trim();
        if (!cat || !allowed.has(cat.toLowerCase()) || !val) continue;
        const canonical = categories.find(c => c.toLowerCase() === cat.toLowerCase()) || cat;
        clean[canonical] = val;
      }
      account.categoryBoardMap = clean;
      const saved = await Planifier.saveConfig(config);
      res.json({ ok: true, categoryBoardMap: clean, config: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  /**
   * Check ctx.automationRunning, BUT auto-clear it if it's been "running"
   * for > 15 min (a previous job likely crashed without unwinding the flag).
   * Returns true if actually busy now.
   */
  function _isActuallyBusy() {
    if (!ctx.automationRunning) return false;
    const STALE_MS = 15 * 60 * 1000;
    const startedAt = ctx.automationStartedAt;
    if (startedAt && Date.now() - startedAt > STALE_MS) {
      Logger.warn(`[Server] automationRunning flag stuck for ${Math.round((Date.now() - startedAt) / 60000)} min — auto-clearing as stale.`);
      ctx.automationRunning = false;
      ctx.automationStartedAt = null;
      return false;
    }
    return true;
  }

  // ── ChatGPT pin generator — open Chrome with dedicated profile ────
  // First-time setup convenience: user clicks "Open profile + login" in the
  // Pin Generator settings → server launches Chrome with the configured
  // profile path so they can log in to ChatGPT once. The Chrome window
  // stays open until user closes it; the persistent profile keeps cookies.
  app.post('/api/chatgpt-pin/open-profile', async (req, res) => {
    try {
      let { profilePath, gptUrl } = req.body || {};
      // Default to a project-local folder when empty so user doesn't have to pick a path
      if (!profilePath || !profilePath.trim()) {
        const { join: jpc } = await import('path');
        profilePath = jpc(ctx.__dirname, '..', 'data', 'chatgpt-pin-profile');
        Logger.info(`[ChatGPTPinProfile] No path provided — defaulting to ${profilePath}`);
      }
      const { chromium } = await import('playwright');
      // Use launchPersistentContext (NOT in a managed handle — we deliberately
      // don't close it so the user can interact and close manually).
      const context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      // Open the target URL in a new tab (or reuse first tab)
      const page = context.pages()[0] || (await context.newPage());
      const url = gptUrl?.trim() || 'https://chatgpt.com/';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      Logger.info(`[ChatGPTPinProfile] Opened ${url} in profile ${profilePath}`);
      res.json({ ok: true, profilePath, url, usedDefault: !req.body?.profilePath });
      // Note: we don't close the context. User closes manually when done logging in.
    } catch (e) {
      Logger.error(`[ChatGPTPinProfile] failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // Manual override — POST /api/force-clear-busy → force clear stuck flag.
  // Use when the dashboard reports "Other automation running" but you know
  // nothing is actually running (e.g. after a server crash mid-job).
  app.post('/api/force-clear-busy', (req, res) => {
    const wasBusy = ctx.automationRunning;
    const startedAt = ctx.automationStartedAt;
    ctx.automationRunning = false;
    ctx.automationStartedAt = null;
    Logger.warn(`[Server] busy flag manually cleared (was=${wasBusy}, since=${startedAt ? new Date(startedAt).toISOString() : 'unknown'})`);
    res.json({ ok: true, wasBusy, startedAt });
  });

  // POST /api/planifier/boards-validation/:site/:accountId/run
  //   Force-runs validation NOW: connects to Dolphin profile, opens Pinterest
  //   profile page, scrapes boards, compares with site categories, persists.
  //   Heavy (~30-60s) — single-flight gated on ctx.automationRunning.
  app.post('/api/planifier/boards-validation/:site/:accountId/run', async (req, res) => {
    try {
      if (_isActuallyBusy()) {
        return res.status(409).json({ error: 'Other automation running — try again in a few minutes' });
      }
      const { site, accountId } = req.params;
      const config = await Planifier.getConfig();
      const siteCfg = config.sites?.[site];
      if (!siteCfg) return res.status(400).json({ error: `Site ${site} not in planifier config` });
      const account = (siteCfg.pinterestAccounts || []).find(a => a.id === accountId);
      if (!account) return res.status(400).json({ error: `Account ${accountId} not found` });
      const profileId = account.dolphinProfileId;
      if (!profileId) return res.status(400).json({ error: `Account ${accountId} has no Dolphin profile` });

      // Load site categories
      const { readFile: rf2 } = await import('fs/promises');
      const { join: jp2 } = await import('path');
      const settings = JSON.parse(await rf2(jp2(ctx.__dirname, '..', 'data', 'sites', site, 'settings.json'), 'utf8'));
      const categories = (settings.wpCategories || '').split(',').map(s => s.trim()).filter(Boolean);
      if (categories.length === 0) return res.status(400).json({ error: 'Site has no wpCategories defined' });

      // Mark busy + launch Dolphin
      ctx.automationRunning = true;
      ctx.automationStartedAt = Date.now();
      const { DolphinAnty } = await import('./shared/utils/dolphin-anty.js');
      const { chromium } = await import('playwright');
      const planCfg = await Planifier.getConfig();
      const dolphin = new DolphinAnty({ dolphinAnty: planCfg.dolphinAnty });
      let browser, context, page;
      try {
        Logger.info(`[BoardsValidate] Starting Dolphin profile ${profileId} for ${site}/${accountId}...`);
        const { port } = await dolphin.startAndGetCDP(Number(profileId));
        browser = await chromium.connectOverCDP(`http://localhost:${port}`);
        context = browser.contexts()[0] || (await browser.newContext());
        page = context.pages()[0] || (await context.newPage());

        const { PinterestPage } = await import('./shared/pages/pinterest.js');
        const pinterest = new PinterestPage(page);
        await pinterest.init();

        const { validate } = await import('./modules/planifier/boards-validator.js');
        const result = await validate(page, site, accountId, categories);
        res.json({ ok: true, validation: result });
      } finally {
        try { await browser?.close(); } catch {}
        try { await dolphin.stopProfile(Number(profileId)); } catch {}
        ctx.automationRunning = false;
        ctx.automationStartedAt = null;
      }
    } catch (e) {
      Logger.error(`[BoardsValidate] ${e.message}`);
      try { ctx.automationRunning = false; } catch {}
      res.status(500).json({ error: e.message });
    }
  });

  // ── Per-site recipe listing (powers calendar modal dropdowns) ─────
  // Returns:
  //   - GET /api/sites/:siteId/recipes         → all rows with topic + draftUrl
  //   - GET /api/sites/:siteId/pending-topics  → rows where status empty/pending (no draftUrl yet)
  //
  // Cached implicitly by the SheetsAPI gviz endpoint; each call is one read.
  app.get('/api/sites/:siteId/recipes', async (req, res) => {
    try {
      const siteId = req.params.siteId;
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const settingsPath = join(process.cwd(), 'data', 'sites', siteId, 'settings.json');
      const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
      const cfg = await Planifier.getConfig();
      const override = cfg?.sites?.[siteId]?.sheetTab;
      const tab = (override && override.trim()) || settings.generatorSheetTab || settings.sheetTabName;
      if (!tab) return res.status(400).json({ error: `No recipes tab configured for site ${siteId}` });
      const rows = await SheetsAPI.readSheet(settings.sheetId, tab);
      const startRow = Number(settings.generatorStartRow || settings.startRow || 2);
      const recipes = [];
      for (let i = startRow - 2; i < rows.length; i++) {
        const row = rows[i];
        const topic = (row[0] || '').trim();
        const status = (row[1] || '').trim().toLowerCase();
        const draftUrl = (row[2] || '').trim();
        if (!topic) continue;
        recipes.push({
          rowIndex: i + 2,
          topic,
          status,
          draftUrl,
          isPending: !status || status === 'pending',
          isDone: status === 'done',
        });
      }
      res.json({ ok: true, sheetTab: tab, recipes });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/sites/:siteId/pending-topics', async (req, res) => {
    try {
      const siteId = req.params.siteId;
      const r = await fetch(`http://localhost:${app.locals.port || 3000}/api/sites/${encodeURIComponent(siteId)}/recipes`).then(r => r.json()).catch(() => null);
      if (r?.recipes) {
        return res.json({ ok: true, topics: r.recipes.filter(x => x.isPending) });
      }
      // Fallback: read directly
      const { readFile } = await import('fs/promises');
      const { join } = await import('path');
      const settings = JSON.parse(await readFile(join(process.cwd(), 'data', 'sites', siteId, 'settings.json'), 'utf8'));
      const cfg = await Planifier.getConfig();
      const tab = (cfg?.sites?.[siteId]?.sheetTab || '').trim() || settings.generatorSheetTab || settings.sheetTabName;
      const rows = await SheetsAPI.readSheet(settings.sheetId, tab);
      const startRow = Number(settings.generatorStartRow || settings.startRow || 2);
      const topics = [];
      for (let i = startRow - 2; i < rows.length; i++) {
        const topic = (rows[i][0] || '').trim();
        const status = (rows[i][1] || '').trim().toLowerCase();
        if (topic && (!status || status === 'pending')) {
          topics.push({ rowIndex: i + 2, topic, status });
        }
      }
      res.json({ ok: true, topics });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Multi-site sites-config (Google Sheet backed) ──────────────────
  // GET — list all sites with metadata for the dashboard table.
  app.get('/api/sites-config', async (req, res) => {
    try {
      const sites = await SitesConfig.list({ noCache: !!req.query.fresh });
      res.json({ ok: true, sites });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Pin Campaigns CRUD (Google Sheet backed) ───────────────────
  app.get('/api/pin-campaigns', async (req, res) => {
    try {
      const all = await PinCampaigns.list();
      const filtered = req.query.site
        ? all.filter(c => c.site === req.query.site)
        : all;
      res.json({ ok: true, campaigns: filtered });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/pin-campaigns', async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.site || !b.recipe_url || !b.type) {
        return res.status(400).json({ error: 'site, recipe_url, type required' });
      }
      const row = await PinCampaigns.create({
        site: b.site,
        recipe_url: b.recipe_url,
        recipe_title: b.recipe_title || '',
        type: b.type,
        template: b.template || '',
        scheduled_date_1: b.scheduled_date_1 || '',
        scheduled_date_2: b.scheduled_date_2 || '',
        scheduled_date_3: b.scheduled_date_3 || '',
        account_id: b.account_id || '',
        notes: b.notes || '',
      });
      res.json({ ok: true, campaign: row });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/pin-campaigns/:campaignId', async (req, res) => {
    try {
      const ALLOWED = [
        'recipe_url', 'recipe_title', 'type', 'template',
        'scheduled_date_1', 'scheduled_date_2', 'scheduled_date_3',
        'status_1', 'status_2', 'status_3',
        'account_id', 'notes',
      ];
      const patch = {};
      for (const k of ALLOWED) {
        if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no allowed fields in body' });
      }
      const r = await PinCampaigns.patch(req.params.campaignId, patch);
      res.json({ ok: true, updated: r.updated, patch });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/pin-campaigns/:campaignId', async (req, res) => {
    try {
      // Soft-delete: set all 3 statuses to 'cancelled'. (Hard delete of a
      // sheet row would shift indices and break ongoing operations.)
      const r = await PinCampaigns.patch(req.params.campaignId, {
        status_1: 'cancelled', status_2: 'cancelled', status_3: 'cancelled',
      });
      res.json({ ok: true, updated: r.updated });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // PUT — update one site's columns. Body: { active?, warming_enabled?, display_name?, notes?, ... }
  // Only whitelisted columns are written; others are ignored.
  app.put('/api/sites-config/:siteId', async (req, res) => {
    try {
      const ALLOWED = ['active', 'warming_enabled', 'display_name', 'wp_url', 'recipes_tab', 'scraper_tab', 'notes'];
      const patch = {};
      for (const k of ALLOWED) {
        if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no allowed fields in body' });
      }
      const result = await SitesConfig.update(req.params.siteId, patch);
      res.json({ ok: true, updated: result.updated, patch });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Browse session simulator — preview what a session looks like
  app.post('/api/planifier/simulate-browse', async (req, res) => {
    try {
      const { site, override, runs } = req.body || {};
      const config = await Planifier.getConfig();
      const siteName = site || Object.keys(config.sites || {}).find(s => !s.startsWith('_'));
      if (!siteName) return res.status(400).json({ error: 'No site available' });

      // Build recipe titles list from pin-pool (most-recent first by publishedAt)
      let recipeTitles = [];
      let recipeObjs = [];
      try {
        if (config.sites?.[siteName]?.useRecipeNamesAsKeywords) {
          const { readSitePool } = await import('./modules/planifier/pin-pool.js');
          const pool = await readSitePool(siteName, config);
          recipeObjs = pool
            .filter(r => r.topic)
            .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
            .map(r => ({ title: r.topic, category: r.category || '' }));
          recipeTitles = recipeObjs.map(r => r.title);
        }
      } catch (e) {
        Logger.warn(`[simulate-browse] recipe titles unavailable: ${e.message}`);
      }

      // Load site's WP categories — used as primary search keywords with
      // 1-to-1 mapping to Pinterest boards.
      let categories = [];
      try {
        const { readFile: rfCat } = await import('fs/promises');
        const { join: jpCat } = await import('path');
        const ss = JSON.parse(await rfCat(jpCat(ctx.__dirname, '..', 'data', 'sites', siteName, 'settings.json'), 'utf8'));
        categories = (ss.wpCategories || '').split(',').map(s => s.trim()).filter(Boolean);
      } catch {}
      const one = simulateSession(config, siteName, override || {}, recipeTitles, { categories, recipes: recipeObjs });
      const agg = simulateMany(config, siteName, Math.max(1, Math.min(500, Number(runs) || 100)), override || {}, recipeTitles, { categories, recipes: recipeObjs });
      res.json({ ok: true, one, aggregate: agg, recipeTitlesAvailable: recipeTitles.length, categoriesUsed: categories });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Pin Pool — read from Google Sheet, computed per-account assignment.
  //
  // Validation comes from sheet col X by default (populated when the user
  // clicked "Validate All" previously). ?validate=1 re-runs the validator
  // (fetches each WP post + persists fresh result back to the sheet).
  app.get('/api/planifier/pin-pool', async (req, res) => {
    try {
      const config = await Planifier.getConfig();
      const pool = await readAllPools(config);
      // Optionally re-run the validator (fetches WP + writes back to sheet col X)
      if (req.query.validate === '1') {
        await Promise.all(pool.map(async r => {
          try {
            r.validation = await validateRecipe(r);
            await writeValidationToSheet(r.site, r.rowIndex, r.validation);
          } catch (e) {
            r.validation = { valid: true, issues: [{ kind: 'validation-error', msg: e.message }] };
          }
        }));
      }
      const summary = summarizePool(pool);
      summary.recipesValid = pool.filter(r => r.validation?.valid === true).length;
      summary.recipesInvalid = pool.filter(r => r.validation?.valid === false).length;
      summary.recipesNotValidated = pool.filter(r => !r.validation).length;
      res.json({ ok: true, pool, summary });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Recipes Management ──────────────────────────────────────
  // GET — all recipes from all sites (every status, not just done)
  app.get('/api/planifier/recipes', async (req, res) => {
    try {
      const config = await Planifier.getConfig();
      const recipes = await readAllRecipes(config);
      // Enrich with LIVE WP status (publish/draft/future/private/trash) via
      // authenticated REST. Cached 5 min per (site, postId). Recipes without
      // a draftUrl get null. Runs in parallel so 100 recipes ≈ first call ~3-8s,
      // subsequent calls instant from cache.
      const { fetchLiveWpStatus } = await import('./modules/planifier/pin-pool.js');
      await Promise.all(recipes.map(async (r) => {
        if (!r.draftUrl) return;
        const live = await fetchLiveWpStatus(r.site, r.draftUrl);
        if (live) {
          r.wpStatusLive = live;            // live truth from WP
          r.wpStatus = live;                // override sheet col R (which is rarely populated)
        }
      }));
      // Build summary
      const summary = {
        total: recipes.length,
        bySite: {},
        byStatus: {},
        byWpStatus: {},
        validationStats: { valid: 0, invalid: 0, notValidated: 0 },
      };
      for (const r of recipes) {
        summary.bySite[r.site] = (summary.bySite[r.site] || 0) + 1;
        const s = r.status || '(empty)';
        summary.byStatus[s] = (summary.byStatus[s] || 0) + 1;
        const ws = r.wpStatus || '(none)';
        summary.byWpStatus[ws] = (summary.byWpStatus[ws] || 0) + 1;
        if (r.validation?.valid === true) summary.validationStats.valid++;
        else if (r.validation?.valid === false) summary.validationStats.invalid++;
        else summary.validationStats.notValidated++;
      }
      res.json({ ok: true, recipes, summary });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Pin Regenerator ──────────────────────────────────────────
  // List available heroes + templates from a site's backgrounds.json
  app.get('/api/planifier/regen-assets/:site', async (req, res) => {
    try {
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { join: jp } = await import('path');
      const path = jp(ctx.__dirname, '..', 'data', 'sites', req.params.site, 'backgrounds.json');
      if (!ex(path)) return res.json({ heroes: [], templatesGenerator: [], templatesScraper: [] });
      const data = JSON.parse(await rf(path, 'utf8'));
      // Strip base64 from list payload (too heavy) — UI fetches individual assets
      const stripBase64 = (arr) => (arr || []).map((a, idx) => ({
        idx, name: a.name || `item-${idx}`,
        thumbDataUrl: 'data:image/' + (a.name?.endsWith('.png') ? 'png' : 'jpeg') + ';base64,' + a.base64,
      }));
      res.json({
        heroes: stripBase64(data.hero),
        templatesGenerator: stripBase64(data.pinterestTemplatesGenerator),
        templatesScraper: stripBase64(data.pinterestTemplatesScraper),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Trigger pin regeneration. Hero is fetched automatically from the recipe's
  // WP featured image — the user only chooses the template.
  app.post('/api/planifier/regenerate-pin', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(409).json({ error: 'Other automation running — wait for it to finish' });
      }
      const { site, rowIndex, pinIndex, templateIdx } = req.body || {};
      if (!site || rowIndex == null || pinIndex == null || templateIdx == null) {
        return res.status(400).json({ error: 'site, rowIndex, pinIndex, templateIdx required' });
      }
      // Load backgrounds to grab the chosen template
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { join: jp } = await import('path');
      const path = jp(ctx.__dirname, '..', 'data', 'sites', site, 'backgrounds.json');
      if (!ex(path)) return res.status(404).json({ error: 'backgrounds.json not found for this site' });
      const data = JSON.parse(await rf(path, 'utf8'));
      const templateList = (req.body?.templateList === 'scraper')
        ? (data.pinterestTemplatesScraper || [])
        : (data.pinterestTemplatesGenerator || []);
      const templateEntry = templateList[templateIdx];
      if (!templateEntry) return res.status(400).json({ error: `Template idx ${templateIdx} not found` });

      const { enqueueRegen, processJob } = await import('./modules/planifier/pin-regenerator.js');
      const job = await enqueueRegen({
        site, rowIndex, pinIndex,
        templateName: templateEntry.name,
        templateBase64: templateEntry.base64,
      });
      // Fire-and-forget the processing — UI polls /api/planifier/regen-job/:id
      const planCfg = await Planifier.getConfig();
      processJob(job.id, ctx, planCfg)
        .then(r => Logger.success(`[Regen] job ${job.id} done: ${r?.newPinUrl}`))
        .catch(e => Logger.error(`[Regen] job ${job.id} failed: ${e.message}`));
      // Strip internal paths before returning
      const { _heroPath, _templatePath, ...safe } = job;
      res.json({ ok: true, job: safe });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Bulk pin regeneration — enqueue many regen jobs and process them
  // SEQUENTIALLY (one browser/engine at a time). Body:
  //   { site, items: [{ rowIndex, pinIndex, templateIdx, templateList }] }
  // Engine = settings.pinGenerator (chatgpt for leagueofcooking). UI polls
  // /api/planifier/regen-jobs for progress.
  app.post('/api/planifier/regenerate-pins-bulk', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(409).json({ error: 'Other automation running — wait for it to finish' });
      }
      const { site, items } = req.body || {};
      if (!site || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'site and non-empty items[] required' });
      }
      const { readFile: rf } = await import('fs/promises');
      const { existsSync: ex } = await import('fs');
      const { join: jp } = await import('path');
      const path = jp(ctx.__dirname, '..', 'data', 'sites', site, 'backgrounds.json');
      if (!ex(path)) return res.status(404).json({ error: 'backgrounds.json not found for this site' });
      const data = JSON.parse(await rf(path, 'utf8'));
      const { enqueueRegen, processJob } = await import('./modules/planifier/pin-regenerator.js');
      const planCfg = await Planifier.getConfig();

      const jobIds = [];
      const errors = [];
      for (const it of items) {
        const { rowIndex, pinIndex, templateIdx, templateList } = it || {};
        if (rowIndex == null || pinIndex == null || templateIdx == null) {
          errors.push({ item: it, error: 'rowIndex, pinIndex, templateIdx required' });
          continue;
        }
        const list = (templateList === 'scraper')
          ? (data.pinterestTemplatesScraper || [])
          : (data.pinterestTemplatesGenerator || []);
        const tpl = list[templateIdx];
        if (!tpl) { errors.push({ item: it, error: `template idx ${templateIdx} not found` }); continue; }
        try {
          const job = await enqueueRegen({ site, rowIndex, pinIndex, templateName: tpl.name, templateBase64: tpl.base64 });
          jobIds.push(job.id);
        } catch (e) { errors.push({ item: it, error: e.message }); }
      }

      // Process all queued jobs sequentially in the background.
      (async () => {
        for (const id of jobIds) {
          try { const r = await processJob(id, ctx, planCfg); Logger.success(`[RegenBulk] job ${id} done: ${r?.newPinUrl || ''}`); }
          catch (e) { Logger.error(`[RegenBulk] job ${id} failed: ${e.message}`); }
        }
        Logger.success(`[RegenBulk] processed ${jobIds.length} regen job(s)`);
      })();

      res.json({ ok: true, queued: jobIds.length, jobIds, errors });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Poll job status
  app.get('/api/planifier/regen-job/:id', async (req, res) => {
    try {
      const { getJob } = await import('./modules/planifier/pin-regenerator.js');
      const job = await getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const { _heroPath, _templatePath, ...safe } = job;
      res.json(safe);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // List recent regen jobs
  app.get('/api/planifier/regen-jobs', async (req, res) => {
    try {
      const { listJobs } = await import('./modules/planifier/pin-regenerator.js');
      const jobs = await listJobs({ limit: Number(req.query.limit) || 50 });
      res.json({ jobs: jobs.map(({ _heroPath, _templatePath, ...j }) => j) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Available sheet tabs for a site (from its settings.json)
  app.get('/api/planifier/sheet-tabs/:site', async (req, res) => {
    try {
      const out = await getAvailableSheetTabs(req.params.site);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST — add a new recipe (writes to next empty row in the sheet)
  app.post('/api/planifier/recipes', async (req, res) => {
    try {
      const { site, topic } = req.body || {};
      if (!site || !topic) return res.status(400).json({ error: 'site and topic required' });
      const r = await addRecipeToSheet(site, String(topic).trim());
      res.json({ ok: true, ...r, site });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE — HARD delete: removes WP post + all media, resets sheet row to
  // "pending" with only the topic (col A) preserved. The orchestrator will
  // pick it up to re-generate from scratch.
  app.delete('/api/planifier/recipes/:site/:rowIndex', async (req, res) => {
    try {
      const { site, rowIndex } = req.params;
      const r = await deleteRecipeFromSheet(site, Number(rowIndex));
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT — reset recipe status to 'pending' (e.g., to reprocess an orphan)
  app.put('/api/planifier/recipes/:site/:rowIndex/reset', async (req, res) => {
    try {
      const { site, rowIndex } = req.params;
      await resetRecipeToPending(site, Number(rowIndex));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST — BULK recreate (DRAFTS ONLY). For each selected row: confirm the WP
  // post is a draft (live check), then hard-delete WP post+media + reset the
  // sheet row to 'pending'. PUBLISHED / scheduled / private / trashed recipes
  // are SKIPPED to protect live content + SEO. After deletions, kicks off one
  // /api/start batch so the now-pending rows regenerate.
  //   Body: { site, rowIndexes: [..] }
  app.post('/api/planifier/recipes/recreate-bulk', async (req, res) => {
    try {
      if (ctx.automationRunning) {
        return res.status(409).json({ error: 'Other automation running — wait for it to finish' });
      }
      const { site, rowIndexes } = req.body || {};
      if (!site || !Array.isArray(rowIndexes) || rowIndexes.length === 0) {
        return res.status(400).json({ error: 'site and non-empty rowIndexes[] required' });
      }
      const cfg = await Planifier.getConfig();
      const allRecipes = await readAllRecipes(cfg);
      const { fetchLiveWpStatus } = await import('./modules/planifier/pin-pool.js');
      const PROTECTED = new Set(['publish', 'published', 'future', 'private', 'trash']);

      const recreated = [];
      const skipped = [];
      for (const rowIndex of rowIndexes) {
        const rec = allRecipes.find(r => r.site === site && Number(r.rowIndex) === Number(rowIndex));
        if (!rec) { skipped.push({ rowIndex, reason: 'not found in sheet' }); continue; }
        // Live WP status (drafts only). No draftUrl = nothing live to protect → allow.
        let wp = (rec.wpStatus || '').toLowerCase();
        if (rec.draftUrl) {
          const live = await fetchLiveWpStatus(site, rec.draftUrl);
          if (live) wp = String(live).toLowerCase();
        }
        if (wp && PROTECTED.has(wp)) {
          skipped.push({ rowIndex, topic: rec.topic, reason: `WP status "${wp}" — drafts only` });
          continue;
        }
        try {
          const r = await deleteRecipeFromSheet(site, Number(rowIndex));
          recreated.push({ rowIndex, topic: rec.topic, wpDeleted: r?.wpDeleted, mediaDeleted: r?.mediaDeleted });
        } catch (e) {
          skipped.push({ rowIndex, topic: rec.topic, reason: e.message });
        }
      }

      // Trigger one batch regeneration of the now-pending rows.
      let started = false;
      if (recreated.length > 0) {
        try {
          const r = await fetch(`http://localhost:${app.locals.port || 3000}/api/start`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'generate' }),
          }).then(r => r.json()).catch(() => null);
          started = !!(r && r.ok);
        } catch (e) { Logger.warn(`[RecreateBulk] auto-start failed: ${e.message}`); }
      }

      try { const { clearLiveWpStatusCache } = await import('./modules/planifier/pin-pool.js'); clearLiveWpStatusCache(site); } catch {}
      Logger.info(`[RecreateBulk] recreated ${recreated.length}, skipped ${skipped.length}, started=${started}`);
      res.json({ ok: true, recreated, skipped, started });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST — BULK PUBLISH (gradual). Schedules selected DRAFT articles to go live
  // a few per day at random times (WP `future` status), randomized order, with
  // random gaps — never all at once. Checks existing scheduled (future) posts so
  // a day isn't overloaded. Body: { site, rowIndexes, dryRun? }
  //   dryRun:true → returns the computed schedule without touching WP.
  app.post('/api/planifier/articles/publish-bulk', async (req, res) => {
    try {
      const { site, rowIndexes, dryRun } = req.body || {};
      if (!site || !Array.isArray(rowIndexes) || rowIndexes.length === 0) {
        return res.status(400).json({ error: 'site and non-empty rowIndexes[] required' });
      }
      const cfg = await Planifier.getConfig();
      const rules = cfg.rules || {};
      const perDayMin = Math.max(1, rules.publishPerDayMin ?? 2);
      const perDayMax = Math.max(perDayMin, rules.publishPerDayMax ?? 3);
      const aStart = rules.activeHourStart ?? 8;
      const aEnd = rules.activeHourEnd ?? 22;

      // WP creds
      const { readFile: rf } = await import('fs/promises');
      const { join: jp } = await import('path');
      const ss = JSON.parse(await rf(jp(ctx.__dirname, '..', 'data', 'sites', site, 'settings.json'), 'utf8'));
      const wpUrl = (ss.wpUrl || '').replace(/\/$/, '');
      const auth = 'Basic ' + Buffer.from(`${ss.wpUsername || ss.wpUser}:${ss.wpAppPassword || ss.wpPassword}`).toString('base64');
      if (!wpUrl) return res.status(400).json({ error: 'site has no wpUrl' });

      // Resolve selected → DRAFT posts only (live-checked)
      const { fetchLiveWpStatus } = await import('./modules/planifier/pin-pool.js');
      const allRecipes = await readAllRecipes(cfg);
      const targets = [];
      const skipped = [];
      for (const rowIndex of rowIndexes) {
        const rec = allRecipes.find(r => r.site === site && Number(r.rowIndex) === Number(rowIndex));
        if (!rec || !rec.draftUrl) { skipped.push({ rowIndex, reason: 'not found / no draft URL' }); continue; }
        const postId = (() => { try { return new URL(rec.draftUrl).searchParams.get('post'); } catch { return null; } })();
        if (!postId || !/^\d+$/.test(postId)) { skipped.push({ rowIndex, topic: rec.topic, reason: 'no post id' }); continue; }
        const live = (await fetchLiveWpStatus(site, rec.draftUrl)) || '';
        if (live !== 'draft' && live !== 'auto-draft') { skipped.push({ rowIndex, topic: rec.topic, reason: `status "${live}" — only drafts` }); continue; }
        targets.push({ rowIndex, postId, topic: rec.topic });
      }
      if (targets.length === 0) return res.json({ ok: true, scheduled: [], skipped, note: 'no draft articles to publish' });

      // Randomize publish order
      for (let i = targets.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [targets[i], targets[j]] = [targets[j], targets[i]]; }

      // Check existing scheduled posts → count per day so we don't overload a day
      const existingByDay = {};
      try {
        const fr = await fetch(`${wpUrl}/wp-json/wp/v2/posts?status=future&per_page=100&_fields=date`, { headers: { Authorization: auth } });
        if (fr.ok) { for (const p of (await fr.json())) { const d = (p.date || '').slice(0, 10); if (d) existingByDay[d] = (existingByDay[d] || 0) + 1; } }
      } catch {}

      // Build the schedule: spread across upcoming days, random times in active hours
      const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const pad = (n) => String(n).padStart(2, '0');
      const localIso = (ms) => { const d = new Date(ms); return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
      const randomTimes = (dayDate, count, afterMs) => {
        const y = dayDate.getFullYear(), m = dayDate.getMonth(), d = dayDate.getDate();
        let lo = new Date(y, m, d, aStart, 0, 0).getTime();
        const hi = new Date(y, m, d, aEnd, 0, 0).getTime();
        if (afterMs) lo = Math.max(lo, afterMs + 20 * 60000); // today: ≥20 min from now
        if (lo >= hi) return [];
        const span = hi - lo;
        const out = [];
        for (let i = 0; i < count; i++) out.push(lo + Math.random() * span);
        out.sort((a, b) => a - b);
        const minGap = Math.min(45 * 60000, Math.floor(span / (count + 1)));
        for (let i = 1; i < out.length; i++) if (out[i] - out[i - 1] < minGap) out[i] = out[i - 1] + minGap;
        return out.filter(t => t <= hi);
      };

      const now = Date.now();
      const scheduled = [];
      let idx = 0, day = 0;
      while (idx < targets.length && day < 120) {
        const dayDate = new Date(now + day * 86400000);
        const dateKey = ymd(dayDate);
        const rollPerDay = perDayMin + Math.floor(Math.random() * (perDayMax - perDayMin + 1));
        const cap = rollPerDay - (existingByDay[dateKey] || 0);
        if (cap <= 0) { day++; continue; }
        const times = randomTimes(dayDate, cap, day === 0 ? now : null);
        for (const t of times) { if (idx >= targets.length) break; scheduled.push({ ...targets[idx++], when: localIso(t), whenMs: t }); }
        day++;
      }
      // Any leftover (e.g., active window already closed) → bump to next morning slots
      while (idx < targets.length && day < 200) {
        const dayDate = new Date(now + day * 86400000);
        const times = randomTimes(dayDate, perDayMin, null);
        for (const t of times) { if (idx >= targets.length) break; scheduled.push({ ...targets[idx++], when: localIso(t), whenMs: t }); }
        day++;
      }

      if (dryRun) {
        return res.json({ ok: true, dryRun: true, scheduled: scheduled.map(s => ({ rowIndex: s.rowIndex, topic: s.topic, when: s.when })), skipped });
      }

      // Apply: set each post to `future` with its scheduled local date (WP cron publishes it)
      const applied = [];
      for (const s of scheduled) {
        try {
          const r = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${s.postId}`, {
            method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'future', date: s.when }),
          });
          const j = await r.json().catch(() => ({}));
          applied.push({ rowIndex: s.rowIndex, topic: s.topic, when: s.when, status: j.status || `http-${r.status}` });
        } catch (e) { applied.push({ rowIndex: s.rowIndex, topic: s.topic, when: s.when, status: 'error: ' + e.message }); }
      }
      // Bust the live-status cache so the Recipes tab immediately shows SCHEDULED
      try { const { clearLiveWpStatusCache } = await import('./modules/planifier/pin-pool.js'); clearLiveWpStatusCache(site, scheduled.map(s => Number(s.postId))); } catch {}
      Logger.info(`[PublishBulk] ${applied.length} article(s) scheduled across days for ${site}; ${skipped.length} skipped`);
      res.json({ ok: true, scheduled: applied, skipped });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST — BULK queue pins for Pinterest (scheduler-feed). Creates one paced
  // `pinterest-session` plan item per selected pin, spread across upcoming days
  // within active hours and spaced by the configured intra-account gap, each
  // carrying targetPin:{rowIndex,pinIndex}. The planifier scheduler then posts
  // them over time (safe pacing — no burst). Eligibility (recipe published) is
  // enforced by the executor at post time.
  //   Body: { site, accountId, items: [{ rowIndex, pinIndex }] }
  app.post('/api/planifier/queue-pins-bulk', async (req, res) => {
    try {
      const { site, accountId, items } = req.body || {};
      if (!site || !accountId || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'site, accountId and non-empty items[] required' });
      }
      const cfg = await Planifier.getConfig();
      const account = (cfg.sites?.[site]?.pinterestAccounts || []).find(a => a.id === accountId);
      if (!account) return res.status(400).json({ error: `account ${accountId} not found for ${site}` });
      const dolphinProfileId = account.dolphinProfileId || null;
      const rules = cfg.rules || {};
      const horizonDays = Math.max(1, rules.horizonDays || 7);
      const activeStart = rules.activeHourStart ?? 8;
      const activeEnd = rules.activeHourEnd ?? 22;
      const gapMin = Math.max(30, rules.minGapIntraAccount || 120);
      const { savePlan } = await import('./modules/planifier/plan-storage.js');

      const dateKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const now = Date.now();
      let placed = 0;
      const queued = [];
      for (let dayOffset = 0; dayOffset < horizonDays && placed < items.length; dayOffset++) {
        const day = new Date(now + dayOffset * 86400000);
        const dateKey = dateKeyOf(day);
        let plan = await Planifier.getPlan(dateKey);
        if (!plan) plan = await Planifier.regeneratePlan(dateKey);
        let cursor = new Date(day.getFullYear(), day.getMonth(), day.getDate(), activeStart, 0, 0).getTime();
        if (dayOffset === 0) cursor = Math.max(cursor, now + 5 * 60000); // today: never in the past
        const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), activeEnd, 0, 0).getTime();
        while (cursor <= dayEnd && placed < items.length) {
          const it = items[placed];
          const item = {
            id: randomUUID(),
            type: 'pinterest-session',
            site,
            accountId,
            dolphinProfileId,
            scheduledAt: new Date(cursor).toISOString(),
            status: 'pending',
            willPost: true,
            browseOnly: false,
            locked: true,
            manuallyAdded: true,
            targetPin: { rowIndex: Number(it.rowIndex), pinIndex: Number(it.pinIndex) },
          };
          plan.items.push(item);
          queued.push({ date: dateKey, scheduledAt: item.scheduledAt, targetPin: item.targetPin });
          placed++;
          cursor += gapMin * 60000;
        }
        plan.items.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
        await savePlan(dateKey, plan);
      }

      Logger.info(`[QueuePinsBulk] queued ${placed}/${items.length} pins for ${site}/${accountId} across ${horizonDays}d`);
      res.json({ ok: true, queued: placed, notPlaced: items.length - placed, slots: queued });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });


  // Telegram test + fetch chat ID endpoints
  app.post('/api/planifier/notifications/test-telegram', async (req, res) => {
    try {
      const { testTelegram } = await import('./shared/utils/telegram-notifier.js');
      const { botToken, chatId } = req.body || {};
      let cfg = { botToken, chatId };
      if (!botToken || !chatId) {
        const planCfg = await Planifier.getConfig();
        cfg = planCfg.notifications?.telegram || {};
      }
      const r = await testTelegram(cfg);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/planifier/notifications/fetch-chatid', async (req, res) => {
    try {
      const { fetchChatId } = await import('./shared/utils/telegram-notifier.js');
      const { botToken } = req.body || {};
      const token = botToken || (await Planifier.getConfig())?.notifications?.telegram?.botToken;
      const r = await fetchChatId(token);
      res.json(r);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // UI state — saves per-tab filter preferences server-side so they
  // survive across browser sessions and across machines (if data/ is shared)
  app.get('/api/planifier/ui-state', async (req, res) => {
    try {
      const { loadUiState } = await import('./modules/planifier/plan-storage.js');
      res.json(await loadUiState());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/planifier/ui-state', async (req, res) => {
    try {
      const { patchUiState } = await import('./modules/planifier/plan-storage.js');
      const updated = await patchUiState(req.body || {});
      res.json({ ok: true, state: updated });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Validate one recipe on demand (refresh validation badge) + persist to sheet
  app.post('/api/planifier/validate-recipe', async (req, res) => {
    try {
      const { site, rowIndex, draftUrl } = req.body || {};
      if (!site || !rowIndex || !draftUrl) {
        return res.status(400).json({ error: 'site, rowIndex, draftUrl required' });
      }
      const v = await validateRecipe({ site, rowIndex, draftUrl });
      try { await writeValidationToSheet(site, Number(rowIndex), v); } catch (e) {
        Logger.warn(`[validate-recipe] sheet write failed: ${e.message}`);
      }
      res.json({ ok: true, validation: v });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Clear validation cache (force re-fetch on next pin pool view)
  app.delete('/api/planifier/validation-cache', (req, res) => {
    clearValidationCache();
    res.json({ ok: true });
  });

  // Clear the validation result for ONE recipe (sheet col X) — useful to revert
  // an accidental validation or to mark for re-validation.
  app.delete('/api/planifier/validate-recipe/:site/:rowIndex', async (req, res) => {
    try {
      const { site, rowIndex } = req.params;
      await writeValidationToSheet(site, Number(rowIndex), null);  // null clears
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/planifier/pin-pool/next', async (req, res) => {
    try {
      const { site, accountId } = req.query;
      if (!site || !accountId) return res.status(400).json({ error: 'site and accountId required' });
      const config = await Planifier.getConfig();
      const next = await pickNextEligiblePin(config, String(site), String(accountId));
      res.json({ next });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/planifier/pin-pool/mark-posted', async (req, res) => {
    try {
      const { site, rowIndex, pinIndex, when } = req.body || {};
      if (!site || rowIndex == null || pinIndex == null) {
        return res.status(400).json({ error: 'site, rowIndex, pinIndex required' });
      }
      await markPinPosted(String(site), Number(rowIndex), Number(pinIndex), when);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/planifier/pin-pool/unmark-posted', async (req, res) => {
    try {
      const { site, rowIndex, pinIndex } = req.body || {};
      if (!site || rowIndex == null || pinIndex == null) {
        return res.status(400).json({ error: 'site, rowIndex, pinIndex required' });
      }
      await unmarkPinPosted(String(site), Number(rowIndex), Number(pinIndex));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * Build a Dolphin settings object suitable for DolphinAnty constructor.
   * Prefers the planifier global config; falls back to active site for
   * backward-compatibility with older installs.
   */
  async function _resolveDolphinSettings() {
    const planCfg = await Planifier.getConfig();
    if (planCfg?.dolphinAnty?.apiToken) {
      return { dolphinAnty: planCfg.dolphinAnty };
    }
    const siteSettings = await StateManager.getSettings();
    if (siteSettings?.dolphinAnty?.apiToken) {
      return siteSettings;
    }
    return null;
  }

  /**
   * Decode JWT payload (no signature check — just inspecting claims).
   */
  function _decodeDolphinToken(token) {
    try {
      const parts = String(token || '').split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      return payload;
    } catch { return null; }
  }

  // GET → diagnostic + profiles. POST → diagnostic for a candidate token (without saving).
  async function _diagnoseDolphin(token, cloudApi, localApi) {
    const out = {
      ok: false,
      token: { provided: !!token },
      plan: null,
      expiresAt: null,
      expiresInDays: null,
      tokenExpired: false,
      cloudReachable: false,
      localReachable: false,
      profileCount: 0,
      profiles: [],
      warnings: [],
      error: null,
    };
    if (!token) {
      out.error = 'No Dolphin token configured. Paste your JWT from https://dolphin-anty.com/panel → API and click Test.';
      return out;
    }
    const payload = _decodeDolphinToken(token);
    if (payload) {
      out.plan = payload.team_plan || 'unknown';
      out.userId = payload.sub || null;
      out.teamId = payload.team_id || null;
      if (payload.exp) {
        out.expiresAt = new Date(payload.exp * 1000).toISOString();
        const days = Math.round((payload.exp * 1000 - Date.now()) / 86400000);
        out.expiresInDays = days;
        out.tokenExpired = days < 0;
      }
      if (out.plan === 'free') {
        out.warnings.push('Plan "free" — Dolphin returns HTTP 402 on CDP automation. The Planifier executor will fail on a free plan. Upgrade or regenerate the token after upgrading.');
      }
      if (out.tokenExpired) {
        out.warnings.push('Token expired — regenerate at https://dolphin-anty.com/panel/index.html#/api');
      }
    } else {
      out.warnings.push('Could not decode token (malformed JWT) — paste the full token from the Dolphin panel.');
    }
    // Probe cloud
    try {
      const dolphin = new DolphinAnty({ dolphinAnty: { apiToken: token, cloudApi, localApi } });
      const list = await dolphin.listProfiles({ limit: 100 });
      const arr = Array.isArray(list) ? list : (list.data || []);
      out.cloudReachable = true;
      out.profileCount = arr.length;
      out.profiles = arr.map(p => ({
        id: String(p.id),
        name: p.name || '(no name)',
        platform: p.platform || '',
        proxy: p.proxy ? `${p.proxy.host || p.proxy.type || 'set'}` : null,
        tags: p.tags || [],
      }));
    } catch (e) {
      out.error = e.message;
      out.warnings.push(`Cloud API unreachable: ${e.message}`);
    }
    // Probe local (best-effort, doesn't fail the whole diagnostic)
    try {
      const res = await fetch(`${localApi || 'http://localhost:3001'}/v1.0/status`, {
        signal: AbortSignal.timeout(2500),
      });
      out.localReachable = res.ok;
    } catch {
      out.localReachable = false;
      out.warnings.push('Local Dolphin app not reachable at ' + (localApi || 'http://localhost:3001') + '. The app must be running for CDP profile launch.');
    }
    out.ok = out.cloudReachable && !out.tokenExpired;
    return out;
  }

  // Test connection — uses candidate token from body, or saved one
  app.post('/api/planifier/dolphin/test', async (req, res) => {
    try {
      const planCfg = await Planifier.getConfig();
      const token = req.body?.apiToken || planCfg?.dolphinAnty?.apiToken || (await StateManager.getSettings())?.dolphinAnty?.apiToken;
      const cloudApi = req.body?.cloudApi || planCfg?.dolphinAnty?.cloudApi;
      const localApi = req.body?.localApi || planCfg?.dolphinAnty?.localApi;
      const diag = await _diagnoseDolphin(token, cloudApi, localApi);
      res.json(diag);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Save token to planifier config (global, shared across sites)
  app.post('/api/planifier/dolphin/save-token', async (req, res) => {
    try {
      const { apiToken, cloudApi, localApi } = req.body || {};
      const config = await Planifier.getConfig();
      if (!config.dolphinAnty) config.dolphinAnty = {};
      if (typeof apiToken === 'string') config.dolphinAnty.apiToken = apiToken.trim();
      if (typeof cloudApi === 'string' && cloudApi) config.dolphinAnty.cloudApi = cloudApi.trim();
      if (typeof localApi === 'string' && localApi) config.dolphinAnty.localApi = localApi.trim();
      // Run a quick test and cache the result
      const diag = await _diagnoseDolphin(config.dolphinAnty.apiToken, config.dolphinAnty.cloudApi, config.dolphinAnty.localApi);
      config.dolphinAnty.lastTestedAt = new Date().toISOString();
      config.dolphinAnty.lastTestResult = {
        ok: diag.ok, plan: diag.plan, expiresInDays: diag.expiresInDays, profileCount: diag.profileCount,
      };
      await Planifier.saveConfig(config);
      res.json({ ok: true, diagnostic: diag });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Return the saved Dolphin connection (without exposing the full token)
  // so the UI can populate the fields without leaking the secret value.
  app.get('/api/planifier/dolphin/config', async (req, res) => {
    try {
      const planCfg = await Planifier.getConfig();
      const siteSettings = await StateManager.getSettings();
      const planToken = planCfg?.dolphinAnty?.apiToken || '';
      const siteToken = siteSettings?.dolphinAnty?.apiToken || '';
      const effective = planToken || siteToken;
      const masked = effective ? (effective.slice(0, 18) + '…' + effective.slice(-12)) : '';
      res.json({
        hasToken: !!effective,
        source: planToken ? 'planifier' : (siteToken ? 'site' : null),
        masked,
        cloudApi: planCfg?.dolphinAnty?.cloudApi || siteSettings?.dolphinAnty?.cloudApi || 'https://dolphin-anty-api.com',
        localApi: planCfg?.dolphinAnty?.localApi || siteSettings?.dolphinAnty?.localApi || 'http://localhost:3001',
        lastTestedAt: planCfg?.dolphinAnty?.lastTestedAt || null,
        lastTestResult: planCfg?.dolphinAnty?.lastTestResult || null,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Dolphin integration: list profiles + diagnose token health
  app.get('/api/planifier/dolphin-profiles', async (req, res) => {
    try {
      const resolved = await _resolveDolphinSettings();
      if (!resolved) {
        return res.json({ ok: false, error: 'No Dolphin token configured. Open the Configuration tab and paste your token.', profiles: [], warnings: [] });
      }
      const dolphin = new DolphinAnty(resolved);
      const warnings = [];
      const payload = _decodeDolphinToken(resolved.dolphinAnty.apiToken);
      if (payload?.team_plan === 'free') {
        warnings.push('Dolphin plan is "free" — CDP automation returns HTTP 402. Upgrade required.');
      }
      if (payload?.exp && (payload.exp * 1000) < Date.now()) {
        warnings.push('Dolphin token expired — regenerate at https://dolphin-anty.com/panel/index.html#/api');
      }
      const list = await dolphin.listProfiles({ limit: 100 });
      const arr = Array.isArray(list) ? list : (list.data || []);
      const profiles = arr.map(p => ({
        id: String(p.id),
        name: p.name || '(no name)',
        platform: p.platform || '',
        proxy: p.proxy ? `${p.proxy.host || p.proxy.type || 'set'}` : null,
        tags: p.tags || [],
      }));
      res.json({ ok: true, profiles, warnings });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, profiles: [], warnings: [] });
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
      const OrchestratorClass =
        settings.mode === 'scrape' ? ScraperOrchestrator
                                   : VerifiedGeneratorOrchestrator;  // default = verified
      ctx.orchestrator = new OrchestratorClass(null, ctx.browserContext, ctx);
      ctx.automationRunning = true;
      ctx.automationStartedAt = Date.now(); // enable stuck-flag auto-recovery (see /api/start)
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
    try {
      const stats = await History.getStats();
      res.json(stats);
    } catch (e) {
      // Express 4 does not forward async-handler rejections to error middleware,
      // so without this the request would hang forever on a read/parse error.
      Logger.warn(`/api/stats failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/history', async (req, res) => {
    try {
      const history = await History.getAll();
      res.json(history);
    } catch (e) {
      Logger.warn(`/api/history failed: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
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
