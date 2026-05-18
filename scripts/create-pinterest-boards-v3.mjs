// v3: use the profile homepage flow (the one the user confirmed works manually):
//   1. https://www.pinterest.com/<user>/ (profile homepage, NOT /_boards/)
//   2. Click "Créer" button (top-right "+" / Create CTA on profile)
//   3. Menu appears → click "Tableau"
//   4. Popup → fill name → click "Créer"
//   5. Verify by listing boards on /_boards/ before/after
//
// Run: node scripts/create-pinterest-boards-v3.mjs [--profile-id 792149670] [--only "American,Dinner"]

import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const profileId = parseInt(arg('profile-id', '792149670'));
const onlyArg = arg('only', '');
const only = onlyArg ? onlyArg.split(',').map(s => s.trim().toLowerCase()) : null;

const ssDir = join(ROOT, 'screenshots');
mkdirSync(ssDir, { recursive: true });

const log = (...a) => console.log('[boards-v3]', ...a);
const ssCounter = { n: 0 };
const screenshot = async (page, label) => {
  const path = join(ssDir, `boards-v3-${String(++ssCounter.n).padStart(2, '0')}-${label}.png`);
  try { await page.screenshot({ path, timeout: 5000 }); return path; } catch { return null; }
};

const rand = (a, b) => a + Math.random() * (b - a);
const wait = (page, min, max) => page.waitForTimeout(rand(min, max));

async function fetchCategories(settings) {
  const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
  const r = await fetch(`${settings.wpUrl}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug,count`, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`WP categories fetch failed: ${r.status}`);
  const cats = await r.json();
  return cats.filter(c => c.name.toLowerCase() !== 'uncategorized' && c.name !== 'Non classé');
}

/** Read current boards on /_boards/. Returns array of { href, title, slug }. */
async function getExistingBoards(page, username) {
  await page.goto(`https://www.pinterest.com${username}_boards/`, { waitUntil: 'domcontentloaded' });
  await wait(page, 3000, 5000);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 800); await wait(page, 400, 800); }
  return await page.evaluate((uname) => {
    const prefix = uname.replace(/\/+$/, '');
    const seen = new Set();
    const boards = [];
    for (const a of document.querySelectorAll('a[href^="' + prefix + '/"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/[^/]+\/([^_][^/]*)\/?$/);
      if (!m || seen.has(href)) continue;
      seen.add(href);
      const title = (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 100);
      boards.push({ href, title, slug: m[1] });
    }
    return boards;
  }, username);
}

/** Step 1: open the create flow. Returns { mode: 'direct' | 'menu' }.
 *  - 'direct' = clicked "Créer un tableau" (empty state CTA) → popup opens directly
 *  - 'menu'   = clicked the red "Créer" header button → dropdown menu opens, step 2 needed
 */
async function clickCreerButton(page) {
  // Try the empty-state direct CTA first ("Créer un tableau" / "Create a board")
  const direct = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, div[role="button"], a'));
    for (const el of els) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'créer un tableau' || t === 'create a board' || t === 'create board') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 400) {
          el.click();
          return { text: el.textContent?.trim(), x: Math.round(r.x), y: Math.round(r.y) };
        }
      }
    }
    return null;
  });
  if (direct) return { mode: 'direct', ...direct };

  // Otherwise click the red top-right "Créer" / "Create" button (no y filter — it's at ~y=263 on profile)
  const menu = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('button, div[role="button"], a'));
    // Among candidates, prefer the one with smallest width (Pinterest's red CTA is compact)
    const matches = [];
    for (const el of els) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'créer' || t === 'create') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 200) {
          matches.push({ el, r });
        }
      }
    }
    if (!matches.length) return null;
    // Prefer the topmost button. Once you have ≥6 boards, Pinterest also adds
    // a "Créer" card in the grid (placeholder) that does NOT open the menu —
    // only the red header CTA does. The header is always the highest on the page.
    matches.sort((a, b) => a.r.y - b.r.y);
    const pick = matches[0];
    pick.el.click();
    return { text: pick.el.textContent?.trim(), x: Math.round(pick.r.x), y: Math.round(pick.r.y) };
  });
  if (menu) return { mode: 'menu', ...menu };

  throw new Error('Neither "Créer un tableau" CTA nor "Créer" header button found');
}

/** Step 2 (menu mode only): in the dropdown, click "Tableau". */
async function clickTableauMenuItem(page) {
  await wait(page, 600, 1200);
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], a, button, div[role="button"], div'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'tableau' || t === 'board') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.width < 400) {
          el.click();
          return { text: el.textContent?.trim() };
        }
      }
    }
    return null;
  });
  if (!clicked) throw new Error('"Tableau"/"Board" menu item not found after clicking Créer');
  return clicked;
}

/** Step 3: in the popup, type the board name. */
async function fillBoardName(page, name) {
  await wait(page, 800, 1500);
  const selectors = [
    'input[name="boardName"]',
    '#boardEditName',
    '[data-test-id="board-name-input"]',
    'input[placeholder*="like" i]',
    'input[placeholder*="comme" i]',
    'input[placeholder*="ex." i]',
    'input[placeholder*="Place" i]',  // "Places to Go"
    'input[aria-label*="name" i]',
    'input[aria-label*="nom" i]',
  ];
  let handle = null;
  let usedSel = null;
  for (const sel of selectors) {
    handle = await page.$(sel);
    if (handle && await handle.isVisible().catch(() => false)) { usedSel = sel; break; }
    handle = null;
  }
  // Fallback: any visible text input inside a dialog
  if (!handle) {
    const dialogInput = await page.evaluateHandle(() => {
      const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
      if (!dialog) return null;
      const inputs = dialog.querySelectorAll('input[type="text"], input:not([type])');
      for (const i of inputs) {
        const r = i.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && !i.readOnly) return i;
      }
      return null;
    });
    if (dialogInput && await dialogInput.asElement()) {
      handle = dialogInput.asElement();
      usedSel = 'dialog text input fallback';
    }
  }
  if (!handle) throw new Error('Board name input not found in popup');
  log(`  name input via: ${usedSel}`);
  await handle.click({ delay: 50 });
  await wait(page, 200, 400);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await wait(page, 100, 250);
  for (const ch of name) {
    await page.keyboard.type(ch);
    await wait(page, 70, 180);
  }
  await wait(page, 600, 1200);
}

/** Step 4: click the popup's "Créer" submit button. */
async function clickPopupCreer(page) {
  const clicked = await page.evaluate(() => {
    // Must be inside the dialog, must be enabled, must say Créer / Create
    const dialog = document.querySelector('[role="dialog"], [aria-modal="true"]');
    const root = dialog || document;
    const btns = Array.from(root.querySelectorAll('button'));
    for (const b of btns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (b.disabled) continue;
      const r = b.getBoundingClientRect();
      if (r.width === 0) continue;
      if (t === 'créer' || t === 'create' || t === 'done' || t === 'fait') {
        b.click();
        return { text: b.textContent?.trim(), inDialog: !!dialog };
      }
    }
    return null;
  });
  if (!clicked) throw new Error('Popup "Créer"/"Create" submit not found');
  return clicked;
}

async function createOneBoard(page, name, username) {
  log(`\n── Creating "${name}" ──`);
  await page.goto(`https://www.pinterest.com${username}`, { waitUntil: 'domcontentloaded' });
  await wait(page, 3000, 5000);
  await screenshot(page, `${name.replace(/\W/g, '_')}-01-profile`);

  const creer = await clickCreerButton(page);
  log(`  step 1 ✓ clicked "${creer.text}" (mode=${creer.mode}, y=${creer.y})`);
  await screenshot(page, `${name.replace(/\W/g, '_')}-02-creer-clicked`);

  if (creer.mode === 'menu') {
    const tableau = await clickTableauMenuItem(page);
    log(`  step 2 ✓ clicked menu "${tableau.text}"`);
  } else {
    log(`  step 2 — skipped (direct mode, popup should open)`);
  }
  await wait(page, 1000, 1800);
  await screenshot(page, `${name.replace(/\W/g, '_')}-03-popup`);

  await fillBoardName(page, name);
  log(`  step 3 ✓ filled name "${name}"`);
  await screenshot(page, `${name.replace(/\W/g, '_')}-04-name-filled`);

  const submit = await clickPopupCreer(page);
  log(`  step 4 ✓ clicked popup "${submit.text}" (inDialog=${submit.inDialog})`);
  await wait(page, 5000, 8000);
  await screenshot(page, `${name.replace(/\W/g, '_')}-05-after-submit`);
}

async function main() {
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));

  log('Fetching WP categories...');
  const allCats = await fetchCategories(settings);
  let cats = allCats;
  if (only) {
    cats = allCats.filter(c => only.includes(c.name.toLowerCase()));
    log(`Filtered with --only: ${cats.map(c => c.name).join(', ')}`);
  }
  log(`${cats.length} categories to create: ${cats.map(c => c.name).join(', ')}`);

  const dolphin = new DolphinAnty(settings);
  log(`Starting Dolphin profile ${profileId}...`);
  const { port } = await dolphin.startAndGetCDP(profileId);
  log(`✓ CDP port: ${port}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    // Find username
    await page.goto('https://www.pinterest.com', { waitUntil: 'domcontentloaded' });
    await wait(page, 3000, 5000);
    const username = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('a[href^="/"]'));
      for (const a of all) {
        const h = a.getAttribute('href') || '';
        if (/^\/[^/]+\/?$/.test(h) && !['/business/', '/help/', '/today/', '/ideas/', '/settings/'].some(x => h.startsWith(x))) {
          return h.replace(/\/+$/, '/');
        }
      }
      return null;
    });
    if (!username) throw new Error('Could not find username');
    log(`Username path: ${username}`);

    // Snapshot boards once at the start
    let baseline = await getExistingBoards(page, username);
    log(`Existing boards (${baseline.length}): ${baseline.map(b => b.slug).join(', ') || '(none)'}`);

    const results = [];
    for (const cat of cats) {
      const existsAlready = baseline.some(b =>
        (b.title || '').toLowerCase().includes(cat.name.toLowerCase()) ||
        (b.slug || '').toLowerCase() === cat.name.toLowerCase().replace(/\s+/g, '-')
      );
      if (existsAlready) {
        log(`SKIP "${cat.name}" — already exists`);
        results.push({ name: cat.name, status: 'skip' });
        continue;
      }
      const before = baseline.length;
      try {
        await createOneBoard(page, cat.name, username);
        // Re-fetch boards to verify
        baseline = await getExistingBoards(page, username);
        if (baseline.length > before) {
          log(`✓ "${cat.name}" — boards ${before} → ${baseline.length}`);
          results.push({ name: cat.name, status: 'created' });
        } else {
          log(`✗ "${cat.name}" — count unchanged (${before}). Likely submit didn't go through.`);
          results.push({ name: cat.name, status: 'failed-verify' });
        }
      } catch (e) {
        log(`✗ "${cat.name}" — ${e.message}`);
        results.push({ name: cat.name, status: 'error', error: e.message });
      }
      await wait(page, 3000, 6000);
    }

    log('\n═══ FINAL REPORT ═══');
    for (const r of results) log(`  [${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`);
    const created = results.filter(r => r.status === 'created').length;
    log(`Created: ${created}/${cats.length}`);
  } catch (e) {
    console.error('[boards-v3] fatal:', e.message);
  } finally {
    log('Closing in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    try { await browser?.close(); } catch {}
    try { await dolphin.stopProfile(profileId); } catch {}
  }
}

main().catch(e => { console.error('[boards-v3] fatal:', e); process.exit(1); });
