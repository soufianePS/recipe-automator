/**
 * Inspector — opens chatgpt.com in CDP Chrome, lists every visible button/clickable
 * element matching "recherche" / "search" / "web", and saves screenshot + HTML.
 *
 * Goal: find the right selector for the web-search toggle.
 *
 * Usage:
 *   node scripts/inspect-chatgpt-search.js
 *
 * Output: output/_inspect/chatgpt-search-<ts>.png + .html + summary text
 */

import { getContextAndPage } from './_cdp-helper.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'output', '_inspect');

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const { ctx, mode, cleanup } = await getContextAndPage({ url: null });
  console.log(`[inspect] mode=${mode}`);
  if (mode !== 'cdp') {
    console.error('Need CDP mode (real Chrome). Run scripts/launch-chrome-cdp.bat first.');
    process.exit(1);
  }

  // Close existing chatgpt tabs to start fresh
  for (const p of ctx.pages().filter(p => p.url().includes('chatgpt.com'))) {
    await p.close().catch(() => {});
  }

  const page = await ctx.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // 1. Take screenshot
  const ts = Date.now();
  const screenshotPath = join(OUT_DIR, `chatgpt-search-${ts}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`[inspect] screenshot: ${screenshotPath}`);

  // 2. Save HTML
  const htmlPath = join(OUT_DIR, `chatgpt-search-${ts}.html`);
  writeFileSync(htmlPath, await page.content());
  console.log(`[inspect] html: ${htmlPath}`);

  // 3a. Click the composer "+" button via real Playwright (proper events for Radix popovers)
  const plusBtn = await page.$('button[data-testid="composer-plus-btn"]');
  if (!plusBtn) {
    console.log('[inspect] composer-plus-btn not found in DOM');
  } else {
    await plusBtn.click();
    console.log('[inspect] composer-plus clicked via Playwright');
    await page.waitForTimeout(1500);
  }

  // 3b. Take screenshot of the now-open menu
  const menuShotPath = join(OUT_DIR, `chatgpt-search-menu-${ts}.png`);
  await page.screenshot({ path: menuShotPath, fullPage: false });
  console.log(`[inspect] menu screenshot: ${menuShotPath}`);

  // 3c. Save HTML AFTER the click — for offline inspection of the popover content
  const htmlAfterPath = join(OUT_DIR, `chatgpt-search-after-click-${ts}.html`);
  writeFileSync(htmlAfterPath, await page.content());
  console.log(`[inspect] html-after-click: ${htmlAfterPath}`);

  // 3d. List ALL visible clickables that appeared via popover (Radix often uses [data-state="open"] or portals)
  const popoverItems = await page.evaluate(() => {
    // Strategy A: Radix popper portals
    const portals = Array.from(document.querySelectorAll(
      '[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"], [data-state="open"]'
    ));
    const fromPortal = [];
    for (const portal of portals) {
      const clickables = portal.querySelectorAll('button, [role="menuitem"], [role="option"], a, div[role="button"], [tabindex="0"]');
      for (const c of clickables) {
        if (c.offsetWidth === 0 && c.offsetHeight === 0) continue;
        fromPortal.push({
          source: 'portal',
          text: (c.innerText || c.textContent || '').trim().slice(0, 100),
          ariaLabel: c.getAttribute('aria-label') || '',
          testId: c.getAttribute('data-testid') || '',
          tag: c.tagName.toLowerCase(),
          html: c.outerHTML.slice(0, 200).replace(/\s+/g, ' '),
        });
      }
    }
    // Strategy B: any element with text containing search/web/recherche that wasn't there before
    const hits = Array.from(document.querySelectorAll('*')).filter(el => {
      if (el.children.length > 0) return false; // leaf nodes only
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
      const txt = (el.textContent || '').trim().toLowerCase();
      return txt && txt.length < 60 && (
        txt.includes('search') || txt.includes('recherche') || txt.includes('web')
      );
    });
    const fromText = hits.map(el => ({
      source: 'text-leaf',
      text: el.textContent.trim().slice(0, 80),
      tag: el.tagName.toLowerCase(),
      parentTag: el.parentElement?.tagName.toLowerCase() || '',
      parentRole: el.parentElement?.getAttribute('role') || '',
      parentTestId: el.parentElement?.getAttribute('data-testid') || '',
    }));
    return { fromPortal, fromText };
  });
  console.log(`\n[inspect] Popover/portal items after clicking "+":  (${popoverItems.fromPortal.length})\n`);
  popoverItems.fromPortal.forEach((m, i) => {
    console.log(`  ${i + 1}. tag=${m.tag} text="${m.text}" testId="${m.testId}" aria="${m.ariaLabel}"`);
    console.log(`     html: ${m.html.slice(0, 180)}`);
  });
  console.log(`\n[inspect] Text-leaf elements with search/recherche/web:  (${popoverItems.fromText.length})\n`);
  popoverItems.fromText.forEach((m, i) => {
    console.log(`  ${i + 1}. text="${m.text}" parent=${m.parentTag}[role="${m.parentRole}"][testid="${m.parentTestId}"]`);
  });

  // List candidates: every clickable that contains "search" / "recherche" / "web"
  const candidates = await page.evaluate(() => {
    const allClickable = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"]'));
    const matches = [];
    for (const el of allClickable) {
      if (el.offsetWidth === 0 && el.offsetHeight === 0) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      const ariaLabel = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const testId = el.getAttribute('data-testid') || '';
      const haystack = `${txt} ${ariaLabel} ${title} ${testId}`.toLowerCase();
      if (haystack.includes('search') || haystack.includes('recherche') || haystack.includes('web')) {
        // Build a unique CSS selector hint
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.')
          : '';
        matches.push({
          tag,
          id,
          cls: cls.slice(0, 100),
          testId,
          ariaLabel: ariaLabel.slice(0, 80),
          title: title.slice(0, 80),
          text: txt.slice(0, 80),
          width: el.offsetWidth,
          height: el.offsetHeight,
          // Show the OUTER HTML structure (parent + self)
          outerHtml: el.outerHTML.slice(0, 300),
        });
      }
    }
    return matches;
  });

  console.log(`\n[inspect] Found ${candidates.length} clickable elements with "search" / "recherche" / "web":\n`);
  let i = 0;
  for (const c of candidates) {
    i++;
    console.log(`#${i}`);
    console.log(`  tag:        ${c.tag}${c.id}`);
    console.log(`  testId:     "${c.testId}"`);
    console.log(`  aria-label: "${c.ariaLabel}"`);
    console.log(`  title:      "${c.title}"`);
    console.log(`  text:       "${c.text}"`);
    console.log(`  size:       ${c.width}×${c.height}`);
    console.log(`  outerHtml:  ${c.outerHtml.replace(/\s+/g, ' ').slice(0, 200)}`);
    console.log('');
  }

  // 4. Save summary
  const summaryPath = join(OUT_DIR, `chatgpt-search-${ts}.txt`);
  writeFileSync(summaryPath, [
    `Snapshot: ${new Date().toISOString()}`,
    `URL: ${page.url()}`,
    `Candidates: ${candidates.length}`,
    '',
    ...candidates.map((c, i) => [
      `#${i + 1}`,
      `  tag:        ${c.tag}${c.id}`,
      `  testId:     "${c.testId}"`,
      `  aria-label: "${c.ariaLabel}"`,
      `  title:      "${c.title}"`,
      `  text:       "${c.text}"`,
      `  size:       ${c.width}×${c.height}`,
      `  outerHtml:  ${c.outerHtml.replace(/\s+/g, ' ').slice(0, 250)}`,
      '',
    ].join('\n')),
  ].join('\n'));
  console.log(`[inspect] summary saved: ${summaryPath}`);

  await page.close().catch(() => {});
  await cleanup();
}

main().catch(e => {
  console.error('[inspect] FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
