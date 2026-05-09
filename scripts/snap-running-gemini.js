/**
 * Snapshot the currently-open Gemini chat tab from the running server's
 * browser context — without disturbing the orchestrator. Connects via the
 * persistent profile dir.
 */
import { chromium } from 'playwright';
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

(async () => {
  const account = await FlowAccountManager.getActiveAccount();
  const profileDir = FlowAccountManager.getProfileDir(account);
  console.log('Trying to connect to existing profile:', profileDir);

  // Can't really attach to a running persistent context — instead, write a
  // throwaway page that screenshots gemini.google.com from a sibling browser.
  // This will use the SAME profile so it sees the same logged-in account,
  // but it opens its own browser instance — meaning the live one might be
  // locked (one process per profile). We try anyway and fall back gracefully.
  try {
    const ctx = await chromium.launchPersistentContext(profileDir + '-snap', {
      headless: false,
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const out = join(__dirname, '..', 'screenshots', `snap-gemini-${Date.now()}.png`);
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out, fullPage: false });
    console.log('Saved:', out);
    await page.waitForTimeout(2000);
    await ctx.close();
  } catch (e) {
    console.error('Snap failed:', e.message);
  }
})();
