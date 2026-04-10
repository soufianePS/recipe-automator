/**
 * History — simple job history tracker
 *
 * Persists a log of completed/failed jobs to data/history.json.
 * Used by the dashboard to show recent activity and statistics.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getSiteDataDir } from './state-manager.js';

function getHistoryFile() {
  return join(getSiteDataDir(), 'history.json');
}

export const History = {
  async getAll() {
    try {
      const data = await readFile(getHistoryFile(), 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  },

  async add(entry) {
    const history = await this.getAll();
    history.unshift({
      id: Date.now(),
      date: new Date().toISOString(),
      ...entry
    });
    // Keep last 500 entries
    if (history.length > 500) history.length = 500;
    await writeFile(getHistoryFile(), JSON.stringify(history, null, 2));
  },

  async getStats() {
    const history = await this.getAll();
    const today = new Date().toISOString().split('T')[0];
    return {
      total: history.length,
      success: history.filter(h => h.status === 'success').length,
      errors: history.filter(h => h.status === 'error').length,
      today: history.filter(h => h.date?.startsWith(today)).length,
      byModule: {
        generator: history.filter(h => h.module === 'generator').length,
        scraper: history.filter(h => h.module === 'scraper').length,
      },
      recent: history.slice(0, 20)
    };
  }
};
