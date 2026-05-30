/**
 * Account aging — auto-progress Pinterest accounts through warmup tiers.
 *
 * Runs once a day (driven by planifier.js's daily tick). For each account
 * across all sites:
 *   - skip if autoProgress === false (manual control)
 *   - skip if createdAt is null (no age data)
 *   - skip if status is 'active' or 'disabled' (nothing to promote)
 *   - compute daysSince(createdAt) and check against PROGRESSION_THRESHOLDS_DAYS
 *   - if eligible: update account.status to NEXT_STATUS[current], log,
 *     send Telegram notif if configured
 *
 * Promotions persist to data/planifier/config.json via Planifier.saveConfig().
 *
 * Conservative: if a brand-new account has no createdAt, we DO NOT auto-set
 * it to today (might mask a problem). The user must either set createdAt
 * manually or toggle autoProgress=false.
 */

import { Logger } from '../../shared/utils/logger.js';
import { sendTelegram } from '../../shared/utils/telegram-notifier.js';
import { PROGRESSION_THRESHOLDS_DAYS, NEXT_STATUS } from './default-config.js';

function _daysBetween(isoOrDate, now = new Date()) {
  if (!isoOrDate) return null;
  const then = new Date(isoOrDate).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((now.getTime() - then) / (24 * 3600 * 1000));
}

/**
 * Run the aging pass.
 * @param {Object} config — loaded planifier config (mutated in place)
 * @returns {Promise<Array<{site,accountId,from,to,daysOld}>>} list of promotions applied
 */
export async function applyAging(config) {
  if (!config?.sites) return [];
  const promotions = [];
  const now = new Date();

  for (const [siteName, site] of Object.entries(config.sites)) {
    const accounts = site.pinterestAccounts || [];
    for (const acc of accounts) {
      if (!acc.autoProgress) continue;
      if (!acc.createdAt) continue;
      const next = NEXT_STATUS[acc.status];
      if (!next) continue;  // 'active', 'disabled', unknown → no progression
      const threshold = PROGRESSION_THRESHOLDS_DAYS[acc.status];
      if (threshold == null) continue;
      const days = _daysBetween(acc.createdAt, now);
      if (days == null || days < threshold) continue;

      const from = acc.status;
      acc.status = next;
      promotions.push({ site: siteName, accountId: acc.id, from, to: next, daysOld: days });
      Logger.info(`[Aging] ${siteName}/${acc.id}: ${from} → ${next} (account is ${days}d old)`);
    }
  }
  return promotions;
}

/**
 * Build a Telegram message for a batch of promotions, send via sendTelegram.
 * No-op if Telegram not configured.
 */
export async function notifyPromotions(config, promotions) {
  if (!promotions || promotions.length === 0) return;
  const tg = config.notifications?.telegram;
  if (!tg?.enabled || !tg?.botToken || !tg?.chatId) return;
  const lines = promotions.map(p =>
    `• <b>${p.site}/${p.accountId}</b>: ${p.from} → <b>${p.to}</b> (${p.daysOld}d old)`
  );
  const msg = `🌱 <b>Pinterest accounts promoted</b>\n${lines.join('\n')}`;
  try { await sendTelegram(tg, msg); }
  catch (e) { Logger.warn(`[Aging] Telegram notif failed: ${e.message}`); }
}
