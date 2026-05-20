/**
 * Diagnostic: find the current Flow prompt input element.
 *
 * Opens Flow with the soufiane profile (same as the failed VG run), waits
 * for the editor to load, then dumps EVERY interactive element on the page
 * so we can identify the new selector for the prompt input.
 *
 * Usage:
 *   node scripts/diag-flow-prompt-input.mjs
 *   node scripts/diag-flow-prompt-input.mjs --profile "soufiane flow"
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'data', 'tmp', 'flow-diag');

const args = process.argv.slice(2);
const arg = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const PROFILE = arg('profile', 'soufiane flow');

const log = (...a) => console.log('[diag]', ...a);

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const profileDir = join(process.env.LOCALAPPDATA || '', PROFILE);
  log(`Profile: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();

    log('Opening Flow...');
    await page.goto('https://labs.google/fx/fr/tools/flow', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    log('Dismissing any landing page (clicking "Nouveau projet" / "New project")...');
    try {
      const clicked = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, a, [role="button"]');
        for (const b of buttons) {
          const t = (b.textContent || '').toLowerCase().trim();
          if (t.includes('nouveau projet') || t.includes('new project') ||
              t.includes('create with flow') || t.includes('créer avec')) {
            b.click();
            return t;
          }
        }
        return null;
      });
      if (clicked) log(`Clicked: ${clicked}`);
      else log('No "new project" button found, trying to look at the page anyway');
      await page.waitForTimeout(6000);
    } catch (e) { log('Landing click skipped: ' + e.message); }

    // Try to enter the editor — Flow editor URLs contain /project/ or /editor
    await page.waitForTimeout(8000);
    log(`Current URL: ${page.url()}`);

    log('Taking screenshot...');
    const shotPath = join(OUT_DIR, `${ts}-flow-page.png`);
    await page.screenshot({ path: shotPath, fullPage: true });
    log(`Screenshot: ${shotPath}`);

    // ── Dump every interactive text input element ────────────────
    log('Inspecting page DOM for input candidates...');
    const candidates = await page.evaluate(() => {
      const out = [];
      const SELS = [
        'textarea',
        'input[type="text"]',
        'input[type="search"]',
        'div[contenteditable="true"]',
        'div[contenteditable]',
        'div[role="textbox"]',
        '[aria-label*="prompt" i]',
        '[aria-label*="describe" i]',
        '[aria-label*="décri" i]',
        '[placeholder*="prompt" i]',
        '[placeholder*="describe" i]',
        '[placeholder*="décri" i]',
      ];
      const seen = new Set();
      for (const sel of SELS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (seen.has(el)) continue;
          seen.add(el);
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue; // hidden
          // Get all attributes
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value.length > 100 ? a.value.slice(0, 100) + '…' : a.value;
          out.push({
            matchedSel: sel,
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            classes: (el.className && typeof el.className === 'string') ? el.className.slice(0, 200) : null,
            ariaLabel: el.getAttribute('aria-label') || null,
            placeholder: el.getAttribute('placeholder') || null,
            role: el.getAttribute('role') || null,
            contentEditable: el.getAttribute('contenteditable') || null,
            textContent: (el.textContent || '').trim().slice(0, 80),
            innerHTML: (el.innerHTML || '').trim().slice(0, 200),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
            attrs,
          });
        }
      }
      // Sort by size (bigger = more likely the main prompt)
      out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
      return out;
    });

    const dumpPath = join(OUT_DIR, `${ts}-elements.json`);
    writeFileSync(dumpPath, JSON.stringify({ url: page.url(), candidates }, null, 2), 'utf8');
    log(`Element dump: ${dumpPath}`);

    console.log('\n========================================');
    console.log('  CANDIDATE INPUT ELEMENTS (sorted by size)');
    console.log('========================================');
    candidates.slice(0, 12).forEach((c, i) => {
      console.log(`\n[${i}] <${c.tag}${c.role ? ' role=' + c.role : ''}${c.contentEditable ? ' contenteditable=' + c.contentEditable : ''}> ${c.w}×${c.h} at (${c.x}, ${c.y})`);
      console.log(`    Matched selector: ${c.matchedSel}`);
      if (c.id) console.log(`    id: ${c.id}`);
      if (c.ariaLabel) console.log(`    aria-label: "${c.ariaLabel}"`);
      if (c.placeholder) console.log(`    placeholder: "${c.placeholder}"`);
      if (c.classes) console.log(`    class: "${c.classes.slice(0, 80)}"`);
      if (c.textContent) console.log(`    text: "${c.textContent}"`);
      const attrLines = Object.entries(c.attrs).slice(0, 8).map(([k, v]) => `      ${k}="${v}"`);
      console.log('    attrs:');
      console.log(attrLines.join('\n'));
    });
    console.log('\n========================================');
    console.log('Best guess for prompt input: probably the largest <textarea> or contenteditable visible.');
    console.log('========================================\n');

    log('Browser stays open 30s for visual inspection — press Ctrl+C to exit early...');
    await page.waitForTimeout(30000);
  } finally {
    try { await context.close(); } catch {}
  }
}

main().catch(e => { console.error('[diag] FATAL:', e.message); console.error(e.stack); process.exit(1); });
