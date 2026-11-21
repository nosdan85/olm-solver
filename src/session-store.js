'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.OLM_DATA_DIR || path.join(__dirname, '..', 'data');
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json');

// sessionId -> { id, cookieJar (serialized), createdAt, lastUsed, username }
const sessions = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function encryptionKey() {
  const secret = process.env.SESSION_SECRET;
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

function load() {
  if (!fs.existsSync(SESSION_FILE)) return;
  const key = encryptionKey();
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    let entries = raw;
    if (raw.version === 1) {
      if (!key) return;
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
      entries = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(raw.data, 'base64')), decipher.final(),
      ]).toString('utf8'));
    }
    for (const [id, { username, cookieJar, ua, createdAt, lastUsed }] of Object.entries(entries)) {
      sessions.set(id, { id, username, cookieJar, ua, createdAt, lastUsed });
    }
    sweep();
    if (raw.version !== 1) {
      if (key) persist();
      else fs.unlinkSync(SESSION_FILE);
    }
  } catch (err) {
    log('store', 'failed to load sessions: ' + err.message);
  }
}

function persist() {
  const key = encryptionKey();
  if (!key) return;
  const file = SESSION_FILE + '.tmp';
  try {
    ensureDataDir();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(Object.fromEntries(sessions))), cipher.final(),
    ]);
    const encoded = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    fs.writeFileSync(file, JSON.stringify(encoded), { mode: 0o600 });
    fs.renameSync(file, SESSION_FILE);
  } catch (err) {
    log('store', 'failed to persist sessions: ' + err.message);
  }
}

function create(username, cookieJar, ua) {
  const id = crypto.randomBytes(24).toString('hex');
  const s = { id, username, cookieJar, ua, createdAt: Date.now(), lastUsed: Date.now() };
  sessions.set(id, s);
  persist();
  return s;
}

function updateCookies(id, cookieJar, ua) {
  const s = sessions.get(id);
  if (!s) return null;
  if (cookieJar) s.cookieJar = cookieJar;
  if (ua) s.ua = ua;
  s.lastUsed = Date.now();
  persist();
  return s;
}

function get(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - (s.lastUsed || s.createdAt) > TTL_MS) {
    destroy(id);
    return null;
  }
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

// Expire idle application sessions after seven days.
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

module.exports = { create, updateCookies, get, destroy, list, load, sweep, log };