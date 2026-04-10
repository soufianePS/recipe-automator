/**
 * Debug script — navigate to GPT editor and screenshot everything
 */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');

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

  // Step 1: Go to chatgpt.com and check login
  console.log('1. Going to chatgpt.com...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  await delay(5000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-1-home.png'), fullPage: true });
  console.log('   URL:', page.url());

  // Step 2: Go to GPTs mine page
  console.log('2. Going to /gpts/mine...');
  await page.goto('https://chatgpt.com/gpts/mine', { waitUntil: 'domcontentloaded' });
  await delay(5000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-2-gpts-mine.png'), fullPage: true });
  console.log('   URL:', page.url());

  // Step 3: Go to GPT editor
  console.log('3. Going to /gpts/editor...');
  await page.goto('https://chatgpt.com/gpts/editor', { waitUntil: 'domcontentloaded' });
  await delay(8000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-3-editor.png'), fullPage: true });
  console.log('   URL:', page.url());

  // Log page content
  const html = await page.content();
  const title = await page.title();
  console.log('   Title:', title);

  // Find all interactive elements
  const elements = await page.evaluate(() => {
    const results = [];
    // Inputs
    document.querySelectorAll('input').forEach(el => {
      results.push({ tag: 'input', type: el.type, placeholder: el.placeholder, name: el.name, visible: el.offsetParent !== null });
    });
    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
      results.push({ tag: 'textarea', placeholder: el.placeholder, name: el.name, visible: el.offsetParent !== null, rows: el.rows });
    });
    // Buttons
    document.querySelectorAll('button').forEach(el => {
      if (el.innerText.trim()) {
        results.push({ tag: 'button', text: el.innerText.trim().substring(0, 50), visible: el.offsetParent !== null });
      }
    });
    // Tabs
    document.querySelectorAll('[role="tab"]').forEach(el => {
      results.push({ tag: 'tab', text: el.innerText.trim(), selected: el.getAttribute('aria-selected') });
    });
    return results;
  });

  console.log('\n   Interactive elements:');
  elements.forEach(el => console.log('   ', JSON.stringify(el)));

  // Check if there's an iframe
  const frames = page.frames();
  console.log(`\n   Frames: ${frames.length}`);
  frames.forEach((f, i) => console.log(`   Frame ${i}: ${f.url()}`));

  await delay(2000);

  // Step 4: Try clicking "Create a GPT" or similar button
  console.log('\n4. Looking for Create button...');
  const createBtns = await page.locator('a, button').filter({ hasText: /create|créer|new|nouveau/i }).all();
  for (const btn of createBtns) {
    const text = await btn.innerText().catch(() => '');
    const visible = await btn.isVisible().catch(() => false);
    console.log(`   Found: "${text.trim().substring(0, 50)}" visible=${visible}`);
  }

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-4-final.png'), fullPage: true });

  console.log('\nDone. Check screenshots/ folder.');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
