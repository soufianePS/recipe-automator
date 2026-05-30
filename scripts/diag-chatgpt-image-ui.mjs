/**
 * Diagnostic: explore ChatGPT's composer UI to see what tools / image
 * options / aspect-ratio selectors are currently available.
 *
 * Use this to refine selectors when ChatGPT redesigns. Output is a structured
 * JSON dump of:
 *   - Composer "+" button presence + selector
 *   - Items in the tools menu when "+" is clicked
 *   - Any aspect-ratio selectors visible
 *   - Generated image URLs sniffed from network
 *
 * Usage:
 *   node scripts/diag-chatgpt-image-ui.mjs                  # use default path
 *   node scripts/diag-chatgpt-image-ui.mjs --path=C:\...    # custom path
 *   node scripts/diag-chatgpt-image-ui.mjs --gen            # also send a test image-gen prompt
 *
 * Requirement: you must have logged in to ChatGPT in the profile once
 * (via Settings → Open profile + login).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const customPath = args.find(a => a.startsWith('--path='))?.slice(7);
const DO_GEN = args.includes('--gen');
const PROFILE_PATH = customPath || join(PROJECT_ROOT, 'data', 'chatgpt-pin-profile');
const TARGET_URL = 'https://chatgpt.com/?temporary-chat=true&utm_source=chatgpt.com';

const ok   = m => console.log(`\x1b[32m[OK]\x1b[0m   ${m}`);
const info = m => console.log(`\x1b[34m[INFO]\x1b[0m ${m}`);
const warn = m => console.log(`\x1b[33m[WARN]\x1b[0m ${m}`);
const err  = m => console.log(`\x1b[31m[ERR]\x1b[0m  ${m}`);

async function main() {
  console.log('━'.repeat(60));
  console.log(' ChatGPT UI Diagnostic');
  console.log('━'.repeat(60));
  info(`Profile: ${PROFILE_PATH}`);
  if (!existsSync(PROFILE_PATH)) {
    warn(`Profile path does not exist — will be created on first run.`);
    warn(`If first run, you'll need to log in to ChatGPT manually in the window that opens.`);
  }
  info(`Target URL: ${TARGET_URL}`);

  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = context.pages()[0] || (await context.newPage());

  // Capture network responses (image URLs)
  const sniffed = new Set();
  page.on('response', (response) => {
    try {
      const url = response.url();
      if (!/oaiusercontent|sdmntp|cdn\.openai\.com/i.test(url)) return;
      const ct = (response.headers()['content-type'] || '').toLowerCase();
      if (!ct.startsWith('image/') && !/\.(png|jpg|jpeg|webp)(\?|$)/i.test(url)) return;
      sniffed.add(url);
    } catch {}
  });

  info('Opening ChatGPT...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Check if logged in
  const loggedIn = await page.evaluate(() => {
    return !!document.querySelector('#prompt-textarea, div[contenteditable="true"][data-placeholder]');
  });
  if (!loggedIn) {
    warn('Not logged in. Login manually in the window, then re-run this script.');
    console.log('Browser stays open — close it when done.');
    return;
  }
  ok('ChatGPT loaded + logged in.');

  // ── 1. Probe composer "+" button ──────────────────────────────
  info('Probing composer "+" / tools button...');
  const plusInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const matches = [];
    for (const b of btns) {
      if (b.offsetWidth === 0) continue;
      const id = (b.getAttribute('data-testid') || '').toLowerCase();
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.textContent || '').trim().slice(0, 50);
      if (id.includes('composer') || id.includes('tool') || id.includes('plus') || id.includes('add') ||
          lbl.includes('add files') || lbl.includes('ajouter') || lbl.includes('attach') ||
          lbl.includes('plus') || lbl.includes('outils') || lbl.includes('tools')) {
        matches.push({ testid: id, aria: lbl, text });
      }
    }
    return matches;
  });
  console.log('  Composer button candidates:');
  for (const m of plusInfo) console.log(`    • testid="${m.testid}" aria="${m.aria}" text="${m.text}"`);
  if (plusInfo.length === 0) warn('  No composer button matched our heuristics — UI may have changed.');

  // ── 2. Click "+" and see what menu opens ────────────────────────
  info('Clicking the first composer match + dumping menu items...');
  const plusClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of btns) {
      if (b.offsetWidth === 0) continue;
      const id = (b.getAttribute('data-testid') || '').toLowerCase();
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      if (id === 'composer-plus-btn' || id.includes('composer-add') ||
          lbl.includes('add files') || lbl.includes('ajouter des fichiers') ||
          lbl.includes('attach')) {
        b.click();
        return { id, aria: lbl };
      }
    }
    return null;
  });
  if (plusClicked) {
    ok(`  Clicked: testid="${plusClicked.id}" aria="${plusClicked.aria}"`);
    await page.waitForTimeout(1000);
    const menuItems = await page.evaluate(() => {
      const items = document.querySelectorAll('div[role="menuitem"], [role="option"], button, a');
      const out = [];
      for (const it of items) {
        if (it.offsetWidth === 0) continue;
        const text = (it.textContent || '').trim();
        if (!text || text.length > 80) continue;
        out.push({ role: it.getAttribute('role') || it.tagName.toLowerCase(), text });
      }
      return out;
    });
    console.log(`  Menu items visible after click (${menuItems.length} total):`);
    for (const it of menuItems.slice(0, 30)) console.log(`    • [${it.role}] "${it.text}"`);
    // Close menu
    await page.keyboard.press('Escape').catch(() => {});
  } else {
    warn('  Could not click any composer button.');
  }

  // ── 3. Optional: send a test image generation prompt ────────────
  if (DO_GEN) {
    info('Sending test image-gen prompt...');
    const prompt = 'Generate a vertical 1024x1536 portrait food photo: a beautifully plated chicken pasta dish on a wooden table, top-down view, soft natural lighting.';
    const input = await page.waitForSelector('#prompt-textarea, div[contenteditable="true"][data-placeholder]', { timeout: 10000 });
    await input.click();
    await page.keyboard.type(prompt, { delay: 10 });
    await page.waitForTimeout(500);
    // Click send
    const sendBtn = await page.$('button[data-testid="send-button"], button[aria-label="Send prompt"]');
    if (sendBtn) await sendBtn.click();
    info('  Prompt sent. Watching for image generation (max 4 min)...');
    const deadline = Date.now() + 240_000;
    let imageFound = null;
    while (Date.now() < deadline) {
      if (sniffed.size > 0) {
        imageFound = [...sniffed].slice(-1)[0];
        break;
      }
      await page.waitForTimeout(3000);
      process.stdout.write('.');
    }
    console.log();
    if (imageFound) {
      ok(`  Image generation succeeded! URL: ${imageFound}`);
      ok(`  Total sniffed: ${sniffed.size}`);
      console.log('  All sniffed URLs:');
      for (const u of sniffed) console.log(`    → ${u}`);
    } else {
      warn('  No image was sniffed in 4 min — generation may have failed or ChatGPT did not produce an image.');
    }
  }

  // ── Wrap up ─────────────────────────────────────────────────────
  console.log();
  console.log('━'.repeat(60));
  info('Diagnostic complete. Browser stays open — close it manually.');
  console.log('━'.repeat(60));
}

main().catch(e => {
  err('Failed: ' + e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
