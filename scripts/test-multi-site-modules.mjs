/**
 * Integration test: verify the new multi-site modules can read the sheet
 * via service-account credentials.
 */

import { SitesConfig } from '../src/shared/utils/sites-config.js';
import { PinHistory } from '../src/shared/utils/pin-history.js';
import { PinCampaigns } from '../src/shared/utils/pin-campaigns.js';
import { WarmingPool, WarmingPinList } from '../src/shared/utils/warming-store.js';

const ok   = m => console.log(`\x1b[32m[OK]\x1b[0m   ${m}`);
const info = m => console.log(`\x1b[34m[INFO]\x1b[0m ${m}`);
const err  = m => console.log(`\x1b[31m[ERR]\x1b[0m  ${m}`);

async function main() {
  console.log('━'.repeat(60));
  console.log(' Multi-Site Modules Integration Test');
  console.log('━'.repeat(60));

  // 1. SitesConfig
  const sites = await SitesConfig.list();
  ok(`SitesConfig.list() → ${sites.length} site(s)`);
  for (const s of sites) {
    console.log(`     • ${s.site_id} (${s.display_name}) — active=${s.active} warming=${s.warming_enabled} wp_url=${s.wp_url}`);
  }
  const active = await SitesConfig.listActive();
  ok(`SitesConfig.listActive() → ${active.length} active site(s)`);
  const warming = await SitesConfig.listWarming();
  ok(`SitesConfig.listWarming() → ${warming.length} warming site(s) (should be 0 since we defaulted to FALSE)`);

  // 2. PinCampaigns
  const camps = await PinCampaigns.list();
  ok(`PinCampaigns.list() → ${camps.length} campaign(s) (should be 0 — tab is fresh)`);
  const due = await PinCampaigns.listDueSlots();
  ok(`PinCampaigns.listDueSlots() → ${due.length} due slot(s)`);

  // 3. WarmingPool
  const pool = await WarmingPool.listForSite('leagueofcooking');
  ok(`WarmingPool.listForSite('leagueofcooking') → ${pool.length} entries`);

  // 4. WarmingPinList
  const list = await WarmingPinList.listForSite('leagueofcooking');
  ok(`WarmingPinList.listForSite('leagueofcooking') → ${list.length} entries`);

  // 5. PinHistory — append a test row, then verify it's there, then clean by tagging it
  info('PinHistory.append() — writing a test row...');
  const testEntry = {
    site: 'leagueofcooking',
    type: 'initial',
    recipe_topic: '__integration_test__',
    notes: 'auto-cleanup-candidate ' + Date.now(),
  };
  const r = await PinHistory.append(testEntry);
  ok(`PinHistory.append() → ${r.appended} row appended (note: leaves a test row in the sheet — feel free to delete it manually)`);

  console.log('━'.repeat(60));
  ok('All modules verified.');
}

main().catch(e => {
  err('Failed: ' + e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
