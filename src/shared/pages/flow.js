/**
 * Google Flow/ImageFX Page Object — Playwright automation
 *
 * Simple & safe approach:
 * - Each image = fresh tab → new project → upload refs → generate → download → close
 * - Uses Flow's own download button (no DOM image extraction)
 * - Retry once on failure, then log and stop
 *
 * Split into 3 files:
 * - flow.js (this file) — class, constructor, core generation flow, settings, prompt, utilities
 * - flow-download.js — image download, filtering, SRC tracking, generation progress
 * - flow-cleanup.js — project cleanup, file upload, progress helpers
 */

import { Logger } from '../utils/logger.js';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, writeFileSync, mkdirSync } from 'fs';

// Import methods from split modules
import {
  _compareImages,
  _getAllImgSrcs,
  _waitForNewSrc,
  _downloadBySrc,
  _downloadImage,
  _downloadFilteredImage,
  _applyGenereFilter,
  _removeGenereFilter,
  _waitForGenerationProgress,
  _waitForGeneration,
  FlowRateLimitError,
  FlowAccountBlockedError,
} from './flow-download.js';

export { FlowRateLimitError, FlowAccountBlockedError };

import {
  cleanupAllProjects,
  _uploadFile,
  _pasteImageToPrompt,
  _uploadToCanvasAndAttach,
  _waitForProgress,
  _isProgressVisible,
} from './flow-cleanup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', '..', '..', 'screenshots');
const TMP_DIR = join(__dirname, '..', '..', '..', 'data', 'tmp');

// ═══════════════════════════════════════════════════════════
// ALL CONSTANTS (exported for use by flow-download.js & flow-cleanup.js)
// ═══════════════════════════════════════════════════════════

export const FLOW_URL = 'https://labs.google/fx/fr/tools/flow';

export const GOOGLE_SYMBOLS_SELECTOR = 'i.google-symbols, i[class*="google-symbols"]';
export const PROMPT_INPUT_SELECTORS = [
  'div[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]'
];
export const PROMPT_INPUT_CSS = PROMPT_INPUT_SELECTORS.join(', ');

export const PROGRESS_SELECTORS = [
  '[role="progressbar"]',
  '[aria-busy="true"]',
  '[class*="progress"]',
  '[class*="spinner"]'
];

// ─── Timeout / delay constants (milliseconds) ───

export const RETRY_DELAY                  = 3000;
export const PAGE_LOAD_DELAY              = 4000;
export const LANDING_PAGE_DELAY           = 3000;
export const NEW_PROJECT_DELAY            = 3000;
export const SETTINGS_OPEN_DELAY          = 1000;
export const SETTINGS_TAB_DELAY           = 300;
export const SETTINGS_CLOSE_DELAY         = 500;
export const UPLOAD_BUTTON_DELAY          = 1500;
export const UPLOAD_CONTEXT_DELAY         = 800;
export const POST_UPLOAD_DELAY            = 2000;
export const UPLOAD_PROGRESS_TIMEOUT      = 15000;
export const UPLOAD_CLOSE_DELAY           = 500;
export const POST_UPLOAD_FILE_DELAY       = 1000;
export const PROMPT_FOCUS_DELAY           = 300;
export const PROMPT_SELECT_ALL_DELAY      = 100;
export const PROMPT_DELETE_DELAY          = 200;
export const PROMPT_TYPE_DELAY            = 500;
export const PROMPT_POLL_DELAY            = 1000;
export const PROMPT_MAX_ATTEMPTS          = 10;
export const PRE_GENERATION_DELAY         = 3000;
export const GENERATION_MAX_TIMEOUT       = 120000;
export const GENERATION_POLL_DELAY        = 1000;
export const GENERATION_CONFIRM_DELAY     = 1000;
export const POST_GENERATION_DELAY        = 5000;
export const POST_GENERATION_RENDER_DELAY = 8000;
export const DOWNLOAD_MAX_TIMEOUT         = 45000;
export const DOWNLOAD_POLL_DELAY          = 2000;
export const IMAGE_LOAD_TIMEOUT           = 5000;
export const MAX_IMAGE_SIZE_BYTES         = 5 * 1024 * 1024; // 5MB — no aggressive compression
export const MIN_IMAGE_DIMENSION          = 200;
export const CLEANUP_INITIAL_DELAY        = 5000;
export const CLEANUP_LANDING_DELAY        = 5000;
export const CLEANUP_DELETE_DELAY         = 1000;
export const CLEANUP_CONFIRM_DELAY        = 1500;
export const CLEANUP_MAX_PROJECTS         = 50;
export const PROGRESS_DETECT_WINDOW       = 3000;
export const PROGRESS_DETECT_POLL_DELAY   = 300;
export const PROGRESS_FALLBACK_DELAY      = 1000;
export const PROGRESS_WAIT_POLL_DELAY     = 500;
export const FILECHOOSER_TIMEOUT          = 5000;

// ═══════════════════════════════════════════════════════════
// CLASS DEFINITION
// ═══════════════════════════════════════════════════════════

export class FlowPage {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
    this.page = null;

    // Single-project session state
    this._projectOpen = false;
    this._bgFilesOnCanvas = new Set();   // filenames already uploaded to canvas
    this._generatedNames = new Map();    // outputPath → picker display name

    // Model preference — set by orchestrator, applied in _setGenerationSettings
    this.preferredModel = 'Nano Banana Pro';

    // Network sniffer — captures generated images from network responses
    this._networkImages = [];    // captured image buffers during generation
    this._snifferActive = false; // whether we're currently listening
  }

  _cacheGeneratedName(filePath, pickerName) {
    if (!filePath || !pickerName) return;
    this._generatedNames.set(filePath, pickerName);
    this._generatedNames.set(basename(filePath), pickerName);
  }

  _getCachedGeneratedName(filePath) {
    if (!filePath) return null;
    return this._generatedNames.get(filePath) || this._generatedNames.get(basename(filePath)) || null;
  }

  _compactPromptForFlow(prompt, maxChars = 1800) {
    const text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxChars) return text;

    let compact = text.slice(0, maxChars);
    const sentenceEnd = Math.max(compact.lastIndexOf('. '), compact.lastIndexOf('; '), compact.lastIndexOf(', '));
    if (sentenceEnd > 900) compact = compact.slice(0, sentenceEnd + 1);
    compact = compact.trim();

    Logger.warn(`[Flow] Prompt compacted for composer reliability: ${text.length} -> ${compact.length} chars`);
    return compact;
  }

  /**
   * Start listening for image responses from Google's CDN.
   * Call before clicking Create — images are captured automatically.
   */
  _startNetworkSniffer() {
    this._networkImages = [];
    this._snifferActive = true;

    if (!this._snifferHandler) {
      this._snifferHandler = async (response) => {
        if (!this._snifferActive) return;
        try {
          const url = response.url();
          const contentType = response.headers()['content-type'] || '';

          // Capture ANY large image response (not just specific CDN domains)
          if (contentType.includes('image') &&
              !url.includes('favicon') && !url.includes('nav_logo') &&
              !url.includes('pinhole-about') && !url.includes('hero-grid')) {
            const body = await response.body();
            if (body.length > 50000) { // >50KB = real image, not thumbnail
              this._networkImages.push({
                url,
                buffer: body,
                size: body.length,
                timestamp: Date.now()
              });
              Logger.debug(`[Flow/Network] Captured image: ${Math.round(body.length / 1024)}KB from ${url.substring(0, 80)}`);
            }
          }
        } catch {} // Response may be already disposed
      };
    }

    this.page?.on('response', this._snifferHandler);
  }

  /**
   * Stop listening and return captured images.
   * @returns {Array} captured image buffers sorted newest first
   */
  _stopNetworkSniffer() {
    this._snifferActive = false;
    const images = [...this._networkImages].sort((a, b) => b.timestamp - a.timestamp);
    this._networkImages = [];
    return images;
  }

  // ═══════════════════════════════════════════════════════════
  // MAIN PUBLIC METHOD
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate one image and download it to outputPath.
   * @param {string} prompt
   * @param {string} backgroundFilePath — background image file on disk
   * @param {string[]} contextFilePaths — file paths of previous step images
   * @param {string} aspectRatio — LANDSCAPE|LANDSCAPE_4_3|SQUARE|PORTRAIT_3_4|PORTRAIT
   * @param {string} outputPath — where to save the downloaded image
   * @returns {boolean} true if image was saved
   */
  /**
   * @param {string} prompt
   * @param {string} backgroundFilePath
   * @param {string[]} contextFilePaths
   * @param {string} aspectRatio
   * @param {string} outputPath
   * @param {object} [opts] - Options
   * @param {boolean} [opts.skipSimilarityCheck] - Skip pixel similarity validation (for Pinterest pins where output SHOULD resemble the template)
   */
  async generate(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath, opts = {}) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        Logger.debug(`Flow generation attempt ${attempt}/${MAX_ATTEMPTS}`);
        await this._doGenerate(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath);

        // Validate: image file must exist and not be empty
        if (!existsSync(outputPath)) {
          Logger.warn(`Attempt ${attempt}: No image file created. Retrying...`);
          await this.closeSession();
          if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
          continue;
        }

        const outSize = statSync(outputPath).size;

        // Validate: file must be at least 5KB (not corrupted/empty)
        if (outSize < 5000) {
          Logger.warn(`Attempt ${attempt}: Image too small (${outSize} bytes), likely corrupted. Retrying...`);
          await this.closeSession();
          if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
          continue;
        }

        // Validate: pixel comparison with background — detect empty generation
        // SKIP for Pinterest pins: generated pin is SUPPOSED to look like the template
        if (!opts.skipSimilarityCheck && backgroundFilePath && existsSync(backgroundFilePath)) {
          const similarity = await this._compareImages(backgroundFilePath, outputPath);
          Logger.info(`[Flow] Pixel similarity to background: ${similarity}%`);
          if (similarity > 85) {
            Logger.warn(`Attempt ${attempt}: Generated image is ${similarity}% similar to background — empty! Retrying...`);
            await this.closeSession();
            if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
            continue;
          }
        }

        Logger.debug(`Image validated: ${(outSize / 1024).toFixed(0)}KB`);
        return true;
      } catch (err) {
        // Rate limit or account blocked = don't retry, bubble up immediately
        if (err instanceof FlowRateLimitError || err instanceof FlowAccountBlockedError) {
          Logger.warn(`[Flow] ${err.name} — stopping retries`);
          await this.closeSession();
          throw err;
        }

        Logger.error(`Flow attempt ${attempt} failed: ${err.message}`);
        await this._screenshot(`error-attempt${attempt}`);
        // Reset session on failure — next attempt starts with fresh project
        await this.closeSession();
        if (attempt < MAX_ATTEMPTS) {
          const retryDelay = RETRY_DELAY * attempt;
          Logger.info(`Waiting ${retryDelay / 1000}s before retry...`);
          await this._delay(retryDelay);
        }
      }
    }

    Logger.error(`All ${MAX_ATTEMPTS} Flow attempts failed for: ${prompt.substring(0, 80)}...`);
    return false;
  }

  /**
   * Generate using "Réutiliser le prompt" workflow.
   * Same API as generate(), but for images after the first one,
   * hovers on the previous generated image → "Réutiliser le prompt" →
   * clears unwanted refs → adds needed refs → changes prompt → creates.
   * Falls back to normal generate() if reuse isn't available.
   */
  async generateWithReuse(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        Logger.debug(`Flow reuse generation attempt ${attempt}/${MAX_ATTEMPTS}`);
        await this._doGenerateWithReuse(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath);

        if (!existsSync(outputPath)) {
          Logger.warn(`Attempt ${attempt}: No image file created. Retrying...`);
          await this.closeSession();
          if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
          continue;
        }

        const outSize = statSync(outputPath).size;
        if (outSize < 5000) {
          Logger.warn(`Attempt ${attempt}: Image too small (${outSize} bytes). Retrying...`);
          await this.closeSession();
          if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
          continue;
        }

        if (backgroundFilePath && existsSync(backgroundFilePath)) {
          const similarity = await this._compareImages(backgroundFilePath, outputPath);
          Logger.info(`[Flow] Pixel similarity to background: ${similarity}%`);
          if (similarity > 85) {
            Logger.warn(`Attempt ${attempt}: Generated image is ${similarity}% similar to background — empty! Retrying...`);
            await this.closeSession();
            if (attempt < MAX_ATTEMPTS) await this._delay(RETRY_DELAY);
            continue;
          }
        }

        Logger.debug(`Image validated: ${(outSize / 1024).toFixed(0)}KB`);
        return true;
      } catch (err) {
        // Rate limit = don't retry, bubble up for account rotation
        if (err instanceof FlowRateLimitError) {
          Logger.warn('[Flow] Rate limit hit during reuse — stopping retries, needs account rotation');
          await this.closeSession();
          throw err;
        }

        Logger.error(`Flow reuse attempt ${attempt} failed: ${err.message}`);
        await this._screenshot(`reuse-error-attempt${attempt}`);
        await this.closeSession();
        if (attempt < MAX_ATTEMPTS) {
          const retryDelay = RETRY_DELAY * attempt;
          Logger.info(`Waiting ${retryDelay / 1000}s before retry...`);
          await this._delay(retryDelay);
        }
      }
    }

    Logger.error(`All ${MAX_ATTEMPTS} reuse attempts failed for: ${prompt.substring(0, 80)}...`);
    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // CORE GENERATION FLOW
  // ═══════════════════════════════════════════════════════════

  async _doGenerate(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath) {
    const flowPrompt = this._compactPromptForFlow(prompt);

    // ─── Single-project approach ───
    // Reuse one project for all images in a recipe.
    // Background uploaded once, context images already on canvas from prior generations.
    // ~50% faster than creating a new project per image.

    // 1. Ensure project is open and background is on canvas.
    //    On a NEW project this also applies the Agent defaults (aspect/model/
    //    count/confirm) via the tune panel — the only place they live now.
    await this._ensureProject(backgroundFilePath, aspectRatio);

    // 2. Legacy classic settings (no-op on the new Agent-only Flow; kept as a
    //    fallback in case the inline model button ever returns).
    await this._setGenerationSettings(aspectRatio);

    // 2b. Clear any leftover refs from previous generation in this project
    //     Without this, refs accumulate across generations (e.g. Pinterest pins)
    //     and Flow may use stale refs instead of the intended ones.
    const refsCleared = await this._clearAllPromptRefs();
    if (!refsCleared) {
      Logger.warn('[Flow] Starting generation with leftover refs still present; output may use stale references');
    }

    // Keep the composer empty while attaching refs. Flow often refuses image
    // refs after text is already present; prompt text is appended after refs.
    await this._clearPromptText();

    // 3. Attach background as FIRST ref — this is critical for Pinterest templates
    //    where the prompt says "first uploaded reference image".
    //    Strategy: try picker first, but for short filenames (< 6 chars) skip picker
    //    entirely and paste via clipboard to avoid false matches.
    const bgName = basename(backgroundFilePath);
    const bgNameNoExt = bgName.split('.')[0];
    Logger.info(`[Flow] Attaching background from picker: ${bgName}`);
    let bgAttached = false;
    let promptRefsBeforeBg = await this._getPromptRefs();

    if (bgNameNoExt.length < 6) {
      // Short filenames (e.g. "1.jpg", "2.jpg") — fuzzy picker matching is unreliable.
      // The file is already on canvas from _ensureProject(), so try exact picker match first.
      // If that fails, paste via clipboard (which also uploads to canvas, but ensures correct ref).
      Logger.info(`[Flow] Short filename "${bgName}" — trying exact picker match`);
      bgAttached = await this._attachFromPicker(bgName);
      if (!bgAttached) {
        Logger.info(`[Flow] Picker failed for "${bgName}", pasting via clipboard`);
        bgAttached = await this._uploadFile(backgroundFilePath);
      }
    } else {
      bgAttached = await this._attachFromPicker(bgName);
      if (!bgAttached) {
        // Re-upload to canvas and try again (file may have been pushed off picker)
        Logger.warn(`[Flow] Background not found in picker, re-uploading: ${bgName}`);
        await this._uploadBgToCanvas(backgroundFilePath);
        bgAttached = await this._attachFromPicker(bgName);
        if (!bgAttached) {
          // Last resort: paste via clipboard directly into prompt
          Logger.warn(`[Flow] Picker still failed, pasting via clipboard: ${bgName}`);
          bgAttached = await this._uploadFile(backgroundFilePath);
        }
      }
    }
    bgAttached = await this._confirmPromptRefAttached(promptRefsBeforeBg.length, bgName, 'background');
    if (!bgAttached) {
      Logger.warn(`[Flow] Background click did not add a prompt ref, forcing clipboard/upload fallback: ${bgName}`);
      bgAttached = await this._uploadFile(backgroundFilePath);
      bgAttached = await this._confirmPromptRefAttached(promptRefsBeforeBg.length, bgName, 'background-fallback');
    }
    if (bgAttached) Logger.info(`[Flow] Background ref attached and verified: ${bgName}`);
    else Logger.warn(`[Flow] Background ref FAILED after verification: ${bgName}`);
    if (!bgAttached) {
      throw new Error(`Background reference failed to attach: ${bgName}`);
    }

    // 4. Attach context images from picker
    // All ref images must go through the picker — never clipboard paste into prompt.
    // For files we KNOW were never uploaded this session (not in _generatedNames),
    // skip the picker attempt entirely (3 scroll attempts × ~4s = wasted time) and
    // upload to canvas first. Picker auto-filters already-attached files anyway, so
    // an optimistic picker probe just times out.
    let contextAttachedCount = 0;
    let contextRequestedCount = 0;
    for (const ctxPath of contextFilePaths) {
      if (!existsSync(ctxPath)) continue;
      contextRequestedCount++;
      const ctxName = basename(ctxPath);
      const cachedName = this._getCachedGeneratedName(ctxPath);
      let ctxAttached = false;
      const refsBeforeCtx = await this._getPromptRefs();

      if (cachedName) {
        // Known to be on canvas in this session — try picker first
        Logger.info(`[Flow] Attaching context from picker: ${cachedName}`);
        ctxAttached = await this._attachFromPicker(cachedName);
      } else {
        // Never uploaded this session — go straight to upload+attach (avoid the
        // ~12s picker-then-scroll-then-fail dance for files that aren't there)
        Logger.info(`[Flow] Context not in session cache, uploading to canvas: ${ctxName}`);
        await this._uploadBgToCanvas(ctxPath);
        ctxAttached = await this._attachFromPicker(ctxName);
        if (ctxAttached) this._cacheGeneratedName(ctxPath, ctxName);
      }

      let ctxVerified = ctxAttached
        ? await this._confirmPromptRefAttached(refsBeforeCtx.length, cachedName || ctxName, 'context')
        : false;

      if (!ctxVerified && cachedName && cachedName !== ctxName) {
        Logger.warn(`[Flow] Cached picker click did not add prompt ref, trying basename: ${ctxName}`);
        ctxAttached = await this._attachFromPicker(ctxName);
        ctxVerified = ctxAttached
          ? await this._confirmPromptRefAttached(refsBeforeCtx.length, ctxName, 'context-basename')
          : false;
      }

      if (!ctxVerified) {
        // Last resort: paste via clipboard
        Logger.warn(`[Flow] Picker failed for context, pasting via clipboard: ${ctxName}`);
        ctxAttached = await this._uploadFile(ctxPath);
        ctxVerified = ctxAttached
          ? await this._confirmPromptRefAttached(refsBeforeCtx.length, ctxName, 'context-fallback')
          : false;
        if (ctxVerified) this._cacheGeneratedName(ctxPath, ctxName);
      }

      if (ctxVerified) contextAttachedCount++;
      else Logger.warn(`[Flow] Context ref FAILED: ${ctxName}`);
    }
    Logger.info(`[Flow] Reference attach summary: background=${bgAttached ? 'ok' : 'failed'}, context=${contextAttachedCount}/${contextRequestedCount}`);

    await this._insertPromptTextPreservingRefs(flowPrompt);

    // 6. Snapshot SRCs AFTER all uploads (background + context) so that
    //    uploaded reference images are in the "before" set and won't be
    //    mistaken for the newly generated image during download.
    const srcsBeforeGen = new Set(await this._getAllImgSrcs());

    // 7. Type prompt — verify it was actually typed
    await this._assertPromptReady(1 + contextRequestedCount, 10, 'pre-create');

    // 8. Screenshot before Create (debug)
    await this._screenshot('pre-create');

    // 9. Start network sniffer before Create
    this._startNetworkSniffer();

    // 10. Click Create
    await this._clickCreate();

    // 11. Wait for generation using % progress indicator
    await this._waitForGenerationProgress();

    // 12. Screenshot after generation (debug)
    await this._screenshot('post-generate');

    // 13. Wait for image to render + stop sniffer
    await this._delay(3000);
    const capturedImages = this._stopNetworkSniffer();

    // Log sniffer results
    const debugSrcs = (await this._getAllImgSrcs()).filter(s => !srcsBeforeGen.has(s));
    Logger.info(`[Flow/Network] Sniffer captured ${capturedImages.length} images, DOM found ${debugSrcs.length} new srcs`);

    // 14. Download — Strategy 0: Network sniffer (most reliable)
    if (capturedImages.length > 0) {
      const newest = capturedImages[0]; // sorted newest first
      try {
        mkdirSync(dirname(outputPath), { recursive: true });
      } catch {}
      try {
        writeFileSync(outputPath, newest.buffer);
      } catch (e) {
        Logger.debug(`[Flow] Sniffer writeFileSync error (may still have written): ${e.message}`);
      }
      // Check if file was actually written (Windows sometimes throws but succeeds)
      if (existsSync(outputPath) && statSync(outputPath).size > 5000) {
        Logger.info(`[Flow] Image captured via network sniffer: ${Math.round(statSync(outputPath).size / 1024)}KB`);
        try {
          const newName = await this._getNewestPickerName();
          if (newName) {
            this._cacheGeneratedName(outputPath, newName);
            Logger.info(`[Flow] Stored picker name: "${newName}" for ${basename(outputPath)}`);
          }
        } catch {}
        return true;
      }
      Logger.warn(`[Flow] Network sniffer: file not saved properly — falling back to DOM`);
    }

    // 15. Download the generated image — find the new SRC that appeared (DOM fallback)
    const srcsAfterGen = await this._getAllImgSrcs();
    const newSrcs = srcsAfterGen.filter(s => !srcsBeforeGen.has(s));

    let downloaded = false;

    // Strategy 1: Download by new SRC (most reliable in single-project mode)
    if (newSrcs.length > 0) {
      try {
        await this._downloadBySrc(outputPath, newSrcs);
        downloaded = true;
        Logger.info(`[Flow] Image downloaded via new SRC (${newSrcs.length} new)`);
      } catch (e) {
        Logger.debug('New SRC download failed:', e.message);
      }
    }

    // Strategy 1.5: Last image element screenshot (when src comparison fails)
    if (!downloaded) {
      try {
        const lastImgData = await this.page.evaluate(() => {
          const imgs = Array.from(document.querySelectorAll('img'))
            .filter(i => i.naturalWidth > 200 && i.naturalHeight > 200 && !i.src.includes('data:'));
          if (imgs.length === 0) return null;
          const last = imgs[imgs.length - 1];
          // Try canvas approach on the last (newest) image
          try {
            const canvas = document.createElement('canvas');
            canvas.width = last.naturalWidth;
            canvas.height = last.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(last, 0, 0);
            return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
          } catch { return null; }
        });
        if (lastImgData) {
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, Buffer.from(lastImgData, 'base64'));
          if (statSync(outputPath).size > 5000) {
            downloaded = true;
            Logger.info('[Flow] Image captured via last-element canvas screenshot');
          }
        }
      } catch (e) {
        Logger.debug('Last element screenshot failed:', e.message);
      }
    }

    // Strategy 2: Généré filter fallback
    if (!downloaded) {
      try {
        const filterApplied = await this._applyGenereFilter();
        if (filterApplied) {
          await this._downloadFilteredImage(outputPath);
          downloaded = true;
          Logger.info('[Flow] Image picked via Généré filter');
        }
      } catch (e) {
        Logger.debug('Filter strategy failed:', e.message);
      } finally {
        await this._removeGenereFilter();
      }
    }

    // Strategy 3: Largest visible image fallback
    if (!downloaded) {
      try {
        await this._downloadImage(outputPath, [...srcsBeforeGen]);
        downloaded = true;
        Logger.debug('Image picked via before/after snapshot');
      } catch (e) {
        Logger.debug('Snapshot strategy failed:', e.message);
      }
    }

    if (!downloaded) throw new Error('Failed to download generated image');

    // 13. Learn the picker name of the new image (for future context attachment)
    try {
      const newName = await this._getNewestPickerName();
      if (newName) {
        this._cacheGeneratedName(outputPath, newName);
        Logger.info(`[Flow] Stored picker name: "${newName}" for ${basename(outputPath)}`);
      }
    } catch (e) {
      Logger.debug('Could not get picker name:', e.message);
    }

    // NOTE: Do NOT close the page — reuse for next generation
    Logger.success('Image generated and saved');
  }

  // ═══════════════════════════════════════════════════════════
  // REUSE-BASED GENERATION FLOW
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate using "Réutiliser le prompt" workflow (faster for subsequent images).
   *
   * Flow:
   * 1. Ensure project open, background on canvas
   * 2. If first image: normal flow (attach bg + context + type prompt + create)
   * 3. If subsequent: hover last generated → "Réutiliser le prompt" →
   *    remove unwanted refs → add new refs → change prompt → create
   *
   * Falls back to normal _doGenerate if reuse fails.
   */
  async _doGenerateWithReuse(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath) {
    // 1. Ensure project is open and background is on canvas (+ Agent defaults on new project)
    await this._ensureProject(backgroundFilePath, aspectRatio);

    // 2. Set generation settings
    await this._setGenerationSettings(aspectRatio);

    // 3. Check if we can use reuse workflow (need a previous generation in session)
    const hasPreviousGeneration = this._generatedNames.size > 0;

    if (hasPreviousGeneration) {
      Logger.info('[Flow] Attempting reuse workflow...');

      // 3a. Snapshot SRCs before
      const srcsBeforeGen = new Set(await this._getAllImgSrcs());

      // 3b. Hover on last generated image → "Réutiliser le prompt"
      const reused = await this._reusePrompt();

      if (reused) {
        // 3c. Debug: show what was loaded
        await this._debugPromptState();

        // 3d. Clear all existing refs (we'll add exactly what we need)
        const refsCleared = await this._clearAllPromptRefs();
        if (!refsCleared) {
          Logger.warn('[Flow] Reuse started with leftover refs still present after cleanup');
        }
        await this._delay(300);

        // 3e. Attach background from picker
        const bgName = basename(backgroundFilePath);
        Logger.info(`[Flow] Attaching background: ${bgName}`);
        const refsBeforeBg = await this._getPromptRefs();
        let bgAttached = await this._attachFromPicker(bgName);
        bgAttached = bgAttached
          ? await this._confirmPromptRefAttached(refsBeforeBg.length, bgName, 'reuse-background')
          : false;
        if (!bgAttached) {
          Logger.warn(`[Flow] Reuse background picker failed, forcing clipboard/upload fallback: ${bgName}`);
          bgAttached = await this._uploadFile(backgroundFilePath);
          bgAttached = bgAttached
            ? await this._confirmPromptRefAttached(refsBeforeBg.length, bgName, 'reuse-background-fallback')
            : false;
        }
        if (bgAttached) Logger.info(`[Flow] Reuse background ref attached and verified: ${bgName}`);
        else Logger.warn(`[Flow] Reuse background ref FAILED after verification: ${bgName}`);
        if (!bgAttached) {
          throw new Error(`Reuse background reference failed to attach: ${bgName}`);
        }

        // 3f. Attach context images — skip picker for files we know aren't uploaded
        // yet (avoids the wasted ~12s picker-then-scroll-then-fail per unknown file).
        let contextAttachedCount = 0;
        let contextRequestedCount = 0;
        for (const ctxPath of contextFilePaths) {
          if (!existsSync(ctxPath)) continue;
          contextRequestedCount++;
          const ctxName = basename(ctxPath);
          const cachedName = this._getCachedGeneratedName(ctxPath);
          let ok = false;
          const refsBeforeCtx = await this._getPromptRefs();

          if (cachedName) {
            Logger.info(`[Flow] Attaching context: ${cachedName}`);
            ok = await this._attachFromPicker(cachedName);
          } else {
            Logger.info(`[Flow] Context not in session cache, uploading: ${ctxName}`);
            await this._uploadBgToCanvas(ctxPath);
            ok = await this._attachFromPicker(ctxName);
            if (ok) this._cacheGeneratedName(ctxPath, ctxName);
          }

          let ctxVerified = ok
            ? await this._confirmPromptRefAttached(refsBeforeCtx.length, cachedName || ctxName, 'reuse-context')
            : false;

          if (!ctxVerified && cachedName && cachedName !== ctxName) {
            Logger.warn(`[Flow] Reuse cached picker click did not add prompt ref, trying basename: ${ctxName}`);
            ok = await this._attachFromPicker(ctxName);
            ctxVerified = ok
              ? await this._confirmPromptRefAttached(refsBeforeCtx.length, ctxName, 'reuse-context-basename')
              : false;
          }

          if (!ctxVerified) {
            Logger.warn(`[Flow] Reuse picker failed for context, pasting via clipboard: ${ctxName}`);
            ok = await this._uploadFile(ctxPath);
            ctxVerified = ok
              ? await this._confirmPromptRefAttached(refsBeforeCtx.length, ctxName, 'reuse-context-fallback')
              : false;
            if (ctxVerified) this._cacheGeneratedName(ctxPath, ctxName);
          }

          if (ctxVerified) contextAttachedCount++;
          else Logger.warn(`[Flow] Reuse context ref FAILED: ${ctxName}`);
        }
        Logger.info(`[Flow] Reuse reference attach summary: background=${bgAttached ? 'ok' : 'failed'}, context=${contextAttachedCount}/${contextRequestedCount}`);

        // 3g. Replace prompt text
        await this._typePrompt(prompt);

        // 3h. Verify prompt
        const promptVerified = await this.page.evaluate((css) => {
          const el = document.querySelector(css);
          return el ? (el.textContent || '').trim().length : 0;
        }, PROMPT_INPUT_CSS);
        Logger.info(`[Flow] Prompt length: ${promptVerified} chars`);
        if (promptVerified < 10) {
          Logger.warn('[Flow] Prompt may not have been typed correctly, retrying...');
          await this._typePrompt(prompt);
        }

        // 3i. Debug before create
        await this._screenshot('reuse-pre-create');
        await this._debugPromptState();

        // 3j. Click Create
        await this._clickCreate();

        // 3k. Wait for generation
        await this._waitForGenerationProgress();
        await this._screenshot('reuse-post-generate');

        // 3l. Download
        const srcsAfterGen = await this._getAllImgSrcs();
        const newSrcs = srcsAfterGen.filter(s => !srcsBeforeGen.has(s));
        let downloaded = false;

        if (newSrcs.length > 0) {
          try {
            await this._downloadBySrc(outputPath, newSrcs);
            downloaded = true;
            Logger.info(`[Flow] Reuse: downloaded via new SRC (${newSrcs.length} new)`);
          } catch (e) {
            Logger.debug('New SRC download failed:', e.message);
          }
        }
        if (!downloaded) {
          try {
            const filterApplied = await this._applyGenereFilter();
            if (filterApplied) {
              await this._downloadFilteredImage(outputPath);
              downloaded = true;
            }
          } catch (e) {
            Logger.debug('Filter strategy failed:', e.message);
          } finally {
            await this._removeGenereFilter();
          }
        }
        if (!downloaded) {
          try {
            await this._downloadImage(outputPath, [...srcsBeforeGen]);
            downloaded = true;
          } catch (e) {
            Logger.debug('Snapshot strategy failed:', e.message);
          }
        }
        if (!downloaded) throw new Error('Failed to download generated image (reuse)');

        // 3m. Learn picker name
        try {
          const newName = await this._getNewestPickerName();
          if (newName) {
            this._cacheGeneratedName(outputPath, newName);
            Logger.info(`[Flow] Stored picker name: "${newName}" for ${basename(outputPath)}`);
          }
        } catch (e) {
          Logger.debug('Could not get picker name:', e.message);
        }

        Logger.success('Image generated via reuse workflow');
        return;
      }

      Logger.warn('[Flow] Reuse failed, falling back to normal flow');
    }

    // 4. Fallback: normal generation flow
    await this._doGenerate(prompt, backgroundFilePath, contextFilePaths, aspectRatio, outputPath);
  }

  // ═══════════════════════════════════════════════════════════
  // SINGLE-PROJECT SESSION MANAGEMENT
  // ═══════════════════════════════════════════════════════════

  /**
   * Ensure a Flow project is open with the background uploaded to canvas.
   * Creates a new project only on first call; subsequent calls reuse the same project.
   * If the background file changes, uploads the new one to the existing canvas.
   */
  async _ensureProject(backgroundFilePath, aspectRatio) {
    const bgName = basename(backgroundFilePath);

    // Check if project is still alive
    if (this._projectOpen && this.page) {
      try {
        await this.page.evaluate(() => document.title);
      } catch {
        Logger.warn('[Flow] Project page died, resetting session');
        this._projectOpen = false;
        this._bgFilesOnCanvas.clear();
        this._generatedNames.clear();
      }
    }

    if (!this._projectOpen || !this.page) {
      // Open new project
      await this._closePage();
      this.page = await this.context.newPage();
      await this.page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
      await this._delay(PAGE_LOAD_DELAY);

      await this._clickIfExists('create with flow', 'créer avec flow');
      await this._delay(LANDING_PAGE_DELAY);

      await this._clickIfExists('nouveau projet', 'new project');
      await this._delay(NEW_PROJECT_DELAY);

      await this._waitForPromptInput();

      this._projectOpen = true;
      this._bgFilesOnCanvas.clear();
      this._generatedNames.clear();
      Logger.info('[Flow] New project created');

      // Agent mode burns credits AND has no inline model/aspect controls. Turn
      // it OFF (classic / direct image mode), once per project. That restores the
      // inline "Nano Banana Pro · aspect · 1x" settings button, which
      // _setGenerationSettings (called next in _doGenerate) then configures.
      await this._deselectAgent();
    }

    // Upload background to canvas if not already there
    if (!this._bgFilesOnCanvas.has(bgName)) {
      Logger.info(`[Flow] Uploading background to canvas: ${bgName}`);
      await this._uploadBgToCanvas(backgroundFilePath);
      this._bgFilesOnCanvas.add(bgName);
    }
  }

  /**
   * Deselect the "Agent" mode pill in the bottom composer so generations use the
   * classic / direct image path (NO agent credit usage). The pill is a <button>
   * whose trimmed text is exactly "Agent" with aria-pressed; pressed="true" = ON.
   * Target by text + aria-pressed, NEVER by class (styled-component hashes like
   * `sc-59223abb-3 bdRbOx`/`dmZGYv` change per build). Idempotent — no-op if off.
   * When OFF, the inline "Nano Banana Pro · aspect · 1x" settings pill appears
   * (configured by _setGenerationSettings) and the agent `tune`/instructions
   * buttons disappear.
   */
  async _deselectAgent() {
    const findPill = () => this.page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === 'Agent');
      if (!b) return { found: false };
      const r = b.getBoundingClientRect();
      if (r.width === 0) return { found: false };
      return { found: true, pressed: b.getAttribute('aria-pressed'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    try {
      // The composer (and its Agent pill) can render a moment AFTER the prompt
      // input appears, and the right-side Agent assistant zone may briefly cover
      // it. Poll for the pill; if it doesn't show, try closing that zone, then
      // poll again.
      let pos = { found: false };
      for (let i = 0; i < 12; i++) {
        pos = await findPill();
        if (pos.found) break;
        if (i === 5) {
          // Halfway: try closing the right Agent assistant zone (X "close" icon, top-right)
          await this.page.evaluate(() => {
            const x = [...document.querySelectorAll('button')].find(b => {
              const ic = (b.querySelector('i')?.textContent || '').trim();
              const r = b.getBoundingClientRect();
              return ic === 'close' && r.width > 0 && r.x > window.innerWidth * 0.6 && r.y < 200;
            });
            if (x) x.click();
          }).catch(() => {});
        }
        await this._delay(800);
      }
      if (!pos.found) { Logger.warn('[Flow] Agent pill not found after polling — cannot confirm classic mode'); return; }
      if (pos.pressed === 'false') { Logger.info('[Flow] Agent already OFF (classic image mode)'); return; }
      await this.page.mouse.click(pos.x, pos.y);
      await this._delay(1200);
      const after = await findPill();
      if (after.found && after.pressed === 'false') Logger.info('[Flow] Agent mode deselected → classic image mode (no agent credits)');
      else Logger.warn(`[Flow] Clicked Agent pill but state=${after.pressed} (expected false)`);
    } catch (e) {
      Logger.warn(`[Flow] _deselectAgent failed: ${e.message}`);
    }
  }

  /**
   * Apply the Agent generation defaults for the NEW Flow UI (Agent-only).
   * These live in the agent settings panel (the `tune` icon on the chat input)
   * and are PER-PROJECT, resetting to 16:9 / x2 / Nano Banana 2 / confirm=Always
   * on each new project. We set: Confirm=Never, aspect (mapped), 1x, Nano Banana Pro.
   * All controls are Radix with dynamic ids → target by visible text/role.
   * The IMAGE section renders before the VIDEO section, so `.first()` = image.
   */
  async _applyAgentDefaults(aspectRatio) {
    const ASPECT_LABEL = {
      LANDSCAPE: '16:9', LANDSCAPE_4_3: '4:3', SQUARE: '1:1',
      PORTRAIT_3_4: '3:4', PORTRAIT: '9:16',
    };
    const label = ASPECT_LABEL[aspectRatio] || '9:16';
    try {
      const tunePos = await this.page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(b => (b.querySelector('i')?.textContent || '').trim() === 'tune');
        if (!b) return null; const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      });
      if (!tunePos) { Logger.warn('[Flow] Agent settings (tune) button not found — defaults not applied'); return; }
      await this.page.mouse.click(tunePos.x, tunePos.y);
      await this._delay(2000);
      const open = await this.page.evaluate(() => /Confirmer avant de générer/i.test(document.body.innerText));
      if (!open) { Logger.warn('[Flow] Agent settings panel did not open — defaults not applied'); await this.page.keyboard.press('Escape').catch(() => {}); return; }

      // Confirm before generating = Never (so the agent generates without pausing)
      try { await this.page.getByText('Jamais', { exact: true }).first().click({ timeout: 3000 }); } catch {}
      // Image aspect ratio (image section is first in the panel)
      try { await this.page.getByText(label, { exact: false }).first().click({ timeout: 3000 }); } catch (e) { Logger.debug(`[Flow] aspect ${label} not clicked: ${e.message}`); }
      // Image count = 1x (one image per prompt)
      try { await this.page.getByText('1x', { exact: true }).first().click({ timeout: 3000 }); } catch {}
      // Model = this.preferredModel (NOT hardcoded): the orchestrator may have
      // fallen back to "Nano Banana 2" after Pro failed — forcing Pro here would
      // undo that fallback on every retry's fresh project.
      const model = this.preferredModel || 'Nano Banana Pro';
      const modelRx = /nano banana 2/i.test(model) ? /Nano Banana 2/i : /Nano Banana Pro/i;
      try {
        await this.page.getByText(/Nano Banana 2|Nano Banana Pro/i).first().click({ timeout: 3000 }); // open menu
        await this._delay(900);
        await this.page.getByText(modelRx).last().click({ timeout: 3000 });
      } catch (e) { Logger.debug(`[Flow] model select skipped: ${e.message}`); }
      // Save
      try { await this.page.getByRole('button', { name: /Enregistrer/i }).first().click({ timeout: 3000 }); } catch {}
      await this._delay(1200);
      Logger.info(`[Flow] Agent defaults applied: Never, ${label}, 1x, ${model}`);
    } catch (e) {
      Logger.warn(`[Flow] _applyAgentDefaults failed: ${e.message}`);
      try { await this.page.keyboard.press('Escape'); } catch {}
    }
  }

  /**
   * Upload a background image to the canvas via top "+" → "Importer une image".
   * Does NOT attach to prompt — that's done separately via picker.
   */
  async _uploadBgToCanvas(filePath) {
    // Click top "add" icon button via native mouse (Radix needs real events)
    const addPos = await this.page.evaluate(() => {
      const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
      for (const icon of icons) {
        if (icon.textContent.trim() === 'add') {
          const btn = icon.closest('button');
          if (btn && btn.getBoundingClientRect().width > 0) {
            const r = btn.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }
      return null;
    });

    if (!addPos) throw new Error('Top add button not found');
    await this.page.mouse.click(addPos.x, addPos.y);
    await this._delay(800);

    // Click "Importer une image" + handle file chooser
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
      this.page.evaluate(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          if ((item.textContent || '').toLowerCase().includes('importer')) { item.click(); return; }
        }
      })
    ]);

    if (fileChooser) {
      await fileChooser.setFiles(filePath);
    } else {
      const input = await this.page.$('input[type="file"]');
      if (input) await input.setInputFiles(filePath);
      else throw new Error('No file chooser for background upload');
    }

    // Wait for upload to complete (% indicator disappears)
    await this._delay(2000);
    const start = Date.now();
    while (Date.now() - start < UPLOAD_PROGRESS_TIMEOUT) {
      const hasPercent = await this.page.evaluate(() => {
        const divs = document.querySelectorAll('div');
        for (const div of divs) {
          if (div.children.length === 0 && /^\d+%$/.test(div.textContent.trim())) return true;
        }
        return false;
      });
      if (!hasPercent) break;
      await this._delay(500);
    }
    await this._delay(POST_UPLOAD_FILE_DELAY);
    Logger.info(`[Flow] Background uploaded to canvas: ${basename(filePath)}`);
  }

  /**
   * Attach an image from the picker dialog by its display name.
   * Opens picker (add_2), finds image by alt text or label, clicks it.
   * Picker auto-closes after clicking an image.
   */
  async _attachFromPicker(imageName) {
    // Open picker via add_2 button (native mouse for Radix)
    const pickerPos = await this._findPickerButton();
    if (!pickerPos) {
      Logger.warn('[Flow] Picker button (add_2) not found');
      return false;
    }
    await this.page.mouse.click(pickerPos.x, pickerPos.y);
    await this._delay(1000);

    // Try to find and click the image — with scrolling to reveal off-screen images
    const nameToFind = imageName.toLowerCase();
    const nameNoExt = nameToFind.split('.')[0]; // hash or slug without extension

    for (let scrollAttempt = 0; scrollAttempt < 4; scrollAttempt++) {
      const clicked = await this.page.evaluate(({ nameToFind, nameNoExt }) => {
        const dialog = document.querySelector('dialog, [role="dialog"]');
        if (!dialog) return null;

        const imgs = dialog.querySelectorAll('img');

        // Method 1: Exact match by img alt text
        for (const img of imgs) {
          const alt = (img.alt || '').toLowerCase().trim();
          if (alt && alt === nameToFind) {
            const container = img.closest('[cursor]') || img.parentElement;
            if (container) { container.click(); return 'alt-equals'; }
          }
        }

        // Method 1b: Contained filename in img alt text
        for (const img of imgs) {
          const alt = (img.alt || '').toLowerCase();
          if (alt && alt.includes(nameToFind)) {
            const container = img.closest('[cursor]') || img.parentElement;
            if (container) { container.click(); return 'alt-contains'; }
          }
        }

        // Method 2: Match by filename without extension (handles truncated names)
        for (const img of imgs) {
          const alt = (img.alt || '').toLowerCase();
          if (alt && nameNoExt.length > 6 && alt.includes(nameNoExt)) {
            const container = img.closest('[cursor]') || img.parentElement;
            if (container) { container.click(); return 'alt-noext'; }
          }
        }

        // Method 3: Match by first 10+ chars of filename (handles Flow truncation)
        const prefix = nameNoExt.substring(0, Math.min(12, nameNoExt.length));
        if (prefix.length >= 6) {
          for (const img of imgs) {
            const alt = (img.alt || '').toLowerCase();
            if (alt && alt.includes(prefix)) {
              const container = img.closest('[cursor]') || img.parentElement;
              if (container) { container.click(); return 'alt-prefix'; }
            }
          }
        }

        // Method 4: Match by text label near images
        const divs = dialog.querySelectorAll('div');
        for (const div of divs) {
          const text = (div.textContent || '').toLowerCase().trim();
          if (text && (text.includes(nameToFind) || (nameNoExt.length > 6 && text.includes(nameNoExt))) && div.children.length <= 1) {
            const clickable = div.closest('[cursor]') || div.parentElement;
            if (clickable) { clickable.click(); return 'label'; }
          }
        }

        // Method 5: Partial match on alt
        for (const img of imgs) {
          const alt = (img.alt || '').toLowerCase();
          if (alt && alt.length > 3 && (alt.includes(nameNoExt) || nameToFind.includes(alt.split(' ')[0]))) {
            const container = img.closest('[cursor]') || img.parentElement;
            if (container) { container.click(); return 'partial'; }
          }
        }

        return null;
      }, { nameToFind, nameNoExt });

      if (clicked) {
        Logger.debug(`[Flow] Picker: attached "${imageName}" via ${clicked} (scroll ${scrollAttempt})`);
        await this._delay(500);
        return true;
      }

      // Not found yet — scroll down inside the picker dialog to reveal more images
      if (scrollAttempt < 3) {
        Logger.debug(`[Flow] Picker: "${imageName}" not visible, scrolling... (attempt ${scrollAttempt + 1})`);
        await this.page.evaluate(() => {
          const dialog = document.querySelector('dialog, [role="dialog"]');
          if (!dialog) return;
          // Find the scrollable container inside dialog
          const scrollables = dialog.querySelectorAll('div');
          for (const div of scrollables) {
            if (div.scrollHeight > div.clientHeight + 10) {
              div.scrollBy(0, 300);
              return;
            }
          }
          // Fallback: scroll the dialog itself
          dialog.scrollBy(0, 300);
        });
        await this._delay(600);
      }
    }

    // Close picker if nothing found after scrolling
    Logger.warn(`[Flow] Picker: "${imageName}" not found after scrolling, closing`);
    await this.page.keyboard.press('Escape').catch(() => {});
    await this._delay(300);
    return false;
  }

  /** Find the add_2 picker button position */
  async _findPickerButton() {
    return await this.page.evaluate(() => {
      const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
      for (const icon of icons) {
        if (icon.textContent.trim() === 'add_2') {
          const btn = icon.closest('button');
          if (btn && btn.getBoundingClientRect().width > 0) {
            const r = btn.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
      }
      return null;
    });
  }

  /**
   * After generation, open picker briefly to read the newest image's display name.
   * Returns the name or null.
   */
  async _getNewestPickerName() {
    // Open picker
    const pickerPos = await this._findPickerButton();
    if (!pickerPos) return null;
    await this.page.mouse.click(pickerPos.x, pickerPos.y);
    await this._delay(1000);

    // Read the first non-background image name from the picker dialog
    const bgNames = [...this._bgFilesOnCanvas].map(n => n.toLowerCase());
    const knownGenNames = [...this._generatedNames.values()].map(n => n.toLowerCase());
    const newestName = await this.page.evaluate(({ bgNames, knownGenNames }) => {
      // Search inside picker dialog only (not the main grid)
      const dialog = document.querySelector('dialog, [role="dialog"]');
      const root = dialog || document;
      const imgs = root.querySelectorAll('img[alt]');
      for (const img of imgs) {
        const alt = (img.alt || '').trim();
        if (!alt) continue;
        const altLower = alt.toLowerCase();
        // Skip UI images
        if (altLower.includes('aperçu') || altLower.includes('preview') ||
            altLower.includes('profil') || altLower.includes('recherche') ||
            altLower.includes('fleur') || altLower.includes('discord') ||
            altLower.includes('twitter') || altLower === 'image générée') continue;
        // Skip backgrounds
        if (bgNames.includes(altLower)) continue;
        // Skip already-known generated names (we want the newest one)
        if (knownGenNames.includes(altLower)) continue;
        // First remaining = newest generated
        return alt;
      }
      // Fallback: look for text labels near images in dialog
      if (dialog) {
        const divs = dialog.querySelectorAll('div');
        for (const div of divs) {
          const text = (div.textContent || '').trim();
          if (!text || text.length < 3 || text.length > 100) continue;
          const textLower = text.toLowerCase();
          if (bgNames.includes(textLower)) continue;
          if (knownGenNames.includes(textLower)) continue;
          if (textLower.includes('importer') || textLower.includes('recherche') ||
              textLower.includes('récents') || textLower.includes('arrow_drop')) continue;
          // Check if this div is next to an image (likely a label)
          const parent = div.parentElement;
          if (parent && parent.querySelector('img')) return text;
        }
      }
      return null;
    }, { bgNames, knownGenNames });

    // Close picker
    await this.page.keyboard.press('Escape').catch(() => {});
    await this._delay(300);

    return newestName;
  }

  // ═══════════════════════════════════════════════════════════
  // REUSE PROMPT WORKFLOW
  // ═══════════════════════════════════════════════════════════

  /**
   * Hover on the last generated image on canvas, click "Réutiliser le prompt".
   * This pre-fills the prompt area with refs + text from that generation.
   * Returns true if successful, false if button not found.
   */
  async _reusePrompt() {
    // Find the most recent generated image on the canvas.
    // Generated images sit in the main canvas area (not in picker/dialog).
    // We look for large visible images, excluding backgrounds and UI elements.
    const imgPos = await this.page.evaluate((bgNames) => {
      // Find all visible images on the canvas (large enough to be generated)
      const imgs = [...document.querySelectorAll('img')];
      const candidates = [];
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        // Skip tiny images (icons, avatars) and offscreen ones
        if (r.width < 100 || r.height < 100 || r.x < 0 || r.y < 0) continue;
        // Skip images inside dialogs/pickers
        if (img.closest('dialog') || img.closest('[role="dialog"]')) continue;
        // Skip prompt area thumbnails (they're small, usually < 200px)
        const promptBox = document.querySelector('div[contenteditable="true"]');
        if (promptBox && promptBox.contains(img)) continue;
        // Skip background images by alt text
        const alt = (img.alt || '').toLowerCase();
        if (bgNames.some(bg => alt.includes(bg))) continue;
        // Skip known UI images
        if (alt.includes('aperçu') || alt.includes('preview') || alt.includes('profil') ||
            alt.includes('avatar') || alt.includes('logo')) continue;
        candidates.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, alt });
      }
      if (candidates.length === 0) return null;
      // Pick the largest one (most likely the latest generated image on canvas)
      candidates.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      return candidates[0];
    }, [...this._bgFilesOnCanvas].map(n => n.toLowerCase().replace(/\.[^.]+$/, '')));

    if (!imgPos) {
      Logger.warn('[Flow] No generated image found on canvas for reuse');
      return false;
    }
    Logger.debug(`[Flow] Hovering on canvas image at (${imgPos.x.toFixed(0)}, ${imgPos.y.toFixed(0)}) ${imgPos.w.toFixed(0)}×${imgPos.h.toFixed(0)}`);

    // Hover to reveal action buttons
    await this.page.mouse.move(imgPos.x, imgPos.y);
    await this._delay(800);

    // Look for "Réutiliser le prompt" button in the overlay
    const reuseClicked = await this.page.evaluate(() => {
      // Strategy 1: Button with text "Réutiliser le prompt" or "Reuse prompt"
      const btns = document.querySelectorAll('button, [role="button"], [role="menuitem"]');
      for (const btn of btns) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (t.includes('réutiliser') || t.includes('reuse') || t.includes('reutiliser')) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            btn.click();
            return { method: 'text', label: t };
          }
        }
      }
      // Strategy 2: Look for icon-based button (e.g., "refresh" or "replay" icon near the image)
      const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
      for (const icon of icons) {
        const iconText = icon.textContent.trim();
        if (iconText === 'refresh' || iconText === 'replay' || iconText === 'content_copy' || iconText === 'redo') {
          const btn = icon.closest('button');
          if (btn) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.y > 200) { // y > 200 to avoid toolbar buttons
              btn.click();
              return { method: 'icon', icon: iconText };
            }
          }
        }
      }
      // Strategy 3: Tooltip-based — look for elements with title/aria-label containing "réutiliser"
      const allEls = document.querySelectorAll('[title], [aria-label]');
      for (const el of allEls) {
        const title = ((el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
        if (title.includes('réutiliser') || title.includes('reuse') || title.includes('reutiliser')) {
          el.click();
          return { method: 'title', label: title.trim() };
        }
      }
      return null;
    });

    if (reuseClicked) {
      Logger.info(`[Flow] "Réutiliser le prompt" clicked via ${reuseClicked.method}: ${reuseClicked.label || reuseClicked.icon}`);
      await this._delay(1500); // Wait for prompt area to populate
      return true;
    }

    // If click didn't work via evaluate, try right-click context menu
    Logger.debug('[Flow] Trying right-click context menu...');
    await this.page.mouse.click(imgPos.x, imgPos.y, { button: 'right' });
    await this._delay(800);

    const contextClicked = await this.page.evaluate(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        const t = (item.textContent || '').toLowerCase();
        if (t.includes('réutiliser') || t.includes('reuse') || t.includes('reutiliser')) {
          item.click();
          return true;
        }
      }
      return false;
    });

    if (contextClicked) {
      Logger.info('[Flow] "Réutiliser le prompt" clicked via context menu');
      await this._delay(1500);
      return true;
    }

    // Close any open menu
    await this.page.keyboard.press('Escape').catch(() => {});
    Logger.warn('[Flow] "Réutiliser le prompt" button not found');
    return false;
  }

  /**
   * Count reference thumbnails currently in the prompt area.
   * Returns array of { index, alt, x, y, width, height } for each ref.
   */
  async _getPromptRefs() {
    return await this.page.evaluate(() => {
      // Prompt refs are small thumbnails near/inside the composer. Do not rely
      // on y > 50% viewport: long prompts can push thumbnails higher.
      const editor = document.querySelector('div[contenteditable="true"]');
      const editorRect = editor ? editor.getBoundingClientRect() : null;
      const refs = [];
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        // Ref thumbnails: 20-200px wide. Main canvas images are larger.
        if (r.width < 20 || r.width > 200 || r.height < 20 || r.height > 200) continue;
        // Skip if inside a dialog/picker
        if (img.closest('dialog') || img.closest('[role="dialog"]')) continue;
        const altLower = (img.alt || '').toLowerCase();
        if (altLower.includes('profil') || altLower.includes('profile') ||
            altLower.includes('avatar') || altLower.includes('logo') ||
            altLower.includes('preview') || altLower.includes('aperÃ§u')) continue;

        if (editorRect) {
          const overlapsEditorX = r.right >= editorRect.left - 250 && r.left <= editorRect.right + 250;
          const nearEditorY = r.bottom >= editorRect.top - 350 && r.top <= editorRect.bottom + 350;
          if (!overlapsEditorX || !nearEditorY) continue;
        }

        refs.push({
          index: refs.length,
          alt: img.alt || '',
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          width: r.width,
          height: r.height
        });
      }
      return refs;
    });
  }

  /**
   * Remove a prompt reference by clicking its X/close button.
   * @param {number} index — 0-based index from left to right
   * @returns {boolean} true if removed
   */
  async _removePromptRefByIndex(index) {
    const refs = await this._getPromptRefs();
    if (index < 0 || index >= refs.length) {
      Logger.warn(`[Flow] Cannot remove ref #${index}, only ${refs.length} refs found`);
      return false;
    }

    const ref = refs[index];
    Logger.debug(`[Flow] Removing ref #${index}: "${ref.alt}" at (${ref.x.toFixed(0)}, ${ref.y.toFixed(0)})`);

    // Hover on the ref thumbnail to reveal the X button
    await this.page.mouse.move(ref.x, ref.y);
    await this._delay(500);

    // Try to find and click the X/close button near this ref
    const removed = await this.page.evaluate(({ refX, refY, refW, refH }) => {
      // Look for close/X buttons near this ref position
      const closeBtns = document.querySelectorAll('button, [role="button"]');
      let bestBtn = null;
      let bestDist = Infinity;

      for (const btn of closeBtns) {
        const r = btn.getBoundingClientRect();
        if (r.width < 5 || r.width > 40 || r.height > 40) continue; // X buttons are small
        const t = (btn.textContent || '').trim().toLowerCase();
        const icon = btn.querySelector('i.google-symbols, i[class*="google-symbols"]');
        const iconText = icon ? icon.textContent.trim() : '';
        // X button indicators: "close", "×", "x", "clear", or close icon
        if (t === 'x' || t === '×' || t === 'close' || iconText === 'close' || iconText === 'cancel' ||
            btn.getAttribute('aria-label')?.toLowerCase().includes('close') ||
            btn.getAttribute('aria-label')?.toLowerCase().includes('supprimer') ||
            btn.getAttribute('aria-label')?.toLowerCase().includes('remove')) {
          // Must be near our ref thumbnail
          const dist = Math.sqrt(Math.pow(r.x - refX, 2) + Math.pow(r.y - refY, 2));
          if (dist < 100 && dist < bestDist) { // Within 100px of ref
            bestDist = dist;
            bestBtn = btn;
          }
        }
      }

      // Fallback: any small button very close to the ref (within 50px of top-right corner)
      if (!bestBtn) {
        const topRightX = refX + refW / 2;
        const topRightY = refY - refH / 2;
        for (const btn of closeBtns) {
          const r = btn.getBoundingClientRect();
          if (r.width > 30 || r.height > 30) continue;
          const cx = r.x + r.width / 2;
          const cy = r.y + r.height / 2;
          const dist = Math.sqrt(Math.pow(cx - topRightX, 2) + Math.pow(cy - topRightY, 2));
          if (dist < 50 && dist < bestDist) {
            bestDist = dist;
            bestBtn = btn;
          }
        }
      }

      if (bestBtn) {
        bestBtn.click();
        return true;
      }
      return false;
    }, { refX: ref.x, refY: ref.y, refW: ref.width, refH: ref.height });

    if (removed) {
      Logger.info(`[Flow] Removed ref #${index}: "${ref.alt}"`);
      await this._delay(500);
      return true;
    }

    Logger.warn(`[Flow] Could not find X button for ref #${index}`);
    return false;
  }

  /**
   * Remove all prompt references (clear the ref area).
   * Removes from right to left to avoid index shifting.
   */
  async _clearAllPromptRefs() {
    let refs = await this._getPromptRefs();
    Logger.info(`[Flow] Clearing ${refs.length} prompt refs`);

    for (let pass = 1; pass <= 3 && refs.length > 0; pass++) {
      Logger.info(`[Flow] Clear refs pass ${pass}: ${refs.length} ref(s)`);
      // Remove from end to start to avoid index shifting
      for (let i = refs.length - 1; i >= 0; i--) {
        await this._removePromptRefByIndex(i);
        await this._delay(300);
      }
      await this._delay(500);
      refs = await this._getPromptRefs();
    }

    if (refs.length > 0) {
      Logger.warn(`[Flow] ${refs.length} refs remain after clearing`);
      for (const ref of refs) {
        Logger.warn(`[Flow] Remaining ref: "${ref.alt || 'unknown'}" (${Math.round(ref.width)}x${Math.round(ref.height)})`);
      }
    }
    return refs.length === 0;
  }

  async _confirmPromptRefAttached(previousCount, imageName, role = 'ref') {
    const started = Date.now();
    let refs = [];
    while (Date.now() - started < 7000) {
      await this._delay(700);
      refs = await this._getPromptRefs();
      if (refs.length > previousCount) {
        const suffix = Date.now() - started > 1000 ? ' after wait' : '';
        Logger.info(`[Flow] Verified ${role} ref in prompt${suffix}: ${imageName} (${previousCount} -> ${refs.length})`);
        return true;
      }
    }

    const visible = refs.map(ref => ref.alt || 'unknown').join(', ');
    Logger.warn(`[Flow] ${role} ref not visible after attach attempt: ${imageName} (${previousCount} -> ${refs.length}); visible refs: ${visible || 'none'}`);
    return false;
  }

  async _assertPromptReady(expectedRefs, minPromptLength = 10, label = 'pre-create') {
    const { refs, promptText } = await this._debugPromptState();
    const visibleRefs = refs.map(ref => ref.alt || 'unknown').join(', ');
    Logger.info(`[Flow] ${label} composer check: refs=${refs.length}/${expectedRefs}, prompt=${promptText.length} chars, visible refs=${visibleRefs || 'none'}`);

    if (promptText.length < minPromptLength) {
      throw new Error(`[Flow] ${label} failed: prompt text missing before Create`);
    }
    if (refs.length < expectedRefs) {
      throw new Error(`[Flow] ${label} failed: expected ${expectedRefs} prompt ref(s), found ${refs.length}`);
    }

    return true;
  }

  /**
   * Dump debug info about current prompt state:
   * - Refs in prompt area (count, alt texts)
   * - Prompt text content
   * Useful for testing the reuse workflow.
   */
  async _debugPromptState() {
    const refs = await this._getPromptRefs();
    const promptText = await this.page.evaluate((css) => {
      const el = document.querySelector(css);
      return el ? (el.textContent || '').trim() : '';
    }, PROMPT_INPUT_CSS);

    Logger.info(`[Flow] Prompt state: ${refs.length} refs, ${promptText.length} chars`);
    for (const ref of refs) {
      Logger.debug(`  Ref #${ref.index}: "${ref.alt}" (${ref.width.toFixed(0)}×${ref.height.toFixed(0)}) at (${ref.x.toFixed(0)}, ${ref.y.toFixed(0)})`);
    }
    if (promptText.length > 0) {
      Logger.debug(`  Text: "${promptText.substring(0, 100)}${promptText.length > 100 ? '...' : ''}"`);
    }
    return { refs, promptText };
  }

  // ═══════════════════════════════════════════════════════════
  // STEP HELPERS
  // ═══════════════════════════════════════════════════════════

  async _clickIfExists(...texts) {
    return await this.page.evaluate((textList) => {
      const els = document.querySelectorAll('button, a, [role="button"], [role="link"]');
      for (const el of els) {
        const t = (el.textContent || '').toLowerCase().trim();
        for (const match of textList) {
          if (t.includes(match)) { el.click(); return true; }
        }
      }
      return false;
    }, texts);
  }

  async _waitForPromptInput() {
    for (let i = 0; i < PROMPT_MAX_ATTEMPTS; i++) {
      const found = await this.page.evaluate((sels) => {
        for (const sel of sels) {
          const el = document.querySelector(sel);
          if (el && el.getBoundingClientRect().width > 0) {
            el.focus(); el.click(); return true;
          }
        }
        return false;
      }, PROMPT_INPUT_SELECTORS);
      if (found) return;
      await this._delay(PROMPT_POLL_DELAY);
    }
    throw new Error('Prompt input not found');
  }

  async _setGenerationSettings(aspectRatio) {
    // Click the settings button via native mouse (Radix needs real events)
    // Matches any model: Nano Banana Pro, Nano Banana 2, Imagen 4
    const settingsPos = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('nano banana') || text.includes('imagen')) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (!settingsPos) { Logger.debug('Settings button not found'); return; }
    await this.page.mouse.click(settingsPos.x, settingsPos.y);
    await this._delay(SETTINGS_OPEN_DELAY);

    // Set aspect ratio via native mouse click
    // Use exact match to avoid "PORTRAIT" matching "PORTRAIT_3_4" via includes()
    const ratioPos = await this.page.evaluate((ratio) => {
      const tabs = document.querySelectorAll('button[role="tab"]');
      const exact = `trigger-${ratio}`;
      for (const tab of tabs) {
        const id = tab.id || '';
        // Exact match: id ends with the ratio OR the trigger segment matches exactly
        if (id === exact || id.endsWith(`-${ratio}`) || id.includes(`trigger-${ratio}-`) || id.includes(`trigger-${ratio}`)) {
          // Guard against partial match: "PORTRAIT" should NOT match "PORTRAIT_3_4"
          // Check that the character after ratio in the id is not alphanumeric/underscore
          const idx = id.indexOf(`trigger-${ratio}`);
          const afterChar = id[idx + `trigger-${ratio}`.length] || '';
          if (afterChar && /[a-zA-Z0-9_]/.test(afterChar)) continue; // partial match, skip
          if (tab.getAttribute('data-state') !== 'active') {
            const r = tab.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          return null; // already active
        }
      }
      return null;
    }, aspectRatio);

    if (ratioPos) {
      await this.page.mouse.click(ratioPos.x, ratioPos.y);
      Logger.info(`[Flow] Aspect ratio set: ${aspectRatio}`);
    } else {
      Logger.debug(`[Flow] Aspect ratio ${aspectRatio} already active or not found`);
    }
    await this._delay(SETTINGS_TAB_DELAY);

    // Set 1 image/generation via native mouse click. The count tab for 1 renders
    // as "1x" (the 2/3/4 tabs render as "x2"/"x3"/"x4"); accept either spelling.
    const x1Pos = await this.page.evaluate(() => {
      const tabs = document.querySelectorAll('button[role="tab"]');
      for (const tab of tabs) {
        const txt = (tab.textContent || '').trim();
        if ((txt === '1x' || txt === 'x1') && /trigger-1$/.test(tab.id || '')) {
          if (tab.getAttribute('data-state') !== 'active') {
            const r = tab.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
          return null; // already active
        }
      }
      return null;
    });

    if (x1Pos) {
      await this.page.mouse.click(x1Pos.x, x1Pos.y);
    }
    await this._delay(SETTINGS_TAB_DELAY);

    // Set model if preferredModel is specified
    if (this.preferredModel) {
      await this._selectModelInSettings(this.preferredModel);
    }

    // Close dropdown
    await this.page.keyboard.press('Escape');
    await this._delay(SETTINGS_CLOSE_DELAY);
    Logger.info(`[Flow] Settings: ${aspectRatio}, x1, model: ${this.preferredModel || 'default'}`);
  }

  /**
   * Select a model from the dropdown inside the already-open settings panel.
   * Called from _setGenerationSettings when the settings panel is open.
   *
   * The model dropdown is: button[aria-haspopup="menu"] containing "arrow_drop_down"
   * Options are: [role="menuitem"] — "Nano Banana Pro", "Nano Banana 2", "Imagen 4"
   */
  async _selectModelInSettings(targetModel) {
    const target = targetModel.toLowerCase();

    // Check if current model already matches (read from the dropdown trigger)
    const currentModel = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('arrow_drop_down') && (text.includes('nano banana') || text.includes('imagen'))) {
          return text;
        }
      }
      return '';
    });

    if (currentModel.includes(target)) {
      Logger.debug(`[Flow] Model already set to "${targetModel}"`);
      return;
    }

    // Click the model dropdown trigger (button with aria-haspopup="menu" + arrow_drop_down)
    const dropdownPos = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('arrow_drop_down') && (text.includes('nano banana') || text.includes('imagen'))) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (!dropdownPos) {
      Logger.warn('[Flow] Model dropdown not found in settings panel');
      return;
    }

    await this.page.mouse.click(dropdownPos.x, dropdownPos.y);
    await this._delay(800);

    // Select the target model from role="menuitem" options
    const optionPos = await this.page.evaluate((tgt) => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if ((item.textContent || '').toLowerCase().includes(tgt)) {
          const r = item.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, target);

    if (!optionPos) {
      Logger.warn(`[Flow] Model option "${targetModel}" not found in menu`);
      await this.page.keyboard.press('Escape');
      await this._delay(300);
      return;
    }

    await this.page.mouse.click(optionPos.x, optionPos.y);
    await this._delay(500);
    Logger.info(`[Flow] Model selected: "${targetModel}"`);
  }

  /**
   * Switch the Flow model (e.g. "Nano Banana Pro" → "Nano Banana 2").
   * Opens the settings panel, clicks the model dropdown, selects the target.
   * Returns true if switch succeeded, false otherwise.
   * NOTE: Requires the Flow page to be open. For pre-generation model selection,
   * use this.preferredModel instead (applied in _setGenerationSettings).
   */
  async switchFlowModel(targetModel) {
    if (!this.page) {
      Logger.debug(`[Flow] No page open — setting preferredModel to "${targetModel}" for next generation`);
      this.preferredModel = targetModel;
      return true;
    }

    Logger.info(`[Flow] Switching model to "${targetModel}"...`);

    // 1. Open settings panel
    const settingsPos = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        if ((btn.textContent || '').toLowerCase().includes('nano banana') ||
            (btn.textContent || '').toLowerCase().includes('imagen')) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (!settingsPos) {
      Logger.warn('[Flow] Settings button not found');
      this.preferredModel = targetModel;
      return false;
    }

    await this.page.mouse.click(settingsPos.x, settingsPos.y);
    await this._delay(SETTINGS_OPEN_DELAY);

    // 2. Click model dropdown (button[aria-haspopup="menu"] with arrow_drop_down)
    const dropdownPos = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button[aria-haspopup="menu"]');
      for (const btn of btns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('arrow_drop_down') && (text.includes('nano banana') || text.includes('imagen'))) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (!dropdownPos) {
      Logger.warn('[Flow] Model dropdown not found');
      await this.page.keyboard.press('Escape');
      await this._delay(SETTINGS_CLOSE_DELAY);
      this.preferredModel = targetModel;
      return false;
    }

    await this.page.mouse.click(dropdownPos.x, dropdownPos.y);
    await this._delay(800);

    // 3. Select target from role="menuitem" options
    const target = targetModel.toLowerCase();
    const optionPos = await this.page.evaluate((tgt) => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if ((item.textContent || '').toLowerCase().includes(tgt)) {
          const r = item.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, target);

    if (!optionPos) {
      Logger.warn(`[Flow] Model "${targetModel}" not found in menu`);
      await this.page.keyboard.press('Escape');
      await this._delay(SETTINGS_CLOSE_DELAY);
      return false;
    }

    await this.page.mouse.click(optionPos.x, optionPos.y);
    await this._delay(500);

    // 4. Close settings
    await this.page.keyboard.press('Escape');
    await this._delay(SETTINGS_CLOSE_DELAY);

    this.preferredModel = targetModel;
    Logger.success(`[Flow] Model switched to "${targetModel}"`);
    return true;
  }

  async _typePrompt(prompt) {
    await this.page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) { el.focus(); el.click(); }
    }, PROMPT_INPUT_CSS);
    await this._delay(PROMPT_FOCUS_DELAY);
    await this.page.keyboard.press('Control+a');
    await this._delay(PROMPT_SELECT_ALL_DELAY);
    await this.page.keyboard.press('Delete');
    await this._delay(PROMPT_DELETE_DELAY);
    await this.page.keyboard.insertText(prompt);
    await this._delay(PROMPT_TYPE_DELAY);
    Logger.debug('Prompt typed');
  }

  async _clearPromptText() {
    await this.page.evaluate((s) => {
      const el = document.querySelector(s);
      if (el) { el.focus(); el.click(); }
    }, PROMPT_INPUT_CSS);
    await this._delay(PROMPT_FOCUS_DELAY);
    await this.page.keyboard.press('Control+a');
    await this._delay(PROMPT_SELECT_ALL_DELAY);
    await this.page.keyboard.press('Delete');
    await this._delay(PROMPT_DELETE_DELAY);
    Logger.debug('Prompt text cleared');
  }

  async _insertPromptTextPreservingRefs(prompt) {
    const editor = this.page.locator(PROMPT_INPUT_CSS).first();
    await editor.click({ timeout: 8000 });
    await this._delay(PROMPT_FOCUS_DELAY);
    await this.page.keyboard.insertText(prompt);
    await this._delay(PROMPT_TYPE_DELAY);
    const insertedLength = await this.page.evaluate((css) => {
      const el = document.querySelector(css);
      return el ? (el.textContent || '').trim().length : 0;
    }, PROMPT_INPUT_CSS);
    Logger.info(`[Flow] Prompt inserted preserving refs: ${insertedLength} chars`);
  }

  async _clickCreate() {
    // Try the arrow_forward send button first (most reliable)
    const arrowPos = await this.page.evaluate(() => {
      const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
      for (const icon of icons) {
        if (icon.textContent.trim() === 'arrow_forward') {
          const btn = icon.closest('button');
          if (btn && btn.getBoundingClientRect().width > 0) {
            const r = btn.getBoundingClientRect();
            const disabled = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled };
          }
        }
      }
      return null;
    });

    if (arrowPos) {
      if (arrowPos.disabled) {
        Logger.warn('[Flow] Create button is DISABLED — prompt or refs may be invalid');
      }
      await this.page.mouse.click(arrowPos.x, arrowPos.y);
      Logger.info('[Flow] Create clicked (arrow button)');

      // Verify generation started — wait up to 5s for % or progress indicator
      await this._delay(2000);
      let started = false;
      for (let i = 0; i < 6; i++) {
        const hasProgress = await this.page.evaluate(() => {
          const divs = document.querySelectorAll('div');
          for (const div of divs) {
            if (div.children.length === 0 && /^\d+%$/.test(div.textContent.trim())) return true;
          }
          return false;
        });
        const hasSpinner = await this._isProgressVisible(false);
        if (hasProgress || hasSpinner) { started = true; break; }
        await this._delay(500);
      }
      if (!started) {
        // IMPORTANT: in the updated Flow chat UI the Create/arrow button turns
        // into a STOP control while generating, so clicking it again CANCELS
        // the run ("La réponse a été annulée"). Progress detection can miss the
        // new indicator, so we must NOT re-click here. Proceed to wait for the
        // result instead — if it genuinely didn't start, _waitForGeneration
        // times out and the outer generate() retries with a fresh project.
        Logger.warn('[Flow] Progress indicator not detected after Create — NOT re-clicking (would cancel in new Flow); proceeding to wait');
      }
      return;
    }

    // Fallback: text-based button
    const clicked = await this.page.evaluate(() => {
      const texts = ['créer', 'create', 'generate', 'générer'];
      const btns = document.querySelectorAll('button');
      for (const btn of [...btns].reverse()) {
        const t = (btn.textContent || '').toLowerCase().trim();
        if (btn.getBoundingClientRect().width === 0) continue;
        for (const match of texts) {
          if (t.includes(match)) { btn.click(); return true; }
        }
      }
      return false;
    });
    if (!clicked) throw new Error('Create button not found');
    Logger.info('[Flow] Create clicked (text button)');
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════

  async _screenshot(name) {
    try {
      await this.page?.screenshot({
        path: join(SCREENSHOTS_DIR, `flow-${name}-${Date.now()}.png`),
        fullPage: false
      });
    } catch {}
  }

  async _closePage() {
    if (this.page) {
      try { await this.page.close(); } catch {}
      this.page = null;
    }
  }

  async close() { await this.closeSession(); }
  async closeSession() {
    await this._closePage();
    this._projectOpen = false;
    this._bgFilesOnCanvas.clear();
    this._generatedNames.clear();
  }

  _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ═══════════════════════════════════════════════════════════
// ATTACH METHODS FROM SPLIT MODULES
// ═══════════════════════════════════════════════════════════

// Download & image tracking methods (from flow-download.js)
FlowPage.prototype._compareImages = _compareImages;
FlowPage.prototype._getAllImgSrcs = _getAllImgSrcs;
FlowPage.prototype._waitForNewSrc = _waitForNewSrc;
FlowPage.prototype._downloadBySrc = _downloadBySrc;
FlowPage.prototype._downloadImage = _downloadImage;
FlowPage.prototype._downloadFilteredImage = _downloadFilteredImage;
FlowPage.prototype._applyGenereFilter = _applyGenereFilter;
FlowPage.prototype._removeGenereFilter = _removeGenereFilter;
FlowPage.prototype._waitForGenerationProgress = _waitForGenerationProgress;
FlowPage.prototype._waitForGeneration = _waitForGeneration;

// Cleanup & upload methods (from flow-cleanup.js)
FlowPage.prototype.cleanupAllProjects = cleanupAllProjects;
FlowPage.prototype._uploadFile = _uploadFile;
FlowPage.prototype._pasteImageToPrompt = _pasteImageToPrompt;
FlowPage.prototype._uploadToCanvasAndAttach = _uploadToCanvasAndAttach;
FlowPage.prototype._waitForProgress = _waitForProgress;
FlowPage.prototype._isProgressVisible = _isProgressVisible;
