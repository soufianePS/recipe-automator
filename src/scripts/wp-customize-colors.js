/**
 * Set Kadence Customizer colors by:
 *  1. Finding every setting whose current value is the purple #9b7fb0 (Kadence's theme button/link color)
 *  2. Using wp.customize('key').set(newColor) for each — same API the Customize UI uses
 *  3. Calling wp.customize.previewer.save() to publish
 *
 * Run: node src/scripts/wp-customize-colors.js
 */

import { chromium } from 'playwright';
import { join } from 'path';
import { readFileSync } from 'fs';

const settings = JSON.parse(readFileSync('./data/sites/leagueofcooking/settings.json', 'utf8'));
const WP_URL = settings.wpUrl;
const PROFILE = join(process.env.LOCALAPPDATA || '', 'recipe-automator-wp-admin-profile');

const PEACH = '#e0b8a9';
const DARK = '#2a2a2a';
const WHITE = '#ffffff';
const PURPLE = '#9b7fb0';

const log = (m) => console.log(`[Customize] ${m}`);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1500, height: 900 },
  args: ['--disable-blink-features=AutomationControlled']
});
const page = ctx.pages()[0] || await ctx.newPage();

try {
  log('Opening customize.php...');
  await page.goto(`${WP_URL}/wp-admin/customize.php`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('wp-login')) throw new Error('Not logged in. Run wp-admin-setup.js first.');

  // Wait for wp.customize to be ready
  await page.waitForFunction(() => typeof window.wp?.customize === 'function' && window.wp.customize.state('ready')?.get?.(), { timeout: 60000 }).catch(() => {});
  await wait(4000);

  // Step 1: find all settings whose value is the purple
  const hitList = await page.evaluate((purple) => {
    const hits = [];
    wp.customize.each((setting) => {
      try {
        const v = setting.get();
        if (typeof v === 'string' && v.toLowerCase() === purple.toLowerCase()) {
          hits.push({ id: setting.id, value: v });
        } else if (v && typeof v === 'object') {
          const s = JSON.stringify(v).toLowerCase();
          if (s.includes(purple.toLowerCase())) hits.push({ id: setting.id, value: JSON.stringify(v).slice(0, 200) });
        }
      } catch {}
    });
    return hits;
  }, PURPLE);

  log(`Found ${hitList.length} settings containing ${PURPLE}:`);
  for (const h of hitList) log(`  ${h.id} = ${h.value}`);

  if (hitList.length === 0) {
    log('No settings hold that exact purple directly — checking Kadence global palette now...');
    const paletteInfo = await page.evaluate(() => {
      const s = wp.customize('kadence_global_palette');
      return s ? s.get() : null;
    });
    log(`kadence_global_palette: ${JSON.stringify(paletteInfo).slice(0, 600)}`);
  }

  // Step 1b: Inspect Additional CSS setting (that's where the purple actually lives)
  const cssInfo = await page.evaluate(() => {
    let id = null, value = null;
    wp.customize.each((s) => {
      if (/^custom_css/.test(s.id)) { id = s.id; value = s.get(); }
    });
    return { id, length: value ? value.length : 0, preview: value ? value.slice(0, 300) : null };
  });
  log(`Additional CSS setting id=${cssInfo.id} length=${cssInfo.length}`);
  if (cssInfo.preview) log(`CSS preview: ${cssInfo.preview.replace(/\n/g, ' | ').slice(0, 400)}`);

  // Step 2: update each match to peach/dark and also force common button/link keys
  const updated = await page.evaluate(({ purple, peach, dark, white, hits }) => {
    const changes = [];
    const setIfExists = (id, val) => {
      const s = wp.customize(id);
      if (s) { s.set(val); changes.push({ id, from: s._previousValue, to: val }); }
    };
    // Replace purple anywhere it appears
    for (const h of hits) {
      const s = wp.customize(h.id);
      if (!s) continue;
      const current = s.get();
      if (typeof current === 'string') {
        s.set(peach);
        changes.push({ id: h.id, from: current, to: peach });
      } else if (current && typeof current === 'object') {
        // Deep clone and replace purple anywhere in the object
        const replace = (obj) => {
          if (!obj) return obj;
          if (typeof obj === 'string') return obj.toLowerCase() === purple.toLowerCase() ? peach : obj;
          if (Array.isArray(obj)) return obj.map(replace);
          if (typeof obj === 'object') {
            const o = {};
            for (const k of Object.keys(obj)) o[k] = replace(obj[k]);
            return o;
          }
          return obj;
        };
        const newVal = replace(JSON.parse(JSON.stringify(current)));
        s.set(newVal);
        changes.push({ id: h.id, from: 'object', to: 'object (purple→peach)' });
      }
    }
    // Also force common Kadence keys
    setIfExists('link_color', dark);
    setIfExists('buttons_background', peach);
    setIfExists('buttons_color', white);

    // Rewrite Additional CSS:
    //   1. Replace any remaining purple hex/rgb with peach
    //   2. Narrow `entry-content a` link rule so it no longer hits button text or post-title links
    //   3. Append post-title + category-tile overrides (dark text, no underline)
    let cssId = null;
    wp.customize.each((s) => { if (/^custom_css/.test(s.id)) cssId = s.id; });
    if (cssId) {
      const cssSetting = wp.customize(cssId);
      let cur = cssSetting.get() || '';
      const before = cur;

      // 1. Defensive: catch any lingering purple
      cur = cur.replace(/#9b7fb0/gi, peach);
      cur = cur.replace(/rgb\(\s*155\s*,\s*127\s*,\s*176\s*\)/gi, peach);

      // 2. Scope content-link rule to paragraph links only — post titles (<h3 a>),
      //    buttons, category tiles are outside <p>, so they won't inherit peach.
      cur = cur.replace(
        /body\s+\.entry-content\s+a(:not\([^)]*\))*\s*\{/g,
        'body .entry-content p a:not(.wprm-recipe-link) {'
      );

      // 2b. Remove homepage heading-size caps that were left over from an older
      // small-heading design. They force h1→24px and h2→22px with !important,
      // crushing the new big-font layout.
      cur = cur.replace(/\.home\s+h1,\s*body\.home\s+h1\.wp-block-heading\s*\{[^}]*\}/g, '');
      cur = cur.replace(/\.home\s+h2,\s*body\.home\s+h2\.wp-block-heading\s*\{[^}]*\}/g, '');
      cur = cur.replace(/\.home\s+\.wp-block-kadence-column\s+h1\s*\{[^}]*\}/g, '');

      // 2c. Scope the site-wide heading caps to NON-home pages, so home can use its own big sizes
      // Original: .entry-title, h1.entry-title, body h1.wp-block-heading { font-size: 38px !important; }
      cur = cur.replace(
        /\.entry-title,\s*h1\.entry-title,\s*body\s+h1\.wp-block-heading\s*\{/g,
        'body:not(.home) .entry-title, body:not(.home) h1.entry-title, body:not(.home) h1.wp-block-heading {'
      );
      // Original: .entry-content h2, .entry-content h2.wp-block-heading, body h2.wp-block-heading { font-size: 26px !important; ... }
      cur = cur.replace(
        /\.entry-content\s+h2,\s*\.entry-content\s+h2\.wp-block-heading,\s*body\s+h2\.wp-block-heading\s*\{/g,
        'body:not(.home) .entry-content h2, body:not(.home) .entry-content h2.wp-block-heading, body:not(.home) h2.wp-block-heading {'
      );

      // 3. Append overrides if not already present
      const marker = '/* homepage-overrides-v1 */';
      if (!cur.includes(marker)) {
        cur += `\n\n${marker}\n` +
`body .entry-content .wp-block-post-title,
body .entry-content .wp-block-post-title a {
  color: ${dark} !important;
  text-decoration: none !important;
}
body .entry-content .wp-block-post-title a:hover { color: ${peach} !important; }

body.home .wp-block-columns .wp-block-column > p a {
  color: ${dark} !important;
  text-decoration: none !important;
}
body.home .wp-block-columns .wp-block-column > p a:hover { color: ${peach} !important; }
`;
      }

      if (cur !== before) {
        cssSetting.set(cur);
        changes.push({ id: cssId, from: `${before.length} chars`, to: `${cur.length} chars (rewritten)` });
      } else {
        changes.push({ id: cssId, from: 'no change needed', to: 'same' });
      }
    }
    return changes;
  }, { purple: PURPLE, peach: PEACH, dark: DARK, white: WHITE, hits: hitList });

  log(`Applied ${updated.length} changes. Calling previewer.save()...`);
  for (const u of updated) log(`  ${u.id}: ${u.from} → ${u.to}`);

  // Step 3: publish
  const saveResult = await page.evaluate(() => new Promise((resolve) => {
    try {
      wp.customize.state('saved').set(false);
      // Set changeset status to publish so it's committed, not draft
      wp.customize.state('selectedChangesetStatus').set('publish');
      const done = wp.customize.previewer.save();
      done.done((resp) => resolve({ ok: true, resp: typeof resp === 'object' ? Object.keys(resp) : String(resp).slice(0, 200) }));
      done.fail((err) => resolve({ ok: false, err: typeof err === 'object' ? JSON.stringify(err).slice(0, 400) : String(err).slice(0, 400) }));
      setTimeout(() => resolve({ ok: false, err: 'timeout' }), 30000);
    } catch (e) { resolve({ ok: false, err: e.message }); }
  }));

  log(`save result: ${JSON.stringify(saveResult)}`);
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exitCode = 1;
} finally {
  await wait(2000);
  await ctx.close();
}
