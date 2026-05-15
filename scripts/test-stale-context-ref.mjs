// Repro: page-wrapper object cached BEFORE a context swap holds a stale
// ref to the (now closed) context. Calling .init() on it later fails with
// "Target page, context or browser has been closed" — exactly the error
// the real recipe-automator hits at the recipe 1→2 transition.
//
// Run: node scripts/test-stale-context-ref.mjs

import { chromium } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const log = (...a) => console.log('[test]', ...a);

// Minimal stand-in for ChatGPTPage / GeminiChatPage — holds a context ref
// in its constructor and uses it in init().
class FakePageWrapper {
  constructor(context) { this.context = context; this.page = null; }
  async init() {
    this.page = await this.context.newPage();
    await this.page.goto('about:blank');
    return this;
  }
}

async function freshCtx() {
  const dir = mkdtempSync(join(tmpdir(), 'pw-stale-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    timeout: 30000,
  });
  return { ctx, dir };
}

// ────────────────────────────────────────────────────────────────
// Bug repro — same shape as recipe-automator's flow
// ────────────────────────────────────────────────────────────────
async function reproBug() {
  log('=== REPRO: cached wrapper outlives a context swap ===');
  const { ctx: ctxA, dir: dirA } = await freshCtx();
  log('ctxA launched (recipe 1 starts)');

  // Recipe 1 JSON gen — creates the wrapper bound to ctxA
  const cachedWrapper = new FakePageWrapper(ctxA);
  await cachedWrapper.init();
  log('cachedWrapper created on ctxA, init OK');
  await cachedWrapper.page.close();

  // _ensureBrowserForAccount fires mid-recipe-1 — swap to ctxB
  await ctxA.close();
  const { ctx: ctxB, dir: dirB } = await freshCtx();
  log('ctxA closed, ctxB launched (Flow-account swap)');

  // Recipe 1's flow finishes on ctxB, then COMPLETED → recipe 2 starts
  // Recipe 2 JSON gen reuses the cached wrapper (still pointing at ctxA!)
  try {
    await cachedWrapper.init();
    log('  ❌ unexpected: wrapper.init() succeeded on stale ctx');
  } catch (e) {
    log(`  ✓ bug reproduced: ${e.message.split('\n')[0]}`);
  }

  try { await ctxB.close(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// Fix verification — null the cached wrapper at swap time
// ────────────────────────────────────────────────────────────────
async function verifyFix() {
  log('=== FIX: null the cached wrapper on context swap ===');
  const { ctx: ctxA, dir: dirA } = await freshCtx();

  let cachedWrapper = new FakePageWrapper(ctxA);
  await cachedWrapper.init();
  await cachedWrapper.page.close();

  // _ensureBrowserForAccount: close ctxA, launch ctxB, AND null the wrapper
  await ctxA.close();
  const { ctx: ctxB, dir: dirB } = await freshCtx();
  cachedWrapper = null; // ← the fix
  log('ctx swapped, wrapper nulled');

  // Recipe 2 JSON gen — lazy-recreates the wrapper against ctxB
  if (!cachedWrapper) cachedWrapper = new FakePageWrapper(ctxB);
  try {
    await cachedWrapper.init();
    log('  ✓ fixed: wrapper recreated on ctxB, init OK');
    await cachedWrapper.page.close();
  } catch (e) {
    log(`  ❌ still broken: ${e.message.split('\n')[0]}`);
  }

  try { await ctxB.close(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
}

(async () => {
  await reproBug();
  await verifyFix();
  log('done');
})();
