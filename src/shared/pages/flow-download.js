/**
 * Flow download & image generation tracking methods.
 * These functions are attached to FlowPage.prototype in flow.js.
 *
 * `this` always refers to a FlowPage instance.
 */

import { Logger } from '../utils/logger.js';
import { dirname, basename } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import sharp from 'sharp';
import {
  DOWNLOAD_MAX_TIMEOUT,
  DOWNLOAD_POLL_DELAY,
  IMAGE_LOAD_TIMEOUT,
  MAX_IMAGE_SIZE_BYTES,
  MIN_IMAGE_DIMENSION,
  GENERATION_MAX_TIMEOUT,
  POST_GENERATION_RENDER_DELAY,
  PRE_GENERATION_DELAY,
  GENERATION_CONFIRM_DELAY,
  GENERATION_POLL_DELAY,
  POST_GENERATION_DELAY,
} from './flow.js';

/**
 * Custom error thrown when Flow rate-limits the account (too fast).
 * Caught by the orchestrator to try fallback model or rotate account.
 */
export class FlowRateLimitError extends Error {
  constructor(message = 'Flow rate limit — too many generations too quickly') {
    super(message);
    this.name = 'FlowRateLimitError';
  }
}

/**
 * Custom error thrown when Flow blocks the account (unusual activity).
 * Account is dead — skip recipe, flag account, rotate immediately.
 */
export class FlowAccountBlockedError extends Error {
  constructor(message = 'Flow account blocked — unusual activity detected') {
    super(message);
    this.name = 'FlowAccountBlockedError';
  }
}

// ═══════════════════════════════════════════════════════════
// IMAGE COMPARISON
// ═══════════════════════════════════════════════════════════

/**
 * Compare two images pixel-by-pixel using Sharp.
 * Returns similarity percentage (0-100).
 * If >85% similar, the generated image is likely just the background.
 */
export async function _compareImages(imgPathA, imgPathB) {
  try {
    const size = 32; // Small thumbnail for fast comparison
    const pixelsA = await sharp(imgPathA).resize(size, size, { fit: 'fill' }).raw().toBuffer();
    const pixelsB = await sharp(imgPathB).resize(size, size, { fit: 'fill' }).raw().toBuffer();

    let matching = 0;
    const totalPixels = size * size;
    const threshold = 30; // Color difference tolerance per channel

    for (let i = 0; i < pixelsA.length; i += 3) {
      const diffR = Math.abs(pixelsA[i] - pixelsB[i]);
      const diffG = Math.abs(pixelsA[i + 1] - pixelsB[i + 1]);
      const diffB = Math.abs(pixelsA[i + 2] - pixelsB[i + 2]);
      if (diffR < threshold && diffG < threshold && diffB < threshold) {
        matching++;
      }
    }

    return Math.round((matching / totalPixels) * 100);
  } catch (e) {
    Logger.debug('Image comparison failed:', e.message);
    return 0; // If comparison fails, assume images are different (don't block)
  }
}

// ═══════════════════════════════════════════════════════════
// SRC TRACKING HELPERS
// ═══════════════════════════════════════════════════════════

/** Get all img.src values on the page */
export async function _getAllImgSrcs() {
  return await this.page.evaluate(() =>
    Array.from(document.querySelectorAll('img')).map(i => i.src).filter(Boolean)
  );
}

/** Wait until a new img.src appears that wasn't in srcsBefore. Returns the new src or null. */
export async function _waitForNewSrc(srcsBefore, timeout = 10000) {
  const beforeSet = new Set(srcsBefore);
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const current = await this._getAllImgSrcs();
    for (const src of current) {
      if (!beforeSet.has(src)) return src;
    }
    await this._delay(500);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// DOWNLOAD BY SRC
// ═══════════════════════════════════════════════════════════

/** Download image by its src URL — uses multiple methods */
export async function _downloadBySrc(outputPath, srcs) {
  mkdirSync(dirname(outputPath), { recursive: true });

  // Method 1: Click the image to open it, then use Playwright screenshot of the element
  // This avoids CORS/canvas taint issues entirely
  const imgHandle = await this.page.evaluateHandle((srcs) => {
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(i => srcs.includes(i.src) && i.naturalWidth > 100);
    if (imgs.length === 0) return null;
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    return imgs[0];
  }, srcs);

  if (!imgHandle || (await imgHandle.jsonValue()) === null) {
    throw new Error('Image element not found for download');
  }

  // Method 1: page.request — Playwright's HTTP client with browser cookies (full-res, no CORS)
  const bestSrc = await this.page.evaluate((srcs) => {
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(i => srcs.includes(i.src) && i.naturalWidth > 100);
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    return imgs[0]?.src || null;
  }, srcs);

  if (bestSrc) {
    try {
      const resp = await this.page.request.get(bestSrc);
      if (resp.ok()) {
        const body = await resp.body();
        if (body.length > 5000) {
          writeFileSync(outputPath, body);
          Logger.debug('Image downloaded via page.request (full-res)');
          return;
        }
      }
    } catch (e) {
      Logger.debug('page.request failed:', e.message);
    }
  }

  // Method 2: Canvas at full naturalWidth x naturalHeight
  const base64 = await this.page.evaluate(async ({ srcs, maxSize, loadTimeout }) => {
    const imgs = Array.from(document.querySelectorAll('img'))
      .filter(i => srcs.includes(i.src) && i.naturalWidth > 100);
    if (imgs.length === 0) return null;
    imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
    const best = imgs[0];

    // Try canvas at full naturalWidth x naturalHeight
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = best.naturalWidth;
      canvas.height = best.naturalHeight;
      ctx.drawImage(best, 0, 0);
      return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
    } catch {}

    return null;
  }, { srcs, maxSize: MAX_IMAGE_SIZE_BYTES, loadTimeout: IMAGE_LOAD_TIMEOUT });

  if (base64) {
    writeFileSync(outputPath, Buffer.from(base64, 'base64'));
    Logger.debug('Image downloaded via canvas/fetch');
    return;
  }

  // Method 3: Element screenshot fallback (thumbnail quality)
  // NOTE: Do NOT click images — it opens the editor view and breaks single-project session.
  // Just screenshot the grid thumbnail directly.
  try {
    const element = imgHandle.asElement();
    if (element) {
      await element.screenshot({ path: outputPath, type: 'jpeg', quality: 92 });
      Logger.debug('Image downloaded via element screenshot (thumbnail)');
      return;
    }
  } catch (e) {
    Logger.debug('Element screenshot failed:', e.message);
  }

  throw new Error('Failed to download image - all methods failed');
}

// ═══════════════════════════════════════════════════════════
// DOWNLOAD IMAGE (before/after snapshot strategy)
// ═══════════════════════════════════════════════════════════

export async function _downloadImage(outputPath, beforeSrcs = []) {
  mkdirSync(dirname(outputPath), { recursive: true });

  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < DOWNLOAD_MAX_TIMEOUT) {
    attempt++;
    const result = await this.page.evaluate((before) => {
      // Count all images and new images for debugging
      const allImgs = document.querySelectorAll('img');
      const newImgs = [];
      allImgs.forEach(img => {
        if (img.src && !before.includes(img.src)) {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          newImgs.push({ src: img.src.substring(0, 80), w, h });
        }
      });
      return { total: allImgs.length, beforeCount: before.length, newCount: newImgs.length, newImgs: newImgs.slice(0, 5) };
    }, beforeSrcs);

    if (attempt <= 2) {
      Logger.debug(`Image scan #${attempt}: ${result.total} total, ${result.beforeCount} before, ${result.newCount} new`);
      if (result.newImgs.length) Logger.debug(`New images: ${JSON.stringify(result.newImgs.map(i => i.w + 'x' + i.h))}`);
    }

    const base64 = await this.page.evaluate(async ({ before, minDim, maxSize, loadTimeout }) => {
      const candidates = [];
      document.querySelectorAll('img').forEach(img => {
        if (!img.src || before.includes(img.src)) return;

        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const src = (img.src || '').toLowerCase();

        if (w < minDim || h < minDim) return;
        if (src.includes('avatar') || src.includes('icon') || src.includes('logo') ||
            src.includes('profile') || src.includes('favicon')) return;

        const rect = img.getBoundingClientRect();
        candidates.push({ src: img.src, w, h, visible: rect.width * rect.height });
      });

      if (candidates.length === 0) return null;

      // Pick the largest NEW visible image
      candidates.sort((a, b) => b.visible - a.visible);
      const best = candidates[0];

      // Convert to base64
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const imgEl = await new Promise((resolve, reject) => {
          const ni = new Image();
          ni.crossOrigin = 'anonymous';
          ni.onload = () => resolve(ni);
          ni.onerror = () => reject(new Error('load failed'));
          ni.src = best.src;
          setTimeout(() => reject(new Error('timeout')), loadTimeout);
        });
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        ctx.drawImage(imgEl, 0, 0);

        for (let q = 0.9; q >= 0.3; q -= 0.1) {
          const dataUrl = canvas.toDataURL('image/jpeg', q);
          const b64 = dataUrl.split(',')[1];
          if (Math.ceil(b64.length * 0.75) <= maxSize) return b64;
        }
        return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      } catch {
        try {
          const resp = await fetch(best.src);
          const blob = await resp.blob();
          return new Promise(r => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.onerror = () => r(null);
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      }
    }, { before: beforeSrcs, minDim: MIN_IMAGE_DIMENSION, maxSize: MAX_IMAGE_SIZE_BYTES, loadTimeout: IMAGE_LOAD_TIMEOUT });

    if (base64) {
      writeFileSync(outputPath, Buffer.from(base64, 'base64'));
      Logger.debug(`Image saved: ${basename(outputPath)}`);
      return;
    }
    await this._delay(DOWNLOAD_POLL_DELAY);
  }

  throw new Error('No generated image found');
}

// ═══════════════════════════════════════════════════════════
// DOWNLOAD FILTERED IMAGE
// ═══════════════════════════════════════════════════════════

/**
 * Download the first visible large image on the page (after filter applied).
 * Since "Généré" filter is active, only generated images are visible.
 */
export async function _downloadFilteredImage(outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });

  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < DOWNLOAD_MAX_TIMEOUT) {
    attempt++;

    const base64 = await this.page.evaluate(async ({ minDim, maxSize, loadTimeout }) => {
      const candidates = [];
      document.querySelectorAll('img').forEach(img => {
        if (!img.src) return;
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const src = (img.src || '').toLowerCase();

        if (w < minDim || h < minDim) return;
        if (src.includes('avatar') || src.includes('icon') || src.includes('logo') ||
            src.includes('profile') || src.includes('favicon')) return;

        const rect = img.getBoundingClientRect();
        if (rect.width < 50 || rect.height < 50) return; // not visible
        candidates.push({ src: img.src, w, h, visible: rect.width * rect.height });
      });

      if (candidates.length === 0) return null;

      // Pick the largest visible image (should be the only generated one)
      candidates.sort((a, b) => b.visible - a.visible);
      const best = candidates[0];

      // Convert to base64
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const imgEl = await new Promise((resolve, reject) => {
          const ni = new Image();
          ni.crossOrigin = 'anonymous';
          ni.onload = () => resolve(ni);
          ni.onerror = () => reject(new Error('load failed'));
          ni.src = best.src;
          setTimeout(() => reject(new Error('timeout')), loadTimeout);
        });
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        ctx.drawImage(imgEl, 0, 0);

        for (let q = 0.9; q >= 0.3; q -= 0.1) {
          const dataUrl = canvas.toDataURL('image/jpeg', q);
          const b64 = dataUrl.split(',')[1];
          if (Math.ceil(b64.length * 0.75) <= maxSize) return b64;
        }
        return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      } catch {
        try {
          const resp = await fetch(best.src);
          const blob = await resp.blob();
          return new Promise(r => {
            const reader = new FileReader();
            reader.onloadend = () => r(reader.result.split(',')[1]);
            reader.onerror = () => r(null);
            reader.readAsDataURL(blob);
          });
        } catch { return null; }
      }
    }, { minDim: MIN_IMAGE_DIMENSION, maxSize: MAX_IMAGE_SIZE_BYTES, loadTimeout: IMAGE_LOAD_TIMEOUT });

    if (base64) {
      writeFileSync(outputPath, Buffer.from(base64, 'base64'));
      Logger.debug(`Image saved (filtered): ${basename(outputPath)}`);
      return;
    }

    if (attempt <= 2) Logger.debug(`Waiting for filtered image (attempt ${attempt})...`);
    await this._delay(DOWNLOAD_POLL_DELAY);
  }

  throw new Error('No generated image found after filter');
}

// ═══════════════════════════════════════════════════════════
// FILTER: show only generated images (hide uploaded backgrounds)
// ═══════════════════════════════════════════════════════════

/**
 * Click the Filtres button and check "Généré" to show only generated images.
 * Returns true if filter was applied successfully.
 */
export async function _applyGenereFilter() {
  Logger.debug('Applying Généré filter...');

  // Step 1: Find filter_list icon and click via native mouse (Radix needs real pointer events)
  const filterPos = await this.page.evaluate(() => {
    const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
    for (const icon of icons) {
      if (icon.textContent.trim() === 'filter_list') {
        const btn = icon.closest('button') || icon;
        const r = btn.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });

  if (!filterPos) {
    Logger.warn('Filter button not found');
    return false;
  }

  await this.page.mouse.click(filterPos.x, filterPos.y);
  await this._delay(2000);

  // Step 2: Find "Généré" menu item and click via native mouse
  const genPos = await this.page.evaluate(() => {
    const items = document.querySelectorAll('[role="menuitem"]');
    for (const item of items) {
      if ((item.textContent || '').includes('Généré')) {
        const r = item.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });

  if (!genPos) {
    Logger.warn('Généré option not found in filter menu');
    await this.page.keyboard.press('Escape').catch(() => {});
    return false;
  }

  await this.page.mouse.click(genPos.x, genPos.y);
  await this.page.keyboard.press('Escape').catch(() => {});
  await this._delay(2000);
  Logger.debug('Généré filter applied');
  return true;
}

/**
 * Remove the Généré filter (uncheck it) so all images show again.
 * Used as fallback when filter approach fails.
 */
export async function _removeGenereFilter() {
  try {
    // Click filter button via mouse
    const filterPos = await this.page.evaluate(() => {
      const icons = document.querySelectorAll('i.google-symbols, i[class*="google-symbols"]');
      for (const icon of icons) {
        if (icon.textContent.trim() === 'filter_list') {
          const btn = icon.closest('button') || icon;
          const r = btn.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    if (filterPos) {
      await this.page.mouse.click(filterPos.x, filterPos.y);
      await this._delay(2000);
      // Uncheck Généré via mouse
      const genPos = await this.page.evaluate(() => {
        for (const item of document.querySelectorAll('[role="menuitem"]')) {
          if ((item.textContent || '').includes('Généré')) {
            const r = item.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });
      if (genPos) await this.page.mouse.click(genPos.x, genPos.y);
      await this.page.keyboard.press('Escape').catch(() => {});
      await this._delay(1000);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════
// WAIT FOR GENERATION: track % progress on the generated image
// ═══════════════════════════════════════════════════════════

/**
 * Wait for generation by tracking the % progress overlay.
 * Flow shows a div with "27%", "15%", etc. on the generating image.
 * When the % disappears, generation is complete.
 */
export async function _waitForGenerationProgress() {
  const TIMEOUT = GENERATION_MAX_TIMEOUT;
  const start = Date.now();
  let sawProgress = false;

  // Snapshot image count at start — so we can detect NEW images only
  const imgCountAtStart = await this.page.evaluate(() => document.querySelectorAll('img').length);

  Logger.info(`[Flow] Waiting for generation... (${imgCountAtStart} images on page)`);

  while (Date.now() - start < TIMEOUT) {
    // Check for error messages — only in error banners/dialogs, NOT the entire page body
    // (body.innerText catches footer text, help links, etc. → false positives)
    const errorType = await this.page.evaluate(() => {
      // Look for error text in small containers (alerts, banners, dialogs, snackbars)
      // These are typically short elements (<500 chars) that contain the error message
      const candidates = document.querySelectorAll(
        '[role="alert"], [role="dialog"], [class*="error"], [class*="snackbar"], ' +
        '[class*="banner"], [class*="toast"], [class*="warning"], [class*="notice"]'
      );

      // Also check small divs/paragraphs that might be error messages
      const allSmall = document.querySelectorAll('div, p, span');
      const checkElements = [...candidates];
      for (const el of allSmall) {
        const text = (el.innerText || '').trim();
        // Only check small elements that could be error messages (not the whole page)
        if (text.length > 20 && text.length < 500) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) checkElements.push(el);
        }
      }

      for (const el of checkElements) {
        const text = (el.innerText || '').toLowerCase();
        if (text.length > 500) continue; // Skip large containers

        // "Échec" header + rate limit message
        if (text.includes('générations trop rapidement') || text.includes('generations too quickly')) {
          return 'ratelimit';
        }
        if (text.includes('chec') && text.includes('trop rapidement')) {
          return 'ratelimit';
        }

        // Account block — must be a clear error message, not footer text
        // Full message: "We noticed some unusual activity. Please visit the Help Center"
        if ((text.includes('unusual activity') && text.includes('help center')) ||
            (text.includes('activité inhabituelle') && text.includes("centre d'aide"))) {
          return 'blocked';
        }
      }
      return null;
    });

    if (errorType === 'blocked') {
      Logger.error('[Flow] Account BLOCKED — unusual activity detected in error banner');
      await this._screenshot('flow-account-blocked');
      throw new FlowAccountBlockedError();
    }
    if (errorType === 'ratelimit') {
      Logger.warn('[Flow] Rate limit detected — generating too quickly');
      await this._screenshot('flow-rate-limited');
      throw new FlowRateLimitError();
    }

    const progress = await this.page.evaluate(() => {
      // Find any element showing a percentage (e.g. "27%")
      const divs = document.querySelectorAll('div');
      for (const div of divs) {
        const text = div.textContent.trim();
        if (text.match(/^\d+%$/) && div.children.length === 0) {
          return text;
        }
      }
      return null;
    });

    if (progress) {
      sawProgress = true;
      Logger.debug(`Generation progress: ${progress}`);
    } else if (sawProgress) {
      // Progress was visible before but now gone = generation complete
      Logger.debug('Generation complete (progress disappeared)');
      await this._delay(POST_GENERATION_RENDER_DELAY);
      return;
    }

    // Also check classic progress indicators as fallback
    if (!sawProgress && Date.now() - start > 10000) {
      const classicProgress = await this._isProgressVisible(false);
      if (classicProgress) sawProgress = true;
    }

    // Log every 15s if no progress detected yet
    if (!sawProgress && (Date.now() - start) % 15000 < 1100) {
      Logger.warn(`[Flow] No generation progress detected after ${Math.round((Date.now() - start) / 1000)}s`);
    }

    // If no progress seen after 30s, check if a NEW image appeared (not just uploaded bg)
    if (!sawProgress && Date.now() - start > 30000) {
      const currentCount = await this.page.evaluate(() => document.querySelectorAll('img').length);
      if (currentCount > imgCountAtStart) {
        Logger.debug(`No progress % found but new image appeared (${imgCountAtStart} → ${currentCount}) — generation likely complete`);
        await this._delay(POST_GENERATION_RENDER_DELAY);
        return;
      }
    }

    await this._delay(1000);
  }

  Logger.warn(`[Flow] Generation timeout after ${Math.round((Date.now() - start) / 1000)}s — no progress or new image detected`);
  await this._delay(POST_GENERATION_RENDER_DELAY);
}

// ═══════════════════════════════════════════════════════════
// LEGACY WAIT FOR GENERATION (kept for compatibility)
// ═══════════════════════════════════════════════════════════

export async function _waitForGeneration() {
  const start = Date.now();

  // Wait for loading to start
  await this._delay(PRE_GENERATION_DELAY);

  // Wait for loading to finish
  while (Date.now() - start < GENERATION_MAX_TIMEOUT) {
    const loading = await this._isProgressVisible(true);

    if (!loading) {
      // Double check after a brief pause
      await this._delay(GENERATION_CONFIRM_DELAY);
      const still = await this._isProgressVisible(false);
      if (!still) break;
    }
    await this._delay(GENERATION_POLL_DELAY);
  }

  await this._delay(POST_GENERATION_DELAY);
  Logger.debug('Generation complete');
}
