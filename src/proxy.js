'use strict';

const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

let runtimeProxy = null;

function loadStoredProxy() {
  if (process.env.PROXY_URL || process.env.ROTATING_PROXY_URL || process.env.HTTP_PROXY) {
    return process.env.PROXY_URL || process.env.ROTATING_PROXY_URL || process.env.HTTP_PROXY;
  }
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.proxyUrl) return data.proxyUrl;
    }
  } catch {}
  return null;
}

runtimeProxy = loadStoredProxy();

function getRuntimeProxy() {
  return runtimeProxy || loadStoredProxy();
}

function saveStoredProxy(proxyUrl) {
  runtimeProxy = proxyUrl ? proxyUrl.trim() : null;
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    if (fs.existsSync(SETTINGS_FILE)) {
      try {
        existing = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      } catch {}
    }
    existing.proxyUrl = runtimeProxy;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(existing, null, 2));
    console.log(`[proxy] Saved proxy settings: ${runtimeProxy ? runtimeProxy.replace(/:[^:@]+@/, ':****@') : '(disabled)'}`);
  } catch (err) {
    console.error('[proxy] Failed to save proxy to settings:', err.message);
  }
}

function parseProxy(rawStr) {
  const str = String(rawStr !== undefined ? rawStr : getRuntimeProxy() || '').trim();
  if (!str) return null;

  // Handle format host:port:user:pass
  const parts = str.split(':');
  if (parts.length === 4 && !str.includes('@') && !str.includes('//')) {
    const [host, port, user, pass] = parts;
    return {
      raw: str,
      protocol: 'http:',
      host,
      port: Number(port),
      username: user,
      password: pass,
      serverArg: `http://${host}:${port}`,
      url: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
    };
  }

  let urlObj;
  try {
    urlObj = new URL(str.includes('://') ? str : `http://${str}`);
  } catch {
    return null;
  }

  const protocol = urlObj.protocol || 'http:';
  const username = decodeURIComponent(urlObj.username || '');
  const password = decodeURIComponent(urlObj.password || '');
  const host = urlObj.hostname;
  const port = Number(urlObj.port) || (protocol === 'https:' ? 443 : 80);

  return {
    raw: str,
    protocol,
    host,
    port,
    username,
    password,
    serverArg: `${protocol}//${host}:${port}`,
    url: urlObj.href,
  };
}

function getAxiosAgent(proxyInfo) {
  const p = proxyInfo || parseProxy();
  if (!p) return null;

  if (p.protocol.startsWith('socks')) {
    return new SocksProxyAgent(p.url);
  }
  return new HttpsProxyAgent(p.url);
}

async function testProxy(rawStr) {
  const p = parseProxy(rawStr);
  if (!p) throw new Error('Định dạng proxy không hợp lệ (Ví dụ: http://user:pass@ip:port hoặc ip:port:user:pass)');

  const axios = require('axios');
  const agent = getAxiosAgent(p);

  const start = Date.now();
  const res = await axios.get('https://api.ipify.org?format=json', {
    httpsAgent: agent,
    httpAgent: agent,
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });

  const latency = Date.now() - start;
  return {
    ok: true,
    ip: res.data?.ip,
    latency,
    protocol: p.protocol.replace(':', ''),
    host: p.host,
    port: p.port,
  };
}

module.exports = {
  getRuntimeProxy,
  saveStoredProxy,
  parseProxy,
  getAxiosAgent,
  testProxy,
};
