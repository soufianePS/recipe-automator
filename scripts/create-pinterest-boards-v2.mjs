// v2: simpler, more reliable board creation with screenshots at each step.
// Approach: go to /_boards/ tab → click the visible "Créer un tableau" /
// "Create a board" CTA → fill name → submit → verify the board now exists
// in the page DOM before moving on.
//
// Run: node scripts/create-pinterest-boards-v2.mjs [--profile-id 792149670]

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
const ssDir = join(ROOT, 'screenshots');
mkdirSync(ssDir, { recursive: true });

const log = (...a) => console.log('[boards-v2]', ...a);
const ssCounter = { n: 0 };
const screenshot = async (page, label) => {
  const path = join(ssDir, `boards-v2-${String(++ssCounter.n).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path }); return path;
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

/** Read current boards on /_boards/ via page DOM. */
async function getExistingBoards(page, username) {
  await page.goto(`https://www.pinterest.com${username}_boards/`, { waitUntil: 'domcontentloaded' });
  await wait(page, 3000, 5000);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 800); await wait(page, 500, 900); }
  return await page.evaluate((uname) => {
    const prefix = uname.replace(/\/+$/, '');
    const links = Array.from(document.querySelectorAll('a[href^="' + prefix + '/"]'));
    const boards = [];
    const seen = new Set();
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      // /user/boardslug/ — exclude /_pins/, /_boards/, /_collages/, etc.
      const m = href.match(/^\/[^/]+\/([^_][^/]*)\/?$/);
      if (!m) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const title = (a.getAttribute('aria-label') || a.textContent || '').trim().slice(0, 100);
      boards.push({ href, title, slug: m[1] });
    }
    return boards;
  }, username);
}

/** Click the visible "Créer un tableau" / "Create a board" CTA, or fallback to top-right Créer. */
async function openCreateBoardModal(page) {
  // Look for any visible button/link containing the localized phrase
  const opened = await page.evaluate(() => {
    const targets = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
    const phrases = ['créer un tableau', 'create a board', 'create board', 'créer'];
    for (const phrase of phrases) {
      for (const el of targets) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (t === phrase) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            el.click();
            return { phrase, isExact: true };
          }
        }
      }
    }
    return null;
  });
  if (!opened) throw new Error('No "Créer un tableau" / "Create board" button visible on the page');
  return opened;
}

/** After click, if a menu appeared (not the modal), pick the board option. */
async function maybePickFromMenu(page) {
  // Wait for either the modal name input OR a menu to appear
  await wait(page, 600, 1200);
  // If we see a "Tableau" menu item AND no name input yet, click it
  const picked = await page.evaluate(() => {
    const hasNameInput = !!document.querySelector('input[name="boardName"], #boardEditName, input[placeholder*="Like" i], input[placeholder*="ex." i], input[placeholder*="Comme" i]');
    if (hasNameInput) return { skipped: true };
    const items = Array.from(document.querySelectorAll('[role="menuitem"], a, button, div[role="button"]'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'tableau' || t === 'board' || t === 'créer un tableau' || t === 'create board' || t === 'create a board') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { el.click(); return { clicked: t }; }
      }
    }
    return null;
  });
  if (picked?.clicked) {
    log(`  menu picked: "${picked.clicked}"`);
    await wait(page, 800, 1500);
  }
  return picked;
}

/** Type name in the modal input. */
async function fillBoardName(page, name) {
  const selectors = [
    'input[name="boardName"]',
    '#boardEditName',
    '[data-test-id="board-name-input"]',
    'input[placeholder*="Like" i]',
    'input[placeholder*="ex." i]',
    'input[placeholder*="Comme" i]',
    'input[aria-label*="name" i]',
    'input[aria-label*="nom" i]',
    'input[type="text"]:not([readonly])',
  ];
  let handle = null;
  for (const sel of selectors) {
    handle = await page.$(sel);
    if (handle && await handle.isVisible()) { log(`  name input matched by: ${sel}`); break; }
    handle = null;
  }
  if (!handle) throw new Error('Board name input not found in modal');

  await handle.click();
  await wait(page, 200, 400);
  // Clear if anything is pre-filled
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await wait(page, 100, 250);
  for (const ch of name) {
    await page.keyboard.type(ch);
    await wait(page, 60, 180);
  }
  await wait(page, 600, 1200);
}

/** Click submit. */
async function submitBoardForm(page) {
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    // Take the LAST one whose text exactly matches a submission word.
    // Pinterest's modal typically has the submit button at the bottom of the modal.
    const candidates = [];
    for (const b of btns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (b.disabled || b.offsetWidth === 0) continue;
      if (t === 'créer' || t === 'create' || t === 'done' || t === 'fait' || t === 'enregistrer' || t === 'save') {
        candidates.push({ el: b, text: t });
      }
    }
    if (!candidates.length) return null;
    const last = candidates[candidates.length - 1];
    last.el.click();
    return last.text;
  });
  if (!clicked) throw new Error('Submit button not found in modal');
  return clicked;
}

async function createBoard(page, name) {
  log(`Creating "${name}"`);
  // We assume the page is currently on /_boards/
  await screenshot(page, `${name.replace(/\W/g, '_')}-01-tab`);
  const opened = await openCreateBoardModal(page);
  log(`  opened with: "${opened.phrase}"`);
  await screenshot(page, `${name.replace(/\W/g, '_')}-02-clicked`);
  await maybePickFromMenu(page);
  await screenshot(page, `${name.replace(/\W/g, '_')}-03-modal`);
  await fillBoardName(page, name);
  await screenshot(page, `${name.replace(/\W/g, '_')}-04-filled`);
  const submitted = await submitBoardForm(page);
  log(`  submitted via "${submitted}"`);
  await wait(page, 4000, 8000); // wait for redirect/creation
  await screenshot(page, `${name.replace(/\W/g, '_')}-05-after-submit`);
}

async function main() {
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));

  log('Fetching WP categories...');
  const cats = await fetchCategories(settings);
  log(`${cats.length} categories: ${cats.map(c => c.name).join(', ')}`);

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

    const results = [];
    for (let idx = 0; idx < cats.length; idx++) {
      const cat = cats[idx];
      try {
        // Refresh state: list current boards
        const existing = await getExistingBoards(page, username);
        if (existing.some(b => (b.title || '').toLowerCase().includes(cat.name.toLowerCase()) || (b.slug || '').toLowerCase() === cat.name.toLowerCase().replace(/\s+/g, '-'))) {
          log(`SKIP "${cat.name}" — exists`);
          results.push({ name: cat.name, status: 'skip' });
          continue;
        }
        await createBoard(page, cat.name);
        // Verify by checking boards count again
        await wait(page, 1500, 3000);
        const after = await getExistingBoards(page, username);
        if (after.length > existing.length) {
          log(`✓ "${cat.name}" — board count ${existing.length} → ${after.length}`);
          results.push({ name: cat.name, status: 'created' });
        } else {
          log(`✗ "${cat.name}" — count unchanged (${existing.length}). Probably submit didn't go through.`);
          results.push({ name: cat.name, status: 'failed-verify' });
        }
      } catch (e) {
        log(`✗ "${cat.name}" — ${e.message}`);
        results.push({ name: cat.name, status: 'error', error: e.message });
      }
      // pause between iterations
      await wait(page, 4000, 8000);
    }

    log('\n═══ FINAL REPORT ═══');
    for (const r of results) log(`  [${r.status}] ${r.name}${r.error ? ' — ' + r.error : ''}`);
    const created = results.filter(r => r.status === 'created').length;
    log(`Created: ${created}/${cats.length}`);

  } catch (e) {
    console.error('[boards-v2] fatal:', e.message);
  } finally {
    log('Closing in 5s...');
    await new Promise(r => setTimeout(r, 5000));
    try { await browser?.close(); } catch {}
    try { await dolphin.stopProfile(profileId); } catch {}
  }
}

main().catch(e => { console.error('[boards-v2] fatal:', e); process.exit(1); });
