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
    bindLicense();
    registerSW();
    connectEvents();
    startAutoScan();
    const licOk = await checkLicense();
    if (licOk) {
      await checkSession();
    }
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

  // ----------------------------------------------------------- login

  let currentLoginTab = 'account';

  function bindLogin() {
    $('#btn-login').addEventListener('click', doLogin);
    $('#btn-login-rescan').addEventListener('click', doLogin);
    $('#in-password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    $('#in-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('#in-password').focus();
    });

    const tabAcc = $('#tab-login-account');
    const tabCookie = $('#tab-login-cookie');
    const formAcc = $('#login-form-account');
    const formCookie = $('#login-form-cookie');

    if (tabAcc && tabCookie) {
      tabAcc.addEventListener('click', () => {
        currentLoginTab = 'account';
        tabAcc.style.background = '#3b82f6';
        tabAcc.style.color = '#fff';
        tabCookie.style.background = 'transparent';
        tabCookie.style.color = '#9ca3af';
        if (formAcc) formAcc.hidden = false;
        if (formCookie) formCookie.hidden = true;
      });

      tabCookie.addEventListener('click', () => {
        currentLoginTab = 'cookie';
        tabCookie.style.background = '#3b82f6';
        tabCookie.style.color = '#fff';
        tabAcc.style.background = 'transparent';
        tabAcc.style.color = '#9ca3af';
        if (formAcc) formAcc.hidden = true;
        if (formCookie) formCookie.hidden = false;
        $('#in-cookie')?.focus();
      });
    }
  }

  async function doLogin() {
    const errorBox = $('#login-error');
    errorBox.hidden = true;

    const btn = $('#btn-login');

    if (currentLoginTab === 'cookie') {
      const cookie = ($('#in-cookie')?.value || '').trim();
      if (!cookie) {
        errorBox.textContent = 'Vui lòng dán chuỗi Cookie OLM.';
        errorBox.hidden = false;
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Đang kiểm tra cookie…';
      setStatus('Đang xác thực Cookie OLM…', 'busy');

      try {
        const res = await Api.loginWithCookie(cookie);
        Api.setToken(res.sessionId);
        if (Api.saveCookie) Api.saveCookie(cookie);
        state.currentUser = res.username || 'Học sinh OLM';
        updateSessionDisplay(state.currentUser);

        setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
        appendLog({ ts: Date.now(), level: 'success', message: `Đăng nhập bằng Cookie thành công (${state.currentUser})` });
        updateAuthTabs(true);
        switchTab('homework');
        await refreshHomeworks();
      } catch (err) {
        errorBox.textContent = err.message || 'Đăng nhập bằng Cookie thất bại.';
        errorBox.hidden = false;
        setStatus('Đăng nhập thất bại', 'err');
        appendLog({ ts: Date.now(), level: 'error', message: `Cookie login failed: ${err.message}` });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Đăng nhập';
      }
      return;
    }

    const username = $('#in-username').value.trim();
    const password = $('#in-password').value;

    if (!username || !password) {
      errorBox.textContent = 'Vui lòng nhập đủ tài khoản và mật khẩu.';
      errorBox.hidden = false;
      return;
    }

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
      let errMsg = err.message || 'Đăng nhập thất bại.';
      if (/cloudflare/i.test(errMsg)) {
        errMsg += ' (Bạn có thể chuyển sang tab "🍪 Dán Cookie OLM" ở trên để đăng nhập trực tiếp).';
      }
      errorBox.textContent = errMsg;
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
    const savedCookie = Api.getCookie ? Api.getCookie() : null;
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
    } else if (savedCookie) {
      try {
        setStatus('Đang khôi phục phiên OLM…', 'busy');
        const res = await Api.loginWithCookie(savedCookie);
        Api.setToken(res.sessionId);
        state.currentUser = res.username || 'Học sinh OLM';
        updateSessionDisplay(state.currentUser);
        setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
        appendLog({ ts: Date.now(), level: 'success', message: `Tự động khôi phục phiên (${state.currentUser})` });
        updateAuthTabs(true);
        switchTab('homework');
        await refreshHomeworks();
        return;
      } catch (err) {
        console.warn('Auto-cookie-relogin failed:', err.message);
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

  async function refreshHomeworks(silent = false) {
    const list = $('#hw-list');
    if (!silent && !state.homeworks.length) {
      list.innerHTML = '<div class="empty">Đang tải danh sách bài tập OLM…</div>';
    }
    if (!silent) setStatus('Đang quét bài tập…', 'busy');

    try {
      const res = await Api.homeworks();
      const serverHws = res.homeworks || [];
      const customHws = state.homeworks.filter((h) => h.subject === 'Tự thêm');
      state.homeworks = [...customHws, ...serverHws.filter((sh) => !customHws.some((ch) => ch.id === sh.id))];

      renderHomeworks();
      const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
      if (!silent) {
        setStatus(`Sẵn sàng (${todoCount} bài chưa làm)`, 'on');
        appendLog({
          ts: Date.now(),
          level: 'info',
          message: `Đã quét được ${res.count} bài tập (${todoCount} bài chưa làm) từ OLM`,
        });
      }
    } catch (err) {
      if (!silent) {
        if (!state.homeworks.length) {
          list.innerHTML = `<div class="empty">Không quét được danh sách bài tập tự động.<br><span class="muted small">Vui lòng bấm "+ Dán link bài" ở trên để giải bài OLM mong muốn!</span></div>`;
        }
        setStatus('Sẵn sàng làm bài', 'on');
        appendLog({ ts: Date.now(), level: 'warn', message: `Chưa quét được bài: ${err.message}` });
      }
    }
  }

  // Quét liên tục danh sách bài tập (mỗi 12 giây một lần ngầm)
  let autoScanTimer = null;
  function startAutoScan() {
    if (autoScanTimer) clearInterval(autoScanTimer);
    autoScanTimer = setInterval(() => {
      if (Api.token() && state.tab === 'homework' && !state.runId) {
        refreshHomeworks(true);
      }
    }, 12000);
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

      // REQUIREMENT FIX: Clear selected checkboxes right away so returning to homework tab won't cause conflict
      state.selected.clear();
      renderHomeworks();

      // Setup homework chips for individual logs
      renderHwLogChips(state.runningHomeworks);
      startSmartPolling(res.runId);

      const stopBtn = $('#btn-stop-run');
      if (stopBtn) {
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = false;
        stopBtn.textContent = '⏹ Dừng giải bài';
      }

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
      stopSmartPolling();
      if (err.code === 'NO_LICENSE' || err.code === 'INVALID_LICENSE') {
        showLicenseModal(false, err.message);
      } else if (err.code === 'NO_SESSION' || err.code === 'NO_TOKEN') {
        toast('Phiên OLM đã hết hạn (do máy chủ vừa khởi động lại). Vui lòng đăng nhập lại.', 'warn');
        updateAuthTabs(false);
        switchTab('login');
      }
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

    const stopBtn = $('#btn-stop-run');
    if (stopBtn) {
      stopBtn.addEventListener('click', async () => {
        if (!state.runId) return;
        if (confirm('Bạn có chắc chắn muốn dừng giải bài ngay lập tức?')) {
          stopBtn.disabled = true;
          stopBtn.textContent = 'Đang dừng…';
          try {
            await Api.stopRun(state.runId);
            stopSmartPolling();
            stopBgKeepAlive();
            setRunStatus('stopped');
            setStatus('Đã dừng', '');
            const pText = $('#run-progress-text');
            if (pText) pText.textContent = 'Tiến trình đã được dừng theo yêu cầu.';
            appendLog({ ts: Date.now(), level: 'warn', message: '⏹ Bạn đã dừng giải bài ngay lập tức.' });
            toast('Đã dừng tiến trình giải bài', 'warn');
          } catch (err) {
            toast(err.message || 'Lỗi dừng tiến trình', 'error');
          } finally {
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ Dừng giải bài';
            stopBtn.style.display = 'none';
          }
        }
      });
    }
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

    const cloudBtn = $('#btn-use-cloud-server');
    if (cloudBtn && serverInput) {
      cloudBtn.addEventListener('click', () => {
        serverInput.value = Api.DEFAULT_CLOUD_URL;
        Api.setServerUrl(Api.DEFAULT_CLOUD_URL);
        toast('Đã chọn máy chủ Cloud mặc định (Render)!', 'ok');
        connectEvents();
      });
    }

    // Cloudflare Tunnel public URL loader & copy
    const tunnelInput = $('#in-tunnel-url');
    const tunnelStatus = $('#tunnel-status-text');
    const copyTunnelBtn = $('#btn-copy-tunnel');

    async function loadTunnelUrl() {
      try {
        const res = await Api.tunnel();
        if (res && res.url) {
          if (tunnelInput) tunnelInput.value = res.url;
          if (tunnelStatus) {
            tunnelStatus.textContent = '✔ Đường link công khai đã sẵn sàng (mở được từ điện thoại 4G/WiFi bất kỳ)!';
            tunnelStatus.style.color = 'var(--ok)';
          }
        } else {
          if (tunnelInput) tunnelInput.placeholder = 'Chưa bật tunnel (đang chạy local/cloud)';
        }
      } catch {}
    }

    if (copyTunnelBtn && tunnelInput) {
      copyTunnelBtn.addEventListener('click', async () => {
        const val = tunnelInput.value.trim();
        if (!val) {
          toast('Chưa có đường link công khai', 'warn');
          return;
        }
        try {
          await navigator.clipboard.writeText(val);
          toast('Đã sao chép link! Mở link này trên điện thoại', 'ok');
        } catch {
          tunnelInput.select();
          document.execCommand('copy');
          toast('Đã sao chép link!', 'ok');
        }
      });
    }

    loadTunnelUrl();
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
      if (state.runId) {
        try {
          await Api.stopRun(state.runId);
        } catch {}
      }
      stopSmartPolling();
      stopBgKeepAlive();
      const stopBtn = $('#btn-stop-run');
      if (stopBtn) stopBtn.style.display = 'none';
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
        stopSmartPolling();
        setRunStatus('done');
        setStatus('Đã hoàn thành', 'on');
        const stopBtn = $('#btn-stop-run');
        if (stopBtn) stopBtn.style.display = 'none';
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
        stopSmartPolling();
        setRunStatus('error');
        setStatus('Lỗi', 'err');
        const stopBtn = $('#btn-stop-run');
        if (stopBtn) stopBtn.style.display = 'none';
      } else if (data.type === 'stopped') {
        stopBgKeepAlive();
        stopSmartPolling();
        setRunStatus('stopped');
        setStatus('Đã dừng', '');
        const pText = $('#run-progress-text');
        if (pText) pText.textContent = 'Tiến trình giải bài đã dừng.';
        const stopBtn = $('#btn-stop-run');
        if (stopBtn) stopBtn.style.display = 'none';
        appendLog({ ts: Date.now(), level: 'warn', message: '⏹ Tiến trình đã dừng.' });
      } else if (data.type === 'scheduled') {
        const schedTime = formatDateTime(new Date(data.submitAt).getTime());
        const subAt = $('#run-submit-at');
        if (subAt) subAt.textContent = `→ Nộp bài lúc: ${schedTime}`;
        appendLog({ ts: Date.now(), level: 'info', message: `Lịch nộp bài: ${schedTime}` });
      }
    };

    es.onerror = () => {
      // Reconnect silently without spamming error banners to the user
      try { es.close(); } catch {}
      state.es = null;
      setTimeout(connectEvents, 4000);
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

  // ------------------------------------------------------------- license

  function showLicenseModal(allowClose = false, errorMsg = '') {
    const modal = $('#modal-license');
    if (!modal) return;
    const stored = Api.getStoredLicense();
    const inName = $('#in-license-name');
    const inKey = $('#in-license-key');
    if (stored) {
      if (inName && !inName.value) inName.value = stored.name || '';
      if (inKey && !inKey.value) inKey.value = stored.key || '';
    }
    const alertBox = $('#license-alert');
    if (alertBox) {
      if (errorMsg) {
        alertBox.textContent = errorMsg;
        alertBox.style.display = 'block';
      } else {
        alertBox.style.display = 'none';
      }
    }
    modal.style.display = 'flex';
  }

  function hideLicenseModal() {
    const modal = $('#modal-license');
    if (modal) modal.style.display = 'none';
  }

  function renderLicenseInfo(lic) {
    const container = $('#settings-license-info');
    if (!container) return;
    if (!lic || !lic.key) {
      container.innerHTML = '<p class="muted small">Chưa kích hoạt bản quyền.</p>';
      return;
    }

    let typeStr = '1 Tháng (30 Ngày)';
    if (lic.type === '3_days') typeStr = '3 Ngày';
    if (lic.type === 'lifetime') typeStr = 'Vĩnh viễn (Trọn đời)';

    const isExpired = lic.status === 'expired' || (lic.expiresAt && Date.now() > lic.expiresAt);
    const statusColor = isExpired ? 'var(--err)' : 'var(--ok)';
    const statusText = isExpired ? 'Đã hết hạn' : 'Đang hoạt động';

    container.innerHTML = `
      <div class="license-row">
        <span>Khách hàng:</span>
        <span>${escapeHtml(lic.name || '')}</span>
      </div>
      <div class="license-row">
        <span>Gói bản quyền:</span>
        <span>${typeStr}</span>
      </div>
      <div class="license-row">
        <span>Thời hạn còn lại:</span>
        <span style="color: ${statusColor}">${lic.remainingText || statusText}</span>
      </div>
      <div class="license-row">
        <span>Mã License:</span>
        <span style="font-family: monospace; font-size: 11px;">${escapeHtml(lic.key || '')}</span>
      </div>
    `;
  }

  async function checkLicense() {
    const lic = Api.getStoredLicense();
    if (!lic || !lic.key) {
      showLicenseModal(false);
      return false;
    }

    const hwid = await Api.getDeviceHWID();
    try {
      const res = await Api.verifyLicense(lic.key, hwid);
      if (res && res.ok && res.valid) {
        Api.saveLicense(res.license);
        renderLicenseInfo(res.license);
        hideLicenseModal();
        return true;
      } else {
        showLicenseModal(false, res?.error || 'Mã bản quyền đã hết hạn hoặc không hợp lệ.');
        return false;
      }
    } catch (err) {
      // Offline fallback: if network error, verify expiration locally
      if (lic.expiresAt && Date.now() > lic.expiresAt) {
        showLicenseModal(false, 'Mã bản quyền đã hết hạn sử dụng.');
        return false;
      }
      renderLicenseInfo(lic);
      hideLicenseModal();
      return true;
    }
  }

  function bindLicense() {
    const btnAct = $('#btn-activate-license');
    const inName = $('#in-license-name');
    const inKey = $('#in-license-key');
    const alertBox = $('#license-alert');

    if (btnAct) {
      btnAct.addEventListener('click', async () => {
        const name = (inName?.value || '').trim();
        const key = (inKey?.value || '').trim().toUpperCase();

        if (!name || !key) {
          if (alertBox) {
            alertBox.textContent = 'Vui lòng nhập đầy đủ Tên người dùng và Mã License Key.';
            alertBox.style.display = 'block';
          }
          return;
        }

        btnAct.disabled = true;
        btnAct.textContent = 'Đang kích hoạt…';
        if (alertBox) alertBox.style.display = 'none';

        try {
          const hwid = await Api.getDeviceHWID();
          const isIOS = navigator.userAgent.includes('iPhone') || navigator.userAgent.includes('iPad');
          const isAndroid = navigator.userAgent.includes('Android');
          const deviceInfo = isIOS ? 'Apple iPhone' : isAndroid ? 'Android' : 'Web/Desktop';

          const res = await Api.activateLicense(key, name, hwid, deviceInfo);
          if (!res.ok) throw new Error(res.error || 'Kích hoạt thất bại');

          Api.saveLicense(res.license);
          renderLicenseInfo(res.license);
          hideLicenseModal();
          toast(`Kích hoạt thành công! Hạn dùng: ${res.license.remainingText}`, 'ok');

          await checkSession();
        } catch (err) {
          if (alertBox) {
            alertBox.textContent = err.message || 'Lỗi kích hoạt bản quyền';
            alertBox.style.display = 'block';
          }
        } finally {
          btnAct.disabled = false;
          btnAct.textContent = 'Kích Hoạt Bản Quyền';
        }
      });
    }

    const btnChange = $('#btn-change-license');
    if (btnChange) {
      btnChange.addEventListener('click', () => {
        showLicenseModal(true);
      });
    }
  }

  // ------------------------------------------------ smart polling fallback

  let smartPollTimer = null;
  function startSmartPolling(runId) {
    if (smartPollTimer) clearInterval(smartPollTimer);
    smartPollTimer = setInterval(async () => {
      if (!state.runId || state.runId !== runId) {
        clearInterval(smartPollTimer);
        smartPollTimer = null;
        return;
      }
      try {
        const data = await Api.run(runId);
        if (data && data.ok && data.run) {
          const r = data.run;
          if (Array.isArray(r.homeworks)) {
            r.homeworks.forEach((h) => {
              if (h.id && h.status) updateHwChipStatus(h.id, h.status);
            });
          }
          if (r.status === 'done') {
            stopSmartPolling();
            stopBgKeepAlive();
            setRunStatus('done');
            setStatus('Đã hoàn thành', 'on');
            const stopBtn = $('#btn-stop-run');
            if (stopBtn) stopBtn.style.display = 'none';
            const pText = $('#run-progress-text');
            if (pText) pText.textContent = 'Đã hoàn thành toàn bộ bài tập!';
            notify('OLM Solver - Hoàn tất!', 'Đã hoàn thành giải toàn bộ các bài tập OLM được chọn!');
            toast('Đã hoàn thành toàn bộ bài tập!', 'ok');
          } else if (r.status === 'error') {
            stopSmartPolling();
            stopBgKeepAlive();
            setRunStatus('error');
            setStatus('Lỗi', 'err');
            const stopBtn = $('#btn-stop-run');
            if (stopBtn) stopBtn.style.display = 'none';
          } else if (r.status === 'stopped') {
            stopSmartPolling();
            stopBgKeepAlive();
            setRunStatus('stopped');
            setStatus('Đã dừng', '');
            const stopBtn = $('#btn-stop-run');
            if (stopBtn) stopBtn.style.display = 'none';
          }
        }
      } catch {
        /* silent catch */
      }
    }, 2500);
  }

  function stopSmartPolling() {
    if (smartPollTimer) {
      clearInterval(smartPollTimer);
      smartPollTimer = null;
    }
  }
})();