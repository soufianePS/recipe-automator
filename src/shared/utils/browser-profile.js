/**
 * Launch a Chromium persistent-context profile, auto-recovering from a
 * stale Chrome singleton lock.
 *
 * Symptom this fixes: `browserType.launchPersistentContext: Target page,
 * context or browser has been closed`, with the browser log line
 * "Ouverture dans une session de navigateur existante" (or the English
 * equivalent "Opening in existing browser session"). Chrome writes
 * SingletonLock/SingletonSocket/SingletonCookie files into the profile
 * directory while running; if a previous run crashed or was killed instead
 * of shutting down cleanly, those files can survive and make Chrome believe
 * another instance already owns the profile. It then silently hands the
 * request to that (nonexistent, or uncontrollable) instance instead of
 * actually launching under Playwright's control, and the CDP connection
 * fails immediately.
 *
 * Removing just the Singleton* lock files is safe — they're an OS-level
 * "is anyone using this profile" marker, not part of the saved login/session
 * data (cookies, local storage, etc. are untouched).
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { Logger } from './logger.js';

const LOCK_FILES = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function clearStaleLocks(profilePath) {
  let removed = 0;
  for (const name of LOCK_FILES) {
    const p = join(profilePath, name);
    if (existsSync(p)) {
      try { rmSync(p, { force: true }); removed++; } catch {}
    }
  }
  return removed;
}

const STALE_LOCK_ERROR = /Target page, context or browser has been closed/i;

/**
 * @param {import('playwright').BrowserType} chromium
 * @param {string} profilePath
 * @param {object} launchOptions
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function launchPersistentContextWithRecovery(chromium, profilePath, launchOptions) {
  try {
    return await chromium.launchPersistentContext(profilePath, launchOptions);
  } catch (e) {
    if (!STALE_LOCK_ERROR.test(e.message || '')) throw e;
    const removed = clearStaleLocks(profilePath);
    if (removed === 0) throw e; // nothing to clean up — a different problem
    Logger.warn(`[BrowserProfile] launch failed on a stale lock in ${profilePath} — cleared ${removed} lock file(s), retrying once`);
    return await chromium.launchPersistentContext(profilePath, launchOptions);
  }
}
