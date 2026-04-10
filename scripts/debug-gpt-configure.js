/**
 * Debug: click Configure tab and explore the form
 */
import { chromium } from 'playwright';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'recipe-automator-profile');
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

  console.log('Going to GPT editor...');
  await page.goto('https://chatgpt.com/gpts/editor', { waitUntil: 'domcontentloaded' });
  await delay(6000);

  // Click "Configurer" tab
  console.log('Clicking Configurer tab...');
  const configTab = page.locator('button').filter({ hasText: /Configurer|Configure/i }).first();
  await configTab.click();
  await delay(3000);

  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-configure-1.png'), fullPage: true });
  console.log('Screenshot taken after clicking Configurer');

  // Scroll down to see more
  await page.evaluate(() => {
    const scrollable = document.querySelector('[class*="overflow-auto"], [class*="scroll"]') || document.documentElement;
    scrollable.scrollTop = scrollable.scrollHeight;
  });
  await delay(1000);
  await page.screenshot({ path: join(__dirname, '..', 'screenshots', 'debug-configure-2-scrolled.png'), fullPage: true });

  // Find all form elements
  const elements = await page.evaluate(() => {
    const results = [];
    // Inputs (not file)
    document.querySelectorAll('input:not([type="file"])').forEach(el => {
      results.push({
        tag: 'input', type: el.type, placeholder: el.placeholder,
        name: el.name, id: el.id, value: el.value.substring(0, 30),
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect()
      });
    });
    // Textareas
    document.querySelectorAll('textarea').forEach(el => {
      results.push({
        tag: 'textarea', placeholder: el.placeholder.substring(0, 60),
        name: el.name, id: el.id, rows: el.rows,
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect()
      });
    });
    // Labels
    document.querySelectorAll('label').forEach(el => {
      results.push({
        tag: 'label', text: el.innerText.trim().substring(0, 50),
        for: el.htmlFor,
        visible: el.offsetParent !== null
      });
    });
    // Contenteditable divs
    document.querySelectorAll('[contenteditable="true"]').forEach(el => {
      results.push({
        tag: 'contenteditable', text: el.innerText.trim().substring(0, 50),
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect()
      });
    });
    return results;
  });

  console.log('\nForm elements:');
  elements.forEach(el => console.log(JSON.stringify(el)));

  // Also look for specific sections
  const sections = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('h2, h3, h4, [class*="label"], [class*="title"]').forEach(el => {
      if (el.innerText.trim() && el.offsetParent !== null) {
        results.push({ tag: el.tagName, text: el.innerText.trim().substring(0, 60) });
      }
    });
    return results;
  });
  console.log('\nSection headers/labels:');
  sections.forEach(s => console.log(JSON.stringify(s)));

  console.log('\nDone.');
  await context.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
