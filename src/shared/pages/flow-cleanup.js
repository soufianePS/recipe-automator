/**
 * Flow cleanup & upload methods.
 * These functions are attached to FlowPage.prototype in flow.js.
 *
 * `this` always refers to a FlowPage instance.
 *
 * Upload method: Clipboard paste (Ctrl+V)
 *   - Read image file → write to clipboard → focus prompt → Ctrl+V
 *   - Image goes directly into prompt box AND canvas in one step
 *   - Supports multiple images (paste one after another)
 *   - Much faster and simpler than upload+picker method
 *
 * Selector strategy (priority order):
 *   1. Semantic attributes: role="menuitem", role="dialog", role="tab", contenteditable
 *   2. Icon text: google-symbols icon content (add, add_2, arrow_forward, etc.)
 *   3. Scoped search: search inside dialog/panel only, not global document
 *   4. Text content: menu item labels, image alt text, filenames
 */

import { Logger } from '../utils/logger.js';
import { basename } from 'path';
import { readFileSync } from 'fs';
import {
  PROGRESS_SELECTORS,
  PROMPT_INPUT_CSS,
  CLEANUP_INITIAL_DELAY,
  CLEANUP_LANDING_DELAY,
  CLEANUP_DELETE_DELAY,
  CLEANUP_CONFIRM_DELAY,
  CLEANUP_MAX_PROJECTS,
  FLOW_URL,
  PROGRESS_DETECT_WINDOW,
  PROGRESS_DETECT_POLL_DELAY,
  PROGRESS_FALLBACK_DELAY,
  PROGRESS_WAIT_POLL_DELAY,
} from './flow.js';

// DOM helpers string — injected into page.evaluate for button/menu finding
const DOM_HELPERS = `
  const ICON_SEL = 'i.google-symbols, i[class*="google-symbols"]';
  function findButtonByIcon(iconText, root) {
    root = root || document;
    for (const icon of root.querySelectorAll(ICON_SEL)) {
      if (icon.textContent.trim() === iconText) {
        const btn = icon.closest('button');
        if (btn && btn.getBoundingClientRect().width > 0) return btn;
      }
    }
    return null;
  }
`;

// ═══════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════

export async function cleanupAllProjects() {
  Logger.info('Cleaning up old Flow projects...');
  this.page = await this.context.newPage();
  await this.page.goto(FLOW_URL, { waitUntil: 'domcontentloaded' });
  await this._delay(CLEANUP_INITIAL_DELAY);

  await this._clickIfExists('create with flow', 'créer avec flow');
  await this._delay(CLEANUP_LANDING_DELAY);

  let deleted = 0;
  for (let i = 0; i < CLEANUP_MAX_PROJECTS; i++) {
    const found = await this.page.evaluate(`(() => {
      ${DOM_HELPERS}
      const btn = findButtonByIcon('delete');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    if (!found) break;
    await this._delay(CLEANUP_DELETE_DELAY);

    await this.page.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"][data-state="open"]')
        || document.querySelector('[role="dialog"]');
      if (!dialog) return;
      for (const btn of dialog.querySelectorAll('button')) {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('annuler') || t.includes('cancel')) continue;
        if (t.includes('supprimer') || t.includes('delete') || t.includes('confirm')) {
          btn.click(); return;
        }
      }
    })()`);
    await this._delay(CLEANUP_CONFIRM_DELAY);
    deleted++;
  }

  Logger.success(`Cleaned ${deleted} old project(s)`);
  await this._closePage();
}

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD — Clipboard Paste Method (Flow UI 2026-04)
//
// How it works:
//   1. Read image file as buffer → convert to base64
//   2. In browser: decode base64 → create Blob → clipboard.write()
//   3. Focus prompt textbox → Ctrl+V
//   4. Image appears in prompt box AND canvas simultaneously
//
// Benefits over upload+picker:
//   - 3x faster (~1.5s vs ~13s per image)
//   - No UI navigation (no menus, no dialogs, no filename matching)
//   - Image goes directly to prompt (not canvas-only)
//   - Works for multiple images (paste sequentially)
// ═══════════════════════════════════════════════════════════

/**
 * Upload a file to Flow prompt.
 * Primary: clipboard paste (fast, direct to prompt)
 * Fallback: upload to canvas + picker attach (slower, reliable)
 * @param {string} filePath — absolute path to image file on disk
 */
export async function _uploadFile(filePath) {
  const fileName = basename(filePath);
  const buffer = readFileSync(filePath);
  const base64 = buffer.toString('base64');
  const mimeType = fileName.endsWith('.png') ? 'image/png' : 'image/jpeg';

  // --- Try clipboard paste first (fast path) ---
  const pasteSuccess = await this._pasteImageToPrompt(base64, mimeType, fileName);

  if (pasteSuccess) {
    Logger.debug(`Pasted to prompt: ${fileName}`);
    return;
  }

  // --- Fallback: upload to canvas + attach via picker ---
  Logger.info(`[Flow] Paste failed for ${fileName}, falling back to upload+picker`);
  await this._uploadToCanvasAndAttach(filePath, fileName);
}

/**
 * Fast path: paste image directly into prompt via clipboard.
 * Returns true if image appeared in prompt, false otherwise.
 */
export async function _pasteImageToPrompt(base64, mimeType, fileName) {
  // Focus the prompt textbox
  await this.page.evaluate((css) => {
    const el = document.querySelector(css);
    if (el) { el.focus(); el.click(); }
  }, PROMPT_INPUT_CSS);
  await this._delay(300);

  // Write image to clipboard (always as PNG — clipboard API only supports image/png)
  const clipResult = await this.page.evaluate(async ({ b64, mime }) => {
    try {
      const byteString = atob(b64);
      const ab = new ArrayBuffer(byteString.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);

      // Convert to PNG via canvas if needed (clipboard only supports image/png)
      let pngBlob;
      if (mime === 'image/png') {
        pngBlob = new Blob([ia], { type: 'image/png' });
      } else {
        // Decode JPEG/other → draw on canvas → export as PNG
        const imgBitmap = await createImageBitmap(new Blob([ia], { type: mime }));
        const canvas = document.createElement('canvas');
        canvas.width = imgBitmap.width;
        canvas.height = imgBitmap.height;
        canvas.getContext('2d').drawImage(imgBitmap, 0, 0);
        pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      }

      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      return 'ok';
    } catch (e) {
      return 'error: ' + e.message;
    }
  }, { b64: base64, mime: mimeType });

  if (clipResult !== 'ok') {
    Logger.warn(`[Flow] Clipboard write failed: ${clipResult}`);
    return false;
  }

  // Paste
  await this.page.keyboard.press('Control+v');
  await this._delay(3000);

  // Verify image appeared in prompt area (thumbnail)
  const appeared = await this.page.evaluate(() => {
    const imgs = document.querySelectorAll('img');
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.width > 20 && r.width < 200 && r.y > 550) return true;
    }
    return false;
  });

  return appeared;
}

/**
 * Fallback: upload image to canvas via top "+" menu, then attach via picker.
 */
export async function _uploadToCanvasAndAttach(filePath, fileName) {
  // Click top "add" button
  await this.page.evaluate(`(() => {
    ${DOM_HELPERS}
    const btn = findButtonByIcon('add');
    if (btn) btn.click();
  })()`);
  await this._delay(800);

  // Click "Importer une image" + handle file chooser
  const [fileChooser] = await Promise.all([
    this.page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null),
    this.page.evaluate(`(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if ((item.textContent || '').toLowerCase().includes('importer')) { item.click(); return; }
      }
    })()`)
  ]);

  if (fileChooser) {
    await fileChooser.setFiles(filePath);
  } else {
    const input = await this.page.$('input[type="file"]');
    if (input) await input.setInputFiles(filePath);
    else throw new Error('No file chooser — Flow UI may have changed');
  }

  await this._delay(3000);

  // Open picker (add_2) and click the image
  await this.page.evaluate(`(() => {
    ${DOM_HELPERS}
    const btn = findButtonByIcon('add_2');
    if (btn) btn.click();
  })()`);
  await this._delay(1000);

  // Click the image in picker dialog — try exact alt, then only-image fallback
  const fnLower = fileName.toLowerCase();
  const attached = await this.page.evaluate(`((fnLower) => {
    const dialog = document.querySelector('dialog, [role="dialog"]');
    if (!dialog) return false;
    const imgs = dialog.querySelectorAll('img');
    // Exact match
    for (const img of imgs) {
      if ((img.alt || '').toLowerCase() === fnLower) { img.parentElement.click(); return 'exact'; }
    }
    // Only non-UI image
    const candidates = [];
    for (const img of imgs) {
      const alt = (img.alt || '').toLowerCase();
      if (alt && !alt.includes('aperçu') && !alt.includes('preview') && !alt.includes('profil') && !alt.includes('recherche')) {
        candidates.push(img);
      }
    }
    if (candidates.length === 1) { candidates[0].parentElement.click(); return 'only'; }
    // Partial match
    for (const img of imgs) {
      const alt = (img.alt || '').toLowerCase();
      if (alt && fnLower.includes(alt.substring(0, 10))) { img.parentElement.click(); return 'partial'; }
    }
    return false;
  })('${fnLower}')`);

  if (attached) {
    Logger.info(`[Flow] Fallback picker: attached "${fileName}" via ${attached}`);
  } else {
    // Close picker, wait, and retry once (image may not be ready yet)
    try { await this.page.keyboard.press('Escape'); } catch {}
    await this._delay(2000);

    // Retry: open picker again
    await this.page.evaluate(`(() => {
      ${DOM_HELPERS}
      const btn = findButtonByIcon('add_2');
      if (btn) btn.click();
    })()`);
    await this._delay(1000);

    const retry = await this.page.evaluate(`((fnLower) => {
      const dialog = document.querySelector('dialog, [role="dialog"]');
      if (!dialog) return false;
      const imgs = dialog.querySelectorAll('img');
      for (const img of imgs) {
        if ((img.alt || '').toLowerCase() === fnLower) { img.parentElement.click(); return 'exact-retry'; }
      }
      const candidates = [];
      for (const img of imgs) {
        const alt = (img.alt || '').toLowerCase();
        if (alt && !alt.includes('aperçu') && !alt.includes('preview') && !alt.includes('profil') && !alt.includes('recherche')) candidates.push(img);
      }
      if (candidates.length === 1) { candidates[0].parentElement.click(); return 'only-retry'; }
      return false;
    })('${fnLower}')`);

    if (retry) {
      Logger.info(`[Flow] Fallback picker retry: attached "${fileName}" via ${retry}`);
    } else {
      try { await this.page.keyboard.press('Escape'); } catch {}
      Logger.warn(`[Flow] Fallback picker failed for "${fileName}" after retry`);
    }
  }

  await this._delay(500);
}

// ═══════════════════════════════════════════════════════════
// PROGRESS UTILITIES
// ═══════════════════════════════════════════════════════════

export async function _waitForProgress(maxWait = 30000) {
  const start = Date.now();
  let seen = false;

  while (Date.now() - start < PROGRESS_DETECT_WINDOW) {
    const has = await this._isProgressVisible(false);
    if (has) { seen = true; break; }
    await this._delay(PROGRESS_DETECT_POLL_DELAY);
  }
  if (!seen) { await this._delay(PROGRESS_FALLBACK_DELAY); return; }

  while (Date.now() - start < maxWait) {
    const still = await this._isProgressVisible(false);
    if (!still) return;
    await this._delay(PROGRESS_WAIT_POLL_DELAY);
  }
}

/**
 * Check whether any progress/loading indicator is currently visible.
 * Uses semantic selectors: role="progressbar", aria-busy="true"
 */
export async function _isProgressVisible(includeCircles = false) {
  return await this.page.evaluate(({ sels, includeCircles }) => {
    for (const sel of sels) {
      try { if (document.querySelector(sel)?.getBoundingClientRect().width > 0) return true; } catch {}
    }
    if (includeCircles) {
      const circles = document.querySelectorAll('circle[stroke-dasharray]');
      for (const c of circles) {
        if (c.getBoundingClientRect().width > 0) return true;
      }
    }
    return false;
  }, { sels: PROGRESS_SELECTORS, includeCircles });
}
