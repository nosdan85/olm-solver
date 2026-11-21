'use strict';

// The browser sends the web session cookie with each API request.

const Api = (() => {
  const HWID_KEY = 'olm.device_hwid';
  const LICENSE_KEY = 'olm.license';

  try {
    localStorage.removeItem('olm.auth');
    localStorage.removeItem('olm.cookie');
    localStorage.removeItem('olm.sessionId');
    localStorage.removeItem('olm.currentUser');
    localStorage.removeItem('olm.serverUrl');
  } catch {}

  const deployment = window.OLM_DEPLOYMENT || {};
  const apiOrigin = deployment.apiOrigin || '';
  let currentUser = '';

  async function computeDeviceFingerprint() {
    let glRenderer = '';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '');
      }
    } catch {}
    const raw = [
      navigator.platform || '',
      navigator.hardwareConcurrency || '',
      navigator.maxTouchPoints || '',
      `${screen.width}x${screen.height}`,
      window.devicePixelRatio || 1,
      Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      navigator.language || '',
      glRenderer,
    ].join('|');
    try {
      if (window.crypto?.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        const hex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
        return 'OLM-HW-' + hex.slice(0, 24).toUpperCase();
      }
    } catch {}
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return 'OLM-HW-' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  async function getDeviceHWID() {
    try {
      const stored = localStorage.getItem(HWID_KEY);
      if (stored && stored.startsWith('OLM-HW-')) return stored;
      const fp = await computeDeviceFingerprint();
      localStorage.setItem(HWID_KEY, fp);
      return fp;
    } catch (e) {
      return await computeDeviceFingerprint();
    }
  }

  function getStoredLicense(username = null) {
    try {
      const user = String(username || currentUser || '').toLowerCase();
      if (!user) return null;
      const saved = localStorage.getItem(LICENSE_KEY + '_' + user);
      if (saved) return JSON.parse(saved);
      const legacy = JSON.parse(localStorage.getItem(LICENSE_KEY));
      return legacy?.olmUsername?.toLowerCase() === user ? legacy : null;
    } catch {
      return null;
    }
  }

  function saveLicense(license, username = null) {
    try {
      const user = String(username || license?.olmUsername || currentUser || '').toLowerCase();
      if (!user) return;
      const key = LICENSE_KEY + '_' + user;
      if (license) localStorage.setItem(key, JSON.stringify(license));
      else localStorage.removeItem(key);
      const legacy = JSON.parse(localStorage.getItem(LICENSE_KEY));
      if (legacy?.olmUsername?.toLowerCase() === user) localStorage.removeItem(LICENSE_KEY);
    } catch {}
  }

  function openEvents(path) {
    const controller = new AbortController();
    let retry;
    const stream = {
      readyState: 0,
      close() {
        stream.readyState = 2;
        clearTimeout(retry);
        controller.abort();
      },
    };

    async function connect() {
      try {
        const response = await fetch(apiOrigin + path, {
          credentials: 'include',
          signal: controller.signal,
          redirect: 'error',
        });
        if ([401, 403, 410].includes(response.status)) {
          stream.close();
          const fatalErr = new Error('Phiên sự kiện đã hết hạn.');
          fatalErr.fatal = true;
          fatalErr.status = response.status;
          stream.onerror?.(fatalErr);
          return;
        }
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new Error('Không kết nối được luồng sự kiện.');
        }
        stream.readyState = 1;
        stream.onopen?.();
        const decoder = new TextDecoder();
        const reader = response.body.getReader();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 2_000_000) throw new Error('Sự kiện quá lớn.');
            let end;
            while ((end = buffer.indexOf('\n\n')) !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (frame.startsWith('data: ')) stream.onmessage?.({ data: frame.slice(6) });
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (err) {
        if (!controller.signal.aborted) stream.onerror?.(err);
      }
      if (!controller.signal.aborted) {
        stream.readyState = 0;
        retry = setTimeout(connect, 2000);
      }
    }
    connect();
    return stream;
  }

  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const opts = {
      method,
      redirect: 'error',
      credentials: 'include',
      headers: { ...headers },
    };

    const lic = getStoredLicense();
    if (lic && lic.key) {
      opts.headers['X-License-Key'] = lic.key;
      let devHwid = '';
      try { devHwid = localStorage.getItem(HWID_KEY) || lic.hwid || ''; } catch (e) {}
      opts.headers['X-Device-HWID'] = devHwid;
    }

    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(apiOrigin + path, opts);
    } catch (err) {
      throw new Error('Không kết nối được máy chủ. Vui lòng kiểm tra kết nối mạng.');
    }

    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('Máy chủ không trả về JSON hợp lệ.');
      }
    }

    if (!res.ok) {
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
    setCurrentUser: (username) => { currentUser = username || ''; },
    getCurrentUser: () => currentUser,
    apiOrigin,
    liveEvents: deployment.liveEvents !== false,
    getDeviceHWID,
    getStoredLicense,
    saveLicense,
    openEvents,

    login: (username, password) => request('/api/login', { method: 'POST', body: { username, password } }),
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
    activateLicense: (key, olmUsername, hwid, deviceName, name) =>
      request('/api/license/activate', { method: 'POST', body: { key, olmUsername, hwid, deviceName, name } }),
    verifyLicense: (key, olmUsername, hwid, deviceName) =>
      request('/api/license/verify', { method: 'POST', body: { key, olmUsername, hwid, deviceName } }),

  };
})();
