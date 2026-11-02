'use strict';

// Thin API wrapper. The session token and license live in localStorage;
// the OLM password never reaches the client beyond the login request itself.

const Api = (() => {
  const TOKEN_KEY = 'olm.sessionId';
  const SETTINGS_KEY = 'olm.settings';
  const SERVER_URL_KEY = 'olm.serverUrl';
  const AUTH_KEY = 'olm.auth';
  const HWID_KEY = 'olm.device_hwid';
  const LICENSE_KEY = 'olm.license';

  // URL backend mặc định khi deploy trên Render (dùng cho mobile app iOS và web Vercel)
  const DEFAULT_CLOUD_URL = 'https://olm-solver.onrender.com';

  function getServerUrl() {
    try {
      const custom = (localStorage.getItem(SERVER_URL_KEY) || '').trim().replace(/\/+$/, '');
      if (custom) return custom;
    } catch {
      /* ignore */
    }

    // Nếu chạy trên điện thoại (Capacitor iOS/Android) hoặc chạy trên frontend Vercel:
    // Tự động trỏ về Cloud Render backend
    const isNative = Boolean(window.Capacitor?.isNativePlatform?.() || window.location.protocol === 'capacitor:');
    const isVercel = Boolean(window.location.hostname.includes('vercel.app'));

    if (isNative || isVercel) {
      return DEFAULT_CLOUD_URL;
    }

    return '';
  }

  function setServerUrl(value) {
    try {
      if (value) localStorage.setItem(SERVER_URL_KEY, value.trim().replace(/\/+$/, ''));
      else localStorage.removeItem(SERVER_URL_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  async function getDeviceHWID() {
    try {
      let hwid = localStorage.getItem(HWID_KEY);
      if (hwid) return hwid;

      if (window.Capacitor?.Plugins?.Device) {
        try {
          const idInfo = await window.Capacitor.Plugins.Device.getId();
          if (idInfo && idInfo.identifier) {
            hwid = 'ios_' + idInfo.identifier;
            localStorage.setItem(HWID_KEY, hwid);
            return hwid;
          }
        } catch {}
      }

      const randomPart = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      hwid = randomPart;
      localStorage.setItem(HWID_KEY, hwid);
      return hwid;
    } catch {
      return 'device_' + Date.now();
    }
  }

  function getStoredLicense() {
    try {
      const raw = localStorage.getItem(LICENSE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveLicense(lic) {
    try {
      if (lic) localStorage.setItem(LICENSE_KEY, JSON.stringify(lic));
      else localStorage.removeItem(LICENSE_KEY);
    } catch {
      /* ignore */
    }
  }

  function token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  function saveCredentials(username, password) {
    try {
      if (username && password) {
        localStorage.setItem(AUTH_KEY, JSON.stringify({ username, password }));
      } else {
        localStorage.removeItem(AUTH_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }

  function getCredentials() {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  const COOKIE_KEY = 'olm.cookie';

  function saveCookie(cookie) {
    try {
      if (cookie) localStorage.setItem(COOKIE_KEY, cookie);
      else localStorage.removeItem(COOKIE_KEY);
    } catch {}
  }

  function getCookie() {
    try {
      return localStorage.getItem(COOKIE_KEY) || '';
    } catch {
      return '';
    }
  }

  function clearCredentials() {
    try {
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(COOKIE_KEY);
    } catch {
      /* storage unavailable */
    }
  }

  async function request(path, { method = 'GET', body, headers = {}, _isRetry = false } = {}) {
    const opts = {
      method,
      headers: { ...headers },
    };

    const t = token();
    if (t) opts.headers['X-Session-Id'] = t;

    const lic = getStoredLicense();
    if (lic && lic.key) {
      opts.headers['X-License-Key'] = lic.key;
      let devHwid = '';
      try { devHwid = localStorage.getItem(HWID_KEY) || lic.hwid || ''; } catch {}
      opts.headers['X-Device-HWID'] = devHwid;
    }

    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const serverUrl = getServerUrl();
    const finalUrl = (serverUrl && path.startsWith('/')) ? `${serverUrl}${path}` : path;

    let res;
    try {
      res = await fetch(finalUrl, opts);
    } catch (err) {
      const target = serverUrl ? `tới máy chủ (${serverUrl})` : 'tới máy chủ';
      throw new Error(`Không kết nối được ${target}. Kiểm tra kết nối mạng hoặc địa chỉ máy chủ.`);
    }

    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.slice(0, 300) };
      }
    }

    if (!res.ok) {
      // Auto-relogin silently if session expired on server
      if (res.status === 401 && (data.code === 'NO_SESSION' || data.code === 'NO_TOKEN') && !_isRetry && !path.includes('/api/login')) {
        const creds = getCredentials();
        const savedCookie = getCookie();
        try {
          let loginRes = null;
          if (creds && creds.username && creds.password) {
            loginRes = await request('/api/login', { method: 'POST', body: { username: creds.username, password: creds.password }, _isRetry: true });
          } else if (savedCookie) {
            loginRes = await request('/api/login-cookie', { method: 'POST', body: { cookie: savedCookie }, _isRetry: true });
          }
          if (loginRes && loginRes.sessionId) {
            setToken(loginRes.sessionId);
            return await request(path, { method, body, headers, _isRetry: true });
          }
        } catch {
          /* fallback to throw error */
        }
      }

      const message = data.error || `HTTP ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      error.code = data.code;
      error.expired = data.expired;
      throw error;
    }

    return data;
  }

  return {
    token,
    setToken,
    getServerUrl,
    setServerUrl,
    DEFAULT_CLOUD_URL,
    getDeviceHWID,
    getStoredLicense,
    saveLicense,
    saveCredentials,
    getCredentials,
    saveCookie,
    getCookie,
    clearCredentials,

    health: () => request('/api/health'),
    login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
    loginWithCookie: (cookie) => request('/api/login-cookie', { method: 'POST', body: { cookie } }),
    logout: () => request('/api/logout', { method: 'POST' }),
    session: () => request('/api/session'),
    homeworks: () => request('/api/homeworks'),
    answer: (question) => request('/api/answer', { method: 'POST', body: { question } }),
    startRun: (homeworks, config) => request('/api/run', { method: 'POST', body: { homeworks, config } }),
    stopRun: (runId) => request(runId ? `/api/run/${runId}/stop` : '/api/run/stop', { method: 'POST' }),
    run: (runId) => request(`/api/run/${runId}`),
    runs: () => request('/api/runs'),
    submit: (payload) => request('/api/submit', { method: 'POST', body: payload }),

    // License API
    activateLicense: (key, name, hwid, deviceInfo) =>
      request('/api/license/activate', { method: 'POST', body: { key, name, hwid, deviceInfo } }),
    verifyLicense: (key, hwid) =>
      request('/api/license/verify', { method: 'POST', body: { key, hwid } }),

    loadSettings() {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      } catch {
        return {};
      }
    },

    saveSettings(settings) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        /* ignore */
      }
    },
  };
})();