/**
 * Upload knowledge file to Recipe Rewriter GPT and save
 */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');
const KNOWLEDGE_FILE = join(__dirname, '..', 'docs', 'gpt-intro-templates.md');
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

  // Click Configurer tab
  const configTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
  if (await configTab.isVisible().catch(() => false)) {
    await configTab.click();
    console.log('Clicked Configurer');
    await delay(3000);
  }

  // Scroll to knowledge base section
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = 800);
  });
  await delay(1000);

  // Upload knowledge file
  console.log('Uploading knowledge file...');
  const uploadBtn = page.locator('button').filter({ hasText: /Charger les fichiers|Upload files/i }).first();
  if (await uploadBtn.isVisible().catch(() => false)) {
    const [fileChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      uploadBtn.click()
    ]);
    await fileChooser.setFiles(KNOWLEDGE_FILE);
    console.log('File selected, waiting for upload...');
    // Wait for the file chip to appear
    await delay(10000);
    await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'upload-kb-1-after-upload.png') });
  } else {
    console.log('Upload button not found!');
  }

  // Now click the top-right "Mettre à jour" (Update) button
  // Since the GPT is already published, the button should say "Mettre à jour"
  const allBtns = await page.locator('button:visible').all();
  console.log('All visible buttons:');
  for (const btn of allBtns) {
    const text = (await btn.innerText().catch(() => '')).trim();
    const box = await btn.boundingBox().catch(() => null);
    if (text && box) {
      console.log(`  "${text.substring(0, 40)}" at x=${Math.round(box.x)} y=${Math.round(box.y)}`);
    }
  }

  // Click the top-right button (Mettre à jour / Update)
  const updateBtn = page.locator('button').filter({ hasText: /Mettre à jour|Update/i }).first();
  if (await updateBtn.isVisible().catch(() => false)) {
    await updateBtn.click();
    console.log('Clicked Mettre à jour');
    await delay(8000);
  } else {
    // Fallback: find button in top-right area
    for (const btn of allBtns) {
      const box = await btn.boundingBox().catch(() => null);
      const text = (await btn.innerText().catch(() => '')).trim();
      if (box && box.x > 1100 && box.y < 60 && text) {
        console.log(`Clicking top-right: "${text}"`);
        await btn.click();
        await delay(8000);
        break;
      }
    }
  }

  // Handle confirmation dialog
  await delay(2000);
  const confirmBtn = page.locator('button').filter({ hasText: /Enregistrer|Confirm|Mettre à jour|Update|Save/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    console.log('Confirmed');
    await delay(5000);
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'upload-kb-2-done.png') });
  console.log('Done!');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
