// Phase 2 validation: post ONE Pinterest pin via Dolphin → Playwright.
//
// Run: node scripts/test-pinterest-post.mjs
//        [--profile-id 792149670]
//        [--image scripts/_pin-test-output.jpg]
//        [--title "Best Burgers Recipe"]
//        [--description "..."]
//        [--link https://leagueofcooking.com]
//        [--board "Recipes"]
//        [--no-warmup]
//
// Defaults to the existing scripts/_pin-test-output.jpg (Burgers pin we
// already generated) and a Burgers-themed title/description. You must
// pass --board with the EXACT name of a board on the logged-in Pinterest
// account, or the first board found will be used.

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';
import { PinterestPage } from '../src/shared/pages/pinterest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (n, def) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : def; };
const noWarmup = args.includes('--no-warmup');

const profileId = parseInt(arg('profile-id', '792149670'));
const imagePathArg = arg('image', 'scripts/_pin-test-output.jpg');
const title = arg('title', 'The Only Burger Recipe You Need This Summer');
const description = arg('description', 'Juicy beef patties, melted cheddar, crispy bacon, and homemade BBQ sauce on toasted brioche buns. This is the burger your friends will keep asking about.');
const link = arg('link', 'https://leagueofcooking.com');
const boardName = arg('board', null);

const log = (...a) => console.log('[pin-post]', ...a);

async function main() {
  const imagePath = isAbsolute(imagePathArg) ? imagePathArg : join(ROOT, imagePathArg);
  if (!existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }
  log(`Image: ${imagePath}`);
  log(`Title: ${title}`);
  log(`Description: ${description.slice(0, 80)}...`);
  log(`Link: ${link}`);
  log(`Board: ${boardName || '(first available)'}`);
  log(`Warmup: ${!noWarmup}`);

  // Prefer planifier config (new global token) over per-site settings
  const planPath = join(ROOT, 'data', 'planifier', 'config.json');
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  let dolphinSettings;
  try {
    const planCfg = JSON.parse(readFileSync(planPath, 'utf8'));
    if (planCfg?.dolphinAnty?.apiToken) {
      dolphinSettings = { dolphinAnty: planCfg.dolphinAnty };
      log(`Using token from planifier config (plan: ${planCfg.dolphinAnty.lastTestResult?.plan || 'unknown'})`);
    }
  } catch {}
  if (!dolphinSettings) {
    dolphinSettings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));
    log('Using token from site settings (fallback)');
  }
  const dolphin = new DolphinAnty(dolphinSettings);
  const settings = dolphinSettings;

  log(`Starting Dolphin profile ${profileId}...`);
  const { port } = await dolphin.startAndGetCDP(profileId);
  log(`✓ CDP port: ${port}`);

  let browser;
  try {
    log(`Connecting Playwright via CDP...`);
    browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.newPage());

    const pinterest = new PinterestPage(page);
    await pinterest.init();

    log('Starting createPin flow...');
    const t0 = Date.now();
    const result = await pinterest.createPin({
      imagePath, title, description, link, boardName,
      altText: title,
      warmup: !noWarmup,
    });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`✓ DONE in ${dt}s — pinUrl: ${result.pinUrl || '(no URL captured)'}`);

  } catch (e) {
    console.error('[pin-post] ✗ Error:', e.message);
    console.error(e.stack);
  } finally {
    log('Pausing 10s so you can inspect the browser...');
    await new Promise(r => setTimeout(r, 10000));
    try { await browser?.close(); } catch {}
    try { await dolphin.stopProfile(profileId); } catch {}
    log('Done');
  }
}

main().catch(e => { console.error('[pin-post] fatal:', e); process.exit(1); });
