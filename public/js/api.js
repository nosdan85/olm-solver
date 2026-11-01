'use strict';

// Thin API wrapper. The session token lives in localStorage; the OLM
// password never reaches the client beyond the login request itself.

const Api = (() => {
  const TOKEN_KEY = 'olm.sessionId';
  const SETTINGS_KEY = 'olm.settings';
  const SERVER_URL_KEY = 'olm.serverUrl';

  function getServerUrl() {
    try {
      return (localStorage.getItem(SERVER_URL_KEY) || '').trim().replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  function setServerUrl(value) {
    try {
      if (value) localStorage.setItem(SERVER_URL_KEY, value.trim().replace(/\/+$/, ''));
      else localStorage.removeItem(SERVER_URL_KEY);
    } catch {
      /* storage unavailable */
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

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const opts = {
      method,
      headers: { ...headers },
    };

    const t = token();
    if (t) opts.headers['X-Session-Id'] = t;

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
      throw new Error(`Không kết nối được ${target}. Kiểm tra kết nối mạng hoặc địa chỉ IP máy chủ.`);
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
      const message = data.error || `HTTP ${res.status}`;
      const error = new Error(message);
      error.status = res.status;
      error.code = data.code;
      throw error;
    }

    return data;
  }

  return {
    token,
    setToken,
    getServerUrl,
    setServerUrl,

    health: () => request('/api/health'),
    login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
    logout: () => request('/api/logout', { method: 'POST' }),
    session: () => request('/api/session'),
    homeworks: () => request('/api/homeworks'),
    answer: (question) => request('/api/answer', { method: 'POST', body: { question } }),
    startRun: (homeworks, config) => request('/api/run', { method: 'POST', body: { homeworks, config } }),
    run: (runId) => request(`/api/run/${runId}`),
    runs: () => request('/api/runs'),
    submit: (payload) => request('/api/submit', { method: 'POST', body: payload }),

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