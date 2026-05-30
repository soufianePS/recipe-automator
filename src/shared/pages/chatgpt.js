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
   * Attach reference images BEFORE the next sendPromptAndGetResponse call.
   * The composer "+" menu is opened first so ChatGPT's React state binds
   * the upload-photos input properly (free-plan + fresh-chat quirk).
   * Safe to call with an empty array (no-op).
   *
   * @param {string[]} filePaths — absolute paths to images
   */
  async attachFiles(filePaths) {
    const refs = (filePaths || []).filter(p => !!p);
    if (refs.length === 0) return { ok: true, attached: 0 };
    Logger.info(`[ChatGPT] attaching ${refs.length} reference image(s)`);

    // Open the "+" composer menu so the upload-photos input is wired to React
    await this.page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of btns) {
        if (b.offsetWidth === 0) continue;
        const id = (b.getAttribute('data-testid') || '').toLowerCase();
        const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
        if (id === 'composer-plus-btn' || id.includes('composer-add') || lbl.includes('ajouter des fichiers') || lbl.includes('add files') || lbl.includes('attach')) {
          b.click();
          return true;
        }
      }
      return false;
    });
    await this.page.waitForTimeout(700);

    const inputSelectors = [
      'input#upload-photos',
      'input#upload-files',
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ];
    let fileInput = null;
    for (const sel of inputSelectors) {
      fileInput = await this.page.$(sel);
      if (fileInput) break;
    }
    if (!fileInput) throw new Error('ChatGPT file input not found in DOM');
    await fileInput.setInputFiles(refs);
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Escape').catch(() => {});

    // Poll for thumbnails to settle
    const start = Date.now();
    while (Date.now() - start < 90000) {
      await this.page.waitForTimeout(700);
      const status = await this.page.evaluate(() => {
        const allImgs = Array.from(document.querySelectorAll('img'));
        const thumbs = allImgs.filter(i => i.offsetWidth >= 40 && i.offsetWidth <= 200 && i.offsetHeight >= 40 && i.offsetHeight <= 200).length;
        const blob = allImgs.filter(i => /^(blob:|data:)/.test(i.src || '')).length;
        const sendDisabled = !!Array.from(document.querySelectorAll('button')).find(b => {
          const id = b.getAttribute('data-testid') || '';
          return (id.includes('send') || id === 'send-button') && (b.disabled || b.getAttribute('aria-disabled') === 'true');
        });
        return { thumbs: Math.max(thumbs, blob), sendDisabled };
      });
      if (status.thumbs >= refs.length && !status.sendDisabled) {
        Logger.info(`[ChatGPT] ${status.thumbs} thumbnail(s) ready`);
        return { ok: true, attached: status.thumbs };
      }
    }
    Logger.warn('[ChatGPT] thumbnail wait timed out — sending anyway');
    return { ok: false, attached: 0 };
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

  /**
   * Best-effort: delete the current chat from ChatGPT history.
   *
   * Strategy:
   *   1. Locate the current chat URL (/c/<id>) from window.location
   *   2. Find the sidebar row whose href matches
   *   3. Hover the row (Playwright mouse.move on its position) to reveal "..." btn
   *   4. Click "..." → wait for menu → click "Delete"
   *   5. Confirm the dialog
   *
   * Multiple fallback strategies + Playwright hover (more reliable than DOM event).
   */
  async deleteCurrentChat() {
    if (!this.page) return { ok: false, reason: 'no page' };
    try {
      const currentUrl = this.page.url();
      // Skip if temporary chat (no history exists)
      if (currentUrl.includes('temporary-chat=true')) {
        Logger.info('[ChatGPT] temporary chat — nothing to delete (not in history)');
        return { ok: true, skipped: 'temporary' };
      }
      // Extract chat ID from URL: /c/<uuid>
      const chatIdMatch = currentUrl.match(/\/c\/([a-f0-9-]+)/i);
      const chatId = chatIdMatch ? chatIdMatch[1] : null;
      if (!chatId) {
        Logger.warn(`[ChatGPT] cannot extract chat ID from URL: ${currentUrl} — chat may not be saved yet`);
        return { ok: false, reason: 'no-chat-id' };
      }
      Logger.info(`[ChatGPT] attempting to delete chat ${chatId}...`);

      // Find the sidebar link
      const rowBox = await this.page.evaluate((id) => {
        const link = document.querySelector(`a[href*="/c/${id}"]`);
        if (!link) return null;
        const r = link.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, found: true };
      }, chatId);
      if (!rowBox) {
        Logger.warn(`[ChatGPT] sidebar row for chat ${chatId} not found`);
        return { ok: false, reason: 'no-sidebar-row' };
      }

      // Hover the row with Playwright (reveals the "..." button via :hover styles)
      await this.page.mouse.move(rowBox.x, rowBox.y);
      await this.page.waitForTimeout(700);

      // Click the "..." options button inside that row
      const optionsClicked = await this.page.evaluate((id) => {
        const link = document.querySelector(`a[href*="/c/${id}"]`);
        if (!link) return null;
        // The "..." button is usually inside the link OR a sibling
        const candidates = [
          ...link.querySelectorAll('button'),
          ...(link.parentElement?.querySelectorAll('button') || []),
        ];
        for (const b of candidates) {
          const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
          const id2 = (b.getAttribute('data-testid') || '').toLowerCase();
          if (lbl.includes('option') || lbl.includes('more') || lbl.includes('plus') ||
              id2.includes('option') || id2.includes('more') || id2.includes('history-item-options')) {
            b.click();
            return { aria: lbl, testid: id2 };
          }
        }
        return null;
      }, chatId);
      if (!optionsClicked) {
        Logger.warn('[ChatGPT] "..." options button not found on chat row');
        return { ok: false, reason: 'no-options-btn' };
      }
      Logger.info(`[ChatGPT] opened options menu (${JSON.stringify(optionsClicked).slice(0, 80)})`);
      await this.page.waitForTimeout(600);

      // Click "Delete" / "Supprimer" in the dropdown
      const deleteClicked = await this.page.evaluate(() => {
        const items = document.querySelectorAll('div[role="menuitem"], [role="option"], button');
        for (const it of items) {
          if (it.offsetWidth === 0) continue;
          const text = (it.textContent || '').toLowerCase().trim();
          if (text === 'delete' || text === 'supprimer' ||
              text.startsWith('delete chat') || text.startsWith('supprimer la conv')) {
            it.click();
            return text;
          }
        }
        return null;
      });
      if (!deleteClicked) {
        Logger.warn('[ChatGPT] "Delete" menu item not found');
        return { ok: false, reason: 'no-delete-item' };
      }
      Logger.info(`[ChatGPT] clicked menu: "${deleteClicked}"`);
      await this.page.waitForTimeout(800);

      // Confirm the dialog — look for primary action button labeled Delete/Confirm
      const confirmClicked = await this.page.evaluate(() => {
        // Modal dialogs usually have a clear primary danger button
        const dialog = document.querySelector('div[role="dialog"], div[role="alertdialog"]') || document;
        const btns = dialog.querySelectorAll('button');
        for (const b of btns) {
          if (b.offsetWidth === 0) continue;
          const t = (b.textContent || '').toLowerCase().trim();
          if (t === 'delete' || t === 'supprimer' || t === 'confirm' || t === 'confirmer' || t === 'yes' || t === 'oui') {
            b.click();
            return t;
          }
        }
        return null;
      });
      await this.page.waitForTimeout(500);
      if (confirmClicked) {
        Logger.info(`[ChatGPT] ✓ chat deleted from history (confirmed: "${confirmClicked}")`);
      } else {
        Logger.info('[ChatGPT] delete triggered (no confirm dialog detected — may have been deleted directly)');
      }
      return { ok: true, chatId };
    } catch (e) {
      Logger.warn(`[ChatGPT] deleteCurrentChat failed (non-fatal): ${e.message}`);
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Try to click the composer "Create image" / "Image" tool from the "+"
   * menu so ChatGPT enters image-gen mode explicitly.
   *
   * Best-effort: many ChatGPT layouts don't have an explicit tool selector
   * (the model decides from the prompt). Returns whatever was clicked or null.
   */
  async selectImageTool() {
    try {
      // Click the composer "+" (same selector pattern as attachFiles)
      const plusClicked = await this.page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        for (const b of btns) {
          if (b.offsetWidth === 0) continue;
          const id = (b.getAttribute('data-testid') || '').toLowerCase();
          const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
          if (id === 'composer-plus-btn' || id.includes('composer-add') ||
              lbl.includes('add files') || lbl.includes('ajouter des fichiers') ||
              lbl.includes('attach') || lbl.includes('plus') || lbl.includes('outils') || lbl.includes('tools')) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!plusClicked) {
        Logger.debug('[ChatGPT-Image] composer "+" button not found — skipping tool selection');
        return null;
      }
      await this.page.waitForTimeout(700);
      // Find "Create image" / "Image" / "Créer une image" in the dropdown menu
      const clicked = await this.page.evaluate(() => {
        const candidates = document.querySelectorAll('div[role="menuitem"], [role="option"], button, a');
        const labels = ['create image', 'créer une image', 'créer image', 'générer une image', 'image generation'];
        for (const c of candidates) {
          if (c.offsetWidth === 0) continue;
          const text = (c.textContent || '').toLowerCase().trim();
          // Match exact "Image" tool OR phrases above
          if (text === 'image' || text === 'créer image' || labels.some(l => text.includes(l))) {
            c.click();
            return text;
          }
        }
        return null;
      });
      if (clicked) {
        Logger.info(`[ChatGPT-Image] selected tool: "${clicked}"`);
        await this.page.waitForTimeout(800);
      } else {
        // Close the menu we opened (Escape) since we didn't use it
        await this.page.keyboard.press('Escape').catch(() => {});
        Logger.debug('[ChatGPT-Image] no "Create image" tool option found in menu — model will infer from prompt');
      }
      return clicked;
    } catch (e) {
      Logger.warn(`[ChatGPT-Image] selectImageTool failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  /**
   * After image tool is selected, ChatGPT shows a small dropdown in the composer
   * with aspect-ratio options (1:1, 2:3, 3:4, 16:9, etc.). This:
   *   1. Finds the dropdown TRIGGER (button showing current ratio, default 1:1)
   *   2. Clicks to open the menu
   *   3. Picks the preferred ratio (3:4 by default — ChatGPT's vertical option)
   *
   * Fallback chain: preferred → 2:3 → 9:16 → portrait → vertical.
   * Logs every visible option so we can debug if ChatGPT renames its UI.
   */
  async selectPortraitRatio(preferred = '9:16') {
    try {
      // STEP 1: click the ratio dropdown trigger using a REAL Playwright click.
      // CRITICAL: element.click() via page.evaluate() doesn't fire React's
      // mouse events properly — the menu opens then immediately closes.
      // Playwright's locator.click() simulates real mouse down/up → menu stays.
      // aria-label "Choisir le format d'image" (FR) is the stable selector.
      const triggerLoc = this.page.locator(
        'button[aria-label*="format d"], button[aria-label*="image size" i], button[aria-label*="aspect ratio" i]'
      ).first();
      const triggerCount = await triggerLoc.count();
      if (triggerCount === 0) {
        Logger.debug('[ChatGPT-Image] no aspect-ratio dropdown trigger found in composer — relying on prompt text');
        return null;
      }
      const triggerLabel = await triggerLoc.getAttribute('aria-label').catch(() => '') || '';
      const currentText = (await triggerLoc.textContent().catch(() => '') || '').trim();
      await triggerLoc.click({ delay: 50 });
      Logger.info(`[ChatGPT-Image] opened ratio dropdown (current: "${currentText}")`);
      await this.page.waitForTimeout(500);

      // STEP 2: ChatGPT's menu items are <span> labels inside menuitem-like
      // <div>s in a popover. The visible options are: Automatique, Carré 1:1,
      // Portrait 3:4, Story 9:16, Paysage 4:3, Écran large 16:9.
      // Fallback chain: preferred → 2:3 → 9:16 → Portrait → Vertical.
      // Default preference order: 9:16 (Story) → tall pins like the old Flow output
      // (which displayed BIG on Pinterest feed). Fall back to 3:4 → 2:3 → Portrait → Story.
      const fallbackChain = [preferred, '9:16', '3:4', '2:3', 'Story', 'Portrait'];
      let clicked = null;
      let visibleOptions = [];

      // Enumerate visible menu options for logging
      try {
        visibleOptions = await this.page.evaluate(() => {
          const all = Array.from(document.querySelectorAll('span, div'));
          const seen = new Set();
          const items = [];
          for (const el of all) {
            if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
            const text = Array.from(el.childNodes)
              .filter(n => n.nodeType === 3)
              .map(n => n.textContent.trim())
              .join('');
            if (!text || text.length > 30) continue;
            // Heuristic: only labels that look like ratio menu items
            if (/^(automatique|auto|carré|square|portrait|paysage|landscape|story|écran large|widescreen|\d+\s*:\s*\d+)$/i.test(text)) {
              if (!seen.has(text)) { seen.add(text); items.push(text); }
            }
          }
          return items;
        });
        Logger.info(`[ChatGPT-Image] dropdown options visible: [${visibleOptions.join(' | ')}]`);
      } catch {}

      // Try each candidate label via Playwright text locator (real click)
      for (const candidate of fallbackChain) {
        try {
          // Use getByText with exact match first, then loose
          const exactLoc = this.page.getByText(candidate, { exact: true }).first();
          const exactCount = await exactLoc.count();
          if (exactCount > 0 && await exactLoc.isVisible().catch(() => false)) {
            await exactLoc.click({ delay: 50 });
            clicked = candidate;
            break;
          }
        } catch {}
      }

      if (clicked) {
        Logger.success(`[ChatGPT-Image] selected ratio "${clicked}"`);
        await this.page.waitForTimeout(400);
        return clicked;
      } else {
        Logger.warn(`[ChatGPT-Image] dropdown opened but "${preferred}" (or fallbacks) not found — closing menu`);
        await this.page.keyboard.press('Escape').catch(() => {});
        return null;
      }
    } catch (e) {
      Logger.warn(`[ChatGPT-Image] selectPortraitRatio failed (non-fatal): ${e.message}`);
      return null;
    }
  }

  /**
   * Generate a pin image via ChatGPT's native image generation (GPT-4o /
   * GPT-Image / DALL-E). Replaces Flow for users who prefer ChatGPT.
   *
   * Flow:
   *   1. Ensure page initialized (init or reuse)
   *   2. Attach reference images (template + hero, etc.)
   *   3. Try to select "Create image" tool + Portrait ratio (best-effort)
   *   4. Setup network sniffer for files.oaiusercontent.com responses
   *   5. Send prompt that explicitly asks for image generation
   *   6. Wait for image — first via network sniffer (faster + more reliable),
   *      then fallback to DOM scraping
   *   7. Download the image → outputPath
   *
   * @param {object} opts
   * @param {string} opts.prompt - text prompt for image generation
   * @param {string[]} opts.refImages - absolute paths to reference images
   * @param {string} opts.outputPath - where to save the downloaded image
   * @param {number} [opts.timeoutSeconds=240] - max wait
   * @param {boolean} [opts.skipToolSelect=false] - skip the UI tool/ratio selection
   * @param {boolean} [opts.deleteAfter=true] - auto-delete chat from history after image saved
   * @returns {Promise<{ok: boolean, imagePath?: string, error?: string}>}
   */
  async generatePinImage({ prompt, refImages = [], outputPath, timeoutSeconds = 240, skipToolSelect = false, deleteAfter = true, preferredRatio = null }) {
    const { writeFile } = await import('fs/promises');
    if (!this.page) throw new Error('ChatGPTPage.generatePinImage: call init() first');
    if (!prompt) return { ok: false, error: 'no prompt' };
    if (!outputPath) return { ok: false, error: 'no outputPath' };

    Logger.step('ChatGPT-Image', `Generating pin (${refImages.length} ref(s))`);

    // 1. Setup network sniffer BEFORE any action so we catch image responses
    //    Capture ONLY user-content image URLs (the generated outputs). Strict
    //    filtering to avoid catching:
    //    - UI preview thumbnails (persistent.oaistatic.com/images-app/*)
    //    - Avatar/logo/sprite assets
    //    - Uploaded reference image previews (rejected by gating below)
    const sniffed = new Set();
    let promptSentAt = 0;  // sniffed entries before this timestamp are noise
    const sniffHandler = (response) => {
      try {
        const url = response.url();
        if (!url) return;
        // HARD EXCLUDE: ChatGPT static UI assets (persistent.oaistatic.com)
        // These are preview thumbnails of image-gen styles, NOT generated content.
        if (/oaistatic\.com|images-app|persistent\.oai/i.test(url)) return;
        // HARD EXCLUDE: known UI chrome
        if (/sprite|favicon|avatar|logo|emoji|icon-|cdn\.oai/i.test(url)) return;
        // ACCEPT: only user-content CDNs that host generated images
        const isUserContent = /oaiusercontent|sdmntp|files\.oaiusercontent|backend-api\/estuary\/content/i.test(url);
        if (!isUserContent) return;
        // Filter: must be an image content-type OR have image extension
        const ct = (response.headers()['content-type'] || '').toLowerCase();
        const isImage = ct.startsWith('image/') ||
                        /\.(png|jpg|jpeg|webp)(\?|$)/i.test(url);
        if (!isImage) return;
        // Discard pre-prompt captures (uploaded refs, attachment previews)
        if (promptSentAt > 0 && Date.now() < promptSentAt) return;
        sniffed.add(url);
        Logger.info(`[ChatGPT-Image] 🎯 sniffer captured: ${url.slice(0, 120)}`);
      } catch {}
    };
    this.page.on('response', sniffHandler);

    // 2. Attach refs (skip if none)
    if (refImages.length > 0) {
      try {
        await this.attachFiles(refImages);
      } catch (e) {
        Logger.warn(`[ChatGPT-Image] attachFiles failed: ${e.message} — continuing without refs`);
      }
    }

    // 3. Try UI tool + ratio selection (best-effort, fragile)
    if (!skipToolSelect) {
      await this.selectImageTool();
      await this.selectPortraitRatio(preferredRatio || '9:16');
    }

    // 4. Send prompt
    try {
      const input = await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
      await input.click();
      await this.page.waitForTimeout(300);
      await this._pastePrompt(prompt);
      await this.page.waitForTimeout(500);
      // CRITICAL: reset the sniffer Set + mark sentAt so any pre-prompt
      // captures (UI thumbnails, attachment previews, etc.) are discarded.
      sniffed.clear();
      promptSentAt = Date.now();
      await this._clickSend();
      Logger.info(`[ChatGPT-Image] prompt sent at ${new Date(promptSentAt).toISOString()}, waiting for image generation...`);
    } catch (e) {
      this.page.off('response', sniffHandler);
      return { ok: false, error: `send prompt failed: ${e.message}` };
    }

    // 5. Wait for image — sniffer takes priority (faster + more reliable),
    //    fallback to DOM scraping if nothing sniffed.
    const deadline = Date.now() + timeoutSeconds * 1000;
    let imageUrl = null;
    let lastLogAt = 0;
    while (Date.now() < deadline) {
      // 5a. Check sniffer hits first — pick the most recent (likely the final image)
      if (sniffed.size > 0) {
        const arr = [...sniffed].filter(u => !/sprite|logo|icon|avatar|placeholder|thumb/i.test(u));
        if (arr.length > 0) {
          imageUrl = arr[arr.length - 1];
          Logger.info(`[ChatGPT-Image] using sniffed URL (${sniffed.size} captured total)`);
          break;
        }
      }
      // 5b. DOM fallback — strict: only generated images in the LATEST assistant
      //     message that aren't UI thumbnails (oaistatic, images-app, etc.)
      try {
        const found = await this.page.evaluate(() => {
          const msgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
          if (msgs.length === 0) return null;
          const last = msgs[msgs.length - 1];
          const imgs = last.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.getAttribute('src') || '';
            if (!src) continue;
            // HARD EXCLUDE: UI assets
            if (/oaistatic\.com|images-app|persistent\.oai/i.test(src)) continue;
            if (/sprite|favicon|avatar|logo|emoji|icon-/i.test(src)) continue;
            // Reject tiny images (likely UI chrome)
            const w = img.naturalWidth || img.width || 0;
            const h = img.naturalHeight || img.height || 0;
            if (w > 0 && (w < 200 || h < 200)) continue;
            // ACCEPT: data URLs, blobs, or generated-content CDN hosts only
            if (src.startsWith('data:image/')) return src;
            if (src.startsWith('blob:')) return src;
            if (/oaiusercontent|sdmntp|files\.oaiusercontent|backend-api\/estuary\/content/i.test(src)) return src;
            // Reject everything else — don't accept random http images
          }
          return null;
        });
        if (found) { imageUrl = found; break; }
      } catch {}
      if (Date.now() - lastLogAt > 15000) {
        const elapsed = Math.round((timeoutSeconds * 1000 - (deadline - Date.now())) / 1000);
        Logger.info(`[ChatGPT-Image] waiting for image... (${elapsed}s / ${timeoutSeconds}s · sniffer hits: ${sniffed.size})`);
        lastLogAt = Date.now();
      }
      await this.page.waitForTimeout(2500);
    }
    this.page.off('response', sniffHandler);

    if (!imageUrl) {
      await this.screenshot('image-gen-timeout');
      return { ok: false, error: `no image returned within ${timeoutSeconds}s (sniffer: ${sniffed.size} hits)` };
    }
    Logger.info(`[ChatGPT-Image] image detected: ${imageUrl.slice(0, 80)}...`);

    // 4. Download image (use the browser's fetch context so cookies/auth work)
    try {
      let buffer;
      if (imageUrl.startsWith('blob:')) {
        // Blob URLs only resolve inside the page — fetch as data URL there
        const dataUrl = await this.page.evaluate(async (url) => {
          const r = await fetch(url);
          const blob = await r.blob();
          return await new Promise(res => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.readAsDataURL(blob);
          });
        }, imageUrl);
        const b64 = dataUrl.split(',')[1];
        buffer = Buffer.from(b64, 'base64');
      } else {
        // Cross-origin (oaiusercontent) — fetch via the page context to share cookies
        const result = await this.page.evaluate(async (url) => {
          const r = await fetch(url);
          if (!r.ok) return { ok: false, status: r.status };
          const arr = new Uint8Array(await r.arrayBuffer());
          // Base64-encode in chunks to avoid stack overflow on large images
          let bin = '';
          const chunk = 0x8000;
          for (let i = 0; i < arr.length; i += chunk) {
            bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
          }
          return { ok: true, b64: btoa(bin), size: arr.length };
        }, imageUrl);
        if (!result.ok) return { ok: false, error: `download failed: HTTP ${result.status}` };
        buffer = Buffer.from(result.b64, 'base64');
        Logger.info(`[ChatGPT-Image] downloaded ${Math.round(result.size / 1024)}KB`);
      }
      await writeFile(outputPath, buffer);
      Logger.success(`[ChatGPT-Image] saved to ${outputPath}`);
      // Optional: cleanup the chat from history (best-effort, non-blocking)
      if (deleteAfter) {
        try { await this.deleteCurrentChat(); } catch {}
      }
      return { ok: true, imagePath: outputPath, imageUrl, sizeBytes: buffer.length };
    } catch (e) {
      return { ok: false, error: `save image failed: ${e.message}` };
    }
  }
}
