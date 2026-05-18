// Sanity-check Dolphin{anty} API connection.
// Run: node scripts/test-dolphin.mjs
//
// Validates:
//   1. Cloud API auth works (lists profiles)
//   2. Local API is reachable (Dolphin app must be open on this machine)
//   3. Local login-with-token succeeds
//
// Does NOT start any profile by default. Pass --start <id> to also test
// starting a profile and print the CDP port.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DolphinAnty } from '../src/shared/utils/dolphin-anty.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const startId = args[args.indexOf('--start') + 1] && args.includes('--start') ? args[args.indexOf('--start') + 1] : null;

async function main() {
  const activeSite = readFileSync(join(ROOT, 'data', 'active-site.txt'), 'utf8').trim();
  const settings = JSON.parse(readFileSync(join(ROOT, 'data', 'sites', activeSite, 'settings.json'), 'utf8'));
  const dolphin = new DolphinAnty(settings);

  console.log('[test] Dolphin client initialized');
  console.log('  cloud:', dolphin.cloudBase);
  console.log('  local:', dolphin.localBase);
  console.log('  token: ***' + dolphin.token.slice(-12));

  // ── 1. Cloud API: list profiles ────────────────────────────
  console.log('\n[test] Cloud API: listProfiles()...');
  try {
    const profiles = await dolphin.listProfiles({ limit: 50 });
    console.log(`✓ ${profiles.length} profile(s) found:`);
    profiles.forEach((p, i) => {
      console.log(`  ${i + 1}. id=${p.id || p.uuid || '?'}  name="${p.name || '(no name)'}"  platform=${p.platform || '?'}  status=${p.status || '?'}`);
    });
    if (!profiles.length) {
      console.log('  ⚠ No profiles. Create one in the Dolphin app first.');
    }
  } catch (e) {
    console.log(`✗ Cloud API failed: ${e.message}`);
    console.log('  → Check that the JWT token is valid (regenerate at https://dolphin-anty.com/panel/index.html#/api)');
    process.exit(1);
  }

  // ── 2. Local API: ping ─────────────────────────────────────
  console.log('\n[test] Local API: login-with-token...');
  try {
    const r = await dolphin.loginLocal();
    console.log('✓ Local API responded:', JSON.stringify(r).slice(0, 200));
  } catch (e) {
    console.log(`✗ Local API failed: ${e.message}`);
    console.log('  → Make sure the Dolphin Anty desktop app is OPEN on this machine.');
    console.log('  → Confirm the local API port (default 3001).');
    process.exit(1);
  }

  // ── 3. Optional: start a profile ───────────────────────────
  if (startId) {
    console.log(`\n[test] Local API: starting profile ${startId}...`);
    try {
      const { port, wsEndpoint, raw } = await dolphin.startAndGetCDP(startId);
      console.log('✓ Profile started');
      console.log('  CDP port:    ', port);
      console.log('  ws endpoint: ', wsEndpoint || '(not provided)');
      console.log('  full response:', JSON.stringify(raw).slice(0, 400));
      console.log('\n  → Playwright can connect via:');
      if (port) console.log(`     await chromium.connectOverCDP('http://localhost:${port}')`);
      if (wsEndpoint) console.log(`     await chromium.connectOverCDP('${wsEndpoint}')`);

      console.log('\n[test] stopping profile in 5s...');
      await new Promise(r => setTimeout(r, 5000));
      await dolphin.stopProfile(startId);
      console.log('✓ Stopped');
    } catch (e) {
      console.log(`✗ Start failed: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.log('\n[test] (skip --start: pass `--start <profile-id>` to also test launching)');
  }

  console.log('\n[test] ✓ All checks passed');
}

main().catch(e => { console.error('[test] fatal:', e); process.exit(1); });
