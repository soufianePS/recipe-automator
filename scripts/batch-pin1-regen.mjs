// Batch: regenerate pin 1 for the last 20 WP posts (skipping Burgers
// #4219 + Cheeseburgers #4232), upload to WP, update Sheet column F.
//
// One Playwright context is reused across all 20 pins (no relaunch).
// Uses template idx 0 (the Tuna Salad layout) for every pin.
//
// Run: node scripts/batch-pin1-regen.mjs [--dry-run]

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlowPage } from '../src/shared/pages/flow.js';
import { StateManager } from '../src/shared/utils/state-manager.js';
import { FlowAccountManager } from '../src/shared/utils/flow-account-manager.js';
import { WordPressAPI } from '../src/shared/utils/wordpress-api.js';
import { SheetsAPI } from '../src/shared/utils/sheets-api.js';
import { DEFAULT_VG_PINTEREST_PROMPT } from '../src/modules/verified-generator/prompts-verified.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKIP_POST_IDS = new Set([4219, 4232]); // Burgers, Cheeseburgers
const BATCH_SIZE = 20;
const TEMPLATE_IDX = 0; // Tuna Salad layout

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const log = (...a) => console.log('[batch]', ...a);

// ── Utilities ────────────────────────────────────────────────────
function cleanText(s) {
  return (s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#8217;/g, '\'').replace(/&[a-z]+;/g, '').replace(/\s+/g, ' ').trim();
}

function extractIngredientsFromHtml(html) {
  if (!html) return '';
  const match = html.match(/<h[1-6][^>]*>\s*Ingredients?[^<]*<\/h[1-6]>([\s\S]{0,3000})/i);
  if (!match) return '';
  const items = [...match[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)]
    .map(m => cleanText(m[1]))
    .map(s => s.split(':')[0].trim()) // strip ": description" suffix
    .filter(Boolean)
    .slice(0, 8);
  return items.map(s => `• ${s}`).join('\n');
}

async function fetchPosts(settings, count) {
  const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
  const url = `${settings.wpUrl}/wp-json/wp/v2/posts?per_page=${count}&status=draft,publish&_embed&_fields=id,title,date,status,content,_links,_embedded`;
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`WP posts fetch failed: ${r.status}`);
  return await r.json();
}

async function readSheetTopics(settings) {
  const sheetTab = settings.verifiedGenSheetTab || settings.generatorSheetTab || settings.sheetTabName || 'single post';
  const rows = await SheetsAPI.readSheet(settings.sheetId, sheetTab);
  // Build topic-lowercase → row-index map (rowIndex is 1-based + header = +2 from array idx)
  const map = new Map();
  for (let i = 0; i < rows.length; i++) {
    const topic = (rows[i][0] || '').trim();
    if (topic) {
      const key = topic.toLowerCase();
      if (!map.has(key)) map.set(key, i + 2); // +2 = header (1) + 1-based (1)
    }
  }
  return { sheetTab, map };
}

async function downloadHero(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`hero download failed: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));
  log(`Active site: ${activeSite}`);
  log(`Dry-run mode: ${dryRun}`);

  // 1. Fetch posts (over-fetch to allow for skipped ones)
  log(`Fetching latest ${BATCH_SIZE + SKIP_POST_IDS.size + 5} WP posts...`);
  const allPosts = await fetchPosts(settings, BATCH_SIZE + SKIP_POST_IDS.size + 5);
  const posts = allPosts.filter(p => !SKIP_POST_IDS.has(p.id)).slice(0, BATCH_SIZE);
  log(`${posts.length} posts queued (after skipping ${[...SKIP_POST_IDS].join(', ')}):`);
  posts.forEach((p, i) => log(`  ${i + 1}. #${p.id} | ${cleanText(p.title?.rendered || '')}`));

  // 2. Sheet topic map
  log('Reading Sheet topics...');
  const { sheetTab, map: sheetMap } = await readSheetTopics(settings);
  log(`Sheet tab "${sheetTab}" — ${sheetMap.size} topics indexed`);

  // 3. Picture template (dashboard, idx 0)
  const templates = await StateManager.getPinterestTemplates('generator');
  if (!templates.length) throw new Error('No dashboard templates uploaded');
  const tplObj = templates[TEMPLATE_IDX % templates.length];
  log(`Using template idx ${TEMPLATE_IDX}: ${tplObj.name}`);

  const tmpDir = join(ROOT, 'data', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tplExt = tplObj.name?.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const tplPath = join(tmpDir, `batch-pin-template.${tplExt}`);
  writeFileSync(tplPath, Buffer.from(tplObj.base64, 'base64'));

  // 4. Launch browser ONCE
  const account = await FlowAccountManager.getActiveAccount();
  if (!account) throw new Error('No active Flow account');
  const profileDir = FlowAccountManager.getProfileDir(account);
  log(`Flow account: ${account.name} (${profileDir})`);

  if (dryRun) {
    log('\n--- DRY-RUN: would now process the queue. Stopping here. ---');
    return;
  }

  log('Launching browser...');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 30000,
  });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);

  const flow = new FlowPage(null, ctx);
  flow.preferredModel = 'Nano Banana Pro';

  const results = [];
  let i = 0;
  for (const post of posts) {
    i++;
    const title = cleanText(post.title?.rendered || '');
    const prefix = `[${i}/${posts.length}] #${post.id} "${title}"`;
    log(`\n${prefix} — starting`);

    try {
      // 4a. Hero
      const heroUrl = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
      if (!heroUrl) throw new Error('no featured media');

      const heroExt = heroUrl.split('.').pop().split('?')[0];
      const heroPath = join(tmpDir, `batch-hero-${post.id}.${heroExt}`);
      await downloadHero(heroUrl, heroPath);

      // 4b. Ingredients
      const ingredients = extractIngredientsFromHtml(post.content?.rendered || '');
      if (!ingredients) log(`${prefix} ⚠ no ingredients extracted from content — pin will skip ingredients block`);

      // 4c. Sheet row
      const sheetRow = sheetMap.get(title.toLowerCase());
      if (!sheetRow) log(`${prefix} ⚠ no Sheet row matched for "${title}" — pin will be uploaded but Sheet not updated`);

      // 4d. Build prompt
      const websiteDomain = settings.wpUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const pinTitle = `The Best ${title} Recipe`;
      const prompt = DEFAULT_VG_PINTEREST_PROMPT
        .replace(/\{\{pin_title\}\}/g, pinTitle)
        .replace(/\{\{pin_description\}\}/g, '')
        .replace(/\{\{recipe_title\}\}/g, title)
        .replace(/\{\{website\}\}/g, websiteDomain)
        .replace(/\{\{ingredients\}\}/g, ingredients || '(see recipe)');

      // 4e. Generate
      const outputPath = join(tmpDir, `batch-pin-${post.id}.jpg`);
      log(`${prefix} generating pin...`);
      const ok = await flow.generate(
        prompt,
        tplPath,
        [heroPath],
        settings.pinterestAspectRatio || 'PORTRAIT',
        outputPath,
        { skipSimilarityCheck: true }
      );
      if (!ok || !existsSync(outputPath)) throw new Error('Flow generate returned false');

      // 4f. Upload to WP
      log(`${prefix} uploading to WP...`);
      const pinBase64 = readFileSync(outputPath).toString('base64');
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const uploadFilename = `${slug}-pin-1-new.jpg`;
      const seo = {
        alt_text: `${title} — Pinterest pin`,
        title: pinTitle,
        description: `${title} recipe pin from leagueofcooking.com`
      };
      const media = await WordPressAPI.uploadImage(settings, pinBase64, uploadFilename, seo);
      // WordPressAPI.uploadImage returns { id, url } — not raw WP media object
      if (!media?.url) throw new Error('WP upload — no url returned');

      // 4g. Attach to post
      const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
      try {
        await fetch(`${settings.wpUrl}/wp-json/wp/v2/media/${media.id}`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({ post: post.id })
        });
      } catch {}

      // 4h. Sheet update
      if (sheetRow) {
        const range = `${sheetTab}!F${sheetRow}`;
        await SheetsAPI.writeRange(settings.sheetId, range, [[media.url]], settings);
      }

      log(`${prefix} ✓ done — ${media.url}${sheetRow ? ` (sheet F${sheetRow})` : ' (no sheet)'}`);
      results.push({ id: post.id, title, status: 'ok', url: media.url, sheetRow });

    } catch (e) {
      log(`${prefix} ✗ FAILED: ${e.message}`);
      results.push({ id: post.id, title, status: 'error', error: e.message });
    }

    // Light pacing between recipes
    await new Promise(r => setTimeout(r, 2000));
  }

  // 5. Final report
  log('\n═══ BATCH COMPLETE ═══');
  const successes = results.filter(r => r.status === 'ok').length;
  const errors = results.filter(r => r.status === 'error').length;
  log(`Total: ${results.length} | ✓ Success: ${successes} | ✗ Errors: ${errors}`);
  for (const r of results) {
    if (r.status === 'ok') log(`  ✓ #${r.id} ${r.title} → ${r.url}`);
    else log(`  ✗ #${r.id} ${r.title} — ${r.error}`);
  }

  log('\nClosing browser in 5s...');
  await new Promise(r => setTimeout(r, 5000));
  try { await flow.closeSession(); } catch {}
  try { await ctx.close(); } catch {}
}

main().catch(e => { console.error('[batch] fatal:', e); process.exit(1); });
