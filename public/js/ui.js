'use strict';

// DOM helpers, logging and notifications.

const UI = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('vi-VN', { hour12: false });
  }

  function formatDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleString('vi-VN', { hour12: false, dateStyle: 'short', timeStyle: 'short' });
  }

  function debounce(fn, ms = 300) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  // Log pane writer with per-homework filtering support
  const logList = () => document.getElementById('log-list');
  const logBuffer = [];
  let currentLogFilter = 'all';

  function appendLog(entry) {
    logBuffer.push(entry);
    if (logBuffer.length > 2000) logBuffer.shift();

    // Check if this entry should be shown in the current filter view
    if (currentLogFilter !== 'all' && entry.hwId && String(entry.hwId) !== String(currentLogFilter)) {
      return;
    }

    const list = logList();
    if (!list) return;

    renderLogLine(entry, list);
    while (list.children.length > 600) list.removeChild(list.firstChild);
    list.scrollTop = list.scrollHeight;
  }

  function renderLogLine(entry, list) {
    const line = el('div', { class: `log-line ${entry.level || 'info'}` });
    line.append(el('span', { class: 'log-time', text: formatTime(entry.ts) }));
    line.append(el('span', { class: 'log-msg', text: entry.message }));
    list.append(line);
  }

  function setLogFilter(hwId) {
    currentLogFilter = hwId || 'all';
    const list = logList();
    if (!list) return;
    list.innerHTML = '';

    const filtered = currentLogFilter === 'all'
      ? logBuffer
      : logBuffer.filter((e) => !e.hwId || String(e.hwId) === String(currentLogFilter));

    for (const entry of filtered.slice(-600)) {
      renderLogLine(entry, list);
    }
    list.scrollTop = list.scrollHeight;
  }

  function syncLogs(serverLogs) {
    if (!Array.isArray(serverLogs) || !serverLogs.length) return;
    const seen = new Set(logBuffer.slice(-300).map(e => `${e.ts}_${e.message}`));
    let added = false;
    for (const item of serverLogs) {
      const k = `${item.ts}_${item.message}`;
      if (!seen.has(k)) {
        seen.add(k);
        logBuffer.push(item);
        if (logBuffer.length > 2000) logBuffer.shift();
        added = true;
      }
    }
    if (added) {
      setLogFilter(currentLogFilter);
    }
  }

  function clearLog() {
    logBuffer.length = 0;
    const list = logList();
    if (list) list.innerHTML = '';
  }

  function setStatus(label, state) {
    const dot = document.getElementById('conn-dot');
    const text = document.getElementById('conn-label');
    if (dot) dot.className = `dot ${state || ''}`;
    if (text) text.textContent = label;
  }

  function setRunStatus(status) {
    const pill = document.getElementById('run-status');
    if (!pill) return;
    const labels = {
      idle: 'Sẵn sàng',
      running: 'Đang giải bài',
      done: 'Đã hoàn thành',
      error: 'Có lỗi',
      stopped: 'Đã dừng',
    };
    pill.textContent = labels[status] || status;
    pill.className = `pill ${status === 'running' ? 'running' : status === 'done' ? 'done' : (status === 'error' || status === 'stopped') ? 'error' : ''}`;
  }

  function toast(message, kind = 'info') {
    let box = document.getElementById('toast');
    if (!box) {
      box = el('div', { id: 'toast', class: `alert alert-${kind}` });
      box.style.position = 'fixed';
      box.style.left = '16px';
      box.style.right = '16px';
      box.style.bottom = 'calc(var(--tabbar-h) + var(--safe-bottom) + 14px)';
      box.style.zIndex = '100';
      box.style.boxShadow = '0 8px 24px rgba(0,0,0,0.5)';
      document.body.append(box);
    }
    box.className = `alert alert-${kind}`;
    box.textContent = message;
    box.hidden = false;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => {
      box.hidden = true;
    }, 4000);
  }

  // Play a brief pleasant completion chime
  function playBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12); // A5
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.45);
    } catch {
      /* audio autoplay restricted */
    }
  }

  // Native & Web notification dispatch for iPhone / Mobile
  async function notify(title, body) {
    playBeep();
    if (navigator.vibrate) {
      try { navigator.vibrate([200, 100, 200]); } catch {}
    }

    // 1. Capacitor Native Push/Local Notifications (if running as native iOS App)
    const localNotif = window.Capacitor?.Plugins?.LocalNotifications;
    if (localNotif) {
      try {
        let perm = await localNotif.checkPermissions().catch(() => null);
        if (!perm || perm.display !== 'granted') {
          perm = await localNotif.requestPermissions().catch(() => null);
        }
        await localNotif.schedule({
          notifications: [
            {
              id: Math.floor(Math.random() * 800000) + 1000,
              title: title || 'OLM Solver',
              body: body || 'Đã hoàn thành giải bài tập!',
              schedule: { at: new Date(Date.now() + 100) },
              sound: 'default',
              actionTypeId: '',
              extra: null,
            },
          ],
        });
        return;
      } catch (err) {
        console.warn('Capacitor notification error:', err);
      }
    }

    // 2. Service Worker Notification (iOS 16.4+ Web Push & PWA)
    if ('serviceWorker' in navigator && 'Notification' in window && Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker.ready;
        if (reg && reg.showNotification) {
          await reg.showNotification(title, {
            body,
            icon: '/icons/icon.svg',
            badge: '/icons/icon.svg',
            tag: 'olm-completed',
            renotify: true,
          });
          return;
        }
      } catch {
        /* fallback */
      }
    }

    // 3. Fallback Web Notification API
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(title, { body, icon: '/icons/icon.svg' });
      } catch {}
    }
  }

  return {
    $,
    $$,
    el,
    escapeHtml,
    formatTime,
    formatDateTime,
    debounce,
    appendLog,
    syncLogs,
    clearLog,
    setLogFilter,
    setStatus,
    setRunStatus,
    toast,
    notify,
    playBeep,
  };
})();