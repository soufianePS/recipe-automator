/**
 * Scraper Page Object — Playwright-based web scraper
 *
 * Replaces: content-scripts/scraper.js (Chrome extension)
 * Extracts recipe content from any URL using Playwright's page.evaluate()
 * for DOM extraction and Node.js for image URL verification.
 */

import { Logger } from '../../shared/utils/logger.js';

// Default CSS selectors to find the main content container
const DEFAULT_CONTENT_SELECTORS = [
  '.entry-content',
  '.post-content',
  'article',
  '.recipe-content',
  '.article-content',
  'main',
];

// Elements to strip from cloned content (noise removal)
const NOISE_SELECTORS = [
  'script', 'style', 'nav', 'footer', 'header', 'aside',
  '.sidebar', '.comments', '#comments', '.share', '.share-buttons',
  '.social', '.social-share', '.ad', '.ad-unit', '.widget',
  'iframe', 'noscript', '.newsletter', '.popup',
  '.related-posts', '.nav',
];

// Minimum content length (chars) to accept a selector match
const MIN_CONTENT_LENGTH = 500;

// Maximum number of image URLs to collect
const MAX_IMAGE_URLS = 20;

// Timeout for HEAD requests when verifying image URLs (ms)
const IMAGE_CHECK_TIMEOUT = 10000;

export class ScraperPage {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
  }

  /**
   * Scrape recipe content from a URL.
   *
   * @param {string} url - The page URL to scrape
   * @param {string} [contentSelectors=''] - Comma or newline separated CSS selectors
   * @returns {Object} { html, pageTitle, metaDescription, imageUrls, hasRecipeSchema }
   */
  async scrape(url, contentSelectors = '') {
    Logger.step('Scraper', `Scraping ${url}`);

    const page = await this.context.newPage();

    try {
      // ── 1. Navigate to the URL ──
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // ── 2. Scroll page to trigger lazy-loaded images ──
      await this._scrollPage(page);

      // ── 3. Extract content via page.evaluate() (browser context) ──
      const selectors = this._parseSelectors(contentSelectors);
      const extracted = await page.evaluate(
        ({ selectors, defaultSelectors, noiseSelectors, minContentLength, maxImageUrls }) => {
          // --- Helper: escape HTML ---
          function escHtml(str) {
            return (str || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
          }

          // --- Helper: parse srcset and return largest URL ---
          function parseSrcsetLargest(srcset) {
            let bestUrl = null;
            let bestWidth = 0;
            const entries = srcset.split(',');
            for (const entry of entries) {
              const parts = entry.trim().split(/\s+/);
              if (parts.length >= 2) {
                const entryUrl = parts[0];
                const w = parseInt(parts[1]);
                if (w > bestWidth && entryUrl.startsWith('http')) {
                  bestWidth = w;
                  bestUrl = entryUrl;
                }
              }
            }
            return bestUrl;
          }

          // --- Helper: get best image URL from an img element ---
          function getBestImageUrl(img) {
            const lazySrc = img.getAttribute('data-lazy-src');
            if (lazySrc && lazySrc.startsWith('http')) return lazySrc;

            const dataSrc = img.getAttribute('data-src');
            if (dataSrc && dataSrc.startsWith('http')) return dataSrc;

            const srcset = img.getAttribute('srcset');
            if (srcset) {
              const largest = parseSrcsetLargest(srcset);
              if (largest) return largest;
            }

            const src = img.getAttribute('src');
            if (src && src.startsWith('http') && !src.includes('data:')) return src;

            return null;
          }

          // --- Helper: check if URL looks like a tiny icon/spacer ---
          function isLikelyIcon(url) {
            const lower = url.toLowerCase();
            return (
              lower.includes('icon') ||
              lower.includes('logo') ||
              lower.includes('avatar') ||
              lower.includes('spacer') ||
              lower.includes('pixel') ||
              lower.includes('1x1') ||
              lower.includes('blank') ||
              lower.endsWith('.gif') ||
              lower.endsWith('.svg')
            );
          }

          let html = '';
          let hasRecipeSchema = false;

          // ── JSON-LD Schema ──
          const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (const script of jsonLdScripts) {
            try {
              const data = JSON.parse(script.textContent);
              if (
                data['@type'] === 'Recipe' ||
                (Array.isArray(data['@graph']) &&
                  data['@graph'].some(g => g['@type'] === 'Recipe'))
              ) {
                hasRecipeSchema = true;
                html += `<!-- JSON-LD Schema -->\n<script type="application/ld+json">${script.textContent}</script>\n\n`;
              }
            } catch (_) {}
          }

          // ── Page title + meta description ──
          const pageTitle = document.title || '';
          const metaDesc =
            document.querySelector('meta[name="description"]')?.content || '';
          html += `<title>${escHtml(pageTitle)}</title>\n`;
          if (metaDesc)
            html += `<meta name="description" content="${escHtml(metaDesc)}">\n`;
          html += '\n';

          // ── Find content container using selectors ──
          const allSelectors = selectors.length > 0 ? selectors : defaultSelectors;
          let contentEl = null;
          let matchedSelector = null;

          for (const sel of allSelectors) {
            try {
              const el = document.querySelector(sel);
              if (el && el.innerHTML.length > minContentLength) {
                contentEl = el;
                matchedSelector = sel;
                break;
              }
            } catch (_) {}
          }

          if (!contentEl) {
            contentEl = document.body;
            matchedSelector = 'body (fallback)';
          }

          // ── Clone content and remove noise ──
          const clone = contentEl.cloneNode(true);

          for (const sel of noiseSelectors) {
            try {
              clone.querySelectorAll(sel).forEach(el => el.remove());
            } catch (_) {}
          }

          // ── Collect ALL image URLs from inside the content class ──
          const imgs = clone.querySelectorAll('img');
          const seenUrls = new Set();
          const imageUrls = [];

          for (const img of imgs) {
            const bestUrl = getBestImageUrl(img);
            if (!bestUrl) {
              img.remove();
              continue;
            }

            // Deduplicate
            if (seenUrls.has(bestUrl)) {
              img.remove();
              continue;
            }

            // Skip icons/spacers
            if (isLikelyIcon(bestUrl)) {
              img.remove();
              continue;
            }

            // Keep ALL images — normalize src
            img.setAttribute('src', bestUrl);
            img.removeAttribute('data-lazy-src');
            img.removeAttribute('data-src');
            img.removeAttribute('srcset');
            img.removeAttribute('loading');
            seenUrls.add(bestUrl);

            if (imageUrls.length < maxImageUrls) {
              imageUrls.push(bestUrl);
            }
          }

          html += `<!-- Content -->\n${clone.innerHTML}`;

          return {
            html,
            pageTitle,
            metaDescription: metaDesc,
            imageUrls,
            hasRecipeSchema,
            matchedSelector,
          };
        },
        {
          selectors,
          defaultSelectors: DEFAULT_CONTENT_SELECTORS,
          noiseSelectors: NOISE_SELECTORS,
          minContentLength: MIN_CONTENT_LENGTH,
          maxImageUrls: MAX_IMAGE_URLS,
        }
      );

      Logger.info(`Content found with selector: ${extracted.matchedSelector}`);
      Logger.info(
        `Extracted ${extracted.html.length} chars, ${extracted.imageUrls.length} image URLs`
      );

      // ── 4. Verify image URLs from Node.js (HEAD requests) ──
      const allVerified = await this._verifyImageUrls(extracted.imageUrls);
      Logger.info(
        `Images verified: ${allVerified.length}/${extracted.imageUrls.length} accessible`
      );

      // ── 6. Close page ──
      await page.close();

      // ── 7. Return result ──
      const result = {
        html: extracted.html,
        pageTitle: extracted.pageTitle,
        metaDescription: extracted.metaDescription,
        imageUrls: allVerified,
        hasRecipeSchema: extracted.hasRecipeSchema,
      };

      Logger.success(
        `Scraped ${result.html.length} chars, ${allVerified.length} verified images, schema=${result.hasRecipeSchema}`
      );

      return result;
    } catch (err) {
      Logger.error(`Scraper failed for ${url}: ${err.message}`);
      await page.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Scroll the page to trigger lazy-loaded images.
   * Scrolls 4 times with delays, then back to top.
   */
  async _scrollPage(page) {
    Logger.debug('Scrolling page to trigger lazy-loaded images...');

    // Scroll all the way to the bottom of the page to trigger all lazy-loaded images
    let lastHeight = 0;
    for (let i = 0; i < 30; i++) {
      const currentHeight = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
        return document.body.scrollHeight;
      });
      await page.waitForTimeout(500);
      if (currentHeight === lastHeight) break; // reached bottom
      lastHeight = currentHeight;
    }

    // Scroll back to top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);
  }

  /**
   * Parse content selectors string (newline or comma separated) into array.
   */
  _parseSelectors(raw) {
    if (!raw) return [];
    return raw
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  /**
   * Verify image URLs via HEAD requests from Node.js.
   * Returns only URLs that respond with HTTP 200.
   */
  async _verifyImageUrls(urls) {
    if (!urls || urls.length === 0) return [];

    const results = await Promise.allSettled(
      urls.map(url => this._checkImageUrl(url))
    );

    return results
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
  }

  /**
   * Send a HEAD request to check if an image URL is accessible.
   * Returns the URL if status is 200, null otherwise.
   */
  async _checkImageUrl(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), IMAGE_CHECK_TIMEOUT);

      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeout);

      if (resp.ok) {
        return url;
      }

      Logger.debug(`Image not accessible (${resp.status}): ${url.substring(0, 80)}`);
      return null;
    } catch (err) {
      Logger.debug(`Image check failed: ${url.substring(0, 80)} — ${err.message}`);
      return null;
    }
  }
}
