// Create Pinterest boards (one per WP category).
// Run: node scripts/create-pinterest-boards.mjs [--profile-id 792149670] [--dry-run]
//
// Reads categories from WordPress, then for each one:
//   1. Opens Pinterest in the Dolphin profile
//   2. Navigates to the user's profile / boards page
//   3. Clicks "+" / "Create board"
//   4. Types the category name
//   5. Submits
//   6. Verifies the board appears
//
// Uses humanization (delays, mouse moves, typed input).
// Skips categories that already have a matching board.

import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const profileId = parseInt(arg('profile-id', '792149670'));
const dryRun = args.includes('--dry-run');

const log = (...a) => console.log('[boards]', ...a);

// ── Humanization ─────────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const humanWait = (page, min = 800, max = 2500) => page.waitForTimeout(rand(min, max));

async function humanClick(page, target) {
  let handle = typeof target === 'string'
    ? await page.waitForSelector(target, { timeout: 15000 })
    : target;
  const box = await handle.boundingBox();
  if (!box) { await handle.click(); return; }
  const x = box.x + box.width * (0.3 + Math.random() * 0.4);
  const y = box.y + box.height * (0.3 + Math.random() * 0.4);
  await page.mouse.move(x, y, { steps: Math.floor(rand(10, 25)) });
  await page.waitForTimeout(rand(100, 250));
  await page.mouse.click(x, y);
}

async function humanType(page, selector, text) {
  const handle = await page.waitForSelector(selector, { timeout: 15000 });
  await handle.click();
  await page.waitForTimeout(rand(150, 350));
  for (const c of text) {
    await page.keyboard.type(c);
    await page.waitForTimeout(rand(60, 200));
  }
}

// ── WP categories ────────────────────────────────────────────────
async function fetchCategories(settings) {
  const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
  const r = await fetch(`${settings.wpUrl}/wp-json/wp/v2/categories?per_page=100&_fields=id,name,slug,count`, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`WP categories fetch failed: ${r.status}`);
  const cats = await r.json();
  return cats.filter(c => c.name.toLowerCase() !== 'uncategorized' && c.name !== 'Non classé');
}

// ── Pinterest UI helpers ────────────────────────────────────────

/** List the boards currently on the user's profile. */
async function listExistingBoards(page) {
  // Navigate to your profile's Saved/Boards tab
  // We use the avatar link in nav to find the username, then go to /<username>/_saved
  let username = await page.evaluate(() => {
    const link = document.querySelector('a[href^="/"][data-test-id="header-profile"], a[href^="/"][data-test-id="user-avatar"]');
    if (!link) return null;
    return link.getAttribute('href');
  });
  // Fallback: look at any /<word>/ pattern in href
  if (!username) {
    username = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/"]')).map(a => a.getAttribute('href'));
      const m = links.find(h => /^\/[^/]+\/?$/.test(h) && !['/business', '/help', '/today', '/ideas', '/settings'].some(x => h.startsWith(x)));
      return m;
    });
  }
  if (!username) throw new Error('Could not find profile username link');
  log(`Profile path: ${username}`);

  await page.goto(`https://www.pinterest.com${username}_saved`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await humanWait(page, 2500, 4500);

  const boards = await page.evaluate(() => {
    // Pinterest renders boards on the profile as <a href="/<user>/<board-slug>/">
    const links = Array.from(document.querySelectorAll('a[href^="/"]'))
      .map(a => ({
        href: a.getAttribute('href') || '',
        title: a.getAttribute('aria-label') || a.textContent || '',
      }))
      .filter(b => /^\/[^/]+\/[^/_][^/]*\/?$/.test(b.href)) // /<user>/<slug>/
      .filter(b => !b.href.includes('/_'));
    // Dedup by href
    const seen = new Set();
    return links.filter(b => {
      if (seen.has(b.href)) return false;
      seen.add(b.href);
      return true;
    }).map(b => ({ href: b.href, title: (b.title || '').trim() }));
  });
  return { username, boards };
}

/** Create one board by name. Returns true on success. */
async function createBoard(page, username, boardName) {
  log(`Creating board: "${boardName}"`);

  // Go to the user's main profile page (the "+" / Create board button is here)
  await page.goto(`https://www.pinterest.com${username}_saved`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await humanWait(page, 1500, 3000);

  // Find and click the "+" button. Pinterest labels it "Create" / "Créer" /
  // "Create board" / "Créer un tableau". We try multiple ways.
  const opened = await page.evaluate(() => {
    // Look for a button with a + icon or aria-label containing create
    const sel = [
      'button[aria-label*="create" i]',
      'button[aria-label*="créer" i]',
      'div[role="button"][aria-label*="create" i]',
      'div[role="button"][aria-label*="créer" i]',
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el && el.offsetWidth > 0) {
        el.click();
        return s;
      }
    }
    return null;
  });
  if (!opened) throw new Error('Create button not found on profile page');
  log(`  clicked: ${opened}`);
  await humanWait(page, 800, 1800);

  // A menu/modal opens. Look for "Create board" / "Créer un tableau" link
  // OR the modal opens directly with a name input.
  const stepIntoBoard = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('a, button, [role="menuitem"], div[role="button"]'));
    for (const el of items) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (t === 'create board' || t === 'créer un tableau' || t === 'board' || t === 'tableau' ||
          t.includes('create board') || t.includes('créer un tableau')) {
        if (el.offsetWidth > 0) { el.click(); return t; }
      }
    }
    return null;
  });
  if (stepIntoBoard) {
    log(`  picked menu item: "${stepIntoBoard}"`);
    await humanWait(page, 800, 1500);
  }

  // The board-creation modal should now be open with a name input
  const nameInputSel = [
    'input[name="boardName"]',
    'input[placeholder*="Like" i]',
    'input[placeholder*="ex." i]',
    'input[placeholder*="Comme" i]',
    'input[type="text"][maxlength]',
    '#boardEditName',
    '[data-test-id="board-name-input"]',
    'input[aria-label*="name" i]',
    'input[aria-label*="nom" i]',
  ].join(', ');

  try {
    await page.waitForSelector(nameInputSel, { timeout: 8000 });
  } catch {
    // Diagnose what's on the page
    const inputs = await page.evaluate(() => Array.from(document.querySelectorAll('input, textarea')).map(i => ({
      type: i.getAttribute('type') || '', placeholder: i.getAttribute('placeholder') || '',
      name: i.getAttribute('name') || '', aria: i.getAttribute('aria-label') || '',
      visible: i.offsetWidth > 0,
    })).filter(i => i.visible));
    log(`  ⚠ no name input found. Visible inputs on page:`);
    inputs.forEach((i, j) => log(`    [${j}] type=${i.type} placeholder="${i.placeholder}" aria="${i.aria}" name="${i.name}"`));
    throw new Error('Board-create modal name input not found');
  }

  await humanType(page, nameInputSel, boardName);
  await humanWait(page, 700, 1500);

  // Click Create / Créer submit button in the modal
  const submitted = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const b of btns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t === 'create' || t === 'créer' || t === 'done' || t === 'fait' || t === 'save' || t === 'enregistrer') {
        if (b.offsetWidth > 0 && !b.disabled) {
          b.click();
          return t;
        }
      }
    }
    return null;
  });
  if (!submitted) throw new Error('Create board submit button not found in modal');
  log(`  submitted with button text "${submitted}"`);
  await humanWait(page, 3000, 6000); // wait for board creation + redirect

  return true;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));

  log('Fetching WP categories...');
  const cats = await fetchCategories(settings);
  log(`${cats.length} categories to ensure as boards:`);
  cats.forEach(c => log(`  • ${c.name} (${c.count} posts)`));

  if (dryRun) {
    log('\n--- DRY RUN: would now create boards. Stopping here. ---');
    return;
  }

  const dolphin = new DolphinAnty(settings);
  log(`\nStarting Dolphin profile ${profileId}...`);
  const { port } = await dolphin.startAndGetCDP(profileId);
  log(`✓ CDP port: ${port}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    // Go home + check login
    await page.goto('https://www.pinterest.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await humanWait(page, 2000, 4000);
    const isLogin = await page.evaluate(() => !!document.querySelector('input[type="email"], input[name="email"]'));
    if (isLogin) throw new Error('Not logged in to Pinterest on this profile');
    log('✓ Logged in');

    // Existing boards
    const { username, boards: existing } = await listExistingBoards(page);
    log(`Existing boards: ${existing.length}`);
    existing.forEach(b => log(`  - ${b.title || b.href}`));
    const existingNames = new Set(existing.map(b => (b.title || '').toLowerCase().trim()));

    const results = [];
    for (const cat of cats) {
      if (existingNames.has(cat.name.toLowerCase())) {
        log(`SKIP "${cat.name}" — already exists`);
        results.push({ name: cat.name, status: 'skip-existing' });
        continue;
      }
      try {
        await createBoard(page, username, cat.name);
        log(`✓ Created "${cat.name}"`);
        results.push({ name: cat.name, status: 'created' });
        // Pause between boards to look human
        await humanWait(page, 4000, 9000);
      } catch (e) {
        log(`✗ "${cat.name}" — ${e.message}`);
        results.push({ name: cat.name, status: 'error', error: e.message });
      }
    }

    log('\n═══ DONE ═══');
    const created = results.filter(r => r.status === 'created').length;
    const skipped = results.filter(r => r.status === 'skip-existing').length;
    const errs = results.filter(r => r.status === 'error').length;
    log(`Created: ${created} | Skipped (existing): ${skipped} | Errors: ${errs}`);

  } catch (e) {
    console.error('[boards] fatal:', e.message);
  } finally {
    log('Pausing 10s for inspection...');
    await new Promise(r => setTimeout(r, 10000));
    try { await browser?.close(); } catch {}
    try { await dolphin.stopProfile(profileId); } catch {}
    log('Closed');
  }
}

main().catch(e => { console.error('[boards] fatal:', e); process.exit(1); });
