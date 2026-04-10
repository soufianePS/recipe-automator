/**
 * Save the Recipe Rewriter GPT (go back from Actions, then click top-right Créer)
 */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');
const REWRITER_EDITOR_URL = 'https://chatgpt.com/gpts/editor/g-69c1110d4f048191ac6a4b32b9039eb7';
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  try {
    const prefsPath = join(PROFILE_DIR, 'Default', 'Preferences');
    if (existsSync(prefsPath)) {
      const prefs = JSON.parse(readFileSync(prefsPath, 'utf-8'));
      if (prefs.profile) prefs.profile.exit_type = 'Normal';
      if (prefs.profile) prefs.profile.exited_cleanly = true;
      writeFileSync(prefsPath, JSON.stringify(prefs));
    }
  } catch {}

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--hide-crash-restore-bubble'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    timeout: 30000,
  });

  const page = await context.newPage();

  console.log('Opening Rewriter GPT editor...');
  await page.goto(REWRITER_EDITOR_URL, { waitUntil: 'domcontentloaded' });
  await delay(6000);

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'save-rewriter-1.png') });
  console.log('Page loaded, URL:', page.url());

  // Verify we're on the Configure view
  const configTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
  if (await configTab.isVisible().catch(() => false)) {
    await configTab.click();
    await delay(2000);
  }

  // Verify the knowledge file is there
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = p.scrollHeight);
  });
  await delay(1000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'save-rewriter-2-kb.png') });

  // Scroll back up
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = 0);
  });
  await delay(500);

  // Click the top-right "Créer" button specifically
  // It's the one that's NOT inside the tab bar and NOT "Créer une nouvelle action"
  // Use position-based selection: the button in the top-right corner
  const topRightBtn = page.locator('button').filter({ hasText: /^Créer$|^Create$|^Enregistrer$|^Save$|^Mettre à jour$|^Update$/i });
  const count = await topRightBtn.count();
  console.log(`Found ${count} matching buttons`);

  for (let i = 0; i < count; i++) {
    const btn = topRightBtn.nth(i);
    const text = await btn.innerText().catch(() => '');
    const box = await btn.boundingBox().catch(() => null);
    const visible = await btn.isVisible().catch(() => false);
    console.log(`  [${i}] "${text.trim()}" visible=${visible} box=${box ? `x=${Math.round(box.x)} y=${Math.round(box.y)}` : 'null'}`);
  }

  // The top-right button is the one with x > 1000 and y < 100
  for (let i = 0; i < count; i++) {
    const btn = topRightBtn.nth(i);
    const box = await btn.boundingBox().catch(() => null);
    if (box && box.x > 900 && box.y < 100) {
      console.log(`Clicking top-right button [${i}]...`);
      await btn.click();
      console.log('Clicked!');
      await delay(8000);
      break;
    }
  }

  // Handle confirmation dialog
  await delay(2000);
  const confirmBtn = page.locator('button').filter({ hasText: /Confirmer|Confirm|Mettre à jour|Update|Seulement moi|Only me/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    console.log('Confirmed');
    await delay(5000);
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'save-rewriter-done.png') });
  console.log('URL:', page.url());
  console.log('Done!');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
