/**
 * One-off inspector — opens Gemini chat, dumps every button + role=button
 * within ~100px of the prompt input so we can see exactly what HTML the
 * attach "+" button uses. No file uploads, just DOM dump.
 */

import { chromium } from 'playwright';
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';

async function main() {
  const account = await FlowAccountManager.getActiveAccount();
  const profileDir = FlowAccountManager.getProfileDir(account);
  console.log('Profile:', profileDir);

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  console.log('\n=== Buttons near prompt input ===\n');
  const dump = await page.evaluate(() => {
    const promptInput = document.querySelector('div.ql-editor[contenteditable="true"], rich-textarea .ql-editor');
    if (!promptInput) return { error: 'prompt input not found' };
    const inputRect = promptInput.getBoundingClientRect();
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], mat-icon-button, label'));
    const near = [];
    for (const b of buttons) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Within 200px vertically of prompt input
      const dy = Math.min(Math.abs(r.top - inputRect.top), Math.abs(r.bottom - inputRect.bottom));
      if (dy > 200) continue;
      near.push({
        tag: b.tagName,
        ariaLabel: b.getAttribute('aria-label'),
        className: b.className,
        text: (b.textContent || '').trim().slice(0, 50),
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        outerHTML: b.outerHTML.slice(0, 400),
      });
    }
    return { inputRect, near, fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).map(i => ({ name: i.name, accept: i.accept, hidden: i.hidden, html: i.outerHTML.slice(0, 300) })) };
  });
  console.log('Prompt input rect:', dump.inputRect);
  console.log('\nFile inputs found:', dump.fileInputs.length);
  for (const f of dump.fileInputs) console.log(' ', JSON.stringify(f));
  console.log('\nButtons near prompt input:', dump.near?.length || 0);
  for (const b of dump.near || []) {
    console.log(`\n  [${b.tag}] x=${b.x} y=${b.y} w=${b.w}h=${b.h}`);
    console.log(`    aria-label: ${b.ariaLabel || '(none)'}`);
    console.log(`    text: "${b.text}"`);
    console.log(`    class: ${b.className.slice(0, 100)}`);
    console.log(`    html: ${b.outerHTML.replace(/\s+/g, ' ').slice(0, 250)}`);
  }

  console.log('\nLeaving browser open 30s for manual inspection...');
  await page.waitForTimeout(30000);
  await ctx.close();
}
main();
