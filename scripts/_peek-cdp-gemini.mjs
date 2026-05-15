// Peek at the open Gemini tab in CDP Chrome — screenshot + extract latest message text
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data/tmp/gv-direct/honey-glazed-ham');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 5000 });
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('open pages:');
pages.forEach((p, i) => console.log(' ', i, p.url()));

const gem = pages.find(p => p.url().includes('gemini.google.com'));
if (!gem) { console.log('no gemini tab open'); process.exit(); }
await gem.bringToFront();
await gem.waitForTimeout(1000);

const sshot = join(OUT, 'gemini-state.png');
await gem.screenshot({ path: sshot, fullPage: true });
console.log('screenshot →', sshot);

const text = await gem.evaluate(() => {
  const sels = ['model-response', '.response-container', 'message-content', '.markdown'];
  let last = null;
  for (const sel of sels) {
    const c = document.querySelectorAll(sel);
    if (c.length > 0) { last = c[c.length - 1]; break; }
  }
  return last ? (last.innerText || last.textContent || '').slice(0, 1500) : '(no model-response found)';
});
console.log('--- LATEST MODEL RESPONSE TEXT (1500 chars) ---');
console.log(text);
console.log('--- END ---');
writeFileSync(join(OUT, 'gemini-state-text.txt'), text);

await browser.close();
