/**
 * Update Kadence social profile links site-wide + remove Twitter/X icons.
 *
 * Run: node src/scripts/wp-update-social.js
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { readFileSync } from 'fs';

const FACEBOOK  = 'https://www.facebook.com/profile.php?id=61580595424640';
const INSTAGRAM = 'https://www.instagram.com/amelia_cooking_/';
const PINTEREST = 'https://www.pinterest.com/LeagueOfCookingwithAmelia/';

const settings = JSON.parse(readFileSync('./data/sites/leagueofcooking/settings.json', 'utf8'));
const WP_URL = settings.wpUrl;
const PROFILE = join(process.env.LOCALAPPDATA || '', 'recipe-automator-wp-admin-profile');

const log = (m) => console.log(`[Social] ${m}`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1500, height: 900 } });
const page = ctx.pages()[0] || await ctx.newPage();
try {
  log('Opening customize.php...');
  await page.goto(`${WP_URL}/wp-admin/customize.php`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('wp-login')) throw new Error('Not logged in.');
  await page.waitForFunction(() => typeof window.wp?.customize === 'function', { timeout: 60000 });
  await wait(4000);

  const applied = await page.evaluate(({ facebook, instagram, pinterest }) => {
    const changes = [];
    const set = (id, val) => {
      const s = wp.customize(id);
      if (s) { s.set(val); changes.push({ id, after: typeof val === 'string' ? val : JSON.stringify(val).slice(0, 120) }); }
    };

    // 1. Profile URLs (Kadence auto-fills icon href from these)
    set('facebook_link', facebook);
    set('instagram_link', instagram);
    set('pinterest_link', pinterest);
    set('twitter_link', ''); // empty disables the twitter icon href

    // 2. Strip Twitter (and X) from header/mobile/footer social items arrays
    const stripTwitter = (settingId) => {
      const s = wp.customize(settingId);
      if (!s) return;
      const val = s.get();
      if (!val || !val.items) return;
      const before = val.items.length;
      const newVal = JSON.parse(JSON.stringify(val));
      // Keep only facebook, instagram, pinterest — drop everything else
      const keep = new Set(['facebook', 'instagram', 'pinterest']);
      newVal.items = newVal.items.filter(it => keep.has(it.id));
      // Reorder: facebook, instagram, pinterest
      const order = ['facebook', 'instagram', 'pinterest'];
      newVal.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      // Ensure all three exist with enabled:true
      for (const id of order) {
        if (!newVal.items.find(x => x.id === id)) {
          newVal.items.push({ id, enabled: true, source: 'icon', url: '', imageid: '', width: 24, icon: id === 'facebook' ? 'facebookAlt' : id, label: id.charAt(0).toUpperCase() + id.slice(1) });
        }
      }
      newVal.items.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      for (const it of newVal.items) it.enabled = true;
      s.set(newVal);
      changes.push({ id: settingId, before: before, after: newVal.items.length });
    };
    stripTwitter('header_social_items');
    stripTwitter('header_mobile_social_items');
    stripTwitter('footer_social_items');

    return changes;
  }, { facebook: FACEBOOK, instagram: INSTAGRAM, pinterest: PINTEREST });

  log('Applied:');
  for (const c of applied) log(`  ${c.id}: ${JSON.stringify(c.after)}`);

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
