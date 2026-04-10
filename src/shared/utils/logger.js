/**
 * Logger — colored console output + file logging
 */

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
  },

  warn(msg, ...args) {
    _log('warn', COLORS.yellow, 'WARN', 'warning', msg, args);
  },

  error(msg, ...args) {
    _log('error', COLORS.red, 'ERR ', 'error', msg, args, { useStderr: true });
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
  }
};
