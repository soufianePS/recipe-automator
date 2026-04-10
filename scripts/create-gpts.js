/**
 * create-gpts.js — Create 3 custom GPTs using the recipe-automator's browser profile
 *
 * Run: node scripts/create-gpts.js
 * Requires: server to be STOPPED first (profile can't be shared)
 */

import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');
const DOCS_DIR = join(__dirname, '..', 'docs');
const SETTINGS_FILE = join(__dirname, '..', 'data', 'settings.json');

// Read instruction files — strip header before ---
function readDoc(name) {
  const content = readFileSync(join(DOCS_DIR, name), 'utf-8');
  const parts = content.split('---');
  return parts.length > 2 ? parts.slice(2).join('---').trim() : content.trim();
}

const GPTS = [
  {
    name: 'Recipe Generator',
    description: 'Generates complete recipe JSON from a topic with SEO optimization and AI detection bypass.',
    instructions: readDoc('gpt-instructions-generator.md'),
    knowledgeFile: join(DOCS_DIR, 'gpt-intro-templates.md'),
    settingsKey: 'generatorGptUrl'
  },
  {
    name: 'Recipe Extractor',
    description: 'Extracts structured recipe data from HTML and images into JSON format.',
    instructions: readDoc('gpt-instructions-extraction.md'),
    knowledgeFile: null,
    settingsKey: 'extractionGptUrl'
  },
  {
    name: 'Recipe Rewriter',
    description: 'Rewrites recipe JSON for SEO, humanization, and AI detection bypass.',
    instructions: readDoc('gpt-instructions-rewrite.md'),
    knowledgeFile: join(DOCS_DIR, 'gpt-intro-templates.md'),
    settingsKey: 'rewriteGptUrl'
  }
];

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function createOneGPT(context, gpt, index) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Creating GPT ${index + 1}/3: ${gpt.name}`);
  console.log('='.repeat(60));

  const page = await context.newPage();

  try {
    // Navigate to GPT creation page
    await page.goto('https://chatgpt.com/gpts/editor', { waitUntil: 'domcontentloaded' });
    await delay(6000);

    // Click "Configurer" tab (French for Configure)
    const configureTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
    if (await configureTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await configureTab.click();
      console.log('Clicked Configurer tab');
      await delay(3000);
    } else {
      console.log('WARNING: Configurer tab not found');
    }

    await page.screenshot({ path: join(__dirname, '..', 'screenshots', `gpt-create-${index}-start.png`) });

    // Fill Name — placeholder: "Nommer votre GPT"
    const nameInput = page.locator('input[placeholder*="Nommer"], input[placeholder*="Name"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 10000 });
    await nameInput.fill(gpt.name);
    console.log(`Name set: ${gpt.name}`);
    await delay(500);

    // Fill Description — placeholder: "Ajouter une brève description"
    const descInput = page.locator('input[placeholder*="brève description"], input[placeholder*="description"]').first();
    if (await descInput.isVisible().catch(() => false)) {
      await descInput.fill(gpt.description);
      console.log('Description set');
      await delay(500);
    }

    // Fill Instructions — textarea with placeholder "Que fait ce GPT"
    const instrInput = page.locator('textarea[placeholder*="Que fait ce GPT"], textarea[placeholder*="What does this GPT"]').first();
    if (await instrInput.isVisible().catch(() => false)) {
      await instrInput.fill(gpt.instructions);
      console.log(`Instructions set (${gpt.instructions.length} chars)`);
      await delay(500);
    } else {
      // Fallback: find textarea by label "Instructions"
      const instrById = page.locator('textarea').filter({ has: page.locator('[id]') }).first();
      const allTextareas = await page.locator('textarea:visible').all();
      console.log(`Found ${allTextareas.length} visible textareas`);
      if (allTextareas.length > 0) {
        // The Instructions textarea is the visible one (not the chat "Poser une question")
        await allTextareas[0].fill(gpt.instructions);
        console.log('Instructions set (via first visible textarea)');
      }
    }

    // Upload knowledge file if needed
    if (gpt.knowledgeFile && existsSync(gpt.knowledgeFile)) {
      console.log('Uploading knowledge file...');

      // Scroll down to "Base de connaissances" section
      await page.evaluate(() => {
        const panel = document.querySelector('.overflow-y-auto') || document.querySelector('[class*="overflow"]');
        if (panel) panel.scrollTop = panel.scrollHeight;
      });
      await delay(1000);

      // Click "Charger les fichiers" (Upload files) button
      const uploadBtn = page.locator('button').filter({ hasText: /Charger les fichiers|Upload files/i }).first();
      if (await uploadBtn.isVisible().catch(() => false)) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 10000 }),
          uploadBtn.click()
        ]);
        await fileChooser.setFiles(gpt.knowledgeFile);
        console.log('Knowledge file uploaded');
        await delay(5000); // Wait for upload to complete
      } else {
        // Fallback: try using hidden file input
        const fileInputs = await page.locator('input[type="file"]').all();
        console.log(`Found ${fileInputs.length} file inputs`);
        // The knowledge file input is typically one of the visible file inputs
        for (const fi of fileInputs) {
          try {
            await fi.setInputFiles(gpt.knowledgeFile);
            console.log('Knowledge file uploaded (via file input)');
            await delay(5000);
            break;
          } catch (e) {
            continue;
          }
        }
      }
    }

    await page.screenshot({ path: join(__dirname, '..', 'screenshots', `gpt-create-${index}-filled.png`) });

    // Scroll back up to see the Create button
    await page.evaluate(() => window.scrollTo(0, 0));
    await delay(500);

    // Click "Créer" (Create) button — the green one in top-right
    // There are two "Créer" buttons; one is the tab, one is the save button
    // The save button is typically the last one or in the header area
    const createBtns = await page.locator('button').filter({ hasText: /^Créer$|^Create$/i }).all();
    console.log(`Found ${createBtns.length} Create/Créer buttons`);

    // Click the last one (the save button, not the tab)
    if (createBtns.length > 0) {
      const saveBtn = createBtns[createBtns.length - 1];
      await saveBtn.click();
      console.log('Clicked Créer/Create button');
      await delay(8000);
    } else {
      console.log('WARNING: Créer/Create button not found');
    }

    // Handle the confirmation dialog if it appears
    // ChatGPT shows a dialog asking "Only me" or "Everyone" etc
    await delay(2000);
    const confirmBtn = page.locator('button').filter({ hasText: /Confirmer|Confirm|Only me|Seulement moi|Enregistrer|Save/i }).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click();
      console.log('Clicked confirmation button');
      await delay(5000);
    }

    // Get the GPT URL
    await delay(3000);
    const currentUrl = page.url();
    console.log(`Current URL after save: ${currentUrl}`);

    let gptUrl = null;

    // If on editor page, extract GPT ID
    if (currentUrl.includes('/gpts/editor/')) {
      const gptId = currentUrl.split('/gpts/editor/')[1]?.split('?')[0];
      if (gptId) {
        gptUrl = `https://chatgpt.com/g/${gptId}`;
        console.log(`GPT URL: ${gptUrl}`);
      }
    }

    // Fallback: look for a link
    if (!gptUrl) {
      const viewLink = page.locator('a[href*="/g/g-"]').first();
      if (await viewLink.count() > 0) {
        gptUrl = await viewLink.getAttribute('href');
        if (gptUrl && !gptUrl.startsWith('http')) gptUrl = `https://chatgpt.com${gptUrl}`;
        console.log(`GPT URL (from link): ${gptUrl}`);
      }
    }

    await page.screenshot({ path: join(__dirname, '..', 'screenshots', `gpt-create-${index}-done.png`) });

    if (gptUrl) {
      console.log(`SUCCESS: ${gpt.name} created at ${gptUrl}`);
    } else {
      console.log(`WARNING: ${gpt.name} may have been created but URL not captured`);
    }

    await page.close();
    return gptUrl;

  } catch (err) {
    console.error(`ERROR creating ${gpt.name}:`, err.message);
    await page.screenshot({ path: join(__dirname, '..', 'screenshots', `gpt-create-${index}-error.png`) }).catch(() => {});
    await page.close();
    return null;
  }
}

async function main() {
  console.log('GPT Creator Script');
  console.log('Profile:', PROFILE_DIR);

  if (!existsSync(PROFILE_DIR)) {
    console.error('Browser profile not found! Run the server first to create it.');
    process.exit(1);
  }

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

  console.log('Browser launched');

  // Verify logged into ChatGPT
  const checkPage = await context.newPage();
  await checkPage.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  await delay(5000);
  const loggedIn = await checkPage.evaluate(() => {
    return !document.querySelector('button[data-testid="login-button"]');
  });
  await checkPage.close();

  if (!loggedIn) {
    console.error('Not logged into ChatGPT! Start the server and login first.');
    await context.close();
    process.exit(1);
  }

  console.log('ChatGPT session verified\n');

  // Create each GPT
  const urls = {};
  for (let i = 0; i < GPTS.length; i++) {
    const url = await createOneGPT(context, GPTS[i], i);
    if (url) {
      urls[GPTS[i].settingsKey] = url;
    }
    if (i < GPTS.length - 1) await delay(3000);
  }

  // Save URLs to settings.json
  if (Object.keys(urls).length > 0) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'));
      Object.assign(settings, urls);
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      console.log('\nGPT URLs saved to settings.json:');
      for (const [key, url] of Object.entries(urls)) {
        console.log(`  ${key}: ${url}`);
      }
    } catch (e) {
      console.error('Failed to save settings:', e.message);
      console.log('\nManually add these to settings.json:');
      for (const [key, url] of Object.entries(urls)) {
        console.log(`  "${key}": "${url}"`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Created ${Object.keys(urls).length}/3 GPTs`);
  console.log('='.repeat(60));
  console.log('\nDone! Closing browser...');
  await context.close();
  console.log('You can now restart the server with: npm start');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
