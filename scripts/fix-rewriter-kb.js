/**
 * Fix Recipe Rewriter GPT:
 * 1. Strip header from instructions
 * 2. Upload missing knowledge file
 */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');
const KNOWLEDGE_FILE = join(__dirname, '..', 'docs', 'gpt-intro-templates.md');
const REWRITER_EDITOR_URL = 'https://chatgpt.com/gpts/editor/g-69c1110d4f048191ac6a4b32b9039eb7';

// Read instruction file — strip everything before (and including) the --- separator
function readDoc(name) {
  const content = readFileSync(join(__dirname, '..', 'docs', name), 'utf-8');
  const idx = content.indexOf('---');
  if (idx !== -1) {
    return content.substring(idx + 3).trim();
  }
  return content.trim();
}

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // Clear crash state
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
    console.log('Clicked Configurer tab');
    await delay(3000);
  }

  // Step 1: Fix instructions — clear and re-fill with stripped version
  const instructions = readDoc('gpt-instructions-rewrite.md');
  console.log(`Instructions (first 80 chars): ${instructions.substring(0, 80)}...`);

  const instrInput = page.locator('textarea[placeholder*="Que fait ce GPT"], textarea[placeholder*="What does this GPT"]').first();
  if (await instrInput.isVisible().catch(() => false)) {
    await instrInput.fill('');
    await delay(300);
    await instrInput.fill(instructions);
    console.log(`Instructions updated (${instructions.length} chars)`);
  } else {
    // Fallback: find the visible textarea that's not the chat input
    const allTextareas = await page.locator('textarea:visible').all();
    for (const ta of allTextareas) {
      const placeholder = await ta.getAttribute('placeholder') || '';
      if (!placeholder.includes('Poser une question') && !placeholder.includes('Ask')) {
        await ta.fill('');
        await delay(300);
        await ta.fill(instructions);
        console.log('Instructions updated (via fallback textarea)');
        break;
      }
    }
  }

  // Step 2: Scroll down to knowledge base section
  await page.evaluate(() => {
    const panels = document.querySelectorAll('.overflow-y-auto, [class*="overflow"]');
    panels.forEach(p => p.scrollTop = p.scrollHeight);
  });
  await delay(1000);

  // Check if file is actually uploaded (look for the file chip, not text in instructions)
  const fileChip = page.locator('[class*="file"], [class*="chip"], [class*="attachment"]').filter({ hasText: /gpt-intro-templates/i });
  const hasFileChip = await fileChip.isVisible().catch(() => false);
  console.log(`Knowledge file already uploaded: ${hasFileChip}`);

  if (!hasFileChip) {
    console.log('Uploading knowledge file...');
    const uploadBtn = page.locator('button').filter({ hasText: /Charger les fichiers|Upload files/i }).first();
    if (await uploadBtn.isVisible().catch(() => false)) {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15000 }),
        uploadBtn.click()
      ]);
      await fileChooser.setFiles(KNOWLEDGE_FILE);
      console.log('File selected, waiting for upload...');
      await delay(10000);

      // Verify upload appeared
      await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'fix-rewriter-after-upload.png') });
    }
  }

  // Step 3: Save — click the top-right button
  // Scroll back up
  await page.evaluate(() => window.scrollTo(0, 0));
  await delay(500);

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'fix-rewriter-before-save.png') });

  // The save button could say "Enregistrer", "Mettre à jour", or still "Créer"
  // It's the button in the top-right corner
  const saveBtns = await page.locator('button').filter({ hasText: /Enregistrer|Mettre à jour|Update|Save|Créer|Create/i }).all();
  console.log(`Found ${saveBtns.length} save-like buttons:`);
  for (const btn of saveBtns) {
    const text = await btn.innerText().catch(() => '');
    const visible = await btn.isVisible().catch(() => false);
    console.log(`  "${text.trim()}" visible=${visible}`);
  }

  // Click the last visible one (typically the top-right save button)
  for (let i = saveBtns.length - 1; i >= 0; i--) {
    if (await saveBtns[i].isVisible().catch(() => false)) {
      await saveBtns[i].click();
      console.log('Clicked save button');
      break;
    }
  }
  await delay(8000);

  // Handle confirmation dialog
  const confirmBtn = page.locator('button').filter({ hasText: /Confirmer|Confirm|Mettre à jour|Update/i }).first();
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click();
    console.log('Confirmed');
    await delay(5000);
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'fix-rewriter-done.png') });
  console.log('Done!');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
