// Isolated repro: does Playwright launchPersistentContext die when you close
// its last page? And does an about:blank keeper save it?
//
// Run: node scripts/test-context-lifecycle.mjs

import { chromium } from 'playwright';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

const log = (...a) => console.log('[test]', ...a);

const LAUNCH_OPTS = {
  headless: true, // headless to avoid window-flash; bug is independent of headfulness
  viewport: null,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
  timeout: 30000,
};

async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pw-test-'));
  const ctx = await chromium.launchPersistentContext(dir, LAUNCH_OPTS);
  return { ctx, dir };
}

async function safeNewPage(ctx, label) {
  try {
    const p = await ctx.newPage();
    log(`  ${label}: newPage() OK (pages now: ${ctx.pages().length})`);
    return p;
  } catch (e) {
    log(`  ${label}: newPage() FAILED → ${e.message.split('\n')[0]}`);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Scenario A — repro: close every page, then try newPage()
// ────────────────────────────────────────────────────────────────
async function scenarioA() {
  log('--- A: open chatgpt+flow, close both, then newPage() ---');
  const { ctx, dir } = await fresh();
  log(`initial pages: ${ctx.pages().length}`);

  const chatgpt = await ctx.newPage();
  await chatgpt.goto('about:blank');
  const flow = await ctx.newPage();
  await flow.goto('about:blank');
  log(`after open: ${ctx.pages().length}`);

  await chatgpt.close();
  await flow.close();
  log(`after close: ${ctx.pages().length}`);

  // Brief wait — Chromium exit on last-page-close may be async
  await new Promise(r => setTimeout(r, 500));

  await safeNewPage(ctx, 'recipe-2');

  try { await ctx.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// Scenario B — keeper-page fix: open keeper BEFORE closing others
// ────────────────────────────────────────────────────────────────
async function scenarioB() {
  log('--- B: open chatgpt+flow, then keeper, close chatgpt+flow, newPage() ---');
  const { ctx, dir } = await fresh();

  const chatgpt = await ctx.newPage();
  await chatgpt.goto('about:blank');
  const flow = await ctx.newPage();
  await flow.goto('about:blank');

  // Keeper goes up BEFORE the two closes
  const keeper = await ctx.newPage();
  log(`with keeper, pages: ${ctx.pages().length}`);

  await chatgpt.close();
  await flow.close();
  log(`after close (keeper still alive): ${ctx.pages().length}`);

  await new Promise(r => setTimeout(r, 500));

  const fresh2 = await safeNewPage(ctx, 'recipe-2');
  if (fresh2) await fresh2.close();
  try { await keeper.close(); } catch {}

  try { await ctx.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// Scenario C — pages().length only check (non-destructive probe)
// ────────────────────────────────────────────────────────────────
async function scenarioC() {
  log('--- C: after close-all, can we still call ctx.pages() without throw? ---');
  const { ctx, dir } = await fresh();

  const p = await ctx.newPage();
  await p.close();
  await new Promise(r => setTimeout(r, 500));

  try {
    const n = ctx.pages().length;
    log(`  pages() returned: ${n}`);
  } catch (e) {
    log(`  pages() THREW: ${e.message.split('\n')[0]}`);
  }

  try { await ctx.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// Scenario D — stale context ref: close ctx fully, then use old ref
// (mirrors stale _geminiChat after _ensureBrowserForAccount)
// ────────────────────────────────────────────────────────────────
async function scenarioD() {
  log('--- D: explicit ctx.close(), then call newPage() on stale ref ---');
  const { ctx, dir } = await fresh();
  await ctx.close();

  // Does pages() throw on a closed context? That's the basis of my probe
  try {
    const n = ctx.pages().length;
    log(`  D.pages() returned: ${n} (no throw — probe is unreliable!)`);
  } catch (e) {
    log(`  D.pages() THREW: ${e.message.split('\n')[0]}`);
  }

  await safeNewPage(ctx, 'stale-ctx');
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ────────────────────────────────────────────────────────────────
// Scenario E — full repro: ctx-swap (like _ensureBrowserForAccount),
// then close pages on new ctx, then newPage() — mirrors recipe 2 flow
// ────────────────────────────────────────────────────────────────
async function scenarioE() {
  log('--- E: ctx-swap then page lifecycle on NEW ctx (real-app flow) ---');
  const { ctx: ctxA, dir: dirA } = await fresh();
  // Recipe 1's JSON page on ctxA
  const cg1 = await ctxA.newPage(); await cg1.goto('about:blank');

  // Simulate _ensureBrowserForAccount: close ctxA, launch ctxB
  await ctxA.close();
  log('  ctxA closed (mid-recipe-1 swap)');
  const { ctx: ctxB, dir: dirB } = await fresh();
  log(`  ctxB launched (pages: ${ctxB.pages().length})`);

  // Recipe 1's flow page on ctxB
  const fp = await ctxB.newPage(); await fp.goto('about:blank');
  log(`  flow page open on ctxB (pages: ${ctxB.pages().length})`);

  // Recipe 1 COMPLETED handler: close pages
  await fp.close();
  log(`  flow page closed (pages: ${ctxB.pages().length})`);

  // Recipe 2's chatgpt.init: newPage on ctxB
  await new Promise(r => setTimeout(r, 500));
  await safeNewPage(ctxB, 'recipe-2-chatgpt');

  try { await ctxB.close(); } catch {}
  try { rmSync(dirA, { recursive: true, force: true }); } catch {}
  try { rmSync(dirB, { recursive: true, force: true }); } catch {}
}

(async () => {
  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  log('done');
})();
