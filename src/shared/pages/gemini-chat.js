/**
 * Gemini Chat Page Object — Playwright automation for Gemini (gemini.google.com)
 *
 * Same interface as ChatGPTPage: init(), sendPromptAndGetResponse(), close()
 * Uses the same Google login session as Flow (no extra auth needed).
 * Supports both French and English UI.
 */

import { Logger } from '../utils/logger.js';
import { Parser } from '../utils/parser.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', '..', '..', 'screenshots');

const GEMINI_URL = 'https://gemini.google.com/app';

// Selectors — Gemini UI (supports FR/EN)
const SEL = {
  // Prompt input area
  promptInput: 'div.ql-editor[contenteditable="true"], rich-textarea .ql-editor, div[aria-label*="prompt" i], div[aria-label*="message" i][contenteditable="true"]',
  // Send button
  sendButton: 'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button.send-button, button[data-mat-icon-name="send"]',
  // Stop/cancel button (visible during generation)
  stopButton: 'button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], button[data-mat-icon-name="stop_circle"]',
  // Response container
  responseContainer: '.response-container, .model-response-text, message-content .markdown',
};

export class GeminiChatPage {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
    this.page = null;
  }

  /**
   * Open a fresh Gemini chat page.
   */
  async init() {
    // Close existing Gemini page if any
    const pages = this.context.pages();
    const existing = pages.find(p => p.url().includes('gemini.google.com'));
    if (existing) {
      await existing.close().catch(() => {});
    }

    this.page = await this.context.newPage();
    await this.page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(4000);

    // Wait for prompt input to be ready
    try {
      await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    } catch {
      // Try clicking "New chat" or dismissing welcome screen
      await this._dismissWelcome();
    }

    Logger.info('Gemini chat page ready');
    return this;
  }

  /**
   * Dismiss welcome/intro screens if present.
   */
  async _dismissWelcome() {
    try {
      // Click "New chat" / "Nouveau chat" if visible
      const newChatBtn = await this.page.$('button:has-text("New chat"), button:has-text("Nouveau chat"), button:has-text("Nouvelle conversation")');
      if (newChatBtn) await newChatBtn.click();
      await this.page.waitForTimeout(2000);

      // Click "Skip" or "Dismiss" if visible
      const skipBtn = await this.page.$('button:has-text("Skip"), button:has-text("Passer"), button:has-text("Got it"), button:has-text("OK")');
      if (skipBtn) await skipBtn.click();
      await this.page.waitForTimeout(1000);

      await this.page.waitForSelector(SEL.promptInput, { timeout: 10000 });
    } catch (e) {
      Logger.debug('Gemini welcome dismiss:', e.message);
    }
  }

  async screenshot(name) {
    try {
      await this.page.screenshot({
        path: join(SCREENSHOTS_DIR, `gemini-${name}-${Date.now()}.png`),
        fullPage: false
      });
    } catch {}
  }

  /**
   * Send a prompt and get the full response.
   * Same interface as ChatGPTPage.sendPromptAndGetResponse()
   */
  async sendPromptAndGetResponse(prompt, expectJSON = false) {
    Logger.step('Gemini', 'Sending prompt...');
    await this.screenshot('before-prompt');

    // Wait for input
    const input = await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    await input.click();
    await this.page.waitForTimeout(300);

    // Clear and type the prompt
    await this._pastePrompt(prompt);
    await this.page.waitForTimeout(500);

    // Click send
    await this._clickSend();
    Logger.debug('Gemini send clicked');
    await this.screenshot('after-send');

    // Wait for response to complete
    const responseText = await this._waitForResponse();
    Logger.success('Response received:', responseText.substring(0, 100) + '...');
    await this.screenshot('response-complete');

    if (expectJSON) {
      const json = Parser.extractJSON(responseText);
      if (!json) {
        Logger.warn(`JSON parse failed. Response length: ${responseText.length} chars. First 200: ${responseText.substring(0, 200)}`);
        Logger.warn('Requesting JSON fix from Gemini...');
        return await this._retryJSON();
      }
      return { success: true, data: json };
    }

    return { success: true, data: responseText };
  }

  async _pastePrompt(text) {
    const input = await this.page.$(SEL.promptInput);
    if (!input) throw new Error('Gemini prompt input not found');

    await input.click();
    await this.page.waitForTimeout(100);

    // Clear existing text
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press('Delete');
    await this.page.waitForTimeout(100);

    // Insert text
    await this.page.keyboard.insertText(text);
    await this.page.waitForTimeout(300);

    // Verify text was inserted
    const content = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim()?.length || 0;
    }, SEL.promptInput);

    if (content < 10) {
      // Fallback: clipboard paste
      Logger.debug('Gemini insertText failed, trying clipboard paste...');
      await this.page.evaluate(async (text) => {
        const input = document.querySelector('div.ql-editor[contenteditable="true"], rich-textarea .ql-editor');
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
    await this.page.waitForTimeout(500);

    // Try direct selectors
    const selectors = [
      SEL.sendButton,
      'button[aria-label="Send message"]',
      'button[aria-label="Envoyer le message"]',
      'button.send-button',
    ];

    for (const sel of selectors) {
      const btn = await this.page.$(sel);
      if (btn) {
        const visible = await btn.isVisible().catch(() => false);
        if (visible) {
          await btn.click();
          Logger.debug(`Gemini send clicked via: ${sel}`);
          return;
        }
      }
    }

    // Search by icon/SVG
    const clicked = await this.page.evaluate(() => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
        const matIcon = btn.querySelector('mat-icon, [data-mat-icon-name]');
        const iconName = matIcon?.getAttribute('data-mat-icon-name') || matIcon?.textContent?.trim() || '';

        if (ariaLabel.includes('send') || ariaLabel.includes('envoyer') ||
            iconName === 'send' || iconName === 'arrow_upward') {
          if (btn.offsetWidth > 0 && !btn.disabled) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });

    if (clicked) {
      Logger.debug('Gemini send clicked via evaluate');
      return;
    }

    // Last fallback: Enter key
    Logger.debug('No send button found, trying Enter...');
    await this.page.keyboard.press('Enter');
  }

  async _waitForResponse() {
    const TIMEOUT = 600000; // 10 minutes
    const POLL_INTERVAL = 1000;
    const start = Date.now();

    // 1. Wait for Gemini to start responding
    Logger.debug('[Gemini] Waiting for response to start...');
    let sawActivity = false;
    for (let i = 0; i < 30; i++) {
      await this.page.waitForTimeout(POLL_INTERVAL);
      const active = await this._isGeminiActive();
      if (active) {
        sawActivity = true;
        Logger.debug('[Gemini] Response started');
        break;
      }
      // Check if response appeared fast
      const hasResponse = await this._hasNewResponse();
      if (hasResponse) {
        sawActivity = true;
        Logger.debug('[Gemini] Fast response detected');
        break;
      }
    }

    if (!sawActivity) {
      Logger.warn('[Gemini] No activity after 30s — checking anyway');
    }

    // 2. Poll until done: no stop button, no typing animation
    Logger.debug('[Gemini] Waiting for completion...');
    let doneCount = 0;
    while (Date.now() - start < TIMEOUT) {
      await this.page.waitForTimeout(POLL_INTERVAL);

      const active = await this._isGeminiActive();
      if (!active) {
        doneCount++;
        if (doneCount >= 3) {
          Logger.debug('[Gemini] Response complete (3 consecutive done checks)');
          break;
        }
      } else {
        doneCount = 0;
      }
    }

    if (Date.now() - start >= TIMEOUT) {
      Logger.warn('[Gemini] Response timeout — extracting what we have');
    }

    await this.page.waitForTimeout(1500);
    return await this._extractResponse();
  }

  /**
   * Check if Gemini is still generating (stop button visible or typing animation).
   */
  async _isGeminiActive() {
    return await this.page.evaluate(() => {
      // Check stop button
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Arrêter" i]',
        'button[data-mat-icon-name="stop_circle"]',
        'button[aria-label*="Cancel" i]',
        'button[aria-label*="Annuler" i]',
      ];
      for (const sel of stopSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.getBoundingClientRect().width > 0) return true;
      }

      // Check for typing/streaming indicators
      if (document.querySelector('.loading-indicator, .typing-indicator, [class*="streaming"], [class*="loading"]')) return true;

      // Check for cursor blinking animation in response
      if (document.querySelector('.cursor-blink, .blinking-cursor')) return true;

      return false;
    });
  }

  async _hasNewResponse() {
    return await this.page.evaluate(() => {
      // Look for model response containers
      const responses = document.querySelectorAll('.model-response-text, message-content .markdown, .response-container');
      if (responses.length > 0) {
        const last = responses[responses.length - 1];
        return (last.textContent?.length || 0) > 20;
      }
      return false;
    });
  }

  async _extractResponse() {
    return await this.page.evaluate(() => {
      // Strategy 1: Find model response text containers
      const responseSelectors = [
        '.model-response-text',
        'message-content .markdown',
        '.response-container .markdown',
        'model-response .markdown',
        '.conversation-container model-response',
      ];

      for (const sel of responseSelectors) {
        const elements = document.querySelectorAll(sel);
        if (elements.length > 0) {
          const last = elements[elements.length - 1];

          // Try code blocks first (for JSON)
          const codeBlocks = last.querySelectorAll('pre code, code-block');
          if (codeBlocks.length > 0) {
            let largest = '';
            codeBlocks.forEach(block => {
              if (block.textContent.length > largest.length) largest = block.textContent;
            });
            if (largest.trim().startsWith('{') || largest.trim().startsWith('[')) {
              return largest.trim();
            }
          }

          // Full text content
          const clone = last.cloneNode(true);
          clone.querySelectorAll('button, mat-icon').forEach(el => el.remove());
          return clone.textContent.trim();
        }
      }

      // Strategy 2: Find any large text block that looks like JSON
      const allText = document.body.innerText;
      const jsonMatch = allText.match(/\{[\s\S]*"post_title"[\s\S]*\}/);
      if (jsonMatch) return jsonMatch[0];

      throw new Error('No Gemini response found');
    });
  }

  async _retryJSON() {
    const MAX_FIX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      Logger.info(`Gemini JSON fix attempt ${attempt}/${MAX_FIX_ATTEMPTS}...`);
      const fixPrompt = attempt === 1
        ? 'Your previous response contained invalid JSON. Please output ONLY the valid JSON object, with no markdown, no code blocks, no explanation. Just raw JSON starting with { and ending with }'
        : 'Still invalid. Output ONLY the raw JSON. No markdown. No code fences. No explanation. Start with { end with }';

      await this._pastePrompt(fixPrompt);
      await this.page.waitForTimeout(500);
      await this._clickSend();

      const text = await this._waitForResponse();
      const json = Parser.extractJSON(text);
      if (json) return { success: true, data: json };
      Logger.warn(`Gemini JSON fix attempt ${attempt} failed`);
    }
    return { success: false, error: 'Failed to extract valid JSON from Gemini after retries' };
  }

  async close() {
    if (this.page) {
      try { await this.page.close(); } catch {}
      this.page = null;
    }
  }
}
