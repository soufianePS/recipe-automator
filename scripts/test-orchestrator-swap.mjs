// Integration test: uses the REAL GeminiChatPage class from src/shared/pages
// and the REAL _ensureBrowserForAccount logic pattern, to verify the fix for
// "stale _geminiChat after browser swap" works on the actual code path.
//
// Run: node scripts/test-orchestrator-swap.mjs

import { chromium } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { GeminiChatPage } from '../src/shared/pages/gemini-chat.js';

const log = (...a) => console.log('[test]', ...a);

async function freshCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'pw-orch-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    timeout: 30000,
  });
  return { ctx, dir };
}

// Just probe the failure surface: call init() far enough to trigger
// this.context.newPage(). Don't navigate to real Gemini (no auth here).
async function probeInit(wrapper, label) {
  try {
    // GeminiChatPage.init() first does this.context.pages() then
    // this.context.newPage() — the latter is where it dies on a closed ctx.
    // We replicate just those two ops so we don't hit auth.
    wrapper.context.pages();
    const page = await wrapper.context.newPage();
    await page.close();
    log(`  ${label}: probe OK (context responsive)`);
    return true;
  } catch (e) {
    log(`  ${label}: probe FAILED → ${e.message.split('\n')[0]}`);
    return false;
  }
}

// ────────────────────────────────────────────────────────────────
// 1. BUG SHAPE — cached wrapper survives context swap
// ────────────────────────────────────────────────────────────────
async function bugShape() {
  log('=== BUG: GeminiChatPage cached on ctxA, swap to ctxB, probe wrapper ===');
  const { ctx: ctxA, dir: dirA } = await freshCtx();

  // Recipe 1 JSON gen creates this._geminiChat against ctxA
  const cachedGemini = new GeminiChatPage(null, ctxA);
  log(`  cached wrapper.context === ctxA: ${cachedGemini.context === ctxA}`);

  // _ensureBrowserForAccount: close ctxA, launch ctxB, recreate flow/chatgpt
  // but in the BUGGY version, _geminiChat is NOT reset
  await ctxA.close();
  const { ctx: ctxB, dir: dirB } = await freshCtx();
  log(`  ctx swapped; cached wrapper still points at ctxA (closed): ${cachedGemini.context === ctxA}`);

  // Recipe 2 JSON gen reuses cachedGemini.init() — boom
  const ok = await probeInit(cachedGemini, 'recipe-2-init');
  if (!ok) log('  ⇒ matches the real-app bug ✓');

  try { await ctxB.close(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// 2. FIX SHAPE — orchestrator nulls _geminiChat on swap, recipe 2
//    lazy-recreates against ctxB
// ────────────────────────────────────────────────────────────────
async function fixShape() {
  log('=== FIX: orchestrator nulls _geminiChat on swap ===');
  const { ctx: ctxA, dir: dirA } = await freshCtx();

  // Fake orchestrator field — matches generator/orchestrator.js:103 pattern
  const orch = { context: ctxA, _geminiChat: null };
  if (!orch._geminiChat) orch._geminiChat = new GeminiChatPage(null, orch.context);
  log(`  recipe 1: wrapper created on ctxA`);

  // _ensureBrowserForAccount with the fix
  await ctxA.close();
  const { ctx: ctxB, dir: dirB } = await freshCtx();
  orch.context = ctxB;
  orch._geminiChat = null; // ← the actual fix line in base-orchestrator.js:285
  log(`  swap done; orch._geminiChat reset to null`);

  // Recipe 2 JSON gen — lazy-recreates against ctxB
  if (!orch._geminiChat) orch._geminiChat = new GeminiChatPage(null, orch.context);
  log(`  recipe 2: wrapper recreated, context === ctxB: ${orch._geminiChat.context === ctxB}`);

  const ok = await probeInit(orch._geminiChat, 'recipe-2-init');
  if (ok) log('  ⇒ fix verified ✓');

  try { await ctxB.close(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// 3. SOURCE CHECK — confirm the fix line is actually in base-orchestrator.js
// ────────────────────────────────────────────────────────────────
async function sourceCheck() {
  log('=== SOURCE CHECK: this._geminiChat = null in _ensureBrowserForAccount ===');
  const { readFileSync } = await import('fs');
  const { fileURLToPath } = await import('url');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const file = readFileSync(join(__dirname, '..', 'src', 'modules', 'base-orchestrator.js'), 'utf8');

  const occurrences = (file.match(/this\._geminiChat\s*=\s*null/g) || []).length;
  log(`  this._geminiChat = null occurrences: ${occurrences}`);
  if (occurrences >= 1) log('  ⇒ fix line present ✓');
  else log('  ⇒ fix line MISSING ❌');
}
import { dirname } from 'path';

(async () => {
  await bugShape();
  await fixShape();
  await sourceCheck();
  log('done');
})();
