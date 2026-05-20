/**
 * Pin Regenerator — regenerate a single pin image using the recipe's existing
 * hero photo + a user-chosen Pinterest template.
 *
 * Same approach as the VG pipeline: the hero is the ground-truth visual of
 * the finished dish (already on WP) and the template is the Pinterest-style
 * layout/branding overlay. We only ask the user to pick the template — the
 * hero is fetched automatically from the recipe's WP featured media.
 *
 * Flow:
 *   1. Look up the recipe row in the sheet (title, draftUrl, current pin data)
 *   2. Fetch the recipe's hero from WP (featured media → source_url → download)
 *   3. Write user-chosen template (base64 from backgrounds.json) to disk
 *   4. Launch Flow, generate the new pin (template as background, hero as context)
 *   5. Upload the new image to WP (creates a new media item)
 *   6. Delete the OLD pin's WP media (best-effort)
 *   7. Update sheet col F|J|N with the new public URL
 *   8. Clear sheet col U|V|W (posted_at) so the pin becomes "pending" again
 *
 * Concurrency: respects ctx.automationRunning so we don't fight an active
 * recipe-creation run. Caller (route) checks this before invoking.
 *
 * Status persistence: each request is saved to data/planifier/regen-queue.json
 * with a unique id so the UI can poll status. Entries are kept for ~24h then
 * pruned.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { Logger } from '../../shared/utils/logger.js';
import { WordPressAPI } from '../../shared/utils/wordpress-api.js';
import { FlowAccountManager } from '../../shared/utils/flow-account-manager.js';
import { SheetsAPI } from '../../shared/utils/sheets-api.js';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const QUEUE_PATH = join(PROJECT_ROOT, 'data', 'planifier', 'regen-queue.json');
const TMP_DIR = join(PROJECT_ROOT, 'data', 'tmp', 'regen');

// Pin block columns in the sheet (1-indexed letters)
const PIN_IMG_COLS = ['F', 'J', 'N'];          // pin1 image, pin2, pin3
const PIN_POSTED_COLS = ['U', 'V', 'W'];

function colIdx(c) { return c.toUpperCase().charCodeAt(0) - 65; }

async function _loadQueue() {
  if (!existsSync(QUEUE_PATH)) return { version: 1, items: [] };
  try { return JSON.parse(await readFile(QUEUE_PATH, 'utf8')); }
  catch { return { version: 1, items: [] }; }
}

async function _saveQueue(queue) {
  await mkdir(dirname(QUEUE_PATH), { recursive: true });
  // Prune entries older than 24h
  const cutoff = Date.now() - 24 * 3600_000;
  queue.items = queue.items.filter(it => new Date(it.createdAt).getTime() > cutoff || it.status === 'in_progress' || it.status === 'queued');
  await writeFile(QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
}

async function _updateJob(jobId, patch) {
  const queue = await _loadQueue();
  const job = queue.items.find(j => j.id === jobId);
  if (!job) return null;
  Object.assign(job, patch);
  await _saveQueue(queue);
  return job;
}

async function _loadSiteSettings(siteName) {
  const path = join(PROJECT_ROOT, 'data', 'sites', siteName, 'settings.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

async function _loadBackgrounds(siteName) {
  const path = join(PROJECT_ROOT, 'data', 'sites', siteName, 'backgrounds.json');
  if (!existsSync(path)) return { hero: [], pinterestTemplatesGenerator: [], pinterestTemplatesScraper: [] };
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Load the recipe row from the sheet to get title, draftUrl, current pin data.
 */
async function _loadRecipeRow(siteName, rowIndex, planifierConfig) {
  const settings = await _loadSiteSettings(siteName);
  // Apply planifier sheetTab override if set
  const override = planifierConfig?.sites?.[siteName]?.sheetTab;
  const sheetTab = (override && override.trim()) || settings.sheetTabName;
  const rows = await SheetsAPI.readSheet(settings.sheetId, sheetTab);
  const i = rowIndex - 2;
  if (i < 0 || i >= rows.length) throw new Error(`Row ${rowIndex} out of range in ${sheetTab}`);
  const row = rows[i];
  return {
    topic: (row[colIdx('A')] || '').trim(),
    status: (row[colIdx('B')] || '').trim(),
    draftUrl: (row[colIdx('C')] || '').trim(),
    timestamp: row[colIdx('D')] || '',
    category: (row[colIdx('E')] || '').trim(),
    pins: [
      { imageUrl: (row[colIdx('F')] || '').trim(), description: (row[colIdx('G')] || '').trim(), title: (row[colIdx('H')] || '').trim() },
      { imageUrl: (row[colIdx('J')] || '').trim(), description: (row[colIdx('K')] || '').trim(), title: (row[colIdx('L')] || '').trim() },
      { imageUrl: (row[colIdx('N')] || '').trim(), description: (row[colIdx('O')] || '').trim(), title: (row[colIdx('P')] || '').trim() },
    ],
    sheetTab,
    settings,
  };
}

/**
 * Try to delete a WP media item identified by its public URL.
 * Returns true on success, false on failure (we don't block regen if delete fails).
 */
async function _deleteWPMediaByUrl(settings, mediaUrl) {
  if (!mediaUrl || !mediaUrl.startsWith('http')) return false;
  try {
    // Look up media id via WP REST search-by-source URL
    const slug = mediaUrl.split('/').pop().replace(/\.[a-z]+$/i, '');
    const baseUrl = `${settings.wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/media`;
    const auth = 'Basic ' + Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64');
    // Search by media URL → use ?search=<slug>
    const searchRes = await fetch(`${baseUrl}?search=${encodeURIComponent(slug)}&per_page=10`, {
      headers: { Authorization: auth },
    });
    if (!searchRes.ok) return false;
    const items = await searchRes.json();
    const match = items.find(m => m.source_url === mediaUrl || m.guid?.rendered === mediaUrl);
    if (!match) {
      Logger.warn(`[Regen] could not locate WP media for URL ${mediaUrl}`);
      return false;
    }
    const delRes = await fetch(`${baseUrl}/${match.id}?force=true`, {
      method: 'DELETE',
      headers: { Authorization: auth },
    });
    if (!delRes.ok) {
      Logger.warn(`[Regen] delete media ${match.id} returned ${delRes.status}`);
      return false;
    }
    Logger.info(`[Regen] Deleted old WP media ${match.id} (${mediaUrl})`);
    return true;
  } catch (e) {
    Logger.warn(`[Regen] delete WP media failed: ${e.message}`);
    return false;
  }
}

/**
 * Write a base64 image to disk (data/tmp/regen/<id>-<name>).
 */
async function _writeBase64ToDisk(base64, namePrefix) {
  await mkdir(TMP_DIR, { recursive: true });
  const ext = (namePrefix.toLowerCase().endsWith('.png')) ? '.png' : '.jpg';
  const filename = `${randomUUID()}${ext}`;
  const path = join(TMP_DIR, filename);
  await writeFile(path, Buffer.from(base64, 'base64'));
  return path;
}

/**
 * Build the Flow prompt for the regenerated pin (similar to base-orchestrator).
 */
function _buildPinPrompt(recipeTitle, pinTitle, pinDescription, websiteDomain, settings) {
  const rawPrefix = settings.pinterestPromptPrefix || '';
  const rawSuffix = settings.pinterestPromptSuffix || '';
  const prefix = rawPrefix
    .replace(/@title/g, recipeTitle)
    .replace(/@pin_title/g, pinTitle || recipeTitle)
    .replace(/@pin_description/g, pinDescription || '')
    .replace(/@website/g, websiteDomain)
    .replace(/@prompt/g, '');
  const suffix = rawSuffix
    .replace(/@title/g, recipeTitle)
    .replace(/@pin_title/g, pinTitle || recipeTitle)
    .replace(/@website/g, websiteDomain);
  return [prefix, suffix].filter(Boolean).join('\n');
}

/**
 * Fetch the recipe's hero image from WP and download it to a local file.
 * Returns the local path.
 *
 * Strategy:
 *   1. Extract post ID from draftUrl
 *   2. Fetch the post → get featuredMediaId
 *   3. Fetch the media item → get source_url
 *   4. Download source_url to data/tmp/regen/<uuid>-hero.<ext>
 */
async function _downloadRecipeHero(settings, draftUrl) {
  if (!draftUrl) throw new Error('Recipe has no draftUrl — cannot fetch hero');
  const u = new URL(draftUrl);
  const postId = u.searchParams.get('post');
  if (!postId || !/^\d+$/.test(postId)) throw new Error('Could not extract post ID from draftUrl');

  // Fetch post → featuredMediaId
  const post = await WordPressAPI.fetchPostForRegen(settings, postId);
  if (!post.featuredMediaId) {
    // Fallback: first image from post content (hero is typically the first <img>)
    if (post.images?.[0]?.wpImageUrl) {
      Logger.info(`[Regen] No featured media set, using first content image as hero`);
      return await _downloadImageToDisk(post.images[0].wpImageUrl, 'hero');
    }
    throw new Error(`Post ${postId} has no featured media and no content images`);
  }

  // Fetch the media item → source_url
  const baseUrl = `${settings.wpUrl.replace(/\/$/, '')}/wp-json/wp/v2/media/${post.featuredMediaId}`;
  const auth = 'Basic ' + Buffer.from(`${settings.wpUsername}:${settings.wpAppPassword}`).toString('base64');
  const res = await fetch(baseUrl, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Fetch media ${post.featuredMediaId} failed: ${res.status}`);
  const media = await res.json();
  const heroUrl = media.source_url;
  if (!heroUrl) throw new Error('Featured media has no source_url');

  return await _downloadImageToDisk(heroUrl, 'hero');
}

/**
 * Download an HTTP image URL to a local file in data/tmp/regen.
 */
async function _downloadImageToDisk(url, prefix = 'img') {
  await mkdir(TMP_DIR, { recursive: true });
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Download ${url} failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = url.toLowerCase().match(/\.(jpe?g|png|webp)(?:\?|$)/)?.[1] || 'jpg';
  const path = join(TMP_DIR, `${randomUUID()}-${prefix}.${ext}`);
  await writeFile(path, buf);
  return path;
}

/**
 * Main entry — enqueue a regen job.
 *
 * Only the TEMPLATE is user-chosen; the hero is taken from the recipe's
 * existing WP featured image (same logic as the VG pipeline).
 *
 * Returns the job object immediately. Caller can poll status via getJob().
 */
export async function enqueueRegen({ site, rowIndex, pinIndex, templateName, templateBase64 }) {
  if (!site || rowIndex == null || pinIndex == null) {
    throw new Error('site, rowIndex, pinIndex required');
  }
  if (!templateBase64) {
    throw new Error('templateBase64 required');
  }
  const queue = await _loadQueue();
  const job = {
    id: randomUUID(),
    site, rowIndex, pinIndex,
    templateName: templateName || null,
    templateBase64Length: templateBase64?.length || 0,
    status: 'queued',
    createdAt: new Date().toISOString(),
    error: null,
    newPinUrl: null,
    log: [],
  };
  job._templatePath = await _writeBase64ToDisk(templateBase64, templateName || 'template.jpg');
  queue.items.push(job);
  await _saveQueue(queue);
  return job;
}

export async function getJob(jobId) {
  const queue = await _loadQueue();
  return queue.items.find(j => j.id === jobId) || null;
}

export async function listJobs({ limit = 50 } = {}) {
  const queue = await _loadQueue();
  return queue.items.slice(-limit).reverse();
}

/**
 * Actually run a regen job — launches Flow, generates the pin, uploads, updates sheet.
 *
 * @param {string} jobId
 * @param {object} serverCtx - shared server context (for ctx.automationRunning, etc.)
 * @param {object} planifierConfig
 */
export async function processJob(jobId, serverCtx, planifierConfig) {
  if (serverCtx.automationRunning) {
    throw new Error('Other automation running — wait for it to finish');
  }
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (job.status === 'in_progress') throw new Error('Job already running');
  if (job.status === 'done') throw new Error('Job already done');

  serverCtx.automationRunning = true;
  await _updateJob(jobId, { status: 'in_progress', startedAt: new Date().toISOString() });
  const log = (msg) => { Logger.info(`[Regen ${jobId.slice(0,8)}] ${msg}`); job.log.push({ t: Date.now(), msg }); };

  let browser, context, flow;
  try {
    log('Loading recipe row from sheet…');
    const recipe = await _loadRecipeRow(job.site, job.rowIndex, planifierConfig);
    log(`Recipe: "${recipe.topic}" — pin#${job.pinIndex + 1}`);
    const oldUrl = recipe.pins[job.pinIndex]?.imageUrl || '';
    const pinTitle = recipe.pins[job.pinIndex]?.title || '';
    const pinDescription = recipe.pins[job.pinIndex]?.description || '';

    if (!job._templatePath) throw new Error('Template not provided');

    // Fetch the recipe's hero from WP (featured media). Same logic as VG.
    log('Fetching recipe hero from WordPress featured media…');
    const heroPath = await _downloadRecipeHero(recipe.settings, recipe.draftUrl);
    job._heroPath = heroPath;
    await _updateJob(jobId, { _heroPath: heroPath, log: job.log });
    log(`Assets ready: hero=${heroPath.split(/[\\/]/).pop()} template=${job._templatePath.split(/[\\/]/).pop()}`);

    // Launch Flow browser
    log('Launching browser…');
    let profileDir = serverCtx.BROWSER_PROFILE;
    try {
      if (await FlowAccountManager.isEnabled()) {
        const account = await FlowAccountManager.getActiveAccount();
        if (account) profileDir = FlowAccountManager.getProfileDir(account);
      }
    } catch {}
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      viewport: null,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    browser = context.browser();
    serverCtx.browserContext = context;

    // Lazy import to avoid loading Playwright until needed
    const { FlowPage } = await import('../../shared/pages/flow.js');
    flow = new FlowPage(browser, context);

    // Build prompt
    const websiteDomain = (recipe.settings.wpUrl || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const prompt = _buildPinPrompt(recipe.topic, pinTitle, pinDescription, websiteDomain, recipe.settings);
    log(`Prompt built (${prompt.length} chars)`);

    // Run Flow
    log('Closing any active Flow session…');
    try { await flow.closeSession(); } catch {}
    const outputPath = join(TMP_DIR, `pin-out-${jobId}.jpg`);
    log('Calling Flow.generate()… (this can take 1-4 min)');
    const aspectRatio = recipe.settings.pinterestAspectRatio || 'PORTRAIT';
    const result = await flow.generate(
      prompt,
      job._templatePath,    // background = template
      [job._heroPath],      // context = hero only (same as base orchestrator)
      aspectRatio,
      outputPath,
      {}
    );
    if (!result || !existsSync(outputPath)) {
      throw new Error('Flow generation returned no image');
    }
    log(`Image generated at ${outputPath}`);

    // Upload to WP
    log('Uploading to WordPress…');
    const newBase64 = readFileSync(outputPath).toString('base64');
    const slug = (recipe.topic || 'pin').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filename = `${slug}-pin-${job.pinIndex + 1}-regen-${Date.now()}.jpg`;
    const seo = {
      alt_text: pinTitle || `${recipe.topic} Pinterest pin`,
      caption: pinDescription,
      title: pinTitle || recipe.topic,
      description: pinDescription,
    };
    const uploaded = await WordPressAPI.uploadImage(recipe.settings, newBase64, filename, seo);
    // WordPressAPI.uploadImage returns { id, url } — NOT source_url
    const newPinUrl = uploaded?.url || uploaded?.source_url;
    if (!newPinUrl) throw new Error(`WP upload failed (no url in response: ${JSON.stringify(uploaded).slice(0,200)})`);
    log(`Uploaded: ${newPinUrl} (WP media id ${uploaded?.id})`);

    // Update sheet col F/J/N + clear U/V/W
    const imgCol = PIN_IMG_COLS[job.pinIndex];
    const postedCol = PIN_POSTED_COLS[job.pinIndex];
    log(`Writing new URL to sheet col ${imgCol}${job.rowIndex} + clearing col ${postedCol}…`);
    const settings = recipe.settings;
    await SheetsAPI.writeRange(settings.sheetId, `${recipe.sheetTab}!${imgCol}${job.rowIndex}`, [[newPinUrl]], settings);
    await SheetsAPI.writeRange(settings.sheetId, `${recipe.sheetTab}!${postedCol}${job.rowIndex}`, [['']], settings, { bgColor: '#ffffff' });

    // Delete old WP media (best-effort)
    if (oldUrl && oldUrl !== newPinUrl) {
      log(`Deleting old WP media: ${oldUrl}`);
      await _deleteWPMediaByUrl(settings, oldUrl);
    }

    log('Done.');
    await _updateJob(jobId, {
      status: 'done',
      finishedAt: new Date().toISOString(),
      newPinUrl,
      log: job.log,
    });
    return { ok: true, newPinUrl };
  } catch (e) {
    Logger.error(`[Regen] ${e.message}`);
    await _updateJob(jobId, {
      status: 'error',
      finishedAt: new Date().toISOString(),
      error: e.message,
      log: job.log,
    });
    throw e;
  } finally {
    if (context) try { await context.close(); } catch {}
    serverCtx.browserContext = null;
    serverCtx.automationRunning = false;
  }
}
