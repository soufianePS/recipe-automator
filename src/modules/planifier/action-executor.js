/**
 * Action Executor — runs a single plan item end-to-end.
 *
 * Dispatches by item.type:
 *   - 'create-recipe'      → wraps VerifiedGeneratorOrchestrator (processes
 *                            whatever is pending in the sheet for the site)
 *   - 'pinterest-session'  → starts the Dolphin profile, connects via CDP,
 *                            runs humanBrowseSession + optionally posts a pin
 *                            from the pin pool
 *
 * Concurrency: respects the global ctx.automationRunning flag so we don't
 * launch two browsers at once (Playwright Chromium is single-tenant on a
 * given user profile).
 *
 * Status flow: pending → in_progress → done | error
 *   At each transition we save the plan + append to history.
 */

import { Logger } from '../../shared/utils/logger.js';
import { Planifier } from './planifier.js';
import { simulateSession } from './browse-simulator.js';
import { pickNextEligiblePin, markPinPosted, readSitePool } from './pin-pool.js';
import { DolphinAnty } from '../../shared/utils/dolphin-anty.js';
import { PinterestPage } from '../../shared/pages/pinterest.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { VerifiedGeneratorOrchestrator } from '../verified-generator/orchestrator.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { chromium } from 'playwright';
import { sendTelegram } from '../../shared/utils/telegram-notifier.js';

/** Escape special chars for Telegram HTML parse_mode. */
function escapeHtmlForTelegram(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

/**
 * Resolve Dolphin connection settings, preferring planifier global config.
 */
async function _resolveDolphinSettings() {
  const planCfg = await Planifier.getConfig();
  if (planCfg?.dolphinAnty?.apiToken) {
    return { dolphinAnty: planCfg.dolphinAnty };
  }
  try {
    const siteSettings = await StateManager.getSettings();
    if (siteSettings?.dolphinAnty?.apiToken) return siteSettings;
  } catch {}
  throw new Error('No Dolphin token configured. Open Planifier → Configuration → 🐬 Dolphin and paste your token.');
}

/**
 * Connect to a Dolphin profile via CDP. Returns { browser, context, page, dolphin, profileId }.
 * Caller MUST call cleanup() in finally to stop the profile.
 */
async function _connectDolphin(profileId) {
  const settings = await _resolveDolphinSettings();
  const dolphin = new DolphinAnty(settings);
  Logger.info(`[Executor] Dolphin starting profile ${profileId}...`);
  const { port } = await dolphin.startAndGetCDP(profileId);
  Logger.info(`[Executor] CDP port: ${port}`);
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { await dolphin.stopProfile(profileId); Logger.info(`[Executor] Dolphin profile ${profileId} stopped`); } catch (e) { Logger.warn(`[Executor] stopProfile failed: ${e.message}`); }
  };
  return { browser, context, page, dolphin, profileId, cleanup };
}

// ── Action: Pinterest session (browse + optional post) ──────────

/**
 * Run one Pinterest session — browse + optionally one pin post.
 * @param {object} item - plan item ({site, accountId, willPost, dolphinProfileId?})
 * @param {object} config - planifier config
 */
async function runPinterestSession(item, config) {
  const site = config.sites?.[item.site];
  if (!site) throw new Error(`Site ${item.site} not in planifier config`);
  const account = (site.pinterestAccounts || []).find(a => a.id === item.accountId);
  if (!account) throw new Error(`Account ${item.accountId} not found in ${item.site}`);
  const profileId = item.dolphinProfileId || account.dolphinProfileId;
  if (!profileId) throw new Error(`No Dolphin profile assigned to ${item.site}/${item.accountId}`);

  // Pick pin first (cheap), so we don't open browser just to find nothing to post
  let pickedPin = null;
  let postFallbackReason = null;
  if (item.willPost) {
    pickedPin = await pickNextEligiblePin(config, item.site, item.accountId);
    if (!pickedPin) {
      postFallbackReason = 'no-eligible-pin';
      Logger.warn(`[Executor] No eligible pin for ${item.site}/${item.accountId} — running browse-only instead. Check: pool source tab, account assignment (Strat A hash), validation, pinSpreadDays eligibility.`);
    }
  }

  // Get recipe titles for keyword pool
  let recipeTitles = [];
  if (site.useRecipeNamesAsKeywords) {
    try {
      const pool = await readSitePool(item.site, config);
      recipeTitles = pool.map(r => r.topic).filter(Boolean);
    } catch (e) { Logger.warn(`[Executor] recipe titles unavailable: ${e.message}`); }
  }

  // Pre-roll the session (deterministic — what the user previewed)
  const plan = simulateSession(config, item.site, {}, recipeTitles);
  Logger.info(`[Executor] Planned session: ${plan.durationMinutes}min, ${plan.events.length} events, summary=${JSON.stringify(plan.summary)}`);

  const { page, cleanup } = await _connectDolphin(Number(profileId));
  try {
    const pinterest = new PinterestPage(page);
    await pinterest.init();
    Logger.info(`[Executor] Pinterest ready — replaying ${plan.events.length} browse events`);

    // Replay browse events (uses humanBrowseSession added to PinterestPage)
    const boards = account.boards || [];
    await pinterest.humanBrowseSession({ events: plan.events, boards });

    if (pickedPin) {
      Logger.info(`[Executor] Now posting pin: ${pickedPin.recipe.topic} / pin#${pickedPin.pin.pinIndex}`);
      const imagePath = await _resolveImagePath(pickedPin.pin.imageUrl, item.site);
      const boardName = boards[Math.floor(Math.random() * boards.length)] || null;
      // Convert the WP admin edit URL into a public-facing redirect URL.
      // Pinterest links go to `<site>/?p=<postId>` which WP auto-redirects to
      // the canonical permalink (e.g. /classic-cobb-salad/).
      const publicLink = await _toPublicLink(pickedPin.recipe.draftUrl, pickedPin.pin.imageUrl);
      Logger.info(`[Executor] Pin link: ${publicLink}`);
      const result = await pinterest.createPin({
        imagePath,
        title: pickedPin.pin.title || pickedPin.recipe.topic,
        description: pickedPin.pin.description || '',
        link: publicLink,
        boardName,
        altText: pickedPin.pin.title || '',
        warmup: false, // we already warmed up via humanBrowseSession
      });
      // Persist posted_at to the sheet
      await markPinPosted(item.site, pickedPin.recipe.rowIndex, pickedPin.pin.pinIndex);
      return { ok: true, posted: true, pinUrl: result.pinUrl, recipe: pickedPin.recipe.topic, pinIndex: pickedPin.pin.pinIndex };
    }

    return {
      ok: true,
      posted: false,
      browseEvents: plan.events.length,
      wantedToPost: !!item.willPost,
      reason: postFallbackReason,    // 'no-eligible-pin' or null if browse-only by design
    };
  } finally {
    await cleanup();
  }
}

// Cache resolved permalinks per process so the same recipe doesn't hit
// the WP REST API multiple times during a session.
const _permalinkCache = new Map();

/**
 * Resolve the real public permalink for a WP post.
 *
 * Calls WP REST: GET /wp-json/wp/v2/posts/{ID}?_fields=link — that returns
 * the actual canonical URL (e.g. https://thetastymama.com/classic-cobb-salad/).
 *
 * Falls back to /?p={ID} if the API call fails (WP auto-redirects that to
 * the canonical anyway, so the link still works — just less clean).
 *
 * @param {string} draftUrl - admin edit URL (contains ?post=ID)
 * @param {string} [imageUrl] - fallback for deriving the site host
 */
async function _toPublicLink(draftUrl, imageUrl) {
  if (!draftUrl) return imageUrl ? new URL(imageUrl).origin : '';
  let origin, postId;
  try {
    const u = new URL(draftUrl);
    origin = u.origin;
    postId = u.searchParams.get('post');
  } catch {
    return draftUrl;
  }
  if (!postId || !/^\d+$/.test(postId)) return draftUrl;

  const cacheKey = `${origin}|${postId}`;
  if (_permalinkCache.has(cacheKey)) return _permalinkCache.get(cacheKey);

  const restUrl = `${origin}/wp-json/wp/v2/posts/${postId}?_fields=link`;
  try {
    const res = await fetch(restUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      if (json?.link && typeof json.link === 'string') {
        _permalinkCache.set(cacheKey, json.link);
        return json.link;
      }
    } else {
      Logger.warn(`[Executor] WP REST returned ${res.status} for post ${postId}`);
    }
  } catch (e) {
    Logger.warn(`[Executor] WP REST permalink fetch failed: ${e.message}`);
  }

  // Fallback — WP auto-redirects ?p=N to the canonical URL
  const fallback = `${origin}/?p=${postId}`;
  _permalinkCache.set(cacheKey, fallback);
  return fallback;
}

/**
 * If imageUrl is a remote URL, download to a temp file. Otherwise treat as
 * already-local path. Returns absolute local path.
 */
async function _resolveImagePath(imageUrl, siteName) {
  if (!imageUrl) throw new Error('Pin has no imageUrl');
  if (imageUrl.startsWith('http')) {
    const { writeFile, mkdir } = await import('fs/promises');
    const tmpDir = join(PROJECT_ROOT, 'data', 'tmp', 'pins');
    await mkdir(tmpDir, { recursive: true });
    const filename = imageUrl.split('/').pop().split('?')[0] || `pin-${Date.now()}.jpg`;
    const localPath = join(tmpDir, filename);
    if (!existsSync(localPath)) {
      Logger.info(`[Executor] Downloading pin image to ${localPath}`);
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(localPath, buf);
    }
    return localPath;
  }
  return imageUrl;  // assume absolute local
}

// ── Action: Create recipe ──────────────────────────────────────

/**
 * Run one recipe creation via VerifiedGeneratorOrchestrator.
 * The orchestrator reads pending rows from the active site's sheet and
 * processes them. For "test one recipe", we rely on the sheet having a
 * pending row.
 *
 * @param {object} item - plan item ({site})
 * @param {object} config - planifier config
 * @param {object} serverCtx - shared server context (browserContext, FlowAccountManager, etc.)
 */
async function runCreateRecipe(item, config, serverCtx) {
  // Set the active site to the item's site so the orchestrator reads the right sheet
  const currentActive = StateManager.getActiveSite?.() || null;
  let switched = false;
  if (currentActive && currentActive !== item.site) {
    StateManager.setActiveSite(item.site);
    switched = true;
    Logger.info(`[Executor] Switched active site: ${currentActive} → ${item.site}`);
  }

  // Apply the planifier's per-site sheetTab override to the site's settings
  // for the duration of the run — so VerifiedGeneratorOrchestrator reads
  // from the same tab the Planifier sees in Recipes/Pin Pool. Restore after.
  const sheetTabOverride = config.sites?.[item.site]?.sheetTab;
  let originalSheetTab = null;
  let didOverride = false;
  if (sheetTabOverride && sheetTabOverride.trim()) {
    try {
      const settings = await StateManager.getSettings();
      originalSheetTab = settings.sheetTabName;
      if (originalSheetTab !== sheetTabOverride.trim()) {
        settings.sheetTabName = sheetTabOverride.trim();
        await StateManager.saveSettings(settings);
        didOverride = true;
        Logger.info(`[Executor] Temporarily set sheetTabName: ${originalSheetTab} → ${sheetTabOverride.trim()} for ${item.site}`);
      }
    } catch (e) {
      Logger.warn(`[Executor] sheetTab override failed: ${e.message}`);
    }
  }

  try {
    // ── Force "1 recipe per slot" ────────────────────────────────
    // Without this guard, the VG orchestrator runs in continuous mode and
    // chains every pending row in the sheet back-to-back (40 pending = 20h
    // straight). The Planifier promise is one slot = one recipe — so we
    // pre-pick the next pending row and set up a 1-item batchMode queue,
    // which makes the orchestrator stop after that single recipe.
    const liveSettings = await StateManager.getSettings();
    const vgSheetSettings = {
      ...liveSettings,
      sheetTabName: liveSettings.verifiedGenSheetTab || liveSettings.generatorSheetTab || liveSettings.sheetTabName || 'single post',
      topicColumn: liveSettings.verifiedGenTopicColumn || liveSettings.generatorTopicColumn || liveSettings.topicColumn || 'A',
      statusColumn: liveSettings.verifiedGenStatusColumn || liveSettings.generatorStatusColumn || liveSettings.statusColumn || 'B',
      startRow: liveSettings.verifiedGenStartRow || liveSettings.generatorStartRow || liveSettings.startRow || 2,
    };
    const pending = await SheetsAPI.findPendingRow(vgSheetSettings);
    if (!pending) {
      Logger.info(`[Executor] No pending recipe in ${vgSheetSettings.sheetTabName} — nothing to do`);
      return { ok: true, processedCount: 0, reason: 'no-pending-row' };
    }
    Logger.info(`[Executor] Will process ONE recipe: "${pending.topic}" (row ${pending.rowIndex})`);

    // Seed batchMode state with a single item — the orchestrator's COMPLETED
    // handler checks batchQueue and stops when batchCurrentIndex >= length.
    await StateManager.resetState();
    await StateManager.updateState({
      status: STATES.LOADING_JOB,
      batchMode: true,
      batchQueue: [{ topic: pending.topic, rowIndex: pending.rowIndex }],
      batchCurrentIndex: 0,
      batchResults: [],
      batchStartedAt: Date.now(),
    });

    // Launch the browser with FlowAccount profile if rotation is enabled
    let profileOverride = null;
    try {
      if (await FlowAccountManager.isEnabled()) {
        const account = await FlowAccountManager.getActiveAccount();
        if (account) profileOverride = FlowAccountManager.getProfileDir(account);
      }
    } catch {}
    await serverCtx.launchBrowserWithProfile(profileOverride);
    const orchestrator = new VerifiedGeneratorOrchestrator(null, serverCtx.browserContext, serverCtx);
    serverCtx.orchestrator = orchestrator;
    await orchestrator.start();

    // Inspect the batch results to know if the recipe ACTUALLY completed —
    // the orchestrator's batch loop swallows step-level errors (Flow crash,
    // WP upload fail, etc.) and returns OK regardless. Check state.batchResults
    // to surface the real status to the Planifier.
    const finalState = await StateManager.getState();
    const batchResults = finalState.batchResults || [];
    const item0 = batchResults[0] || null;
    if (item0 && item0.status === 'error') {
      const errMsg = item0.error || 'Unknown orchestrator error';
      throw new Error(`Recipe "${pending.topic}" generation failed: ${errMsg}`);
    }
    return {
      ok: true,
      processedCount: 1,
      recipe: pending.topic,
      rowIndex: pending.rowIndex,
      draftUrl: item0?.draftUrl || null,
      orchestratorStatus: item0?.status || 'unknown',
    };
  } finally {
    try { await serverCtx.cleanupBrowser(); } catch {}
    // Restore the original sheetTabName so we don't permanently mutate site settings
    if (didOverride) {
      try {
        const settings = await StateManager.getSettings();
        settings.sheetTabName = originalSheetTab;
        await StateManager.saveSettings(settings);
        Logger.info(`[Executor] Restored sheetTabName: ${originalSheetTab}`);
      } catch (e) {
        Logger.warn(`[Executor] failed to restore sheetTabName: ${e.message}`);
      }
    }
    if (switched && currentActive) {
      StateManager.setActiveSite(currentActive);
      Logger.info(`[Executor] Restored active site: ${currentActive}`);
    }
  }
}

// ── Dispatcher ────────────────────────────────────────────────

/**
 * Run a plan item by ID. Updates status + appends history.
 *
 * @param {string} date - plan date (YYYY-MM-DD)
 * @param {string} itemId - item.id
 * @param {object} serverCtx - shared server context (for browser/automation)
 * @param {object} [options]
 * @param {boolean} [options.force] - allow re-running a done/error item
 */
export async function runPlanItem(date, itemId, serverCtx, options = {}) {
  if (serverCtx.automationRunning) {
    throw new Error('Another automation is already running. Wait or pause it first.');
  }

  const plan = await Planifier.getPlan(date);
  if (!plan) throw new Error(`No plan for ${date}`);
  const item = plan.items.find(i => i.id === itemId);
  if (!item) throw new Error(`Item ${itemId} not found`);
  if (item.status === 'in_progress') throw new Error('Already running');
  if (item.status === 'done' && !options.force) throw new Error('Already done. Use force=true to re-run.');

  const config = await Planifier.getConfig();

  serverCtx.automationRunning = true;
  await Planifier.updatePlanItem(date, itemId, {
    status: 'in_progress',
  });
  await Planifier.appendHistory({
    type: item.type,
    site: item.site,
    accountId: item.accountId,
    itemId,
    date,
    status: 'started',
    willPost: item.willPost,
    manuallyTriggered: !!options.manual,
  });

  const startedAt = Date.now();
  let result = null;
  let error = null;
  try {
    if (item.type === 'create-recipe') {
      result = await runCreateRecipe(item, config, serverCtx);
    } else if (item.type === 'pinterest-session') {
      result = await runPinterestSession(item, config);
    } else {
      throw new Error(`Unknown item type: ${item.type}`);
    }
  } catch (e) {
    error = e;
    Logger.error(`[Executor] item ${itemId} failed: ${e.message}`);
  } finally {
    serverCtx.automationRunning = false;
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    const status = error ? 'error' : 'done';
    await Planifier.updatePlanItem(date, itemId, {
      status,
    });
    await Planifier.appendHistory({
      type: item.type,
      site: item.site,
      accountId: item.accountId,
      itemId,
      date,
      status,
      willPost: item.willPost,
      durationSeconds: durationSec,
      result: result || null,
      error: error?.message || null,
      manuallyTriggered: !!options.manual,
    });

    // ── Telegram notification ────────────────────────────────────
    try {
      const tg = config.notifications?.telegram;
      if (tg?.enabled && tg?.botToken && tg?.chatId) {
        const shouldNotify = (error && tg.notifyOnError) || (!error && tg.notifyOnSuccess);
        if (shouldNotify) {
          const icon = error ? '❌' : '✅';
          const label = item.type === 'create-recipe' ? 'Recipe creation' : 'Pinterest session';
          const target = item.site + (item.accountId ? '/' + item.accountId : '');
          const recipe = result?.recipe ? `\n<b>Recipe:</b> ${result.recipe}` : '';
          const pin = result?.posted && result?.pinUrl ? `\n<b>Pin URL:</b> ${result.pinUrl}` : '';
          const draft = result?.draftUrl ? `\n<b>Draft:</b> ${result.draftUrl}` : '';
          const errLine = error ? `\n<b>Error:</b> <code>${escapeHtmlForTelegram(error.message.slice(0, 300))}</code>` : '';
          const msg = `${icon} <b>${label} ${error ? 'FAILED' : 'OK'}</b>\n${target}${recipe}${pin}${draft}\n<i>Duration: ${durationSec}s · ${new Date().toLocaleTimeString()}</i>${errLine}`;
          sendTelegram(tg, msg).catch(e => Logger.warn('[Telegram] async send failed: ' + e.message));
        }
      }
    } catch (e) {
      Logger.warn(`[Executor] Telegram notification skipped: ${e.message}`);
    }
  }
  if (error) throw error;
  return { ok: true, result, durationSec: Math.round((Date.now() - startedAt) / 1000) };
}
