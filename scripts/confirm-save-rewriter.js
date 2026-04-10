/**
 * Click "Enregistrer" on the share dialog to finalize the Rewriter GPT
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

  // Check if we need to click Configurer first
  const configTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
  if (await configTab.isVisible().catch(() => false)) {
    await configTab.click();
    await delay(2000);
  }

  // Verify knowledge file is present
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = 800);
  });
  await delay(1000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'confirm-1-kb-check.png') });

  // Now click the top-right Créer button
  const topBtn = page.locator('button').filter({ hasText: /^Créer$|^Create$/i });
  const count = await topBtn.count();
  for (let i = 0; i < count; i++) {
    const box = await topBtn.nth(i).boundingBox().catch(() => null);
    if (box && box.x > 900 && box.y < 100) {
      await topBtn.nth(i).click();
      console.log('Clicked top-right Créer');
      break;
    }
  }
  await delay(3000);

  // Now click "Enregistrer" in the share dialog
  const saveBtn = page.locator('button').filter({ hasText: /Enregistrer|Save/i }).first();
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click();
    console.log('Clicked Enregistrer');
    await delay(8000);
  } else {
    // Maybe need "Moi seulement" first, then Enregistrer
    const meOnly = page.locator('text=Moi seulement').first();
    if (await meOnly.isVisible().catch(() => false)) {
      await meOnly.click();
      await delay(1000);
    }
    const saveBtn2 = page.locator('button').filter({ hasText: /Enregistrer|Save|Confirm/i }).first();
    if (await saveBtn2.isVisible().catch(() => false)) {
      await saveBtn2.click();
      console.log('Clicked Enregistrer (after selecting Moi seulement)');
      await delay(8000);
    }
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'confirm-2-done.png') });
  console.log('URL:', page.url());
  console.log('Done!');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
