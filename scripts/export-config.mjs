/**
 * export-config.mjs — bundle the essential (secret) config files for moving
 * to another PC. These files are git-ignored on purpose (they hold the Google
 * service-account key + Dolphin/Telegram tokens), so they must be transferred
 * by hand (USB / private message), NEVER pushed to git.
 *
 * Usage:
 *   node scripts/export-config.mjs
 *
 * Produces:  config-bundle/  with the 3 essential files, ready to copy to the
 * same paths on the other machine (recipe-automator/data/...).
 */

import { mkdirSync, copyFileSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'config-bundle');

// Relative paths preserved so the other PC drops them at the same spot.
const FILES = [
  'data/google-credentials.json',          // → Multi-Site (Google Sheet access)
  'data/planifier/config.json',            // → Dolphin token + Telegram + Planifier config
];

// Include EVERY site's settings.json (each one resolves that site's sheet tab +
// WP credentials). Missing even one means that site reads the wrong tab on the
// other PC → wrong recipe counts / 401s.
import { readdirSync } from 'fs';
try {
  for (const site of readdirSync(join(ROOT, 'data', 'sites'))) {
    const rel = `data/sites/${site}/settings.json`;
    if (existsSync(join(ROOT, rel))) FILES.push(rel);
  }
} catch {}

let copied = 0;
const missing = [];

for (const rel of FILES) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) { missing.push(rel); continue; }
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log('  ✓', rel);
  copied++;
}

const readme = [
  'CONFIG BUNDLE — transfer by hand only (USB / private message). NEVER push to git.',
  '',
  'On the OTHER PC, copy each file to the SAME path inside recipe-automator/:',
  ...FILES.map(f => `  - ${f}`),
  '',
  'Then restart the server (npm start) and refresh the dashboard.',
  '',
  'Verify: open data/planifier/config.json — you should see "apiToken": "eyJ...".',
].join('\n');
writeFileSync(join(OUT, 'README.txt'), readme, 'utf8');

console.log(`\nBundle written to: ${OUT}`);
console.log(`Copied ${copied} file(s).`);
if (missing.length) {
  console.log('\n⚠ MISSING on this PC (skipped):');
  for (const m of missing) console.log('  -', m);
}
console.log('\nNext: zip the config-bundle/ folder and send it privately. Do NOT commit it.');
