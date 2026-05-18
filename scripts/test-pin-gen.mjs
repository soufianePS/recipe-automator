// Isolated Pinterest pin generation test.
// Pulls a hero image from a WordPress post, picks a template from the
// dashboard-managed pool, and runs Flow with the current VG pin prompt.
// Saves the output to scripts/_pin-test-output.jpg for visual comparison
// against the template.
//
// Run: node scripts/test-pin-gen.mjs [--post-id 4219] [--template-idx 0]
//                                    [--pin-title "Your title"]
//                                    [--upload --sheet-row 66]
//
// With --upload: also uploads the result to WordPress as a new media
// attached to the post, and (if --sheet-row given) writes the new image
// URL into the Sheet's pin1 column (F) for that row.
//
// This bypasses the full 14-step pipeline so you can iterate on the pin
// prompt without regenerating a recipe.

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

// ── CLI args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const postId = parseInt(arg('post-id', '4219'));
const templateIdx = parseInt(arg('template-idx', '0'));
const pinTitleOverride = arg('pin-title', null);
const doUpload = args.includes('--upload');
const sheetRow = parseInt(arg('sheet-row', '0')) || null;

const log = (...a) => console.log('[pin-test]', ...a);

// ── Step 1: pull hero from WP ────────────────────────────────────
async function fetchWPPost(settings, postId) {
  const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
  const url = `${settings.wpUrl}/wp-json/wp/v2/posts/${postId}?_embed`;
  const r = await fetch(url, { headers: { Authorization: auth } });
  if (!r.ok) throw new Error(`WP fetch failed ${r.status}`);
  return await r.json();
}

async function downloadImage(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`image download failed ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.length;
}

// ── Step 2: format ingredient bullets (mirrors orchestrator) ─────
function formatIngredients(post) {
  // Try Tasty Recipes ACF / meta first; fall back to nothing
  const items = post.meta?.recipe_ingredients
    || post.recipe?.ingredients
    || post.tasty_recipe?.ingredients
    || null;
  if (!Array.isArray(items) || !items.length) {
    return '• 1.5 pounds ground chuck beef\n• 4 thick slices sharp cheddar\n• 8 strips thick-cut bacon\n• 4 whole brioche buns\n• 4 large leaves green leaf lettuce\n• 1 medium red onion\n• 0.5 cups barbecue sauce\n• 1 tablespoon avocado oil';
  }
  return items
    .slice(0, 8)
    .map(it => {
      const q = (it.quantity || '').trim();
      const n = (it.name || it.ingredient || '').trim();
      return q && n ? `• ${q} ${n}` : `• ${n || q}`;
    })
    .filter(Boolean)
    .join('\n');
}

// ── Step 3: pick template from dashboard pool ────────────────────
async function pickTemplate(idx) {
  const templates = await StateManager.getPinterestTemplates('generator');
  if (!templates.length) throw new Error('No dashboard templates uploaded');
  log(`${templates.length} dashboard templates available; picking idx ${idx}: ${templates[idx % templates.length].name}`);
  return templates[idx % templates.length];
}

// ── Main ─────────────────────────────────────────────────────────
async function main() {
  // Load active site settings
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));
  log(`Active site: ${activeSite}`);

  // Pull WP post + hero
  log(`Fetching WP post ${postId}...`);
  const post = await fetchWPPost(settings, postId);
  const recipeTitle = post.title?.rendered?.replace(/&amp;/g, '&').replace(/<[^>]*>/g, '') || `Post ${postId}`;
  log(`Recipe title: "${recipeTitle}"`);

  const featuredUrl = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
  if (!featuredUrl) throw new Error(`No featured media on post ${postId}`);
  log(`Hero URL: ${featuredUrl}`);

  // Download hero
  const tmpDir = join(ROOT, 'data', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const heroPath = join(tmpDir, `pin-test-hero.${featuredUrl.split('.').pop().split('?')[0]}`);
  const size = await downloadImage(featuredUrl, heroPath);
  log(`Hero saved: ${heroPath} (${(size/1024).toFixed(0)}KB)`);

  // Pick template
  const tplObj = await pickTemplate(templateIdx);
  const ext = tplObj.name?.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  const tplPath = join(tmpDir, `pin-test-template.${ext}`);
  writeFileSync(tplPath, Buffer.from(tplObj.base64, 'base64'));
  log(`Template saved: ${tplPath}`);

  // Build prompt
  const ingredients = formatIngredients(post);
  const websiteDomain = settings.wpUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const pinTitle = pinTitleOverride || `The Ultimate ${recipeTitle} Recipe`;
  const prompt = DEFAULT_VG_PINTEREST_PROMPT
    .replace(/\{\{pin_title\}\}/g, pinTitle)
    .replace(/\{\{pin_description\}\}/g, '')
    .replace(/\{\{recipe_title\}\}/g, recipeTitle)
    .replace(/\{\{website\}\}/g, websiteDomain)
    .replace(/\{\{ingredients\}\}/g, ingredients);

  log(`\n--- Prompt (${prompt.length} chars) ---\n${prompt}\n--- End prompt ---\n`);

  // Resolve active Flow account profile
  const account = await FlowAccountManager.getActiveAccount();
  if (!account) throw new Error('No active Flow account');
  const profileDir = FlowAccountManager.getProfileDir(account);
  log(`Using Flow account: ${account.name} (profile: ${profileDir})`);

  // Launch Playwright with the persistent profile
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

  const outputPath = join(__dirname, '_pin-test-output.jpg');
  log(`Generating pin → ${outputPath}`);

  try {
    const ok = await flow.generate(
      prompt,
      tplPath,        // template = background
      [heroPath],     // hero = single context ref
      settings.pinterestAspectRatio || 'PORTRAIT',
      outputPath,
      { skipSimilarityCheck: true }
    );
    if (ok && existsSync(outputPath)) {
      log(`\n✓ Pin generated successfully: ${outputPath}`);
      log(`Open it side-by-side with the template (${tplObj.name}) to compare.`);

      // ── Optional: upload to WP + update Sheet ──────────────────
      if (doUpload) {
        log('\n--- Upload phase ---');
        const pinBuffer = readFileSync(outputPath);
        const pinBase64 = pinBuffer.toString('base64');
        const slug = (recipeTitle || 'pin').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const uploadFilename = `${slug}-pin-1-new.jpg`;
        const seo = {
          alt_text: `${recipeTitle} — Pinterest pin`,
          title: pinTitle,
          description: `${recipeTitle} recipe pin from leagueofcooking.com`
        };
        log(`Uploading ${(pinBuffer.length / 1024).toFixed(0)}KB → WP /wp/v2/media as "${uploadFilename}"...`);
        const media = await WordPressAPI.uploadImage(settings, pinBase64, uploadFilename, seo);
        if (!media?.url) throw new Error('WP upload failed — no url returned');
        log(`✓ Uploaded to WP: ${media.url}`);
        log(`  media id: ${media.id}`);

        // Attach to the post so it shows up under the recipe
        try {
          const auth = 'Basic ' + Buffer.from(settings.wpUsername + ':' + settings.wpAppPassword).toString('base64');
          await fetch(`${settings.wpUrl}/wp-json/wp/v2/media/${media.id}`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ post: postId })
          });
          log(`✓ Attached media ${media.id} to post ${postId}`);
        } catch (e) {
          log(`(non-fatal) couldn't set media parent: ${e.message}`);
        }

        // Sheet update — write the new URL into pin1 img column (F)
        if (sheetRow) {
          log(`Updating Sheet row ${sheetRow}, pin1 img cell...`);
          const sheetSettings = {
            ...settings,
            sheetTabName: settings.verifiedGenSheetTab || settings.generatorSheetTab || settings.sheetTabName || 'single post',
          };
          // Column F = pin1 img. Range: F<row>.
          const range = `${sheetSettings.sheetTabName}!F${sheetRow}`;
          await SheetsAPI.writeRange(sheetSettings.sheetId, range, [[media.url]], sheetSettings);
          log(`✓ Sheet ${sheetSettings.sheetTabName}!F${sheetRow} updated with new URL`);
        } else {
          log('(--sheet-row not provided — skipping Sheet update)');
        }
      }
    } else {
      log('✗ Pin generation failed');
    }
  } catch (e) {
    log('✗ Error:', e.message);
  } finally {
    log('Closing browser in 10s (so you can inspect)...');
    await new Promise(r => setTimeout(r, 10000));
    try { await flow.closeSession(); } catch {}
    try { await ctx.close(); } catch {}
  }
}

main().catch(e => { console.error(e); process.exit(1); });
