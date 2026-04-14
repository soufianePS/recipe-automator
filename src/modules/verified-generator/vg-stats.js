/**
 * VG Stats — tracks detailed verification statistics per recipe.
 * Stored in data/sites/{site}/vg-stats.json
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getSiteDataDir } from '../../shared/utils/state-manager.js';

function getStatsFile() {
  return join(getSiteDataDir(), 'vg-stats.json');
}

// In-memory tracker for current recipe
let _current = null;

export const VGStats = {

  /** Start tracking a new recipe */
  startRecipe(title) {
    _current = {
      title,
      startedAt: Date.now(),
      chatgptStarted: null,
      chatgptFinished: null,
      chatgptDuration: null,
      visualSteps: 0,
      images: [],
      totalFlowTime: 0,
      totalGeminiCalls: 0,
      geminiPasses: 0,
      geminiFails: 0,
      geminiSkipped: 0,
      retries: 0,
      similarityChecks: 0,
      similarityFails: 0,
      modelUsed: {},
      pinsGenerated: 0,
      pinsVerified: 0,
      status: 'running',
      error: null,
      draftUrl: null,
      finishedAt: null,
      totalDuration: null
    };
  },

  /** Track ChatGPT timing */
  chatgptStart() { if (_current) _current.chatgptStarted = Date.now(); },
  chatgptEnd(steps) {
    if (!_current) return;
    _current.chatgptFinished = Date.now();
    _current.chatgptDuration = _current.chatgptFinished - _current.chatgptStarted;
    _current.visualSteps = steps || 0;
  },

  /** Track an image generation + verification */
  trackImage(info) {
    if (!_current) return;
    const entry = {
      type: info.type, // 'ingredients', 'step', 'hero', 'pin'
      stepNumber: info.stepNumber || null,
      title: info.title || '',
      flowStarted: info.flowStarted || Date.now(),
      flowDuration: info.flowDuration || 0,
      downloadMethod: info.downloadMethod || 'unknown', // 'sniffer', 'new-src', 'canvas', 'filter'
      fileSizeKB: info.fileSizeKB || 0,
      geminiStatus: info.geminiStatus || 'skipped', // 'PASS', 'HARD_FAIL', 'SOFT_FAIL', 'skipped'
      geminiModel: info.geminiModel || '',
      geminiDetectedItems: info.geminiDetectedItems || [],
      geminiForbiddenFound: info.geminiForbiddenFound || [],
      geminiIssues: info.issues || [],
      retries: info.retries || 0,
      similarityScore: info.similarityScore || null,
      similarityVerdict: info.similarityVerdict || null,
    };
    _current.images.push(entry);
    _current.totalFlowTime += entry.flowDuration;
    _current.totalGeminiCalls++;
    if (entry.geminiStatus === 'PASS') _current.geminiPasses++;
    else if (entry.geminiStatus === 'skipped') _current.geminiSkipped++;
    else _current.geminiFails++;
    if (entry.retries > 0) _current.retries += entry.retries;
    if (entry.similarityScore !== null) _current.similarityChecks++;
    if (entry.similarityVerdict === 'TOO_SIMILAR') _current.similarityFails++;
    if (entry.type === 'pin') _current.pinsGenerated++;
  },

  /** Mark recipe complete */
  async complete(draftUrl) {
    if (!_current) return;
    _current.status = 'success';
    _current.draftUrl = draftUrl || null;
    _current.finishedAt = Date.now();
    _current.totalDuration = _current.finishedAt - _current.startedAt;
    await this._save(_current);
    _current = null;
  },

  /** Mark recipe failed */
  async fail(error) {
    if (!_current) return;
    _current.status = 'error';
    _current.error = error || 'Unknown error';
    _current.finishedAt = Date.now();
    _current.totalDuration = _current.finishedAt - _current.startedAt;
    await this._save(_current);
    _current = null;
  },

  /** Get current recipe tracking data */
  getCurrent() { return _current; },

  /** Get all VG stats */
  async getAll() {
    try {
      const data = await readFile(getStatsFile(), 'utf-8');
      const parsed = JSON.parse(data);
      // Ensure it's always an array (file might be corrupted as {})
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  },

  /** Get summary statistics */
  async getSummary() {
    const all = await this.getAll();
    const success = all.filter(r => r.status === 'success');
    const failed = all.filter(r => r.status === 'error');
    const today = new Date().toISOString().split('T')[0];
    const todayRecipes = all.filter(r => r.startedAt && new Date(r.startedAt).toISOString().startsWith(today));

    const totalImages = success.reduce((s, r) => s + (r.images?.length || 0), 0);
    const totalPasses = success.reduce((s, r) => s + (r.geminiPasses || 0), 0);
    const totalFails = success.reduce((s, r) => s + (r.geminiFails || 0), 0);
    const totalSkipped = success.reduce((s, r) => s + (r.geminiSkipped || 0), 0);
    const totalRetries = success.reduce((s, r) => s + (r.retries || 0), 0);
    const avgDuration = success.length > 0
      ? Math.round(success.reduce((s, r) => s + (r.totalDuration || 0), 0) / success.length / 1000)
      : 0;
    const avgChatgpt = success.length > 0
      ? Math.round(success.reduce((s, r) => s + (r.chatgptDuration || 0), 0) / success.length / 1000)
      : 0;

    return {
      total: all.length,
      success: success.length,
      failed: failed.length,
      today: todayRecipes.length,
      totalImages,
      geminiPasses: totalPasses,
      geminiFails: totalFails,
      geminiSkipped: totalSkipped,
      totalRetries,
      avgDurationSec: avgDuration,
      avgChatgptSec: avgChatgpt,
      passRate: totalImages > 0 ? Math.round((totalPasses / (totalPasses + totalFails)) * 100) : 0,
      recent: all.slice(0, 20)
    };
  },

  /** Save a recipe entry */
  async _save(entry) {
    try {
      const all = await this.getAll();
      all.unshift(entry);
      if (all.length > 200) all.length = 200;
      await writeFile(getStatsFile(), JSON.stringify(all, null, 2));
    } catch (e) {
      // Don't crash the batch if stats can't be saved
      console.error('[VGStats] Save failed:', e.message);
    }
  }
};
