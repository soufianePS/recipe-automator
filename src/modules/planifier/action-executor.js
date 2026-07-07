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
import { pickNextEligiblePin, pickSpecificPin, pickOldestForRecycle, markPinPosted, readSitePool } from './pin-pool.js';
import { DolphinAnty } from '../../shared/utils/dolphin-anty.js';
import { PinterestPage } from '../../shared/pages/pinterest.js';
import { StateManager, STATES } from '../../shared/utils/state-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { VerifiedGeneratorOrchestrator } from '../verified-generator/orchestrator.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { chromium } from 'playwright';
import { sendTelegram } from '../../shared/utils/telegram-notifier.js';
import { PinHistory } from '../../shared/utils/pin-history.js';

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
 * Derive Pinterest "tagged topics" from a recipe when the sheet has no tags
 * populated (the recipe generator doesn't write a tags column). Uses the
 * category + meaningful words from the title + a generic food term. Pinterest
 * matches these to its interest taxonomy via the tag-search suggestions.
 */
function _deriveTags(recipe) {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    const v = String(t || '').trim().toLowerCase();
    if (v.length > 2 && !seen.has(v)) { seen.add(v); out.push(v); }
  };
  const cat = (recipe?.category || '').trim();
  if (cat) { add(cat); add(`${cat} recipes`); }
  const STOP = new Set(['the','a','an','and','with','of','for','to','in','on','best','easy','quick','simple','homemade','recipe','recipes','how','make','your']);
  const words = String(recipe?.topic || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  for (const w of words.slice(0, 3)) add(w);
  add('food recipes');
  return out.slice(0, 6);
}

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
    try {
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          try { await p.close(); } catch {}
        }
      }
    } catch {}
    try { await browser.close(); } catch {}
    try {
      await dolphin.stopProfile(profileId);
      Logger.info(`[Executor] Dolphin profile ${profileId} stopped`);
    } catch (e) {
      Logger.warn(`[Executor] stopProfile failed, retrying once: ${e.message}`);
      try {
        await dolphin.stopProfile(profileId);
        Logger.info(`[Executor] Dolphin profile ${profileId} stopped (retry)`);
      } catch (e2) {
        Logger.warn(`[Executor] stopProfile retry failed — profile ${profileId} may still be running: ${e2.message}`);
      }
    }
  };
  return { browser, context, page, dolphin, profileId, cleanup };
}

/**
 * Recycle helper (rules #4/#5) — generate a fresh EXTRA pin (beyond the 3 slots)
 * for a recipe using a RANDOM Pinterest template, via the regen job pipeline
 * (mode='extra'). The new pin is written to pin-history and surfaced into the
 * pool by _attachExtraPins, so the normal posting flow then picks + posts it.
 * Runs BEFORE the Dolphin connection, so the Flow/ChatGPT regen browser and the
 * Dolphin browser never overlap.
 */
async function _regenExtraPin(recipe, config, serverCtx) {
  const { enqueueRegen, processJob } = await import('./pin-regenerator.js');
  const bgPath = join(PROJECT_ROOT, 'data', 'sites', recipe.site, 'backgrounds.json');
  const data = JSON.parse(await readFile(bgPath, 'utf8'));
  const templates = (data.pinterestTemplatesGenerator && data.pinterestTemplatesGenerator.length)
    ? data.pinterestTemplatesGenerator
    : (data.pinterestTemplatesScraper || []);
  if (!templates.length) throw new Error('no Pinterest templates available to recycle with');
  const tpl = templates[Math.floor(Math.random() * templates.length)];   // random template
  const nextIndex = (recipe.pins?.length || 3);                          // after slots + existing extras
  Logger.info(`[Executor] Recycle: regenerating extra pin for "${recipe.topic}" with random template "${tpl.name}"`);
  const job = await enqueueRegen({
    site: recipe.site,
    rowIndex: recipe.rowIndex,
    pinIndex: nextIndex,
    templateName: tpl.name,
    templateBase64: tpl.base64,
    mode: 'extra',
    slotLabel: 'extra',
    fullTitle: recipe.topic,
    recipeCategory: recipe.category || null,
  });
  await processJob(job.id, serverCtx, config);
}

// ── Action: Pinterest session (browse + optional post) ──────────

/**
 * Run one Pinterest session — browse + optionally one pin post.
 * @param {object} item - plan item ({site, accountId, willPost, dolphinProfileId?})
 * @param {object} config - planifier config
 */
async function runPinterestSession(item, config, serverCtx = null) {
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
    if (item.targetPin) {
      // Bulk "queue for Pinterest" targets a SPECIFIC pin chosen by the user.
      pickedPin = await pickSpecificPin(config, item.site, item.targetPin.rowIndex, item.targetPin.pinIndex);
      if (!pickedPin) {
        postFallbackReason = 'target-pin-unavailable';
        Logger.warn(`[Executor] targetPin row ${item.targetPin.rowIndex} pin#${item.targetPin.pinIndex} unavailable (not in pool / no image / already posted) — running browse-only.`);
      }
    } else {
      pickedPin = await pickNextEligiblePin(config, item.site, item.accountId);
      if (!pickedPin) {
        // RULES #4 + #5: pool is dry (every article has all pins posted, or all
        // available pins are within the gap window). Recycle the article that
        // has gone the LONGEST without a new pin → regenerate a fresh EXTRA pin
        // for it with a RANDOM template (evergreen reposting beyond 3 pins),
        // then retry the pick so it gets posted this session.
        const oldest = await pickOldestForRecycle(config, item.site, item.accountId);
        if (oldest && serverCtx) {
          try {
            await _regenExtraPin(oldest, config, serverCtx);
            pickedPin = await pickNextEligiblePin(config, item.site, item.accountId);
            if (pickedPin) Logger.info(`[Executor] Recycled oldest article "${oldest.topic}" → fresh extra pin ready to post`);
          } catch (e) { Logger.warn(`[Executor] recycle regen failed: ${e.message}`); }
        }
        if (!pickedPin) {
          postFallbackReason = 'no-eligible-pin';
          Logger.warn(`[Executor] No eligible pin for ${item.site}/${item.accountId} and nothing recyclable — running browse-only instead.`);
        }
      }
    }
  }

  // Get recipe {title, category} pairs for the keyword pool. The category is
  // what lets a recipe-search → save target the matching board (1-to-1).
  let recipeTitles = [];
  let recipeObjs = [];
  if (site.useRecipeNamesAsKeywords) {
    try {
      const pool = await readSitePool(item.site, config);
      recipeObjs = pool.filter(r => r.topic).map(r => ({ title: r.topic, category: r.category || '' }));
      recipeTitles = recipeObjs.map(r => r.title);
    } catch (e) { Logger.warn(`[Executor] recipe titles unavailable: ${e.message}`); }
  }

  // Load site's WP categories — used as primary search keywords with 1-to-1
  // mapping to Pinterest board names (search "Dinner" → save to board "Dinner").
  let categories = [];
  let wpAuth = null; // Basic auth for WP REST — lets status/permalink checks see non-public posts
  try {
    const sitePath = join(PROJECT_ROOT, 'data', 'sites', item.site, 'settings.json');
    const ss = JSON.parse(await readFile(sitePath, 'utf8'));
    categories = (ss.wpCategories || '').split(',').map(s => s.trim()).filter(Boolean);
    const wpUser = ss.wpUsername || ss.wpUser;
    const wpPass = ss.wpAppPassword || ss.wpPassword;
    if (wpUser && wpPass) wpAuth = 'Basic ' + Buffer.from(`${wpUser}:${wpPass}`).toString('base64');
    if (categories.length > 0) {
      Logger.info(`[Executor] Site categories (search + board mapping): ${categories.join(', ')}`);
    }
  } catch (e) { Logger.warn(`[Executor] categories unavailable: ${e.message}`); }

  // HARD GUARD: recipe must be PUBLISH on WP — pinning to drafts/futures sends
  // Pinterest traffic to a 404 or login wall, hurts domain trust. Checked HERE
  // (before Dolphin even starts) rather than after the browse session, so a
  // recipe with a bad/missing draftUrl doesn't burn a 20+ min Dolphin session
  // only to be rejected at the very end.
  if (pickedPin) {
    const pubCheck = await _isRecipePublished(pickedPin.recipe.draftUrl, wpAuth);
    if (!pubCheck.ok) {
      Logger.warn(`[Executor] Skipping pin before browse session: ${pubCheck.reason}`);
      return {
        ok: true,
        posted: false,
        skipped: true,
        recipe: pickedPin.recipe.topic,
        pinIndex: pickedPin.pin.pinIndex,
        reason: `recipe-not-published (${pubCheck.status})`,
        browseEvents: 0,
      };
    }
  }

  // Pre-roll the session (deterministic — what the user previewed).
  // If we're going to post a pin, tell the simulator to warm up specifically on
  // THAT recipe (search it + save to its category board) before posting.
  const targetRecipe = (item.willPost && pickedPin && pickedPin.recipe)
    ? { title: pickedPin.recipe.topic, category: pickedPin.recipe.category || '' }
    : null;
  const plan = simulateSession(config, item.site, {}, recipeTitles, { categories, recipes: recipeObjs, targetRecipe });
  Logger.info(`[Executor] Planned session: ${plan.durationMinutes}min, ${plan.events.length} events, summary=${JSON.stringify(plan.summary)}`);

  const { page, cleanup } = await _connectDolphin(Number(profileId));
  try {
    const pinterest = new PinterestPage(page);
    await pinterest.init();
    Logger.info(`[Executor] Pinterest ready — replaying ${plan.events.length} browse events`);

    // Pre-flight: validate that Pinterest boards exist for the site's
    // categories. Cached 24h. Best-effort — never blocks the session.
    if (categories.length > 0) {
      try {
        const { ensureValidation } = await import('./boards-validator.js');
        const val = await ensureValidation(page, item.site, item.accountId, categories);
        if (val.missing.length > 0) {
          Logger.warn(`[Executor] Missing Pinterest boards: ${val.missing.join(', ')} — those category saves will use default board`);
        }
      } catch (e) {
        Logger.warn(`[Executor] board validation skipped: ${e.message}`);
      }
    }

    // Replay browse events (uses humanBrowseSession added to PinterestPage)
    const boards = account.boards || [];
    await pinterest.humanBrowseSession({ events: plan.events, boards });

    if (pickedPin) {
      Logger.info(`[Executor] Now posting pin: ${pickedPin.recipe.topic} / pin#${pickedPin.pin.pinIndex}`);
      Logger.info(`[Executor] Recipe status check: publish ✓`);
      // A dead pin image (e.g. recipe regenerated → old pin URL 404s) must NOT
      // crash the whole session. The human browse already happened; just skip
      // the post and return browse-only.
      let imagePath;
      try {
        imagePath = await _resolveImagePath(pickedPin.pin.imageUrl, item.site);
      } catch (e) {
        Logger.warn(`[Executor] Skipping post — pin image unavailable: ${e.message}`);
        return {
          ok: true, posted: false, skipped: true,
          recipe: pickedPin.recipe.topic, pinIndex: pickedPin.pin.pinIndex,
          reason: 'pin-image-unavailable', browseEvents: plan.events.length,
        };
      }

      // Board selection: use scraped Pinterest boards (preferred — found via
      // validator cache from prior warming or live-scrape) OR account.boards
      // fallback. Match category → board via substring.
      const { getEffectiveBoards, resolveBoardForCategory } = await import('./boards-validator.js');
      const { boards: effBoards, source: bSource } = await getEffectiveBoards(item.site, item.accountId, boards);
      let boardName = null;
      if (effBoards.length === 0) {
        Logger.warn(`[Executor] ⚠ account ${item.accountId} has NO boards (no scraped cache, no manual config). Pinterest defaults to last-used board (e.g. "breakfast"). Run a warming session OR add boards manually.`);
      } else if (pickedPin.recipe.category) {
        const resolved = resolveBoardForCategory(effBoards, pickedPin.recipe.category, account.categoryBoardMap || {});
        if (!resolved?.boardName) {
          Logger.warn(`[Executor] Skipping pin: no Pinterest board mapped for category "${pickedPin.recipe.category}"`);
          return {
            ok: true, posted: false, skipped: true,
            recipe: pickedPin.recipe.topic, pinIndex: pickedPin.pin.pinIndex,
            reason: 'no-category-board-mapping', category: pickedPin.recipe.category,
            availableBoards: effBoards,
          };
        }
        boardName = resolved.boardName;
        Logger.info(`[Executor] Board: "${boardName}" (category="${pickedPin.recipe.category}", boardsSource=${bSource}, mapping=${resolved.source})`);
      } else {
        boardName = effBoards[Math.floor(Math.random() * effBoards.length)];
        Logger.info(`[Executor] Board: "${boardName}" (random — recipe has no category, source=${bSource})`);
      }

      // Tags ("tagged topics"): from the sheet (pin tags column) if present.
      // The recipe generator doesn't write a tags column, so it's usually empty
      // → DERIVE tags from the recipe (category + title words) so pins never go
      // up with zero tagged topics.
      let tags = (pickedPin.pin.tags || '')
        .split(',').map(t => t.trim()).filter(Boolean).slice(0, 10);
      if (tags.length === 0) {
        tags = _deriveTags(pickedPin.recipe);
        Logger.info(`[Executor] No sheet tags — derived ${tags.length} from recipe: ${tags.join(', ')}`);
      }

      // Convert the WP admin edit URL into a public-facing redirect URL.
      // Pinterest links go to `<site>/?p=<postId>` which WP auto-redirects to
      // the canonical permalink (e.g. /classic-cobb-salad/).
      const publicLink = await _toPublicLink(pickedPin.recipe.draftUrl, pickedPin.pin.imageUrl, wpAuth);
      Logger.info(`[Executor] Pin link: ${publicLink}`);
      // HARD GUARD #2: must resolve to a real PUBLIC link (not empty, not an
      // admin/edit URL). Belt-and-suspenders with the published check above.
      if (!publicLink || /\/wp-admin\//.test(publicLink) || /[?&]action=edit/.test(publicLink)) {
        Logger.warn(`[Executor] Skipping pin: no valid public link resolved (${publicLink})`);
        return { ok: true, posted: false, skipped: true, recipe: pickedPin.recipe.topic, pinIndex: pickedPin.pin.pinIndex, reason: 'no-public-link' };
      }
      const result = await pinterest.createPin({
        imagePath,
        title: pickedPin.pin.title || pickedPin.recipe.topic,
        description: pickedPin.pin.description || '',
        link: publicLink,
        boardName,
        altText: pickedPin.pin.title || '',
        tags,
        warmup: false, // we already warmed up via humanBrowseSession
      });
      // Persist posted_at. For extras (campaign-generated, not in sheet F/J/N)
      // we only patch pin-history. For regular pins (slot 0-2) we update the
      // recipe sheet U/V/W cell as before.
      if (pickedPin.pin.isExtra) {
        Logger.info(`[Executor] Extra pin — skipping sheet U/V/W update (will patch pin-history instead)`);
      } else {
        await markPinPosted(item.site, pickedPin.recipe.rowIndex, pickedPin.pin.pinIndex);
      }
      // Audit: patch the pin-history row for this image with pinterest_url +
      // posted_at + account_id. Best-effort — never blocks the return.
      try {
        await PinHistory.patchByImageUrl(pickedPin.pin.imageUrl, {
          pinterest_url: result.pinUrl || '',
          posted_at: new Date().toISOString(),
          account_id: item.accountId || '',
        });
      } catch (e) {
        Logger.warn(`[PinHistory] post-patch failed (non-fatal): ${e.message}`);
      }
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
// Cache recipe status check per process (5-minute TTL) so repeated checks of
// the same post during a session don't hammer the WP REST API.
const _recipeStatusCache = new Map();  // postId → { status, at }
const RECIPE_STATUS_TTL_MS = 5 * 60 * 1000;

/**
 * Live-check WordPress to confirm the pin's underlying recipe is PUBLISHED.
 * Pinterest rules + UX: posting pins to draft/scheduled recipes wastes posts
 * (link returns 404 or login wall to non-admins). This is a hard guard
 * applied just before createPin.
 *
 * Returns:
 *   - { ok: true, status: 'publish' }        → safe to post
 *   - { ok: false, status, reason }          → skip the post
 *   - { ok: true, status: 'unknown' }        → REST unreachable; permissive
 *                                              fail-open (don't block on infra)
 */
export async function _isRecipePublished(draftUrl, wpAuth = null) {
  if (!draftUrl) return { ok: false, status: 'no-url', reason: 'no draftUrl on pin' };
  let origin, postId;
  try {
    const u = new URL(draftUrl);
    origin = u.origin;
    postId = u.searchParams.get('post');
  } catch {
    return { ok: false, status: 'invalid-url', reason: `cannot parse ${draftUrl}` };
  }
  if (!postId || !/^\d+$/.test(postId)) return { ok: false, status: 'no-post-id', reason: 'no ?post=N in draftUrl' };

  const cacheKey = `${origin}|${postId}`;
  const cached = _recipeStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.at < RECIPE_STATUS_TTL_MS) {
    return cached.status === 'publish'
      ? { ok: true, status: 'publish' }
      : { ok: false, status: cached.status, reason: `recipe status is "${cached.status}", not publish (cached)` };
  }
  // Query /posts/{id}?context=edit WITH auth so we get the TRUE status even for
  // non-public posts (a draft returns 200 + status:"draft" when authenticated;
  // unauthenticated it returns 401/403/404 which we treat as "not public").
  const restUrl = `${origin}/wp-json/wp/v2/posts/${postId}?_fields=status,id${wpAuth ? '&context=edit' : ''}`;
  try {
    const res = await fetch(restUrl, {
      headers: wpAuth ? { Authorization: wpAuth } : {},
      signal: AbortSignal.timeout(8000),
    });
    // 404/401/403 → post is NOT publicly visible (draft/future/private/trashed).
    // FAIL CLOSED: skip the post rather than pin to a dead/draft link.
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      _recipeStatusCache.set(cacheKey, { status: 'not-public', at: Date.now() });
      return { ok: false, status: 'not-public', reason: `WP returned ${res.status} (post not publicly visible: draft/future/private/trashed)` };
    }
    if (!res.ok) {
      // Infra error (5xx, etc.) — FAIL CLOSED: skip this slot and retry later.
      // A missed pin slot is cheaper than pinning a URL we can't verify
      // (Pinterest account safety > slot throughput). Not cached, so the next
      // tick re-checks.
      Logger.warn(`[Executor] recipe status check ${restUrl} → HTTP ${res.status}; skipping (WP unreachable, will retry)`);
      return { ok: false, status: 'wp-unreachable', reason: `WP returned HTTP ${res.status} — cannot verify publish status, skipping` };
    }
    const json = await res.json();
    const status = json?.status || 'unknown';
    _recipeStatusCache.set(cacheKey, { status, at: Date.now() });
    return status === 'publish'
      ? { ok: true, status }
      : { ok: false, status, reason: `recipe status is "${status}", not publish` };
  } catch (e) {
    // Network failure/timeout — same FAIL CLOSED rule as HTTP 5xx above.
    Logger.warn(`[Executor] recipe status check failed for post ${postId}: ${e.message}; skipping (WP unreachable, will retry)`);
    return { ok: false, status: 'wp-unreachable', reason: `status check failed (${e.message}) — cannot verify publish status, skipping` };
  }
}

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
async function _toPublicLink(draftUrl, imageUrl, wpAuth = null) {
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
    const res = await fetch(restUrl, {
      headers: wpAuth ? { Authorization: wpAuth } : {},
      signal: AbortSignal.timeout(8000),
    });
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
  serverCtx.automationStartedAt = Date.now();
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
      result = await runPinterestSession(item, config, serverCtx);
    } else if (item.type === 'warming-session') {
      const { runWarmingSession } = await import('./warming-executor.js');
      result = await runWarmingSession(item, config);
    } else {
      throw new Error(`Unknown item type: ${item.type}`);
    }
  } catch (e) {
    error = e;
    Logger.error(`[Executor] item ${itemId} failed: ${e.message}`);
  } finally {
    serverCtx.automationRunning = false;
    serverCtx.automationStartedAt = null;
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
