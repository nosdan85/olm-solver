'use strict';

(() => {
  const { $, $$, el, escapeHtml, formatDateTime, debounce, appendLog, syncLogs, clearLog, setLogFilter, setStatus, setRunStatus, toast, notify } = UI;

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
  };

  // ------------------------------------------------------------- boot

  document.addEventListener('DOMContentLoaded', async () => {
    updateAuthTabs(false);
    bindTabs();
    bindLogin();
    bindHomework();
    bindSolveConfigModal();
    bindLogTabs();
    bindLicense();
    bindIosHelperModal();
    registerSW();
    switchTab('login');
    await checkSession();
    syncRunStateOnFocus();
  });

  // ------------------------------------------------------------- tabs

  let bgKeepAliveCtx = null;
  let bgAudioEl = null;

  function startBgKeepAlive() {
    try {
      if (!bgAudioEl) {
        // Silent 1-sample WAV base64 loop to maintain Safari background processing
        bgAudioEl = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA');
        bgAudioEl.loop = true;
        bgAudioEl.volume = 0.01;
      }
      bgAudioEl.play().catch(() => {});
    } catch (e) {}

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
      } else if (bgKeepAliveCtx.state === 'suspended') {
        bgKeepAliveCtx.resume().catch(() => {});
      }
    } catch (e) {}
  }

  function stopBgKeepAlive() {
    try {
      if (bgAudioEl) {
        bgAudioEl.pause();
        bgAudioEl = null;
      }
    } catch (e) {}
    try {
      if (bgKeepAliveCtx) {
        bgKeepAliveCtx.close().catch(() => {});
        bgKeepAliveCtx = null;
      }
    } catch (e) {}
  }

  function bindIosHelperModal() {
    const modal = $('#modal-ios-helper');
    const openBtn = $('#btn-open-ios-helper');
    const closeBtn = $('#btn-close-ios-helper');
    if (!modal || !openBtn) return;
    openBtn.addEventListener('click', () => {
      if (typeof modal.showModal === 'function' && !modal.open) modal.showModal();
      else modal.setAttribute('open', '');
    });
    closeBtn?.addEventListener('click', () => {
      if (typeof modal.close === 'function' && modal.open) modal.close();
      else modal.removeAttribute('open');
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        if (typeof modal.close === 'function' && modal.open) modal.close();
        else modal.removeAttribute('open');
      }
    });
  }

  function updateAuthTabs(isLoggedIn) {
    if (!isLoggedIn) {
      latestRunToken = null;
      renderRecentRun();
    }
    $('#tab-nav-login').hidden = isLoggedIn;
    for (const id of ['homework', 'log']) $('#tab-nav-' + id).hidden = !isLoggedIn;
    $('#tab-nav-logout').style.display = isLoggedIn ? '' : 'none';
  }

  function bindTabs() {
    if (Api.apiOrigin) {
      $$('a[href="/api/helper/download"]').forEach((a) => {
        a.href = Api.apiOrigin + '/api/helper/download';
      });
    }
    $$('#tabbar .tab').forEach((btn) => {
      if (btn.id === 'tab-nav-logout') {
        btn.addEventListener('click', doLogout);
      } else {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab, { focus: true }));
      }
    });
  }

  let latestRunToken = null;
  function renderRecentRun(run) {
    const statuses = { queued: 'Đang chờ', running: 'Đang giải', done: 'Đã nộp', partial: 'Nộp một phần', stopped: 'Đã dừng', error: 'Chưa xác nhận nộp' };
    const label = $('#recent-run-status');
    const progress = $('#recent-run-progress');
    const total = Number(run?.progress?.total) || 0;
    const filled = Number(run?.progress?.filled) || 0;
    label.textContent = run ? (statuses[run.status] || 'Có tác vụ') + (total ? ' · ' + filled + '/' + total + ' câu đã điền' : '') : 'Chưa có tác vụ nào.';
    progress.hidden = total < 1;
    progress.max = Math.max(1, total);
    progress.value = Math.min(total, filled);
  }

  async function loadRecentRun() {
    const token = sessionMarker;
    if (!token || latestRunToken === token || state.runId) return;
    latestRunToken = token;
    try {
      const { runs } = await Api.runs();
      if (sessionMarker === token && !state.runId) renderRecentRun(runs?.[0]);
    } catch {
      if (latestRunToken === token) latestRunToken = null;
    }
  }

  function switchTab(tab, { focus = false } = {}) {
    state.tab = tab;
    ['login', 'homework', 'log'].forEach((name) => {
      const view = $(`#view-${name}`);
      if (view) view.hidden = name !== tab;
    });
    $$('#tabbar .tab').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    const visibleHeading = $('#view-' + tab + ' h1');
    if (visibleHeading) $('.skip-to-workspace').href = '#' + visibleHeading.id;
    if (focus) visibleHeading?.focus();
    if (tab === 'homework') loadRecentRun();
  }

  // ----------------------------------------------------------- login

  let sessionMarker = null;

  function bindLogin() {
    $('#login-form-account').addEventListener('submit', doLogin);
    const btnTogglePass = $('#btn-toggle-password');
    const inPass = $('#in-password');
    if (btnTogglePass && inPass) {
      btnTogglePass.addEventListener('click', () => {
        const isPass = inPass.type === 'password';
        inPass.type = isPass ? 'text' : 'password';
        btnTogglePass.textContent = isPass ? '🙈' : '👁️';
        btnTogglePass.setAttribute('aria-label', isPass ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      });
    }
  }

  async function doLogin(event) {
    event.preventDefault();
    const errorBox = $('#login-error');
    const btn = $('#btn-login');
    if (btn.disabled) return;
    errorBox.hidden = true;

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
      sessionMarker = Symbol();
      state.currentUser = res.username || username;
      Api.setCurrentUser(state.currentUser);
      connectEvents();
      updateSessionDisplay(state.currentUser);

      $('#in-password').value = '';
      setStatus(`Đã đăng nhập: ${state.currentUser}`, 'on');
      appendLog({ ts: Date.now(), level: 'success', message: `Đăng nhập thành công (${state.currentUser})` });
      updateAuthTabs(true);

      switchTab('homework');
      const licOk = await checkOlmLicense(state.currentUser);
      if (licOk) {
        await refreshHomeworks();
      }
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
    try {
      const res = await Api.session();
      sessionMarker = Symbol();
      state.currentUser = res.username;
      Api.setCurrentUser(state.currentUser);
      updateSessionDisplay(state.currentUser);
      updateAuthTabs(true);
      connectEvents();
      switchTab('homework');
      const licOk = await checkOlmLicense(state.currentUser);
      if (licOk) await refreshHomeworks();
      return;
    } catch (err) {
      if (err.status !== 401) {
        setStatus('Không kiểm tra được phiên. Thử kết nối lại.', 'err');
        return;
      }
    }

    sessionMarker = null;
    Api.setCurrentUser('');
    clearActiveRun();
    connectEvents();
    updateAuthTabs(false);
    setStatus('Chưa đăng nhập', '');
    updateSessionDisplay('');
    switchTab('login');
  }

  function updateSessionDisplay(username) {
    const lbl = $('#conn-label');
    const dot = $('#conn-dot');
    const btnLogout = $('#btn-header-logout');
    if (lbl) lbl.textContent = username ? `Đã đăng nhập: ${username}` : 'Chưa đăng nhập';
    if (dot) dot.className = `dot ${username ? 'ok' : ''}`;
    if (btnLogout) btnLogout.style.display = username ? 'inline-flex' : 'none';
  }

  // -------------------------------------------------------- homeworks

  function showSubmitSuccessModal(_title, _score) {
    // Đã tắt cơ chế hiện bảng thông báo sau khi nộp bài theo yêu cầu người dùng
  }

  function bindHomework() {
    $('#btn-refresh').addEventListener('click', () => {
      refreshHomeworks();
    });
    $('#btn-select-all').addEventListener('click', toggleSelectAll);
    $('#btn-start').addEventListener('click', openSolveConfigModal);

    const inSearchHw = $('#in-search-hw');
    const btnClearSearch = $('#btn-clear-search');
    if (inSearchHw) {
      const syncClearBtn = () => {
        if (btnClearSearch) btnClearSearch.hidden = !inSearchHw.value;
      };
      inSearchHw.addEventListener('input', () => {
        syncClearBtn();
        renderHomeworks();
      });
      if (btnClearSearch) {
        btnClearSearch.addEventListener('click', () => {
          inSearchHw.value = '';
          syncClearBtn();
          renderHomeworks();
          inSearchHw.focus();
        });
      }
    }

    const btnHeaderLogout = $('#btn-header-logout');
    if (btnHeaderLogout) {
      btnHeaderLogout.addEventListener('click', doLogout);
    }

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
          if (u.protocol !== 'https:' || !/(^|\.)olm\.vn$/i.test(u.hostname) || u.port || u.username || u.password) {
            throw new Error('URL ngoài OLM');
          }
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

  let pendingHomeworkScan;
  async function refreshHomeworks(silent = false) {
    const currentToken = sessionMarker;
    if (!currentToken || pendingHomeworkScan === currentToken) return;
    pendingHomeworkScan = currentToken;
    const list = $('#hw-list');
    if (!silent && !state.homeworks.length) {
      list.innerHTML = '<div class="empty">Đang tải danh sách bài tập OLM…</div>';
    }
    if (!silent) setStatus('Đang quét bài tập…', 'busy');

    try {
      const res = await Api.homeworks();
      if (sessionMarker !== currentToken) return;
      const serverHws = res.homeworks || [];
      const customHws = state.homeworks.filter((h) => h.subject === 'Tự thêm');
      state.homeworks = [...customHws, ...serverHws.filter((sh) => !customHws.some((ch) => ch.id === sh.id))];

      const prevTodo = state._lastTodoCount;
      const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
      state._lastTodoCount = todoCount;
      renderHomeworks();

      const scanTime = new Date().toLocaleTimeString('vi-VN');
      const scanLbl = document.getElementById('scan-last-time');
      const scanDot = document.getElementById('scan-live-dot');
      if (scanLbl) scanLbl.textContent = `Vừa quét ${scanTime}`;
      if (scanDot) {
        scanDot.style.opacity = '1';
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) scanDot.style.transform = 'scale(1.3)';
        setTimeout(() => {
          if (scanDot) {
            scanDot.style.opacity = '0.7';
            scanDot.style.transform = 'scale(1)';
          }
        }, 600);
      }

      if (!silent) {
        setStatus(`Sẵn sàng (${todoCount} bài chưa làm)`, 'on');
        appendLog({
          ts: Date.now(),
          level: 'info',
          message: `Đã quét được ${res.count} bài tập (${todoCount} bài chưa làm) từ OLM`,
        });
      } else if (prevTodo !== undefined && prevTodo !== todoCount) {
        appendLog({
          ts: Date.now(),
          level: 'info',
          message: `🔄 [Quét tự động] Cập nhật từ OLM: ${res.count} bài (${todoCount} bài chưa làm)`,
        });
      }
    } catch (err) {
      if (sessionMarker !== currentToken) return;
      const scanLbl = document.getElementById('scan-last-time');
      if (scanLbl) scanLbl.textContent = `Quét lỗi lúc ${new Date().toLocaleTimeString('vi-VN')}`;
      if (!silent) {
        if (!state.homeworks.length) {
          list.innerHTML = `<div class="empty">Không quét được danh sách bài tập tự động.<br><span class="muted small">Vui lòng bấm "+ Dán link bài" ở trên hoặc thử quét lại.</span><div style="margin-top:12px;"><button type="button" class="btn btn-secondary btn-mini" id="btn-retry-scan">🔄 Thử lại</button></div></div>`;
          const retryBtn = $('#btn-retry-scan');
          if (retryBtn) retryBtn.addEventListener('click', () => refreshHomeworks());
        }
        setStatus('Sẵn sàng làm bài', 'on');
        appendLog({ ts: Date.now(), level: 'warn', message: `Chưa quét được bài: ${err.message}` });
      }
    } finally {
      if (pendingHomeworkScan === currentToken) pendingHomeworkScan = null;
    }
  }

  // Quét liên tục danh sách bài tập (mỗi 12 giây một lần ngầm)
  function renderHomeworks() {
    const list = $('#hw-list');
    list.innerHTML = '';

    const filter = state.filter || 'todo';
    const totalCount = state.homeworks.length;
    const todoCount = state.homeworks.filter((h) => !h.isDone && !h.isExpired).length;
    const retryCount = state.homeworks.filter((h) => Boolean(h.isDone && !h.isExpired && h.canRetry)).length;
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
      items = state.homeworks.filter((h) => Boolean(h.isDone && !h.isExpired && h.canRetry));
    } else if (filter === 'done') {
      items = state.homeworks.filter((h) => Boolean(h.isDone));
    } else if (filter === 'expired') {
      items = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));
    }

    const searchVal = ($('#in-search-hw')?.value || '').trim().toLowerCase();
    if (searchVal) {
      items = items.filter((h) =>
        String(h.title || '').toLowerCase().includes(searchVal) ||
        String(h.subject || '').toLowerCase().includes(searchVal) ||
        String(h.id || '').toLowerCase().includes(searchVal)
      );
    }

    if (!items.length) {
      let emptyMsg = 'Chưa có bài tập nào trong danh mục này.';
      let showRetry = false;
      if (searchVal) {
        emptyMsg = `🔍 Không tìm thấy bài tập nào khớp với từ khóa "<b>${escapeHtml(searchVal)}</b>".`;
      } else if (filter === 'todo') {
        emptyMsg = '🎉 Tuyệt vời! Bạn không còn bài tập nào chưa làm.<br><span class="muted small">Chọn tab "Luyện tập lại" hoặc "Tất cả" để làm thêm bài.</span>';
        showRetry = true;
      } else if (filter === 'retry') {
        emptyMsg = 'Hiện tại không có bài nào có thể luyện tập lại.<br><span class="muted small">Các bài đã hoàn thành có thể mở lại khi giáo viên cho phép.</span>';
      } else if (filter === 'done') {
        emptyMsg = 'Chưa có bài tập nào đã hoàn thành.';
      } else if (filter === 'expired') {
        emptyMsg = 'Không có bài tập nào bị hết hạn.';
      }
      const actionHtml = searchVal
        ? '<div style="margin-top:10px;"><button type="button" class="btn btn-secondary btn-mini" id="btn-empty-clear-search">✕ Xóa từ khóa</button></div>'
        : (showRetry ? '<div style="margin-top:10px;"><button type="button" class="btn btn-secondary btn-mini" id="btn-empty-retry">🔄 Quét lại</button></div>' : '');
      list.innerHTML = `<div class="empty">${emptyMsg}${actionHtml}</div>`;
      const btnEmptyClear = $('#btn-empty-clear-search');
      if (btnEmptyClear) {
        btnEmptyClear.addEventListener('click', () => {
          const inp = $('#in-search-hw');
          const clr = $('#btn-clear-search');
          if (inp) inp.value = '';
          if (clr) clr.hidden = true;
          renderHomeworks();
        });
      }
      const btnEmptyRetry = $('#btn-empty-retry');
      if (btnEmptyRetry) btnEmptyRetry.addEventListener('click', () => refreshHomeworks());
      updateSummary();
      return;
    }

    for (const hw of items) {
      const isDone = !!hw.isDone;
      const isExpired = !!hw.isExpired;
      const canRetry = Boolean(hw.canRetry);
      const isLockedDone = isDone && !canRetry;

      if (isLockedDone && state.selected.has(hw.id)) {
        state.selected.delete(hw.id);
      }

      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = state.selected.has(hw.id);
      checkbox.disabled = isLockedDone;
      checkbox.addEventListener('change', () => {
        if (isLockedDone) {
          checkbox.checked = false;
          toast('🔒 Bài này đã nộp và giáo viên/OLM đã khóa chức năng làm lại!', 'warn');
          return;
        }
        if (checkbox.checked) state.selected.add(hw.id);
        else state.selected.delete(hw.id);
        card.classList.toggle('selected', checkbox.checked);
        updateSummary();
      });

      const card = el('div', { class: `hw-card ${checkbox.checked ? 'selected' : ''}` });
      card.append(checkbox);

      const body = el('div', { class: 'hw-body' });
      body.append(el('div', { class: 'hw-title', text: hw.title }));

      const meta = el('div', { class: 'hw-meta' });
      if (hw.categoryPrefix) {
        meta.append(el('span', { class: 'tag type-badge', text: hw.categoryPrefix }));
      }
      if (hw.subject) meta.append(el('span', { class: 'tag', text: hw.subject }));
      if (hw.deadline) meta.append(el('span', { class: 'tag warn', text: `Hạn: ${hw.deadline}` }));

      if (canRetry && (isDone || filter === 'retry')) {
        meta.append(el('span', { class: 'tag retry', text: '🔄 Luyện tập lại' }));
      } else if (isDone && !canRetry) {
        meta.append(el('span', { class: 'tag muted', text: '🔒 OLM khóa làm lại' }));
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
          if (isLockedDone) {
            toast('🔒 Bài này đã nộp và giáo viên/OLM đã khóa chức năng làm lại!', 'warn');
            return;
          }
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
    else if (filter === 'retry') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone && !h.isExpired && h.canRetry));
    else if (filter === 'done') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone && h.canRetry));
    else if (filter === 'expired') visibleItems = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));
    visibleItems = visibleItems.filter((h) => !(h.isDone && !h.canRetry));

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
    else if (filter === 'retry') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone && !h.isExpired && h.canRetry));
    else if (filter === 'done') visibleItems = state.homeworks.filter((h) => Boolean(h.isDone && h.canRetry));
    else if (filter === 'expired') visibleItems = state.homeworks.filter((h) => Boolean(h.isExpired && !h.isDone));
    visibleItems = visibleItems.filter((h) => !(h.isDone && !h.canRetry));

    const allSelected = visibleItems.length > 0 && visibleItems.every((h) => state.selected.has(h.id));
    if (txtSelectAll) txtSelectAll.textContent = allSelected ? 'Bỏ chọn' : 'Chọn tất cả';

    const stickySummary = $('#sticky-summary');
    if (stickySummary) stickySummary.textContent = count ? `Đã chọn ${count} bài` : 'Chưa chọn bài nào';
    const startBtn = $('#btn-start');
    if (startBtn) {
      startBtn.disabled = count === 0;
      startBtn.textContent = count ? `Cấu hình ${count} bài` : 'Cấu hình giải';
    }
  }

  // ------------------------------------------------------ solve config modal & run

  function openSolveConfigModal() {
    const selected = state.homeworks.filter((h) => state.selected.has(h.id));
    if (!selected.length) {
      toast('Vui lòng chọn ít nhất 1 bài tập', 'warn');
      return;
    }

    const modal = $('#modal-solve-config');
    if (!modal) return;

    const countSpan = $('#cfg-modal-count');
    if (countSpan) countSpan.textContent = String(selected.length);

    const batchBar = $('#cfg-batch-bar');
    if (batchBar) {
      batchBar.style.display = selected.length >= 2 ? 'block' : 'none';
    }

    const score = 10;
    const minutes = 0;
    const batchScore = $('#cfg-batch-score');
    const batchDelay = $('#cfg-batch-delay');
    if (batchScore) batchScore.value = score;
    if (batchDelay) batchDelay.value = minutes;

    const listEl = $('#cfg-items-list');
    if (listEl) {
      listEl.innerHTML = selected.map((hw, idx) => `
        <div class="cfg-hw-item" style="background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px;">
          <div style="font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
            <span><span style="color: var(--accent);">#${idx + 1}.</span> ${escapeHtml(hw.title || hw.subject || 'Bài tập')}</span>
            <span style="font-size: 11px; color: var(--text-dim); font-weight: 500;">${escapeHtml(hw.subject || '')}</span>
          </div>
          <div style="display: flex; gap: 14px; align-items: center; flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 12px; color: var(--text-dim);">🎯 Điểm yêu cầu:</span>
              <input type="number" class="cfg-item-score" aria-label="Điểm mục tiêu bài ${idx + 1}" data-id="${escapeHtml(hw.id)}" min="1" max="10" step="0.5" value="${score}" style="width: 70px; padding: 5px 8px; font-size: 13px; font-weight: 700; border-radius: 6px; background: var(--bg-elev); border: 1px solid var(--border-light); color: var(--text); text-align: center;">
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="font-size: 12px; color: var(--text-dim);">⏳ Hoãn nộp (phút):</span>
              <input type="number" class="cfg-item-delay" aria-label="Phút hoãn nộp bài ${idx + 1}" data-id="${escapeHtml(hw.id)}" min="0" max="60" value="${minutes}" style="width: 65px; padding: 5px 8px; font-size: 13px; font-weight: 700; border-radius: 6px; background: var(--bg-elev); border: 1px solid var(--border-light); color: var(--text); text-align: center;">
            </div>
          </div>
        </div>
      `).join('');
    }

    if (!modal.open) modal.showModal();
  }

  function bindSolveConfigModal() {
    const modal = $('#modal-solve-config');
    const btnClose = $('#btn-close-solve-config');
    const btnCancel = $('#btn-cancel-solve-config');
    const btnConfirm = $('#btn-confirm-solve-config');
    const btnApplyBatch = $('#btn-apply-batch-cfg');

    const closeModal = () => {
      if (modal?.open) modal.close();
    };

    if (btnClose) btnClose.addEventListener('click', closeModal);
    if (btnCancel) btnCancel.addEventListener('click', closeModal);

    const clampNum = (val, min, max, fallback) => {
      const n = Number(val);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    };

    if (btnApplyBatch) {
      btnApplyBatch.addEventListener('click', () => {
        const scoreEl = $('#cfg-batch-score');
        const delayEl = $('#cfg-batch-delay');
        const batchScoreNum = Math.round(clampNum(scoreEl?.value, 1, 10, 10) * 2) / 2;
        const batchDelayNum = Math.round(clampNum(delayEl?.value, 0, 60, 0));
        if (scoreEl) scoreEl.value = String(batchScoreNum);
        if (delayEl) delayEl.value = String(batchDelayNum);
        const batchScore = String(batchScoreNum);
        const batchDelay = String(batchDelayNum);
        const listEl = $('#cfg-items-list');
        if (!listEl) return;
        listEl.querySelectorAll('.cfg-item-score').forEach((inp) => {
          inp.value = batchScore;
        });
        listEl.querySelectorAll('.cfg-item-delay').forEach((inp) => {
          inp.value = batchDelay;
        });
        toast(`Đã áp dụng ${batchScore} điểm và hoãn nộp ${batchDelay} phút cho tất cả các bài!`, 'ok');
      });
    }

    if (btnConfirm) {
      btnConfirm.addEventListener('click', async () => {
        const selected = state.homeworks.filter((h) => state.selected.has(h.id));
        if (!selected.length) {
          closeModal();
          return;
        }

        const listEl = $('#cfg-items-list');
        const configuredHws = selected.map((hw) => {
          const scoreInp = listEl ? listEl.querySelector(`.cfg-item-score[data-id="${CSS.escape(String(hw.id))}"]`) : null;
          const delayInp = listEl ? listEl.querySelector(`.cfg-item-delay[data-id="${CSS.escape(String(hw.id))}"]`) : null;
          const scoreNum = Math.round(clampNum(scoreInp ? scoreInp.value : 10, 1, 10, 10) * 2) / 2;
          const delay = Math.round(clampNum(delayInp ? delayInp.value : 0, 0, 60, 0));
          return {
            ...hw,
            config: {
              scoreTarget: String(scoreNum),
              submitDelayMinutes: delay,
            },
          };
        });

        closeModal();
        await executeRun(configuredHws);
      });
    }
  }

  async function executeRun(selected) {
    if (!selected || !selected.length) return;

    if (state.runId) return;
    const config = { concurrency: 2 };

    const btn = $('#btn-start');
    btn.disabled = true;
    btn.textContent = 'Đang khởi động…';

    try {
      startBgKeepAlive();

      const res = await Api.startRun(selected, config);
      state.runId = res.runId;
      try { localStorage.setItem('olm.active_run_id', res.runId); } catch {}
      state.runningHomeworks = selected.map((h, i) => ({ id: h.id, title: h.title, status: 'pending', index: i }));

      // Clear selected checkboxes right away
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

      const queued = res.status === 'queued';
      const message = queued ? 'Đã đưa bài tập vào hàng đợi.' : 'Đang giải bài…';
      appendLog({ ts: Date.now(), level: 'info', message });
      setRunStatus(queued ? 'queued' : 'running');
      renderRecentRun({ status: res.status || 'running' });
      setStatus(message, 'busy');
      const pText = $('#run-progress-text');
      if (pText) pText.textContent = message;

      switchTab('log');
    } catch (err) {
      stopBgKeepAlive();
      stopSmartPolling();
      if (err.code === 'NO_LICENSE' || err.code === 'INVALID_LICENSE' || err.code === 'EXPIRED') {
        await checkOlmLicense(state.currentUser);
      } else if (err.code === 'NO_SESSION' || err.code === 'NO_TOKEN') {
        toast('Phiên OLM đã hết hạn (do máy chủ vừa khởi động lại). Vui lòng đăng nhập lại.', 'warn');
        updateAuthTabs(false);
        switchTab('login');
      }
      toast(err.message, 'error');
      appendLog({ ts: Date.now(), level: 'error', message: `Khởi chạy lỗi: ${err.message}` });
    } finally {
      btn.disabled = false;
      btn.textContent = 'Cấu hình giải';
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
            const id = state.runId;
            const response = await Api.stopRun(id);
            if (response.stopped && state.runId === id) finishRun({ status: 'stopped' });
            if (response.requested) toast('Đã gửi yêu cầu dừng. Đang chờ worker xác nhận.', 'info');
          } catch (err) {
            toast(err.message || 'Lỗi dừng tiến trình', 'error');
          } finally {
            stopBtn.disabled = false;
            stopBtn.textContent = '⏹ Dừng giải bài';
            if (!state.runId) stopBtn.style.display = 'none';
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
      const hwTitle = String(hw.title || '');
      const label = el('span', { text: hwTitle.length > 18 ? `${hwTitle.slice(0, 16)}…` : hwTitle });
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

  async function doLogout() {
    if (confirm('Bạn có chắc chắn muốn đăng xuất tài khoản OLM?')) {
      if (state.runId) {
        try {
          await Api.stopRun(state.runId);
        } catch (e) {}
      }
      stopSmartPolling();
      stopBgKeepAlive();
      const stopBtn = $('#btn-stop-run');
      if (stopBtn) stopBtn.style.display = 'none';
      try {
        await Api.logout();
      } catch (err) {
        if (err.status !== 401) {
          toast('Chưa đăng xuất được. Vui lòng thử lại.', 'error');
          return;
        }
      }
      sessionMarker = null;
      Api.setCurrentUser('');
      clearActiveRun();
      connectEvents();
      state.homeworks = [];
      state.selected.clear();
      state.currentUser = '';
      clearLog();
      setStatus('Chưa đăng nhập', '');
      updateSessionDisplay('');
      updateAuthTabs(false);
      hideLicenseModal();
      const badge = $('#topbar-license-badge');
      if (badge) badge.style.display = 'none';
      switchTab('login');
      toast('Đã đăng xuất tài khoản', 'info');
    }
  }

  // ------------------------------------------------------ live events

  function connectEvents() {
    if (state.es) {
      try { state.es.close(); } catch (e) {}
      state.es = null;
    }

    if (!sessionMarker || !Api.liveEvents) return;
    const es = Api.openEvents('/api/events');
    state.es = es;

    es.onopen = () => {
      if (state.tab === 'homework') {
        setStatus('Sẵn sàng làm bài', 'on');
      } else if (state.tab === 'login') {
        setStatus(sessionMarker ? 'Đã đăng nhập' : 'Chưa đăng nhập', sessionMarker ? 'on' : '');
      } else {
        setStatus('Đã kết nối máy chủ', 'on');
      }
    };

    es.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (!state.runId || data.runId !== state.runId) return;

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
          showSubmitSuccessModal(data.title, data.result?.score);
        }
      } else if (['done', 'error', 'stopped'].includes(data.type)) {
        finishRun({ status: data.status || data.type, completed: data.completed, total: data.total });
      } else if (data.type === 'scheduled') {
        const schedTime = formatDateTime(new Date(data.submitAt).getTime());
        const subAt = $('#run-submit-at');
        if (subAt) subAt.textContent = `→ Nộp bài lúc: ${schedTime}`;
        appendLog({ ts: Date.now(), level: 'info', message: `Lịch nộp bài: ${schedTime}` });
      }
    };

    es.onerror = (err) => {
      try { es.close(); } catch (e) {}
      state.es = null;
      if (err && (err.fatal || [401, 403, 410].includes(err.status))) {
        return;
      }
      setTimeout(connectEvents, 1200);
    };
  }

  // -------------------------------------------------- service worker

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      try { reg.update(); } catch (e) {}
    }).catch(() => {
      /* offline shell is optional */
    });
  }

  // ------------------------------------------------------------- license

  let licenseKeyMasked = true;

  function maskLicenseKey(key) {
    const str = String(key || '').trim();
    const parts = str.split('-');
    if (parts.length >= 4) {
      return `${parts[0]}-${parts[1]}-****-${parts[parts.length - 1]}`;
    }
    if (str.length > 8) {
      return `${str.slice(0, 4)}****${str.slice(-4)}`;
    }
    return str;
  }

  async function copyTextWithFallback(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function showLicenseModal(username = '', deviceInfo = '', errorMsg = '', opts = {}) {
    const modal = $('#modal-license');
    if (!modal) return;
    const uSpan = $('#lic-modal-username');
    const dSpan = $('#lic-modal-device');
    const hwidSpan = $('#lic-modal-hwid');
    const expRow = $('#lic-modal-expires-row');
    const expSpan = $('#lic-modal-expires');
    const alertBox = $('#license-alert');
    const inKey = $('#in-license-key');
    const activeBox = $('#lic-active-box');
    const activeKeyDisp = $('#lic-active-key-display');
    const btnToggleMask = $('#btn-toggle-key-mask');
    const inputGroup = $('#lic-input-group');
    const btnAct = $('#btn-activate-license');
    const buyBox = $('#lic-buy-box');
    const btnClose = $('#btn-close-license-modal');
    const iconEl = $('#lic-modal-icon');
    const titleEl = $('#modal-license-title');

    const curUser = username || state.currentUser || Api.getCurrentUser() || '';
    if (uSpan) uSpan.textContent = curUser || 'Chưa đăng nhập';
    if (dSpan) dSpan.textContent = deviceInfo || detectDeviceInfo();
    if (hwidSpan) {
      hwidSpan.textContent = 'Đang xác định...';
      Api.getDeviceHWID().then((hwid) => {
        if (hwidSpan) hwidSpan.textContent = hwid || 'Không rõ';
      }).catch(() => {
        if (hwidSpan) hwidSpan.textContent = 'Không rõ';
      });
    }

    const stored = Api.getStoredLicense(curUser);
    const isExpired = Boolean(stored && (stored.status === 'expired' || (stored.expiresAt && Date.now() > stored.expiresAt)));
    const hasActive = Boolean(stored?.key && !isExpired && !errorMsg && !opts.forceInput);

    if (expRow && expSpan) {
      if (stored?.expiresAt) {
        expRow.style.display = 'block';
        const dtStr = formatDateTime(stored.expiresAt);
        expSpan.textContent = stored.remainingText ? `${dtStr} (${stored.remainingText})` : dtStr;
        expSpan.style.color = isExpired ? '#ef4444' : 'var(--ok)';
      } else {
        expRow.style.display = 'none';
      }
    }

    if (hasActive) {
      licenseKeyMasked = true;
      if (iconEl) iconEl.textContent = '🔑';
      if (titleEl) titleEl.textContent = 'Thông Tin Bản Quyền';
      if (activeBox) activeBox.style.display = 'block';
      if (activeKeyDisp) activeKeyDisp.textContent = maskLicenseKey(stored.key);
      if (btnToggleMask) btnToggleMask.textContent = '👁 Hiện';
      if (inputGroup) inputGroup.style.display = 'none';
      if (btnAct) btnAct.style.display = 'none';
      if (buyBox) buyBox.style.display = 'none';
    } else {
      if (iconEl) iconEl.textContent = '🔒';
      if (titleEl) titleEl.textContent = isExpired ? 'Bản Quyền Đã Hết Hạn' : 'Kích Hoạt Bản Quyền';
      if (activeBox) activeBox.style.display = 'none';
      if (inputGroup) inputGroup.style.display = 'block';
      if (btnAct) btnAct.style.display = 'block';
      if (buyBox) buyBox.style.display = 'block';
    }

    if (btnClose) {
      btnClose.style.display = opts.canClose ? 'inline-flex' : 'none';
    }

    if (inKey && !inKey.value && stored?.key) {
      inKey.value = stored.key;
    }

    if (alertBox) {
      if (errorMsg) {
        alertBox.textContent = errorMsg;
        alertBox.style.display = 'block';
      } else {
        alertBox.style.display = 'none';
      }
    }
    if (!modal.open) modal.showModal();
  }

  function hideLicenseModal() {
    const modal = $('#modal-license');
    if (modal?.open) modal.close();
  }

  function renderLicenseInfo(lic) {
    const badge = $('#topbar-license-badge');
    const lblKey = $('#lbl-header-key');
    const lblRem = $('#lbl-header-remaining');

    if (!lic || !lic.key) {
      if (badge) badge.style.display = 'none';
      return;
    }

    const isExpired = lic.status === 'expired' || (lic.expiresAt && Date.now() > lic.expiresAt);
    if (badge && lblKey && lblRem) {
      badge.style.display = 'inline-flex';
      lblKey.textContent = lic.key;
      lblRem.textContent = lic.remainingText || (isExpired ? 'Hết hạn' : 'Còn hiệu lực');
      if (isExpired) {
        badge.style.background = 'rgba(239, 68, 68, 0.15)';
        badge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
        lblRem.style.color = '#ef4444';
      } else {
        badge.style.background = 'rgba(59, 130, 246, 0.15)';
        badge.style.borderColor = 'rgba(59, 130, 246, 0.3)';
        lblRem.style.color = 'var(--accent)';
      }
    }
  }

  function detectDeviceInfo() {
    const ua = navigator.userAgent || '';
    if (/iPhone/i.test(ua)) return 'Apple iPhone (Safari)';
    if (/iPad/i.test(ua)) return 'Apple iPad';
    if (/Android/i.test(ua)) return 'Android Device';
    if (/Macintosh/i.test(ua)) return 'Mac OS (Safari/Chrome)';
    if (/Windows/i.test(ua)) return 'Windows PC';
    return 'Web Client';
  }

  async function checkOlmLicense(username) {
    const user = username || state.currentUser || Api.getCurrentUser();
    if (!user) return false;

    const hwid = await Api.getDeviceHWID();
    const deviceInfo = detectDeviceInfo();
    let lic = Api.getStoredLicense(user);

    if (!lic || !lic.key) {
      showLicenseModal(user, deviceInfo, 'Tài khoản OLM chưa có bản quyền. Vui lòng nhập mã License Key để sử dụng.');
      return false;
    }

    try {
      const res = await Api.verifyLicense(lic.key, user, hwid, deviceInfo);
      if (res && res.ok && res.valid) {
        Api.saveLicense(res.license, user);
        renderLicenseInfo(res.license);
        hideLicenseModal();
        return true;
      } else {
        Api.saveLicense(null, user);
        renderLicenseInfo(null);
        showLicenseModal(user, deviceInfo, res?.error || 'Mã bản quyền đã hết hạn hoặc không hợp lệ.');
        return false;
      }
    } catch (err) {
      if (err.status === 401 || err.code === 'NO_SESSION') {
        return false;
      }
      if (err.status === 403 || err.code === 'INVALID_LICENSE' || err.code === 'NO_LICENSE' || err.code === 'EXPIRED') {
        Api.saveLicense(null, user);
        renderLicenseInfo(null);
        showLicenseModal(user, deviceInfo, err.message || 'Mã bản quyền không hợp lệ hoặc đã bị khóa.');
        return false;
      }
      if (err.status && err.status < 500) {
        showLicenseModal(user, deviceInfo, err.message || 'Không thể xác thực mã bản quyền.');
        return false;
      }

      // Offline fallback: only for network errors (!err.status) or 5xx server errors
      if (lic.expiresAt && Date.now() > lic.expiresAt) {
        showLicenseModal(user, deviceInfo, 'Mã bản quyền đã hết hạn sử dụng.');
        return false;
      }
      renderLicenseInfo(lic);
      hideLicenseModal();
      return true;
    }
  }

  function bindLicense() {
    const btnAct = $('#btn-activate-license');
    const inKey = $('#in-license-key');
    const alertBox = $('#license-alert');
    const btnLogoutAcc = $('#btn-license-logout-acc');
    const badge = $('#topbar-license-badge');
    const btnClose = $('#btn-close-license-modal');
    const btnToggleMask = $('#btn-toggle-key-mask');
    const btnCopyKey = $('#btn-copy-license-key');
    const btnChangeKey = $('#btn-change-license-key');

    if (badge) {
      const openBadgeModal = () => {
        const user = state.currentUser || Api.getCurrentUser();
        if (!user) return;
        showLicenseModal(user, detectDeviceInfo(), '', { canClose: true });
      };
      badge.addEventListener('click', openBadgeModal);
      badge.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openBadgeModal();
        }
      });
    }

    if (btnClose) {
      btnClose.addEventListener('click', hideLicenseModal);
    }

    if (btnToggleMask) {
      btnToggleMask.addEventListener('click', () => {
        const user = state.currentUser || Api.getCurrentUser();
        const stored = Api.getStoredLicense(user);
        const disp = $('#lic-active-key-display');
        if (!stored?.key || !disp) return;
        licenseKeyMasked = !licenseKeyMasked;
        disp.textContent = licenseKeyMasked ? maskLicenseKey(stored.key) : stored.key;
        btnToggleMask.textContent = licenseKeyMasked ? '👁 Hiện' : '🙈 Ẩn';
      });
    }

    if (btnCopyKey) {
      btnCopyKey.addEventListener('click', async () => {
        const user = state.currentUser || Api.getCurrentUser();
        const stored = Api.getStoredLicense(user);
        if (!stored?.key) return;
        const ok = await copyTextWithFallback(stored.key);
        toast(ok ? 'Đã sao chép License Key!' : 'Không sao chép được, hãy bấm Hiện để copy thủ công.', ok ? 'ok' : 'warn');
      });
    }

    if (btnChangeKey) {
      btnChangeKey.addEventListener('click', () => {
        const activeBox = $('#lic-active-box');
        const inputGroup = $('#lic-input-group');
        const buyBox = $('#lic-buy-box');
        if (activeBox) activeBox.style.display = 'none';
        if (inputGroup) inputGroup.style.display = 'block';
        if (btnAct) btnAct.style.display = 'block';
        if (buyBox) buyBox.style.display = 'block';
        if (inKey) {
          inKey.value = '';
          inKey.focus();
        }
      });
    }

    if (inKey) {
      inKey.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (btnAct && !btnAct.disabled) btnAct.click();
        }
      });
    }

    if (btnLogoutAcc) {
      btnLogoutAcc.addEventListener('click', async () => {
        hideLicenseModal();
        await doLogout();
      });
    }


    if (btnAct) {
      btnAct.addEventListener('click', async () => {
        const key = (inKey?.value || '').trim().toUpperCase();
        const user = state.currentUser || Api.getCurrentUser();

        if (!user) {
          if (alertBox) {
            alertBox.textContent = 'Chưa đăng nhập tài khoản OLM. Vui lòng đăng nhập OLM trước.';
            alertBox.style.display = 'block';
          }
          return;
        }

        if (!key) {
          if (alertBox) {
            alertBox.textContent = 'Vui lòng nhập Mã License Key.';
            alertBox.style.display = 'block';
          }
          return;
        }

        btnAct.disabled = true;
        btnAct.textContent = 'Đang kích hoạt…';
        if (alertBox) alertBox.style.display = 'none';

        try {
          const hwid = await Api.getDeviceHWID();
          const deviceInfo = detectDeviceInfo();

          const res = await Api.activateLicense(key, user, hwid, deviceInfo, user);
          if (!res.ok) throw new Error(res.error || 'Kích hoạt thất bại');

          Api.saveLicense(res.license, user);
          renderLicenseInfo(res.license);
          hideLicenseModal();
          toast(`Kích hoạt thành công! Hạn dùng: ${res.license.remainingText}`, 'ok');

          switchTab('homework');
          await refreshHomeworks();
        } catch (err) {
          if (alertBox) {
            alertBox.textContent = err.message || 'Lỗi kích hoạt bản quyền';
            alertBox.style.display = 'block';
          }
        } finally {
          btnAct.disabled = false;
          btnAct.textContent = 'Kích Hoạt Key & Bắt Đầu';
        }
      });
    }

  }

  // ------------------------------------------------ smart polling fallback

  let smartPollTimer = null;
  function clearActiveRun() {
    state.runId = null;
    try { localStorage.removeItem('olm.active_run_id'); } catch {}
    stopSmartPolling();
    stopBgKeepAlive();
  }

  function finishRun(run) {
    const { status, homeworks } = run;
    const completed = run.completed ?? homeworks?.filter(hw => hw.result?.submitted === true).length;
    const total = run.total ?? homeworks?.length;
    clearActiveRun();
    const labels = {
      done: 'Đã nộp toàn bộ bài tập.',
      partial: Number.isInteger(completed) ? 'Đã nộp ' + completed + '/' + total + ' bài.' : 'Một số bài chưa được nộp.',
      error: 'Tác vụ kết thúc mà chưa xác nhận nộp bài.',
      stopped: 'Tiến trình đã dừng.',
    };
    const message = labels[status] || labels.error;
    renderRecentRun(run);
    setRunStatus(status);
    setStatus(message, status === 'done' ? 'on' : status === 'error' ? 'err' : '');
    const stopBtn = $('#btn-stop-run');
    if (stopBtn) stopBtn.style.display = 'none';
    const progress = $('#run-progress-text');
    if (progress) progress.textContent = message;
    updateSummary();
    if (status === 'done') notify('OLM Solver', message);
    toast(message, status === 'done' ? 'ok' : 'warn');
    if (status === 'done' || status === 'partial') refreshHomeworks(true);
  }

  function startSmartPolling(runId) {
    stopSmartPolling();
    let interval = 4000;
    const poll = async () => {
      if (state.runId !== runId) return;
      try {
        if (document.visibilityState === 'visible') {
          const { run } = await Api.run(runId);
          if (!run || state.runId !== runId) return;
          renderRecentRun(run);
          setRunStatus(run.status);
          const progress = $('#run-progress-text');
          if (progress && ['running', 'queued'].includes(run.status)) {
            const { filled = 0, total = 0 } = run.progress || {};
            progress.textContent = run.status === 'queued' ? 'Đang chờ worker' :
              total ? 'Đã điền ' + filled + '/' + total + ' câu' : 'Đang giải bài…';
          }
          for (const hw of run.homeworks || []) {
            if (hw.id && hw.status) updateHwChipStatus(hw.id, hw.status);
          }
          if (run.logs?.length) syncLogs(run.logs);
          if (!['queued', 'running'].includes(run.status)) {
            finishRun(run);
            if (run.error) appendLog({ ts: Date.now(), level: 'warn', message: run.error });
            return;
          }
          interval = run.status === 'queued' ? 12000 : 5000;
        } else {
          interval = 15000;
        }
      } catch (err) {
        if (state.runId === runId && [401, 404].includes(err.status)) finishRun({ status: 'error' });
        interval = Math.min(interval * 2, 30000);
      }
      if (state.runId === runId) smartPollTimer = setTimeout(poll, interval + Math.random() * 1500);
    };
    smartPollTimer = setTimeout(poll, interval + Math.random() * 1500);
  }

  function stopSmartPolling() {
    clearTimeout(smartPollTimer);
    smartPollTimer = null;
  }

  async function syncRunStateOnFocus() {
    if (!sessionMarker) return;
    const token = sessionMarker;
    const getActiveRunId = () => {
      try { return state.runId || localStorage.getItem('olm.active_run_id'); } catch { return null; }
    };
    const activeRunId = getActiveRunId();
    if (!activeRunId) {
      if (!state.es || state.es.readyState === 2) connectEvents();
      return;
    }

    try {
      const data = await Api.run(activeRunId);
      if (sessionMarker !== token || getActiveRunId() !== activeRunId) return;
      if (data && data.run) {
        const r = data.run;
        state.runId = activeRunId;
        if (Array.isArray(r.logs) && r.logs.length > 0) {
          if (typeof syncLogs === 'function') syncLogs(r.logs);
          else if (window.UI?.syncLogs) window.UI.syncLogs(r.logs);
        }
        state.runningHomeworks = r.homeworks || [];
        renderHwLogChips(state.runningHomeworks);
        if (['queued', 'running'].includes(r.status)) {
          setRunStatus(r.status);
          setStatus(r.status === 'queued' ? 'Đang chờ worker' : 'Đang giải bài…', 'busy');
          const stopBtn = $('#btn-stop-run');
          if (stopBtn) {
            stopBtn.style.display = 'inline-flex';
            stopBtn.disabled = false;
          }
          if (!smartPollTimer) startSmartPolling(activeRunId);
          if (r.status === 'running') startBgKeepAlive();
        } else {
          finishRun(r);
        }
      }
    } catch (err) {
      if (sessionMarker === token && getActiveRunId() === activeRunId && [401, 404].includes(err.status)) {
        finishRun({ status: 'error' });
      }
    }
    if (!state.es || state.es.readyState === 2) connectEvents();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      syncRunStateOnFocus();
    }
  });

  window.addEventListener('focus', () => {
    syncRunStateOnFocus();
  });
})();
