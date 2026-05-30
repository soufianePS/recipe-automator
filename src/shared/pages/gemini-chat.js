/**
 * Gemini Chat Page Object — Playwright automation for Gemini (gemini.google.com)
 *
 * Same interface as ChatGPTPage: init(), sendPromptAndGetResponse(), close()
 * Uses the same Google login session as Flow (no extra auth needed).
 * Supports both French and English UI.
 */

import { Logger } from '../utils/logger.js';
import { Parser } from '../utils/parser.js';
import { attachGeminiListener } from '../utils/gemini-network-listener.js';
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
   * Open a FRESH Gemini chat page.
   *
   * gemini.google.com/app loads the most recent conversation by default,
   * which means Gemini's responses are influenced by previous chat history
   * (e.g., past recipes that used different schema field names). To get
   * clean schema-compliant outputs, we always click "New chat" to start a
   * fresh, history-free conversation.
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
      await this._dismissWelcome();
    }

    // ── ALWAYS start a fresh conversation ───────────────────────
    // Click the "New chat" button so we don't inherit history from a
    // previous run. Without this, Gemini will mimic the schema/format of
    // the last conversation (e.g. write "article_title" instead of
    // "post_title" because that's what an older session used).
    try {
      const clicked = await this.page.evaluate(() => {
        const candidates = [
          // Current Gemini UI (verified 2026-05-25): the "new chat" control is
          // an <a> sparkle button, and the sidebar id moved to a <gem-nav-list-item>.
          // The French label is "Nouvelle discussion" (NOT "nouveau chat").
          'a[data-test-id="side-nav-sparkle-button"]',
          '[data-test-id="side-nav-sparkle-button"]',
          '[data-test-id="new-chat-button"]',
          '[aria-label="Nouvelle discussion"]',
          '[aria-label*="nouvelle discussion" i]',
          // Older / English UI fallbacks:
          'button[data-test-id="new-chat-button"]',
          'button[aria-label="New chat"]',
          'button[aria-label*="Nouveau chat" i]',
          'button[aria-label*="nouvelle conversation" i]',
          'button[aria-label*="new chat" i]',
          'a[href*="/chat/"][aria-label*="new" i]',
        ];
        for (const sel of candidates) {
          const el = document.querySelector(sel);
          if (el) { el.click(); return sel; }
        }
        // Fallback: scan buttons AND links (the sparkle button is an <a>) for a
        // text/label match. Include "nouvelle discussion" (current FR label).
        const btns = Array.from(document.querySelectorAll('button, a[role="button"], a[data-test-id], [role="link"]'));
        for (const b of btns) {
          const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
          const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
          if (txt === 'new chat' || txt === 'nouveau chat' || txt === 'nouvelle conversation' || txt === 'nouvelle discussion' ||
              lbl.includes('new chat') || lbl.includes('nouveau chat') || lbl.includes('nouvelle conversation') || lbl.includes('nouvelle discussion')) {
            b.click();
            return 'text:' + (txt || lbl);
          }
        }
        return null;
      });
      if (clicked) {
        Logger.info(`[Gemini] Started fresh conversation via: ${clicked}`);
        await this.page.waitForTimeout(2000);
        // Re-wait for the (now fresh) prompt input
        await this.page.waitForSelector(SEL.promptInput, { timeout: 10000 }).catch(() => {});
      } else {
        Logger.warn('[Gemini] New chat button not found — proceeding (response may be polluted by old conversation history)');
      }
    } catch (e) {
      Logger.warn(`[Gemini] Failed to start fresh chat: ${e.message}`);
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
   * Attach reference images BEFORE the next sendPromptAndGetResponse call.
   * Same interface as ChatGPTPage.attachFiles — caller passes absolute paths.
   * Safe to call with an empty array (no-op).
   *
   * @param {string[]} filePaths
   */
  async attachFiles(filePaths) {
    const refs = (filePaths || []).filter(p => !!p);
    if (refs.length === 0) return { ok: true, attached: 0 };
    Logger.info(`[Gemini] attaching ${refs.length} reference image(s)`);

    // Step 1: open the "+" attach menu.
    // Current Gemini (2026-05): the attach control is "Importation et outils"
    // (icon "plus"). NB "importation" does NOT contain "importer", so the old
    // selectors missed it entirely. Match by label + the plus/add icon, keeping
    // older-UI labels as fallback.
    const opened = await this.page.evaluate(() => {
      const iconOf = (b) => {
        const i = b.querySelector('mat-icon, [data-mat-icon-name], i.google-symbols');
        return i ? (i.getAttribute('data-mat-icon-name') || i.textContent || '').trim().toLowerCase() : '';
      };
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        if (b.offsetWidth === 0) continue;
        const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
        const ic = iconOf(b);
        if (lbl.includes('importation') || lbl.includes('importer') || lbl.includes('outils') ||
            lbl.includes('upload') || lbl.includes('add file') || lbl.includes('add image') ||
            lbl.includes('attach') || ic === 'plus' || ic === 'add' || ic === 'add_circle') {
          b.click();
          return lbl || ('icon:' + ic);
        }
      }
      return null;
    });
    if (!opened) throw new Error('Gemini "+" attach button not found');
    await this.page.waitForTimeout(700);

    // Step 2: catch the filechooser event triggered by clicking
    //         "Importer des fichiers" — Gemini opens an OS file dialog
    //         instead of using a static <input type="file">.
    const clickMenuItem = async () => {
      await this.page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"], .cdk-overlay-container button, [role="menu"] button, [role="menu"] [role="menuitem"], button'));
        for (const it of items) {
          const txt = (it.innerText || it.textContent || '').trim().toLowerCase();
          const tid = (it.getAttribute('data-testid') || '').toLowerCase();
          // Current Gemini: the upload-from-device item is just "Fichiers"/"Files"
          // (NOT "Drive"/"Notebooks"). Older UIs used "Importer des fichiers".
          if (txt === 'fichiers' || txt === 'files' ||
              txt.includes('importer des fichiers') || txt.includes('upload files') ||
              tid === 'local-images-files-uploader-button') {
            it.click();
            return true;
          }
        }
        return false;
      });
    };

    let chooser;
    try {
      [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 8000 }),
        clickMenuItem(),
      ]);
      await chooser.setFiles(refs);
    } catch (e) {
      // Fallback: maybe a hidden input exists once the menu is open
      const input = await this.page.$('input[type="file"]');
      if (input) {
        await input.setInputFiles(refs);
      } else {
        // CRITICAL: dismiss the open menu/CDK overlay backdrop before throwing.
        // Otherwise the invisible backdrop blocks the next click (e.g. send button)
        // and the orchestrator times out 30s later with "cdk-overlay-backdrop intercepts pointer events".
        await this._dismissOverlays();
        throw new Error(`Gemini file input/chooser not available: ${e.message.split('\n')[0]}`);
      }
    }
    await this.page.waitForTimeout(500);
    // Close any popover, refocus the composer
    await this.page.keyboard.press('Escape').catch(() => {});
    await this.page.waitForTimeout(200);
    try {
      const promptInput = await this.page.$(SEL.promptInput);
      if (promptInput) await promptInput.click({ force: true });
    } catch {}
    await this.page.waitForTimeout(300);

    // Poll for thumbnails to settle (similar to ChatGPT pattern)
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await this.page.waitForTimeout(700);
      const thumbs = await this.page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('img'));
        const small = all.filter(i => i.offsetWidth >= 30 && i.offsetWidth <= 200 && i.offsetHeight >= 30 && i.offsetHeight <= 200).length;
        const blob = all.filter(i => /^(blob:|data:)/.test(i.src || '')).length;
        return Math.max(small, blob);
      });
      if (thumbs >= refs.length) {
        Logger.info(`[Gemini] ${thumbs} thumbnail(s) ready`);
        return { ok: true, attached: thumbs };
      }
    }
    Logger.warn('[Gemini] thumbnail wait timed out — sending anyway');
    return { ok: false, attached: 0 };
  }

  /**
   * Dismiss any open Gemini menu, popover, or CDK overlay backdrop.
   * Called after a failed attach to prevent the invisible backdrop from
   * blocking subsequent clicks (send button, etc.).
   */
  async _dismissOverlays() {
    try {
      // Press Escape twice — first dismisses any open menu, second any nested popover
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(200);
      await this.page.keyboard.press('Escape').catch(() => {});
      await this.page.waitForTimeout(200);
      // Click the CDK overlay backdrop directly if it's still present
      await this.page.evaluate(() => {
        const backdrops = document.querySelectorAll('.cdk-overlay-backdrop, .cdk-overlay-transparent-backdrop');
        for (const b of backdrops) {
          try { b.click(); } catch {}
        }
        // Also remove any orphaned backdrops Angular failed to clean up
        const container = document.querySelector('.cdk-overlay-container');
        if (container) {
          for (const c of container.children) {
            if (c.classList.contains('cdk-overlay-backdrop') ||
                c.classList.contains('cdk-overlay-transparent-backdrop')) {
              try { c.remove(); } catch {}
            }
          }
        }
      }).catch(() => {});
      await this.page.waitForTimeout(300);
    } catch {}
  }

  /**
   * Send a prompt and get the full response.
   *
   * Uses the network sniffer (attachGeminiListener) to capture Gemini's raw
   * API response from the /StreamGenerate endpoint instead of scraping the
   * DOM. This is dramatically more reliable for long JSON outputs:
   *   - No markdown corruption (the DOM HTML-encodes special chars + adds
   *     copy buttons + wraps in <code> tags that pollute text extraction)
   *   - Catches the FULL streamed response (DOM only shows what's currently
   *     visible — long responses can be truncated when the textarea scrolls)
   *   - No race condition between "stream still streaming" and "we copied"
   *
   * The DOM extraction path is kept as a fallback for the rare case the
   * sniffer doesn't catch a body (e.g. Gemini routes through a different
   * endpoint we don't recognize).
   */
  async sendPromptAndGetResponse(prompt, expectJSON = false) {
    Logger.step('Gemini', 'Sending prompt...');
    await this.screenshot('before-prompt');

    await this._dismissOverlays();

    const input = await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    await input.click();
    await this.page.waitForTimeout(300);

    // Attach the network sniffer BEFORE typing/sending so we don't miss
    // the very first stream chunk.
    const listener = attachGeminiListener(this.page);
    Logger.info('[Gemini] Network sniffer attached');

    let responseText;
    try {
      await this._pastePrompt(prompt);
      await this.page.waitForTimeout(500);
      await this._clickSend();
      Logger.debug('Gemini send clicked');
      await this.screenshot('after-send');

      // Use sniffer first — when it captures, it's cleaner than DOM scraping.
      // Cap at 120s (not 600s): if it hasn't captured by then, the response is
      // already done and the DOM-stability path below extracts it reliably —
      // no point hanging 10 minutes (that was the old silent-failure mode).
      try {
        const snap = await listener.waitForResponse({ timeout: 120000, quietMs: 4000, minTextLen: 50 });
        responseText = snap.text || '';
        Logger.success(`[Gemini] Sniffed ${responseText.length} chars (chunks: ${snap.rawChunks}, bodies: ${snap.bodiesSeen})`);
      } catch (snifferError) {
        Logger.warn(`[Gemini] Sniffer failed (${snifferError.message.split('\n')[0]}) — falling back to DOM extraction`);
        responseText = await this._waitForResponse();
      }
    } finally {
      try { listener.dispose(); } catch {}
    }

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

    // Find the composer's send button. CRITICAL: do NOT match on
    // aria-label*="send"/"envoyer" loosely — Gemini's sidebar "more options"
    // (⋮, icon=more_vert) buttons embed the conversation's text in their
    // aria-label, so a past chat containing the word "send" (e.g. an image-gen
    // session: "I will send each prompt…") falsely matches and gets clicked
    // FIRST in DOM order, opening a menu instead of sending. Target by icon
    // (arrow_upward/send) + exact label, and explicitly skip more_vert.
    const clicked = await this.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const iconOf = (b) => {
        const i = b.querySelector('mat-icon, [data-mat-icon-name]');
        return (i?.getAttribute('data-mat-icon-name') || i?.textContent?.trim() || '').toLowerCase();
      };
      const usable = (b) => b.offsetWidth > 0 && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      // 1. Exact send labels (composer button), excluding menu buttons.
      const exact = btns.find(b => {
        const lbl = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        return iconOf(b) !== 'more_vert' && usable(b) &&
          (lbl === 'envoyer un message' || lbl === 'send message' || lbl === 'envoyer le message' || lbl === 'envoyer');
      });
      if (exact) { exact.click(); return 'exact-label'; }
      // 2. By send icon, skipping the ⋮ menu buttons.
      const byIcon = btns.find(b => {
        const ic = iconOf(b);
        return (ic === 'send' || ic === 'arrow_upward') && ic !== 'more_vert' && usable(b);
      });
      if (byIcon) { byIcon.click(); return 'icon:' + iconOf(byIcon); }
      return null;
    });

    if (clicked) {
      Logger.debug(`Gemini send clicked via ${clicked}`);
      return;
    }

    // Last fallback: keyboard. Gemini sends on Enter (Shift+Enter = newline).
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

    // FINAL GATE: the avatar/stop "done" signals can flip mid-stream, which
    // made extraction grab a TRUNCATED response (the recipe JSON cut off at
    // line 272). The reliable completion signal is text-length STABILITY —
    // wait until the largest response/code-block stops growing for 3 polls.
    // (Verified 2026-05-25: this captures the full clean JSON; without it the
    // DOM gives a partial blob that fails to parse.)
    let lastLen = -1, stableCount = 0;
    const stabilityCap = Date.now() + 60000; // never block here more than 60s
    while (Date.now() < stabilityCap) {
      await this.page.waitForTimeout(1500);
      const len = await this.page.evaluate(() => {
        let max = 0;
        for (const el of document.querySelectorAll('code-block, pre code, .model-response-text, message-content .markdown')) {
          const n = (el.textContent || '').length;
          if (n > max) max = n;
        }
        return max;
      });
      if (len > 0 && len === lastLen) { if (++stableCount >= 3) break; } else stableCount = 0;
      lastLen = len;
    }
    Logger.debug(`[Gemini] Response text stable at ${lastLen} chars — extracting`);
    return await this._extractResponse();
  }

  /**
   * Check if Gemini is still generating.
   *
   * PRIMARY SIGNAL — the Bard avatar Lottie animation status:
   *   <bard-avatar> ... [data-test-lottie-animation-status="playing"] = generating
   *   <bard-avatar> ... [data-test-lottie-animation-status="completed"] = done
   * The avatar also has a spinner sub-element that toggles visibility/opacity.
   *
   * SECONDARY: stop button (when visible).
   * SECONDARY: spinner visibility (the .avatar_spinner_animation div).
   *
   * Reasoning: Lottie animation status is set by the chat app itself when it
   * starts/stops the response stream — most reliable signal we have.
   */
  async _isGeminiActive() {
    return await this.page.evaluate(() => {
      // PRIMARY — Lottie status on the bard-avatar in the LATEST response
      const avatars = Array.from(document.querySelectorAll('bard-avatar [data-test-lottie-animation-status]'));
      if (avatars.length > 0) {
        const last = avatars[avatars.length - 1];
        const status = (last.getAttribute('data-test-lottie-animation-status') || '').toLowerCase();
        if (status === 'playing') return true;
      }
      // SECONDARY — spinner sub-element visible (opacity > 0 and visibility !== hidden)
      const spinners = Array.from(document.querySelectorAll('bard-avatar .avatar_spinner_animation'));
      for (const sp of spinners) {
        const style = sp.getAttribute('style') || '';
        if (!/opacity:\s*0/.test(style) && !/visibility:\s*hidden/.test(style)) {
          // Has explicit non-zero opacity or no hide style
          if (sp.offsetWidth > 0 && sp.offsetHeight > 0) return true;
        }
      }
      // SECONDARY — stop button (rarely visible but absolute confirmation)
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Arrêter" i]',
        'button[data-mat-icon-name="stop_circle"]',
        'button[aria-label*="Cancel response" i]',
        'button[aria-label*="Annuler la réponse" i]',
      ];
      for (const sel of stopSelectors) {
        const btn = document.querySelector(sel);
        if (btn && btn.getBoundingClientRect().width > 0) return true;
      }
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
