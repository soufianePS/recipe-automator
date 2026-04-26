/**
 * Set the site logo + hide text site title via the Kadence Customizer.
 * The logo is clickable and links to home automatically (WP core behavior).
 *
 * Run: node src/scripts/wp-set-logo.js <attachment_id>
 * Example: node src/scripts/wp-set-logo.js 2983
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { readFileSync } from 'fs';

const LOGO_ID = parseInt(process.argv[2], 10);
if (!LOGO_ID) { console.error('Usage: node wp-set-logo.js <attachment_id>'); process.exit(1); }

const settings = JSON.parse(readFileSync('./data/sites/leagueofcooking/settings.json', 'utf8'));
const WP_URL = settings.wpUrl;
const PROFILE = join(process.env.LOCALAPPDATA || '', 'recipe-automator-wp-admin-profile');

const log = (m) => console.log(`[Logo] ${m}`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true,
  viewport: { width: 1500, height: 900 }
});
const page = ctx.pages()[0] || await ctx.newPage();

try {
  log('Opening customize.php...');
  await page.goto(`${WP_URL}/wp-admin/customize.php`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('wp-login')) throw new Error('Not logged in. Run wp-admin-setup.js first.');
  await page.waitForFunction(() => typeof window.wp?.customize === 'function', { timeout: 60000 });
  await wait(4000);

  // Find logo-related settings
  const logoSettings = await page.evaluate(() => {
    const keys = [];
    wp.customize.each((s) => {
      if (/logo|site_icon|site_title|header_title_tagline/.test(s.id)) {
        let v = s.get();
        if (typeof v === 'object') v = JSON.stringify(v).slice(0, 80);
        keys.push({ id: s.id, value: v });
      }
    });
    return keys;
  });
  log('Logo-related settings before change:');
  for (const s of logoSettings) log(`  ${s.id} = ${s.value}`);

  // Inspect Kadence's header-layout setting
  const layoutInfo = await page.evaluate(() => {
    const info = {};
    const setting = wp.customize('header_desktop_items');
    info.header_desktop_items = setting ? setting.get() : null;
    const rowLayout = wp.customize('header_row_layout_main');
    info.header_row_layout_main = rowLayout ? rowLayout.get() : null;
    return info;
  });
  log('Kadence header items JSON:');
  log(JSON.stringify(layoutInfo.header_desktop_items).slice(0, 600));

  // Apply changes:
  //  - Set custom_logo
  //  - Insert "branding" element into the 'main_left' section so the real logo appears in the top row
  //  - Remove the CSS ::before "League of Cooking" text from Additional CSS
  //  - Bump logo height so it's readable
  const applied = await page.evaluate((logoId) => {
    const changes = [];
    const set = (id, val) => {
      const s = wp.customize(id);
      if (s) { const before = s.get(); s.set(val); changes.push({ id, before: JSON.stringify(before).slice(0,80), after: JSON.stringify(val).slice(0,80) }); }
    };

    // 1. Set custom logo
    set('custom_logo', logoId);

    // 2. Move "branding" into the top-left row (alongside nav)
    const itemsSetting = wp.customize('header_desktop_items');
    if (itemsSetting) {
      const items = JSON.parse(JSON.stringify(itemsSetting.get() || {}));
      // Remove branding from ALL rows first
      for (const rowKey of Object.keys(items)) {
        const row = items[rowKey];
        if (row && typeof row === 'object') {
          for (const sectionKey of Object.keys(row)) {
            if (Array.isArray(row[sectionKey])) {
              row[sectionKey] = row[sectionKey].filter(x => x !== 'logo');
            }
          }
        }
      }
      // Put branding at the start of main_left
      if (items.main && items.main.main_left) {
        items.main.main_left = ['logo', ...items.main.main_left.filter(x => x !== 'logo')];
        set('header_desktop_items', items);
      }
    }

    // 3. Increase logo height so it's readable
    const lw = wp.customize('logo_width');
    if (lw) {
      const current = lw.get() || {};
      const next = JSON.parse(JSON.stringify(current));
      next.size = next.size || {};
      next.size.desktop = 220;
      next.size.tablet = 180;
      next.size.mobile = 140;
      lw.set(next);
      changes.push({ id: 'logo_width', to: 'desktop:80, tablet:64, mobile:56' });
    }

    // 3b. Show only the logo image (hide the site-title text beside it)
    const ll = wp.customize('logo_layout');
    if (ll) {
      const current = ll.get() || {};
      const next = JSON.parse(JSON.stringify(current));
      next.include = next.include || {};
      next.include.desktop = 'logo';
      next.include.tablet = 'logo';
      next.include.mobile = 'logo';
      ll.set(next);
      changes.push({ id: 'logo_layout', to: 'logo-only on all breakpoints' });
    }

    // 4. Strip the ::before "League of Cooking" rule from Additional CSS
    let cssId = null;
    wp.customize.each(s => { if (/^custom_css/.test(s.id)) cssId = s.id; });
    if (cssId) {
      const cs = wp.customize(cssId);
      let cur = cs.get() || '';
      const before = cur.length;
      // Match any ::before rule containing "League of Cooking" text (flexible)
      cur = cur.replace(/[^{}]*::before\s*\{[^}]*League of Cooking[^}]*\}/gi, '');
      if (cur.length !== before) { cs.set(cur); changes.push({ id: cssId, to: `stripped ::before rule (${before} → ${cur.length} chars)` }); }
      else { changes.push({ id: cssId, to: 'no ::before rule matched for removal' }); }
    }
    return changes;
  }, LOGO_ID);

  log('Applied changes:');
  for (const c of applied) log(`  ${c.id}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`);

  // Publish
  const result = await page.evaluate(() => new Promise((resolve) => {
    wp.customize.state('selectedChangesetStatus').set('publish');
    const done = wp.customize.previewer.save();
    done.done((resp) => resolve({ ok: true, resp: Object.keys(resp || {}) }));
    done.fail((err) => resolve({ ok: false, err: String(err).slice(0, 300) }));
    setTimeout(() => resolve({ ok: false, err: 'timeout' }), 30000);
  }));
  log(`save: ${JSON.stringify(result)}`);
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  await wait(1500);
  await ctx.close();
}
