/**
 * Pinterest scraper for gemini-visual — fetch top food photos for a recipe topic.
 *
 * Used during recipe-JSON generation as visual reference attached to ChatGPT.
 * Lives inside the gemini-visual module so VG and other modes are untouched.
 */

import { Logger } from '../../shared/utils/logger.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const TARGET_IMAGES = 3;
const MIN_IMG_BYTES = 30_000;

function upgradeUrl(url) {
  return url ? url.replace(/\/\d+x(\d+)?\//, '/originals/') : url;
}

async function downloadImage(page, url, dest) {
  try {
    const resp = await page.request.get(url, { timeout: 20000 });
    if (!resp.ok()) return { ok: false, reason: `HTTP ${resp.status()}` };
    const buf = await resp.body();
    if (buf.length < MIN_IMG_BYTES) return { ok: false, reason: `too small (${buf.length}B)` };
    writeFileSync(dest, buf);
    return { ok: true, bytes: buf.length };
  } catch (e) {
    return { ok: false, reason: e.message.split('\n')[0].slice(0, 100) };
  }
}

async function tryDownloadWithFallback(page, originalUrl, dest) {
  const upgraded = upgradeUrl(originalUrl);
  if (upgraded !== originalUrl) {
    const r = await downloadImage(page, upgraded, dest);
    if (r.ok) return { ...r, url: upgraded, upgraded: true };
  }
  const r2 = await downloadImage(page, originalUrl, dest);
  return { ...r2, url: originalUrl, upgraded: false };
}

/**
 * Open Pinterest, search "<query> recipe", download up to TARGET_IMAGES high-res
 * images into outDir. Returns array of { path, bytes, url, alt }.
 *
 * @param {import('playwright').BrowserContext} ctx — Playwright context (CDP or persistent)
 * @param {string} query — recipe topic, e.g. "honey glazed ham"
 * @param {string} outDir — destination directory (created if missing)
 */
export async function scrapePinterestImages(ctx, query, outDir) {
  mkdirSync(outDir, { recursive: true });
  const page = await ctx.newPage();
  try {
    const url = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query + ' recipe')}&rs=typed`;
    Logger.info(`[Pinterest] navigating: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);

    try {
      await page.waitForFunction(() => document.querySelectorAll('img').length > 5, { timeout: 12000 });
    } catch {
      Logger.warn('[Pinterest] grid did not populate within 12s — proceeding anyway');
    }

    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1800);
      await page.waitForTimeout(900);
    }

    const candidates = await page.evaluate(() => {
      const seen = new Set();
      const results = [];
      const fromSrcset = (srcset) => {
        if (!srcset) return null;
        const parts = srcset.split(',').map(s => s.trim());
        return parts[parts.length - 1].split(/\s+/)[0];
      };
      const imgs = Array.from(document.querySelectorAll('img'));
      for (const img of imgs) {
        const src = img.src || img.currentSrc || fromSrcset(img.getAttribute('srcset'));
        if (!src) continue;
        if (!/pinimg\.com/.test(src)) continue;
        if (/\/(60|75|140)x(60|75|140)?\//.test(src)) continue;
        if (seen.has(src)) continue;
        seen.add(src);
        results.push({ src, alt: img.alt || '' });
      }
      return results;
    });

    Logger.info(`[Pinterest] found ${candidates.length} candidates`);
    const downloaded = [];
    let attempts = 0;
    for (const c of candidates) {
      if (downloaded.length >= TARGET_IMAGES) break;
      attempts++;
      const dest = join(outDir, `pinterest-ref-${downloaded.length + 1}.jpg`);
      const r = await tryDownloadWithFallback(page, c.src, dest);
      if (r.ok) {
        downloaded.push({ path: dest, bytes: r.bytes, url: r.url, alt: c.alt });
        Logger.info(`[Pinterest] ✓ ref-${downloaded.length}: ${(r.bytes / 1024).toFixed(0)}KB`);
      }
      if (attempts > 25) break;
    }

    if (downloaded.length < 2) {
      throw new Error(`Pinterest: only ${downloaded.length}/${TARGET_IMAGES} images — abort`);
    }
    return downloaded;
  } finally {
    await page.close().catch(() => {});
  }
}
