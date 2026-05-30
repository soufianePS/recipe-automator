/**
 * UI TRIGGER HEALTH CHECK
 *
 * Probes every Gemini/ChatGPT UI "trigger" (from ui-triggers.js) live and
 * prints a PASS/FAIL table. Run this FIRST whenever generation misbehaves —
 * it tells you instantly which selector/interaction is broken, instead of
 * debugging symptoms (10-min hangs, degenerate output).
 *
 * Usage:
 *   node scripts/check-triggers.mjs                 # all surfaces
 *   node scripts/check-triggers.mjs --surface=gemini-chat
 *   node scripts/check-triggers.mjs --no-roundtrip  # presence checks only (no live send)
 *
 * Read-only: it sends one throwaway "reply OK" prompt during the round-trip;
 * it never posts/generates real content.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SURFACES, triggersFor } from '../src/shared/pages/ui-triggers.js';
import { GeminiChatPage } from '../src/shared/pages/gemini-chat.js';

const ROOT = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const onlySurface = (args.find(a => a.startsWith('--surface=')) || '').split('=')[1] || null;
const noRoundtrip = args.includes('--no-roundtrip');

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[90m', bold: '\x1b[1m' };
const tag = (s) => s === 'PASS' ? `${C.green}PASS${C.reset}` : s === 'FAIL' ? `${C.red}FAIL${C.reset}` : `${C.yellow}WARN${C.reset}`;

function resolveProfile(surface) {
  const s = SURFACES[surface];
  if (s.profileKind === 'fixed') return s.profile;
  const fa = JSON.parse(readFileSync(join(ROOT, 'data', 'flow-accounts.json'), 'utf8'));
  const acc = fa.accounts.find(a => a.id === fa.activeAccountId && a.enabled) || fa.accounts.find(a => a.enabled);
  if (!acc) throw new Error('No enabled Flow account for profile');
  return join(process.env.LOCALAPPDATA || '', acc.profileDir);
}

/** Probe one trigger's presence on the page. Runs in the browser. */
async function probe(page, t) {
  return await page.evaluate((t) => {
    const iconOf = (el) => {
      const i = el.querySelector && el.querySelector('mat-icon, [data-mat-icon-name]');
      return (i && (i.getAttribute('data-mat-icon-name') || i.textContent || '').trim().toLowerCase()) || '';
    };
    let el = null, how = '';
    for (const sel of (t.css || [])) {
      try { const e = document.querySelector(sel); if (e) { el = e; how = 'css'; break; } } catch {}
    }
    if (!el && t.iconNames) {
      for (const b of document.querySelectorAll('button')) {
        const ic = iconOf(b);
        if (t.iconNames.includes(ic) && ic !== (t.excludeIcon || '__x')) { el = b; how = 'icon:' + ic; break; }
      }
    }
    if (!el && t.labelIncludes) {
      const els = document.querySelectorAll('button, a[role="button"], a[data-test-id], [role="link"], [role="menuitem"]');
      for (const e of els) {
        if (t.excludeIcon && iconOf(e) === t.excludeIcon) continue;
        const lbl = ((e.getAttribute && e.getAttribute('aria-label')) || e.innerText || e.textContent || '').toLowerCase();
        if (t.labelIncludes.some(s => lbl.includes(s))) { el = e; how = 'label'; break; }
      }
    }
    if (!el) return { found: false };
    return {
      found: true, how,
      visible: !!(el.offsetWidth || el.offsetHeight),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
    };
  }, t);
}

function statusFor(t, r) {
  if (!r.found) return (t.critical && !t.dynamic) ? 'FAIL' : 'WARN';
  // nav controls (e.g. new-chat) live in a sidebar that may be collapsed —
  // the code clicks them via JS regardless of visibility, so found = OK.
  if (t.category === 'nav') return 'PASS';
  if (!r.visible) return 'WARN';
  return 'PASS';
}

const results = []; // {surface, id, label, category, critical, status, detail}

async function checkSurface(surface) {
  const cfg = SURFACES[surface];
  console.log(`\n${C.bold}=== ${surface} — ${cfg.label} ===${C.reset}`);
  let ctx, profile;
  try { profile = resolveProfile(surface); } catch (e) { console.log(`  ${tag('FAIL')} profile: ${e.message}`); return; }
  try {
    ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: null });
  } catch (e) {
    console.log(`  ${tag('FAIL')} launch: ${e.message.split('\n')[0]}`);
    return;
  }
  try {
    const page = ctx.pages()[0] || await ctx.newPage();

    // For gemini-chat, exercise the REAL page object (tests new-chat + send fixes)
    let gem = null;
    if (surface === 'gemini-chat') {
      gem = new GeminiChatPage(ctx.browser(), ctx);
      await gem.init();              // navigates + clicks new-chat
    } else {
      await page.goto(cfg.url, { waitUntil: 'domcontentloaded' });
      // Wait for the composer to actually render — ChatGPT can be slow or show
      // a Cloudflare/login gate. Poll the prompt-input selectors up to 25s.
      const pin = triggersFor(surface).find(t => /prompt-input/.test(t.id));
      const deadline = Date.now() + 25000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        for (const sel of (pin?.css || [])) { if (await page.$(sel)) { ready = true; break; } }
        if (!ready) await page.waitForTimeout(1000);
      }
    }
    const livePage = gem ? gem.page : page;

    // Login / gate check — distinguish "not logged in / not loaded" from a real
    // selector break (otherwise a logged-out profile looks like broken triggers).
    const gate = await livePage.evaluate(() => {
      if (/accounts\.google\.com|auth\.openai|\/auth\/login|\/log-in/i.test(location.href)) return 'redirected to login';
      const hasComposer = !!document.querySelector('#prompt-textarea, div.ql-editor[contenteditable="true"], rich-textarea .ql-editor');
      if (hasComposer) return null;
      const loginBtn = Array.from(document.querySelectorAll('button, a'))
        .some(b => /log in|login|sign up|connexion|se connecter/i.test((b.innerText || b.textContent || '')));
      return loginBtn ? 'login wall (logged out?)' : 'composer never rendered (slow load / gate)';
    });
    if (gate) {
      console.log(`  ${tag('FAIL')} NOT READY — ${gate}`);
      results.push({ surface, id: surface + '.login', label: 'Logged in / loaded', status: 'FAIL', detail: gate });
      return;
    }

    // Prime the composer — some send buttons only render once there's text
    // (ChatGPT hides send on an empty input). Type a throwaway char first.
    try {
      const pin = triggersFor(surface).find(t => /prompt-input/.test(t.id));
      for (const sel of (pin?.css || [])) {
        const el = await livePage.$(sel);
        if (el) { await el.click(); await livePage.keyboard.type('check'); await livePage.waitForTimeout(700); break; }
      }
    } catch {}

    // Presence probes
    for (const t of triggersFor(surface)) {
      if (t.network) continue; // network triggers only checkable via round-trip
      if (t.category === 'catch' && t.dynamic) {
        // response/stream containers only exist after a real exchange
        results.push({ surface, ...t, status: 'SKIP', detail: 'round-trip only' });
        console.log(`  ${C.dim}SKIP catch   ${t.label} — round-trip only${C.reset}`);
        continue;
      }
      const r = await probe(livePage, t);
      const st = statusFor(t, r);
      const detail = r.found ? `${r.how}${r.visible ? '' : ' (hidden)'}${r.disabled ? ' (disabled)' : ''}` : 'NOT FOUND';
      results.push({ surface, ...t, status: st, detail });
      console.log(`  ${tag(st)} ${t.category.padEnd(7)} ${t.label} ${C.dim}— ${detail}${C.reset}`);
    }

    // Round-trip: gemini-chat send → capture (the chain that broke tonight)
    if (surface === 'gemini-chat' && !noRoundtrip && gem) {
      const urls = [];
      livePage.on('response', (r) => { const u = r.url(); if (/StreamGenerate|batchexecute/i.test(u)) urls.push(u); });
      try {
        await gem._pastePrompt('Reply with ONLY the word: OK');
        await gem._clickSend();
        let landed = false, responded = false;
        for (let i = 0; i < 15; i++) {
          await livePage.waitForTimeout(2000);
          const s = await livePage.evaluate(() => ({
            user: document.querySelectorAll('user-query, .user-query-bubble-with-background').length,
            resp: document.querySelectorAll('.model-response-text, model-response .markdown, message-content .markdown').length,
          }));
          if (s.user > 0) landed = true;
          if (s.resp > 0) { responded = true; break; }
        }
        const t = triggersFor(surface).find(x => x.id === 'gemini-chat.send');
        const sendStatus = landed ? 'PASS' : 'FAIL';
        results.push({ surface, id: 'gemini-chat.send-roundtrip', label: 'Send → message landed', category: 'put', critical: true, status: sendStatus, detail: landed ? 'message posted' : 'NEVER SENT' });
        console.log(`  ${tag(sendStatus)} put     Send → message landed ${C.dim}— ${landed ? 'message posted' : 'NEVER SENT'}${C.reset}`);

        const respStatus = responded ? 'PASS' : 'WARN';
        results.push({ surface, id: 'gemini-chat.capture-dom-roundtrip', label: 'Response appeared (DOM)', category: 'catch', critical: true, status: respStatus, detail: responded ? 'response rendered' : 'no response in 30s' });
        console.log(`  ${tag(respStatus)} catch   Response appeared (DOM) ${C.dim}— ${responded ? 'response rendered' : 'no response in 30s'}${C.reset}`);

        // Sniffer path staleness
        const expected = triggersFor(surface).find(x => x.id === 'gemini-chat.capture-network')?.expectedPath;
        const exactHit = urls.some(u => expected && u.includes(expected));
        const anyStream = urls.some(u => /StreamGenerate/i.test(u));
        const snifStatus = exactHit ? 'PASS' : (anyStream ? 'FAIL' : 'WARN');
        const snifDetail = exactHit ? 'StreamGenerate path matches' : (anyStream ? 'STALE PATH — StreamGenerate fired at a different URL' : 'no StreamGenerate seen (response not sent?)');
        results.push({ surface, id: 'gemini-chat.capture-network', label: 'Sniffer StreamGenerate path', category: 'catch', critical: false, status: snifStatus, detail: snifDetail });
        console.log(`  ${tag(snifStatus)} catch   Sniffer StreamGenerate path ${C.dim}— ${snifDetail}${C.reset}`);
      } catch (e) {
        console.log(`  ${tag('FAIL')} round-trip error: ${e.message.split('\n')[0]}`);
      }
    }
  } finally {
    try { await ctx.close(); } catch {}
  }
}

// ── Run ──
const surfaces = onlySurface ? [onlySurface] : Object.keys(SURFACES);
console.log(`${C.bold}UI Trigger Health Check${C.reset} ${C.dim}— ${new Date().toLocaleString()}${C.reset}`);
for (const s of surfaces) {
  if (!SURFACES[s]) { console.log(`Unknown surface: ${s}`); continue; }
  await checkSurface(s);
}

// Summary
const fails = results.filter(r => r.status === 'FAIL');
const warns = results.filter(r => r.status === 'WARN');
const skips = results.filter(r => r.status === 'SKIP');
console.log(`\n${C.bold}── SUMMARY ──${C.reset}`);
console.log(`  ${results.filter(r => r.status === 'PASS').length} PASS · ${warns.length} WARN · ${fails.length} FAIL · ${skips.length} SKIP ${C.dim}(round-trip only)${C.reset}`);
if (fails.length) {
  console.log(`\n${C.red}${C.bold}BROKEN (fix these first):${C.reset}`);
  fails.forEach(f => console.log(`  ✗ [${f.surface}] ${f.label}${f.notes ? ' — ' + f.notes : ''}`));
}
process.exit(fails.length ? 1 : 0);
