'use strict';

const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const SETTINGS_FILE = path.join(process.env.OLM_DATA_DIR || path.join(__dirname, '..', 'data'), 'settings.json');

let runtimeProxy = null;
let sharedProxy;
let refreshAt = 0;
let refreshPromise;

function loadStoredProxy() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      if (data.proxyUrl !== undefined) {
        return data.proxyUrl ? data.proxyUrl.trim() : null;
      }
    }
  } catch {}
  if (process.env.PROXY_URL || process.env.ROTATING_PROXY_URL || process.env.HTTP_PROXY) {
    const val = (process.env.PROXY_URL || process.env.ROTATING_PROXY_URL || process.env.HTTP_PROXY).trim();
    return val || null;
  }
  return null;
}

runtimeProxy = loadStoredProxy();

function getRuntimeProxy() {
  if (sharedProxy) return sharedProxy;
  return runtimeProxy || loadStoredProxy();
}

async function refreshSharedProxy({ force = false } = {}) {
  const shared = require('./deployment-store');
  if (!shared.configured || (!force && Date.now() < refreshAt)) return;
  if (!refreshPromise) {
    refreshPromise = shared.settings.getProxy().then((value) => {
      sharedProxy = value;
      refreshAt = Date.now() + 30000;
    }).finally(() => { refreshPromise = null; });
  }
  await refreshPromise;
}

async function saveProxy(proxyUrl) {
  const shared = require('./deployment-store');
  if (!shared.configured) return saveStoredProxy(proxyUrl);
  await shared.settings.setProxy(proxyUrl || null);
  await refreshSharedProxy({ force: true });
}

function saveStoredProxy(proxyUrl) {
  const next = proxyUrl ? proxyUrl.trim() : null;
  if (next && !parseProxy(next)) throw new Error('Địa chỉ proxy không hợp lệ.');
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const existing = fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) : {};
  const file = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(file, JSON.stringify({ ...existing, proxyUrl: next }, null, 2), { mode: 0o600 });
  fs.renameSync(file, SETTINGS_FILE);
  runtimeProxy = next;
}

function parseProxy(rawStr) {
  const str = String(rawStr !== undefined ? rawStr : getRuntimeProxy() || '').trim();
  if (!str) return null;

  // Handle format host:port:user:pass (where pass may contain '@' or other special characters)
  const colonMatch = str.match(/^([a-zA-Z0-9.-]+):(\d+):([^:]+):(.+)$/);
  if (colonMatch) {
    const [, host, port, user, pass] = colonMatch;
    if (Number(port) < 1 || Number(port) > 65535) return null;
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

  const protocol = urlObj.protocol;
  if (!['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(protocol) ||
      !urlObj.hostname || (urlObj.pathname && urlObj.pathname !== '/') || urlObj.search || urlObj.hash) return null;
  let username, password;
  try {
    username = decodeURIComponent(urlObj.username);
    password = decodeURIComponent(urlObj.password);
  } catch {
    return null;
  }
  const host = urlObj.hostname;
  const port = Number(urlObj.port) || (protocol === 'https:' ? 443 : protocol.startsWith('socks') ? 1080 : 80);

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
    proxy: false,
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

function createAxiosClient(jar) {
  const axios = require('axios');
  const p = parseProxy();
  if (p) {
    const { createCookieAgent } = require('http-cookie-agent/http');
    const { HttpsProxyAgent } = require('https-proxy-agent');
    const { SocksProxyAgent } = require('socks-proxy-agent');

    const AgentClass = p.protocol.startsWith('socks') ? SocksProxyAgent : HttpsProxyAgent;
    const CookieAgentClass = createCookieAgent(AgentClass);
    const agent = new CookieAgentClass(p.url, { cookies: { jar } });

    return axios.create({
      httpsAgent: agent,
      httpAgent: agent,
      proxy: false,
    });
  }

  const { wrapper } = require('axios-cookiejar-support');
  return wrapper(axios.create({ jar, withCredentials: true, proxy: false }));
}

module.exports = {
  getRuntimeProxy,
  saveStoredProxy,
  saveProxy,
  refreshSharedProxy,
  parseProxy,
  getAxiosAgent,
  createAxiosClient,
  testProxy,
};
