/**
 * ChatGPT page driver for gemini-visual recipe-JSON generation.
 *
 * Differs from src/shared/pages/chatgpt.js (used by VG) in 3 ways:
 *   1. Activates the "Recherche sur le Web" toggle inside the "+" composer menu
 *      so web search is GUARANTEED on (validated empirically — auto-route is
 *      not reliable for every recipe).
 *   2. Attaches multi-image references via #upload-photos (after opening the +
 *      menu — required to wire the input to React state).
 *   3. Lives in src/modules/gemini-visual so the proven VG ChatGPT page is
 *      never affected.
 */

import { Logger } from '../../shared/utils/logger.js';
import { Parser } from '../../shared/utils/parser.js';

const PROMPT_INPUT_SELS = [
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"][data-placeholder]',
  'div[contenteditable="true"][role="textbox"]',
  '#prompt-textarea',
];

async function findPromptInput(page) {
  for (const sel of PROMPT_INPUT_SELS) {
    const el = await page.$(sel);
    if (el && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/**
 * Click the "+" composer menu, then the "Recherche sur le Web" menuitemradio.
 * Returns a short label describing what was clicked, or null if not found.
 */
async function activateWebSearch(page) {
  const plusBtn = await page.$('button[data-testid="composer-plus-btn"]');
  if (!plusBtn) return null;

  await plusBtn.click();
  await page.waitForTimeout(900);

  const result = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
    for (const it of items) {
      const txt = (it.innerText || it.textContent || '').trim().toLowerCase();
      if (
        txt.includes('recherche sur le web') ||
        txt === 'web search' ||
        txt.includes('search the web') ||
        txt === 'recherche web' || txt === 'web'
      ) {
        const wasChecked = it.getAttribute('aria-checked') === 'true';
        it.click();
        return { found: true, label: txt.slice(0, 40), wasChecked };
      }
    }
    return { found: false };
  });

  await page.waitForTimeout(400);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);

  if (result.found) {
    return `menu:"${result.label}"${result.wasChecked ? ' [already on]' : ''}`;
  }
  return null;
}

/**
 * Attach files via #upload-photos (open + menu first to wire the React handler).
 * @param {import('playwright').Page} page
 * @param {string[]} filePaths
 */
async function attachFiles(page, filePaths) {
  const inputSelectors = [
    'input#upload-photos',
    'input#upload-files',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
  ];

  // Open the "+" composer menu so React wires the upload-photos input
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const b of btns) {
      if (b.offsetWidth === 0) continue;
      const id = (b.getAttribute('data-testid') || '').toLowerCase();
      const lbl = (b.getAttribute('aria-label') || '').toLowerCase();
      if (id === 'composer-plus-btn' || lbl.includes('ajouter des fichiers') || lbl.includes('add files')) {
        b.click();
        return true;
      }
    }
    return false;
  });
  await page.waitForTimeout(700);

  let fileInput = null;
  for (const sel of inputSelectors) {
    fileInput = await page.$(sel);
    if (fileInput) break;
  }
  if (!fileInput) throw new Error('no file input found in DOM');
  await fileInput.setInputFiles(filePaths);
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape').catch(() => {});
}

async function countThumbs(page) {
  return await page.evaluate(() => {
    const allImgs = Array.from(document.querySelectorAll('img'));
    const thumbs = allImgs.filter(i =>
      i.offsetWidth >= 40 && i.offsetWidth <= 200 &&
      i.offsetHeight >= 40 && i.offsetHeight <= 200
    ).length;
    const blob = allImgs.filter(i => /^(blob:|data:)/.test(i.src || '')).length;
    return Math.max(thumbs, blob);
  });
}

async function waitForUploadsToFinish(page, expectedCount, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page.waitForTimeout(700);
    const thumbs = await countThumbs(page);
    const sendDisabled = await page.evaluate(() => {
      return !!Array.from(document.querySelectorAll('button')).find(b => {
        const id = b.getAttribute('data-testid') || '';
        return (id.includes('send') || id === 'send-button') && (b.disabled || b.getAttribute('aria-disabled') === 'true');
      });
    });
    if (thumbs >= expectedCount && !sendDisabled) return { ok: true, thumbs };
  }
  const thumbs = await countThumbs(page);
  return { ok: false, thumbs, timedOut: true };
}

async function clickSend(page) {
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
  await page.keyboard.press('Enter');
}

async function waitForResponseComplete(page, timeoutMs = 600000) {
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

async function extractResponse(page) {
  return await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    if (blocks.length === 0) return { text: '', citations: [] };
    const last = blocks[blocks.length - 1];
    // Code blocks first (JSON often wrapped in ```json)
    const codes = last.querySelectorAll('pre code');
    let text = '';
    if (codes.length) {
      let largest = '';
      codes.forEach(c => { if (c.textContent.length > largest.length) largest = c.textContent; });
      text = largest.trim();
    }
    if (!text) {
      const clone = last.cloneNode(true);
      clone.querySelectorAll('button').forEach(b => b.remove());
      text = (clone.innerText || '').trim();
    }
    const citations = Array.from(last.querySelectorAll('a[href*="http"]'))
      .map(a => a.href)
      .filter(h => !h.includes('chatgpt.com') && !h.includes('openai.com'));
    return { text, citations };
  });
}

/**
 * Repair ChatGPT's quirk of inserting literal newlines inside JSON string values
 * (most often in URLs). Walks the text and escapes \n/\r found inside "..." strings.
 */
function repairJSON(txt) {
  let out = '';
  let inStr = false;
  let prevEsc = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (prevEsc) { out += c; prevEsc = false; continue; }
    if (c === '\\') { out += c; prevEsc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr && (c === '\n' || c === '\r')) { out += '\\n'; continue; }
    out += c;
  }
  return out;
}

function tryParseJSON(txt) {
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  try { return JSON.parse(repairJSON(txt)); } catch {}
  // Extract first {...} block (skips markdown preamble)
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    try { return JSON.parse(repairJSON(m[0])); } catch {}
  }
  // ```json ... ``` block
  const m2 = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m2) {
    try { return JSON.parse(m2[1]); } catch {}
    try { return JSON.parse(repairJSON(m2[1])); } catch {}
  }
  // Fallback to shared Parser util
  return Parser.extractJSON(txt);
}

/**
 * Open a fresh ChatGPT chat, activate web search, attach reference images,
 * send the prompt, wait for completion, return parsed JSON.
 *
 * Caller is responsible for providing the BrowserContext (CDP recommended on
 * Windows — see project_cloudflare_cdp memory).
 *
 * @param {import('playwright').BrowserContext} ctx
 * @param {string[]} imageRefs — absolute paths to images to attach
 * @param {string} prompt — the recipe-generation prompt
 * @returns {Promise<{json: object|null, rawText: string, citations: string[], searchToggle: string|null}>}
 */
export async function generateRecipeJSON(ctx, imageRefs, prompt) {
  // Close any existing chatgpt tabs to start fresh
  for (const p of ctx.pages().filter(p => p.url().includes('chatgpt.com'))) {
    await p.close().catch(() => {});
  }

  const page = await ctx.newPage();
  try {
    Logger.step('GV-ChatGPT', 'Opening fresh ChatGPT chat');
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    // Wait up to 5 min for input (may need manual Cloudflare solve)
    const startWait = Date.now();
    let cfWarned = false;
    while (Date.now() - startWait < 300000) {
      if (await findPromptInput(page)) break;
      if (!cfWarned) {
        const cf = await page.evaluate(() => {
          const t = (document.body?.innerText || '').toLowerCase();
          return t.includes('vérifiez que vous êtes humain') || t.includes('verify you are human') || t.includes('cloudflare');
        });
        if (cf) {
          Logger.warn('[GV-ChatGPT] Cloudflare check detected — solve manually in browser window');
          cfWarned = true;
        }
      }
      await page.waitForTimeout(1500);
    }

    // Force a brand-new chat (ChatGPT often resumes the last chat when you re-open
    // the tab — we MUST start fresh to avoid carry-over context).
    const newChatClicked = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="create-new-chat-button"]');
      if (btn) { btn.click(); return true; }
      // Fallback: any link with "Nouveau chat" / "New chat" text
      const links = Array.from(document.querySelectorAll('a, button'));
      for (const el of links) {
        const txt = (el.innerText || '').trim().toLowerCase();
        if (txt === 'nouveau chat' || txt === 'new chat') { el.click(); return true; }
      }
      return false;
    });
    if (newChatClicked) {
      Logger.info('[GV-ChatGPT] forced new chat via sidebar button');
      await page.waitForTimeout(1500);
    } else {
      Logger.warn('[GV-ChatGPT] could not find new-chat button — may carry over previous chat context');
    }

    const input = await findPromptInput(page);
    if (!input) throw new Error('chatgpt input never appeared after 5 min');

    // 1. Activate web search
    const searchToggle = await activateWebSearch(page);
    if (searchToggle) Logger.info(`[GV-ChatGPT] web search activated (${searchToggle})`);
    else Logger.warn('[GV-ChatGPT] web-search toggle not found — relying on prompt auto-route');

    // 2. Attach images
    await input.click();
    await page.waitForTimeout(400);
    if (imageRefs && imageRefs.length > 0) {
      Logger.info(`[GV-ChatGPT] attaching ${imageRefs.length} reference images`);
      await attachFiles(page, imageRefs);
      const upload = await waitForUploadsToFinish(page, imageRefs.length);
      if (!upload.ok) throw new Error(`upload incomplete: ${upload.thumbs}/${imageRefs.length}`);
    }

    // 3. Send prompt
    await input.click();
    await page.waitForTimeout(200);
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(500);
    Logger.info('[GV-ChatGPT] sending prompt + waiting for response');
    await clickSend(page);
    await waitForResponseComplete(page);

    // 4. Extract + parse
    const { text, citations } = await extractResponse(page);
    const json = tryParseJSON(text);
    return { json, rawText: text, citations, searchToggle };
  } finally {
    await page.close().catch(() => {});
  }
}
