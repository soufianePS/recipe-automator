/**
 * Shared helper: connect to the dedicated Chrome started by launch-chrome-cdp.bat
 * (running with --remote-debugging-port=9222), or fall back to launching a
 * Playwright Chromium with stealth.
 *
 * Usage in a test script:
 *   import { getContextAndPage } from './_cdp-helper.js';
 *   const { ctx, page, mode } = await getContextAndPage({ url: 'https://chatgpt.com/' });
 */

import { chromium as chromiumStealth } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { chromium as chromiumRaw } from 'playwright';

chromiumStealth.use(StealthPlugin());

const CDP_URLS = ['http://127.0.0.1:9222', 'http://localhost:9222'];

async function tryConnect() {
  for (const url of CDP_URLS) {
    try {
      const browser = await chromiumRaw.connectOverCDP(url, { timeout: 4000 });
      return { browser, url };
    } catch {}
  }
  return null;
}

export async function getContextAndPage({ url, profileDir = null, viewport = { width: 1280, height: 900 } } = {}) {
  // Try CDP first
  const cdp = await tryConnect();
  if (cdp) {
    const browser = cdp.browser;
    const contexts = browser.contexts();
    const ctx = contexts[0] || await browser.newContext();
    let page;
    if (url) {
      const existing = ctx.pages().find(p => p.url().includes(new URL(url).hostname));
      page = existing || await ctx.newPage();
      if (!existing) await page.goto(url, { waitUntil: 'domcontentloaded' });
    } else {
      page = ctx.pages()[0] || await ctx.newPage();
    }
    console.log(`[cdp-helper] connected via CDP (${cdp.url}) — using your real Chrome`);
    return { browser, ctx, page, mode: 'cdp', cleanup: async () => { /* don't close real Chrome */ } };
  } else {
    console.log('[cdp-helper] CDP connect failed (Chrome not running on port 9222) — falling back to launchPersistentContext + stealth');
  }

  if (!profileDir) {
    throw new Error('CDP unavailable and no profileDir provided for fallback. Either run scripts/launch-chrome-cdp.bat first, or pass profileDir.');
  }
  const ctx = await chromiumStealth.launchPersistentContext(profileDir, {
    headless: false,
    viewport,
  });
  const page = await ctx.newPage();
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`[cdp-helper] launched stealth Chromium with profile: ${profileDir}`);
  return { browser: null, ctx, page, mode: 'stealth', cleanup: async () => { await ctx.close().catch(() => {}); } };
}
