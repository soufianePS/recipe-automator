/**
 * UI TRIGGER REGISTRY — the single source of truth for every web-UI
 * interaction point ("trigger") the automation uses to PUT data into, or
 * CATCH data out of, the AI sites (Gemini, ChatGPT).
 *
 * WHY THIS EXISTS: Google/OpenAI silently change their web UIs, which
 * breaks our hardcoded selectors. When that happens the failures are
 * SLOW/SILENT (10-min hangs, degenerate output) and expensive to debug.
 * This registry powers `scripts/check-triggers.mjs`, which probes every
 * trigger live and reports PASS/FAIL — so you check this FIRST, before
 * debugging anything else.
 *
 * Categories:
 *   nav     — navigation / start-fresh controls (e.g. "new chat")
 *   put     — feed data IN (type prompt, attach files, click send)
 *   catch   — read data OUT (network response capture, DOM extraction)
 *   dismiss — overlays/modals that block the flow
 *
 * Probe fields (any combination; checker tries each):
 *   css            — array of CSS selectors (first that resolves wins)
 *   labelIncludes  — match a <button>/<a> whose aria-label/text contains any
 *   iconNames      — match a button whose child mat-icon data-mat-icon-name is in this list
 *   excludeIcon    — never match a button with this icon (e.g. 'more_vert' menu buttons)
 *   network        — (catch) URL substring that should appear during a live round-trip
 *   dynamic: true  — only appears after a precondition; presence is best-effort, not a hard fail
 *
 * Keep these in sync with the page objects (gemini-chat.js, gemini-image-chat.js,
 * chatgpt.js). Last verified against live UI: 2026-05-25.
 */

import { join } from 'path';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');

/** Surfaces = the three AI web apps we drive, with their URL + profile dir. */
export const SURFACES = {
  'gemini-chat': {
    label: 'Gemini — recipe JSON',
    url: 'https://gemini.google.com/app',
    // profile resolved at runtime from flow-accounts.json active account
    profileKind: 'flow-active',
  },
  'gemini-image': {
    label: 'Gemini — image generation',
    url: 'https://gemini.google.com/app',
    profileKind: 'flow-active',
  },
  'chatgpt': {
    label: 'ChatGPT (alternate JSON + pin images)',
    url: 'https://chatgpt.com/',
    profile: join(PROJECT_ROOT, 'data', 'chatgpt-pin-profile'),
    profileKind: 'fixed',
  },
};

export const TRIGGERS = [
  // ─────────────── GEMINI — recipe JSON (gemini-chat.js) ───────────────
  {
    id: 'gemini-chat.new-chat', surface: 'gemini-chat', category: 'nav', critical: true,
    label: 'New-chat button (start fresh conversation)',
    css: ['a[data-test-id="side-nav-sparkle-button"]', '[data-test-id="side-nav-sparkle-button"]',
          '[data-test-id="new-chat-button"]', '[aria-label="Nouvelle discussion"]'],
    labelIncludes: ['nouvelle discussion', 'new chat', 'nouveau chat', 'nouvelle conversation'],
    notes: 'If broken, runs inherit a polluted conversation → degenerate JSON. Fixed 2026-05-25.',
  },
  {
    id: 'gemini-chat.prompt-input', surface: 'gemini-chat', category: 'put', critical: true,
    label: 'Prompt input (contenteditable)',
    css: ['div.ql-editor[contenteditable="true"]', 'rich-textarea .ql-editor',
          'div[aria-label*="message" i][contenteditable="true"]'],
  },
  {
    id: 'gemini-chat.attach', surface: 'gemini-chat', category: 'put', critical: false, dynamic: true,
    label: 'Attach reference images ("+" / import)',
    labelIncludes: ['importer un fichier', 'importer une image', 'upload', 'add file', 'add image', 'attach'],
    notes: 'Currently flaky (filechooser timeout) — refs get silently dropped. Non-fatal.',
  },
  {
    id: 'gemini-chat.send', surface: 'gemini-chat', category: 'put', critical: true,
    label: 'Send button',
    css: ['button[aria-label="Envoyer un message"]', 'button[aria-label="Send message"]'],
    iconNames: ['send', 'arrow_upward'], excludeIcon: 'more_vert',
    notes: 'Do NOT match aria-label*="send" loosely — sidebar ⋮ menu buttons embed chat text containing "send". Fixed 2026-05-25.',
  },
  {
    id: 'gemini-chat.capture-network', surface: 'gemini-chat', category: 'catch', critical: false,
    label: 'Response capture — network sniffer (StreamGenerate)',
    network: 'StreamGenerate',
    expectedPath: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
    notes: 'If the live URL contains "StreamGenerate" but not expectedPath, the hardcoded path is STALE → 10-min timeout then DOM fallback.',
  },
  {
    id: 'gemini-chat.capture-dom', surface: 'gemini-chat', category: 'catch', critical: true, dynamic: true,
    label: 'Response capture — DOM fallback',
    css: ['.model-response-text', 'model-response .markdown', 'message-content .markdown'],
  },

  // ─────────────── GEMINI — image generation (gemini-image-chat.js) ───────────────
  {
    id: 'gemini-image.prompt-input', surface: 'gemini-image', category: 'put', critical: true,
    label: 'Prompt input',
    css: ['div.ql-editor[contenteditable="true"]', 'rich-textarea .ql-editor'],
  },
  {
    id: 'gemini-image.image-tool', surface: 'gemini-image', category: 'put', critical: true, dynamic: true,
    label: 'Image-generation tool chip',
    labelIncludes: ['créer des images', 'create images', 'image', 'générer une image'],
    notes: 'Must be selected before sending or Gemini answers as text. Selector lives in _selectImageTool.',
  },
  {
    id: 'gemini-image.send', surface: 'gemini-image', category: 'put', critical: true,
    label: 'Send button',
    css: ['button[aria-label="Envoyer un message"]'],
    iconNames: ['send', 'arrow_upward'], excludeIcon: 'more_vert',
    notes: 'SAME bug class as gemini-chat.send (matches sidebar ⋮ via "send" in label). NEEDS the same fix.',
  },
  {
    id: 'gemini-image.capture-network', surface: 'gemini-image', category: 'catch', critical: true,
    label: 'Image bytes capture (googleusercontent /rd-gg-dl/)',
    network: 'rd-gg-dl',
    notes: 'Generated image downloaded from /rd-gg-dl/. Fallback: DOM/canvas extraction.',
  },

  // ─────────────── CHATGPT (chatgpt.js) ───────────────
  {
    id: 'chatgpt.prompt-input', surface: 'chatgpt', category: 'put', critical: true,
    label: 'Prompt input',
    css: ['#prompt-textarea', 'div[contenteditable="true"][data-placeholder]'],
  },
  {
    id: 'chatgpt.send', surface: 'chatgpt', category: 'put', critical: true,
    label: 'Send button',
    css: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]',
          'button[aria-label="Envoyer le prompt"]', 'button[aria-label="Envoyer"]'],
    notes: 'data-testid="send-button" is relatively stable. Only enables after text is registered.',
  },
  {
    id: 'chatgpt.stop-button', surface: 'chatgpt', category: 'catch', critical: false, dynamic: true,
    label: 'Stop/streaming indicator (used to detect "still responding")',
    css: ['button[data-testid="stop-button"]', 'button[aria-label="Stop streaming"]',
          'button[aria-label="Stop generating"]', 'button[aria-label="Arrêter le streaming"]'],
  },
  {
    id: 'chatgpt.response', surface: 'chatgpt', category: 'catch', critical: true, dynamic: true,
    label: 'Response capture (assistant message)',
    css: ['div[data-message-author-role="assistant"]', '.markdown.prose'],
  },
];

/** Convenience: all triggers for one surface. */
export function triggersFor(surface) {
  return TRIGGERS.filter(t => t.surface === surface);
}
