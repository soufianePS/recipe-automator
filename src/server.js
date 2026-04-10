/**
 * Recipe Automator — Combined Express Server + Playwright Automation
 *
 * Single entry point: starts the web dashboard on localhost:3000
 * and launches Playwright automation when triggered from the UI.
 *
 * Usage:
 *   node src/server.js       — start server + dashboard
 *   npm start                — same
 *   start.bat                — one-click setup + launch
 */

import express from 'express';
import { chromium } from 'playwright';
import { StateManager } from './shared/utils/state-manager.js';
import { FlowAccountManager } from './shared/utils/flow-account-manager.js';
import { Logger } from './shared/utils/logger.js';
import { History } from './shared/utils/history.js';
import { setupRoutes } from './routes.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

// Ensure directories exist
const dirs = ['screenshots', 'output', 'data', 'data/images', 'data/tmp'];
for (const dir of dirs) {
  const fullPath = join(PROJECT_ROOT, dir);
  if (!existsSync(fullPath)) mkdirSync(fullPath, { recursive: true });
}

// Initialize state manager (multi-site support)
await StateManager.init();

// ══════════════════════════════════════════════════════════════
// APP STATE
// ══════════════════════════════════════════════════════════════

// Persistent Playwright Chromium profile — user logs in once, session is reused.
const BROWSER_PROFILE = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');

// Clean up stale lock file from a previous crash
if (existsSync(BROWSER_PROFILE)) {
  try {
    const lockFile = join(BROWSER_PROFILE, 'SingletonLock');
    if (existsSync(lockFile)) unlinkSync(lockFile);
  } catch {}
}

// Shared mutable context — passed to routes
const ctx = {
  orchestrator: null,
  browserContext: null,
  automationRunning: false,
  loginBrowserContext: null,
  chromium,
  BROWSER_PROFILE,
  FlowAccountManager,
  __dirname,
  cleanupBrowser,
  launchBrowserWithProfile,
  attachOrchestratorCallbacks,
};

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/** Close the automation browser context and null out the reference. */
async function cleanupBrowser() {
  if (ctx.browserContext) {
    try { await ctx.browserContext.close(); } catch {}
    ctx.browserContext = null;
  }
}

/** Shared callback wired to orchestrator.start() in both /api/start and /api/resume. */
function attachOrchestratorCallbacks(promise, settings) {
  promise.then(async () => {
    Logger.info('Orchestrator finished');
    const state = await StateManager.getState();
    await History.add({
      module: settings.mode || 'generator',
      title: state.recipeTitle,
      status: 'success',
      wpPostId: state.draftPostId,
      draftUrl: state.draftUrl
    });
    ctx.automationRunning = false;
    await cleanupBrowser();
  }).catch(async (err) => {
    Logger.error('Orchestrator error:', err.message);
    let state;
    try { state = await StateManager.getState(); } catch {}
    await History.add({
      module: settings.mode || 'generator',
      title: state?.recipeTitle || 'Unknown',
      status: 'error',
      error: err.message
    });
    ctx.automationRunning = false;
    await cleanupBrowser();
  });
}

async function launchBrowserWithProfile(profileOverride) {
  const profileDir = profileOverride || BROWSER_PROFILE;
  Logger.info(`Using browser profile: ${profileDir}`);

  // Clear crash recovery state so Chrome doesn't show the restore bubble
  try {
    const prefsPath = join(profileDir, 'Default', 'Preferences');
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
      if (prefs.profile) prefs.profile.exit_type = 'Normal';
      if (prefs.profile) prefs.profile.exited_cleanly = true;
      writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {}

  ctx.browserContext = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 30000,
  });

  // Grant clipboard permissions for Flow image paste
  await ctx.browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);
}

// ══════════════════════════════════════════════════════════════
// EXPRESS SERVER
// ══════════════════════════════════════════════════════════════

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));

// Serve static files (CSS, JS) from the dashboard folder
app.use(express.static(join(__dirname, 'dashboard')));

// Register all route handlers
setupRoutes(app, ctx);

// ══════════════════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  Logger.info(`Recipe Automator server running at http://localhost:${PORT}`);
  Logger.info('Open the dashboard in your browser to configure and start automation.');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  Logger.info('Shutting down...');
  if (ctx.orchestrator && ctx.automationRunning) {
    try { await ctx.orchestrator.pause(); } catch {}
  }
  await cleanupBrowser();
  if (ctx.loginBrowserContext) {
    try { await ctx.loginBrowserContext.close(); } catch {}
    ctx.loginBrowserContext = null;
  }
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  Logger.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  Logger.error('Unhandled rejection:', err?.message || String(err));
});
