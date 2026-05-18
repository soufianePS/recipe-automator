// Phase 1.5: validate the full Dolphin → Playwright → Pinterest chain.
// 1. Starts a Dolphin profile with automation enabled
// 2. Connects Playwright via CDP
// 3. Opens pinterest.com
// 4. Checks if logged in (looks for the user avatar or login form)
// 5. Takes a screenshot
// 6. Closes
//
// Run: node scripts/test-pinterest-connect.mjs [--profile-id 792149670]

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

const log = (...a) => console.log('[pin-connect]', ...a);

async function main() {
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

  log(`Starting Dolphin profile ${profileId}...`);
  const { port, wsEndpoint } = await dolphin.startAndGetCDP(profileId);
  log(`✓ CDP port: ${port}`);

  log(`Connecting Playwright via CDP (http://localhost:${port})...`);
  const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
  log(`✓ Connected. Existing contexts: ${browser.contexts().length}`);

  const context = browser.contexts()[0] || (await browser.newContext());
  const page = context.pages()[0] || (await context.newPage());
  log(`Using ${context.pages().length} existing page(s); will navigate the first one`);

  log('Going to pinterest.com...');
  await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const url = page.url();
  log(`Final URL: ${url}`);

  // Check if logged in by looking for the avatar or pin grid
  const isLoggedIn = await page.evaluate(() => {
    const hasAvatar = !!document.querySelector('[data-test-id="header-profile"], div[data-test-id="user-avatar"]');
    const hasPinGrid = !!document.querySelector('[data-test-id="pin"], div[data-grid-item]');
    const hasLoginForm = !!document.querySelector('input[type="email"], input[name="email"]');
    return { hasAvatar, hasPinGrid, hasLoginForm };
  });
  log('Login state probe:', JSON.stringify(isLoggedIn));

  if (isLoggedIn.hasLoginForm) {
    log('⚠ NOT logged in to Pinterest. Open the Dolphin profile manually, go to pinterest.com, and log in. The session will persist.');
  } else if (isLoggedIn.hasAvatar || isLoggedIn.hasPinGrid) {
    log('✓ Looks logged in (avatar/pin grid detected)');
  } else {
    log('? Unable to determine login state — Pinterest may have changed the DOM. Check the screenshot.');
  }

  // Screenshot
  const ssDir = join(ROOT, 'screenshots');
  mkdirSync(ssDir, { recursive: true });
  const ssPath = join(ssDir, `pinterest-connect-${Date.now()}.png`);
  await page.screenshot({ path: ssPath, fullPage: false });
  log(`Screenshot saved: ${ssPath}`);

  log('Closing in 5s...');
  await new Promise(r => setTimeout(r, 5000));
  try { await browser.close(); } catch {}
  try { await dolphin.stopProfile(profileId); } catch {}
  log('✓ Done');
}

main().catch(e => { console.error('[pin-connect] fatal:', e); process.exit(1); });
