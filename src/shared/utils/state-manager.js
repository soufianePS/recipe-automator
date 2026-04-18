/**
 * State Manager — persistent state via JSON file (multi-site)
 * Each site gets its own directory under data/sites/{siteName}/
 */

import { readFile, writeFile, mkdir, rm, cp } from 'fs/promises';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, resolve, extname } from 'path';
import { fileURLToPath } from 'url';
import {
  RECIPE_PROMPT,
  BACKGROUND_PROMPT_PREFIX,
  HERO_PROMPT_PREFIX,
  HERO_PROMPT_SUFFIX,
  INGREDIENTS_PROMPT_PREFIX,
  STEPS_PROMPT_PREFIX
} from './prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const GLOBAL_FILE = join(DATA_DIR, 'global.json');
const ACTIVE_SITE_FILE = join(DATA_DIR, 'active-site.txt');
const SITES_DIR = join(DATA_DIR, 'sites');

// In-memory cache for active site name
let _activeSiteCache = null;

export const STATES = {
  IDLE: 'IDLE',
  LOADING_JOB: 'LOADING_JOB',
  SELECTING_BACKGROUND: 'SELECTING_BACKGROUND',
  GENERATING_RECIPE_JSON: 'GENERATING_RECIPE_JSON',
  CREATING_FOLDERS: 'CREATING_FOLDERS',
  GENERATING_HERO: 'GENERATING_HERO',
  GENERATING_INGREDIENTS: 'GENERATING_INGREDIENTS',
  GENERATING_STEPS: 'GENERATING_STEPS',
  SAVING_FILES: 'SAVING_FILES',
  UPLOADING_MEDIA: 'UPLOADING_MEDIA',
  PUBLISHING_DRAFT: 'PUBLISHING_DRAFT',
  UPDATING_SHEET: 'UPDATING_SHEET',
  GENERATING_PINS: 'GENERATING_PINS',
  UPLOADING_PINS: 'UPLOADING_PINS',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
  SCRAPING_SITE: 'SCRAPING_SITE',
  DOWNLOADING_IMAGES: 'DOWNLOADING_IMAGES',
  PLANNING_VISUAL_STATES: 'PLANNING_VISUAL_STATES'
};

function defaultState() {
  return {
    status: STATES.IDLE,
    recipeTitle: '',
    sheetRowIndex: -1,
    selectedHeroBackground: null,
    selectedStepsBackground: null,
    backgroundQueue: [],
    backgroundQueueIndex: 0,
    recipeJSON: null,
    heroImage: null,
    ingredientsImage: null,
    steps: [],
    currentStepIndex: 0,
    articleHTML: null,
    draftUrl: null,
    draftPostId: null,
    seoData: null,
    error: null,
    statusBeforeError: null,
    lastUpdated: null,
    logs: [],
    recipeUrl: '',
    scrapedHTML: null,
    scrapedImageUrls: [],
    sheetSettings: null,
    pinterestPins: [],
    // Batch mode fields
    batchMode: false,
    batchQueue: [],          // Array of { topic, rowIndex } — all pending recipes loaded upfront
    batchCurrentIndex: 0,    // Index into batchQueue for current recipe
    batchResults: [],        // Array of { topic, rowIndex, status: 'success'|'error'|'skipped', error?, draftUrl?, duration? }
    batchStartedAt: null,    // Timestamp when batch started
  };
}

function defaultSettings() {
  return {
    sheetId: '',
    sheetTabName: 'Sheet1',
    topicColumn: 'A',
    statusColumn: 'B',
    startRow: 2,
    appsScriptUrl: '',
    downloadFolder: '',
    wpUrl: '',
    wpUsername: '',
    wpAppPassword: '',
    recipePromptTemplate: RECIPE_PROMPT,
    imagePromptSuffix: '',
    backgroundPromptPrefix: BACKGROUND_PROMPT_PREFIX,
    heroPromptPrefix: HERO_PROMPT_PREFIX,
    heroPromptSuffix: HERO_PROMPT_SUFFIX,
    ingredientsPromptPrefix: INGREDIENTS_PROMPT_PREFIX,
    ingredientsPromptSuffix: '',
    stepsPromptPrefix: STEPS_PROMPT_PREFIX,
    stepsPromptSuffix: '',
    wprmEnabled: false,
    seoAuthor: '',
    seoCopyright: '',
    backgroundsFolderPath: '',
    selectedSubfolder: '',
    heroAspectRatio: 'LANDSCAPE',
    stepAspectRatio: 'PORTRAIT',
    ingredientAspectRatio: 'PORTRAIT',
    wpCategories: 'Breakfast, Lunch, Dinner, Dessert',
    postTemplate: null,
    generatorSheetTab: 'single post',
    generatorTopicColumn: 'A',
    generatorStatusColumn: 'B',
    generatorStartRow: 2,
    scraperSheetTab: 'Scraping',
    scraperUrlColumn: 'A',
    scraperStatusColumn: 'B',
    scraperStartRow: 2,
    mode: 'generate',
    contentSelectors: '.entry-content, .post-content, article, .recipe-content',
    extractionProvider: 'chatgpt',
    extractionPromptTemplate: '',
    rewritePromptTemplate: '',
    generatorGptUrl: '',
    extractionGptUrl: '',
    rewriteGptUrl: '',
    introRotationIndex: 0,
    introRotationTotal: 12,
    pinterestEnabled: false,
    pinterestPinCount: 3,
    pinterestTemplateFolderGenerator: '',
    pinterestTemplateFolderScraper: '',
    pinterestAspectRatio: 'PORTRAIT',
    pinterestPromptPrefix: 'Recreate the EXACT same layout, style, text placement, and design from the first uploaded reference image (the Pinterest template). Use the food from the other uploaded reference images (hero and step photos). Recipe: "@title". Website: @website. Ingredients list as text: @ingredients. If the template shows ingredients text, use this list. If the template shows a website name, use "@website". ',
    pinterestPromptSuffix: ' Pinterest pin style, vertical format, eye-catching, high quality food photography, text overlay matching the template style.',
    listStyle: 'default'
  };
}

function getActiveSiteName() {
  if (_activeSiteCache) return _activeSiteCache;
  try {
    _activeSiteCache = readFileSync(ACTIVE_SITE_FILE, 'utf-8').trim();
  } catch {
    _activeSiteCache = 'default';
  }
  return _activeSiteCache;
}

export function getSiteDir(siteName) {
  return join(SITES_DIR, siteName || getActiveSiteName());
}

export function getSiteDataDir(siteName) {
  return getSiteDir(siteName);
}

function siteFile(filename) {
  return join(getSiteDir(), filename);
}

function getImagesDir() {
  return join(getSiteDir(), 'images');
}

async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

async function readJSON(filePath, defaultValue) {
  try {
    const data = await readFile(filePath, 'utf-8');
    return { ...defaultValue, ...JSON.parse(data) };
  } catch {
    return defaultValue;
  }
}

async function writeJSON(filePath, data) {
  await ensureDir(dirname(filePath));
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

async function migrate() {
  if (existsSync(SITES_DIR)) return; // already migrated

  await ensureDir(DATA_DIR);
  const defaultDir = join(SITES_DIR, 'default');
  await mkdir(defaultDir, { recursive: true });

  // Move existing per-site files into default site dir
  for (const fname of ['settings.json', 'state.json', 'history.json']) {
    const src = join(DATA_DIR, fname);
    if (existsSync(src)) {
      try { renameSync(src, join(defaultDir, fname)); } catch { /* ignore */ }
    }
  }

  // Move images dir if it exists
  const oldImages = join(DATA_DIR, 'images');
  if (existsSync(oldImages)) {
    try { renameSync(oldImages, join(defaultDir, 'images')); } catch { /* ignore */ }
  }

  // Write active-site.txt
  writeFileSync(ACTIVE_SITE_FILE, 'default', 'utf-8');
  _activeSiteCache = 'default';

  // Write global.json
  if (!existsSync(GLOBAL_FILE)) {
    writeFileSync(GLOBAL_FILE, JSON.stringify({ browserProfilePath: '' }, null, 2), 'utf-8');
  }
}

export const StateManager = {
  // Run migration at startup
  async init() {
    await migrate();
  },

  // --- Active site ---
  getActiveSite() {
    return getActiveSiteName();
  },

  setActiveSite(name) {
    const dir = getSiteDir(name);
    if (!existsSync(dir)) throw new Error(`Site "${name}" does not exist`);
    writeFileSync(ACTIVE_SITE_FILE, name, 'utf-8');
    _activeSiteCache = name;
  },

  // --- Site management ---
  listSites() {
    if (!existsSync(SITES_DIR)) return [];
    return readdirSync(SITES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  },

  async createSite(name) {
    const dir = getSiteDir(name);
    if (existsSync(dir)) throw new Error(`Site "${name}" already exists`);
    await mkdir(dir, { recursive: true });
    await writeJSON(join(dir, 'settings.json'), defaultSettings());
    await writeJSON(join(dir, 'state.json'), defaultState());
    await writeJSON(join(dir, 'history.json'), { entries: [] });
  },

  async deleteSite(name) {
    const sites = this.listSites();
    if (sites.length <= 1) throw new Error('Cannot delete the last site');
    if (getActiveSiteName() === name) throw new Error('Cannot delete the active site');
    const dir = getSiteDir(name);
    if (!existsSync(dir)) throw new Error(`Site "${name}" does not exist`);
    await rm(dir, { recursive: true, force: true });
  },

  async duplicateSite(src, dest) {
    const srcDir = getSiteDir(src);
    if (!existsSync(srcDir)) throw new Error(`Source site "${src}" does not exist`);
    const destDir = getSiteDir(dest);
    if (existsSync(destDir)) throw new Error(`Destination site "${dest}" already exists`);
    await cp(srcDir, destDir, { recursive: true });
  },

  async exportSite(name) {
    const dir = getSiteDir(name);
    const settings = await readJSON(join(dir, 'settings.json'), defaultSettings());
    const backgrounds = await readJSON(join(dir, 'backgrounds.json'), { hero: [], steps: [] });
    return { settings, backgrounds };
  },

  async importSite(name, data) {
    const dir = getSiteDir(name);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    // Support both old format (flat settings) and new format ({ settings, backgrounds })
    if (data.settings) {
      await writeJSON(join(dir, 'settings.json'), data.settings);
      if (data.backgrounds) {
        await writeJSON(join(dir, 'backgrounds.json'), data.backgrounds);
      }
    } else {
      // Legacy: flat object = settings only
      await writeJSON(join(dir, 'settings.json'), data);
    }
  },

  // --- Global config ---
  async getGlobal() {
    return readJSON(GLOBAL_FILE, { browserProfilePath: '' });
  },

  async saveGlobal(data) {
    const current = await this.getGlobal();
    await writeJSON(GLOBAL_FILE, { ...current, ...data });
  },

  // --- Flow Accounts (global, shared across sites) ---
  async getFlowAccounts() {
    const flowFile = join(DATA_DIR, 'flow-accounts.json');
    return readJSON(flowFile, {
      accounts: [],
      maxPerAccount: 90,
      autoReset: true,
      activeAccountId: null
    });
  },

  async saveFlowAccounts(data) {
    const flowFile = join(DATA_DIR, 'flow-accounts.json');
    await writeJSON(flowFile, data);
  },

  // --- State (per-site) ---
  async getState() {
    return readJSON(siteFile('state.json'), defaultState());
  },

  async setState(state) {
    state.lastUpdated = Date.now();
    await writeJSON(siteFile('state.json'), state);
  },

  async updateState(updates) {
    const current = await this.getState();
    const newState = { ...current, ...updates, lastUpdated: Date.now() };
    await writeJSON(siteFile('state.json'), newState);
    return newState;
  },

  async resetState() {
    await writeJSON(siteFile('state.json'), defaultState());
    await this.clearImageData();
  },

  async addLog(message, type = 'info') {
    const state = await this.getState();
    state.logs.push({ message, type, timestamp: Date.now() });
    if (state.logs.length > 100) {
      state.logs = state.logs.slice(-100);
    }
    await this.setState(state);
  },

  // --- Settings (per-site) ---
  async getSettings() {
    return readJSON(siteFile('settings.json'), defaultSettings());
  },

  async saveSettings(settings) {
    const current = await this.getSettings();
    await writeJSON(siteFile('settings.json'), { ...current, ...settings });
  },

  // --- Image data (per-site) ---
  async storeImageData(key, base64Data) {
    const imgDir = getImagesDir();
    await ensureDir(imgDir);
    await writeFile(join(imgDir, `${key}.b64`), base64Data, 'utf-8');
  },

  async getImageData(key) {
    try {
      return await readFile(join(getImagesDir(), `${key}.b64`), 'utf-8');
    } catch {
      return null;
    }
  },

  async clearImageData() {
    try {
      const imgDir = getImagesDir();
      const files = readdirSync(imgDir);
      for (const file of files) {
        unlinkSync(join(imgDir, file));
      }
    } catch {
      // Directory may not exist
    }
  },

  // --- Backgrounds ---
  async getHeroBackgrounds() {
    const data = await readJSON(siteFile('backgrounds.json'), { hero: [], steps: [] });
    return data.hero || [];
  },

  async saveHeroBackgrounds(backgrounds) {
    const data = await readJSON(siteFile('backgrounds.json'), { hero: [], steps: [] });
    data.hero = backgrounds;
    await writeJSON(siteFile('backgrounds.json'), data);
  },

  async getStepsBackgrounds() {
    const data = await readJSON(siteFile('backgrounds.json'), { hero: [], steps: [] });
    return data.steps || [];
  },

  async saveStepsBackgrounds(backgrounds) {
    const data = await readJSON(siteFile('backgrounds.json'), { hero: [], steps: [] });
    data.steps = backgrounds;
    await writeJSON(siteFile('backgrounds.json'), data);
  },

  // --- Backgrounds folder system ---
  listSubfolders(rootPath) {
    if (!rootPath || !existsSync(rootPath)) return [];
    try {
      return readdirSync(rootPath, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    } catch { return []; }
  },

  listImagesInFolder(folderPath) {
    if (!folderPath || !existsSync(folderPath)) return [];
    const exts = ['.jpg', '.jpeg', '.png', '.webp'];
    try {
      return readdirSync(folderPath)
        .filter(f => exts.includes(extname(f).toLowerCase()))
        .map(f => join(folderPath, f))
        .sort();
    } catch { return []; }
  },

  getImageBase64FromFile(filePath) {
    try {
      const buf = readFileSync(filePath);
      return buf.toString('base64');
    } catch { return null; }
  }
};
