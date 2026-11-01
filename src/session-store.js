'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

// sessionId -> { id, cookieJar (serialized), createdAt, lastUsed, username }
const sessions = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(SESSION_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    for (const [id, s] of Object.entries(raw)) {
      sessions.set(id, { ...s, createdAt: s.createdAt || Date.now() });
    }
    log('store', `loaded ${sessions.size} session(s) from disk`);
  } catch (err) {
    log('store', `failed to load sessions: ${err.message}`);
  }
}

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    ensureDataDir();
    const out = {};
    for (const [id, s] of sessions) {
      out[id] = { id: s.id, cookieJar: s.cookieJar, ua: s.ua, createdAt: s.createdAt, lastUsed: s.lastUsed, username: s.username };
    }
    try {
      fs.writeFileSync(SESSION_FILE, JSON.stringify(out, null, 2));
    } catch (err) {
      log('store', `failed to persist sessions: ${err.message}`);
    }
  }, 500);
}

function create(username, cookieJar, ua) {
  const id = crypto.randomBytes(24).toString('hex');
  const s = { id, username, cookieJar, ua, createdAt: Date.now(), lastUsed: Date.now() };
  sessions.set(id, s);
  persist();
  return s;
}

function get(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  s.lastUsed = Date.now();
  return s;
}

function destroy(id) {
  const existed = sessions.delete(id);
  if (existed) persist();
  return existed;
}

function list() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    username: s.username,
    createdAt: s.createdAt,
    lastUsed: s.lastUsed,
  }));
}

// Drop sessions idle for longer than the TTL so a dead cookie never lingers.
const TTL_MS = 1000 * 60 * 60 * 12;
function sweep() {
  const now = Date.now();
  let removed = 0;
  for (const [id, s] of sessions) {
    if (now - (s.lastUsed || s.createdAt) > TTL_MS) {
      sessions.delete(id);
      removed++;
    }
  }
  if (removed) {
    persist();
    log('store', `swept ${removed} expired session(s)`);
  }
}

function log(scope, msg) {
  console.log(`[${new Date().toISOString()}] [${scope}] ${msg}`);
}

module.exports = { create, get, destroy, list, load, sweep, log };