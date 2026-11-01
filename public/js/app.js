'use strict';

(() => {
  const { $, $$, el, escapeHtml, formatDateTime, debounce, appendLog, clearLog, setStatus, setRunStatus, toast } = UI;

  const state = {
    tab: 'login',
    homeworks: [],
    selected: new Set(),
    runId: null,
    es: null,
    settings: {
      scoreTarget: 'high',
      speed: 'normal',
      engine: 'auto',
      windowEnabled: false,
      windowStart: '19:00',
      windowEnd: '21:00',
    },
  };

  // ------------------------------------------------------------- boot

  document.addEventListener('DOMContentLoaded', async () => {
    loadSettings();
    bindTabs();
    bindLogin();
    bindHomework();
    bindSettings();
    registerSW();
    connectEvents();
    await checkSession();
  });

  // ------------------------------------------------------------- tabs

  function bindTabs() {
    $$('#tabbar .tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('#btn-settings').addEventListener('click', () => switchTab('settings'));
  }

  function switchTab(tab) {
    state.tab = tab;
    ['login', 'homework', 'log', 'settings'].forEach((name) => {
      const view = $(`#view-${name}`);
      if (view) view.hidden = name !== tab;
    });
    $$('#tabbar .tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    if (tab === 'homework' && state.homeworks.length === 0) refreshHomeworks();
  }

  // ----------------------------------------------------------- login

  function bindLogin() {
    $('#btn-login').addEventListener('click', doLogin);
    $('#btn-login-rescan').addEventListener('click', doLogin);
    $('#in-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    $('#in-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#in-password').focus();
    });
  }

  async function doLogin() {
    const username = $('#in-username').value.trim();
    const password = $('#in-password').value;
    const errorBox = $('#login-error');

    errorBox.hidden = true;

    if (!username || !password) {
      errorBox.textContent = 'Nhập đủ tài khoản và mật khẩu.';
      errorBox.hidden = false;
      return;
    }

    const btn = $('#btn-login');
    btn.disabled = true;
    btn.textContent = 'Đang đăng nhập…';
    setStatus('Đang kết nối OLM…', 'busy');

    try {
      const res = await Api.login(username, password);
      Api.setToken(res.sessionId);
      $('#in-password').value = '';
      setStatus(`Đã đăng nhập: ${res.username}`, 'on');
      appendLog({ ts: Date.now(), level: 'success', message: `Đăng nhập thành công (${res.username})` });
      switchTab('homework');
      await refreshHomeworks();
    } catch (err) {
      errorBox.textContent = err.message || 'Đăng nhập thất bại.';
      errorBox.hidden = false;
      setStatus('Đăng nhập thất bại', 'err');
      appendLog({ ts: Date.now(), level: 'error', message: `Login failed: ${err.message}` });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Đăng nhập';
    }
  }

  async function checkSession() {
    if (!Api.token()) {
      switchTab('login');
      return;
    }
    try {
      const res = await Api.session();
      setStatus(`Đã đăng nhập: ${res.username}`, 'on');
      switchTab('homework');
      await refreshHomeworks();
    } catch {
      Api.setToken('');
      switchTab('login');
    }
  }

  // -------------------------------------------------------- homeworks

  function bindHomework() {
    $('#btn-refresh').addEventListener('click', refreshHomeworks);
    $('#btn-select-all').addEventListener('click', toggleSelectAll);
    $('#btn-start').addEventListener('click', startRun);

    const filterBtns = {
      all: $('#btn-filter-all'),
      todo: $('#btn-filter-todo'),
      done: $('#btn-filter-done'),
      expired: $('#btn-filter-expired'),
    };

    Object.entries(filterBtns).forEach(([fKey, btn]) => {
      if (!btn) return;
      btn.addEventListener('click', () => {
        state.filter = fKey;
        Object.values(filterBtns).forEach((b) => b && b.classList.remove('active'));
        btn.classList.add('active');
        renderHomeworks();
      });
    });

    const addHwBtn = $('#btn-add-hw');
    const customHwInput = $('#in-custom-hw');
    if (addHwBtn && customHwInput) {
      const handleAdd = () => {
        const val = customHwInput.value.trim();
        if (!val) {
          toast('Vui lòng dán link bài tập', 'warn');
          return;
        }
        try {
          const u = new URL(val, 'https://olm.vn');
          const id = u.pathname.split('/').filter(Boolean).pop() || `hw_${Date.now()}`;
          const title = `Bài tập (${id})`;
          const newItem = {
            id: String(id),
            title: title,
            url: u.toString(),
            subject: 'Tự thêm',
            deadline: '',
            status: 'Chưa làm',
            isDone: false,
            isExpired: false,
          };
          if (!state.homeworks.some((h) => h.id === newItem.id || h.url === newItem.url)) {
            state.homeworks.unshift(newItem);
          }
          state.selected.add(newItem.id);
          renderHomeworks();
          toast(`Đã thêm bài tập!`, 'ok');
          customHwInput.value = '';
        } catch (e) {
          toast('Đường link không hợp lệ', 'error');
        }
      };

      addHwBtn.addEventListener('click', handleAdd);
      customHwInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAdd();
      });
    }
  }

  async function refreshHomeworks() {
    const list = $('#hw-list');
    if (!state.homeworks.length) {
      list.innerHTML = '<div class="empty">Đang tải danh sách bài tập…</div>';
    }
    setStatus('Đang quét bài tập…', 'busy');

    try {
      const res = await Api.homeworks();
      const serverHws = res.homeworks || [];
      const customHws = state.homeworks.filter((h) => h.subject === 'Tự thêm');
      state.homeworks = [...customHws, ...serverHws.filter((sh) => !customHws.some((ch) => ch.id === sh.id))];

      // Auto-select all unfinished homeworks by default
      state.selected.clear();
      for (const hw of state.homeworks) {
        if (!hw.isDone && !hw.isExpired) {
          state.selected.add(hw.id);
        }
      }

      renderHomeworks();
      const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
      setStatus(`Có ${todoCount} bài chưa làm / ${state.homeworks.length} bài`, 'on');
      appendLog({
        ts: Date.now(),
        level: 'info',
        message: `Đã quét được ${res.count} bài tập (${todoCount} bài chưa làm) từ ${res.source}`,
      });
    } catch (err) {
      if (!state.homeworks.length) {
        list.innerHTML = `<div class="empty">Không tự động dò được danh sách bài tập.<br><span class="muted small">Vui lòng dán trực tiếp link bài tập OLM vào ô bên trên để bắt đầu giải!</span></div>`;
      }
      setStatus('Sẵn sàng làm bài', 'on');
      appendLog({ ts: Date.now(), level: 'warn', message: `Chưa tự động quét được bài: ${err.message}` });
    }
  }

  function renderHomeworks() {
    const list = $('#hw-list');
    list.innerHTML = '';

    const filter = state.filter || 'todo';
    const totalCount = state.homeworks.length;
    const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
    const doneCount = state.homeworks.filter((h) => !!h.isDone).length;
    const expiredCount = state.homeworks.filter((h) => !!h.isExpired && !h.isDone).length;

    // Update filter buttons text with dynamic counters
    const bAll = $('#btn-filter-all');
    const bTodo = $('#btn-filter-todo');
    const bDone = $('#btn-filter-done');
    const bExp = $('#btn-filter-expired');
    if (bAll) bAll.textContent = `Tất cả (${totalCount})`;
    if (bTodo) bTodo.textContent = `Chưa làm (${todoCount})`;
    if (bDone) bDone.textContent = `Đã xong (${doneCount})`;
    if (bExp) bExp.textContent = `Hết hạn (${expiredCount})`;

    let items = state.homeworks;
    if (filter === 'todo') {
      items = state.homeworks.filter((h) => !h.isDone && !h.isExpired);
    } else if (filter === 'done') {
      items = state.homeworks.filter((h) => !!h.isDone);
    } else if (filter === 'expired') {
      items = state.homeworks.filter((h) => !!h.isExpired && !h.isDone);
    }

    if (!items.length) {
      let emptyMsg = 'Chưa có bài tập trong danh mục này.';
      if (filter === 'todo') {
        emptyMsg = 'Tuyệt vời! Không còn bài tập nào chưa làm.<br><span class="muted small">Bấm tab "Tất cả" hoặc "Đã xong" để xem lại các bài tập.</span>';
      } else if (filter === 'done') {
        emptyMsg = 'Chưa có bài tập nào đã hoàn thành.';
      } else if (filter === 'expired') {
        emptyMsg = 'Không có bài tập nào bị hết hạn.';
      }
      list.innerHTML = `<div class="empty">${emptyMsg}</div>`;
      updateSummary();
      return;
    }

    for (const hw of items) {
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = state.selected.has(hw.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(hw.id);
        else state.selected.delete(hw.id);
        card.classList.toggle('selected', checkbox.checked);
        updateSummary();
      });

      const isDone = !!hw.isDone;
      const isExpired = !!hw.isExpired;
      const card = el('div', { class: `hw-card ${checkbox.checked ? 'selected' : ''} ${isDone ? 'hw-done' : ''}` });
      if (isDone) {
        card.style.opacity = '0.75';
      }
      card.append(checkbox);

      const body = el('div', { class: 'hw-body' });
      body.append(el('div', { class: 'hw-title', text: hw.title }));

      const meta = el('div', { class: 'hw-meta' });
      if (hw.subject) meta.append(el('span', { class: 'tag', text: hw.subject }));
      if (hw.deadline) meta.append(el('span', { class: 'tag warn', text: `Hạn: ${hw.deadline}` }));
      
      if (isDone) {
        const scoreTxt = (hw.score !== null && hw.score !== undefined) ? `✓ Đã xong (${hw.score}đ)` : '✓ Đã xong';
        meta.append(el('span', { class: 'tag ok', text: scoreTxt }));
      } else if (isExpired) {
        meta.append(el('span', { class: 'tag err', text: '✕ Hết hạn' }));
      } else {
        meta.append(el('span', { class: 'tag warn', style: 'background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4);', text: '● Chưa làm' }));
      }
      body.append(meta);

      card.append(body);
      card.addEventListener('click', (e) => {
        if (e.target !== checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      });

      list.append(card);
    }

    updateSummary();
  }

  function toggleSelectAll() {
    const filter = state.filter || 'todo';
    let visibleItems = state.homeworks;
    if (filter === 'todo') visibleItems = state.homeworks.filter((h) => !h.isDone && !h.isExpired);
    else if (filter === 'done') visibleItems = state.homeworks.filter((h) => !!h.isDone);
    else if (filter === 'expired') visibleItems = state.homeworks.filter((h) => !!h.isExpired && !h.isDone);

    const allSelected = visibleItems.length > 0 && visibleItems.every((h) => state.selected.has(h.id));
    if (allSelected) {
      for (const h of visibleItems) state.selected.delete(h.id);
    } else {
      for (const h of visibleItems) state.selected.add(h.id);
    }
    renderHomeworks();
  }

  function updateSummary() {
    const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
    $('#hw-count').textContent = String(todoCount);

    const count = state.selected.size;
    $('#sticky-summary').textContent = count ? `Đã chọn ${count} bài` : 'Chưa chọn bài nào';
    const startBtn = $('#btn-start');
    startBtn.disabled = count === 0;
    startBtn.textContent = count > 1 ? `Bắt đầu giải tất cả (${count} bài)` : (count === 1 ? 'Bắt đầu giải 1 bài' : 'Bắt đầu làm');
  }

  // ------------------------------------------------------ start a run

  async function startRun() {
    const selected = state.homeworks.filter((h) => state.selected.has(h.id));
    if (!selected.length) return;

    const config = {
      scoreTarget: state.settings.scoreTarget || '10',
      submitDelayMinutes: state.settings.submitDelayMinutes || 0,
      speed: state.settings.speed,
      engine: state.settings.engine,
    };

    const btn = $('#btn-start');
    btn.disabled = true;
    btn.textContent = 'Đang khởi tạo…';

    try {
      const res = await Api.startRun(selected, config);
      state.runId = res.runId;
      appendLog({ ts: Date.now(), level: 'info', message: `Bắt đầu giải ${res.homeworks} bài tập (Target: ${config.scoreTarget}đ, trễ ${config.submitDelayMinutes}p)` });
      setRunStatus('running');
      setStatus('Đang làm bài…', 'busy');
      switchTab('log');
    } catch (err) {
      toast(err.message, 'error');
      appendLog({ ts: Date.now(), level: 'error', message: `run: ${err.message}` });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Bắt đầu làm';
      updateSummary();
    }
  }

  // --------------------------------------------------------- settings

  function bindSettings() {
    $$('#opt-score input').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.settings.scoreTarget = radio.value;
        saveSettings();
      });
    });

    $$('#opt-delay input').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.settings.submitDelayMinutes = Number(radio.value);
        saveSettings();
      });
    });

    $$('#opt-speed button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.speed = btn.dataset.speed;
        $$('#opt-speed button').forEach((b) => b.classList.toggle('active', b === btn));
        saveSettings();
      });
    });

    $$('#opt-engine button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.engine = btn.dataset.engine;
        $$('#opt-engine button').forEach((b) => b.classList.toggle('active', b === btn));
        saveSettings();
      });
    });

    $('#btn-logout').addEventListener('click', doLogout);
    $('#btn-stop').addEventListener('click', () => {
      appendLog({ ts: Date.now(), level: 'warn', message: 'Yêu cầu dừng run (server sẽ bỏ qua lần submit tiếp theo)' });
      toast('Đã gửi yêu cầu dừng.', 'info');
    });

    const serverInput = $('#in-server-url');
    const serverResult = $('#server-test-result');
    const saveServerBtn = $('#btn-save-server');
    const testServerBtn = $('#btn-test-server');

    if (saveServerBtn && serverInput) {
      saveServerBtn.addEventListener('click', () => {
        const val = serverInput.value.trim();
        Api.setServerUrl(val);
        toast('Đã lưu địa chỉ máy chủ.', 'info');
        connectEvents();
      });
    }

    if (testServerBtn && serverInput) {
      testServerBtn.addEventListener('click', async () => {
        const val = serverInput.value.trim();
        Api.setServerUrl(val);
        if (serverResult) {
          serverResult.textContent = 'Đang kiểm tra kết nối...';
          serverResult.style.color = 'var(--text-dim)';
        }
        try {
          const health = await Api.health();
          if (serverResult) {
            serverResult.textContent = `✓ Kết nối thành công! Engine: ${health.engine || 'auto'}`;
            serverResult.style.color = 'var(--ok)';
          }
          toast('Kết nối server thành công!', 'ok');
          connectEvents();
        } catch (err) {
          if (serverResult) {
            serverResult.textContent = `✗ ${err.message}`;
            serverResult.style.color = 'var(--err)';
          }
          toast('Không kết nối được server', 'err');
        }
      });
    }
  }


  async function doLogout() {
    try {
      await Api.logout();
    } catch {
      /* ignore */
    }
    Api.setToken('');
    state.homeworks = [];
    state.selected.clear();
    clearLog();
    setStatus('Chưa đăng nhập', '');
    switchTab('login');
  }

  function loadSettings() {
    const saved = Api.loadSettings();
    state.settings = { ...state.settings, ...saved };

    const scoreRadio = $(`#opt-score input[value="${state.settings.scoreTarget || '10'}"]`);
    if (scoreRadio) scoreRadio.checked = true;

    const delayRadio = $(`#opt-delay input[value="${state.settings.submitDelayMinutes ?? 0}"]`);
    if (delayRadio) delayRadio.checked = true;

    $$('#opt-speed button').forEach((b) => b.classList.toggle('active', b.dataset.speed === state.settings.speed));
    $$('#opt-engine button').forEach((b) => b.classList.toggle('active', b.dataset.engine === state.settings.engine));

    const serverInput = $('#in-server-url');
    if (serverInput) {
      serverInput.value = Api.getServerUrl ? Api.getServerUrl() : '';
    }
  }

  function saveSettings() {
    Api.saveSettings(state.settings);
  }

  // ------------------------------------------------------ live events

  function connectEvents() {
    if (state.es) {
      try { state.es.close(); } catch {}
      state.es = null;
    }

    const sUrl = Api.getServerUrl ? Api.getServerUrl() : '';
    const esUrl = sUrl ? `${sUrl}/api/events` : '/api/events';
    const es = new EventSource(esUrl);
    state.es = es;

    es.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.message && data.level) {
        appendLog({ ts: data.ts || Date.now(), level: data.level, message: data.message });
      }

      if (data.type === 'started') {
        setRunStatus('running');
      } else if (data.type === 'done') {
        setRunStatus('done');
        setStatus('Đã làm xong', 'on');
        const submitTime = UI.formatTime(Date.now());
        const scoreStr = state.settings.scoreTarget ? `${state.settings.scoreTarget} điểm` : '10 điểm';
        toast(`🎉 Đã nộp bài thành công lúc ${submitTime}! Mức điểm: ${scoreStr}`, 'ok');
        appendLog({ ts: Date.now(), level: 'success', message: `✓ Hoàn tất giải bài. Thời gian nộp: ${submitTime}. Mục tiêu: ${scoreStr}.` });
        // Tự động làm mới danh sách bài tập để cập nhật bộ lọc
        setTimeout(async () => {
          await refreshHomeworks();
        }, 1200);
      } else if (data.type === 'homework-status' && data.status === 'done') {
        const timeNow = UI.formatTime(Date.now());
        toast(`✓ Nộp bài "${data.title || ''}" thành công (${timeNow})`, 'ok');
      } else if (data.type === 'error') {
        setRunStatus('error');
        setStatus('Lỗi', 'err');
      } else if (data.type === 'scheduled') {
        const schedTime = formatDateTime(new Date(data.submitAt).getTime());
        $('#run-submit-at').textContent = `→ nộp lúc ${schedTime}`;
        appendLog({ ts: Date.now(), level: 'info', message: `Lịch nộp bài: ${schedTime}` });
      }
    };

    es.onerror = () => {
      setStatus('Mất kết nối SSE', 'err');
      es.close();
      state.es = null;
      setTimeout(connectEvents, 5000);
    };
  }

  // -------------------------------------------------- service worker

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline shell is optional */
    });
  }
})();