/**
 * One-time WP admin setup — toggles settings that app passwords can't reach.
 *
 * Run once:  node src/scripts/wp-admin-setup.js
 *
 * Opens a browser, waits for you to log in, then clicks through 4 toggles:
 *   1. Yoast SEO → Breadcrumbs → ON
 *   2. WPRM → Jump to Recipe button → ON
 *   3. Kadence Customizer → Single Post → Author Box → ON
 *   4. Plugins → install + activate "Grow Social" (if missing)
 *
 * Idempotent: safe to re-run. Each toggle checks current state before changing.
 * No HTML/JS is injected — only native admin controls are clicked.
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { readFileSync } from 'fs';

const settings = JSON.parse(readFileSync('./data/sites/leagueofcooking/settings.json', 'utf8'));
const WP_URL = settings.wpUrl;
const PROFILE = join(process.env.LOCALAPPDATA || '', 'recipe-automator-wp-admin-profile');

const log = (msg) => console.log(`[WP-Setup] ${msg}`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureLoggedIn(page) {
  await page.goto(`${WP_URL}/wp-admin/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(1500);
  if (!page.url().includes('wp-login')) { log('Logged in.'); return; }

  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log('Please log in to WordPress admin in the opened browser.');
  log('Script will auto-detect when login completes (polling every 3s, timeout 5 min).');
  log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await wait(3000);
    const url = page.url();
    if (!url.includes('wp-login') && url.includes('/wp-admin')) {
      log('Login detected.');
      return;
    }
  }
  throw new Error('Timed out waiting for login (5 min).');
}

// ── 1. Yoast Breadcrumbs ──
async function toggleYoastBreadcrumbs(page) {
  log('[1/4] Yoast Breadcrumbs...');
  await page.goto(`${WP_URL}/wp-admin/admin.php?page=wpseo_page_settings`, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  const breadcrumbLink = page.locator('a:has-text("Breadcrumbs")').first();
  if (!(await breadcrumbLink.count())) { log('  ✗ Breadcrumbs tab not found (Yoast not installed?)'); return; }
  await breadcrumbLink.click();
  await wait(1500);
  const toggle = page.locator('[id*="breadcrumbs-enable"], input[name*="breadcrumbs-enable"]').first();
  if (!(await toggle.count())) { log('  ✗ Breadcrumbs toggle not found'); return; }
  const isOn = await toggle.isChecked().catch(() => false);
  if (isOn) { log('  ✓ Already enabled'); return; }
  await toggle.click({ force: true });
  await wait(500);
  const saveBtn = page.locator('button:has-text("Save changes"), #save').first();
  if (await saveBtn.count()) { await saveBtn.click(); await wait(2000); }
  log('  ✓ Enabled');
}

// ── 2. WPRM Jump to Recipe ──
async function toggleWPRMJumpToRecipe(page) {
  log('[2/4] WPRM Jump to Recipe button...');
  await page.goto(`${WP_URL}/wp-admin/admin.php?page=wprm_settings&sub=recipe_jump_to_recipe`, { waitUntil: 'domcontentloaded' });
  await wait(2000);
  // WPRM uses a custom toggle pattern — look for "Jump to Recipe" enable toggle
  const jumpHeading = page.locator('text=/Jump to Recipe/i').first();
  if (!(await jumpHeading.count())) { log('  ✗ WPRM Jump to Recipe settings not found'); return; }
  // Find the first enable toggle — WPRM uses checkbox or button toggle
  const enableToggle = page.locator('input[type="checkbox"][name*="jump_to_recipe_button_enabled"], input[type="checkbox"][name*="enabled"]').first();
  if (await enableToggle.count()) {
    const isOn = await enableToggle.isChecked().catch(() => false);
    if (isOn) { log('  ✓ Already enabled'); return; }
    await enableToggle.click({ force: true });
    await wait(500);
  }
  const saveBtn = page.locator('button:has-text("Save Changes"), input[value*="Save"]').first();
  if (await saveBtn.count()) { await saveBtn.click(); await wait(2000); }
  log('  ✓ Enabled (verify visually)');
}

// ── 3. Kadence Author Box ──
async function toggleKadenceAuthorBox(page) {
  log('[3/4] Kadence Author Box...');
  // Customizer is stateful and JS-heavy. Best effort via Kadence options page if available.
  // Fallback: skip and report — user can flip in Customizer (1 click).
  await page.goto(`${WP_URL}/wp-admin/customize.php?autofocus[section]=kadence_customizer_post_layout`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(4000);
  // Try to find the author-bio toggle inside iframe
  const toggle = page.locator('input[id*="author_box"], input[name*="author_box"], label:has-text("Author Box") input[type="checkbox"]').first();
  if (await toggle.count()) {
    const isOn = await toggle.isChecked().catch(() => false);
    if (!isOn) {
      await toggle.click({ force: true });
      await wait(500);
      const pub = page.locator('#save, button:has-text("Publish")').first();
      if (await pub.count()) { await pub.click().catch(() => {}); await wait(2000); }
      log('  ✓ Enabled');
    } else {
      log('  ✓ Already enabled');
    }
  } else {
    log('  ⚠ Customizer toggle not auto-detected — please toggle manually:');
    log('     Customize → Single Post Layout → Show Author Box → ON');
  }
}

// ── 4. Install Grow Social ──
async function installGrowSocial(page) {
  log('[4/4] Grow Social plugin...');
  await page.goto(`${WP_URL}/wp-admin/plugins.php`, { waitUntil: 'domcontentloaded' });
  await wait(1500);
  const existing = await page.locator('tr:has-text("Grow"), tr:has-text("Grow Social")').count();
  if (existing > 0) {
    // Check if active
    const activateLink = page.locator('tr:has-text("Grow") a:has-text("Activate")').first();
    if (await activateLink.count()) { await activateLink.click(); await wait(3000); log('  ✓ Activated'); }
    else { log('  ✓ Already installed + active'); }
    return;
  }
  // Install fresh
  await page.goto(`${WP_URL}/wp-admin/plugin-install.php?s=grow+social+mediavine&tab=search&type=term`, { waitUntil: 'domcontentloaded' });
  await wait(3000);
  const installBtn = page.locator('a:has-text("Install Now")').first();
  if (!(await installBtn.count())) { log('  ✗ Plugin card not found'); return; }
  await installBtn.click();
  // Wait for install → becomes "Activate"
  const activateBtn = page.locator('a:has-text("Activate")').first();
  await activateBtn.waitFor({ state: 'visible', timeout: 60000 });
  await activateBtn.click();
  await wait(3000);
  log('  ✓ Installed + activated');
}

// ── Main ──
log(`Launching browser with profile: ${PROFILE}`);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: ['--disable-blink-features=AutomationControlled']
});
const page = ctx.pages()[0] || await ctx.newPage();

try {
  await ensureLoggedIn(page);
  await toggleYoastBreadcrumbs(page);
  await toggleWPRMJumpToRecipe(page);
  await toggleKadenceAuthorBox(page);
  await installGrowSocial(page);
  log('All done. Close this terminal when ready.');
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exitCode = 1;
}
await wait(3000);
await ctx.close();
