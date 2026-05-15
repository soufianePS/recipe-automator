/**
 * Gemini Image Chat — Playwright driver for image generation via gemini.google.com.
 *
 * Same `generate()` signature as FlowPage so orchestrators can swap backends with
 * one line. Difference vs FlowPage: ONE chat per recipe persists across calls,
 * giving Gemini native multi-turn visual memory (each new image sees every prior
 * image in the conversation). Caller must call startNewChat(introText) once per
 * recipe before the first generate(), then generate() N times.
 *
 * Reuses the prompt-input / send / polling patterns from gemini-chat.js but
 * waits for an <img> response instead of streamed text and downloads the
 * generated image as a binary file.
 */

import { Logger } from '../utils/logger.js';
import { removeWatermarkInPlace } from '../utils/watermark-remover.js';
import { attachGeminiListener } from '../utils/gemini-network-listener.js';
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = join(__dirname, '..', '..', '..', 'screenshots');

const GEMINI_URL = 'https://gemini.google.com/app';

// ── Errors that the orchestrator handles specially (mirror Flow*) ───────
export class GeminiRateLimitError extends Error {
  constructor(msg = 'Gemini chat rate-limited or daily quota exceeded') {
    super(msg);
    this.name = 'GeminiRateLimitError';
  }
}
export class GeminiAccountBlockedError extends Error {
  constructor(msg = 'Gemini chat account blocked / login required') {
    super(msg);
    this.name = 'GeminiAccountBlockedError';
  }
}

// ── Selectors (FR + EN) ────────────────────────────────────────────────
const SEL = {
  promptInput: 'div.ql-editor[contenteditable="true"], rich-textarea .ql-editor, div[aria-label*="prompt" i][contenteditable="true"], div[aria-label*="message" i][contenteditable="true"]',
  sendButton: 'button[aria-label*="Send" i], button[aria-label*="Envoyer" i], button.send-button, button[data-mat-icon-name="send"]',
  stopButton: 'button[aria-label*="Stop" i], button[aria-label*="Arrêter" i], button[data-mat-icon-name="stop_circle"]',
  // File input — Gemini hides a real <input type="file"> behind the "+" attach button
  fileInput: 'input[type="file"]',
  // Containers showing model output
  modelResponse: 'model-response, .response-container, message-content, .conversation-container',
  // Image inside a model response (skip the user's uploaded refs which are in user-message).
  // Cast a wide net — Gemini wraps generated images in various containers depending on layout.
  responseImage: 'model-response img, .response-container img, message-content img, .conversation-container img, [class*="generated-image"] img, [class*="image-container"] img, .markdown img',
  // 3-dot menu on a generated image (used for "Redo with Pro" detection)
  imageMoreMenu: 'button[aria-label*="More" i], button[aria-label*="Plus" i]',
};

// ── Timing ─────────────────────────────────────────────────────────────
const PAGE_LOAD_DELAY = 4000;
const POST_ATTACH_DELAY = 2000; // give Gemini time to ingest the upload before next action
const POST_PROMPT_DELAY = 700;
const POST_SEND_DELAY = 2000;
const GEN_POLL_INTERVAL = 2500; // 2.5s — caller saw false-positive "no image" when polling too eagerly during slow streams
const GEN_TIMEOUT = 600000; // 10 min — Gemini can stall on heavy turns; better to wait than throw "no image"
const GEN_DONE_CONFIRM_TICKS = 3;

export class GeminiImageChat {
  constructor(browser, context) {
    this.browser = browser;
    this.context = context;
    this.page = null;
    this._userMsgCountBefore = 0;
    this._modelResponseCountBefore = 0;
    // Network listener — set in init(), used by startNewChat() and generate()
    // to read text + image responses straight from Gemini's API streams,
    // bypassing the brittle DOM/canvas extraction.
    this._netListener = null;
    // Last line of defence — MD5s of every image successfully downloaded for
    // the CURRENT recipe. If a "new" image we extract has a hash already in
    // this set, it's a known false positive (Gemini's chat re-mounted a prior
    // turn's image as a fresh DOM element after virtual scroll, or didn't
    // actually generate this turn). We reject it and let generate() retry.
    this._seenImageHashes = new Set();
  }

  // ───────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────

  async init() {
    // Reuse existing tab if already on Gemini, otherwise open one
    const existing = this.context.pages().find(p => p.url().includes('gemini.google.com'));
    if (existing) {
      this.page = existing;
      try { await this.page.bringToFront(); } catch {}
    } else {
      this.page = await this.context.newPage();
      await this.page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' });
      await this.page.waitForTimeout(PAGE_LOAD_DELAY);
    }

    // Detect "Sign in" / login wall
    if (await this._isLoginWall()) {
      throw new GeminiAccountBlockedError('Gemini login required — open the profile manually and sign in once');
    }

    try {
      await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    } catch {
      await this._dismissWelcome();
    }

    // Attach the network listener once. It listens on this.page for the rest
    // of the chat's lifetime (until close()). Survives page.goto() — the
    // listener binds to the page, not the navigation context.
    if (!this._netListener) {
      this._netListener = attachGeminiListener(this.page);
      Logger.info('[GeminiImageChat] network listener attached');
    }
    Logger.info('[GeminiImageChat] page ready');
    return this;
  }

  /**
   * Open a fresh conversation and send the initial recipe-context message
   * (text only — Gemini answers with a short "ready" ack). After this, all
   * subsequent generate() calls go in this same chat = visual memory chain.
   *
   * @param {string} introText  — full recipe JSON + plan + "tu vas générer N images"
   */
  /**
   * Start a fresh Gemini chat. Optionally attach reference images at turn 1
   * (e.g. Pinterest food photos) so the rest of the conversation has visual
   * grounding for the dish from the very first turn.
   *
   * @param {string} introText
   * @param {string[]} [refImagePaths=[]] — absolute paths to images to attach at start
   */
  /**
   * @param {string} introText
   * @param {string[]} refImagePaths
   * @param {object} [opts]
   * @param {boolean} [opts.deepResearch=false] — when true, activate Outils →
   *   "Deep Research" before sending the prompt. Used by the recipe-gen turn so
   *   Gemini grounds answers in real food blogs (not made-up content). The prompt
   *   text already says "web search is enabled", but Gemini doesn't actually
   *   browse unless the tool chip is on.
   */
  async startNewChat(introText, refImagePaths = [], opts = {}) {
    Logger.step('GeminiImageChat', 'Starting new chat for recipe...');
    // Navigate fresh — easiest way to get a brand new chat (no stale history)
    await this.page.goto(GEMINI_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(PAGE_LOAD_DELAY);
    await this._dismissWelcome();
    await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });

    // Reset state for this new chat
    this._seenImageHashes = new Set();

    // Optional: attach reference images (Pinterest food photos) for visual grounding
    const refs = (refImagePaths || []).filter(p => p && existsSync(p));
    if (refs.length > 0) {
      Logger.info(`[GeminiImageChat] attaching ${refs.length} reference image(s) at chat start`);
      try {
        await this._attachFiles(refs);
        // Tiny pause so the upload settles before we type
        await this.page.waitForTimeout(1500);
      } catch (e) {
        Logger.warn(`[GeminiImageChat] ref-image attach at start failed (${e.message}) — continuing with text only`);
      }
    }

    // Optional: activate "Deep Research" tool so Gemini actually browses the web
    // for this turn. Without this, Gemini answers from training data only and
    // the recipes drift to generic templates.
    if (opts.deepResearch) {
      try {
        await this._selectDeepResearchTool();
      } catch (e) {
        Logger.warn(`[GeminiImageChat] Deep Research activation failed (${e.message.split('\n')[0]}) — continuing without web browsing`);
      }
    }

    // Reset network listener state before sending — fresh capture for this turn
    if (this._netListener) this._netListener.reset();

    // Send the intro (with optional refs attached)
    await this._typePrompt(introText);
    await this._clickSend();

    // Read the response from the network listener (StreamGenerate API),
    // not from the DOM — much more reliable. Falls back to DOM scraping
    // only if the listener captured nothing (e.g. listener wasn't attached
    // for legacy callers).
    let responseText = '';
    if (this._netListener) {
      try {
        const snap = await this._netListener.waitForResponse({
          timeout: 600000,
          quietMs: 4000,
          minTextLen: 1,
        });
        responseText = snap.text || '';
        Logger.info(`[GeminiImageChat] response via network listener: ${responseText.length} chars (${snap.bodiesSeen} bodies, ${snap.rawChunks} chunks)`);
      } catch (e) {
        Logger.warn(`[GeminiImageChat] network listener wait failed (${e.message.split('\n')[0]}) — falling back to DOM`);
        await this._waitForTextResponse();
        responseText = await this._extractLastResponseText();
      }
    } else {
      await this._waitForTextResponse();
      responseText = await this._extractLastResponseText();
    }
    Logger.success(`[GeminiImageChat] chat initialized, ready for image generations (response ${responseText.length} chars)`);
    return responseText;
  }

  /**
   * Open Outils drawer and click "Deep Research" so Gemini browses the web for
   * this turn. Mirrors _selectImageTool's locator-click pattern. THROWS on
   * failure — caller decides whether it's fatal.
   */
  async _selectDeepResearchTool() {
    // Click Outils
    const outilsLocator = this.page.locator(
      'button:has-text("Outils"), button:has-text("Tools"), button[aria-label*="Outils" i], button[aria-label*="Tools" i], button.toolbox-drawer-button'
    ).first();
    await outilsLocator.click({ timeout: 5000 });
    await this.page.waitForTimeout(700);

    // Click "Deep Research" — text varies (FR/EN), match all variants
    const deepResearchLocator = this.page.locator(
      'toolbox-drawer-item:has-text("Deep Research"), toolbox-drawer-item:has-text("Recherche approfondie"), [role="menuitem"]:has-text("Deep Research"), [role="menuitem"]:has-text("Recherche approfondie")'
    ).first();
    await deepResearchLocator.click({ timeout: 5000 });
    await this.page.waitForTimeout(900);

    Logger.info('[GeminiImageChat] "Deep Research" tool activated for web-grounded recipe gen');
    return true;
  }

  /**
   * Extract the text content of the LAST model response.
   * Used by callers that send a recipe-gen prompt as the intro and need to
   * parse the JSON answer from Gemini.
   */
  async _extractLastResponseText() {
    return await this.page.evaluate(() => {
      const sels = ['model-response', '.response-container', 'message-content', '.markdown'];
      let blocks = [];
      for (const sel of sels) {
        blocks = Array.from(document.querySelectorAll(sel));
        if (blocks.length > 0) break;
      }
      if (blocks.length === 0) return '';
      const last = blocks[blocks.length - 1];
      // Prefer code blocks (JSON often wrapped in ```)
      const codes = last.querySelectorAll('pre code, code-block');
      if (codes.length > 0) {
        let largest = '';
        codes.forEach(c => { if (c.textContent.length > largest.length) largest = c.textContent; });
        if (largest.trim().startsWith('{') || largest.trim().startsWith('[')) return largest.trim();
      }
      const clone = last.cloneNode(true);
      clone.querySelectorAll('button').forEach(b => b.remove());
      return (clone.innerText || clone.textContent || '').trim();
    });
  }

  async close() {
    if (this._netListener) {
      try { this._netListener.dispose(); } catch {}
      this._netListener = null;
    }
    if (this.page) {
      try { await this.page.close(); } catch {}
      this.page = null;
    }
  }

  /**
   * Flow has closeSession() — we keep the same name for orchestrator parity,
   * but here it just clears the page reference. Real cleanup is via close().
   */
  async closeSession() {
    // No-op — the chat must persist across generate() calls within a recipe.
  }

  /**
   * Send a text-only follow-up turn into the existing chat and wait for the
   * model's reply to settle. Used by callers (the GV orchestrator) that need
   * to inject mid-conversation instructions without triggering image-gen.
   *
   * Caller is responsible for ensuring the chat is already open (via
   * startNewChat() or a prior generate() call).
   */
  async sendFollowupText(text) {
    if (!this.page) throw new Error('Gemini chat not initialized — call startNewChat first');
    await this._typePrompt(text);
    await this._clickSend();
    await this._waitForTextResponse();
  }

  // ───────────────────────────────────────────────────────────────────
  // Public API — mirrors FlowPage.generate()
  // ───────────────────────────────────────────────────────────────────

  /**
   * @param {string}   prompt              — full prompt (built by orchestrator with same builders Flow uses)
   * @param {string}   backgroundFilePath  — path to the background reference image (jpg/png)
   * @param {string[]} contextFilePaths    — additional reference images (e.g. previous step photos)
   * @param {string}   aspectRatio         — '4:5' | '16:9' | '1:1' (passed in prompt; Gemini infers from refs)
   * @param {string}   outputPath          — where to write the resulting image
   * @param {object}   [opts]
   * @returns {boolean} success
   */
  async generate(prompt, backgroundFilePath, contextFilePaths = [], aspectRatio = '4:5', outputPath, opts = {}) {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        Logger.debug(`[GeminiImageChat] attempt ${attempt}/${MAX_ATTEMPTS}`);

        // 0) Wait for the chat to be IDLE before doing anything. Gemini's UI
        // can still be streaming text from the previous turn (acknowledgement
        // of the consistency-rules turn, or commentary after an image). If we
        // start typing/attaching while it's streaming, the new prompt gets
        // mangled with the unfinished response. _waitForChatIdle polls the
        // stop-button state until it stays gone for several ticks.
        await this._waitForChatIdle();

        // 1) Snapshot DOM counts BEFORE send — anchors for "did the message
        // land" and "did Gemini start a new response" detection.
        this._userMsgCountBefore = await this._countUserMessages();
        this._modelResponseCountBefore = await this._countModelResponses();

        // Tag every existing <img> with data-pre-send so any <img> without
        // the tag after send is genuinely new (defends against Gemini
        // re-rendering an old image with a fresh blob URL).
        await this.page.evaluate(() => {
          for (const img of document.querySelectorAll('img')) {
            img.setAttribute('data-pre-send', '1');
          }
        });
        Logger.debug(`[GeminiImageChat] before-send: ${this._userMsgCountBefore} user msgs, ${this._modelResponseCountBefore} model responses, all imgs tagged`);

        // 2) Attach refs FIRST. File attachment is what tends to deselect
        // any active tool (Gemini's UI auto-switches to "vision" mode when
        // an image is attached). Doing this before tool selection means the
        // tool we select afterwards is the one that actually persists to send.
        const refs = [backgroundFilePath, ...contextFilePaths].filter(p => p && existsSync(p));
        if (refs.length > 0) {
          await this._attachFiles(refs);
        }

        // 3) NOW force image-creation mode. Done AFTER attach so the
        // attachment can't auto-deselect. Throws if it can't verify the
        // active-state chip — caller's retry loop handles it.
        await this._selectImageTool();

        // 4) Type the prompt
        const fullPrompt = aspectRatio
          ? `${prompt}\n\nFormat: ${aspectRatio}, photorealistic, high quality.`
          : prompt;
        await this._typePrompt(fullPrompt);

        // 4b) Re-verify image tool RIGHT BEFORE send — typing can occasionally
        // flip Gemini back to text mode if the prompt looks like a question.
        // If the chip is gone, re-select. Throw if re-select fails.
        if (!(await this._isImageToolActive())) {
          Logger.warn('[GeminiImageChat] image tool deselected after typing prompt — re-selecting');
          await this._selectImageTool(); // throws on failure
        }

        // Reset network listener BEFORE send so this turn's image bytes
        // accumulate cleanly (no leftovers from prior turn).
        if (this._netListener) this._netListener.reset();

        await this._clickSend();

        // Confirm submission landed — user message count must increase
        const submitted = await this._waitForUserMessage(15000);
        if (!submitted) {
          throw new Error('Send did not land — user message count never increased (button stuck disabled?)');
        }
        Logger.debug('[GeminiImageChat] submission confirmed (user message landed)');

        // Wait for raw image bytes via the network listener (intercepts the
        // googleusercontent.com response directly). Falls back to DOM/canvas
        // extraction only if the listener isn't attached for any reason.
        let imgBuf = null;
        let imgSource = '';
        if (this._netListener) {
          try {
            const captured = await this._netListener.waitForImage({
              timeout: 600000,
              minBytes: 30000,
              quietMs: 2500,
            });
            imgBuf = captured.buf;
            imgSource = `network:${captured.url.substring(0, 80)}`;
          } catch (e) {
            Logger.warn(`[GeminiImageChat] network image wait failed (${e.message.split('\n')[0]}) — falling back to DOM/canvas`);
          }
        }
        if (!imgBuf) {
          const newImageSrc = await this._waitForNewImage();
          if (!newImageSrc) throw new Error('No new image appeared in chat after send');
          await this._downloadImageToFile(newImageSrc, outputPath);
          if (!existsSync(outputPath)) throw new Error('Image not written to disk');
          imgBuf = readFileSync(outputPath);
          imgSource = 'dom-canvas';
        } else {
          // Write the raw bytes from the network capture directly
          try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}
          writeFileSync(outputPath, imgBuf);
          // Strip Gemini watermark in place (mirrors the DOM path's behaviour)
          await removeWatermarkInPlace(outputPath);
          imgBuf = readFileSync(outputPath); // re-read post-strip for hash
        }

        // Validate output
        const size = statSync(outputPath).size;
        if (size < 5000) {
          throw new Error(`Image too small (${size} bytes) — likely corrupted`);
        }

        // Defensive MD5 dedup — catches Gemini re-rendering a prior turn's
        // image even byte-identically (the new flow doesn't make this less
        // likely, just easier to spot).
        const hash = await this._fileHash(outputPath);
        if (this._seenImageHashes.has(hash)) {
          try { unlinkSync(outputPath); } catch {}
          throw new Error(`Duplicate image detected (md5=${hash.slice(0, 8)}) — Gemini likely re-rendered a prior turn instead of generating, retrying`);
        }
        this._seenImageHashes.add(hash);

        Logger.success(`[GeminiImageChat] generated ${(size / 1024).toFixed(0)}KB md5=${hash.slice(0, 8)} via ${imgSource} → ${outputPath}`);
        return true;
      } catch (err) {
        if (err instanceof GeminiRateLimitError || err instanceof GeminiAccountBlockedError) {
          Logger.warn(`[GeminiImageChat] ${err.name} — propagating to orchestrator`);
          throw err;
        }
        // Detect rate-limit signals in DOM after a failure
        if (await this._detectRateLimit()) {
          throw new GeminiRateLimitError();
        }
        Logger.error(`[GeminiImageChat] attempt ${attempt} failed: ${err.message}`);
        await this._screenshot(`error-attempt${attempt}`);
        if (attempt < MAX_ATTEMPTS) {
          await this.page.waitForTimeout(3000 * attempt);
        }
      }
    }
    Logger.error(`[GeminiImageChat] all ${MAX_ATTEMPTS} attempts failed for: ${prompt.substring(0, 80)}`);
    return false;
  }

  // ───────────────────────────────────────────────────────────────────
  // Internals — input
  // ───────────────────────────────────────────────────────────────────

  async _typePrompt(text) {
    const input = await this.page.waitForSelector(SEL.promptInput, { timeout: 15000 });
    await input.click();
    await this.page.waitForTimeout(200);
    // Clear (in case anything leaked from a previous attempt)
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(80);
    await this.page.keyboard.press('Delete');
    await this.page.waitForTimeout(80);
    // Insert
    await this.page.keyboard.insertText(text);
    await this.page.waitForTimeout(POST_PROMPT_DELAY);

    // Verify
    const len = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el?.textContent?.trim()?.length || 0;
    }, SEL.promptInput);

    if (len < Math.min(10, text.length / 2)) {
      // Clipboard fallback (same trick as gemini-chat.js)
      Logger.debug('[GeminiImageChat] insertText sparse, trying clipboard paste...');
      await this.page.evaluate(async (t) => {
        const el = document.querySelector('div.ql-editor[contenteditable="true"], rich-textarea .ql-editor');
        if (!el) return;
        el.focus();
        const dt = new DataTransfer();
        dt.setData('text/plain', t);
        el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      }, text);
      await this.page.waitForTimeout(POST_PROMPT_DELAY);
    }
  }

  async _clickSend() {
    await this.page.waitForTimeout(400);

    // CRITICAL: the send button stays disabled while attached files are still
    // uploading AND while Gemini is still streaming the previous response.
    // If we click it while disabled, the message just sits in the input box
    // forever — that's how Step 3 stalled silently for 6h on the first run.
    // Wait for the button to become ENABLED before clicking.
    const SEND_READY_TIMEOUT = 60000; // 60s — uploads can be slow on weak connections
    const POLL = 500;
    const start = Date.now();
    let lastReason = 'no send button found';
    while (Date.now() - start < SEND_READY_TIMEOUT) {
      const status = await this.page.evaluate(() => {
        // Find the most likely send button
        const candidates = Array.from(document.querySelectorAll('button')).filter(b => {
          const al = (b.getAttribute('aria-label') || '').toLowerCase();
          return al.includes('send') || al.includes('envoyer') || al.includes('submit');
        });
        if (candidates.length === 0) return { found: false };
        // Pick the first visible one
        const visible = candidates.find(b => b.offsetWidth > 0);
        if (!visible) return { found: true, visible: false };
        return {
          found: true,
          visible: true,
          disabled: visible.disabled || visible.getAttribute('aria-disabled') === 'true',
          ariaLabel: visible.getAttribute('aria-label') || ''
        };
      });

      if (status.found && status.visible && !status.disabled) {
        // Click it
        const clicked = await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button')).filter(b => {
            const al = (b.getAttribute('aria-label') || '').toLowerCase();
            return (al.includes('send') || al.includes('envoyer') || al.includes('submit'))
                   && b.offsetWidth > 0 && !b.disabled
                   && b.getAttribute('aria-disabled') !== 'true';
          });
          if (btns.length === 0) return false;
          btns[0].click();
          return true;
        });
        if (clicked) {
          Logger.debug(`[GeminiImageChat] send clicked (after ${((Date.now() - start) / 1000).toFixed(1)}s wait)`);
          await this.page.waitForTimeout(POST_SEND_DELAY);
          return;
        }
      }

      lastReason = status.found
        ? (status.disabled ? 'send button disabled (upload still in progress?)' : 'send button not visible')
        : 'no send button on page';
      await this.page.waitForTimeout(POLL);
    }

    Logger.warn(`[GeminiImageChat] send button never became clickable (${lastReason}) — falling back to Enter key`);
    await this.page.keyboard.press('Enter');
    await this.page.waitForTimeout(POST_SEND_DELAY);
  }

  async _attachFiles(filePaths) {
    Logger.debug(`[GeminiImageChat] attaching ${filePaths.length} file(s)`);

    // Gemini flow (verified via DOM inspector):
    //   1) Click "+" button (class="upload-card-button", opens #upload-file-menu)
    //   2) Click "Importer depuis l'appareil" menu item → triggers OS file chooser
    //   3) chooser.setFiles(...)
    const opened = await this._clickAttachButton();
    if (!opened) throw new Error('Gemini "+" attach button not found');
    await this.page.waitForTimeout(600); // let menu render

    // Some accounts get a one-time consent modal when first opening the
    // upload menu ("Création de contenus à partir d'images et de fichiers"
    // / "Content creation from images and files"). Auto-accept it so the
    // file picker can open afterwards. Clicking Accept dismisses the modal
    // but does NOT open the chooser — we need to re-click the menu after.
    const acceptedConsent = await this._dismissUploadConsentModal();
    if (acceptedConsent) {
      Logger.info('[GeminiImageChat] dismissed upload consent modal — re-opening attach menu');
      await this.page.waitForTimeout(800);
      await this._clickAttachButton();
      await this.page.waitForTimeout(600);
    }

    // Catch the filechooser that the menu item opens
    let chooser;
    try {
      [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 8000 }),
        this._clickUploadMenuItem(),
      ]);
    } catch (e) {
      // Fallback: maybe a hidden input exists once the menu is open
      const input = await this.page.$(SEL.fileInput);
      if (input) {
        await input.setInputFiles(filePaths);
        await this.page.waitForTimeout(POST_ATTACH_DELAY);
        await this._waitForUploadThumbnails(filePaths.length);
        return;
      }
      throw new Error(`Filechooser did not open after menu click: ${e.message}`);
    }

    await chooser.setFiles(filePaths);
    await this.page.waitForTimeout(POST_ATTACH_DELAY);
    await this._waitForUploadThumbnails(filePaths.length);
  }

  async _clickAttachButton() {
    // Gemini's attach button: <button aria-label='Ouvrir le menu "Importer un fichier"'
    // class="upload-card-button" aria-controls="upload-file-menu">.
    // Clicking opens a menu — the file chooser appears after we click a menu item.
    const clicked = await this.page.evaluate(() => {
      // Most reliable: the well-known class and aria-controls
      const direct = document.querySelector('button.upload-card-button, button[aria-controls="upload-file-menu"]');
      if (direct && direct.offsetWidth > 0) { direct.click(); return 'class:upload-card-button'; }

      // Aria-label fallbacks (FR + EN)
      const keywords = ['importer un fichier', 'importer une image', 'importer', 'attach', 'upload', 'add file', 'add image', 'add photo', 'add files'];
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of buttons) {
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        if (al && keywords.some(k => al.includes(k))) {
          if (b.offsetWidth > 0) { b.click(); return 'aria:' + al; }
        }
      }
      return null;
    });
    if (clicked) Logger.debug(`[GeminiImageChat] attach clicked via ${clicked}`);
    return !!clicked;
  }

  /**
   * Open the "Outils" (Tools) drawer and click "Créer une image" so Gemini
   * is forced into image-generation mode for the next message. Without this,
   * Gemini answers in text mode and refuses with "We think we might have
   * gotten this wrong. Please try again with 'Create Image' enabled."
   *
   * THROWS on failure — earlier versions returned false on failure and the
   * caller silently sent the prompt anyway, leading to text-mode refusals
   * that wasted retry attempts. We'd rather fail this attempt fast and let
   * generate()'s retry loop run a fresh selection cycle.
   *
   * Verification:
   *   1. Check if the active-tool chip is already visible (tool was selected
   *      on a prior turn and persists). If so, no-op.
   *   2. Otherwise, find the Outils button via multiple selectors, click it,
   *      then click "Créer une image" inside the drawer.
   *   3. Re-verify the chip appeared. If not, throw.
   */
  async _isImageToolActive() {
    // Detection layered from strict to permissive. The chip Gemini shows when
    // a tool is active sits NEAR the prompt input (not inside an open menu/drawer).
    // We check a few selector patterns since Gemini's chip implementation
    // varies across UI versions / locales.
    return await this.page.evaluate(() => {
      const isInsideOpenMenu = (el) =>
        !!el.closest('[role="menu"], mat-menu-panel, [class*="menu-panel"], [class*="drawer-panel"], [class*="toolbox-drawer"][open], cdk-overlay-pane');

      const matchesCreateImage = (el) => {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return txt.includes('créer une image') || txt.includes('create image') || txt.includes('create an image');
      };

      // Layer 1 — strict: selected/pressed/checked state on the matching item.
      const strictSels = [
        'toolbox-drawer-item[selected]',
        '[role="button"][aria-pressed="true"]',
        '[aria-checked="true"]',
        '[class*="toolbox-drawer-item"][selected]',
      ];
      for (const sel of strictSels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.offsetWidth === 0) continue;
          if (isInsideOpenMenu(el)) continue;
          if (matchesCreateImage(el)) return true;
        }
      }

      // Layer 2 — chip/pill near the input bar: any small visible element
      // outside a menu containing "Créer une image" text. This catches custom
      // chip implementations (tool-chip, active-tool, pill-component, etc.)
      // that don't use a standard aria attribute.
      const inputArea = document.querySelector('rich-textarea, .ql-editor, div[aria-label*="prompt" i][contenteditable="true"]');
      const inputContainer = inputArea?.closest('[class*="input-area"], [class*="prompt-area"], [class*="composer"], form, footer') || document.body;
      for (const el of inputContainer.querySelectorAll('*')) {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) continue;
        if (isInsideOpenMenu(el)) continue;
        // Avoid the Outils button itself and very large containers.
        const r = el.getBoundingClientRect();
        if (r.width > 400 || r.height > 80) continue;
        if (!matchesCreateImage(el)) continue;
        // Filter: must look chip-like (has aria role, or class hint)
        const cls = el.className || '';
        const role = el.getAttribute('role') || '';
        if (
          /chip|pill|tool|tag|badge|active/i.test(cls) ||
          role === 'button' ||
          el.tagName.toLowerCase() === 'toolbox-drawer-item'
        ) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Open the "Outils" (Tools) drawer and click "Créer une image" so Gemini
   * is forced into image-generation mode for the next message. Without this,
   * Gemini answers in text mode and refuses with "We think we might have
   * gotten this wrong. Please try again with 'Create Image' enabled."
   *
   * Uses Playwright locator.click() (synthetic mouse event sequence) instead
   * of element.click() inside page.evaluate(). Gemini's web components
   * (toolbox-drawer-item, etc.) handle real mouse events but ignore the
   * programmatic click() that a node.click() call dispatches — that's why
   * the earlier evaluate-based clicks "succeeded" technically but the active
   * chip never appeared.
   *
   * THROWS on failure — the caller's retry loop runs a fresh selection cycle.
   */
  async _selectImageTool() {
    // Already active? Skip (idempotent).
    if (await this._isImageToolActive()) {
      Logger.debug('[GeminiImageChat] image tool already active — skipping selection');
      return true;
    }

    // ── Step 1 — open the Outils drawer (real Playwright click) ──
    const outilsLocator = this.page.locator(
      'button:has-text("Outils"), button:has-text("Tools"), button[aria-label*="Outils" i], button[aria-label*="Tools" i], button.toolbox-drawer-button'
    ).first();
    try {
      await outilsLocator.click({ timeout: 5000 });
    } catch (e) {
      throw new Error(`[GeminiImageChat] could not click Outils drawer button (${e.message.split('\n')[0]}) — Gemini DOM may have changed`);
    }
    await this.page.waitForTimeout(700);

    // ── Step 2 — click "Créer une image" via locator (real click) ──
    // toolbox-drawer-item is Gemini's custom web component for drawer items;
    // text-based locators target the right one regardless of shadow DOM.
    const createImgLocator = this.page.locator(
      'toolbox-drawer-item:has-text("Créer une image"), toolbox-drawer-item:has-text("Create an image"), toolbox-drawer-item:has-text("Create image"), [role="menuitem"]:has-text("Créer une image"), button:has-text("Créer une image"):not(:has-text("vidéo")):not(:has-text("musique"))'
    ).first();
    try {
      await createImgLocator.click({ timeout: 5000 });
    } catch (e) {
      try { await this.page.keyboard.press('Escape'); } catch {}
      throw new Error(`[GeminiImageChat] could not click "Créer une image" item (${e.message.split('\n')[0]}) — Gemini may have removed it (account/region restriction?)`);
    }
    await this.page.waitForTimeout(1000); // chip render

    // ── Step 3 — strict verification ──
    if (!(await this._isImageToolActive())) {
      throw new Error('[GeminiImageChat] image tool clicked but no active-state chip appeared — Gemini ignored the selection');
    }
    Logger.info('[GeminiImageChat] "Créer une image" tool active (verified via chip)');
    return true;
  }

  /**
   * Detect and dismiss the one-time "Content creation from images and files"
   * consent modal that Gemini shows on first upload attempt. Returns true if
   * a modal was found and accepted, false otherwise.
   */
  async _dismissUploadConsentModal() {
    return await this.page.evaluate(() => {
      // Look for the modal text — French + English wording
      const modalKeywords = [
        'création de contenus à partir d\'images',
        'creation of content from images',
        'content creation from images',
        'images et de fichiers',
        'images and files'
      ];
      const candidates = Array.from(document.querySelectorAll('mat-dialog-container, [role="dialog"], .cdk-dialog-container'));
      const modal = candidates.find(el => {
        const txt = (el.innerText || '').toLowerCase();
        return modalKeywords.some(k => txt.includes(k));
      });
      if (!modal) return false;
      // Find the Accept button — text "Accepter" or "Accept"
      const buttons = Array.from(modal.querySelectorAll('button'));
      const acceptBtn = buttons.find(b => {
        const txt = (b.innerText || '').trim().toLowerCase();
        return txt === 'accepter' || txt === 'accept' || txt === 'i agree' || txt === 'j\'accepte';
      });
      if (!acceptBtn) return false;
      acceptBtn.click();
      return true;
    });
  }

  async _clickUploadMenuItem() {
    // Menu opened by the "+" button has items like:
    //   "Importer depuis l'appareil" / "Upload from device"
    //   "Importer depuis Drive" / "Add from Drive"
    // We want the local-device option (which triggers the OS file chooser).
    return await this.page.evaluate(() => {
      // The menu container has id "upload-file-menu"
      const menu = document.querySelector('#upload-file-menu, [id*="upload-file-menu"]') || document;
      const items = Array.from(menu.querySelectorAll('button, [role="menuitem"], a, li'));
      // Must be local device option, NOT Drive/Photos/etc.
      const localKeywords = ['appareil', 'device', 'computer', 'ordinateur', 'mon appareil', 'this device'];
      const fallbackKeywords = ['importer', 'upload', 'téléverser'];
      // First pass — explicit "local device" wording
      for (const i of items) {
        const txt = (i.textContent || '').trim().toLowerCase();
        if (!txt || i.offsetWidth === 0) continue;
        if (localKeywords.some(k => txt.includes(k))) { i.click(); return 'local:' + txt.slice(0, 40); }
      }
      // Second pass — generic "import" / "upload" but avoid Drive
      for (const i of items) {
        const txt = (i.textContent || '').trim().toLowerCase();
        if (!txt || i.offsetWidth === 0) continue;
        if (txt.includes('drive') || txt.includes('photos')) continue;
        if (fallbackKeywords.some(k => txt.includes(k))) { i.click(); return 'fallback:' + txt.slice(0, 40); }
      }
      return null;
    });
  }

  async _waitForUploadThumbnails(expectedCount) {
    // Best-effort: wait for thumbnail tiles to appear above the prompt area.
    // If none appear after a few seconds, we proceed anyway — the upload may
    // still be in flight, we'll catch it via the response wait.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await this.page.evaluate(() => {
        // Generic thumbnail selectors near the prompt
        const sels = [
          '[class*="attachment"] img',
          '[class*="thumbnail"] img',
          '[class*="upload"] img',
          'input[type="file"] ~ * img'
        ];
        let count = 0;
        for (const s of sels) count += document.querySelectorAll(s).length;
        return count;
      });
      if (found >= expectedCount) return;
      await this.page.waitForTimeout(500);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Internals — response detection
  // ───────────────────────────────────────────────────────────────────

  async _waitForTextResponse() {
    // Used after the intro message — Gemini answers with text ("ok ready")
    const start = Date.now();
    let done = 0;
    while (Date.now() - start < 60000) {
      await this.page.waitForTimeout(GEN_POLL_INTERVAL);
      const active = await this._isActive();
      if (!active) {
        done++;
        if (done >= GEN_DONE_CONFIRM_TICKS) return;
      } else {
        done = 0;
      }
    }
  }

  async _waitForNewImage() {
    // STRATEGY (v2, anchored on response message count):
    // 1) Wait for the model-response message count to increase past
    //    `_modelResponseCountBefore`. A new response message = Gemini
    //    actually started a new turn. This is the only reliable signal.
    // 2) Once that happens, scope image search to the LATEST response
    //    container only. Re-rendered old images are in OLDER containers
    //    and naturally excluded.
    // 3) Find an <img> in that container, wait for it to be loaded
    //    (naturalWidth/Height > 100), return src.
    // 4) Then wait for chat idle so the next prompt doesn't interrupt.
    Logger.debug('[GeminiImageChat] waiting for new model response + image...');
    const start = Date.now();
    let stableHits = 0;
    let newResponseSeen = false;
    let lastLoggedCount = -1;

    while (Date.now() - start < GEN_TIMEOUT) {
      await this.page.waitForTimeout(GEN_POLL_INTERVAL);

      const responseCount = await this._countModelResponses();
      if (responseCount !== lastLoggedCount) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        Logger.debug(`[GeminiImageChat] +${elapsed}s — model responses: ${responseCount} (before send: ${this._modelResponseCountBefore})`);
        lastLoggedCount = responseCount;
      }

      // Step 1 — wait for new response container
      if (responseCount <= this._modelResponseCountBefore) {
        // No new response yet. Sanity check for refusal / rate-limit only
        // after enough time has elapsed AND Gemini has visibly stopped
        // working (avoids false positive on streaming setup text).
        const elapsed = Date.now() - start;
        if (elapsed > 60000 && !(await this._isActive())) {
          if (await this._detectRateLimit()) throw new GeminiRateLimitError();
          if (await this._detectRefusal()) throw new Error('Gemini refused to generate this image (content policy)');
        }
        continue;
      }
      newResponseSeen = true;

      // Step 2 — find image in the LATEST response container
      const imgInfo = await this._findImageInLatestResponse();
      if (!imgInfo || !imgInfo.src) continue;

      // Step 3 — confirm fully loaded
      if (!imgInfo.loaded) {
        stableHits = 0;
        continue;
      }
      stableHits++;
      Logger.debug(`[GeminiImageChat] image found in new response (hit ${stableHits}/2): ${imgInfo.src.substring(0, 80)}... ${imgInfo.naturalWidth}x${imgInfo.naturalHeight}`);
      if (stableHits >= 2) {
        // Step 4 — wait for chat idle so the next prompt doesn't interrupt
        // any commentary text Gemini is still streaming.
        await this._waitForChatIdle();
        return imgInfo.src;
      }
    }
    if (newResponseSeen) {
      Logger.warn('[GeminiImageChat] new response appeared but no image was loaded inside it — Gemini likely answered with text only');
    } else {
      Logger.warn('[GeminiImageChat] no new model response appeared — submission may have failed silently');
    }
    return null;
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers — message count anchors
  // ───────────────────────────────────────────────────────────────────

  async _countUserMessages() {
    return await this.page.evaluate(() => {
      // Gemini wraps user turns in <user-query> custom elements.
      // Fall back to common class patterns for cross-version safety.
      const sels = [
        'user-query',
        '[class*="user-query"]',
        '[class*="user-message"]',
        '[class*="user-prompt"]'
      ];
      const seen = new Set();
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) seen.add(el);
      }
      return seen.size;
    });
  }

  async _countModelResponses() {
    return await this.page.evaluate(() => {
      const sels = ['model-response', '.response-container', 'message-content'];
      const seen = new Set();
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) seen.add(el);
      }
      return seen.size;
    });
  }

  async _waitForUserMessage(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const c = await this._countUserMessages();
      if (c > this._userMsgCountBefore) return true;
      await this.page.waitForTimeout(500);
    }
    return false;
  }

  /**
   * Find a NEW image — one that wasn't tagged with data-pre-send before
   * the current send. Filters out user-uploaded thumbnails (inside the
   * user-query bubble or attachment preview) so we only return Gemini's
   * generated output. Returns { src, loaded, naturalWidth, naturalHeight, where } or null.
   */
  async _findImageInLatestResponse() {
    return await this.page.evaluate(() => {
      // Strategy:
      // 1. Locate the LATEST model-response container (Gemini wraps each turn
      //    in a <model-response> custom element; fall back to common class
      //    patterns for robustness).
      // 2. Within that container ONLY, pick the FIRST untagged <img> that
      //    looks like a generated image (size > 200px, not an avatar/icon,
      //    not inside a user-query bubble, not the attached reference thumb).
      //
      // FIRST-match (not LAST) is critical: Gemini sometimes produces
      // multiple images for one prompt — variations, or anticipated future
      // steps when our prompt says "Image N of M in series". The PRIMARY
      // answer is image #1; the rest are bonus material we must ignore.
      // Picking the last image in those cases yields the WRONG content
      // (e.g. a step-3 image saved as the ingredients flatlay).
      const responseSelectors = [
        'model-response',
        '.response-container',
        'message-content',
      ];
      let latestResponse = null;
      for (const sel of responseSelectors) {
        const candidates = document.querySelectorAll(sel);
        if (candidates.length > 0) {
          latestResponse = candidates[candidates.length - 1];
          break;
        }
      }
      if (!latestResponse) return null;

      // Iterate FORWARD inside the latest response — primary answer first.
      const imgs = Array.from(latestResponse.querySelectorAll('img:not([data-pre-send])'));
      for (const img of imgs) {
        const src = img.src || img.getAttribute('src') || '';
        if (!src) continue;
        if (src.startsWith('data:image/svg')) continue;
        if (src.includes('icon') || src.includes('avatar')) continue;
        // Skip user-uploaded thumbnails (the bg/refs we just attached). They
        // shouldn't appear inside the model-response container, but defend
        // anyway in case Gemini inlines them.
        const userBubble = img.closest('user-query, [class*="user-query"], [class*="user-message"], [class*="user-prompt"], [class*="attachment-preview"], [class*="upload-preview"], [class*="file-preview"]');
        if (userBubble) continue;
        const r = img.getBoundingClientRect();
        // Generated images are big; user-attachment thumbs are usually < 200px
        if (r.width < 200 || r.height < 200) continue;
        return {
          src,
          loaded: img.complete && img.naturalWidth > 100 && img.naturalHeight > 100,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          where: img.parentElement?.tagName + '.' + (img.parentElement?.className || '').slice(0, 40)
        };
      }
      return null;
    });
  }

  async _isActive() {
    return await this.page.evaluate((stopSel) => {
      // Stop button visible = still generating
      const btns = document.querySelectorAll(stopSel);
      for (const b of btns) {
        if (b.offsetWidth > 0 && !b.disabled) return true;
      }
      // Generic loading indicators
      if (document.querySelector('[class*="loading"], [class*="streaming"], [class*="thinking"]')) return true;
      return false;
    }, SEL.stopButton);
  }

  /**
   * Stricter idle check than _isActive — only looks at the stop button,
   * NOT random "loading" CSS classes (which Gemini keeps mounted forever).
   * The stop button is the authoritative "Gemini is currently writing" signal.
   */
  async _isStopButtonVisible() {
    return await this.page.evaluate((stopSel) => {
      const btns = document.querySelectorAll(stopSel);
      for (const b of btns) {
        if (b.offsetWidth > 0 && !b.disabled) return true;
      }
      return false;
    }, SEL.stopButton);
  }

  /**
   * Wait until Gemini is fully done — image rendered AND any trailing
   * commentary text fully streamed — before returning. If we send the next
   * prompt while the stop button is still visible, Gemini aborts the
   * previous response with "Vous avez interrompu cette réponse" and the
   * chat memory chain is broken for the rest of the recipe.
   *
   * Returns when the stop button has been hidden for IDLE_CONFIRM_TICKS
   * consecutive polls.
   */
  async _waitForChatIdle(maxWaitMs = 120000) {
    const POLL = 1500;
    const IDLE_CONFIRM_TICKS = 3; // 3 × 1.5s = 4.5s of confirmed idle
    const start = Date.now();
    let idleCount = 0;
    Logger.debug('[GeminiImageChat] waiting for chat to go idle (post-image streaming)...');
    while (Date.now() - start < maxWaitMs) {
      await this.page.waitForTimeout(POLL);
      const stopVisible = await this._isStopButtonVisible();
      if (!stopVisible) {
        idleCount++;
        if (idleCount >= IDLE_CONFIRM_TICKS) {
          Logger.debug(`[GeminiImageChat] chat idle (${((Date.now() - start) / 1000).toFixed(0)}s post-image)`);
          // Small extra grace period — UI re-renders sometimes briefly
          // re-mount the stop button for a frame after final text settles.
          await this.page.waitForTimeout(800);
          return;
        }
      } else {
        idleCount = 0;
      }
    }
    Logger.warn(`[GeminiImageChat] chat-idle timeout after ${maxWaitMs / 1000}s — proceeding anyway`);
  }

  async _getAllResponseImageSrcs() {
    // Scan ALL <img>s and filter by heuristics — safer than depending on
    // Gemini's evolving Angular component structure. We exclude tiny icons,
    // user-message thumbnails (left side or above prompt input), and known
    // chrome (avatars, sidebar logos).
    return await this.page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const out = [];
      for (const img of imgs) {
        const src = img.src || img.getAttribute('src') || '';
        if (!src) continue;
        const r = img.getBoundingClientRect();
        // Skip very small images (icons / avatars)
        if (r.width < 120 || r.height < 120) continue;
        // Skip if inside a user-message bubble (those are uploaded refs, not generated)
        const userBubble = img.closest('user-query, [class*="user-query"], [class*="user-message"], [class*="user-prompt"]');
        if (userBubble) continue;
        // Skip if inside an <input> attachment preview (just-uploaded but not yet sent)
        const attachPreview = img.closest('[class*="attachment-preview"], [class*="upload-preview"]');
        if (attachPreview) continue;
        out.push(src);
      }
      return out;
    });
  }

  _looksLikeGeneratedImage(src) {
    if (!src) return false;
    // Skip tiny avatars / icons / spinners
    if (src.startsWith('data:image/svg')) return false;
    if (src.includes('icon') || src.includes('avatar')) return false;
    // Generated images are usually data:image/(jpeg|png|webp);base64,... or
    // hosted on googleusercontent / lh*.googleusercontent.com.
    return src.startsWith('data:image/') ||
           src.includes('googleusercontent.com') ||
           src.includes('gstatic.com') ||
           src.startsWith('blob:') ||
           src.startsWith('https://');
  }

  async _isImageLoaded(src) {
    return await this.page.evaluate((s) => {
      const img = Array.from(document.querySelectorAll('img')).find(i => i.src === s);
      if (!img) return false;
      return img.complete && img.naturalWidth > 100 && img.naturalHeight > 100;
    }, src);
  }

  async _downloadImageToFile(src, outputPath) {
    // Ensure dir exists
    try { mkdirSync(dirname(outputPath), { recursive: true }); } catch {}

    let buffer;
    if (src.startsWith('data:image/')) {
      // Embedded base64 — no fetch needed
      const base64 = src.split(',')[1];
      buffer = Buffer.from(base64, 'base64');
    } else {
      // For blob: / https: URLs we draw the actual <img> element to a canvas
      // and read back the pixel data. This avoids cross-origin fetch issues
      // and works for blob: URLs that are tied to the page context.
      const dataUrl = await this.page.evaluate((url) => {
        const img = Array.from(document.querySelectorAll('img')).find(i => i.src === url);
        if (!img) throw new Error('source <img> element not found in DOM');
        if (!img.complete || img.naturalWidth === 0) throw new Error('source <img> not loaded');
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        // JPEG at 95% — Gemini outputs are already lossy, this preserves quality
        try {
          return canvas.toDataURL('image/jpeg', 0.95);
        } catch (e) {
          // CORS-tainted canvas — fall back to fetch (will likely also fail
          // but worth trying for non-blob https URLs)
          return null;
        }
      }, src);

      if (dataUrl) {
        const base64 = dataUrl.split(',')[1];
        buffer = Buffer.from(base64, 'base64');
      } else {
        // Last-ditch fetch — only useful for non-tainted https URLs
        const result = await this.page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
          const blob = await r.blob();
          const ab = await blob.arrayBuffer();
          return Array.from(new Uint8Array(ab));
        }, src);
        buffer = Buffer.from(result);
      }
    }
    writeFileSync(outputPath, buffer);
    Logger.debug(`[GeminiImageChat] downloaded ${(buffer.length / 1024).toFixed(0)}KB → ${outputPath}`);

    // Strip Gemini's visible watermark in place. Reverse alpha blending —
    // recovers original pixels rather than cropping or hallucinating. Failures
    // are swallowed by the helper, so this CAN'T break the pipeline; the
    // worst case is the original watermarked file is kept.
    await removeWatermarkInPlace(outputPath);
  }

  // ───────────────────────────────────────────────────────────────────
  // Internals — error / state detection
  // ───────────────────────────────────────────────────────────────────

  async _detectRateLimit() {
    return await this.page.evaluate(() => {
      const txt = document.body.innerText.toLowerCase();
      return txt.includes('limit') && (
        txt.includes('exceeded') ||
        txt.includes('quota') ||
        txt.includes('try again later') ||
        txt.includes('réessayez plus tard') ||
        txt.includes('atteint') ||
        txt.includes('dépassé')
      );
    });
  }

  async _detectRefusal() {
    return await this.page.evaluate(() => {
      const responses = Array.from(document.querySelectorAll('model-response, .response-container, message-content'));
      if (responses.length === 0) return false;
      const last = responses[responses.length - 1];
      // If the response has an <img>, Gemini DID generate — not a refusal.
      if (last.querySelector('img')) return false;
      const txt = (last.innerText || '').toLowerCase();
      // Only the strongest, unambiguous refusal signals — generic words like
      // "policy", "impossible", "cannot" trigger false positives on streaming
      // text Gemini writes before the image renders.
      return /(i can'?t generate|i cannot generate|i can'?t create that image|i'?m unable to (generate|create)|je ne peux pas générer|je suis incapable de générer|i'?m not able to generate|content policy violation|safety policy)/i.test(txt);
    });
  }

  async _isLoginWall() {
    if (!this.page) return false;
    const url = this.page.url();
    if (url.includes('accounts.google.com')) return true;
    return await this.page.evaluate(() => {
      const txt = document.body.innerText.toLowerCase();
      return (txt.includes('sign in') || txt.includes('se connecter')) && txt.includes('google');
    }).catch(() => false);
  }

  async _dismissWelcome() {
    try {
      const newChat = await this.page.$('button:has-text("New chat"), button:has-text("Nouveau chat"), button:has-text("Nouvelle conversation")');
      if (newChat) {
        await newChat.click();
        await this.page.waitForTimeout(1500);
      }
      const skip = await this.page.$('button:has-text("Skip"), button:has-text("Passer"), button:has-text("Got it"), button:has-text("OK")');
      if (skip) {
        await skip.click();
        await this.page.waitForTimeout(800);
      }
    } catch (e) {
      Logger.debug('[GeminiImageChat] welcome dismiss skipped:', e.message);
    }
  }

  async _fileHash(path) {
    const { readFile } = await import('fs/promises');
    const buf = await readFile(path);
    return createHash('md5').update(buf).digest('hex');
  }

  async _screenshot(name) {
    try {
      mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      await this.page.screenshot({
        path: join(SCREENSHOTS_DIR, `gemini-img-${name}-${Date.now()}.png`),
        fullPage: false
      });
    } catch {}
  }
}
