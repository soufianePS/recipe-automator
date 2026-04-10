/**
 * Logger — colored console output + file logging + Discord webhook
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// In-memory log storage for dashboard
const logs = [];
const MAX_LOGS = 500;

// Discord webhook config (loaded lazily from settings)
let _discordWebhook = null;
let _discordLoaded = false;
let _siteName = null;

// Batch Discord messages to avoid rate limits (max 1 per 2 seconds)
let _discordQueue = [];
let _discordTimer = null;

function _loadDiscordConfig() {
  if (_discordLoaded) return;
  _discordLoaded = true;
  try {
    // Read site name
    const activeSiteFile = join(__dirname, '..', '..', '..', 'data', 'active-site.txt');
    _siteName = readFileSync(activeSiteFile, 'utf-8').trim();
  } catch { _siteName = 'Unknown'; }
  try {
    // Read settings for discord webhook
    const settingsFile = join(__dirname, '..', '..', '..', 'data', 'sites', _siteName || 'default', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
    _discordWebhook = settings.discordWebhook || null;
  } catch { _discordWebhook = null; }
}

function _sendDiscordBatch() {
  if (_discordQueue.length === 0) return;
  const messages = _discordQueue.splice(0, 10); // Max 10 per batch
  const content = messages.join('\n').substring(0, 1900); // Discord limit ~2000 chars

  fetch(_discordWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  }).catch(() => {}); // Silently fail — don't break the app for logging
}

function _queueDiscord(emoji, text) {
  _loadDiscordConfig();
  if (!_discordWebhook) return;

  const time = new Date().toLocaleTimeString();
  _discordQueue.push(`${emoji} **[${_siteName}]** \`${time}\` ${text}`);

  // Flush batch every 2 seconds
  if (!_discordTimer) {
    _discordTimer = setTimeout(() => {
      _discordTimer = null;
      _sendDiscordBatch();
    }, 2000);
  }
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

function addLog(message, type) {
  logs.push({ message, type, timestamp: Date.now() });
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function _log(level, color, label, logType, msg, args, { useStderr = false, phase = null, skipIfNoDebug = false } = {}) {
  if (skipIfNoDebug && !process.env.DEBUG) return;

  const text = [msg, ...args].join(' ');

  if (phase !== null) {
    console.log(`${COLORS.gray}[${timestamp()}]${color} ${label} ${COLORS.cyan}[${phase}]${COLORS.reset} ${text}`);
    addLog(`[${phase}] ${text}`, logType);
  } else if (skipIfNoDebug) {
    console.log(`${COLORS.gray}[${timestamp()}] ${label} ${text}${COLORS.reset}`);
  } else {
    const writer = useStderr ? console.error : console.log;
    writer(`${COLORS.gray}[${timestamp()}]${color} ${label} ${COLORS.reset}${text}`);
    addLog(text, logType);
  }
}

export const Logger = {
  info(msg, ...args) {
    _log('info', COLORS.blue, 'INFO', 'info', msg, args);
  },

  success(msg, ...args) {
    _log('success', COLORS.green, 'OK  ', 'success', msg, args);
    const text = [msg, ...args].join(' ');
    // Send recipe completions and batch results to Discord
    if (text.includes('completed') || text.includes('BATCH COMPLETE') || text.includes('Job completed')) {
      _queueDiscord('🟢', text);
    }
  },

  warn(msg, ...args) {
    _log('warn', COLORS.yellow, 'WARN', 'warning', msg, args);
    const text = [msg, ...args].join(' ');
    // Send important warnings to Discord
    if (text.includes('rate limit') || text.includes('Rate limit') ||
        text.includes('BLOCKED') || text.includes('JSON parse failed') ||
        text.includes('skipping')) {
      _queueDiscord('🟡', text);
    }
  },

  error(msg, ...args) {
    _log('error', COLORS.red, 'ERR ', 'error', msg, args, { useStderr: true });
    // Send ALL errors to Discord
    const text = [msg, ...args].join(' ');
    _queueDiscord('🔴', text);
  },

  step(phase, msg, ...args) {
    _log('step', COLORS.magenta, 'STEP', 'progress', msg, args, { phase });
  },

  debug(msg, ...args) {
    _log('debug', COLORS.gray, 'DBG ', null, msg, args, { skipIfNoDebug: true });
  },

  getLogs() {
    return logs;
  },

  clearLogs() {
    logs.length = 0;
  },

  /** Force reload Discord config (call after settings change) */
  reloadDiscordConfig() {
    _discordLoaded = false;
    _loadDiscordConfig();
  }
};
