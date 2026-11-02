'use strict';

(() => {
  const { $, $$, el, escapeHtml, formatDateTime, debounce, appendLog, clearLog, setLogFilter, setStatus, setRunStatus, toast, notify } = UI;

  const state = {
    tab: 'login',
    homeworks: [],
    selected: new Set(),
    runId: null,
    runningHomeworks: [],
    currentHwLogFilter: 'all',
    filter: 'todo',
    es: null,
    currentUser: '',
    settings: {
      scoreTarget: '10',
      speed: 'normal',
      engine: 'auto',
      concurrency: 2,
      submitDelayMinutes: 0,
    },
  };

  // ------------------------------------------------------------- boot

  document.addEventListener('DOMContentLoaded', async () => {
    loadSettings();
    bindTabs();
    bindLogin();
    bindHomework();
    bindLogTabs();
    bindSettings();
    bindNotifications();
    registerSW();
    connectEvents();
    await checkSession();
  });

  // ------------------------------------------------------------- tabs

  let bgKeepAliveCtx = null;
  function startBgKeepAlive() {
    try {
      if (!bgKeepAliveCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          bgKeepAliveCtx = new AudioCtx();
          const osc = bgKeepAliveCtx.createOscillator();
          const gain = bgKeepAliveCtx.createGain();
          gain.gain.setValueAtTime(0.0001, bgKeepAliveCtx.currentTime);
          osc.connect(gain);
          gain.connect(bgKeepAliveCtx.destination);
          osc.start();
        }
      }
    } catch {}
  }

  function stopBgKeepAlive() {
    try {
      if (bgKeepAliveCtx) {
        bgKeepAliveCtx.close().catch(() => {});
        bgKeepAliveCtx = null;
      }
    } catch {}
  }

  function updateAuthTabs(isLoggedIn) {
    const loginTab = $('#tab-nav-login');
    const logoutTab = $('#tab-nav-logout');
    if (loginTab) loginTab.style.display = isLoggedIn ? 'none' : '';
    if (logoutTab) logoutTab.style.display = isLoggedIn ? '' : 'none';
  }

  function bindTabs() {
    $$('#tabbar .tab').forEach((btn) => {
      if (btn.id === 'tab-nav-logout') {
        btn.addEventListener('click', doLogout);
      } else {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      }
    });
    const sBtn = $('#btn-settings');
    if (sBtn) sBtn.addEventListener('click', () => switchTab('settings'));
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
    if (tab === 'homework' && state.homeworks.length === 0 && Api.token()) {
      refreshHomeworks();
    }
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
      errorBox.textContent = 'Vui lòng nhập đủ tài khoản và mật khẩu.';
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
      // Save credentials persistently for permanent login until manual logout
      Api.saveCredentials(username, password);
      state.currentUser = res.username || username;
      updateSessionDisplay(state.currentUser);

      $('#in-password').value = '';
      setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
      appendLog({ ts: Date.now(), level: 'success', message: `Đăng nhập thành công (${state.currentUser})` });
      updateAuthTabs(true);
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
    // 1. If token exists, test active session
    if (Api.token()) {
      try {
        const res = await Api.session();
        state.currentUser = res.username || 'OLM User';
        updateSessionDisplay(state.currentUser);
        setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
        updateAuthTabs(true);
        switchTab('homework');
        await refreshHomeworks();
        return;
      } catch (err) {
        console.warn('Session expired on server, checking stored credentials...');
      }
    }

    // 2. Persistent Login: If session expired on server but credentials are saved, auto-relogin silently
    const creds = Api.getCredentials ? Api.getCredentials() : null;
    if (creds && creds.username && creds.password) {
      try {
        setStatus('Đang khôi phục phiên OLM…', 'busy');
        const res = await Api.login(creds.username, creds.password);
        Api.setToken(res.sessionId);
        state.currentUser = res.username || creds.username;
        updateSessionDisplay(state.currentUser);
        setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
        appendLog({ ts: Date.now(), level: 'success', message: `Tự động khôi phục phiên (${state.currentUser})` });
        updateAuthTabs(true);
        switchTab('homework');
        await refreshHomeworks();
        return;
      } catch (err) {
        console.warn('Auto-relogin failed:', err.message);
      }
    }

    // 3. Fallback: Show login view
    Api.setToken('');
    updateAuthTabs(false);
    setStatus('Chưa đăng nhập', '');
    switchTab('login');
  }

  function updateSessionDisplay(username) {
    const info = $('#session-username-info');
    if (info) {
      info.textContent = username
        ? `Đang đăng nhập với tài khoản: ${username}. Phiên được lưu vĩnh viễn trên thiết bị này.`
        : 'Chưa đăng nhập tài khoản OLM.';
    }
  }

  // -------------------------------------------------------- homeworks

  function bindHomework() {
    $('#btn-refresh').addEventListener('click', refreshHomeworks);
    $('#btn-select-all').addEventListener('click', toggleSelectAll);
    $('#btn-start').addEventListener('click', startRun);

    // Filter Chips
    const filterBtns = {
      todo: $('#btn-filter-todo'),
      retry: $('#btn-filter-retry'),
      all: $('#btn-filter-all'),
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

    // Stat cards quick filter
    const statCards = {
      todo: $('#stat-todo-card'),
      retry: $('#stat-retry-card'),
      done: $('#stat-done-card'),
    };
    Object.entries(statCards).forEach(([fKey, card]) => {
      if (!card) return;
      card.addEventListener('click', () => {
        state.filter = fKey;
        Object.values(filterBtns).forEach((b) => b && b.classList.remove('active'));
        if (filterBtns[fKey]) filterBtns[fKey].classList.add('active');
        renderHomeworks();
      });
    });

    // Custom Homework Link toggle & submit
    const toggleAddBtn = $('#btn-toggle-add-hw');
    const closeAddBtn = $('#btn-close-add-hw');
    const addBox = $('#box-custom-hw');
    const addHwBtn = $('#btn-add-hw');
    const customHwInput = $('#in-custom-hw');

    if (toggleAddBtn && addBox) {
      toggleAddBtn.addEventListener('click', () => {
        addBox.hidden = !addBox.hidden;
        if (!addBox.hidden && customHwInput) customHwInput.focus();
      });
    }

    if (closeAddBtn && addBox) {
      closeAddBtn.addEventListener('click', () => {
        addBox.hidden = true;
      });
    }

    if (addHwBtn && customHwInput) {
      const handleAdd = () => {
        const val = customHwInput.value.trim();
        if (!val) {
          toast('Vui lòng dán link bài tập OLM', 'warn');
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
            canRetry: false,
          };
          if (!state.homeworks.some((h) => h.id === newItem.id || h.url === newItem.url)) {
            state.homeworks.unshift(newItem);
          }
          state.selected.add(newItem.id);
          renderHomeworks();
          toast('Đã thêm bài tập!', 'ok');
          customHwInput.value = '';
          if (addBox) addBox.hidden = true;
        } catch {
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
      list.innerHTML = '<div class="empty">Đang tải danh sách bài tập OLM…</div>';
    }
    setStatus('Đang quét bài tập…', 'busy');

    try {
      const res = await Api.homeworks();
      const serverHws = res.homeworks || [];
      const customHws = state.homeworks.filter((h) => h.subject === 'Tự thêm');
      state.homeworks = [...customHws, ...serverHws.filter((sh) => !customHws.some((ch) => ch.id === sh.id))];

      // REQUIREMENT: DO NOT auto-select all homeworks by default
      state.selected.clear();

      renderHomeworks();
      const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
      setStatus(`Sẵn sàng (${todoCount} bài chưa làm)`, 'on');
      appendLog({
        ts: Date.now(),
        level: 'info',
        message: `Đã quét được ${res.count} bài tập (${todoCount} bài chưa làm) từ OLM`,
      });
    } catch (err) {
      if (!state.homeworks.length) {
        list.innerHTML = `<div class="empty">Không quét được danh sách bài tập tự động.<br><span class="muted small">Vui lòng bấm "+ Dán link bài" ở trên để giải bài OLM mong muốn!</span></div>`;
      }
      setStatus('Sẵn sàng làm bài', 'on');
      appendLog({ ts: Date.now(), level: 'warn', message: `Chưa quét được bài: ${err.message}` });
    }
  }

  function renderHomeworks() {
    const list = $('#hw-list');
    list.innerHTML = '';

    const filter = state.filter || 'todo';
    const totalCount = state.homeworks.length;
    const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
    const retryCount = state.homeworks.filter((h) => Boolean(h.canRetry || (h.isDone && !h.isExpired))).length;
    const doneCount = state.homeworks.filter((h) => Boolean(h.isDone)).length;
    const expiredCount = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone)).length;

    // Update dynamic top stat counters
    const sTodo = $('#stat-todo');
    const sRetry = $('#stat-retry');
    const sDone = $('#stat-done');
    if (sTodo) sTodo.textContent = String(todoCount);
    if (sRetry) sRetry.textContent = String(retryCount);
    if (sDone) sDone.textContent = String(doneCount);

    // Update filter counters in chips
    const cTodo = $('#cnt-todo');
    const cRetry = $('#cnt-retry');
    const cAll = $('#cnt-all');
    const cDone = $('#cnt-done');
    const cExp = $('#cnt-expired');
    if (cTodo) cTodo.textContent = String(todoCount);
    if (cRetry) cRetry.textContent = String(retryCount);
    if (cAll) cAll.textContent = String(totalCount);
    if (cDone) cDone.textContent = String(doneCount);
    if (cExp) cExp.textContent = String(expiredCount);

    // Update active highlight on stats card
    const cardTodo = $('#stat-todo-card');
    const cardRetry = $('#stat-retry-card');
    const cardDone = $('#stat-done-card');
    if (cardTodo) cardTodo.classList.toggle('active', filter === 'todo');
    if (cardRetry) cardRetry.classList.toggle('active', filter === 'retry');
    if (cardDone) cardDone.classList.toggle('active', filter === 'done');

    // Filter items
    let items = state.homeworks;
    if (filter === 'todo') {
      items = state.homeworks.filter((h) => !h.isDone && !h.isExpired);
    } else if (filter === 'retry') {
      // FILTER REQUIREMENT: bài nào cho luyện tập lại thì lọc ra để làm lại bài đấy
      items = state.homeworks.filter((h) => Boolean(h.canRetry || (h.isDone && !h.isExpired)));
    } else if (filter === 'done') {
      items = state.homeworks.filter((h) => Boolean(h.isDone));
    } else if (filter === 'expired') {
      items = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));
    }

    if (!items.length) {
      let emptyMsg = 'Chưa có bài tập nào trong danh mục này.';
      if (filter === 'todo') {
        emptyMsg = '🎉 Tuyệt vời! Bạn không còn bài tập nào chưa làm.<br><span class="muted small">Chọn tab "Luyện tập lại" hoặc "Tất cả" để làm thêm bài.</span>';
      } else if (filter === 'retry') {
        emptyMsg = 'Hiện tại không có bài nào có thể luyện tập lại.<br><span class="muted small">Các bài đã hoàn thành có thể mở lại khi giáo viên cho phép.</span>';
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
      const canRetry = Boolean(hw.canRetry || (isDone && !isExpired));

      const card = el('div', { class: `hw-card ${checkbox.checked ? 'selected' : ''}` });
      card.append(checkbox);

      const body = el('div', { class: 'hw-body' });
      body.append(el('div', { class: 'hw-title', text: hw.title }));

      const meta = el('div', { class: 'hw-meta' });
      if (hw.subject) meta.append(el('span', { class: 'tag', text: hw.subject }));
      if (hw.deadline) meta.append(el('span', { class: 'tag warn', text: `Hạn: ${hw.deadline}` }));

      if (canRetry && (isDone || filter === 'retry')) {
        meta.append(el('span', { class: 'tag retry', text: '🔄 Luyện tập lại' }));
      }

      if (isDone) {
        const scoreTxt = hw.score !== null && hw.score !== undefined ? `✓ Đã xong (${hw.score}đ)` : '✓ Đã xong';
        meta.append(el('span', { class: 'tag ok', text: scoreTxt }));
      } else if (isExpired) {
        meta.append(el('span', { class: 'tag err', text: '✕ Hết hạn' }));
      } else {
        meta.append(el('span', { class: 'tag warn', text: '● Chưa làm' }));
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
    else if (filter === 'retry') visibleItems = state.homeworks.filter((h) => Boolean(h.canRetry || (h.isDone && !h.isExpired)));
    else if (filter === 'done') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone));
    else if (filter === 'expired') visibleItems = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));

    const allSelected = visibleItems.length > 0 && visibleItems.every((h) => state.selected.has(h.id));
    if (allSelected) {
      for (const h of visibleItems) state.selected.delete(h.id);
    } else {
      for (const h of visibleItems) state.selected.add(h.id);
    }
    renderHomeworks();
  }

  function updateSummary() {
    const count = state.selected.size;
    const txtSelectAll = $('#txt-select-all');

    const filter = state.filter || 'todo';
    let visibleItems = state.homeworks;
    if (filter === 'todo') visibleItems = state.homeworks.filter((h) => !h.isDone && !h.isExpired);
    else if (filter === 'retry') visibleItems = state.homeworks.filter((h) => Boolean(h.canRetry || (h.isDone && !h.isExpired)));
    else if (filter === 'done') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone));
    else if (filter === 'expired') visibleItems = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));

    const allSelected = visibleItems.length > 0 && visibleItems.every((h) => state.selected.has(h.id));
    if (txtSelectAll) txtSelectAll.textContent = allSelected ? 'Bỏ chọn' : 'Chọn tất cả';

    const stickySummary = $('#sticky-summary');
    if (stickySummary) stickySummary.textContent = count ? `Đã chọn ${count} bài` : 'Chưa chọn bài nào';
    const startBtn = $('#btn-start');
    if (startBtn) {
      startBtn.disabled = count === 0;
      startBtn.textContent = count > 1 ? `Bắt đầu giải ${count} bài` : (count === 1 ? 'Bắt đầu giải 1 bài' : 'Bắt đầu làm bài');
    }
  }

  // ------------------------------------------------------ start a run

  async function startRun() {
    const selected = state.homeworks.filter((h) => state.selected.has(h.id));
    if (!selected.length) return;

    // Concurrency & settings
    const config = {
      scoreTarget: state.settings.scoreTarget || '10',
      submitDelayMinutes: state.settings.submitDelayMinutes || 0,
      speed: state.settings.speed || 'normal',
      engine: state.settings.engine || 'auto',
      concurrency: Number(state.settings.concurrency || 2),
    };

    const btn = $('#btn-start');
    btn.disabled = true;
    btn.textContent = 'Đang khởi động…';

    try {
      // Request notification permission if not yet decided
      if (window.Capacitor?.Plugins?.LocalNotifications) {
        window.Capacitor.Plugins.LocalNotifications.requestPermissions().catch(() => {});
      } else if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
      startBgKeepAlive();

      const res = await Api.startRun(selected, config);
      state.runId = res.runId;
      state.runningHomeworks = selected.map((h, i) => ({ id: h.id, title: h.title, status: 'pending', index: i }));

      // Setup homework chips for individual logs
      renderHwLogChips(state.runningHomeworks);

      appendLog({
        ts: Date.now(),
        level: 'info',
        message: `🚀 Bắt đầu giải ${res.homeworks} bài (Đa luồng: ${config.concurrency} bài cùng lúc, Target: ${config.scoreTarget}đ)`,
      });
      setRunStatus('running');
      setStatus('Đang giải bài…', 'busy');
      const pText = $('#run-progress-text');
      if (pText) pText.textContent = `Đang giải ${selected.length} bài (song song ${config.concurrency} bài)`;

      switchTab('log');
    } catch (err) {
      stopBgKeepAlive();
      toast(err.message, 'error');
      appendLog({ ts: Date.now(), level: 'error', message: `Khởi chạy lỗi: ${err.message}` });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Bắt đầu làm bài';
      updateSummary();
    }
  }

  // ------------------------------------------------ Log per homework tabs

  function bindLogTabs() {
    const clearBtn = $('#btn-clear-log');
    if (clearBtn) clearBtn.addEventListener('click', clearLog);
  }

  function renderHwLogChips(homeworks) {
    const container = $('#hw-log-chips');
    if (!container) return;
    container.innerHTML = '';

    // "Tất cả bài" chip
    const allChip = el('button', {
      class: `hw-log-chip ${state.currentHwLogFilter === 'all' ? 'active' : ''}`,
      dataset: { hwId: 'all' },
    }, el('span', { text: '📋 Tất cả bài' }));

    allChip.addEventListener('click', () => {
      state.currentHwLogFilter = 'all';
      $$('#hw-log-chips .hw-log-chip').forEach((c) => c.classList.remove('active'));
      allChip.classList.add('active');
      setLogFilter('all');
    });
    container.append(allChip);

    // Individual homework chips
    for (const hw of homeworks) {
      const chip = el('button', {
        class: `hw-log-chip ${state.currentHwLogFilter === hw.id ? 'active' : ''}`,
        id: `chip-hw-${hw.id}`,
        dataset: { hwId: hw.id },
      });

      const dot = el('span', { class: `dot-status ${hw.status || 'running'}` });
      const label = el('span', { text: hw.title.length > 18 ? `${hw.title.slice(0, 16)}…` : hw.title });
      chip.append(dot, label);

      chip.addEventListener('click', () => {
        state.currentHwLogFilter = hw.id;
        $$('#hw-log-chips .hw-log-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        setLogFilter(hw.id);
      });

      container.append(chip);
    }
  }

  function updateHwChipStatus(hwId, status) {
    const chip = document.getElementById(`chip-hw-${hwId}`);
    if (!chip) return;
    const dot = chip.querySelector('.dot-status');
    if (dot) dot.className = `dot-status ${status}`;
  }

  // --------------------------------------------------------- settings

  function bindSettings() {
    $$('#opt-score input').forEach((radio) => {
      radio.addEventListener('change', () => {
        state.settings.scoreTarget = radio.value;
        saveSettings();
      });
    });

    $$('#opt-concurrency button').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.settings.concurrency = Number(btn.dataset.concurrency);
        $$('#opt-concurrency button').forEach((b) => b.classList.toggle('active', b === btn));
        saveSettings();
        toast(`Đã chọn ${state.settings.concurrency} bài cùng lúc`, 'ok');
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

    const logoutBtn = $('#btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', doLogout);

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

  function bindNotifications() {
    const btnEnable = $('#btn-enable-notify');
    const btnTest = $('#btn-test-notify');
    const btnQuick = $('#btn-quick-notify');
    const statusTxt = $('#notify-status');

    async function checkPermStatus() {
      if (window.Capacitor?.Plugins?.LocalNotifications) {
        try {
          const check = await window.Capacitor.Plugins.LocalNotifications.checkPermissions();
          return check?.display || 'prompt';
        } catch {
          return 'prompt';
        }
      }
      if ('Notification' in window) {
        return Notification.permission;
      }
      return 'unsupported';
    }

    async function updateNotifyStatus() {
      const perm = await checkPermStatus();
      if (perm === 'granted') {
        if (statusTxt) {
          statusTxt.textContent = '✔ Đã bật thông báo! iPhone sẽ hiện banner và phát chuông khi bài giải xong.';
          statusTxt.style.color = 'var(--ok)';
        }
        if (btnEnable) {
          btnEnable.textContent = '✔ Đã bật thông báo (Banner iOS)';
          btnEnable.disabled = true;
        }
        if (btnQuick) btnQuick.style.color = 'var(--ok)';
      } else if (perm === 'denied') {
        if (statusTxt) {
          statusTxt.textContent = '✕ Quyền thông báo đã bị từ chối trong Cài đặt iPhone.';
          statusTxt.style.color = 'var(--err)';
        }
        if (btnEnable) {
          btnEnable.textContent = 'Bị chặn trong Cài đặt';
          btnEnable.disabled = false;
        }
      } else if (perm === 'unsupported') {
        if (statusTxt) {
          statusTxt.textContent = 'Thiết bị hoặc trình duyệt không hỗ trợ thông báo đẩy.';
          statusTxt.style.color = 'var(--text-dim)';
        }
      } else {
        if (statusTxt) {
          statusTxt.textContent = 'Chưa bật thông báo. Bấm nút dưới để nhận banner khi giải xong.';
          statusTxt.style.color = 'var(--text-dim)';
        }
        if (btnEnable) {
          btnEnable.textContent = 'Bật thông báo khi giải xong';
          btnEnable.disabled = false;
        }
      }
    }

    const requestPerm = async () => {
      // 1. Capacitor Native LocalNotifications (iOS App)
      if (window.Capacitor?.Plugins?.LocalNotifications) {
        try {
          const res = await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
          await updateNotifyStatus();
          if (res?.display === 'granted') {
            toast('Đã bật thông báo iOS thành công!', 'ok');
            await notify('OLM Solver', 'Thông báo đã kích hoạt! Banner & âm thanh sẵn sàng như Messenger.');
            return;
          } else {
            toast('Quyền thông báo chưa được cấp', 'warn');
            return;
          }
        } catch (err) {
          console.warn('Capacitor requestPermissions error:', err);
        }
      }

      // 2. Web Notification fallback
      if ('Notification' in window) {
        try {
          const res = await Notification.requestPermission();
          await updateNotifyStatus();
          if (res === 'granted') {
            toast('Đã bật thông báo thành công!', 'ok');
            await notify('OLM Solver', 'Thông báo đã sẵn sàng trên thiết bị của bạn!');
          } else {
            toast('Chưa cho phép thông báo', 'warn');
          }
        } catch (err) {
          console.warn('Notification.requestPermission error:', err);
        }
      }
    };

    if (btnEnable) btnEnable.addEventListener('click', requestPerm);
    if (btnQuick) btnQuick.addEventListener('click', requestPerm);

    if (btnTest) {
      btnTest.addEventListener('click', async () => {
        toast('Đang gửi thử thông báo...', 'info');
        await notify('OLM Solver - Hoàn tất', 'Đã giải xong tất cả các bài tập! Điểm số: 10/10 🎉');
      });
    }

    updateNotifyStatus();
  }

  async function doLogout() {
    if (confirm('Bạn có chắc chắn muốn đăng xuất tài khoản OLM?')) {
      try {
        await Api.logout();
      } catch {
        /* ignore */
      }
      // Explicit logout clears stored credentials
      Api.clearCredentials();
      Api.setToken('');
      state.homeworks = [];
      state.selected.clear();
      state.currentUser = '';
      clearLog();
      setStatus('Chưa đăng nhập', '');
      updateSessionDisplay('');
      updateAuthTabs(false);
      switchTab('login');
      toast('Đã đăng xuất tài khoản', 'info');
    }
  }

  function loadSettings() {
    const saved = Api.loadSettings();
    state.settings = { ...state.settings, ...saved };

    const scoreRadio = $(`#opt-score input[value="${state.settings.scoreTarget || '10'}"]`);
    if (scoreRadio) scoreRadio.checked = true;

    const delayRadio = $(`#opt-delay input[value="${state.settings.submitDelayMinutes ?? 0}"]`);
    if (delayRadio) delayRadio.checked = true;

    const concurrency = state.settings.concurrency || 2;
    $$('#opt-concurrency button').forEach((b) => b.classList.toggle('active', Number(b.dataset.concurrency) === concurrency));

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

    es.onopen = () => {
      if (state.tab === 'homework') {
        setStatus('Sẵn sàng làm bài', 'on');
      } else if (state.tab === 'login') {
        setStatus(Api.token() ? 'Đã đăng nhập' : 'Chưa đăng nhập', Api.token() ? 'on' : '');
      } else {
        setStatus('Đã kết nối máy chủ', 'on');
      }
    };

    es.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      if (data.message && data.level) {
        appendLog({
          ts: data.ts || Date.now(),
          level: data.level,
          message: data.message,
          hwId: data.hwId || null,
        });
      }

      if (data.type === 'started') {
        setRunStatus('running');
      } else if (data.type === 'scan-progress') {
        const pText = $('#run-progress-text');
        if (pText) pText.textContent = `Đang quét câu ${data.completed}/${data.total}…`;
      } else if (data.type === 'solve-progress') {
        const pText = $('#run-progress-text');
        if (pText) pText.textContent = `Đang xử lý ${data.completed}/${data.total} câu…`;
      } else if (data.type === 'fill-progress') {
        const pText = $('#run-progress-text');
        if (pText) pText.textContent = `Đang điền câu ${data.completed}/${data.total}…`;
      } else if (data.type === 'homework-status') {
        if (data.hwId) {
          updateHwChipStatus(data.hwId, data.status);
        }
        if (data.status === 'done') {
          appendLog({ ts: Date.now(), level: 'success', message: `✔ Hoàn thành: "${data.title || ''}"`, hwId: data.hwId });
        }
      } else if (data.type === 'done') {
        stopBgKeepAlive();
        setRunStatus('done');
        setStatus('Đã hoàn thành', 'on');
        const pText = $('#run-progress-text');
        if (pText) pText.textContent = 'Đã hoàn thành toàn bộ bài tập!';

        notify(
          'OLM Solver - Hoàn tất!',
          'Đã hoàn thành giải toàn bộ các bài tập OLM được chọn!'
        );
        toast('Đã hoàn thành toàn bộ bài tập!', 'ok');
        appendLog({ ts: Date.now(), level: 'success', message: '🎉 Hoàn tất toàn bộ bài tập.' });
      } else if (data.type === 'error') {
        stopBgKeepAlive();
        setRunStatus('error');
        setStatus('Lỗi', 'err');
      } else if (data.type === 'scheduled') {
        const schedTime = formatDateTime(new Date(data.submitAt).getTime());
        const subAt = $('#run-submit-at');
        if (subAt) subAt.textContent = `→ Nộp bài lúc: ${schedTime}`;
        appendLog({ ts: Date.now(), level: 'info', message: `Lịch nộp bài: ${schedTime}` });
      }
    };

    es.onerror = () => {
      const isMobileApp = Boolean(window.Capacitor?.isNativePlatform?.() || window.location.protocol === 'capacitor:');
      const hasCustomUrl = Boolean(Api.getServerUrl && Api.getServerUrl());
      if (isMobileApp && !hasCustomUrl) {
        setStatus('Chưa cấu hình máy chủ', 'warn');
      } else {
        setStatus('Mất kết nối máy chủ', 'err');
      }
      es.close();
      state.es = null;
      setTimeout(connectEvents, 5000);
    };
  }

  // -------------------------------------------------- service worker

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      try { reg.update(); } catch {}
    }).catch(() => {
      /* offline shell is optional */
    });
  }
})();