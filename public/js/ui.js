'use strict';

// DOM helpers and small UI widgets.

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

  // Log pane writer.
  const logList = () => document.getElementById('log-list');
  const logBuffer = [];

  function appendLog(entry) {
    logBuffer.push(entry);
    const list = logList();
    if (!list) return;

    const line = el('div', { class: `log-line ${entry.level || 'info'}` });
    line.append(el('span', { class: 'log-time', text: formatTime(entry.ts) }));
    line.append(el('span', { class: 'log-msg', text: entry.message }));
    list.append(line);

    // Keep the DOM bounded on long runs.
    while (list.children.length > 500) list.removeChild(list.firstChild);

    list.scrollTop = list.scrollHeight;
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
    pill.textContent = status;
    pill.className = `pill ${status === 'running' ? 'running' : status === 'done' ? 'done' : status === 'error' ? 'error' : ''}`;
  }

  function toast(message, kind = 'info') {
    const view = document.getElementById('view-login');
    let box = document.getElementById('login-error');
    if (!box) {
      box = el('div', { id: 'toast', class: `alert alert-${kind}` });
      box.style.position = 'fixed';
      box.style.left = '16px';
      box.style.right = '16px';
      box.style.bottom = 'calc(var(--tabbar-h) + var(--safe-bottom) + 16px)';
      box.style.zIndex = '100';
      document.body.append(box);
    }
    box.className = `alert alert-${kind}`;
    box.textContent = message;
    box.hidden = false;
    clearTimeout(box._timer);
    box._timer = setTimeout(() => {
      box.hidden = true;
    }, 4000);
    return view;
  }

  return { $, $$, el, escapeHtml, formatTime, formatDateTime, debounce, appendLog, clearLog, setStatus, setRunStatus, toast };
})();