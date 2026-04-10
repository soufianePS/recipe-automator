/**
 * ChatGPT Page Object — Playwright automation for ChatGPT
 *
 * Replaces: content-scripts/chatgpt.js + tab management
 * Uses Playwright's native selectors, waits, and error handling
 */

import { Logger } from '../utils/logger.js';
import { Parser } from '../utils/parser.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', '..', '..', 'screenshots');

// Selectors — update these when ChatGPT changes UI
const SEL = {
  promptInput: '#prompt-textarea, div[contenteditable="true"][data-placeholder]',
  sendButton: 'button[data-testid="send-button"]',
  sendButtonAlt: 'button[aria-label="Send prompt"]',
  stopButton: 'button[aria-label="Stop streaming"], button[data-testid="stop-button"], button[aria-label="Stop generating"]',
  assistantMessage: 'div[data-message-author-role="assistant"]',
  codeBlock: 'pre code',
};

export class ChatGPTPage {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
    this.page = null;
  }

  /**
   * Open a fresh ChatGPT page.
   * @param {string|null} gptUrl — custom GPT URL (e.g. https://chatgpt.com/g/g-xxx-name), or null for vanilla ChatGPT
   */
  async init(gptUrl = null) {
    // Always start a fresh ChatGPT page to avoid old conversation interference
    const pages = this.context.pages();
    const existing = pages.find(p => p.url().includes('chatgpt.com'));
    if (existing) {
      await existing.close().catch(() => {});
    }

    this.page = await this.context.newPage();
    const targetUrl = gptUrl || 'https://chatgpt.com/';
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(3000);

    // Custom GPTs may show an intro screen — wait for prompt input to be ready
    if (gptUrl) {
      await this._dismissGptIntro();
    }

    Logger.info(`ChatGPT page ready (${gptUrl ? 'Custom GPT' : 'fresh chat'})`);
    return this;
  }

  /**
   * Handle custom GPT landing state — wait for prompt input to become available.
   * Custom GPTs show their description and conversation starters on first load.
   */
  async _dismissGptIntro() {
    try {
      await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
      const input = await this.page.$(SEL.promptInput);
      if (input) await input.click();
      await this.page.waitForTimeout(500);
    } catch (e) {
      Logger.debug('Custom GPT intro handling:', e.message);
    }
  }

  async screenshot(name) {
    try {
      await this.page.screenshot({
        path: join(SCREENSHOTS_DIR, `chatgpt-${name}-${Date.now()}.png`),
        fullPage: false
      });
    } catch (e) {
      Logger.debug('Screenshot failed:', e.message);
    }
  }

  /**
   * Send a prompt and get the full response
   */
  async sendPromptAndGetResponse(prompt, expectJSON = false) {
    Logger.step('ChatGPT', 'Sending prompt...');
    await this.screenshot('before-prompt');

    // Wait for input
    const input = await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    await input.click();
    await this.page.waitForTimeout(300);

    // Clear and paste the prompt
    await this._pastePrompt(prompt);
    await this.page.waitForTimeout(500);

    // Click send
    await this._clickSend();
    Logger.debug('Send clicked');
    await this.screenshot('after-send');

    // Wait for response to complete
    const responseText = await this._waitForResponse();
    Logger.success('Response received:', responseText.substring(0, 100) + '...');
    await this.screenshot('response-complete');

    if (expectJSON) {
      const json = Parser.extractJSON(responseText);
      if (!json) {
        Logger.warn(`JSON parse failed. Response length: ${responseText.length} chars. First 200: ${responseText.substring(0, 200)}`);
        Logger.warn('Requesting JSON fix from ChatGPT...');
        return await this._retryJSON();
      }
      return { success: true, data: json };
    }

    return { success: true, data: responseText };
  }

  async _pastePrompt(text) {
    const input = await this.page.$(SEL.promptInput);
    if (!input) throw new Error('Prompt input not found');

    await input.click();
    await this.page.waitForTimeout(100);

    // Clear existing text using keyboard (avoids Trusted Types innerHTML restriction)
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press('Delete');
    await this.page.waitForTimeout(100);

    // Insert text using Playwright's insertText (works with contenteditable)
    await this.page.keyboard.insertText(text);
    await this.page.waitForTimeout(300);

    // Verify text was inserted
    const content = await this.page.evaluate(() => {
      const el = document.querySelector('#prompt-textarea, div[contenteditable="true"][data-placeholder]');
      return el?.textContent?.trim() || '';
    });

    if (!content) {
      // Fallback: clipboard paste event
      Logger.debug('insertText failed, trying clipboard paste...');
      await this.page.evaluate(async (text) => {
        const input = document.querySelector('#prompt-textarea, div[contenteditable="true"][data-placeholder]');
        if (!input) return;
        input.focus();
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', text);
        input.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true, cancelable: true, clipboardData
        }));
      }, text);
      await this.page.waitForTimeout(300);
    }
  }

  async _clickSend() {
    // Wait for send button to become enabled (files may still be processing)
    await this.page.waitForTimeout(1000);

    // Try multiple selectors — including broader searches
    const selectors = [
      SEL.sendButton,
      SEL.sendButtonAlt,
      'button[aria-label="Envoyer le prompt"]',
      'button[aria-label="Envoyer"]',
      'form button[type="submit"]',
    ];

    // Retry a few times — send button may take time to enable after file upload
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const sel of selectors) {
        const btn = await this.page.$(sel);
        if (btn) {
          const disabled = await btn.getAttribute('disabled');
          if (disabled === null) {
            await btn.click();
            Logger.debug(`Send clicked via: ${sel}`);
            return;
          }
        }
      }

      // Also try finding send button by SVG arrow icon
      const clicked = await this.page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const btn of btns) {
          const testId = btn.getAttribute('data-testid') || '';
          const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
          if (testId.includes('send') || ariaLabel.includes('send') || ariaLabel.includes('envoyer')) {
            if (!btn.disabled) {
              btn.click();
              return true;
            }
          }
        }
        return false;
      });
      if (clicked) {
        Logger.debug('Send clicked via evaluate search');
        return;
      }

      Logger.debug(`Send button not found/enabled (attempt ${attempt + 1}/3), waiting...`);
      await this.page.waitForTimeout(2000);
    }

    // Last fallback: Enter key
    Logger.debug('No send button found after retries, trying Enter key...');
    await this.page.keyboard.press('Enter');
  }

  async _waitForResponse() {
    const TIMEOUT = 1200000; // 20 minutes safety cap (polls every 1s, detects completion in ~3s)
    const POLL_INTERVAL = 1000;
    const start = Date.now();

    // 1. Wait for ChatGPT to start working (stop button or streaming appears)
    Logger.debug('[ChatGPT] Waiting for response to start...');
    let sawActivity = false;
    for (let i = 0; i < 30; i++) { // up to 30s for thinking to begin
      await this.page.waitForTimeout(POLL_INTERVAL);
      const active = await this._isChatGPTActive();
      if (active) {
        sawActivity = true;
        Logger.debug('[ChatGPT] Response started (stop button or streaming detected)');
        break;
      }
      // Also check if a new message appeared without stop button (very fast response)
      const hasNewMsg = await this.page.evaluate(() => {
        const msgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
        return msgs.length > 0 && (msgs[msgs.length - 1]?.textContent?.length || 0) > 10;
      });
      if (hasNewMsg) {
        Logger.debug('[ChatGPT] Response appeared without stop button (fast response)');
        sawActivity = true;
        break;
      }
    }

    if (!sawActivity) {
      Logger.warn('[ChatGPT] No activity detected after 30s — checking for response anyway');
    }

    // 2. Poll until ChatGPT is done: no stop button AND no streaming class
    Logger.debug('[ChatGPT] Waiting for response to complete...');
    let doneCount = 0;
    while (Date.now() - start < TIMEOUT) {
      await this.page.waitForTimeout(POLL_INTERVAL);

      const active = await this._isChatGPTActive();
      if (!active) {
        doneCount++;
        // Require 3 consecutive "done" checks to avoid false positives
        if (doneCount >= 3) {
          Logger.debug('[ChatGPT] Response complete (no stop button, no streaming for 3 checks)');
          break;
        }
      } else {
        doneCount = 0;
      }
    }

    if (Date.now() - start >= TIMEOUT) {
      Logger.warn('[ChatGPT] Response wait timeout after 5 minutes — extracting what we have');
    }

    // 3. Small extra wait for UI to finalize
    await this.page.waitForTimeout(1500);

    return await this._extractResponse();
  }

  /**
   * Check if ChatGPT is still actively working (thinking, streaming, or generating).
   * Returns true if the stop button exists OR the streaming class is present.
   */
  async _isChatGPTActive() {
    return await this.page.evaluate(() => {
      // Check stop button (most reliable — present during thinking AND streaming)
      const stopSelectors = [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label="Arrêter le streaming"]',
        'button[aria-label="Arrêter la génération"]',
      ];
      for (const sel of stopSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.getBoundingClientRect().width > 0) return true;
      }

      // Check streaming class (present while typing)
      if (document.querySelector('.result-streaming, [class*="result-streaming"]')) return true;

      return false;
    });
  }

  async _extractResponse() {
    return await this.page.evaluate(() => {
      const messages = document.querySelectorAll('div[data-message-author-role="assistant"]');
      if (messages.length === 0) throw new Error('No assistant messages found');

      const lastMessage = messages[messages.length - 1];

      // Try code blocks first (for JSON)
      const codeBlocks = lastMessage.querySelectorAll('pre code');
      if (codeBlocks.length > 0) {
        let largest = '';
        codeBlocks.forEach(block => {
          if (block.textContent.length > largest.length) largest = block.textContent;
        });
        if (largest.trim().startsWith('{') || largest.trim().startsWith('[')) {
          return largest.trim();
        }
      }

      // Full text content (remove buttons)
      const clone = lastMessage.cloneNode(true);
      clone.querySelectorAll('button').forEach(btn => btn.remove());
      return clone.textContent.trim();
    });
  }

  async _retryJSON() {
    const MAX_FIX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      Logger.info(`JSON fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}...`);
      const fixPrompt = attempt === 1
        ? 'Your previous response contained invalid JSON. Please output ONLY the valid JSON object, with no markdown, no code blocks, no explanation. Do not use em dashes or special characters. Just raw JSON starting with { and ending with }'
        : 'Still invalid. Output ONLY the raw JSON. No markdown. No code fences. No explanation. Replace all special dashes with regular dashes. Start with { end with }';

      await this._pastePrompt(fixPrompt);
      await this.page.waitForTimeout(500);
      await this._clickSend();

      const text = await this._waitForResponse();
      const json = Parser.extractJSON(text);
      if (json) return { success: true, data: json };
      Logger.warn(`JSON fix attempt ${attempt} failed`);
    }
    return { success: false, error: 'Failed to extract valid JSON after retries' };
  }

  async close() {
    if (this.page) {
      try { await this.page.close(); } catch {}
      this.page = null;
    }
  }
}
