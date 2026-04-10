/**
 * Click the confirm button in the update modal for Rewriter GPT
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
  await delay(8000);

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'final-1.png') });

  // Click Configurer
  const configTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
  if (await configTab.isVisible().catch(() => false)) {
    await configTab.click();
    await delay(2000);
  }

  // Check if the knowledge file is there
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = 800);
  });
  await delay(1000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'final-2-kb.png') });

  // Click "Mettre à jour" top-right
  const updateBtn = page.locator('button').filter({ hasText: /Mettre à jour|Update/i }).first();
  if (await updateBtn.isVisible().catch(() => false)) {
    await updateBtn.click();
    console.log('Clicked Mettre à jour');
    await delay(5000);
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'final-3-modal.png') });

  // Click the confirm button inside the modal using force click
  // The modal has data-testid="modal-gizmo-updated"
  const modalConfirm = page.locator('[data-testid="modal-gizmo-updated"] button, [id="modal-gizmo-updated"] button').filter({ hasText: /Mettre à jour|Update|Confirm|Enregistrer|Save/i }).first();
  if (await modalConfirm.count() > 0) {
    await modalConfirm.click({ force: true });
    console.log('Clicked modal confirm (force)');
    await delay(8000);
  } else {
    // Try any visible button with Mettre à jour text
    console.log('Looking for any confirm button...');
    const btns = await page.locator('button').filter({ hasText: /Mettre à jour|Confirm/i }).all();
    for (const btn of btns) {
      const text = (await btn.innerText().catch(() => '')).trim();
      console.log(`  Button: "${text}"`);
      try {
        await btn.click({ force: true, timeout: 5000 });
        console.log(`  Clicked "${text}" (force)`);
        await delay(8000);
        break;
      } catch (e) {
        console.log(`  Failed: ${e.message.substring(0, 50)}`);
      }
    }
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'final-4-done.png') });
  console.log('URL:', page.url());
  console.log('Done!');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
