/**
 * Planifier persistence layer.
 *
 * All planifier data lives under `data/planifier/` (global, not per-site —
 * the planifier orchestrates across all sites by design):
 *
 *   data/planifier/
 *   ├── config.json                ← global config (rules + sites + accounts)
 *   ├── plans/YYYY-MM-DD.json      ← one file per day
 *   └── history.json               ← rolling exec log
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PLANIFIER_DEFAULTS } from './default-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const PLANIFIER_DIR = join(PROJECT_ROOT, 'data', 'planifier');
const PLANS_DIR = join(PLANIFIER_DIR, 'plans');
const CONFIG_PATH = join(PLANIFIER_DIR, 'config.json');
const HISTORY_PATH = join(PLANIFIER_DIR, 'history.json');

async function ensureDirs() {
  if (!existsSync(PLANS_DIR)) await mkdir(PLANS_DIR, { recursive: true });
}

function dateKey(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function planPath(date) {
  return join(PLANS_DIR, `${dateKey(date)}.json`);
}

// ── Config ────────────────────────────────────────────────────

export async function loadConfig() {
  await ensureDirs();
  if (!existsSync(CONFIG_PATH)) {
    const fresh = structuredClone(PLANIFIER_DEFAULTS);
    delete fresh.sites._template;
    fresh.sites = {};
    await writeFile(CONFIG_PATH, JSON.stringify(fresh, null, 2), 'utf8');
    return fresh;
  }
  return JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
}

export async function saveConfig(config) {
  await ensureDirs();
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Ensure a site has a config entry. Returns the (possibly newly created)
 * site config. Does NOT persist — caller must call saveConfig if mutated.
 */
export function ensureSiteConfig(config, siteName) {
  if (!config.sites) config.sites = {};
  if (!config.sites[siteName]) {
    const template = PLANIFIER_DEFAULTS.sites._template;
    config.sites[siteName] = structuredClone(template);
  }
  return config.sites[siteName];
}

// ── Plans (per-day) ───────────────────────────────────────────

export async function loadPlan(date) {
  await ensureDirs();
  const path = planPath(date);
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function savePlan(date, plan) {
  await ensureDirs();
  await writeFile(planPath(date), JSON.stringify(plan, null, 2), 'utf8');
}

export async function listPlanDates() {
  await ensureDirs();
  try {
    const files = await readdir(PLANS_DIR);
    return files
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch {
    return [];
  }
}

export async function deletePlan(date) {
  const path = planPath(date);
  if (existsSync(path)) {
    const { unlink } = await import('fs/promises');
    await unlink(path);
  }
}

// ── History (exec log) ────────────────────────────────────────

export async function loadHistory() {
  await ensureDirs();
  if (!existsSync(HISTORY_PATH)) {
    return { version: 1, items: [] };
  }
  try {
    return JSON.parse(await readFile(HISTORY_PATH, 'utf8'));
  } catch {
    return { version: 1, items: [] };
  }
}

export async function appendHistory(entry) {
  const hist = await loadHistory();
  hist.items.push({ ...entry, loggedAt: new Date().toISOString() });
  // Cap at 5000 entries to prevent unbounded growth — older logs drop off
  if (hist.items.length > 5000) hist.items = hist.items.slice(-5000);
  await writeFile(HISTORY_PATH, JSON.stringify(hist, null, 2), 'utf8');
}

export async function clearHistory() {
  await writeFile(HISTORY_PATH, JSON.stringify({ version: 1, items: [] }, null, 2), 'utf8');
}

// ── UI state (per-dashboard preferences, filters, etc.) ─────────

const UI_STATE_PATH = join(PLANIFIER_DIR, 'ui-state.json');

export async function loadUiState() {
  await ensureDirs();
  if (!existsSync(UI_STATE_PATH)) {
    return { version: 1 };
  }
  try {
    return JSON.parse(await readFile(UI_STATE_PATH, 'utf8'));
  } catch {
    return { version: 1 };
  }
}

export async function saveUiState(state) {
  await ensureDirs();
  await writeFile(UI_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Merge a partial UI state update into the existing one and persist.
 * Each top-level key is replaced wholesale (no deep merge).
 */
export async function patchUiState(patch) {
  const current = await loadUiState();
  const updated = { ...current, ...patch };
  await saveUiState(updated);
  return updated;
}
