/**
 * Lighthouse Audit — runs Lighthouse against a published/preview post URL
 * and logs performance, SEO, accessibility scores + core web vitals.
 * Non-blocking: never throws into the pipeline.
 */

import { chromium } from 'playwright';
import { Logger } from './logger.js';

/**
 * Run a Lighthouse audit on a URL using a headless Chromium instance.
 * @param {string} url - URL to audit (public, not a draft)
 * @returns {null|object} summary scores, or null on failure
 */
export async function runLighthouseAudit(url) {
  if (!url) return null;

  let browser;
  try {
    // Dynamic import — lighthouse is ESM and heavy; only load when used
    const { default: lighthouse } = await import('lighthouse');

    Logger.info(`[Lighthouse] Auditing ${url}...`);
    browser = await chromium.launch({
      headless: true,
      args: ['--remote-debugging-port=9222']
    });

    const { port } = new URL(browser.wsEndpoint());
    const result = await lighthouse(url, {
      port: 9222,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance', 'seo', 'accessibility', 'best-practices']
    });

    if (!result?.lhr) {
      Logger.warn('[Lighthouse] No result returned');
      return null;
    }

    const c = result.lhr.categories;
    const a = result.lhr.audits;
    const score = (cat) => cat ? Math.round(cat.score * 100) : null;

    const summary = {
      url,
      performance: score(c.performance),
      seo: score(c.seo),
      accessibility: score(c.accessibility),
      bestPractices: score(c['best-practices']),
      lcp: a['largest-contentful-paint']?.displayValue || '',
      cls: a['cumulative-layout-shift']?.displayValue || '',
      fcp: a['first-contentful-paint']?.displayValue || '',
      tbt: a['total-blocking-time']?.displayValue || '',
      auditedAt: new Date().toISOString()
    };

    Logger.success(
      `[Lighthouse] Perf: ${summary.performance} | SEO: ${summary.seo} | A11y: ${summary.accessibility} | LCP: ${summary.lcp} | CLS: ${summary.cls}`
    );

    return summary;
  } catch (e) {
    Logger.warn(`[Lighthouse] Audit failed (non-fatal): ${e.message}`);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
}
