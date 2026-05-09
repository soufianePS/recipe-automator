/**
 * Long-running brainstorm session with ChatGPT, using the user's logged-in profile.
 *
 * File-based message queue:
 *  - Write to data/brainstorm-input.txt → script types it into ChatGPT
 *  - Response written to data/brainstorm-output.txt
 *
 * Self-contained: doesn't depend on ChatGPTPage class (which uses outdated selectors).
 * Uses fresh selectors that work on current chatgpt.com UI (May 2026).
 */

import { chromium } from 'playwright';
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INPUT_FILE = join(ROOT, 'data', 'brainstorm-input.txt');
const OUTPUT_FILE = join(ROOT, 'data', 'brainstorm-output.txt');

// Robust selectors for current ChatGPT UI (May 2026)
const PROMPT_INPUT_SELS = [
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"][role="textbox"]',
  '#prompt-textarea',
  'textarea[name="prompt-textarea"]',
];

async function findPromptInput(page) {
  for (const sel of PROMPT_INPUT_SELS) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function typePrompt(page, text) {
  const input = await findPromptInput(page);
  if (!input) throw new Error('Prompt input not found');
  await input.click();
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(80);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(500);
  // Verify
  const len = await page.evaluate((sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetWidth > 0) return (el.textContent || el.value || '').trim().length;
    }
    return 0;
  }, PROMPT_INPUT_SELS);
  if (len < Math.min(20, text.length / 2)) {
    // Clipboard fallback
    await page.evaluate(async ({ t, sels }) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        return;
      }
    }, { t: text, sels: PROMPT_INPUT_SELS });
    await page.waitForTimeout(500);
  }
}

async function clickSend(page) {
  // Wait for the send button to become enabled (it's disabled while empty)
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sendBtn = btns.find(b => {
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        const id = b.getAttribute('data-testid') || '';
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
        return al.includes('send') || al.includes('envoyer') || id === 'send-button' || id.includes('send');
      });
      if (sendBtn) { sendBtn.click(); return true; }
      return false;
    });
    if (clicked) return;
    await page.waitForTimeout(500);
  }
  // Fallback: Enter
  await page.keyboard.press('Enter');
}

async function waitForResponseComplete(page, timeoutMs = 600000) {
  // Strategy: wait for the "stop generating" button to disappear (means response done)
  const start = Date.now();
  let sawStop = false;
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(2000);
    const generating = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => {
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        const id = b.getAttribute('data-testid') || '';
        if (b.offsetWidth === 0) return false;
        return al.includes('stop') || al.includes('arrêter') || id === 'stop-button';
      });
    });
    if (generating) { sawStop = true; continue; }
    if (sawStop) {
      // Confirm done with a few stable checks
      let stable = 0;
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(800);
        const stillGen = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.some(b => {
            const al = (b.getAttribute('aria-label') || '').toLowerCase();
            return (al.includes('stop') || al.includes('arrêter')) && b.offsetWidth > 0;
          });
        });
        if (!stillGen) stable++;
        else stable = 0;
      }
      if (stable >= 3) return;
    }
  }
}

async function extractLatestResponse(page) {
  return await page.evaluate(() => {
    // Find all assistant messages — try several patterns
    const sels = [
      '[data-message-author-role="assistant"]',
      '.markdown.prose',
      'div[data-testid^="conversation-turn-"]'
    ];
    let blocks = [];
    for (const s of sels) {
      blocks = Array.from(document.querySelectorAll(s));
      if (blocks.length > 0) break;
    }
    if (blocks.length === 0) return '(no response found)';
    const last = blocks[blocks.length - 1];
    return (last.innerText || '').trim();
  });
}

(async () => {
  const account = await FlowAccountManager.getActiveAccount();
  if (!account) { console.error('No active account'); process.exit(1); }
  const profileDir = FlowAccountManager.getProfileDir(account);
  console.log(`[brainstorm] profile=${profileDir}`);

  mkdirSync(dirname(INPUT_FILE), { recursive: true });
  if (!existsSync(INPUT_FILE)) writeFileSync(INPUT_FILE, '', 'utf8');
  writeFileSync(OUTPUT_FILE, '(waiting for first message...)', 'utf8');

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = await ctx.newPage();
  // Retry navigation — DNS sometimes hiccups on first hit after Chrome launch
  let navOk = false;
  for (const url of ['https://chatgpt.com/', 'https://chat.openai.com/']) {
    for (let i = 0; i < 3; i++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        navOk = true;
        console.log(`[brainstorm] navigated to ${url}`);
        break;
      } catch (e) {
        console.log(`[brainstorm] nav attempt ${i + 1} to ${url} failed: ${e.message.split('\n')[0]}`);
        await page.waitForTimeout(3000);
      }
    }
    if (navOk) break;
  }
  if (!navOk) throw new Error('Could not navigate to ChatGPT after retries');
  await page.waitForTimeout(4000);

  // Try to find the input — wait up to 30s
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const input = await findPromptInput(page);
    if (input) break;
    await page.waitForTimeout(1000);
  }
  console.log('[brainstorm] page ready, polling for messages...');

  let lastSeenInput = '';
  let turn = 0;
  while (true) {
    await new Promise(r => setTimeout(r, 2000));
    let input = '';
    try { input = readFileSync(INPUT_FILE, 'utf8').trim(); } catch {}
    if (!input || input === lastSeenInput) continue;

    lastSeenInput = input;
    turn++;
    console.log(`\n[brainstorm] === Turn ${turn} ===`);
    console.log('[brainstorm] sending message:', input.slice(0, 120) + (input.length > 120 ? '...' : ''));
    writeFileSync(OUTPUT_FILE, '(waiting for response, turn ' + turn + '...)', 'utf8');

    try {
      await typePrompt(page, input);
      await clickSend(page);
      await waitForResponseComplete(page);
      const responseText = await extractLatestResponse(page);
      writeFileSync(OUTPUT_FILE, `=== Turn ${turn} response ===\n\n${responseText}`, 'utf8');
      console.log('[brainstorm] response saved (' + (responseText.length || 0) + ' chars)');
    } catch (e) {
      writeFileSync(OUTPUT_FILE, `=== Turn ${turn} error ===\n\n${e.message}\n${e.stack || ''}`, 'utf8');
      console.error('[brainstorm] error:', e.message);
    }
  }
})();
