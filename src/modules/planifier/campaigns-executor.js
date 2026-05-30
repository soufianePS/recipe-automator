/**
 * Campaigns Executor — fires due slots from the pin-campaigns sheet tab.
 *
 * Runs on each Planifier executor tick (every 60s). For each due slot
 * (scheduled_date <= today AND status == 'pending'):
 *   1. Resolve recipe row from URL → siteName + sheet row index
 *   2. Pick a template (campaign-specified by name OR first available)
 *   3. Call pin-regenerator: enqueueRegen + processJob
 *   4. On success: set status_N = 'generated', append PinHistory(type='regen')
 *   5. On error:   set status_N = 'error', append PinHistory(type='regen', notes=err)
 *
 * Concurrency: respects serverCtx.automationRunning so we don't overlap with
 * recipe creation, Pinterest sessions, or warming sessions.
 *
 * Re-entrancy: a single in-flight flag prevents two campaign slots from
 * starting simultaneously.
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Logger } from '../../shared/utils/logger.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { PinCampaigns } from '../../shared/utils/pin-campaigns.js';
import { PinHistory } from '../../shared/utils/pin-history.js';
import { enqueueRegen, processJob } from './pin-regenerator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

let _running = false;

/**
 * Extract the post_id from a WP admin or public URL.
 *   - Admin edit URL: ?post=1234
 *   - Public permalink: parse via WP REST to get the id (skipped here; we
 *     only support admin URLs for now since campaigns are user-created with
 *     known URLs from the dashboard).
 * Returns null if no post_id can be derived.
 */
function _extractPostId(recipeUrl) {
  if (!recipeUrl) return null;
  try {
    const u = new URL(recipeUrl);
    const p = u.searchParams.get('post');
    if (p && /^\d+$/.test(p)) return Number(p);
  } catch {}
  return null;
}

/**
 * Find the sheet row index for a recipe by its draft URL.
 * Iterates the site's recipe tab and matches col C (draftUrl) exactly.
 * Returns rowIndex (>= 2) or null.
 */
async function _findRecipeRowByUrl(siteName, recipeUrl, planifierConfig) {
  const siteSettings = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'data', 'sites', siteName, 'settings.json'), 'utf8')
  );
  const override = planifierConfig?.sites?.[siteName]?.sheetTab;
  const sheetTab = (override && override.trim()) || siteSettings.generatorSheetTab || siteSettings.sheetTabName;
  if (!sheetTab) throw new Error(`No recipes tab for site ${siteName}`);
  const rows = await SheetsAPI.readSheet(siteSettings.sheetId, sheetTab);
  for (let i = 0; i < rows.length; i++) {
    const c = (rows[i][2] || '').trim();  // column C = draftUrl
    if (c === recipeUrl) return { rowIndex: i + 2, settings: siteSettings, sheetTab };
  }
  // Second pass: substring match on post=ID (covers admin URL stored in C
  // with slight variations like ?action=edit appended/different)
  const postId = _extractPostId(recipeUrl);
  if (postId) {
    for (let i = 0; i < rows.length; i++) {
      const c = (rows[i][2] || '').trim();
      if (c && c.includes(`post=${postId}`)) return { rowIndex: i + 2, settings: siteSettings, sheetTab };
    }
  }
  return null;
}

/**
 * Load backgrounds.json and pick a template by name (case-insensitive).
 * If templateName is empty, picks the first available pinterestTemplatesGenerator.
 * Returns { name, base64 } or null if none available.
 */
async function _pickTemplate(siteName, templateName) {
  const path = join(PROJECT_ROOT, 'data', 'sites', siteName, 'backgrounds.json');
  if (!existsSync(path)) return null;
  const bg = JSON.parse(await readFile(path, 'utf8'));
  const pool = [
    ...(bg.pinterestTemplatesGenerator || []),
    ...(bg.pinterestTemplatesScraper || []),
  ];
  if (pool.length === 0) return null;
  if (templateName && templateName.trim()) {
    const lower = templateName.trim().toLowerCase();
    const hit = pool.find(t =>
      (t.name || t.filename || '').toLowerCase().includes(lower)
    );
    if (hit) return { name: hit.name || hit.filename, base64: hit.base64 || hit.data };
  }
  // Random pick from the pool
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  return { name: chosen.name || chosen.filename || 'template.jpg', base64: chosen.base64 || chosen.data };
}

/**
 * Process ONE due campaign slot end-to-end.
 * Returns true if processed (success OR error — either way the slot is no
 * longer 'pending'), false if skipped (concurrency/conditions not met).
 */
async function _processDueSlot(due, serverCtx, planifierConfig) {
  const { campaign, slot } = due;
  const slotKey = `${campaign.campaign_id}/${slot}`;
  Logger.info(`[Campaigns] Firing slot ${slotKey} (recipe="${campaign.recipe_title || '(untitled)'}", type=${campaign.type})`);

  // 1. Locate recipe row in the sheet
  let recipe;
  try {
    recipe = await _findRecipeRowByUrl(campaign.site, campaign.recipe_url, planifierConfig);
  } catch (e) {
    Logger.error(`[Campaigns] ${slotKey}: recipe lookup error: ${e.message}`);
    await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'error');
    await PinHistory.append({
      site: campaign.site, type: 'regen',
      recipe_topic: campaign.recipe_title || '', recipe_url: campaign.recipe_url,
      pin_slot: String(slot), notes: `lookup-error: ${e.message}`,
    });
    return true;
  }
  if (!recipe) {
    Logger.warn(`[Campaigns] ${slotKey}: recipe URL not found in ${campaign.site} sheet`);
    await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'error');
    await PinHistory.append({
      site: campaign.site, type: 'regen',
      recipe_topic: campaign.recipe_title || '', recipe_url: campaign.recipe_url,
      pin_slot: String(slot), notes: 'recipe-not-found',
    });
    return true;
  }

  // 2. Pick template
  const template = await _pickTemplate(campaign.site, campaign.template);
  if (!template) {
    Logger.warn(`[Campaigns] ${slotKey}: no templates in backgrounds.json for ${campaign.site}`);
    await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'error');
    await PinHistory.append({
      site: campaign.site, type: 'regen',
      recipe_topic: campaign.recipe_title || '', recipe_url: campaign.recipe_url,
      pin_slot: String(slot), notes: 'no-template-available',
    });
    return true;
  }

  // 3. Map campaign type + slot to pinIndex + mode
  //    - single-pin (new behavior): generate an EXTRA pin (no overwrite)
  //      → pinIndex used only for prompt context; mode='extra' writes to pin-history
  //    - regen-3pins (legacy if it ever reappears): slot N → pinIndex N, mode='replace'
  //    The slot label (from notes: "slot=X") is preserved as audit metadata.
  const slotMatch = (campaign.notes || '').match(/slot=(\w+)/);
  const slotLabel = slotMatch ? slotMatch[1] : 'extra';
  // pinIndex 0 used for prompt context (titles+descriptions). slotLabel
  // carries the user-chosen label into pin-history.
  const pinIndex = campaign.type === 'single-pin'
    ? (['1','2','3'].includes(slotLabel) ? Number(slotLabel) - 1 : 0)
    : Math.max(0, Number(slot) - 1);
  const mode = campaign.type === 'single-pin' ? 'extra' : 'replace';

  // Build full title (with optional prefix) so ChatGPT generates a coherent
  // description for the prefixed version (e.g. "Father's Day Brioche...").
  const prefixMatch = (campaign.notes || '').match(/prefix=([^·]+)/);
  const prefix = prefixMatch ? prefixMatch[1].trim() : '';
  const baseTitle = campaign.recipe_title || recipe.topic || 'Recipe';
  const fullTitle = prefix ? `${prefix} ${baseTitle}` : baseTitle;

  // 4. Enqueue + process
  try {
    const job = await enqueueRegen({
      site: campaign.site,
      rowIndex: recipe.rowIndex,
      pinIndex,
      templateName: template.name,
      templateBase64: template.base64,
      mode,
      slotLabel,
      fullTitle,                       // ChatGPT path uses this for prompt 1 (description)
      recipeCategory: recipe.category, // optional category for richer description
    });
    Logger.info(`[Campaigns] ${slotKey}: enqueued job ${job.id} → processing now`);
    await processJob(job.id, serverCtx, planifierConfig);

    // Reload job to see final state
    const { getJob } = await import('./pin-regenerator.js');
    const finalJob = await getJob(job.id);
    if (finalJob?.status === 'done') {
      await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'generated');
      await PinHistory.append({
        site: campaign.site, type: 'regen',
        recipe_topic: campaign.recipe_title || recipe.settings?.siteName || '',
        recipe_url: campaign.recipe_url,
        pin_slot: String(pinIndex),
        template: template.name,
        wp_image_url: finalJob.newPinUrl || '',
        notes: `campaign ${campaign.campaign_id} slot ${slot}`,
      });
      Logger.info(`[Campaigns] ${slotKey}: ✓ generated → ${finalJob.newPinUrl}`);

      // ── AUTO-POST to Pinterest immediately after generation ────
      // User vision: a Create Pin campaign should generate AND post in
      // the same flow, no waiting for the next pinterest-session tick.
      try {
        const postResult = await _autoPostPin({
          campaign,
          recipe,
          slot,
          pinIndex,
          newPinUrl: finalJob.newPinUrl,
          template,
          planifierConfig,
          serverCtx,
          // ChatGPT-generated description from the 2-prompt flow (if any).
          // Fallback to template-based description if absent.
          generatedDescription: finalJob.generatedDescription || null,
        });
        if (postResult.posted) {
          await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'posted');
          await PinHistory.patchByImageUrl(finalJob.newPinUrl, {
            pinterest_url: postResult.pinUrl || '',
            posted_at: new Date().toISOString(),
            account_id: postResult.accountId || '',
          });
          Logger.info(`[Campaigns] ${slotKey}: ✅ posted to Pinterest → ${postResult.pinUrl}`);
        } else {
          Logger.warn(`[Campaigns] ${slotKey}: post skipped — ${postResult.reason}`);
        }
      } catch (e) {
        Logger.warn(`[Campaigns] ${slotKey}: auto-post failed (non-fatal, will retry on next pinterest-session): ${e.message}`);
      }
    } else {
      await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'error');
      await PinHistory.append({
        site: campaign.site, type: 'regen',
        recipe_topic: campaign.recipe_title || '', recipe_url: campaign.recipe_url,
        pin_slot: String(pinIndex),
        template: template.name,
        notes: `job-${finalJob?.status || 'unknown'}: ${finalJob?.error || ''}`.slice(0, 250),
      });
      Logger.error(`[Campaigns] ${slotKey}: ✗ job status=${finalJob?.status}, err=${finalJob?.error}`);
    }
  } catch (e) {
    Logger.error(`[Campaigns] ${slotKey}: ${e.message}`);
    await PinCampaigns.setSlotStatus(campaign.campaign_id, slot, 'error');
    await PinHistory.append({
      site: campaign.site, type: 'regen',
      recipe_topic: campaign.recipe_title || '', recipe_url: campaign.recipe_url,
      pin_slot: String(pinIndex), template: template.name,
      notes: `exec-error: ${e.message}`.slice(0, 250),
    });
  }
  return true;
}

/**
 * Generate a fresh pin description from rotating templates.
 *
 * STRICT: no emojis, no icons, no markdown. Plain text only.
 * Each call picks a random template + substitutes recipe data so consecutive
 * pins for the same recipe don't have identical descriptions (Pinterest
 * penalizes duplicate descriptions).
 *
 * @param {object} opts
 * @param {string} opts.title - full pin title (with prefix applied if any)
 * @param {string} [opts.recipeTopic] - raw recipe topic
 * @param {string} [opts.category]
 * @returns {string}
 */
function _generatePinDescription({ title, recipeTopic = '', category = '' }) {
  const safe = s => String(s || '').replace(/[\p{Emoji}\p{Extended_Pictographic}]/gu, '').trim();
  const t = safe(title) || safe(recipeTopic) || 'this recipe';
  const cat = safe(category);
  const catTag = cat ? ` Perfect for ${cat.toLowerCase()} ideas.` : '';

  const templates = [
    `Looking for the perfect ${t}? This recipe is easy, quick, and packed with flavor.${catTag} Save this pin for your next meal and click through for the full step-by-step instructions.`,
    `Try this amazing ${t} recipe — simple ingredients, foolproof method, incredible taste. Save now, cook later. Click for the complete recipe with all tips and tricks.`,
    `The best ${t} you will ever make at home. Easy to follow, no fancy equipment needed.${catTag} Save this pin and grab the full recipe today.`,
    `Want a recipe everyone will love? This ${t} is a guaranteed crowd-pleaser. Quick prep, big flavor, simple steps. Click for the printable recipe card and pro tips.`,
    `Save this ${t} recipe for later. Made with everyday ingredients and ready in less time than you think.${catTag} Tap the pin to see the full directions.`,
    `Master ${t} at home with this no-fail recipe. Clear instructions, common ingredients, restaurant-quality result. Save the pin and visit the post for the complete guide.`,
    `If you love ${t}, this is the only recipe you need. Tested, photographed, and easy to follow.${catTag} Pin it now and cook it tonight.`,
    `Discover the simplest way to make ${t} from scratch. Step-by-step photos, helpful tips, and a printable recipe card on the blog. Save this pin to your favorite recipe board.`,
    `This ${t} recipe is going on regular rotation in our kitchen. Easy, satisfying, and full of flavor.${catTag} Tap through for the full method and ingredient list.`,
    `Need a reliable ${t} recipe? Look no further. Simple steps, real ingredients, perfect results every time. Save the pin and read the full post for all the details.`,
  ];

  const pick = templates[Math.floor(Math.random() * templates.length)];
  // Final safety: strip any accidental emojis from output
  return safe(pick);
}

/**
 * Resolve the canonical permalink for a WP post (admin URL → /slug/).
 * Returns the original URL if resolution fails.
 */
async function _toPublicLink(draftUrl) {
  if (!draftUrl) return '';
  let origin, postId;
  try {
    const u = new URL(draftUrl);
    origin = u.origin;
    postId = u.searchParams.get('post');
  } catch { return draftUrl; }
  if (!postId || !/^\d+$/.test(postId)) return draftUrl;
  try {
    const res = await fetch(`${origin}/wp-json/wp/v2/posts/${postId}?_fields=link`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const j = await res.json();
      if (j?.link) return j.link;
    }
  } catch {}
  return `${origin}/?p=${postId}`;
}

/**
 * Download a remote image URL to a local temp file. Returns the local path.
 */
async function _downloadImage(imageUrl) {
  const { writeFile, mkdir } = await import('fs/promises');
  const tmpDir = join(PROJECT_ROOT, 'data', 'tmp', 'campaign-pins');
  await mkdir(tmpDir, { recursive: true });
  const filename = imageUrl.split('/').pop().split('?')[0] || `pin-${Date.now()}.jpg`;
  const localPath = join(tmpDir, `${Date.now()}-${filename}`);
  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(localPath, buf);
  return localPath;
}

/**
 * AUTO-POST: right after a Create Pin campaign generates a new pin image,
 * connect to the Pinterest account's Dolphin profile and post it immediately.
 *
 * Account resolution priority:
 *   1. campaign.account_id (user-specified on the campaign)
 *   2. First account on the site with a Dolphin profile + status active/warmup_week_2/3
 *
 * Board selection: account.boards[0] if any; else default (Pinterest picks).
 *
 * Returns { posted: bool, pinUrl?: string, accountId?: string, reason?: string }
 */
async function _autoPostPin({ campaign, recipe, slot, pinIndex, newPinUrl, template, planifierConfig, serverCtx, generatedDescription = null }) {
  // 1. Resolve account
  const siteCfg = planifierConfig.sites?.[campaign.site];
  if (!siteCfg) return { posted: false, reason: 'site not in planifier config' };
  const accounts = siteCfg.pinterestAccounts || [];
  let account = null;
  if (campaign.account_id) {
    account = accounts.find(a => a.id === campaign.account_id);
    if (!account) return { posted: false, reason: `account ${campaign.account_id} not found` };
  } else {
    // Pick first eligible (has dolphin + status that can post)
    account = accounts.find(a => a.dolphinProfileId && ['active', 'warmup_week_2', 'warmup_week_3'].includes(a.status));
    if (!account) return { posted: false, reason: 'no eligible account with Dolphin profile' };
  }
  if (!account.dolphinProfileId) return { posted: false, reason: `account ${account.id} has no dolphinProfileId` };

  // HARD GUARD: recipe must be PUBLISH on WP. Posting a pin to a draft/scheduled
  // recipe sends Pinterest traffic to a 404 or admin login wall — hurts both UX
  // and domain trust score. Same guard the pinterest-session flow uses.
  const { _isRecipePublished } = await import('./action-executor.js');
  const pubCheck = await _isRecipePublished(campaign.recipe_url);
  if (!pubCheck.ok) {
    Logger.warn(`[Campaigns] Skip auto-post: ${pubCheck.reason}`);
    return { posted: false, reason: `recipe-not-published (${pubCheck.status})` };
  }
  Logger.info(`[Campaigns] Recipe status check: publish ✓`);

  // 2. Resolve public link (canonical WP permalink)
  const publicLink = await _toPublicLink(campaign.recipe_url);

  // 3. Build pin metadata — title = optional [prefix] + recipe_title.
  //    Description = ChatGPT 2-prompt result if available (prompt 1 ran in
  //    pin-regenerator), else template-based fallback (always emoji-free).
  //    Tags = user-provided comma-separated list (parsed from notes).
  const recipePin = recipe.pins?.[pinIndex] || {};
  const baseTitle = campaign.recipe_title || recipe.topic || recipePin.title || 'Recipe';
  // Extract prefix from campaign.notes (format: "... · prefix=Father's Day · ...")
  const prefixMatch = (campaign.notes || '').match(/prefix=([^·]+)/);
  const prefix = prefixMatch ? prefixMatch[1].trim() : '';
  const pinTitle = prefix ? `${prefix} ${baseTitle}` : baseTitle;
  // Extract user-defined tags (comma-separated)
  const tagsMatch = (campaign.notes || '').match(/tags=([^·]+)/);
  const tags = tagsMatch
    ? tagsMatch[1].split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
    : [];
  // Source priority for description:
  //   1. ChatGPT (prompt 1 in 2-prompt flow) — best, contextual, unique each time
  //   2. Template-based fallback — used if ChatGPT path failed or wasn't taken (Flow gen)
  let pinDescription;
  let descSource;
  if (generatedDescription && generatedDescription.trim().length >= 50) {
    pinDescription = generatedDescription.trim();
    descSource = 'chatgpt';
  } else {
    pinDescription = _generatePinDescription({
      title: pinTitle,
      recipeTopic: recipe.topic,
      category: recipe.category,
    });
    descSource = 'template-fallback';
  }
  Logger.info(`[Campaigns] Pin metadata: title="${pinTitle}" · description=${pinDescription.length} chars (source: ${descSource})`);

  // 4. Download the newly-generated pin image to local disk (createPin needs a path)
  const imagePath = await _downloadImage(newPinUrl);

  // 5. Pick board — boards come from scraped Pinterest profile (preferred)
  //    OR manually-entered account.boards (fallback). Category matches board
  //    via substring (case-insensitive), so site category "Dinner" auto-links
  //    to Pinterest board "Best Dinner for Family". If no cached scrape exists,
  //    we'll do a live scrape AFTER the Pinterest browser is open (further below).
  const { getEffectiveBoards, findBoardForCategory } = await import('./boards-validator.js');
  let { boards, source: boardsSource } = await getEffectiveBoards(campaign.site, account.id, account.boards || []);
  let boardName = null;
  let needsLiveScrape = boards.length === 0;
  if (boards.length > 0) {
    if (recipe.category) {
      boardName = findBoardForCategory(boards, recipe.category)
        || boards[Math.floor(Math.random() * boards.length)];
      Logger.info(`[Campaigns] Board: "${boardName}" (category="${recipe.category}", source=${boardsSource}, matched=${!!findBoardForCategory(boards, recipe.category)})`);
    } else {
      boardName = boards[Math.floor(Math.random() * boards.length)];
      Logger.info(`[Campaigns] Board: "${boardName}" (random — recipe has no category, source=${boardsSource})`);
    }
  }

  // 6. Connect Dolphin + open Pinterest + createPin
  const { DolphinAnty } = await import('../../shared/utils/dolphin-anty.js');
  const { PinterestPage } = await import('../../shared/pages/pinterest.js');
  const { chromium } = await import('playwright');
  const { Planifier } = await import('./planifier.js');
  const planCfg = await Planifier.getConfig();
  const dolphin = new DolphinAnty({ dolphinAnty: planCfg.dolphinAnty });

  let browser, context, page;
  // Mark busy so other automations don't fight for Dolphin
  serverCtx.automationRunning = true;
  serverCtx.automationStartedAt = Date.now();
  try {
    Logger.info(`[Campaigns] Auto-post: starting Dolphin profile ${account.dolphinProfileId} for ${campaign.site}/${account.id}...`);
    const { port } = await dolphin.startAndGetCDP(Number(account.dolphinProfileId));
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    context = browser.contexts()[0] || (await browser.newContext());
    page = context.pages()[0] || (await context.newPage());

    const pinterest = new PinterestPage(page);
    await pinterest.init();

    // Live-scrape the account's Pinterest boards on first auto-post (no cache).
    // ~10s cost but cached 24h so subsequent posts are instant. Result is the
    // source of truth for board names — user doesn't have to manually list them.
    if (needsLiveScrape) {
      try {
        Logger.info(`[Campaigns] No cached boards — live-scraping Pinterest profile boards for ${campaign.site}/${account.id}...`);
        const { validate: validateBoards } = await import('./boards-validator.js');
        const { _loadSiteCategories } = { _loadSiteCategories: async (s) => {
          try {
            const { readFile: rf } = await import('fs/promises');
            const { join: jp } = await import('path');
            const p = jp(PROJECT_ROOT, 'data', 'sites', s, 'settings.json');
            const txt = await rf(p, 'utf8');
            const sj = JSON.parse(txt);
            return String(sj.wpCategories || '').split(',').map(x => x.trim()).filter(Boolean);
          } catch { return []; }
        } };
        const cats = await _loadSiteCategories(campaign.site);
        const scrapeResult = await validateBoards(page, campaign.site, account.id, cats);
        if (scrapeResult?.boards?.length > 0) {
          boards = scrapeResult.boards;
          boardsSource = 'live-scrape';
          if (recipe.category) {
            const { findBoardForCategory } = await import('./boards-validator.js');
            boardName = findBoardForCategory(boards, recipe.category)
              || boards[Math.floor(Math.random() * boards.length)];
          } else {
            boardName = boards[Math.floor(Math.random() * boards.length)];
          }
          Logger.info(`[Campaigns] Live-scraped ${boards.length} boards → using "${boardName}"`);
        } else {
          Logger.warn(`[Campaigns] Live-scrape returned 0 boards — pin will go to Pinterest default`);
        }
      } catch (e) {
        Logger.warn(`[Campaigns] Live-scrape failed (non-fatal): ${e.message}`);
      }
    }

    Logger.info(`[Campaigns] Auto-post: createPin board="${boardName || '(default)'}", title="${pinTitle.slice(0, 40)}...", tags=${tags.length ? tags.join('|') : '(none)'}`);
    const result = await pinterest.createPin({
      imagePath,
      title: pinTitle,
      description: pinDescription,
      link: publicLink,
      boardName,
      altText: pinTitle,
      tags,                       // [] or array of user-provided tags
      warmup: false,
    });
    return {
      posted: true,
      pinUrl: result.pinUrl || '',
      accountId: account.id,
      boardName,
    };
  } catch (e) {
    Logger.warn(`[Campaigns] Auto-post error: ${e.message}`);
    return { posted: false, reason: `dolphin/pinterest error: ${e.message}` };
  } finally {
    try { await browser?.close(); } catch {}
    try { await dolphin.stopProfile(Number(account.dolphinProfileId)); } catch {}
    serverCtx.automationRunning = false;
    serverCtx.automationStartedAt = null;
  }
}

/**
 * Tick entrypoint — called from Planifier.executorTick.
 *
 * Picks ONE due slot per tick (sequential — no parallel campaigns). If a
 * slot is currently processing, returns immediately.
 */
export async function campaignsTick(serverCtx, planifierConfig) {
  if (_running) return { processed: 0, skipped: 'already-running' };
  if (!serverCtx) return { processed: 0, skipped: 'no-ctx' };
  if (serverCtx.automationRunning) return { processed: 0, skipped: 'other-automation-running' };

  let processed = 0;
  try {
    const due = await PinCampaigns.listDueSlots();
    if (due.length === 0) return { processed: 0, skipped: 'no-due-slots' };
    // Fire the OLDEST due slot first; others wait next tick.
    const next = due[0];
    Logger.info(`[Campaigns] ${due.length} due slot(s) — processing oldest first (${next.campaign.campaign_id}/${next.slot})`);
    _running = true;
    const ok = await _processDueSlot(next, serverCtx, planifierConfig);
    if (ok) processed++;
  } catch (e) {
    Logger.warn(`[Campaigns] tick error: ${e.message}`);
  } finally {
    _running = false;
  }
  return { processed };
}
