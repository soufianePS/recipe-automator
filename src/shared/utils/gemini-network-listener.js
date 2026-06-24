/**
 * Gemini network response listener — intercepts the batchexecute API directly
 * instead of scraping the DOM. Replaces the DOM-polling pattern that has been
 * the source of most GV flakiness (false-positive chip detection, missed
 * streaming responses, "0 chars" empty extractions).
 *
 * How Gemini's batchexecute response format works (verified via discovery
 * dump on 2026-05-10):
 *
 *   )]}'                                          ← Google anti-XSSI prefix
 *   177                                           ← chunk byte length
 *   [["wrb.fr",RPC_ID,STRINGIFIED_PAYLOAD]]      ← chunk
 *   1482
 *   [["wrb.fr",null,STRINGIFIED_PAYLOAD]]
 *   ...
 *   59
 *   [["di",N],["af.httprm",N,...]]                ← end-of-stream marker
 *
 * After JSON.parse(STRINGIFIED_PAYLOAD), the model's text response is at:
 *   payload[4][0][1][0]   — the running text, updated each chunk with the full
 *                           answer up to that point (NOT a delta)
 *   payload[1]            — [chatId, responseId] like ["c_abc123", "r_xyz789"]
 *
 * Each call to attach() returns a Listener handle exposing:
 *   - waitForResponse({ timeout }) → final text string
 *   - getLastText()                 → current best text (for polling outside)
 *   - reset()                       → clear state for next turn
 *   - dispose()                     → remove the page listener
 *
 * Usage:
 *   const listener = attachGeminiListener(page);
 *   // ... type prompt + click send ...
 *   const text = await listener.waitForResponse({ timeout: 600000 });
 *   listener.reset(); // before next turn
 */

import { Logger } from './logger.js';

// The actual model response stream lives at StreamGenerate. /batchexecute is
// for smaller side requests (suggestions, telemetry, etc) — discovered the
// hard way (2026-05-10) when our listener-on-batchexecute caught only tiny
// metadata bodies and missed the recipe response entirely.
const STREAM_GENERATE_PATH = '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate';
const BATCHEXECUTE_PATH = '/_/BardChatUi/data/batchexecute';
const RELEVANT_PATHS = [STREAM_GENERATE_PATH, BATCHEXECUTE_PATH];
const ANTI_XSSI = ")]}'";

/**
 * Parse a single batchexecute response body into its chunks. Returns an array
 * of parsed chunks (each is the outer JSON array, NOT yet the inner stringified
 * payload). Tolerates partial/malformed bodies.
 *
 * Format: <LENGTH>\n<JSON> repeating, with anti-XSSI prefix at start.
 * The LENGTH field is unreliable (sometimes UTF-16 chars, sometimes off by a
 * few bytes due to multi-byte UTF-8 chars) — so we IGNORE it and find chunk
 * boundaries by tracking JSON bracket depth instead.
 */
function parseChunks(body) {
  if (!body) return [];
  let s = body.toString('utf8');
  if (s.startsWith(ANTI_XSSI)) s = s.slice(ANTI_XSSI.length);
  s = s.trimStart();

  const chunks = [];
  let pos = 0;

  while (pos < s.length) {
    // Skip the length number + its newline (we don't trust it; bracket
    // tracking is the source of truth)
    const nlIdx = s.indexOf('\n', pos);
    if (nlIdx === -1) break;
    const lenStr = s.slice(pos, nlIdx).trim();
    if (!/^\d+$/.test(lenStr)) {
      // No more length tokens; we're done (or hit malformed tail)
      break;
    }
    const jsonStart = nlIdx + 1;

    // Find JSON end by tracking brackets. Handles nested arrays/objects and
    // escaped quotes inside strings.
    let depth = 0, inStr = false, esc = false, jsonEnd = -1;
    for (let j = jsonStart; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) { jsonEnd = j + 1; break; }
      }
    }
    if (jsonEnd === -1) break; // malformed / truncated

    const chunkText = s.slice(jsonStart, jsonEnd);
    try { chunks.push(JSON.parse(chunkText)); }
    catch (e) { /* skip malformed chunk */ }

    pos = jsonEnd;
    // Skip trailing whitespace before the next length token
    while (pos < s.length && (s[pos] === '\n' || s[pos] === '\r' || s[pos] === ' ')) pos++;
  }

  return chunks;
}

/**
 * Walk the parsed chunks of one response body and pull out the latest model
 * text + any image URLs found. Returns:
 *   { text: string|null, images: string[], chatId: string|null, responseId: string|null }
 */
/**
 * Recursively find the longest string in a parsed payload that looks like the
 * recipe JSON — resilient to Gemini moving the text to a path we don't hardcode
 * (the fixed payload[4]/payload[26] paths go stale when Gemini changes format).
 * Looks for big strings containing recipe-JSON markers.
 */
function deepFindRecipeString(node, best = { t: '' }, depth = 0) {
  if (depth > 40 || node == null) return best.t;
  if (typeof node === 'string') {
    if (node.length > best.t.length && node.length > 200) {
      const trimmed = node.trim();
      if (/"post_title"|"visual_plan"|"pinterest_pins"|"recipe"\s*:/.test(node) ||
          (trimmed.startsWith('{') && node.length > 500)) {
        best.t = node;
      }
    }
    return best.t;
  }
  if (Array.isArray(node)) { for (const v of node) deepFindRecipeString(v, best, depth + 1); return best.t; }
  if (typeof node === 'object') { for (const v of Object.values(node)) deepFindRecipeString(v, best, depth + 1); return best.t; }
  return best.t;
}

function extractFromChunks(chunks) {
  let text = null;
  let chatId = null;
  let responseId = null;
  const images = [];

  for (const chunk of chunks) {
    // Each chunk is [["wrb.fr", rpcId, stringifiedPayload], ...] OR
    // [["di", ...]] / [["af.httprm", ...]] / [["e", ...]]  ← control markers
    if (!Array.isArray(chunk) || chunk.length === 0) continue;
    for (const entry of chunk) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
      const stringified = entry[2];
      if (typeof stringified !== 'string') continue;
      let payload;
      try { payload = JSON.parse(stringified); } catch { continue; }
      if (!Array.isArray(payload)) continue;

      // payload[1] is the [chatId, responseId] pair when present
      if (Array.isArray(payload[1])) {
        chatId = payload[1][0] || chatId;
        responseId = payload[1][1] || responseId;
      }

      // Find the model text. Gemini stores it at one of several paths
      // depending on what tool was triggered:
      //   payload[4][0][1][0]                        — conversational text
      //                                                (also where Python code
      //                                                lives if code execution
      //                                                was triggered)
      //   payload[26][0][0][1][0]['39'][0]           — code-execution stdout
      //                                                (cleaner: raw JSON when
      //                                                the prompt asked for it)
      //   payload[26][0][0][2][1][2]                 — duplicate of above on
      //                                                some response shapes
      // We prefer the code-execution output when available because for
      // recipe-gen prompts Gemini frequently routes through Python and the
      // raw text is wrapped in ```python fences.
      const candidates = [];
      try {
        const c1 = payload?.[26]?.[0]?.[0]?.[1]?.[0]?.['39']?.[0];
        if (typeof c1 === 'string') candidates.push({ src: 'codeExec.out1', t: c1 });
      } catch {}
      try {
        const c2 = payload?.[26]?.[0]?.[0]?.[2]?.[1]?.[2];
        if (typeof c2 === 'string') candidates.push({ src: 'codeExec.out2', t: c2 });
      } catch {}
      try {
        const c3 = payload?.[4]?.[0]?.[1]?.[0];
        if (typeof c3 === 'string') candidates.push({ src: 'convText', t: c3 });
      } catch {}
      // Path-agnostic fallback: deep-scan the whole payload for the recipe JSON
      // (handles Gemini moving the text — the cause of "no text at known paths"
      // + truncated 1999-char captures while the real 16KB JSON sat elsewhere).
      try {
        const deep = deepFindRecipeString(payload);
        if (deep) candidates.push({ src: 'deepScan', t: deep });
      } catch {}

      // Pick the longest candidate that looks like JSON (starts with { or [).
      // Fall back to longest text overall.
      let best = null;
      for (const c of candidates) {
        const trimmed = c.t.trim();
        const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');
        if (looksJson && (!best || c.t.length > best.t.length)) {
          best = c;
        }
      }
      if (!best) {
        for (const c of candidates) {
          if (!best || c.t.length > best.t.length) best = c;
        }
      }
      // Keep the LONGEST text seen across all chunks — Gemini streams cumulative
      // text, so a later chunk can be SHORTER (metadata) and must not clobber the
      // full recipe captured by an earlier/longer chunk.
      if (best && best.t.length > 0 && (text == null || best.t.length > text.length)) text = best.t;

      // Image URLs in image-gen StreamGenerate responses live at:
      //   payload[4][0][12][7][0][0][i][3][3]   for i = 0,1,2... (one per variation)
      // Also fall back to a recursive scan for any googleusercontent URLs we
      // missed (handles UI variations).
      try {
        const variations = payload?.[4]?.[0]?.[12]?.[7]?.[0]?.[0];
        if (Array.isArray(variations)) {
          for (const v of variations) {
            const u = v?.[3]?.[3];
            if (typeof u === 'string' && u.startsWith('https://')) images.push(u);
          }
        }
      } catch {}
      collectImageUrls(payload, images);
    }
  }

  return { text, images, chatId, responseId };
}

/**
 * Recursively scan a parsed payload for anything that looks like an image
 * reference. Best-effort — refined as we observe more image responses.
 */
function collectImageUrls(node, sink, depth = 0) {
  if (depth > 30 || node == null) return;
  if (typeof node === 'string') {
    if (node.startsWith('https://lh3.googleusercontent.com/') ||
        node.startsWith('https://lh3.google.com/') ||
        node.startsWith('data:image/') ||
        /\/lamda\/images\//.test(node)) {
      sink.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectImageUrls(v, sink, depth + 1);
    return;
  }
  if (typeof node === 'object') {
    for (const v of Object.values(node)) collectImageUrls(v, sink, depth + 1);
  }
}

/**
 * Heuristic: does `text` contain a COMPLETE JSON value (balanced braces)?
 * Used to avoid settling on a mid-stream truncated recipe — we keep waiting
 * until the model's running text closes its top-level { } / [ ]. Tolerates a
 * ```json / ```python fence wrapper and leading prose.
 */
function looksCompleteJson(text) {
  if (!text) return false;
  let s = String(text).trim();
  const fence = s.match(/```(?:json|python)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const o = s.indexOf('{'), a = s.indexOf('[');
  let start = (o === -1) ? a : (a === -1 ? o : Math.min(o, a));
  if (start === -1) return false;
  s = s.slice(start);
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return true; }
  }
  return false; // never balanced → still streaming / truncated
}

/**
 * Attach a network listener to a Playwright Page. Returns a handle that
 * accumulates the latest model output across batchexecute responses and
 * exposes a Promise-based API for waiting on the next complete response.
 */
export function attachGeminiListener(page) {
  const state = {
    text: null,
    images: [],          // image URLs found in StreamGenerate payloads
    imageBytes: [],      // raw image responses captured from Google CDN: [{url, buf, ct, ts}]
    chatId: null,
    responseId: null,
    rawChunks: 0,
    lastUpdateMs: 0,
    bodiesSeen: 0,
  };
  const updateWaiters = []; // { resolve, condition }

  const onResponse = async (resp) => {
    try {
      const url = resp.url();
      const ct = resp.headers()['content-type'] || '';

      // ── Image bytes ── intercept the actual JPEG/PNG that Gemini's UI loads
      // from Google CDN. Way cleaner than canvas-to-PNG extraction from <img>.
      if (/image\/(jpeg|png|webp)/i.test(ct) &&
          (url.includes('googleusercontent.com') || url.includes('lh3.google'))) {
        const buf = await resp.body().catch(() => null);
        if (buf && buf.length > 5000) { // skip tiny placeholders/icons
          // Tag generated-image responses vs UI/preview fetches. The actual
          // generated image is downloaded from `/rd-gg-dl/` — UI thumbnails
          // and re-fetches of attached refs use other paths. waitForImage
          // prefers `generated:true` so a re-fetched ref preview can't
          // masquerade as the new image (the bug that triggered the false
          // dedup retry on every step after step 1).
          const generated = url.includes('/rd-gg-dl/');
          state.imageBytes.push({ url, buf, ct, ts: Date.now(), generated });
          state.lastUpdateMs = Date.now();
          Logger.info(`[GeminiNet] ✓ image captured ${(buf.length/1024).toFixed(1)}KB ${ct} ${generated ? '[GEN]' : '[ui]'} (${state.imageBytes.length} total)`);
        }
        return;
      }

      if (!RELEVANT_PATHS.some(p => url.includes(p))) return;
      const isStream = url.includes(STREAM_GENERATE_PATH);
      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length === 0) return;
      state.bodiesSeen++;
      const chunks = parseChunks(buf);
      Logger.info(`[GeminiNet] body #${state.bodiesSeen} ${isStream ? 'STREAM' : 'batch '} ${(buf.length/1024).toFixed(1)}KB → ${chunks.length} chunks`);
      if (chunks.length === 0) return;
      state.rawChunks += chunks.length;
      const extracted = extractFromChunks(chunks);
      if (extracted.text) {
        const wasNew = !state.text || state.text !== extracted.text;
        state.text = extracted.text;
        if (wasNew) {
          Logger.info(`[GeminiNet] body #${state.bodiesSeen} → text len ${extracted.text.length} (preview: ${extracted.text.substring(0,60).replace(/\n/g,'\\n')}…)`);
        }
      } else {
        Logger.info(`[GeminiNet] body #${state.bodiesSeen} parsed OK but no text at known paths`);
      }
      if (extracted.chatId) state.chatId = extracted.chatId;
      if (extracted.responseId) state.responseId = extracted.responseId;
      if (extracted.images.length) {
        for (const u of extracted.images) {
          if (!state.images.includes(u)) state.images.push(u);
        }
      }
      state.lastUpdateMs = Date.now();

      // Resolve any waiters whose condition is now satisfied
      for (let i = updateWaiters.length - 1; i >= 0; i--) {
        const w = updateWaiters[i];
        if (w.condition(state)) {
          updateWaiters.splice(i, 1);
          w.resolve(stateSnapshot(state));
        }
      }
    } catch (e) {
      Logger.info(`[GeminiNet] response handler error: ${e.message.split('\n')[0]}`);
    }
  };

  page.on('response', onResponse);

  return {
    /**
     * Wait until the response stream "settles" — text is non-empty AND no
     * new updates for `quietMs` (default 4s, signalling Gemini stopped streaming).
     * Resolves with a snapshot { text, images, chatId, responseId, ... }.
     * Rejects on timeout.
     */
    async waitForResponse({ timeout = 600000, quietMs = 4000, minTextLen = 1, awaitJsonComplete = false } = {}) {
      const start = Date.now();
      // Wait for first text
      await new Promise((resolve, reject) => {
        const tid = setTimeout(() => {
          const idx = updateWaiters.indexOf(w);
          if (idx >= 0) updateWaiters.splice(idx, 1);
          reject(new Error(`[GeminiNet] no response captured within ${timeout}ms (bodies seen: ${state.bodiesSeen})`));
        }, timeout);
        const w = {
          condition: (s) => s.text && s.text.length >= minTextLen,
          resolve: (snap) => { clearTimeout(tid); resolve(snap); },
        };
        if (w.condition(state)) {
          clearTimeout(tid);
          resolve(stateSnapshot(state));
          return;
        }
        updateWaiters.push(w);
      });
      // Settle: wait for the stream to go quiet AND (when awaitJsonComplete) for
      // the captured text to be a COMPLETE JSON. A mid-stream pause >quietMs used
      // to settle early and return a TRUNCATED recipe — now we keep waiting until
      // the braces balance, or until the stream has been silent for HARD_QUIET
      // (real truncation → accept what we have; parser salvage handles the rest).
      const HARD_QUIET = Math.max(quietMs * 4, 15000);
      let warnedIncomplete = false;
      while (true) {
        const sinceUpdate = Date.now() - state.lastUpdateMs;
        const quiet = sinceUpdate >= quietMs;
        const complete = !awaitJsonComplete || looksCompleteJson(state.text);
        if (quiet && complete) break;
        if (sinceUpdate >= HARD_QUIET) {
          if (awaitJsonComplete && !complete && !warnedIncomplete) {
            Logger.warn(`[GeminiNet] stream silent ${(sinceUpdate / 1000).toFixed(0)}s but JSON still incomplete (len ${state.text?.length || 0}) — accepting + letting parser salvage`);
            warnedIncomplete = true;
          }
          break;
        }
        if (Date.now() - start > timeout) {
          throw new Error(`[GeminiNet] response never settled within ${timeout}ms (last text len: ${state.text?.length || 0})`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return stateSnapshot(state);
    },

    /** Current best snapshot without waiting. */
    getSnapshot() { return stateSnapshot(state); },

    /** Clear state for next turn (call BEFORE typing a new prompt). */
    reset() {
      state.text = null;
      state.images = [];
      state.imageBytes = [];
      state.chatId = null;
      state.responseId = null;
      state.rawChunks = 0;
      state.lastUpdateMs = 0;
      state.bodiesSeen = 0;
    },

    /**
     * Wait for an image to land. Returns the FIRST captured raw image (with
     * url, buf, ct). Resolves as soon as one image arrives that's bigger than
     * `minBytes`. Use after sending an image-gen prompt.
     */
    async waitForImage({ timeout = 600000, minBytes = 30000, quietMs = 2000, preferGenerated = true } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        // Prefer the actually-generated image (URL contains /rd-gg-dl/). If
        // none has shown up yet, keep waiting — UI re-fetches of attached
        // refs would land in state.imageBytes too and we don't want to
        // return one of those by accident (it'd trigger MD5 dedup later).
        const candidates = preferGenerated
          ? state.imageBytes.filter(i => i.generated && i.buf.length >= minBytes)
          : state.imageBytes.filter(i => i.buf.length >= minBytes);
        const big = candidates[0];
        if (big) {
          // Optional quiet wait so we capture all variations Gemini produces
          if (quietMs > 0) {
            const seenAt = Date.now();
            while (Date.now() - state.lastUpdateMs < quietMs && Date.now() - seenAt < quietMs * 3) {
              await new Promise(r => setTimeout(r, 200));
            }
          }
          return big;
        }
        await new Promise(r => setTimeout(r, 500));
      }
      // No /rd-gg-dl/ capture within the window. Returning a non-generated
      // CDN response here would happily accept an attached reference preview
      // as the new image (md5 dedup only catches byte-identical reuse, not a
      // different ref). Throw instead so generate() falls back to DOM/canvas
      // extraction, which is scoped to the latest model response.
      throw new Error(`[GeminiNet] no /rd-gg-dl/ image captured within ${timeout}ms (bodies seen: ${state.bodiesSeen}, image refs: ${state.images.length}, raw images: ${state.imageBytes.length})`);
    },

    /** Remove the page listener. Call when chat is closed. */
    dispose() {
      try { page.off('response', onResponse); } catch {}
    },
  };
}

function stateSnapshot(s) {
  return {
    text: s.text,
    images: [...s.images],
    imageBytes: s.imageBytes.map(i => ({ url: i.url, size: i.buf.length, ct: i.ct })),
    chatId: s.chatId,
    responseId: s.responseId,
    rawChunks: s.rawChunks,
    bodiesSeen: s.bodiesSeen,
  };
}
