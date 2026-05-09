/**
 * Inspector — opens gemini.google.com, clicks the composer "+" button,
 * lists every visible menu item, and saves screenshot + HTML for analysis.
 *
 * Goal: find the actual selectors for "Deep Research", "Search the web", or
 * any other tool worth activating before sending the recipe-intro turn.
 *
 * Usage:
 *   node scripts/inspect-gemini-plus.js
 *
 * Output: output/_inspect/gemini-plus-<ts>.png + .html + summary text
 */

import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
chromium.use(StealthPlugin());
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'output', '_inspect');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const account = await FlowAccountManager.getActiveAccount();
  if (!account) {
    console.error('No active Flow account. Open dashboard → Flow Accounts.');
    process.exit(1);
  }
  const profileDir = FlowAccountManager.getProfileDir(account);
  console.log(`[inspect] using profile: ${profileDir}`);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const page = await ctx.newPage();
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  const ts = Date.now();
  const beforePath = join(OUT_DIR, `gemini-plus-before-${ts}.png`);
  await page.screenshot({ path: beforePath, fullPage: false });
  console.log(`[inspect] before screenshot: ${beforePath}`);

  // List every clickable button near the prompt input — looking for "+", tools, etc.
  const composerBtns = await page.evaluate(() => {
    const promptInput = document.querySelector('rich-textarea, [contenteditable="true"]');
    if (!promptInput) return [];
    let composer = promptInput;
    for (let i = 0; i < 8; i++) {
      if (!composer.parentElement) break;
      composer = composer.parentElement;
    }
    const btns = Array.from(composer.querySelectorAll('button, [role="button"]'));
    return btns
      .filter(b => b.offsetWidth > 0 && b.offsetHeight > 0)
      .map(b => ({
        label: b.getAttribute('aria-label') || '',
        title: b.getAttribute('title') || '',
        testId: b.getAttribute('data-testid') || b.getAttribute('data-test-id') || '',
        text: (b.innerText || '').trim().slice(0, 60),
      }));
  });
  console.log('\n[inspect] composer buttons (BEFORE clicking +):');
  composerBtns.forEach((b, i) => console.log(`  ${i + 1}. label="${b.label}" testid="${b.testId}" text="${b.text}"`));

  // Click the "Outils" button specifically (not Importer un fichier)
  const plusClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of candidates) {
      if (b.offsetWidth === 0) continue;
      const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
      if (txt === 'outils' || txt === 'tools') {
        b.click();
        return { text: txt };
      }
    }
    return null;
  });
  console.log(`\n[inspect] clicked: ${plusClicked ? JSON.stringify(plusClicked) : '(Outils button not found)'}`);
  await page.waitForTimeout(1500);

  const afterPath = join(OUT_DIR, `gemini-plus-after-${ts}.png`);
  await page.screenshot({ path: afterPath, fullPage: false });
  console.log(`[inspect] after screenshot: ${afterPath}`);

  // Save full HTML after click — captures any popover/portal
  const htmlPath = join(OUT_DIR, `gemini-plus-after-${ts}.html`);
  writeFileSync(htmlPath, await page.content());
  console.log(`[inspect] html: ${htmlPath}`);

  // List ALL visible menu/option items in the DOM
  const items = await page.evaluate(() => {
    const out = [];
    const all = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], button'));
    for (const el of all) {
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (!txt) continue;
      if (txt.length > 80) continue;
      out.push({
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: txt.slice(0, 80),
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
      });
    }
    return out;
  });
  console.log(`\n[inspect] all visible menu items / clickables (${items.length}):`);
  // Filter to interesting items only
  const interesting = items.filter(it => /tool|outil|recherche|search|web|deep|canvas|image|search|grounding|fichier|file|attach|importer|upload/i.test(it.text + ' ' + it.ariaLabel));
  interesting.forEach((it, i) => {
    console.log(`  ${i + 1}. role=${it.role} text="${it.text}" testid="${it.testId}" aria="${it.ariaLabel}"`);
  });

  await page.close().catch(() => {});
  await ctx.close().catch(() => {});
  console.log('\n[inspect] done');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
