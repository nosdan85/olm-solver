'use strict';

const util = require('util');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(300);

const MAX_BUFFER = 300;
const logHistory = [];

// Store original console methods
const originalConsole = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: (console.warn || console.log).bind(console),
  error: (console.error || console.log).bind(console),
};

let isHooked = false;
let isBroadcasting = false;

function broadcast(entry) {
  if (!entry || !entry.message) return;
  const item = {
    ts: entry.ts || Date.now(),
    level: entry.level || 'info',
    message: String(entry.message),
    hwId: entry.hwId ? String(entry.hwId) : null,
    runId: entry.runId ? String(entry.runId) : null,
  };

  logHistory.push(item);
  if (logHistory.length > MAX_BUFFER) {
    logHistory.splice(0, logHistory.length - MAX_BUFFER);
  }

  bus.emit('log', item);
}

function getRecentLogs() {
  return logHistory.slice(-150);
}

function hookConsole() {
  if (isHooked) return;
  isHooked = true;

  function intercept(level, originalFn, ...args) {
    // Always call original console to maintain terminal output
    originalFn(...args);

    if (isBroadcasting) return;

    try {
      isBroadcasting = true;
      const formatted = util.format(...args);
      // Skip empty lines or pure formatting lines
      if (!formatted || formatted.trim() === '' || formatted.startsWith(': connected')) {
        return;
      }

      // Detect log level if specified in message
      let detectedLevel = level;
      if (/\[error\]|error:|failed|thất bại|lỗi/i.test(formatted)) {
        detectedLevel = 'error';
      } else if (/\[warn\]|warning:|cảnh báo/i.test(formatted)) {
        detectedLevel = 'warn';
      } else if (/\[success\]|hoàn thành|thành công|đạt được/i.test(formatted)) {
        detectedLevel = 'success';
      }

      broadcast({
        ts: Date.now(),
        level: detectedLevel,
        message: formatted,
      });
    } catch {
      /* ignore hook errors */
    } finally {
      isBroadcasting = false;
    }
  }

  console.log = (...args) => intercept('info', originalConsole.log, ...args);
  console.info = (...args) => intercept('info', originalConsole.info, ...args);
  console.warn = (...args) => intercept('warn', originalConsole.warn, ...args);
  console.error = (...args) => intercept('error', originalConsole.error, ...args);
}

module.exports = {
  bus,
  broadcast,
  getRecentLogs,
  hookConsole,
  originalConsole,
};
