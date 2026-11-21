// ==UserScript==
// @name         OLM Universal Ultimate Answer Helper (All Types & Science Normalizer v10.5 - Safari iOS & Main World Engine)
// @namespace    https://olm.vn/
// @version      10.5
// @description  Hiển thị gợi ý từ dữ liệu câu hỏi đã có trên OLM.
// @author       Antigravity
// @match        https://olm.vn/*
// @match        https://*.olm.vn/*
// @run-at       document-start
// @noframes
// @grant        none
// @connect      *
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
    'use strict';

    // 10. Chặn chạy trong iframe con để tránh nhân đôi UI hoặc xung đột DOM
    if (window.top !== window.self) {
        return;
    }

    // Hai tên file phân phối cùng một script. Chỉ gắn hook một lần mỗi trang.
    if (window.__olmHelperRunning) return;
    Object.defineProperty(window, '__olmHelperRunning', { value: true });

    const globalWin = window;

    const XOR_KEY = '1047823200';
    const HELPER_API_ORIGIN = '__OLM_HELPER_API_ORIGIN__';
    const HELPER_LICENSE_STORAGE_KEY = '__olm_helper_license_v1';
    const HELPER_HWID_STORAGE_KEY = '__olm_helper_hwid_v1';
    let licenseState = {
        checked: false,
        valid: false,
        checking: false,
        offline: false,
        error: '',
        license: null,
        hwid: '',
        deviceName: '',
        olmUsername: '',
        verifiedAt: 0,
    };

    function resolveHelperApiOrigin() {
        return HELPER_API_ORIGIN.startsWith('__OLM_HELPER_') ? 'https://giaiolm.com' : HELPER_API_ORIGIN;
    }

    async function helperApiFetch(url, options = {}) {
        try {
            const resp = await fetch(url, options);
            const data = await resp.json().catch(() => ({}));
            return { ok: resp.ok, status: resp.status, data };
        } catch (fetchErr) {
            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: options.method || 'GET',
                        url,
                        headers: options.headers || {},
                        data: options.body || undefined,
                        onload: (res) => {
                            let data = {};
                            try { data = JSON.parse(res.responseText || '{}'); } catch (e) {}
                            resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, data });
                        },
                        onerror: () => reject(new Error('Không thể kết nối máy chủ xác thực (bị chặn bởi CSP hoặc mất mạng).')),
                        ontimeout: () => reject(new Error('Kết nối máy chủ xác thực quá hạn.')),
                    });
                });
            }
            throw new Error('Không thể kết nối máy chủ xác thực (bị chặn bởi CSP hoặc mất mạng).');
        }
    }

    function detectDeviceName() {
        const ua = navigator.userAgent || '';
        let os = 'Thiết bị';
        if (/iPhone/i.test(ua)) os = 'iPhone';
        else if (/iPad/i.test(ua)) os = 'iPad';
        else if (/Android/i.test(ua)) os = 'Android';
        else if (/Windows/i.test(ua)) os = 'Windows';
        else if (/Mac/i.test(ua)) os = 'macOS';
        let browser = 'Browser';
        if (/CriOS|Chrome/i.test(ua) && !/Edg/i.test(ua)) browser = 'Chrome';
        else if (/Safari/i.test(ua)) browser = 'Safari';
        else if (/Firefox/i.test(ua)) browser = 'Firefox';
        return os + ' ' + browser;
    }

    async function computeHelperHWID() {
        try {
            const cached = localStorage.getItem(HELPER_HWID_STORAGE_KEY);
            if (cached && /^OLM-HW-[A-Z0-9]{8,32}$/.test(cached.trim())) {
                return cached.trim();
            }
        } catch (e) {}
        let glRenderer = '';
        try {
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
            if (gl) {
                const dbg = gl.getExtension('WEBGL_debug_renderer_info');
                glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : String(gl.getParameter(gl.RENDERER) || '');
            }
        } catch (e) {}
        const raw = [
            navigator.platform || '',
            navigator.hardwareConcurrency || '',
            navigator.maxTouchPoints || '',
            screen.width + 'x' + screen.height,
            window.devicePixelRatio || 1,
            Intl.DateTimeFormat().resolvedOptions().timeZone || '',
            navigator.language || '',
            glRenderer,
        ].join('|');
        let fp = '';
        try {
            if (window.crypto?.subtle) {
                const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
                const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
                fp = 'OLM-HW-' + hex.slice(0, 24).toUpperCase();
            }
        } catch (e) {}
        if (!fp) {
            let h = 2166136261;
            for (let i = 0; i < raw.length; i++) {
                h ^= raw.charCodeAt(i);
                h = Math.imul(h, 16777619);
            }
            fp = 'OLM-HW-' + (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
        }
        try { localStorage.setItem(HELPER_HWID_STORAGE_KEY, fp); } catch (e) {}
        return fp;
    }

    function detectOlmUsername() {
        try {
            const u1 = globalWin.OTM_SERVER_DATA?.user?.username;
            if (u1 && typeof u1 === 'string') return u1.trim();
            const u2 = globalWin.VIDEO_UI_V2?.values?.page_user?.username;
            if (u2 && typeof u2 === 'string') return u2.trim();
            const u3 = globalWin.baseCategoryUtils?.values?.username;
            if (u3 && typeof u3 === 'string') return u3.trim();
            if (Array.isArray(globalWin.dataLayer)) {
                for (const item of globalWin.dataLayer) {
                    if (item && typeof item.username === 'string' && item.username.trim()) return item.username.trim();
                }
            }
            const accountSelectors = [
                'header a[href*="/thanh-vien/"]',
                'header [data-username]',
                'nav a[href*="/thanh-vien/"]',
                'nav [data-username]',
                '.navbar a[href*="/thanh-vien/"]',
                '.navbar [data-username]',
                '.user-profile a[href*="/thanh-vien/"]',
                '.user-profile [data-username]',
                '.user-menu a[href*="/thanh-vien/"]',
                '.user-menu [data-username]',
                '.sidebar-user a[href*="/thanh-vien/"]',
                '.sidebar-user [data-username]',
                '#user-menu a[href*="/thanh-vien/"]',
                '#user-menu [data-username]',
            ];
            for (const sel of accountSelectors) {
                const links = document.querySelectorAll(sel);
                for (const link of links) {
                    const attr = link.getAttribute('data-username');
                    if (attr && attr.trim()) return attr.trim();
                    const m = (link.getAttribute('href') || '').match(/\/thanh-vien\/([^/?#]+)/i);
                    if (m && m[1]) return decodeURIComponent(m[1]).trim();
                }
            }
        } catch (e) {}
        return '';
    }

    function readSavedHelperLicense() {
        try {
            const raw = localStorage.getItem(HELPER_LICENSE_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function saveHelperLicense(lic) {
        try {
            if (lic) localStorage.setItem(HELPER_LICENSE_STORAGE_KEY, JSON.stringify(lic));
            else localStorage.removeItem(HELPER_LICENSE_STORAGE_KEY);
        } catch (e) {}
    }

    async function verifyHelperLicense(force = false) {
        if (licenseState.checking) return licenseState.valid;
        licenseState.checking = true;
        try {
            const hwid = await computeHelperHWID();
            const deviceName = detectDeviceName();
            const detectedUser = detectOlmUsername();
            licenseState.hwid = hwid;
            licenseState.deviceName = deviceName;
            if (detectedUser) licenseState.olmUsername = detectedUser;

            const saved = readSavedHelperLicense();
            if (!saved || !saved.key) {
                licenseState.valid = false;
                licenseState.checked = true;
                licenseState.license = null;
                return false;
            }
            if (saved.hwid && saved.hwid !== hwid) {
                saveHelperLicense(null);
                licenseState.valid = false;
                licenseState.checked = true;
                licenseState.license = null;
                licenseState.error = 'Thiết bị không khớp HWID đã kích hoạt. Vui lòng nhập lại key!';
                return false;
            }
            if (detectedUser && saved.olmUsername && saved.olmUsername.toLowerCase() !== detectedUser.toLowerCase()) {
                licenseState.valid = false;
                licenseState.checked = true;
                licenseState.license = null;
                licenseState.error = 'Tài khoản OLM hiện tại (@' + detectedUser + ') khác với tài khoản đã gắn key (@' + saved.olmUsername + ').';
                return false;
            }
            if (!force && licenseState.valid && Date.now() - licenseState.verifiedAt < 120000) {
                return true;
            }

            const { ok: respOk, data } = await helperApiFetch(resolveHelperApiOrigin() + '/api/helper/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: saved.key,
                    olmUsername: detectedUser || saved.olmUsername || '',
                    hwid,
                    deviceName,
                }),
            });
            licenseState.offline = false;
            if (respOk && data.ok && data.license) {
                const updated = {
                    ...data.license,
                    hwid,
                    deviceName,
                    verifiedAt: Date.now(),
                };
                saveHelperLicense(updated);
                licenseState.valid = true;
                licenseState.checked = true;
                licenseState.error = '';
                licenseState.license = updated;
                licenseState.verifiedAt = Date.now();
                return true;
            }
            licenseState.valid = false;
            licenseState.checked = true;
            licenseState.license = saved;
            licenseState.error = data.error || 'Key không hợp lệ hoặc đã hết hạn.';
            return false;
        } catch (e) {
            const saved = readSavedHelperLicense();
            if (saved?.key && saved.hwid === licenseState.hwid && (!saved.expiresAt || saved.expiresAt > Date.now()) &&
                saved.verifiedAt && (Date.now() - saved.verifiedAt < 600000)) {
                licenseState.offline = false;
                licenseState.valid = true;
                licenseState.checked = true;
                licenseState.license = saved;
                return true;
            }
            licenseState.offline = true;
            licenseState.valid = false;
            licenseState.checked = true;
            licenseState.license = saved || null;
            licenseState.error = e?.message || 'Không thể kết nối máy chủ xác thực bản quyền.';
            return false;
        } finally {
            licenseState.checking = false;
        }
    }

    async function activateHelperLicense(keyInput, usernameInput) {
        const cleanKey = String(keyInput || '').trim().toUpperCase();
        const detectedUser = detectOlmUsername();
        const cleanUser = (detectedUser || String(usernameInput || '')).trim();
        if (!cleanKey) return { ok: false, error: 'Vui lòng nhập mã Key.' };
        if (!cleanUser) return { ok: false, error: 'Vui lòng nhập tên đăng nhập OLM của bạn.' };

        const hwid = licenseState.hwid || await computeHelperHWID();
        const deviceName = licenseState.deviceName || detectDeviceName();
        try {
            const { ok: respOk, data } = await helperApiFetch(resolveHelperApiOrigin() + '/api/helper/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    key: cleanKey,
                    olmUsername: cleanUser,
                    hwid,
                    deviceName,
                }),
            });
            if (!respOk || !data.ok || !data.license) {
                return { ok: false, error: data.error || 'Kích hoạt thất bại.' };
            }
            const saved = {
                ...data.license,
                hwid,
                deviceName,
                verifiedAt: Date.now(),
            };
            saveHelperLicense(saved);
            licenseState.offline = false;
            licenseState.valid = true;
            licenseState.checked = true;
            licenseState.error = '';
            licenseState.license = saved;
            licenseState.olmUsername = saved.olmUsername || cleanUser;
            licenseState.verifiedAt = Date.now();
            return { ok: true, license: saved };
        } catch (e) {
            return { ok: false, error: 'Lỗi kết nối máy chủ xác thực (' + e.message + ').' };
        }
    }
    let rawAnswerDatabase = [];
    let isPanelOpen = false;
    let overlayRoot;
    let savedScrollTop = 0;
    const capturedShadowRoots = new WeakMap();
    const attachedRoots = new Set();
    const optionMarks = new Map();
    const hintBadges = new Map();

    let pageUrl = location.href;
    let pageKey = lessonKey(pageUrl);
    let pageRevision = 0;
    let inlineRequestContext = null;
    let pendingFetch = null;
    let nextFetchAt = 0;
    let fetchFailures = 0;
    const attemptedIds = new Set();
    let renderPending = false;
    let lastOmrPayload = '';
    let omrResult = null;
    let questionIds = [];
    const questionParts = new Map();
    const optionShuffleMap = new Map();
    const pageGlobalOwners = new WeakMap();
    const appliedPageGlobals = new Map();
    const globalKeys = ['data_practice', 'data_exam_hierarchy', 'data_exam', 'data_lesson',
        'data_test', 'data_smart_practice', 'data_hierarchy', 'data_quiz', 'EXAM_FILE',
        'data_lecture', 'data_video', 'data_interactive', 'data_homework', 'data_category', 'data_cate'];

    function pageGlobalSignature(value) {
        if (!value || typeof value !== 'object') return '';
        const record = value.record || value;
        try {
            return JSON.stringify([record.quiz_list, record.list_quiz, record.data_log, value.list_id_quiz,
                value.quiz_list, value.list_all, value.list_id_script, value.data_question_node, value.parts, value.sections, record.parts, record.sections, value.id_subject, value.values?.result_question]);
        } catch (e) {
            return '';
        }
    }

    function lessonKey(href) {
        const url = new URL(href);
        const identity = ['id', 'i_c', 'id_cate', 'id_category', 'exam_id', 'test_id', 'lesson_id',
            'practice_id', 'attempt_id', 'id_attempt', 'record_id'];
        const query = new URLSearchParams();
        for (const key of identity) {
            const value = url.searchParams.get(key);
            if (value) query.set(key, value);
        }
        const search = query.toString();
        return url.origin + url.pathname.replace(/\/+$/, '') + (search ? '?' + search : '');
    }

    function readPageGlobal(key) {
        const value = globalWin[key];
        if (!value || typeof value !== 'object') return value;
        const signature = pageGlobalSignature(value);
        const previous = pageGlobalOwners.get(value);
        if (previous && previous.pageKey !== pageKey && previous.signature === signature) return undefined;
        pageGlobalOwners.set(value, { pageKey, signature });
        return value;
    }

    if (typeof Element !== 'undefined' && Element.prototype.attachShadow) {
        const attachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) {
            const root = attachShadow.call(this, init);
            capturedShadowRoots.set(this, root);
            attachedRoots.add(typeof WeakRef === 'function' ? new WeakRef(root) : root);
            return root;
        };
    }

    function getShadowRoot(host) {
        return host.shadowRoot || capturedShadowRoots.get(host);
    }

    function syncPage() {
        if (pageUrl === location.href) return;
        pageUrl = location.href;
        const nextKey = lessonKey(pageUrl);
        if (nextKey === pageKey) return;
        pageKey = nextKey;
        pageRevision++;
        inlineRequestContext = null;
        pendingFetch?.abort();
        pendingFetch = null;
        nextFetchAt = 0;
        fetchFailures = 0;
        attemptedIds.clear();
        lastOmrPayload = '';
        omrResult = null;
        questionIds = [];
        questionParts.clear();        optionShuffleMap.clear();
        rawAnswerDatabase = [];
        clearHighlights();
        appliedPageGlobals.clear();
        restoreScrollPosition();
        lastPanelHtml = '';
        renderedItems = [];
        visibleItems = [];
        const list = document.getElementById('olm-scroll-list');
        if (list) {
            list.replaceChildren();
            list.scrollTop = savedScrollTop;
        }
        const count = document.getElementById('olm-total-count');
        if (count) count.textContent = '0 câu';
        const jump = document.getElementById('olm-jump-active-btn');
        if (jump) jump.hidden = true;
        const button = document.getElementById('olm-fetch-now-btn');
        setFetchStatus(button, '⚡', 'Nạp đáp án');
    }

    function scrollStorageKey() {
        return '__olm_scroll_' + pageKey;
    }

    function restoreScrollPosition() {
        savedScrollTop = 0;
        try {
            savedScrollTop = Math.max(0, Number(sessionStorage.getItem(scrollStorageKey()) ?? sessionStorage.getItem('__olm_scroll_v97_' + pageUrl)) || 0);
        } catch (e) {}
    }

    function saveScrollPosition(val) {
        savedScrollTop = val;
        try {
            sessionStorage.setItem(scrollStorageKey(), String(Math.round(val)));
        } catch (e) {}
    }

    restoreScrollPosition();

    function queueRender() {
        if (!isPanelOpen || renderPending || document.hidden) return;
        renderPending = true;
        requestAnimationFrame(() => {
            renderPending = false;
            if (isPanelOpen && !document.hidden) renderShuffledAnswersIntoPanel();
        });
    }

    // =========================================================================
    // 1. CHUẨN HÓA KHOA HỌC TOÀN DIỆN (SCIENCE & MATH NORMALIZER - LỚP 1 ĐẾN ĐẠI HỌC)
    //    Xử lý triệt để KaTeX (.mfrac đảo ngược, .msupsub, .sqrt), MathML, và HTML
    // =========================================================================
    const SUPERSCRIPT_MAP = {
        '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
        '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
        '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
        'ⁿ': 'n', 'ⁱ': 'i'
    };

    const SUBSCRIPT_MAP = {
        '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
        '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
        '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
        'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
        'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
        'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u',
        'ᵥ': 'v', 'ₓ': 'x'
    };

    function parseMathMLNodeDOM(node) {
        if (!node) return '';
        if (node.nodeType === 3) return node.nodeValue || '';
        if (node.nodeType !== 1) return '';

        const tag = (node.tagName || '').toLowerCase().replace(/^m:/, '');
        const elemChildren = Array.from(node.children || []);
        const children = Array.from(node.childNodes || []).filter(
            c => c.nodeType === 1 || (c.nodeType === 3 && (c.nodeValue || '').trim() !== '')
        );

        if (tag === 'annotation') return '';
        if (tag === 'mfrac' && elemChildren.length >= 2) {
            const num = parseMathMLNodeDOM(elemChildren[0]).trim();
            const den = parseMathMLNodeDOM(elemChildren[1]).trim();
            return '(' + num + ')/(' + den + ')';
        }
        if (tag === 'msup' && elemChildren.length >= 2) {
            const base = parseMathMLNodeDOM(elemChildren[0]).trim();
            const sup = parseMathMLNodeDOM(elemChildren[1]).trim();
            return base + '^(' + sup + ')';
        }
        if (tag === 'msub' && elemChildren.length >= 2) {
            const base = parseMathMLNodeDOM(elemChildren[0]).trim();
            const sub = parseMathMLNodeDOM(elemChildren[1]).trim();
            return base + '_(' + sub + ')';
        }
        if (tag === 'msubsup' && elemChildren.length >= 3) {
            const base = parseMathMLNodeDOM(elemChildren[0]).trim();
            const sub = parseMathMLNodeDOM(elemChildren[1]).trim();
            const sup = parseMathMLNodeDOM(elemChildren[2]).trim();
            return base + '_(' + sub + ')^(' + sup + ')';
        }
        if (tag === 'msqrt') {
            const inner = children.map(parseMathMLNodeDOM).join('').trim();
            return '√(' + inner + ')';
        }
        if (tag === 'mroot' && elemChildren.length >= 2) {
            const base = parseMathMLNodeDOM(elemChildren[0]).trim();
            const idx = parseMathMLNodeDOM(elemChildren[1]).trim();
            return idx === '3' ? '∛(' + base + ')' : idx === '4' ? '∜(' + base + ')' : '√[' + idx + '](' + base + ')';
        }
        if (tag === 'mover' && elemChildren.length >= 2) {
            const base = parseMathMLNodeDOM(elemChildren[0]).trim();
            const over = parseMathMLNodeDOM(elemChildren[1]).trim();
            if (over === '→' || over === '⇀' || over === '¯') return 'vectơ ' + base;
            return base + over;
        }
        return children.map(parseMathMLNodeDOM).join('');
    }

    /**
     * Chuẩn hóa cấu trúc KaTeX DOM (đặc biệt .mfrac bị xếp ngược mẫu số trước tử số trong KaTeX)
     */
    function normalizeMathStructureInDOM(rootEl) {
        if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
        const doc = rootEl.ownerDocument || document;

        // 1. Khối .katex, .MathJax, mjx-container
        rootEl.querySelectorAll('.katex, .MathJax, mjx-container').forEach(k => {
            const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ||
                k.querySelector('math')?.getAttribute('alttext') ||
                k.getAttribute('data-latex') ||
                k.getAttribute('alttext') || '';
            if (tex) {
                k.replaceWith(doc.createTextNode(' $' + tex + '$ '));
                return;
            }

            const mathEl = k.querySelector('.katex-mathml math, math');
            if (mathEl && mathEl.querySelector('mfrac, msup, msub, msubsup, msqrt, mroot')) {
                const parsedMml = parseMathMLNodeDOM(mathEl).trim();
                if (parsedMml) {
                    k.replaceWith(doc.createTextNode(' ' + parsedMml + ' '));
                    return;
                }
            }

            // Xóa .katex-mathml để tránh bị lặp nội dung 2 lần
            k.querySelectorAll('.katex-mathml, mjx-assistive-mml, .MJX_Assistive_MathML').forEach(m => m.remove());

            const khtml = k.querySelector('.katex-html') || k;

            // 1a. Căn thức (.sqrt)
            const renderRoot = sq => {
                const rootIdx = sq.querySelector('.root')?.textContent?.trim() || '';
                const vlist = sq.querySelector('.vlist-t .vlist');
                let rad = '';
                if (vlist && vlist.children.length > 0) {
                    rad = vlist.children[0].textContent?.trim() || '';
                } else {
                    const cloneSq = sq.cloneNode(true);
                    cloneSq.querySelectorAll('.root, .sqrt-sign, svg').forEach(n => n.remove());
                    rad = cloneSq.textContent?.trim() || '';
                }
                const rep = rootIdx ? (rootIdx === '3' ? '∛(' + rad + ')' : '√[' + rootIdx + '](' + rad + ')') : '√(' + rad + ')';
                sq.replaceWith(doc.createTextNode(rep));
            };

            // 1b. Số mũ & chỉ số dưới (.msupsub)
            const renderScripts = ss => {
                const vlist = ss.querySelector('.vlist-t .vlist');
                if (vlist && vlist.children.length > 0) {
                    const parts = [];
                    Array.from(vlist.children).forEach(ch => {
                        const txt = (ch.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
                        if (!txt) return;
                        const style = ch.getAttribute('style') || '';
                        const topMatch = style.match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
                        const topVal = topMatch ? parseFloat(topMatch[1]) : -3.0;
                        if (topVal < -2.75) {
                            if (/^[°∘]$/.test(txt)) parts.push('°');
                            else parts.push('^(' + txt + ')');
                        } else {
                            parts.push('_(' + txt + ')');
                        }
                    });
                    if (parts.length > 0) {
                        ss.replaceWith(doc.createTextNode(parts.join('')));
                        return;
                    }
                }
                const rawSs = (ss.textContent || '').trim();
                if (rawSs) ss.replaceWith(doc.createTextNode('^(' + rawSs + ')'));
            };

            // 1c. Phân số (.mfrac) - Xếp lại đúng thứ tự TỬ SỐ / MẪU SỐ
            const renderFraction = mf => {
                const vlist = mf.querySelector('.vlist-t .vlist');
                if (vlist && vlist.children.length >= 2) {
                    const children = Array.from(vlist.children);
                    const lineIdx = children.findIndex(c => c.querySelector('.frac-line') || c.classList?.contains('frac-line'));
                    let num = '';
                    let den = '';
                    if (lineIdx > 0 && lineIdx < children.length - 1) {
                        den = children.slice(0, lineIdx).map(c => c.textContent.trim()).filter(Boolean).join('');
                        num = children.slice(lineIdx + 1).map(c => c.textContent.trim()).filter(Boolean).join('');
                    } else {
                        const nonLine = children.filter(c => !c.querySelector('.frac-line') && !c.classList?.contains('frac-line'));
                        if (nonLine.length >= 2) {
                            const withTop = nonLine.map((c, idx) => {
                                const m = (c.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
                                return { el: c, top: m ? parseFloat(m[1]) : -idx };
                            });
                            withTop.sort((a, b) => a.top - b.top);
                            num = withTop[0].el.textContent.trim();
                            den = withTop[withTop.length - 1].el.textContent.trim();
                        }
                    }
                    if (num || den) {
                        mf.replaceWith(doc.createTextNode(' (' + num + ')/(' + den + ') '));
                    }
                }
            };
            for (const part of Array.from(khtml.querySelectorAll('.sqrt, .msupsub, .mfrac')).reverse()) {
                if (part.matches('.sqrt')) renderRoot(part);
                else if (part.matches('.msupsub')) renderScripts(part);
                else renderFraction(part);
            }
        });

        // 2. Thẻ HTML <sup> và <sub>
        Array.from(rootEl.querySelectorAll('sup')).reverse().forEach(sup => {
            const txt = (sup.textContent || '').trim();
            if (!txt) { sup.remove(); return; }
            const nextTxt = sup.nextSibling?.textContent || '';
            if (/^[°∘o0]$/.test(txt) && (/^[CFK]\b/i.test(nextTxt.trim()) || txt === '°' || txt === '∘')) {
                sup.replaceWith(doc.createTextNode('°'));
            } else {
                sup.replaceWith(doc.createTextNode('^(' + txt + ')'));
            }
        });

        Array.from(rootEl.querySelectorAll('sub')).reverse().forEach(sub => {
            const txt = (sub.textContent || '').trim();
            if (!txt) { sub.remove(); return; }
            sub.replaceWith(doc.createTextNode('_(' + txt + ')'));
        });

        return rootEl;
    }

    function optionImageUrl(image) {
        const src = image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('src') || '';
        if (!src) return null;
        try {
            const url = new URL(src, location.href);
            if (url.protocol === 'https:' || (url.protocol === 'http:' && url.origin === location.origin)) return url;
            if (url.protocol === 'blob:' && url.origin === location.origin && url.origin !== 'null') return url;
            if (url.protocol === 'data:' && /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(src)) return url;
        } catch (e) {}
        return null;
    }

    const svgShapes = new Set(['svg', 'g', 'path', 'line', 'rect', 'circle', 'ellipse', 'polyline', 'polygon', 'text', 'tspan']);
    const svgAttributes = new Set(['viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy',
        'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'stroke', 'stroke-width', 'text-anchor', 'font-size']);

    function staticSvgMarkup(node) {
        if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue.trim());
        if (!svgShapes.has(node.localName)) return '';
        const attrs = Array.from(node.attributes).filter(attr => svgAttributes.has(attr.name) &&
            (!['fill', 'stroke'].includes(attr.name) || /^(?:#[a-f\d]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.,%+\-\s/]+\))$/i.test(attr.value.trim())))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(attr => ' ' + attr.name + '="' + escapeHtml(attr.value) + '"').join('');
        const sizing = node.localName === 'svg' ? ' style="max-width:100%;height:auto;vertical-align:middle;"' : '';
        return '<' + node.localName + attrs + sizing + '>' + Array.from(node.childNodes, staticSvgMarkup).join('') +
            '</' + node.localName + '>';
    }

    function optionCanvasImage(canvas) {
        if (!canvas.width || !canvas.height || canvas.width * canvas.height > 500000) return '';
        try {
            return canvas.toDataURL('image/png');
        } catch (e) {
            return '';
        }
    }

    function visualKey(text) {
        let hash = 2166136261;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
        return text.length + '-' + (hash >>> 0).toString(36);
    }

    function imageMatchKey(url) {
        if (!url) return '';
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname;
        if (url.protocol === 'blob:') return url.href;
        return 'data-' + visualKey(url.href);
    }

    function extractOptionCleanText(el) {
        if (!el) return '';
        if (typeof el === 'string') return cleanScienceText(el);

        const clone = el.cloneNode(true);
        clone.querySelectorAll('#olm-mini-panel, #olm-mini-btn, .olm-mq-hint, script, style').forEach(e => e.remove());
        normalizeMathStructureInDOM(clone);

        clone.querySelectorAll('img').forEach(img => {
            const asset = imageMatchKey(optionImageUrl(img));
            if (asset || img.alt) img.replaceWith(document.createTextNode(' [img:' + (asset || img.alt) + '] '));
        });

        clone.querySelectorAll('svg').forEach(svg => {
            svg.replaceWith(document.createTextNode(' [img:svg-' + visualKey(staticSvgMarkup(svg)) + '] '));
        });
        const canvases = Array.from(el.querySelectorAll('canvas'), optionCanvasImage);
        clone.querySelectorAll('canvas').forEach((canvas, index) => {
            const data = canvases[index];
            if (data) canvas.replaceWith(document.createTextNode(' [img:canvas-' + visualKey(data) + '] '));
        });
        const raw = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();
        return cleanScienceText(raw);
    }

    /**
     * Chuẩn hóa văn bản Toán, Lý, Hóa, Sinh, Tin (Lớp 1 đến Đại học)
     */
    function cleanScienceText(str) {
        if (str === null || str === undefined) return '';
        let s = String(str)
            .normalize('NFC')
            .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
            .replace(/\u00A0/g, ' ')
            .replace(/[\r\n\t]+/g, ' ')
            .trim();

        // 1. Số mũ và chỉ số dưới Unicode: Chuyển đổi kèm tiền tố ^() và _() để khớp tuyệt đối với LaTeX
        s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, m => '^(' + m.split('').map(ch => SUPERSCRIPT_MAP[ch] || ch).join('') + ')');
        s = s.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/g, m => '_(' + m.split('').map(ch => SUBSCRIPT_MAP[ch] || ch).join('') + ')');
        // Chuẩn hóa LaTeX mũ ^{...} và chỉ số _{...} đồng nhất về ^(...) và _(...)
        for (let depth = 0; depth < 8; depth++) {
            const normalized = s.replace(/([_^])\{([^{}]+)\}/g, '$1($2)');
            if (normalized === s) break;
            s = normalized;
        }
        s = s.replace(/\^([+-]?\d+|[A-Za-z](?![A-Za-z0-9]))/g, '^($1)');
        s = s.replace(/(^|[^\w])([A-Za-z])_(\d+)(?!\w)/g, '$1$2_($3)');
        if (/\\[A-Za-z]+|\$[^$]+\$/.test(s)) {
            s = s.replace(/_([A-Za-z])(?!\w)/g, '_($1)');
        }

        // 2. Nhiệt độ & Độ góc
        s = s.replace(/℃/g, '°C').replace(/℉/g, '°F').replace(/K/g, 'K');
        s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘])\s*\}\s*([CFK])\b/g, '°$1');
        s = s.replace(/\^\(\s*(?:\\circ|\\degree|[°∘])\s*\)\s*([CFK])\b/g, '°$1');
        s = s.replace(/\^(?:\\circ|\\degree|[°∘])\s*([CFK])\b/g, '°$1');
        s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘])\s*\}/g, '°');
        s = s.replace(/\^\(\s*(?:\\circ|\\degree|[°∘])\s*\)/g, '°');
        s = s.replace(/\\(?:circ|degree)(?![a-zA-Z])/g, '°');
        s = s.replace(/[∘˚º]/g, '°');
        s = s.replace(/°\s+([CFK])\b/g, '°$1');

        // 3. Đạo hàm
        s = s.replace(/\\(?:prime)(?![a-zA-Z])/g, "'");
        s = s.replace(/″|''/g, "''").replace(/‴|'''/g, "'''").replace(/[’‘′`]/g, "'");

        // 4. Phép toán cơ bản
        s = s.replace(/[\u2212\u2013\u2014]/g, '-');
        s = s.replace(/\\(?:cdot|bullet|centerdot)(?![a-zA-Z])|[\u22C5\u2022\u2219]/g, '·');
        s = s.replace(/\\times(?![a-zA-Z])|\u00D7/g, '×');
        s = s.replace(/\\div(?![a-zA-Z])|\u00F7/g, ':');
        s = s.replace(/\\pm(?![a-zA-Z])|\u00B1/g, '±');
        s = s.replace(/\\mp(?![a-zA-Z])|\u2213/g, '∓');
        s = s.replace(/\\(?:ast|star)(?![a-zA-Z])|\u2217/g, '*');

        // 5. So sánh & Quan hệ
        s = s.replace(/î€\s*=|\s*=/g, '≠');
        s = s.replace(/\\(?:neq|ne|not=)(?![a-zA-Z])/g, '≠');
        s = s.replace(/\\gt(?![a-zA-Z])/g, '>');
        s = s.replace(/\\lt(?![a-zA-Z])/g, '<');
        s = s.replace(/\\(?:ge|geq|geqslant)(?![a-zA-Z])|⩾/g, '≥');
        s = s.replace(/\\(?:le|leq|leqslant)(?![a-zA-Z])|⩽/g, '≤');
        s = s.replace(/\\(?:approx|thickapprox)(?![a-zA-Z])/g, '≈');
        s = s.replace(/\\equiv(?![a-zA-Z])/g, '≡');
        s = s.replace(/\\perp(?![a-zA-Z])/g, '⊥');
        s = s.replace(/\\parallel(?![a-zA-Z])|\u2225/g, '∥');

        // 6. Logic & Mũi tên
        s = s.replace(/\\(?:to|rightarrow|longrightarrow|mapsto)(?![a-zA-Z])|⟶|↦/g, '→');
        s = s.replace(/\\(?:leftarrow|longleftarrow)(?![a-zA-Z])|⟵/g, '←');
        s = s.replace(/\\(?:leftrightarrow|longleftrightarrow)(?![a-zA-Z])|⟷/g, '↔');
        s = s.replace(/\\(?:Rightarrow|implies|Longrightarrow)(?![a-zA-Z])|⟹/g, '⇒');
        s = s.replace(/\\(?:Leftrightarrow|iff|Longleftrightarrow)(?![a-zA-Z])|⟺/g, '⇔');
        s = s.replace(/\\(?:rightleftharpoons|equilibrium)(?![a-zA-Z])|⇄/g, '⇌');
        s = s.replace(/\\(?:uparrow)(?![a-zA-Z])/g, '↑');
        s = s.replace(/\\(?:downarrow)(?![a-zA-Z])/g, '↓');

        // 7. Tập hợp & Đại số
        s = s.replace(/\\forall(?![a-zA-Z])/g, '∀').replace(/\\exists(?![a-zA-Z])/g, '∃');
        s = s.replace(/\\in(?![a-zA-Z])/g, '∈').replace(/\\notin(?![a-zA-Z])/g, '∉');
        s = s.replace(/\\subset(?![a-zA-Z])/g, '⊂').replace(/\\supset(?![a-zA-Z])/g, '⊃');
        s = s.replace(/\\subseteq(?![a-zA-Z])/g, '⊆').replace(/\\supseteq(?![a-zA-Z])/g, '⊇');
        s = s.replace(/\\cup(?![a-zA-Z])/g, '∪').replace(/\\cap(?![a-zA-Z])/g, '∩');
        s = s.replace(/\\mathbb\{R\}|\\mathbf\{R\}|\\bf R|ℝ/g, 'R');
        s = s.replace(/\\mathbb\{N\}|\\mathbf\{N\}|\\bf N|ℕ/g, 'N');
        s = s.replace(/\\mathbb\{Z\}|\\mathbf\{Z\}|\\bf Z|ℤ/g, 'Z');
        s = s.replace(/\\mathbb\{Q\}|\\mathbf\{Q\}|\\bf Q|ℚ/g, 'Q');
        s = s.replace(/\\mathbb\{C\}|\\mathbf\{C\}|\\bf C|ℂ/g, 'C');

        // 8. Giải tích & Căn thức
        s = s.replace(/\\int(?![a-zA-Z])\s*|∫\s*/g, '∫');
        s = s.replace(/\\iint(?![a-zA-Z])\s*|∬\s*/g, '∬');
        s = s.replace(/\\iiint(?![a-zA-Z])\s*|∭\s*/g, '∭');
        s = s.replace(/\\oint(?![a-zA-Z])\s*|∮\s*/g, '∮');
        s = s.replace(/\\partial(?![a-zA-Z])/g, '∂').replace(/\\nabla(?![a-zA-Z])/g, '∇');
        s = s.replace(/\\infty(?![a-zA-Z])/g, '∞').replace(/\\sum(?![a-zA-Z])/g, '∑').replace(/\\prod(?![a-zA-Z])/g, '∏');

        // Normalize the innermost supported TeX groups first.
        for (let depth = 0; depth < 12; depth++) {
            const normalized = s
                .replace(/\\(?:overline|bar)\s*\{([^{}]+)\}/g, (_, value) => Array.from(value, ch => ch + '\u0305').join(''))
                .replace(/\\hat\s*\{([^{}]+)\}/g, (_, value) => value + '\u0302')
                .replace(/\\(?:overrightarrow|overleftarrow|vec|vect)\s*\{([^{}]+)\}/g, 'vectơ $1')
                .replace(/\\(?:widehat|wideparen)\s*\{([^{}]+)\}/g, 'góc $1')
                .replace(/\\(?:mathrm|text|mbox|mathbf|mathit|textbf|textit|textrm)\s*\{([^{}]*)\}/g, '$1')
                .replace(/\\sqrt(?:\[([^\]]+)\])?\s*\{([^{}]+)\}/g, (_, index, value) =>
                    (index === '3' ? '∛' : index === '4' ? '∜' : index ? '√[' + index + ']' : '√') + '(' + value + ')')
                .replace(/\\(?:dfrac|frac|tfrac|cfrac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)')
                .replace(/([_^])\{([^{}]+)\}/g, '$1($2)');
            if (normalized === s) break;
            s = normalized;
        }

        // 9. Hình học & Vectơ
        s = s.replace(/\\(?:overrightarrow|overleftarrow|vec|vect)\s*\{([^{}]+)\}/g, 'vectơ $1');
        s = s.replace(/\\(?:widehat|wideparen)\s*\{([^{}]+)\}/g, 'góc $1');
        s = s.replace(/\\(?:angle|measuredangle)(?![a-zA-Z])|∡|∢/g, '∠');
        s = s.replace(/\\(?:triangle|bigtriangleup)(?![a-zA-Z])|∆(?=\s*[A-Z]{3})/g, '△');

        // 10. Bảng chữ cái Hy Lạp
        s = s.replace(/\\Delta(?![a-zA-Z])|\u2206|𝛥/g, 'Δ');
        s = s.replace(/\\Omega(?![a-zA-Z])|\u2126/g, 'Ω');
        s = s.replace(/\\alpha(?![a-zA-Z])/g, 'α').replace(/\\beta(?![a-zA-Z])/g, 'β');
        s = s.replace(/\\gamma(?![a-zA-Z])/g, 'γ').replace(/\\delta(?![a-zA-Z])/g, 'δ');
        s = s.replace(/\\(?:varepsilon|epsilon)(?![a-zA-Z])/g, 'ε');
        s = s.replace(/\\lambda(?![a-zA-Z])/g, 'λ').replace(/\\mu(?![a-zA-Z])/g, 'μ');
        s = s.replace(/\\pi(?![a-zA-Z])/g, 'π').replace(/\\rho(?![a-zA-Z])/g, 'ρ');
        s = s.replace(/\\sigma(?![a-zA-Z])/g, 'σ').replace(/\\theta(?![a-zA-Z])/g, 'θ');
        s = s.replace(/\\omega(?![a-zA-Z])/g, 'ω').replace(/\\phi(?![a-zA-Z])/g, 'φ');

        const greek = { varphi: 'φ', tau: 'τ', eta: 'η', zeta: 'ζ', chi: 'χ', psi: 'ψ',
            Gamma: 'Γ', Lambda: 'Λ', Sigma: 'Σ', Pi: 'Π', Phi: 'Φ', Psi: 'Ψ', Theta: 'Θ' };
        s = s.replace(/\\(varphi|tau|eta|zeta|chi|psi|Gamma|Lambda|Sigma|Pi|Phi|Psi|Theta)(?![A-Za-z])/g,
            (_, name) => greek[name]);

        // 11. Bỏ định dạng rác LaTeX
        s = s.replace(/\\(?:displaystyle|textstyle|scriptstyle|limits|nolimits|left|right|big|Big)\b/g, '');
        for (let t = 0; t < 3; t++) {
            s = s.replace(/\\(?:mathrm|text|mbox|mathbf|mathit|textbf|textit|textrm)\s*\{([^{}]*)\}/g, '$1');
        }
        s = s.replace(/\\(?:quad|qquad|space|thinspace|;|!|,)(?![a-zA-Z])/g, ' ');
        s = s.replace(/\\([{}])/g, '$1').replace(/\$([^$]+)\$/g, '$1');

        return s.replace(/\s+/g, ' ').trim();
    }

    function cleanLooseScience(str) {
        return cleanScienceText(str).replace(/\s+/g, '');
    }

    // =========================================================================
    // 2. BỘ HIỂN THỊ CÔNG THỨC TRỰC QUAN (RICH HTML MATH FORMATTER)
    //    Định dạng phân số, căn thức, số mũ, ma trận thành HTML chuẩn đẹp không lỗi font
    // =========================================================================
        // 8. Chống XSS: Hàm mã hóa chuỗi HTML an toàn
    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatRichHtml(value) {
        const source = String(value ?? '');
        const text = /\\(?:[a-z]+|[,;!{}])|[_^]\{|\^[-+\w]|[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀-₉]|(?:^|[^\w])[a-z]_\d|\$[^$]+\$/i.test(source)
            ? cleanScienceText(source) : source;
        const openings = [];
        const pairs = new Map();
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '(') openings.push(i);
            if (text[i] === ')' && openings.length) pairs.set(openings.pop(), i);
        }
        function render(start, end, depth = 0) {
            if (depth === 16) return escapeHtml(text.slice(start, end));
            const chunks = [];
            let plainStart = start;
            for (let i = start; i < end; i++) {
                let html;
                let stop;
                const char = text[i];
                const close = pairs.get(i + 1);
                if ('^_√∛∜'.includes(char) && close < end) {
                    const inner = render(i + 2, close, depth + 1);
                    const tag = char === '^' ? 'sup' : 'sub';
                    html = char === '^' || char === '_' ? '<' + tag + '>' + inner + '</' + tag + '>' :
                        char + '<span style="border-top:1px solid currentColor;">' + inner + '</span>';
                    stop = close;

                } else if (char === '√' && text[i + 1] === '[') {
                    const degree = text.slice(i + 2, i + 24).match(/^([\p{L}\d]+)\]\(/u);
                    const open = degree && i + 3 + degree[1].length;
                    const closeRoot = pairs.get(open);
                    if (degree && closeRoot < end) {
                        html = '<sup>' + escapeHtml(degree[1]) + '</sup>√<span style="border-top:1px solid currentColor;">' +
                            render(open + 1, closeRoot, depth + 1) + '</span>';
                        stop = closeRoot;
                    }
                } else if (char === '(' && (i === start || !/[\p{L}\d_]/u.test(text[i - 1]))) {
                    const middle = pairs.get(i);
                    const denominator = pairs.get(middle + 2);
                    if (text[middle + 1] === '/' && denominator < end) {
                        const num = render(i + 1, middle, depth + 1);
                        const den = render(middle + 3, denominator, depth + 1);
                        html = '<span style="display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;">' +
                            '<span style="border-bottom:1px solid currentColor;">' + num + '</span><span>' + den + '</span></span>';
                        stop = denominator;
                    } else if (text[middle + 1] === '/') {
                        const startDen = middle + 2;
                        let endDen = startDen;
                        while (endDen < end && /[a-z0-9.]/i.test(text[endDen])) endDen++;
                        if (text[endDen] === '(') endDen = startDen;
                        if (endDen > startDen) {
                            html = '<span style="display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;">' +
                                '<span style="border-bottom:1px solid currentColor;">' + render(i + 1, middle, depth + 1) +
                                '</span><span>' + escapeHtml(text.slice(startDen, endDen)) + '</span></span>';
                            stop = endDen - 1;
                        }
                    }
                }
                if (html !== undefined) {
                    chunks.push(escapeHtml(text.slice(plainStart, i)), html);
                    i = stop;
                    plainStart = i + 1;
                }
            }
            chunks.push(escapeHtml(text.slice(plainStart, end)));
            return chunks.join('');
        }
        return render(0, text.length);
    }

    function formatOptionElement(el, text = extractOptionCleanText(el)) {
        const images = [];
        for (const image of el.querySelectorAll('img')) {
            const url = optionImageUrl(image);
            if (!url) continue;
            images.push('<img src="' + escapeHtml(url.href) + '" alt="' + escapeHtml(image.alt) +
                '" loading="lazy" referrerpolicy="no-referrer" style="max-width:100%;height:auto;">');
        }
        el.querySelectorAll('svg').forEach(svg => {
            if (!svg.closest('.katex, .MathJax, mjx-container')) images.push(staticSvgMarkup(svg));
        });
        el.querySelectorAll('canvas').forEach(canvas => {
            const data = optionCanvasImage(canvas);
            if (data) images.push('<img src="' + escapeHtml(data) + '" alt="" style="max-width:100%;height:auto;">');
        });
        return formatRichHtml(images.length ? text.replace(/\[img:[^\]]*\]/g, '').trim() : text) + images.join('');
    }

    // =========================================================================
    // 3. GIẢI MÃ GÓI TIN GỐC TỪ NETWORK & CÁC NGUỒN DEVTOOLS
    // =========================================================================
    function decodeQuestionBase64(value, xor = false) {
        if (typeof value !== 'string' || !value) return '';
        try {
            const binary = atob(value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
            const bytes = Uint8Array.from(binary, (char, index) => char.charCodeAt(0) ^
                (xor ? XOR_KEY.charCodeAt(index % XOR_KEY.length) : 0));
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch (e) {
            return '';
        }
    }

    function decodeQuestionContent(content, encodingHint) {
        if (/<[a-z][\w-]*(?:\s|\/?>)/i.test(content)) return content;
        const decoded = decodeQuestionBase64(content, true);
        if (/<[a-z][\w-]*(?:\s|\/?>)/i.test(decoded)) return decoded;
        const plain = decodeQuestionBase64(content);
        if (/<[a-z][\w-]*(?:\s|\/?>)/i.test(plain)) return plain;
        return encodingHint && decoded && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded) ? decoded : content;
    }

    function questionId(value) {
        const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
        return /^\d+$/.test(id) ? id : '';
    }

    const questionListFields = ['children', 'child', 'list_quiz', 'quiz_list', 'list_question', 'questions',
        'list_id_quiz', 'list_all', 'items', 'parts', 'sections', 'quizzes', 'interactions', 'checkpoints', 'slides', 'nodes', 'list'];

    function questionChildren(item) {
        return questionListFields.map(key => item?.[key]).filter(value => Array.isArray(value) ||
            (typeof value === 'string' && /^\d+(?:\s*,\s*\d+)*$/.test(value.trim())));
    }

    function processQuestionsArray(items) {
        const list = Array.isArray(items) ? items : Object.values(items || {});
        let changed = 0;
        const visited = new Set();
        function walk(item) {
            if (!item || typeof item !== 'object' || visited.has(item)) return;
            visited.add(item);
            if (Array.isArray(item)) {
                item.forEach(walk);
                return;
            }
            const rawStructured = item.json_content || item.json || item.json_content_i18n || item.json_i18n;
            const structured = typeof rawStructured === 'string' ?
                readPayload(rawStructured) || readPayload(decodeQuestionBase64(rawStructured, true)) : rawStructured;
            for (const children of [...questionChildren(item), ...questionChildren(structured)]) {
                if (Array.isArray(children)) children.flat(Infinity).forEach(walk);
            }

            const content = item.content || item.html || item.content_i18n || item.html_i18n || item.question_content || item.text ||
                structured?.html || structured?.content || ' ';
            if (typeof content !== 'string') return;
            const meta = structured && typeof structured === 'object' ? { ...structured, ...item } : item;
            const result = parseDecodedQuestionHtml(decodeQuestionContent(content, item.encodeXORBase64 === true), meta);
            for (const entry of Array.isArray(result) ? result : result ? [result] : []) {
                if (!entry.correctAnswers.length && !entry.parentId) continue;
                const index = rawAnswerDatabase.findIndex(q => q.uid === entry.uid);
                if (index < 0) {
                    rawAnswerDatabase.push(entry);
                    changed++;
                } else if ((!rawAnswerDatabase[index].correctAnswers.some(answer => answer.known !== false) ||
                    entry.correctAnswers.some(answer => answer.known !== false)) &&
                    JSON.stringify(rawAnswerDatabase[index]) !== JSON.stringify(entry)) {
                    rawAnswerDatabase[index] = entry;
                    changed++;
                }
            }
        }
        list.forEach(walk);
        if (changed) queueRender();
        return changed;
    }

    function splitSourceChoices(text) {
        const delimiter = text.includes('||') ? '||' : text.includes('|') ? '|' : ';';
        return text.split(delimiter).map(value => value.trim()).filter(Boolean);
    }

    function inputAccepts(el) {
        return ['data-accept', 'data-accepts', 'data-ans', 'ans'].map(attr => el?.getAttribute(attr))
            .find(value => value?.trim());
    }

    function blankHintHtml(index, text, action) {
        return '<b>Ô ' + (index + 1) + ' · ' + action + '</b> ' + formatRichHtml(text);
    }

    function readTruthKey(meta) {
        const value = meta.answerCorrect ?? meta.correctAnswer ?? meta.correct_answer ??
            meta.answers ?? meta.correct ?? meta.right ?? meta.answer;
        if (typeof value !== 'string') return value;
        const parsed = readPayload(value);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) return parsed;
        if (/^[012]+$/.test(value)) return value.split('');
        return value.split(/[|,;]/).map(part => part.trim());
    }

    function documentOrder(a, b) {
        if (!a || !b || a === b) return 0;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1;
    }

    function sourceChoiceLists(root, meta) {
        const marked = Array.from(root.querySelectorAll('.quiz-list, .quiz-options'));
        if (marked.length) return marked.filter(el => !el.parentElement?.closest('.quiz-list, .quiz-options'));
        const kind = String(meta.q_type ?? meta.type ?? '').toLowerCase();
        const lists = Array.from(root.querySelectorAll('ol, ul')).filter(el => !el.parentElement?.closest('ol, ul') &&
            !el.matches('.true-false, .link-list, .group-list, .two-list, .sort-list, .order-list, .arrange-list, .list-sort'));
        const key = meta.correctAnswer ?? meta.answerCorrect ?? meta.answer ?? meta.right;
        const looksLikeLetters = !kind && typeof key === 'string' && /^[A-Z](?:\s*[,;|]\s*[A-Z])*$/i.test(key.trim());
        if (lists.length === 1 && (['1', '41', 'mc', 'multiple-choice'].includes(kind) || looksLikeLetters ||
            lists[0].querySelector('.correctAnswer, [data-correct="1"], [correct="true"]'))) return lists;
        return [];
    }

    function lexicalChoiceLists(root) {
        const lists = new Map();
        const supported = new Set(['quiz-list', 'true-false', 'sort-list', 'order-list', 'arrange-list']);
        function walk(node) {
            if (!node || !Array.isArray(node.children)) return;
            if (node.type === 'olm-list' && supported.has(node.name)) {
                const group = lists.get(node.name) || [];
                group.push(node.children);
                lists.set(node.name, group);
                return;
            }
            node.children.forEach(walk);
        }
        walk(root);
        return lists;
    }

    function extractLexicalText(node) {
        if (!node) return '';
        if (typeof node === 'string') return node;
        if (typeof node.text === 'string') return node.text;
        if (Array.isArray(node.children)) return node.children.map(extractLexicalText).join(' ').replace(/\s+/g, ' ').trim();
        return '';
    }

    function authoredOptionKeys(lists, name, groupIndex, groupCount, optionCount) {
        const groups = lists.get(name);
        const group = groups?.length === groupCount ? groups[groupIndex] : null;
        return group?.length === optionCount ? group : null;
    }

    function parseSourceChoices(list, stem, key, explicitIndexes, authoredLists, groupIndex, groupCount) {
        const nodes = Array.from(list.querySelectorAll('li')).filter(li => !li.parentElement?.closest('li'));
        const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const authored = authoredOptionKeys(authoredLists, 'quiz-list', groupIndex, groupCount, nodes.length);
        const options = nodes.map((li, index) => {
            const raw = extractOptionCleanText(li);
            const text = raw.replace(/^#+\s*/, '').replace(/^[a-z]\s*[).:]\s+/i, '').trim();
            const marker = parseTruth(li.getAttribute('data-correct') ?? li.getAttribute('correct'));
            const hashMarked = raw.startsWith('#');
            const marked = marker ?? parseTruth(authored?.[index]?.correct) ??
                (li.classList.contains('correctAnswer') || (!list.hasAttribute('data-key') && hashMarked));
            return { index, text, cOpt: text, marked, hashMarked, html: formatOptionElement(li, text) };
        });
        if (!options.length) return null;
        const indexed = Array.isArray(explicitIndexes) ? explicitIndexes : [explicitIndexes];
        const parsed = typeof key === 'string' ? readPayload(key) : key;
        const values = Array.isArray(parsed) ? parsed : typeof key === 'string' && /^[A-Z](?:\s*[,;|]\s*[A-Z])+$/i.test(key.trim()) ?
            key.split(/[,;|]/).map(value => value.trim()) : [key];
        const marked = options.some(option => option.marked);
        const keyedOptions = values.filter(value => ['string', 'number'].includes(typeof value)).map(value => {
            const letter = String(value).trim();
            if (/^[A-Z]$/i.test(letter)) return options[labels.indexOf(letter.toUpperCase())];
            const byText = findUniqueOption(cleanScienceText(value), options, candidate => candidate.cOpt);
            if (byText) return byText;
            if (questionId(letter) && Number(letter) < options.length &&
                (Array.isArray(parsed) || typeof value === 'number')) {
                return options[Number(letter)];
            }
            return undefined;
        });
        const hasHashFallback = !marked && !keyedOptions.some(Boolean) &&
            !indexed.some(index => questionId(index) && Number(index) < options.length) &&
            options.some(option => option.hashMarked) && !options.every(option => option.hashMarked);
        const correctAnswers = [];
        for (const option of options) {
            const letter = labels[option.index] || '#' + (option.index + 1);
            option.isCorrect = marked ? option.marked :
                hasHashFallback ? option.hashMarked :
                indexed.some(index => questionId(index) && Number(index) === option.index) ||
                keyedOptions.includes(option);
            if (option.isCorrect) correctAnswers.push({ index: option.index, text: option.text,
                html: '<b>Chọn ' + letter + '</b> ' + option.html, isTrueStatement: true });
        }
        return { qType: 'mc', stem, cStem: cleanScienceText(stem), shortStem: stem.slice(0, 85),
            allOptions: options, correctAnswers };
    }

    function parseDecodedQuestionHtml(html, itemMeta) {
        if (typeof html !== 'string') return null;
        const template = document.createElement('template');
        template.innerHTML = html;
        const div = template.content;

        const expDiv = div.querySelector('.exp, .explanation, .giai-chi-tiet, .loigiai, .huong-dan');
        const expClone = expDiv ? expDiv.cloneNode(true) : null;
        div.querySelectorAll('.exp, .explanation, .giai-chi-tiet, .loigiai, .huong-dan').forEach(e => e.remove());
        normalizeMathStructureInDOM(div);

        const choiceLists = sourceChoiceLists(div, itemMeta);
        const stemClone = div.cloneNode(true);
        sourceChoiceLists(stemClone, itemMeta).forEach(list => list.remove());
        stemClone.querySelectorAll(stemDecorations).forEach(e => e.remove());
        const rawStem = extractOptionCleanText(stemClone);
        const shortStem = rawStem.length > 85 ? rawStem.slice(0, 82) + '...' : rawStem;

        const qId = questionId(itemMeta.id ?? itemMeta._id ?? itemMeta.old_id ?? itemMeta.id_question ?? itemMeta.idq ?? itemMeta.id_script);
        const identity = qId || html + '|' + JSON.stringify([itemMeta.q_type, itemMeta.answer, itemMeta.right]);
        const qType = String(itemMeta.q_type ?? itemMeta.type ?? '');
        const records = [];
        const authoredLists = lexicalChoiceLists(itemMeta.root);
        const add = (entry, anchor) => records.push({ entry, anchor });

        const truthLists = Array.from(div.querySelectorAll('.true-false')).filter(list => !list.parentElement?.closest('.true-false'));
        if (!truthLists.length && qType === '13') truthLists.push(div);
        const truthKey = truthLists.length ? readTruthKey(itemMeta) : null;
        truthLists.forEach((list, groupIndex) => {
            const rows = Array.from(list.querySelectorAll('li, tr')).filter(row =>
                !row.parentElement?.closest('li, tr') && (row.tagName !== 'TR' || row.querySelector('td')));
            const authoredList = list.matches?.('ol.true-false, ul.true-false');
            const authored = authoredOptionKeys(authoredLists, 'true-false', groupIndex, truthLists.length, rows.length);
            const sourceKey = list.getAttribute?.('data-key') || '';
            const explicitKey = truthLists.length === 1 ? truthKey : truthKey?.[sourceKey] ?? truthKey?.[groupIndex];
            const heading = list.previousElementSibling;
            const stem = truthLists.length > 1 && heading?.matches('p, h4, h5, .question-content') ?
                extractOptionCleanText(heading) : rawStem;
            const options = rows.map((row, index) => {
                const raw = extractOptionCleanText(row);
                const labelKey = String.fromCharCode(97 + index);
                const marker = parseTruth(row.getAttribute('data-correct') ?? row.getAttribute('correct'));
                const explicit = explicitKey && typeof explicitKey === 'object' ?
                    explicitKey[labelKey] ?? explicitKey[Array.isArray(explicitKey) || '0' in explicitKey ? index : index + 1] :
                    index === 0 ? explicitKey : undefined;
                const notGiven = row.matches('.notGivenAnswer') || explicit === '2' || explicit === 2;
                // OLM's '#' controls presentation. The true/false key comes from grading metadata or authored classes.
                const truth = notGiven ? null : marker ?? parseTruth(explicit) ?? parseTruth(authored?.[index]?.correct) ??
                    (row.matches('.correctAnswer') ? true : explicitKey == null && authoredList ? false : null);
                const text = raw.replace(/^#+\s*/, '').replace(/^[a-z]\s*[).:]\s+/i, '').trim();
                return { index, isTrue: truth, notGiven, text, cOpt: text };
            });
            if (!options.length) return;
            const correctAnswers = options.map(option => {
                const label = option.notGiven ? 'Không xác định' : option.isTrue === null ? 'Chưa rõ' : option.isTrue ? 'ĐÚNG ✅' : 'SAI ❌';
                return { index: option.index, text: option.text, html: '<b>' + String.fromCharCode(97 + option.index) + ') ' + label + '</b>',
                    isTrueStatement: option.isTrue, notGiven: option.notGiven, known: option.isTrue !== null || option.notGiven };
            });
            if (qType !== '22' && truthLists.length === 1 && !correctAnswers.some(answer => answer.known)) return;
            add({ uid: 'q_tf_' + identity, id: qId, qType: '13', sourceKey, stem,
                cStem: cleanScienceText(stem), shortStem: stem.slice(0, 85), allOptions: options, correctAnswers }, list);
        });

        const params = typeof itemMeta.params === 'string' ? readPayload(itemMeta.params) : itemMeta.params;
        const payloadAnswer = [itemMeta.answerCorrect, itemMeta.correctAnswer, itemMeta.correct_answer, itemMeta.accept, itemMeta.right,
            itemMeta.answer, itemMeta.key, itemMeta.correct, params?.accept, params?.answers, params?.right].find(value =>
            typeof value === 'number' || (typeof value === 'string' && value.trim()) ||
            (value && typeof value === 'object' && Object.keys(value).length));
        const inputs = Array.from(div.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), .dragtext, math-field, .mq-editable-field, .blank-input'));
        const isDragSource = qType === '3' || inputs.some(input => input.matches('.dragtext'));
        const hasFillKey = inputs.some(input => input.matches('[data-accept], [data-accepts], [data-ans], [ans]'));
        if (isDragSource || hasFillKey || qType === '2' || (qType === '18' && inputs.length)) {
            const entries = payloadAnswer && typeof payloadAnswer === 'object' ? payloadAnswer : [payloadAnswer];
            const positions = new Set(inputs.map((_, index) => index));
            Object.keys(entries).filter(key => /^\d+$/.test(key)).forEach(key => positions.add(Number(key)));
            const fillAnswers = [];
            for (const index of Array.from(positions).sort((a, b) => a - b)) {
                const inp = inputs[index];
                const sourceWords = inp?.matches('.dragtext') ? extractOptionCleanText(inp) : '';
                const value = inputAccepts(inp) ?? (sourceWords ? splitSourceChoices(sourceWords)[0] : entries[index]);
                const accepts = (Array.isArray(value) ? value : splitSourceChoices(String(value ?? '')))
                    .filter(value => typeof value === 'string' || typeof value === 'number')
                    .map(value => String(value).trim()).filter(Boolean);
                if (!accepts.length) continue;
                fillAnswers.push({
                    index, text: accepts[0], allAccepts: accepts,
                    html: '<b>Ô ' + (index + 1) + '</b> ' + accepts.map(formatRichHtml).join(' / '),
                    isTrueStatement: true
                });
            }
            if (fillAnswers.length) {
                add({
                    uid: 'q_fill_' + identity, id: qId, qType: 'fill', stem: rawStem,
                    cStem: rawStem, shortStem, allOptions: [], correctAnswers: fillAnswers
                }, inputs[0]);
            }
        }

        const selectSpans = Array.from(div.querySelectorAll('.selecttext, .selectadvance'));
        if (selectSpans.length) {
            const selectAnswers = [];
            selectSpans.forEach((span, index) => {
                const advanced = span.matches('.selectadvance');
                const parts = splitSourceChoices(extractOptionCleanText(span));
                const options = advanced ? parts.slice(1) : parts;
                const marked = options.find(text => text.startsWith('#'));
                const keyed = typeof payloadAnswer === 'string' && /^[\[{]/.test(payloadAnswer.trim()) ?
                    readPayload(payloadAnswer) : payloadAnswer;
                const explicit = keyed && typeof keyed === 'object' ? keyed[index] : index === 0 ? keyed : undefined;
                const fromPayload = typeof explicit === 'string' || typeof explicit === 'number' ?
                    options.find(text => text === String(explicit)) || (questionId(explicit) && options[Number(explicit)]) : '';
                // OLM uses the first source option as the key for these declared formats.
                const sourceKey = advanced || options.length > 1 || qType === '11' ? options[0] : '';
                const text = (marked || fromPayload || sourceKey || '').replace(/^#+\s*/, '').trim();
                if (!text) return;
                selectAnswers.push({ index, text, allChoices: options, html: blankHintHtml(index, text, 'Chọn') });
            });
            if (selectAnswers.length) {
                add({ uid: 'q_select_' + identity, id: qId, qType: '11', stem: rawStem,
                    cStem: rawStem, shortStem, allOptions: [], correctAnswers: selectAnswers }, selectSpans[0]);
            }
        }

        // 2c. Dạng Nối cặp / Ghép đôi (q_type 6 hoặc có ol.link-list)
        const linkLis = Array.from(div.querySelectorAll('ol.link-list li, ul.link-list li, .link-list li'));
        if (linkLis.length > 0 || qType === '6') {
            const pairs = [];
            linkLis.forEach((li, lIdx) => {
                const rawLi = extractOptionCleanText(li);
                const parts = rawLi.split(rawLi.includes('||') ? '||' : '#').map(p => p.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    pairs.push({
                        left: parts[0],
                        right: parts[1],
                        html: '<span style="background:#0891b2;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Cặp ' + (lIdx + 1) + '</span> <b>' + formatRichHtml(parts[0]) + '</b> ➔ <b>' + formatRichHtml(parts[1]) + '</b>',
                        isTrueStatement: true
                    });
                }
            });
            if (pairs.length > 0) {
                add({
                    uid: 'q_link_' + identity,
                    id: String(qId),
                    qType: '6',
                    stem: rawStem,
                    cStem: cleanScienceText(rawStem),
                    shortStem: shortStem,
                    linkPairs: pairs,
                    allOptions: pairs,
                    correctAnswers: pairs
                }, linkLis[0]);
            }
        }

        // 2d. Dạng Phân loại / Gom nhóm (q_type 10 hoặc có ol.group-list / ol.two-list)
        const groupLis = Array.from(div.querySelectorAll('ol.group-list li, ul.group-list li, .group-list li, ol.two-list li, ul.two-list li, .two-list li'))
            .filter(li => !li.parentElement?.closest('li'));
        if (groupLis.length > 0 || qType === '10') {
            const groups = [];
            groupLis.forEach((li, gIdx) => {
                const rawLi = extractOptionCleanText(li);
                const parts = rawLi.split(rawLi.includes('||') ? '||' : '#').map(p => p.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    const groupTitle = parts[0];
                    const groupItems = parts.slice(1);
                    groups.push({
                        title: groupTitle,
                        items: groupItems,
                        html: '<span style="background:#059669;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">' + formatRichHtml(groupTitle) + '</span> ' + groupItems.map(it => '<b>' + formatRichHtml(it) + '</b>').join(', '),
                        isTrueStatement: true
                    });
                }
            });
            if (groups.length > 0) {
                add({
                    uid: 'q_group_' + identity,
                    id: String(qId),
                    qType: '10',
                    stem: rawStem,
                    cStem: cleanScienceText(rawStem),
                    shortStem: shortStem,
                    groups: groups,
                    allOptions: groups,
                    correctAnswers: groups
                }, groupLis[0]);
            }
        }

        // 2e. Dạng Gạch chân (q_type 9 hoặc có span.under-line)
        const underSpans = Array.from(div.querySelectorAll('span.under-line, .under-line'));
        if (underSpans.length > 0 || qType === '9') {
            const ulAnswers = [];
            const parsedUlKey = typeof payloadAnswer === 'string' ? readPayload(payloadAnswer) : payloadAnswer;
            underSpans.forEach((span, uIdx) => {
                const rawSpan = extractOptionCleanText(span);
                const isCorr = span.classList.contains('correctAnswer') || span.getAttribute('data-correct') === '1' || rawSpan.startsWith('#') ||
                    (Array.isArray(parsedUlKey) && parsedUlKey.some(v => (questionId(v) && Number(v) === uIdx) || cleanLooseScience(v) === cleanLooseScience(rawSpan))) ||
                    (parsedUlKey && typeof parsedUlKey === 'object' && !Array.isArray(parsedUlKey) && parseTruth(parsedUlKey[uIdx]) === true);
                const cleanTxt = rawSpan.replace(/^#+\s*/, '').trim();
                if (isCorr && cleanTxt) {
                    ulAnswers.push({
                        index: uIdx,
                        text: cleanTxt,
                        html: '<span style="background:#d97706;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Gạch chân</span> <b>' + formatRichHtml(cleanTxt) + '</b>',
                        isTrueStatement: true
                    });
                }
            });
            if (ulAnswers.length > 0) {
                add({
                    uid: 'q_ul_' + identity,
                    id: String(qId),
                    qType: '9',
                    stem: rawStem,
                    cStem: cleanScienceText(rawStem),
                    shortStem: shortStem,
                    allOptions: ulAnswers,
                    correctAnswers: ulAnswers
                }, underSpans[0]);
            }
        }

        // 2f. Dạng Sắp xếp thứ tự (.sort-list, .order-list, .arrange-list, .list-sort, Lexical sort-list/order-list)
        const sortLists = Array.from(div.querySelectorAll('.sort-list, .order-list, .arrange-list, .list-sort'))
            .filter(list => !list.parentElement?.closest('.sort-list, .order-list, .arrange-list, .list-sort'));
        const lexicalSortGroups = authoredLists.get('sort-list') || authoredLists.get('order-list') || authoredLists.get('arrange-list') || [];
        const isSortType = ['sort', 'order', 'rearrange', 'arrange', 'sort-list', 'order-list'].includes(qType.toLowerCase());
        const sortSources = sortLists.length ? sortLists :
            lexicalSortGroups.length ? lexicalSortGroups.map(group => ({ lexicalGroup: group })) :
            isSortType ? [div] : [];
        sortSources.forEach((source) => {
            let items = [];
            if (source.lexicalGroup) {
                items = source.lexicalGroup.map((node, index) => {
                    const text = cleanScienceText(extractLexicalText(node)).replace(/^#+\s*/, '').trim();
                    return text ? { index, text, cOpt: text, html: formatRichHtml(text) } : null;
                }).filter(Boolean);
            } else {
                const lis = Array.from(source.querySelectorAll('li, .sort-item, .item-sort, .order-item'))
                    .filter(el => !el.parentElement?.closest('li, .sort-item, .item-sort, .order-item'));
                items = lis.map((li, index) => {
                    const text = extractOptionCleanText(li).replace(/^#+\s*/, '').trim();
                    return text ? { index, text, cOpt: text, html: formatOptionElement(li, text) } : null;
                }).filter(Boolean);
            }
            if (!items.length && isSortType) {
                const rawArr = Array.isArray(payloadAnswer) ? payloadAnswer :
                    typeof payloadAnswer === 'string' ? readPayload(payloadAnswer) :
                    Array.isArray(itemMeta.items) ? itemMeta.items :
                    Array.isArray(itemMeta.options) ? itemMeta.options : null;
                if (Array.isArray(rawArr)) {
                    items = rawArr.map((it, index) => {
                        const text = cleanScienceText(typeof it === 'object' && it ? (it.text || it.title || it.content || it.name || it.word || it.value || '') : String(it ?? '')).trim();
                        return text ? { index, text, cOpt: text, html: formatRichHtml(text) } : null;
                    }).filter(Boolean);
                }
            }
            if (items.length < 2) return;
            const parsedOrder = readOptionOrder(payloadAnswer);
            const orderedItems = parsedOrder && parsedOrder.length === items.length ?
                parsedOrder.map(idx => items[idx]).filter(Boolean) : items;
            const correctAnswers = orderedItems.map((item, pos) => ({
                index: pos,
                order: pos + 1,
                text: item.text,
                html: '<b>' + (pos + 1) + '.</b> ' + item.html,
                isTrueStatement: true
            }));
            add({
                uid: 'q_order_' + identity,
                id: String(qId),
                qType: 'order',
                stem: rawStem,
                cStem: cleanScienceText(rawStem),
                shortStem: shortStem,
                allOptions: orderedItems.map((item, idx) => ({ ...item, index: idx })),
                correctAnswers
            }, source.lexicalGroup ? div : source);
        });

        const parsedChoiceKey = typeof payloadAnswer === 'string' ? readPayload(payloadAnswer) : payloadAnswer;
        choiceLists.forEach((list, index) => {
            const heading = list.previousElementSibling;
            const stem = choiceLists.length > 1 && heading?.matches('p, h4, h5, .question-content') ?
                extractOptionCleanText(heading) : rawStem;
            const key = choiceLists.length === 1 ? payloadAnswer : Array.isArray(parsedChoiceKey) ? parsedChoiceKey[index] : undefined;
            const indexes = itemMeta.correctIndex ?? itemMeta.correct_index ?? itemMeta.correctIndices;
            const record = parseSourceChoices(list, stem, key, choiceLists.length === 1 ? indexes : indexes?.[index],
                authoredLists, index, choiceLists.length);
            if (record) add({ ...record, uid: 'q_mc_' + identity, id: qId, sourceKey: list.getAttribute('data-key') || '' }, list);
        });

        if (records.length) {
            records.sort((a, b) => documentOrder(a.anchor, b.anchor));
            if (records.length === 1) return records[0].entry;
            return records.map(({ entry }, index) => ({
                ...entry, uid: entry.uid + '_' + index, id: qId ? qId + '_' + index : '',
                parentId: qId, childIndex: index, childCount: records.length
            }));
        }

        // 4. Dạng Tự luận ngắn / Trả lời ngắn có đáp án trong lời giải (q_type: 18 hoặc đoạn "Đáp án: ...")
        let shortAnsText = '';
        if (expClone) {
            const pList = Array.from(expClone.querySelectorAll('p, div, li, span')).map(el => (el.textContent || '').trim()).filter(Boolean);
            for (let pIdx = 0; pIdx < pList.length; pIdx++) {
                const pt = pList[pIdx];
                const m = pt.match(/^(?:đáp án|đáp số|kết quả)\s*(?:đúng\s*là|là)?[\s\:\.]+(.+)$/i);
                if (m && m[1].trim().length <= 160) {
                    shortAnsText = m[1].trim().replace(/\.$/, '');
                    break;
                }
                if (/^(?:đáp án|đáp số|kết quả)[\s\:\.]*$/i.test(pt) && pIdx + 1 < pList.length) {
                    shortAnsText = pList[pIdx + 1].trim();
                    break;
                }
            }
        }
        const shortTypeAllowed = !qType || qType === '18' || qType === '2' || qType === '14';
        const payloadShortAns = shortTypeAllowed ? (
            ['number', 'string'].includes(typeof payloadAnswer) ? String(payloadAnswer).trim() :
            Array.isArray(payloadAnswer) ? payloadAnswer.filter(v => ['number', 'string'].includes(typeof v)).map(v => String(v).trim()).filter(Boolean).join(' / ') :
            ''
        ) : '';
        if (shortAnsText || payloadShortAns) {
            const finalAns = shortAnsText || payloadShortAns;
            if (finalAns) {
                return {
                    uid: 'q_short_' + identity,
                    id: String(qId),
                    qType: '18',
                    stem: rawStem,
                    cStem: cleanScienceText(rawStem),
                    shortStem: shortStem,
                    allOptions: [],
                    correctAnswers: [{
                        html: '<span style="background:#2563eb;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Điền</span> <b>' + formatRichHtml(finalAns) + '</b>',
                        isTrueStatement: true,
                        index: 0,
                        text: finalAns
                    }]
                };
            }
        }

        return null;
    }

    function parseTruth(value) {
        if (value === true || value === 1 || value === '1' || value === 'true') return true;
        if (value === false || value === 0 || value === '0' || value === 'false') return false;
        return null;
    }

    function processOmrResultObject(value) {
        if (!value || typeof value !== 'object' || !(value.fc || value.tf || value.nrq)) return 0;
        const signature = pageGlobalSignature({ values: { result_question: value } });
        if (!signature) return 0;
        if (signature === lastOmrPayload) return omrResult.length;
        const rows = [];
        for (const [kind, entries] of Object.entries({ fc: value.fc, tf: value.tf, nrq: value.nrq })) {
            if (!entries || typeof entries !== 'object') continue;
            for (const [key, answer] of Object.entries(entries)) {
                if (!questionId(key) || Number(key) < 1) continue;
                let answers = [];
                if (kind === 'fc') {
                    const values = Array.isArray(answer) ? answer : [answer];
                    const chosen = values.map(v => {
                        const raw = String(v ?? '').trim().toUpperCase();
                        return /^[A-E]$/.test(raw) ? raw : /^[0-4]$/.test(raw) ? 'ABCDE'[Number(raw)] : '';
                    }).filter(Boolean);
                    if (chosen.length) answers.push({ html: '<b>Tô bubble ' + chosen.join(', ') + '</b>' });
                } else if (kind === 'tf' && answer && typeof answer === 'object') {
                    const keys = Array.isArray(answer) ?
                        answer.map((_, i) => String.fromCharCode(97 + i)) :
                        Object.keys(answer).filter(k => /^[a-z]$/i.test(k) || /^\d+$/.test(k));
                    const orderedKeys = keys.length ? keys : ['a', 'b', 'c', 'd'];
                    answers = orderedKeys.map((k, i) => {
                        const letter = /^[a-z]$/i.test(k) ? k.toLowerCase() : String.fromCharCode(97 + i);
                        const truth = parseTruth(Array.isArray(answer) ? answer[i] : answer[k] ?? answer[letter] ?? answer[i]);
                        return { html: '<b>' + letter + ') ' + (truth === null ? 'Chưa rõ' : truth ? 'Đúng' : 'Sai') + '</b>' };
                    });
                } else if (kind === 'nrq') {
                    const vals = Array.isArray(answer) ? answer.filter(v => ['number', 'string'].includes(typeof v)) :
                        ['number', 'string'].includes(typeof answer) ? [answer] : [];
                    if (vals.length) answers.push({ html: '<b>Điền</b> ' + vals.map(formatRichHtml).join(' / ') });
                }
                if (answers.length) {
                    rows.push({
                        uid: 'omr_' + kind + '_' + key, section: kind,
                        displayNumber: Number(key), shortStem: 'Phiếu ' + kind.toUpperCase() + ' · Câu ' + key,
                        renderedAnswers: answers
                    });
                }
            }
        }
        if (rows.length) {
            lastOmrPayload = signature;
            omrResult = rows.sort((a, b) => a.displayNumber - b.displayNumber);
            queueRender();
        }
        return rows.length;
    }

    function readPayload(text) {
        if (typeof text !== 'string' || !text.trim()) return null;
        try { return JSON.parse(text); } catch (e) {}
        try {
            const decoded = atob(text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'));
            const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        } catch (e) {
            return null;
        }
    }

    function readOptionOrder(value) {
        const parsed = typeof value === 'string' ? readPayload(value) : value;
        const order = Array.isArray(parsed) ? parsed : parsed?.order;
        if (!Array.isArray(order) || !order.length) return null;
        const indexes = order.map(item => questionId(item) ? Number(item) : NaN);
        if (indexes.some(index => !Number.isInteger(index))) return null;
        const offset = indexes.includes(0) ? 0 : 1;
        const normalized = indexes.map(index => index - offset);
        return new Set(normalized).size === order.length &&
            normalized.every(index => index >= 0 && index < order.length) ? normalized : null;
    }

    function parsePartLabel(value) {
        const text = String(value ?? '').trim();
        const match = text.match(/(?:phần|part|section)\s+(\d+|[ivxlcdm]+)\b/i);
        if (!match) return '';
        if (questionId(match[1])) return 'Phần ' + Number(match[1]);
        const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        const chars = Array.from(match[1].toUpperCase(), char => values[char]);
        const number = chars.reduce((total, value, index) => total + (value < chars[index + 1] ? -value : value), 0);
        return 'Phần ' + number;
    }

    function readPartStart(value) {
        const text = String(value ?? '').trim();
        const range = text.match(/(?:^|[\s(])(\d+)\s*[-–—]\s*\d+\b/);
        return range ? Number(range[1]) : 0;
    }

    function readOrderedQuestions(list) {
        const rows = [];
        const visited = new Set();
        function walk(value, part) {
            if (typeof value === 'string' && /^\d+(?:\s*,\s*\d+)+$/.test(value.trim())) value = value.split(',');
            if (Array.isArray(value)) {
                const partitions = value.filter(item => item && !Array.isArray(item) && typeof item === 'object' && questionChildren(item).length);
                value.forEach(item => {
                    const index = partitions.indexOf(item);
                    const title = item?.title ?? item?.name ?? item?.label;
                    const label = parsePartLabel(title) || (partitions.length > 1 && index !== -1 ? 'Phần ' + (index + 1) : '');
                    const start = Number(item?.startQuestionNumber ?? item?.start_question_number) || readPartStart(title);
                    walk(item, label || start ? { label: label || part?.label || '', start } : part);
                });
                return;
            }
            if (value && typeof value === 'object') {
                if (visited.has(value)) return;
                visited.add(value);
                const children = questionChildren(value);
                if (children.length) {
                    children.forEach(list => walk(list, part));
                    return;
                }
            }
            const id = questionId(value?.idq ?? value?.id_quiz ?? value?.id_question ?? value?.id_script ?? value?.id ?? value);
            if (id) rows.push({ id, part });
        }
        walk(list, null);
        return rows;
    }

    function applyMetadata(data, updateQuestionOrder) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return;
        const record = data.record || data;
        const lists = [record.quiz_list, record.list_quiz, record.sections, record.parts,
            data.data_question_node, data.list_id_quiz, data.list_cate_quiz, data.quiz_list, data.list_all, data.sections, data.parts, data.list_id_script];
        let foundOrder = false;
        let nextOrder = questionIds;
        let changedParts = false;
        for (const list of lists) {
            const rows = readOrderedQuestions(list);
            if (!rows.length) continue;
            const ids = Array.from(new Set(rows.map(row => row.id)));
            for (const { id, part } of rows) {
                if (!part) continue;
                const previous = questionParts.get(id);
                if (previous?.label === part.label && previous?.start === part.start) continue;
                questionParts.set(id, part);
                changedParts = true;
            }
            const known = new Set(nextOrder);
            if (updateQuestionOrder && !foundOrder && nextOrder.length && ids.length) {
                const included = new Set(ids);
                const extras = nextOrder.filter(id => !included.has(id));
                if (ids.every(id => known.has(id))) {
                    let index = 0;
                    nextOrder = nextOrder.map(id => included.has(id) ? ids[index++] : id);
                } else if (nextOrder.every(id => included.has(id))) {
                    nextOrder = ids;
                } else {
                    nextOrder = [...ids, ...extras];
                }
            } else {
                nextOrder = [...nextOrder, ...ids.filter(id => !known.has(id))];
            }
            foundOrder = true;
        }
        if (nextOrder.join(',') !== questionIds.join(',') || changedParts) {
            questionIds = nextOrder;
            queueRender();
        }
        const logs = record.data_log || data.data_log;
        if (!Array.isArray(logs)) return foundOrder;
        for (const item of logs) {
            const id = questionId(item?.idq ?? item?.id_quiz ?? item?.id_script ?? item?.id);
            if (!id) continue;
            const order = readOptionOrder(item.params ?? item.q_params);
            if (!order) continue;
            if (optionShuffleMap.get(id)?.join(',') !== order.join(',')) {
                optionShuffleMap.set(id, order);
                queueRender();
            }
        }
        return foundOrder;
    }

    function processPayload(payload) {
        if (!payload || typeof payload !== 'object') return 0;
        if (Array.isArray(payload)) return processQuestionsArray(payload);
        applyMetadata(payload, true);
        const outer = payload.data ?? payload;
        if (outer !== payload) applyMetadata(outer, true);
        const data = outer?.data && typeof outer.data === 'object' && !Array.isArray(outer.data) ? outer.data : outer;
        if (data !== outer) applyMetadata(data, true);
        const omr = payload.values?.result_question ?? data?.result_question ?? outer?.result_question ?? data;
        if (omr?.fc || omr?.tf || omr?.nrq) return processOmrResultObject(omr);
        const list = Array.isArray(omr) ? omr : data?.questions ?? data?.list_question ?? data?.qlib_list ??
            data?.quizzes ?? data?.interactions ?? data?.slides ?? data?.items ?? data?.content ??
            outer?.questions ?? payload.questions;
        if (Array.isArray(list)) return processQuestionsArray(list);
        if (list && typeof list === 'object') return processQuestionsArray(list);
        if ((data?.id && typeof data?.content === 'string') || questionChildren(data).length || questionChildren(data?.record).length) {
            return processQuestionsArray([data, data?.record]);
        }
        if (data && typeof data === 'object') return processQuestionsArray(data);
        return 0;
    }

    function relevantUrl(input) {
        try {
            const url = new URL(input?.url ?? input, location.href);
            const trustedOlm = url.protocol === 'https:' && (url.hostname === 'olm.vn' || url.hostname.endsWith('.olm.vn'));
            if (url.origin !== location.origin && !trustedOlm) return false;
            return /\/(?:questions?|qlib|quiz(?:zes)?|exams?|practice|lessons?|lectures?|videos?|interactive|slides?|homeworks?|assignments?|categor(?:y|ies)|cates?|do-test|tests?)(?:\/|$)|get-(?:question|quiz|test|lesson|practice|exam|crt-ans-file|data|detail|content|list|lecture|video|interactive)/i
                .test(url.pathname);
        } catch (e) {
            return false;
        }
    }

    // Requests started by this helper are parsed directly, once.
    const pageFetch = window.fetch;
    if (typeof pageFetch === 'function') {
        window.fetch = function (input) {
            syncPage();
            const revision = pageRevision;
            const result = pageFetch.apply(this, arguments);
            if (relevantUrl(input)) {
                result.then(response => {
                    if (response.ok) return response.clone().text();
                }).then(text => {
                    syncPage();
                    if (pageRevision === revision) processPayload(readPayload(text));
                }).catch(() => {});
            }
            return result;
        };
    }

    if (typeof XMLHttpRequest !== 'undefined') {
        const { open, send } = XMLHttpRequest.prototype;
        const requestUrls = new WeakMap();
        XMLHttpRequest.prototype.open = function (method, url) {
            const result = open.apply(this, arguments);
            requestUrls.set(this, url);
            return result;
        };
        XMLHttpRequest.prototype.send = function () {
            if (!relevantUrl(requestUrls.get(this))) return send.apply(this, arguments);
            syncPage();
            const revision = pageRevision;
            const onLoadEnd = () => {
                syncPage();
                if (pageRevision !== revision || this.status < 200 || this.status >= 300) return;
                try {
                    if (this.responseType === 'json') processPayload(this.response);
                    else if (!this.responseType || this.responseType === 'text') processPayload(readPayload(this.responseText));
                } catch (err) {
                    // An unsupported response cannot be used by the helper.
                }
            };
            this.addEventListener('loadend', onLoadEnd, { once: true });
            try {
                return send.apply(this, arguments);
            } catch (err) {
                this.removeEventListener('loadend', onLoadEnd);
                throw err;
            }
        };
    }

    function readScriptArray(text, start) {
        let depth = 0;
        let quote = '';
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                if (ch === '\\') i++;
                else if (ch === quote) quote = '';
            } else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '[') depth++;
            else if (ch === ']' && --depth === 0) {
                const source = text.slice(start, i + 1);
                const parsed = readPayload(source);
                if (Array.isArray(parsed)) return parsed;
                return /^[\[\]\d,\s'"]+$/.test(source) ? source.match(/\d+/g) || [] : [];
            }
        }
        return [];
    }

    const parsedScripts = new WeakMap();
    const scriptRevisions = new WeakMap();
    function collectPageMetadata() {
        let currentOrder = false;
        for (const key of globalKeys) {
            const value = readPageGlobal(key);
            if (!value) continue;
            const signature = pageGlobalSignature(value);
            const applied = appliedPageGlobals.get(key);
            if (applied?.signature === signature) {
                currentOrder = currentOrder || applied.hasOrder;
                continue;
            }
            const hasOrder = applyMetadata(value, !currentOrder);
            appliedPageGlobals.set(key, { signature, hasOrder });
            currentOrder = currentOrder || hasOrder;
            if (key === 'EXAM_FILE' && value.values?.result_question) {
                processPayload(value.values.result_question);
            }
        }
        for (const script of document.scripts) {
            if (script.src) continue;
            const text = script.textContent || '';
            if (scriptRevisions.has(script) && scriptRevisions.get(script) !== pageRevision &&
                parsedScripts.get(script)?.text === text) continue;
            let cached = parsedScripts.get(script);
            if (cached?.text !== text) {
                const data = {};
                const fields = /(?:^|[{\s,])["']?(quiz_list|list_id_quiz|list_quiz|list_id_script|list_all|sections|parts|data_log)["']?\s*:\s*(?=\[)/g;
                let match;
                while ((match = fields.exec(text))) {
                    data[match[1]] = readScriptArray(text, fields.lastIndex);
                }
                const config = {};
                for (const [, name, value] of text.matchAll(/(?:^|[\s{,])["']?(id_category|id_subject|cv_q)["']?\s*:\s*["']?(-?\d+)\b/g)) {
                    config[name] ??= value;
                }
                cached = { text, data, config };
                parsedScripts.set(script, cached);
                scriptRevisions.set(script, pageRevision);
            }
            const category = questionId(new URL(pageUrl).pathname.match(/-(\d+)\/?$/)?.[1]);
            if (category && cached.config.id_category === category && cached.config.id_subject) {
                inlineRequestContext = cached.config;
            }
            applyMetadata(cached.data, !currentOrder && questionIds.length === 0);
        }
    }

    function hasOmrInterface(roots) {
        return roots.some(root => root.querySelector('.q-handle-fc, .q-handle-tf, .q-handle-nrq, #cate-pdf-container'));
    }

    function collectQuestionIds(roots) {
        const ids = new Set(questionIds);
        const selector = questionContainers + ', [data-id-quiz], [data-qid]';
        for (const root of roots) {
            root.querySelectorAll(selector).forEach(el => {
                const id = getComponentQuestionId(el);
                if (id) ids.add(id);
            });
        }
        const fromUrl = questionId(new URL(pageUrl).searchParams.get('idq'));
        if (fromUrl) ids.add(fromUrl);
        return Array.from(ids);
    }

    function setFetchStatus(button, icon, label) {
        if (!button) return;
        button.textContent = icon;
        button.title = label;
        button.setAttribute('aria-label', label);
    }

    function getQuestionRequestContext() {
        const page = new URL(pageUrl);
        const context = globalWin.baseCategoryUtils;
        const currentCategory = questionId(page.pathname.match(/-(\d+)\/?$/)?.[1]);
        const practice = readPageGlobal('data_practice');
        const configuredCategory = questionId(context?.getData?.('id_category'));
        const useContext = !currentCategory || configuredCategory === currentCategory;
        return {
            category: currentCategory || practice?.id_category || (useContext ? configuredCategory : ''),
            subject: (useContext && context?.getData?.('id_subject')) ||
                globalKeys.map(key => readPageGlobal(key)?.id_subject).find(Boolean) || inlineRequestContext?.id_subject,
            cv: (useContext ? context?.getData?.('cv_q') : null) ?? practice?.cv_q ?? inlineRequestContext?.cv_q ?? 1
        };
    }

    async function autoExtractAndFetchExamQuestions(isUserTriggered = false) {
        if (!licenseState.valid) return;
        syncPage();
        if (!pageFetch || pendingFetch || (!isUserTriggered && Date.now() < nextFetchAt)) return;
        collectPageMetadata();
        const roots = getAllQuestionRoots();
        ingestMountedQuestions(roots);
        const ids = collectQuestionIds(roots);
        const known = new Set(rawAnswerDatabase.map(q => q.parentId || q.id));
        if (isUserTriggered) {
            for (const row of rawAnswerDatabase) {
                if (!row.correctAnswers.some(answer => answer.known !== false)) known.delete(row.parentId || row.id);
            }
        }
        const missing = ids.filter(id => !known.has(id));
        const url = new URL(pageUrl);
        const category = questionId(url.searchParams.get('i_c') || url.pathname.match(/-(\d+)\/?$/)?.[1]);
        const hasOmr = hasOmrInterface(roots);
        const btn = document.getElementById('olm-fetch-now-btn');
        const needsOmr = hasOmr && category && (isUserTriggered || !omrResult?.length);
        if (!missing.length && !needsOmr) {
            if (isUserTriggered) {
                const hasAnswers = rawAnswerDatabase.length || omrResult?.length;
                setFetchStatus(btn, hasAnswers ? '✅' : '⚡', hasAnswers ? 'Đã nạp' : 'Chưa có đáp án');
            }
            return;
        }

        const revision = pageRevision;
        const request = new AbortController();
        pendingFetch = request;
        const timer = setTimeout(() => request.abort(), 8000);
        setFetchStatus(btn, '⏳', 'Đang tải đáp án');
        let loaded = 0;
        let moreBatches = false;
        try {
            const headers = { 'X-Requested-With': 'XMLHttpRequest' };
            const csrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                globalWin.OTM_SERVER_DATA?.csrfToken;
            if (csrf) headers['X-CSRF-TOKEN'] = csrf;
            const signal = request.signal;
            const consume = async (response, decodeOmr = false) => {
                if (!response.ok) return 0;
                const text = await response.text();
                syncPage();
                if (revision !== pageRevision || signal.aborted) return 0;
                let payload = readPayload(text);
                if (!payload && decodeOmr) {
                    const codec = globalWin.baseCategoryUtils?.OlmEncode;
                    if (typeof codec?.decode === 'function') payload = readPayload(codec.decode(text));
                }
                return processPayload(payload);
            };
            if (missing.length) {
                let remaining = missing.filter(id => !attemptedIds.has(id));
                if (!remaining.length) {
                    attemptedIds.clear();
                    remaining = missing;
                }
                const batch = remaining.slice(0, 100);
                batch.forEach(id => attemptedIds.add(id));
                moreBatches = remaining.length > batch.length;
                const endpoint = '/course/question/get-question-of-ids';
                const { category, subject, cv } = getQuestionRequestContext();
                const body = new URLSearchParams({ encodeXORBase64: 'true', cv_q: String(cv) });
                batch.forEach(id => body.append('qlib_list[]', id));
                if (subject) body.set('id_subject', subject);
                if (category) body.set('id_skill', category);
                const response = await pageFetch.call(window, endpoint, { method: 'POST', body, headers, signal, credentials: 'same-origin' });
                loaded = await consume(response);
                // The form is the default. Preserve legacy encodings for servers that explicitly reject it.
                if (!loaded && !signal.aborted && [400, 415, 422].includes(response.status)) {
                    const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
                    const json = await pageFetch.call(window, endpoint, {
                        method: 'POST', credentials: 'same-origin', body: JSON.stringify({ qlib_list: batch, ids: batch, encodeXORBase64: true,
                            id_skill: category, id_subject: subject, cv_q: cv }), headers: jsonHeaders, signal
                    });
                    loaded = await consume(json);
                } else if (!signal.aborted && response.status === 405) {
                    const query = new URLSearchParams({ ids: batch.join(',') });
                    loaded = await consume(await pageFetch.call(window, endpoint + '?' + query, { headers, signal, credentials: 'same-origin' }));
                }
            } else {
                const response = await pageFetch.call(window, '/course/teacher-categories/' + category + '/get-crt-ans-file',
                    { headers, signal, credentials: 'same-origin' });
                loaded = await consume(response, true);
            }
        } catch (e) {
            // Network error, timeout, or navigation. The next scheduled attempt is delayed.
        } finally {
            clearTimeout(timer);
            if (pendingFetch === request) {
                pendingFetch = null;
                fetchFailures = loaded ? 0 : fetchFailures + 1;
                nextFetchAt = Date.now() + (moreBatches ? 300 : loaded ? 1500 : Math.min(8000, 1000 * 2 ** fetchFailures));
                setFetchStatus(btn, loaded ? '✅' : '⚡', loaded ? 'Đã nạp đáp án' : 'Chưa nạp được đáp án');
            }
        }
    }

    // =========================================================================
    // 5. CƠ CHẾ ĐỐI CHIẾU 2 LỚP & 5 TẦNG NGỮ NGHĨA (TWO-TIER & 5-LAYER MATCHING)
    // =========================================================================
    function getAllQuestionRoots() {
        const roots = new Set([document]);
        for (const entry of attachedRoots) {
            const root = typeof entry.deref === 'function' ? entry.deref() : entry;
            if (!root || (!root.host.isConnected && root === entry)) attachedRoots.delete(entry);
            if (root?.host.isConnected) roots.add(root);
        }
        for (const root of roots) {
            root.querySelectorAll(questionContainers).forEach(host => {
                const shadow = getShadowRoot(host);
                if (shadow) roots.add(shadow);
            });
        }
        return Array.from(roots);
    }

    function getActiveQuestion(items, roots) {
        const view = viewportBounds();
        const top = view.top * view.scaleY + view.origin.top;
        const left = view.left * view.scaleX + view.origin.left;
        const height = view.height * view.scaleY;
        const bottom = top + height;
        const right = left + view.width * view.scaleX;
        const readingLine = top + height * 0.26;
        let best = null;
        let distance = Infinity;
        for (const item of items) {
            const rect = questionBounds(item.domElement);
            if (!rect || rect.bottom <= top || rect.top >= bottom || rect.left >= right || rect.right <= left) continue;
            const nextDistance = Math.max(rect.top - readingLine, readingLine - rect.bottom, 0);
            if (nextDistance < distance) {
                distance = nextDistance;
                best = item;
            }
        }
        if (best) return best;

        const part = getActivePart(roots).label;
        const byNumber = number => items.find(item => item.displayNumber === number && (!part || part === item.part));
        const practice = byNumber(getPracticeDisplayNumber());
        if (practice) return practice;
        const selector = '.quiz-nav-item.active, .btn-question-number.active, .sheet-question-item.active, ' +
            '[data-quiz-index].active, .tw-btn-quiz.active, .item-q.active, ' +
            '.btn-circle-quiz.active, .tw-olm-chip-question.tw-selected';
        for (const root of roots) {
            for (const chip of root.querySelectorAll(selector)) {
                const label = (chip.textContent || '').trim();
                const number = Number(label.match(/^(?:câu\s*)?(\d+)$/i)?.[1]);
                const match = byNumber(number);
                if (match) return match;
            }
        }
        return null;
    }

    function clearHighlights() {
        hintBadges.forEach(badge => badge.remove());
        hintBadges.clear();
        optionMarks.forEach(mark => mark.remove());
        optionMarks.clear();
    }

    function highlightDomOptionElement(el, tone = 'green') {
        let mark = optionMarks.get(el);
        if (!mark) {
            mark = document.createElement('div');
            mark.className = 'olm-option-mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.style.cssText = 'position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid;' +
                'border-radius:5px;';
            mark.hidden = true;
            ensureOverlayRoot().prepend(mark);
            optionMarks.set(el, mark);
        }
        mark.style.borderColor = tone === 'blue' ? '#2563eb' : '#16a34a';
        mark.style.backgroundColor = tone === 'blue' ? 'rgba(37,99,235,.08)' : 'rgba(34,197,94,.13)';
    }

    function getActivePart(roots) {
        for (const root of roots) {
            for (const tab of root.querySelectorAll('[role="tab"][aria-selected="true"], .nav-tabs .active, .tw-tabs .active')) {
                const label = parsePartLabel(tab.textContent);
                const start = readPartStart(tab.textContent);
                if (label || start) return { label, start };
            }
        }
        return { label: '', start: 0 };
    }

    function composedParent(el) {
        return el.parentElement || el.getRootNode().host;
    }

    function getComponentPart(el) {
        let start = 0;
        let label = '';
        for (let node = el; node; node = composedParent(node)) {
            const value = Number(node.startQuestionNumber ?? node.getAttribute('data-start-question-number'));
            if (!start && Number.isInteger(value) && value > 0) start = value;
            if (!label && node.matches('[role="tabpanel"], .tab-pane, [data-section]')) {
                const tab = node.ownerDocument.getElementById(node.getAttribute('aria-labelledby') || '');
                label = parsePartLabel(tab?.textContent ?? node.getAttribute('aria-label') ?? node.getAttribute('data-section'));
                start ||= readPartStart(tab?.textContent ?? node.getAttribute('aria-label'));
            }
            if (start && label) break;
        }
        return { label, start };
    }

    function extractReactQuestionId(el) {
        for (let depth = 0; depth < 8 && el; depth++, el = el.parentElement) {
            const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
            let fiber = el[key];
            for (let i = 0; i < 12 && fiber; i++, fiber = fiber.return) {
                const props = fiber.memoizedProps || fiber.pendingProps;
                const id = questionId(props?.question?.id ?? props?.quiz?.id ?? props?.id_quiz ?? props?.questionId ?? props?.item?.id_question);
                if (id) return id;
            }
        }
        return '';
    }

    function getComponentQuestionId(el) {
        const explicit = [el.jsonQuestion?.id, el.idStatic, el.getAttribute('data-id-quiz'), el.getAttribute('data-qid'), el.getAttribute('data-question-id'),
            el.id?.match(/^user-test-(\d+)$/)?.[1]].map(questionId).find(Boolean);
        const classicId = el.matches('.q-view-itemx.question, .box-quiz') ? questionId(el.getAttribute('data-id')) : '';
        return explicit || classicId || extractReactQuestionId(el);
    }

    function findUniqueOption(text, options, getText) {
        if (!text) return undefined;
        const exact = options.filter(option => getText(option) === text);
        if (exact.length) return exact.length === 1 ? exact[0] : undefined;
        const loose = cleanLooseScience(text);
        const normalized = options.filter(option => cleanLooseScience(getText(option)) === loose);
        return normalized.length === 1 ? normalized[0] : undefined;
    }

    function findMatchingDbQuestion(stemText, screenOptionTexts, qId, types) {
        const options = screenOptionTexts.filter(Boolean);
        const candidates = rawAnswerDatabase.filter(item =>
            (!types || types.includes(item.qType)) && (!qId || item.id === qId || item.parentId === qId));
        if (qId) {
            const exact = candidates.filter(item => item.id === qId);
            if (exact.length === 1) return exact[0];
        }
        let match;
        let best = 0;
        for (const item of candidates) {
            const stem = item.cStem;
            const source = cleanLooseScience(stem);
            const visible = cleanLooseScience(stemText);
            const sameStem = !!source && source === visible;
            const contained = !sameStem && Math.min(source.length, visible.length) >= 12 &&
                (source.includes(visible) || visible.includes(source));
            if (!sameStem && !contained && (!options.length || !item.allOptions.length)) continue;
            const itemOptions = item.allOptions || [];
            if (options.length && itemOptions.length && options.length !== itemOptions.length) continue;
            const matched = options.map(text => findUniqueOption(text, itemOptions, option => option.cOpt || option.text));
            if (options.length && itemOptions.length && (matched.includes(undefined) || new Set(matched).size !== options.length)) continue;
            const score = (sameStem ? 5 : contained ? 3 : 0) + (options.length && itemOptions.length ? 2 : 0) +
                (qId && qId === item.parentId ? 1 : 0);
            if (score > best) {
                best = score;
                match = item;
            } else if (score === best) match = undefined;
        }
        return match;
    }

    // =========================================================================
    // 6. GIẢI QUYẾT TẤT CẢ CÁC DẠNG CÂU HỎI OLM (ALL 15+ EXTENDED QUESTION TYPES)
    // =========================================================================
    const sourceQuestions = new WeakMap();
    const choiceBlanksSelector = '.select-option, .qlib-opt_wrapper-dropdown, .select-advance-wrapper, ' +
        '.selecttext, .selectadvance, [role="combobox"], [aria-haspopup="listbox"]';
    const stemDecorations = '.qselect, .qcheckbox, tr.tf-row, .item-drag, .boxlink, .quiz-list, .quiz-options, .link-list, .group-list, .two-list, ' +
        '.sort-list, .order-list, .arrange-list, .list-sort, .sort-item, .item-sort, .order-item, ' +
        '.true-false, style, script, .titlex, .title-itm, .q-title, .question-title, input, textarea, ' +
        '.dragtext, .qlib-opt_center, ' + choiceBlanksSelector;

    function ingestMountedQuestions(roots) {
        for (const root of roots) {
            for (const host of root.querySelectorAll('default-root, [data-id-quiz], [data-qid], [data-question-id]')) {
                const source = host.jsonQuestion;
                if (!source || typeof source !== 'object') continue;
                const params = host.dataLog?.q_params ?? host.dataLog?.params;
                const previous = sourceQuestions.get(host);
                const answer = source.answerCorrect ?? source.correctAnswer ?? source.correct_answer ?? source.answer;
                const content = source.content || source.html || source.json_content || source.json;
                if (previous?.revision !== pageRevision || previous.source !== source || previous.content !== content || previous.answer !== answer) {
                    sourceQuestions.set(host, { revision: pageRevision, source, content, answer });
                    processQuestionsArray([source]);
                }
                const id = getComponentQuestionId(host);
                if (id && params) applyMetadata({ data_log: [{ idq: id, q_params: params }] }, false);
            }
        }
    }

    function addInlineHint(el, text, tone) {
        if (!el.parentNode) return;
        highlightDomOptionElement(el, tone);
        let badge = hintBadges.get(el);
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'olm-mq-hint';
            badge.style.cssText = 'position:absolute;pointer-events:none;color:#1d4ed8;background:#eff6ff;' +
                'font:700 11px/1.2 system-ui;padding:1px 3px;border-radius:3px;box-sizing:border-box;' +
                'width:max-content;writing-mode:horizontal-tb;white-space:normal;overflow-wrap:break-word;';
            badge.hidden = true;
            ensureOverlayRoot().appendChild(badge);
            hintBadges.set(el, badge);
        }
        badge.innerHTML = 'Gợi ý: <b>' + formatRichHtml(text) + '</b>';
    }

    const openChoiceMenus = '[role="listbox"], .dropdown-menu.show, .qlib-opt_dropdown.show, [role="dialog"][aria-modal="true"]';

    function positionInlineHints() {
        if (!hintBadges.size && !optionMarks.size) return;
        const view = viewportBounds();
        const origin = view.origin;
        const box = rect => ({
            left: (rect.left - origin.left) / view.scaleX, top: (rect.top - origin.top) / view.scaleY,
            right: (rect.right - origin.left) / view.scaleX, bottom: (rect.bottom - origin.top) / view.scaleY
        });
        const occupied = [];
        for (const root of observedRoots) {
            for (const menu of root.querySelectorAll(openChoiceMenus)) {
                const rect = menu.getBoundingClientRect();
                if (rect.width && rect.height && getComputedStyle(menu).visibility !== 'hidden') occupied.push(box(rect));
            }
        }
        const overlaps = (a, b) => a.left < b.right + 2 && a.right > b.left - 2 &&
            a.top < b.bottom + 2 && a.bottom > b.top - 2;
        for (const [control, mark] of optionMarks) {
            const rect = box(control.getBoundingClientRect());
            const left = Math.max(rect.left, view.left);
            const top = Math.max(rect.top, view.top);
            const right = Math.min(rect.right, view.left + view.width);
            const bottom = Math.min(rect.bottom, view.top + view.height);
            mark.hidden = !control.isConnected || right <= left || bottom <= top ||
                occupied.some(menu => overlaps(rect, menu));
            if (mark.hidden) continue;
            mark.style.left = left + 'px';
            mark.style.top = top + 'px';
            mark.style.width = right - left + 'px';
            mark.style.height = bottom - top + 'px';
        }
        for (const [control, badge] of hintBadges) {
            const bounds = control.getBoundingClientRect();
            const rect = box(bounds);
            badge.hidden = !control.isConnected || !bounds.width || !bounds.height ||
                rect.bottom < view.top || rect.top > view.top + view.height ||
                rect.left > view.left + view.width || rect.right < view.left ||
                control.matches('[aria-expanded="true"]') || !!control.querySelector('[aria-expanded="true"]');
            if (badge.hidden) continue;
            badge.style.maxWidth = Math.max(0, view.width - 8) + 'px';
            const width = badge.offsetWidth;
            const height = badge.offsetHeight;
            const left = clampPosition(rect.left, view.left + 4, view.left + view.width - width - 4);
            const positions = [rect.top - height - 2, rect.bottom + 2, rect.top - 2 * height - 5];
            const placement = positions.map(top => ({ left, right: left + width, top, bottom: top + height }))
                .find(candidate => candidate.top >= view.top && candidate.bottom <= view.top + view.height &&
                    !occupied.some(other => overlaps(candidate, other)));
            badge.hidden = !placement;
            if (!placement) continue;
            badge.style.left = placement.left + 'px';
            badge.style.top = placement.top + 'px';
            occupied.push(placement);
        }
    }

    function resolveInlineChoices(sr, db) {
        const selector = 'select, ' + choiceBlanksSelector;
        const controls = Array.from(sr.querySelectorAll(selector)).filter(el => !el.parentElement?.closest(selector));
        return controls.flatMap((control, index) => {
            const explicit = control.getAttribute('ind') ?? control.getAttribute('data-ind') ?? control.getAttribute('data-index');
            const sourceIndex = questionId(explicit) ? Number(explicit) : index;
            const entry = db?.correctAnswers.find(answer => answer.index === sourceIndex);
            const options = control.tagName === 'SELECT' ? Array.from(control.options) :
                Array.from(control.querySelectorAll('[role="option"], .qlib-opt_dropdown [data-value], .select-advance-dropdown-item'));
            const match = findUniqueOption(cleanScienceText(entry?.text), options, option => extractOptionCleanText(option));
            // These OLM-rendered controls retain the original choice key after shuffling.
            const zero = control.matches('select.select-option') ? options.find(option => option.value === '0') :
                control.matches('.qlib-opt_wrapper-dropdown, .select-advance-wrapper') ?
                    options.find(option => option.getAttribute('data-value') === '0') : null;
            const text = entry?.text ? (match ? extractOptionCleanText(match) : entry.text) : zero && extractOptionCleanText(zero);
            if (!text) return [];
            addInlineHint(control, text, 'green');
            return [{ html: blankHintHtml(index, text, 'Chọn'), known: true }];
        });
    }

    function extractSortCardText(el) {
        if (!el) return '';
        const clone = el.cloneNode(true);
        clone.querySelectorAll('button, [role="button"], .sort-controls, .sort-arrows, .btn-up, .btn-down').forEach(b => b.remove());
        return extractOptionCleanText(clone).replace(/^#+\s*/, '').trim();
    }

    function findSortCards(sr) {
        if (!sr || typeof sr.querySelectorAll !== 'function') return [];
        const explicitSel = '.sort-list > li, .order-list > li, .arrange-list > li, .list-sort > li, ' +
            '.sort-item, .item-sort, .order-item, .arrange-item, [data-sort-item], [data-order-item]';
        const explicit = Array.from(sr.querySelectorAll(explicitSel)).filter(el => !el.parentElement?.closest(explicitSel));
        if (explicit.length >= 2) return explicit;

        // Heuristic cho giao diện thẻ xếp dọc có cặp nút mũi tên ↑ / ↓ (mobile modal OLM)
        const isArrowBtn = btn => {
            const txt = (btn.textContent || '').trim();
            if (/^[↑↓▲▼⬆⬇⇧⇩]$/.test(txt)) return true;
            const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.className || '').toString().toLowerCase();
            if (/(?:move[-_\s]?|sort[-_\s]?|arrow[-_\s]?|btn[-_\s]?)(?:up|down)|lên|xuống/.test(label)) return true;
            return !txt && !!btn.querySelector('svg');
        };
        const groups = new Map();
        const buttons = Array.from(sr.querySelectorAll('button, [role="button"]')).filter(isArrowBtn);
        for (const btn of buttons) {
            const ctrlParent = btn.parentElement;
            if (!ctrlParent) continue;
            const siblingArrows = Array.from(ctrlParent.children).filter(ch => ch.matches('button, [role="button"]') && isArrowBtn(ch));
            if (siblingArrows.length !== 2) continue;
            for (let card = ctrlParent.parentElement, depth = 0; card && depth < 4; card = card.parentElement, depth++) {
                const list = card.parentElement;
                if (!list || list === document.body || list === document.documentElement) break;
                const text = extractSortCardText(card);
                if (text.length >= 2) {
                    let set = groups.get(list);
                    if (!set) { set = new Set(); groups.set(list, set); }
                    set.add(card);
                    break;
                }
            }
        }
        let best = [];
        for (const set of groups.values()) {
            if (set.size > best.length) best = Array.from(set);
        }
        return best.length >= 2 ? best : [];
    }

    function solveQuestionComponent(comp, displayNum, qId, choiceGroup = null, partKind = '') {
        const sr = choiceGroup || getShadowRoot(comp) || comp;
        const accepts = kind => !partKind || partKind === kind;
        const tag = (comp.tagName || '').toLowerCase();
        const orderOwner = choiceGroup || comp;
        const shuffleOrder = readOptionOrder(orderOwner.dataLog?.q_params ?? orderOwner.params) || optionShuffleMap.get(qId);
        const rawMap = (choiceGroup || comp).mapCorrectAnswer;
        const map = typeof rawMap === 'string' ? readPayload(rawMap) : rawMap;

        // 16. Bóc tách đề bài thuần túy (loại bỏ container đáp án mà không xóa ol/ul/table của đề bài)
        const stemEl = (choiceGroup && choiceGroup.previousElementSibling?.matches('p, h4, h5, .question-content') ?
            choiceGroup.previousElementSibling : null) ||
            sr.querySelector('.question-content, #question-content, #border-word, #paragraph, .q-content');
        let stemText = '';
        if (stemEl) {
            const cloneStem = stemEl.cloneNode(true);
            cloneStem.querySelectorAll?.(stemDecorations)?.forEach(el => el.remove());
            stemText = extractOptionCleanText(cloneStem);
        }
        if (!stemText) {
            const cloneSr = sr.host ? sr.ownerDocument.createDocumentFragment() : sr.cloneNode(true);
            if (sr.host) sr.childNodes.forEach(node => cloneSr.appendChild(node.cloneNode(true)));
            cloneSr.querySelectorAll?.(stemDecorations)?.forEach(el => el.remove());
            stemText = extractOptionCleanText(cloneSr);
        }
        // Dự phòng cho đề bài chỉ chứa ảnh, bảng biểu hoặc công thức toán
        if (!stemText) {
            const imgs = Array.from((stemEl || sr).querySelectorAll('img'));
            if (imgs.length) {
                stemText = imgs.map(img => img.getAttribute('src') || img.alt || '[image]').join(' ');
            } else {
                const tex = (stemEl || sr).querySelector('annotation[encoding="application/x-tex"], math')?.textContent?.trim();
                const qTitle = (stemEl || sr).querySelector('.q-title, .title-itm, .title-question, .question-title')?.innerText?.trim();
                stemText = tex || qTitle || (qId ? 'qid_' + qId : '');
            }
        }
        const shortStem = stemText.length > 85 ? stemText.slice(0, 82) + '...' : stemText;

        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const isEssay = accepts('18') && !choiceGroup && (tag.includes('paragraph') || !!sr.querySelector('textarea.typing-para, [data-lexical-editor]'));
        const result = (kind, renderedAnswers, db) => ({
            uid: kind + '_' + (db?.id || qId || displayNum), displayNumber: displayNum, shortStem, renderedAnswers,
            questionId: db?.id || qId, domElement: comp
        });
        function originalIndex(el, index, count) {
            const attr = el.getAttribute('data-ind') ?? el.getAttribute('ind') ??
                (el.matches('.tf-row') ? el.getAttribute('data-id') : null);
            if (questionId(attr) && Number(attr) < count) return Number(attr);
            return shuffleOrder?.length === count ? shuffleOrder[index] : null;
        }

        const tfRows = Array.from(sr.querySelectorAll('.tf-row, tr, [role="row"]')).filter(row =>
            !row.parentElement?.closest('.tf-row, tr, [role="row"]') &&
            row.querySelector('.tf-box, [data-tf-value], input[type="radio"], [role="radio"]'));
        if (accepts('13') && (tfRows.length || tag.includes('true-false') || tag.includes('true-fasle'))) {
            const texts = tfRows.map(row => extractOptionCleanText(row.querySelector('.clause, .tf-statement, [data-statement], td, [role="cell"]') || row).replace(/^[a-d]\s*[\).:]\s*/i, '').trim());
            const db = findMatchingDbQuestion(stemText, texts, qId, ['13']);
            const rendered = [];
            tfRows.forEach((row, i) => {
                const options = db?.allOptions || [];
                const matched = findUniqueOption(texts[i], options, option => option.cOpt);
                const indexElement = row.matches('[ind], [data-ind], [data-id]') ? row : row.querySelector('[ind], [data-ind]') || row;
                const ind = originalIndex(indexElement, i, tfRows.length);
                const option = matched || options[ind];
                const notGiven = option?.notGiven || (ind !== null && ['2', 2].includes(map?.[ind]));
                const truth = option?.isTrue ?? (ind === null ? null : parseTruth(map?.[ind]));
                const key = notGiven ? 2 : truth === true ? 1 : truth === false ? 0 : null;
                const label = key === 2 ? 'Không xác định' : key === 1 ? 'ĐÚNG ✅' : key === 0 ? 'SAI ❌' : 'Chưa rõ';
                if (key !== null) {
                    const controls = row.querySelectorAll('[data-tf-value], input[type="radio"], [role="radio"]');
                    const target = Array.from(controls).find(control => {
                        const value = control.getAttribute('data-tf-value') ?? control.getAttribute('value');
                        if (value === String(key) || (key !== 2 && parseTruth(value) === truth)) return true;
                        const caption = (control.getAttribute('aria-label') || Array.from(control.labels || [], el => el.textContent).join(' '))
                            .trim().toLowerCase();
                        return (key === 1 ? /^(đúng|đ|true)$/ : key === 0 ? /^(sai|s|false)$/ : /^(không xác định|kxđ|not given)$/).test(caption);
                    });
                    if (target) highlightDomOptionElement(target.labels?.[0] || target.closest('label') || target);
                    else {
                        const cell = row.querySelector('.tf-box, [data-tf-control]');
                        if (cell) addInlineHint(cell, label, 'blue');
                    }
                }
                rendered.push({ html: '<b>' + (letters[i]?.toLowerCase() || i + 1) + ') ' + label + '</b>',
                    known: key !== null });
            });
            if (rendered.length) return result('tf', rendered, db);
        }

        const hasChoiceBlanks = tag.includes('select-text') || tag.includes('select-advance') ||
            !!sr.querySelector(choiceBlanksSelector + ', select');
        if (accepts('11') && hasChoiceBlanks) {
            const db = findMatchingDbQuestion(stemText, [], qId, ['11']);
            const answers = resolveInlineChoices(sr, db);
            if (answers.length || db) return result('selecttext', answers.length ? answers : db.correctAnswers, db);
        }

        const choiceSelector = liveChoiceSelector + (choiceGroup?.matches('ol, ul') ? ', li' : '');
        const multipleChoices = Array.from(sr.querySelectorAll(choiceSelector)).filter(el =>
            !el.parentElement?.closest(choiceSelector) &&
            !el.closest('.true-false, type-select-text, type-select-text-mobile, type-drag-text'));
        if (accepts('mc') && multipleChoices.length && !tag.includes('select-text') && !tag.includes('drag-text')) {
            const contents = multipleChoices.map(el => {
                if (el.querySelector('.qsign') && el.querySelector('.qimage')) return el;
                return el.querySelector('.qsign, .qimage, .content, label') || el;
            });
            const texts = contents.map(el => extractOptionCleanText(el).replace(/^[a-z]\s*[\).:]\s+/i, ''));
            const db = findMatchingDbQuestion(stemText, texts, qId, ['mc']);
            const rendered = [];
            multipleChoices.forEach((el, i) => {
                const ind = originalIndex(el, i, multipleChoices.length);
                const options = db?.allOptions || [];
                const matched = findUniqueOption(texts[i], options, option => option.cOpt);
                const marked = el.matches('.qcorrect, .correctq, [data-correct="1"]') || el.querySelector('.qcorrect, .correctq');
                const correct = marked || matched?.isCorrect || (matched == null && ind !== null &&
                    (options[ind]?.isCorrect ?? parseTruth(map?.[ind])));
                if (!correct) return;
                highlightDomOptionElement(el);
                const mark = el.querySelector('.mark, .q-label, [data-option-label]');
                const label = mark?.textContent.trim().match(/^([A-Z])[.):]?$/)?.[1] || letters[i] || '#' + (i + 1);
                rendered.push({ html: '<b>Chọn ' + label + '</b> ' + formatOptionElement(contents[i]), known: true });
            });
            if (rendered.length) return result('mc', rendered, db);
            return result('mc', [], db);
        }

        const editorSelector = '.mq-editable-field, math-field, .mq-root-block, .math-eq';
        const inputs = Array.from(sr.querySelectorAll(
            'input[type="text"], input[type="number"], input:not([type]), textarea, ' +
            '.input-ans, .short-ans-input, .math-eq, ' + editorSelector
        )).filter(el => !el.parentElement?.closest(editorSelector) &&
            !el.closest('.true-false, type-select-text, type-select-text-mobile') &&
            !el.matches('[type="hidden"], [type="radio"], [type="checkbox"]'));
        if (accepts('fill') && !isEssay && (!hasChoiceBlanks || partKind === 'fill') && !tag.includes('drag-text') &&
            (inputs.length || tag.includes('fill') || tag.includes('short-answer'))) {
            const db = findMatchingDbQuestion(stemText, [], qId, ['fill', '18']);
            const known = db?.correctAnswers || [];
            if (!inputs.length && known.length) return result('fill', known, db);
            const raw = comp.answerCorrect ?? comp.correctAnswer ?? comp.correctText ?? comp.right;
            const local = typeof raw === 'string' && /^\s*[\[{]/.test(raw) ? readPayload(raw) ?? raw : raw;
            if (!inputs.length && ['string', 'number'].includes(typeof local) && String(local).trim()) {
                return result('fill', [{ html: blankHintHtml(0, String(local), 'Điền') }], db);
            }
            const rendered = inputs.map((el, index) => {
                const explicit = el.getAttribute('ind') ?? el.getAttribute('data-ind') ?? el.getAttribute('data-index');
                const sourceIndex = questionId(explicit) ? Number(explicit) : index;
                const entry = known.find(item => item.index === sourceIndex) || known.find(item => item.index === index);
                const direct = typeof local === 'object' ? (local?.[sourceIndex] ?? local?.[index]) : inputs.length === 1 ? local : undefined;
                const value = entry?.text ?? direct ?? inputAccepts(el);
                const text = (Array.isArray(value) ? value : ['string', 'number'].includes(typeof value) ?
                    splitSourceChoices(String(value)) : []).find(value => String(value ?? '').trim());
                if (text != null) addInlineHint(el, String(text), 'blue');
                return { html: (entry && sourceIndex === index ? entry.html : null) || blankHintHtml(index, text ?? 'Chưa có đáp án', 'Điền'), known: text != null };
            });
            return result('fill', rendered, db);
        }

        // =====================================================================
        // DẠNG 4: KÉO THẢ TỪ VÀO CHỖ TRỐNG (<type-drag-text>)
        // Hỗ trợ đảo vị trí ô trống & đảo kho từ
        // =====================================================================
        if (accepts('drag') && (tag.includes('drag-text') || sr.querySelector('.item-drag, .dragtext'))) {
            const baseDbMatch = findMatchingDbQuestion(stemText, [], qId, ['fill']);
            const correctMap = typeof comp.answerCorrect === 'string' ? readPayload(comp.answerCorrect) : comp.answerCorrect;
            const renderedAnswers = [];
            const bankWords = Array.from(sr.querySelectorAll('.item-drag .drag-select, .word-bank .drag-select, .word-bank .drag-option, [data-word-bank] [data-word-id]'));
            const blanks = Array.from(sr.querySelectorAll('.dragtext, .drag-slot[data-blank-index]'));
            blanks.forEach((blank, index) => {
                const original = blank.getAttribute('ind') ?? blank.getAttribute('data-blank-index') ?? blank.getAttribute('data-id') ?? index;
                const id = correctMap?.[original];
                const word = id == null ? null : bankWords.find(el =>
                    [el.getAttribute('data-id'), el.getAttribute('data-ans-id'), el.getAttribute('data-key'),
                        el.getAttribute('data-word-id'), el.querySelector('[data-id]')?.getAttribute('data-id'), el.id]
                        .some(key => key != null && key !== '' && key === String(id)));
                const cached = baseDbMatch?.correctAnswers.find(item => item.index === Number(original));
                const text = word ? extractOptionCleanText(word) : cached?.text ??
                    (typeof id === 'string' && !questionId(id) ? id : '');
                if (!text) return;
                if (word) highlightDomOptionElement(word);
                addInlineHint(blank, text, 'green');
                renderedAnswers.push({ html: blankHintHtml(index, text, 'Điền') });
            });

            // Dự phòng từ CSDL nếu comp.answerCorrect bị rỗng
            if (renderedAnswers.length === 0 && baseDbMatch && baseDbMatch.correctAnswers && baseDbMatch.correctAnswers.length > 0) {
                baseDbMatch.correctAnswers.forEach((ans, aIdx) => {
                    renderedAnswers.push({
                        html: '<span style="background:#0891b2;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Ô ' + (aIdx + 1) + '</span> ➔ <b>' + formatRichHtml(ans.text) + '</b>',
                        isTrueStatement: true
                    });
                });
            }

            if (renderedAnswers.length > 0) {
                return result('drag', renderedAnswers, baseDbMatch);
            }
        }

        // =====================================================================
        // DẠNG 5: GHÉP ĐÔI / NỐI CỘT (<type-link-list>, .boxlink)
        // Hỗ trợ đảo vị trí cột phải
        // =====================================================================
        const isLinkList = tag.includes('link-list');
        const boxLefts = Array.from(sr.querySelectorAll('.boxlink.left, .boxlink[data-pos="left"]' +
            (isLinkList ? ', [data-side="left"], .link-left' : '')));
        const boxRights = Array.from(sr.querySelectorAll('.boxlink.right, .boxlink[data-pos="right"]' +
            (isLinkList ? ', [data-side="right"], .link-right' : '')));
        if (accepts('6') && (isLinkList || (boxLefts.length && boxRights.length))) {
            const db = findMatchingDbQuestion(stemText, [], qId, ['6']);
            const raw = comp.answerCorrect ?? comp.mapCorrectAnswer;
            const correctMap = typeof raw === 'string' ? readPayload(raw) : raw;
            const getId = el => el.getAttribute('data-id') ?? el.getAttribute('data-key') ?? el.id;
            const rendered = boxLefts.flatMap((left, index) => {
                const text = extractOptionCleanText(left);
                const pair = findUniqueOption(text, db?.linkPairs || [], pair => cleanScienceText(pair.left));
                const leftId = getId(left);
                const key = correctMap?.[leftId || index] ?? (left.matches('.boxlink[data-pos="left"][data-id]') ? leftId : null);
                const right = (pair && findUniqueOption(cleanScienceText(pair.right), boxRights, extractOptionCleanText)) ||
                    (key != null && boxRights.find(option => getId(option) === String(key)));
                const rightText = pair?.right || (right && extractOptionCleanText(right));
                if (!rightText) return [];
                if (right) {
                    highlightDomOptionElement(left);
                    highlightDomOptionElement(right);
                }
                return [{ html: '<b>Nối:</b> ' + formatOptionElement(left) + ' ➔ ' +
                    (right ? formatOptionElement(right) : formatRichHtml(rightText)) }];
            });
            if (rendered.length || db) return result('match', rendered.length ? rendered : db.correctAnswers, db);
        }

        // =====================================================================
        // DẠNG 6: GOM NHÓM / PHÂN LOẠI (<type-group-list>, <type-two-list>)
        // Hỗ trợ đảo các thẻ cần kéo
        // =====================================================================
        const groupZones = Array.from(sr.querySelectorAll?.('[data-dropzone], .dropzone, .group-box, .category-box, .qgroup') || []);
        const groupDrags = Array.from(sr.querySelectorAll?.('[draggable="true"], .tw-drag-item, .drag-item, .qdrag') || []);
        if (accepts('10') && (groupZones.length >= 2 || tag.includes('group-list') || tag.includes('two-list'))) {
            const baseDbMatch = findMatchingDbQuestion(stemText, [], qId, ['10']);
            const raw = comp.answerCorrect ?? comp.right;
            const correctMap = (typeof raw === 'string' ? readPayload(raw) : raw) || {};
            const renderedAnswers = [];
            groupZones.forEach((zone, zIdx) => {
                const zoneTitle = extractOptionCleanText(zone.querySelector('.title, .group-name, h4, h5') || zone);
                const targetItems = [];
                for (const [itemId, targetZoneId] of Object.entries(correctMap)) {
                    if (String(targetZoneId) === String(zIdx) || String(targetZoneId) === zone.id) {
                        const dragEl = groupDrags.find(d => d.getAttribute('data-id') === itemId || d.id === itemId);
                        if (dragEl) targetItems.push(extractOptionCleanText(dragEl));
                    }
                }
                if (!targetItems.length) {
                    const group = baseDbMatch?.groups?.find(group => cleanLooseScience(group.title) === cleanLooseScience(zoneTitle));
                    if (group) targetItems.push(...group.items);
                }
                if (!targetItems.length) return;
                renderedAnswers.push({
                    html: '<span style="background:#0284c7;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Nhóm ' + (zIdx + 1) + '</span> <b>' + escapeHtml(zoneTitle.slice(0, 20) || 'Nhóm') + '</b>: ' + targetItems.map(formatRichHtml).join(', '),
                    isTrueStatement: true
                });
            });
            // Dự phòng từ CSDL nếu comp.answerCorrect bị rỗng
            if (renderedAnswers.length === 0 && baseDbMatch && (baseDbMatch.groups || baseDbMatch.correctAnswers)) {
                const dbGroups = baseDbMatch.groups || baseDbMatch.correctAnswers || [];
                dbGroups.forEach((g, gIdx) => {
                    renderedAnswers.push({
                        html: g.html || ('<span style="background:#0284c7;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Nhóm ' + (gIdx + 1) + '</span> <b>' + escapeHtml(g.title || 'Nhóm') + '</b>: ' + formatRichHtml(Array.isArray(g.items) ? g.items.join(', ') : g.text)),
                        isTrueStatement: true
                    });
                });
            }

            if (renderedAnswers.length > 0) {
                return result('group', renderedAnswers, baseDbMatch);
            }
        }

        // =====================================================================
        // DẠNG 7: GẠCH CHÂN / CHỌN TỪ TRONG CÂU (<type-under-line>)
        // =====================================================================
        const wordEls = Array.from(sr.querySelectorAll?.('span.word, [class*="underline"], [class*="word-select"]') || []);
        if (accepts('9') && (wordEls.length >= 2 || tag.includes('under-line'))) {
            const baseDbMatch = findMatchingDbQuestion(stemText, [], qId, ['9']);
            const correctIndices = (typeof comp.answerCorrect === 'string' ? readPayload(comp.answerCorrect) : comp.answerCorrect) || [];
            const targetWords = [];
            wordEls.forEach((wEl, wIdx) => {
                const attrInd = wEl.getAttribute('ind');
                const wordInd = (attrInd !== null && attrInd !== '') ? Number(attrInd) : wIdx;
                const isSelected = Array.isArray(correctIndices) ? correctIndices.some(index => questionId(index) && Number(index) === wordInd) : parseTruth(correctIndices[wordInd]) === true;
                if (isSelected) {
                    highlightDomOptionElement(wEl);
                    targetWords.push(extractOptionCleanText(wEl));
                }
            });
            // Dự phòng từ CSDL nếu comp.answerCorrect rỗng
            if (targetWords.length === 0 && baseDbMatch && baseDbMatch.correctAnswers && baseDbMatch.correctAnswers.length > 0) {
                baseDbMatch.correctAnswers.forEach(ans => {
                    const txt = ans.text || (typeof ans === 'string' ? ans : '');
                    if (!txt) return;
                    targetWords.push(txt);
                    const word = findUniqueOption(cleanScienceText(txt), wordEls, extractOptionCleanText);
                    if (word) highlightDomOptionElement(word);
                });
            }

            if (targetWords.length > 0) {
                return result('underline', [{
                        html: '<span style="background:#d97706;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Gạch chân</span> <b>' + targetWords.map(formatRichHtml).join(', ') + '</b>',
                        isTrueStatement: true
                    }], baseDbMatch);
            }
        }

        // =====================================================================
        // DẠNG 9: SẮP XẾP THỨ TỰ (<type-order>, <type-sort>, thẻ dọc ↑↓, .word-pool)
        // =====================================================================
        const wordPool = sr.querySelector?.('.word-pool, .source-words, type-order, type-rearrange, type-sort, type-sort-list, type-arrange');
        const sortCards = findSortCards(sr);
        if (accepts('order') && (wordPool || sortCards.length >= 2 || tag.includes('order') || tag.includes('rearrange') || tag.includes('sort') || tag.includes('arrange'))) {
            const cardTexts = sortCards.map(extractSortCardText);
            const dbMatch = findMatchingDbQuestion(stemText, cardTexts, qId, ['order', '18']);
            const rawOrder = comp.correctText ?? comp.answerCorrect;
            const order = typeof rawOrder === 'string' && /^\s*[\[{]/.test(rawOrder) ? readPayload(rawOrder) ?? rawOrder : rawOrder;
            function extractOrderItemText(item) {
                if (item == null) return '';
                if (typeof item === 'object') {
                    return item.text || item.title || item.content || item.name || item.word || item.val || item.value || (item.id != null ? String(item.id) : '');
                }
                return String(item).trim();
            }
            let orderedTexts = [];
            if (dbMatch?.qType === 'order' && dbMatch.correctAnswers?.length) {
                orderedTexts = dbMatch.correctAnswers.map(a => a.text).filter(Boolean);
            } else if (Array.isArray(order)) {
                const asIndexes = readOptionOrder(order);
                if (asIndexes && sortCards.length === asIndexes.length) {
                    const cardBySource = new Map();
                    sortCards.forEach((card, idx) => {
                        const attr = card.getAttribute('data-ind') ?? card.getAttribute('ind') ?? card.getAttribute('data-id');
                        if (questionId(attr)) cardBySource.set(Number(attr), cardTexts[idx]);
                    });
                    if (cardBySource.size === sortCards.length) {
                        orderedTexts = asIndexes.map(idx => cardBySource.get(idx)).filter(Boolean);
                    } else if (dbMatch?.allOptions?.length === asIndexes.length) {
                        orderedTexts = asIndexes.map(idx => dbMatch.allOptions[idx]?.text).filter(Boolean);
                    }
                }
                if (!orderedTexts.length) {
                    orderedTexts = order.map(extractOrderItemText).filter(Boolean);
                }
            } else if (typeof order === 'object' && order !== null) {
                orderedTexts = Object.values(order).map(extractOrderItemText).filter(Boolean);
            } else if (order != null && String(order).trim()) {
                orderedTexts = [String(order).trim()];
            } else if (dbMatch?.correctAnswers?.[0]?.text) {
                orderedTexts = dbMatch.correctAnswers.map(a => a.text).filter(Boolean);
            }

            if (orderedTexts.length) {
                const cardTargets = new Map();
                if (sortCards.length && orderedTexts.length > 1) {
                    const candidates = orderedTexts.map((text, pos) => ({ pos, text, cOpt: cleanScienceText(text) }));
                    sortCards.forEach((card, cardIdx) => {
                        const txt = cardTexts[cardIdx];
                        const match = findUniqueOption(txt, candidates, c => c.cOpt);
                        if (match) {
                            cardTargets.set(match.pos, cardIdx + 1);
                            addInlineHint(card, 'Vị trí #' + (match.pos + 1), 'green');
                        }
                    });
                }
                if (orderedTexts.length > 1) {
                    const rendered = orderedTexts.map((txt, pos) => {
                        const currentPos = cardTargets.get(pos);
                        const moveHint = currentPos ? ' <small style="color:#475569;">(thẻ #' + currentPos + ')</small>' : '';
                        return {
                            html: '<span style="background:#059669;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:4px;font-size:10px;">' + (pos + 1) + '</span>' +
                                formatRichHtml(txt) + moveHint,
                            known: true
                        };
                    });
                    return result('order', rendered, dbMatch);
                }
                return result('order', [{
                    html: '<span style="background:#059669;color:#fff;padding:1px 5px;border-radius:4px;font-weight:700;margin-right:5px;font-size:10.5px;">Thứ tự ghép</span> <b>' + formatRichHtml(orderedTexts[0]) + '</b>',
                    known: true
                }], dbMatch);
            }
        }

        // =====================================================================
        // DẠNG 10: TỰ LUẬN / ĐOẠN VĂN (<type-paragraph>, textarea.typing-para)
        // =====================================================================
        if (isEssay) {
            const dbMatch = findMatchingDbQuestion(stemText, [], qId, ['18']);
            const ansText = dbMatch && dbMatch.correctAnswers[0]?.text;
            return result('para', [{
                    html: ansText ? ('<b>Gợi ý bài làm:</b> ' + formatRichHtml(ansText)) : '<span style="color:#64748b;">(Tự luận / Đọc hiểu — Soạn bài vào ô trả lời)</span>',
                    known: !!ansText
                }], dbMatch);
        }

        return null;
    }

    // =========================================================================
    // 7. QUÉT TOÀN BỘ CÂU HỎI TRÊN MÀN HÌNH (UNIVERSAL SCREEN SCANNER)
    //    Hỗ trợ Reading Comprehension (tabs 18-25), type-mix, classic exam, OMR
    // =========================================================================
    function renderStoredQuestion(db, displayNumber) {
        const order = optionShuffleMap.get(db.id);
        const renderedAnswers = db.correctAnswers.map(answer => {
            const index = order?.length === db.allOptions.length ? order.indexOf(answer.index) : -1;
            if (index < 0) return answer;
            if (db.qType === 'mc') {
                const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[index] || '#' + (index + 1);
                return { index, html: '<b>Chọn ' + letter + '</b> ' + (db.allOptions[answer.index]?.html || formatRichHtml(answer.text)) };
            }
            if (db.qType === '13') {
                const letter = 'abcdefghijklmnopqrstuvwxyz'[index] || String(index + 1);
                const label = answer.notGiven ? 'Không xác định' : answer.isTrueStatement === null ? 'Chưa rõ' :
                    answer.isTrueStatement ? 'Đúng' : 'Sai';
                return { index, known: answer.known, html: '<b>' + letter + ') ' + label + '</b>' };
            }
            return answer;
        }).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const originalOrder = ['mc', '13'].includes(db.qType) && order?.length !== db.allOptions.length;
        return { uid: db.uid, questionId: db.id, displayNumber, shortStem: db.shortStem, renderedAnswers, originalOrder };
    }

    function getPracticeDisplayNumber() {
        const current = document.querySelector('#question-static .q-static.q-select[data-quiz]');
        const index = current?.getAttribute('data-quiz');
        return questionId(index) ? Number(index) + 1 : null;
    }

    function getMountedParentId(el, leafSelector) {
        for (let node = composedParent(el); node; node = composedParent(node)) {
            if (!node.matches('default-root')) continue;
            const scope = getShadowRoot(node) || node;
            const direct = scope.querySelectorAll(leafSelector);
            if (direct.length > 1 && String(node.jsonQuestion?.q_type) !== '22') return '';
            return getComponentQuestionId(node);
        }
        return '';
    }

    function hasKnownAnswers(row) {
        return row.renderedAnswers.some(answer => answer.known !== false);
    }

    const questionComponents = 'type-quiz-x, type-quiz-x-mobile, type-quiz-multi, type-quiz-multi-mobile, ' +
            'type-true-false, type-true-false-mobile, type-true-fasle, type-true-fasle-mobile, ' +
            'type-fill-me, type-fill-me-mobile, type-short-answer, type-short-answer-mobile, ' +
            'type-drag-text, type-drag-text-mobile, type-link-list, type-link-list-mobile, ' +
            'type-group-list, type-group-list-mobile, type-two-list, type-two-list-mobile, ' +
            'type-under-line, type-under-line-mobile, type-select-text, type-select-text-mobile, type-select-advance, type-select-advance-mobile, ' +
            'type-order, type-rearrange, type-order-mobile, type-rearrange-mobile, ' +
            'type-sort, type-sort-mobile, type-sort-list, type-sort-list-mobile, type-sort-text, type-sort-text-mobile, ' +
            'type-arrange, type-arrange-mobile, type-order-list, type-order-list-mobile, type-reorder, type-reorder-mobile, ' +
            'type-paragraph, type-paragraph-mobile, type-quiz-list, type-quiz-list-mobile, type-mix, type-mix-mobile';
    const classicQuestions = '.q-view-itemx.question, .box-question, .card-question, [id^="user-test-"], .one-quiz-item, .box-quiz, .quiz-item, #quizz, [data-question-id], .modal-question, .question-modal, .olm-question-modal, [data-question]';
    const questionContainers = questionComponents + ', ' + classicQuestions + ', default-root';

    function readDisplayNumber(title) {
        const label = title?.textContent.trim().match(/^(?:câu\s*|question\s*)(\d+)\b|^(\d+)[.:]/i);
        return Number(label?.[1] || label?.[2]) || null;
    }

    const liveChoiceSelector = '.qselect, .qcheckbox, .quiz-options > [ind], .quiz-options > [data-ind]';

    function readLiveParts(scope) {
        const groups = Array.from(scope.querySelectorAll('.quiz-list, .quiz-options')).filter(group =>
            !group.parentElement?.closest('.quiz-list, .quiz-options') && group.querySelector(liveChoiceSelector + ', li'));
        const truthGroups = Array.from(scope.querySelectorAll('.true-false, .tf-table')).filter(group =>
            !group.parentElement?.closest('.true-false, .tf-table') && group.querySelector('li, .tf-row, .tf-box'));
        const parts = [...groups.map(group => ({ kind: 'mc', group, anchor: group })),
            ...truthGroups.map(group => ({ kind: '13', group, anchor: group }))];
        const find = selector => Array.from(scope.querySelectorAll(selector)).find(el =>
            !groups.some(group => group.contains(el)) && !truthGroups.some(group => group.contains(el)));
        for (const [kind, selector] of [
            ['13', '.tf-row, .tf-box'], ['11', 'select, ' + choiceBlanksSelector],
            ['drag', '.dragtext, .drag-slot[data-blank-index]'], ['fill', 'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]), math-field, .mq-editable-field'],
            ['6', '.boxlink, .link-left, [data-side="left"]'], ['10', '[data-dropzone], .dropzone'], ['9', '.under-line, .word-select'],
            ['order', '.word-pool, .source-words, .sort-list, .order-list, .arrange-list, .list-sort, .sort-item, .item-sort'], ['18', 'textarea.typing-para, [data-lexical-editor]']
        ]) {
            const anchor = find(selector);
            if (anchor) parts.push({ kind, group: null, anchor });
        }
        return parts.sort((a, b) => documentOrder(a.anchor, b.anchor));
    }

    function isHiddenInPage(el) {
        for (let node = el; node; node = composedParent(node)) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || node.matches('[hidden], [aria-hidden="true"]')) return true;
        }
        return false;
    }

    function questionBounds(el) {
        if (!el || !el.isConnected || el.closest('[hidden], [aria-hidden="true"]')) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width && rect.height) {
            const visible = el.checkVisibility ?
                el.checkVisibility({ visibilityProperty: true }) : getComputedStyle(el).visibility !== 'hidden';
            return visible ? rect : null;
        }
        if (!el.children.length && !getShadowRoot(el)) return null;
        if (getComputedStyle(el).display === 'none') return null;
        const children = (getShadowRoot(el) || el).children;
        let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
        for (const child of children) {
            const bounds = questionBounds(child);
            if (!bounds) continue;
            left = Math.min(left, bounds.left);
            top = Math.min(top, bounds.top);
            right = Math.max(right, bounds.right);
            bottom = Math.max(bottom, bounds.bottom);
        }
        return Number.isFinite(top) ? { left, top, right, bottom } : null;
    }

    function buildAnswersFromScreen(roots = getAllQuestionRoots()) {
        ingestMountedQuestions(roots);
        if (omrResult && hasOmrInterface(roots)) return omrResult;

        const dbById = new Map();
        const childrenById = new Map();
        for (const row of rawAnswerDatabase) {
            if (!row.id) continue;
            dbById.set(row.id, row);
            if (!row.parentId) continue;
            const children = childrenById.get(row.parentId) || [];
            children.push(row);
            childrenById.set(row.parentId, children);
        }
        const ordered = [];
        const starts = new Map();
        const rosterIds = questionIds.length ? questionIds : Array.from(new Set(rawAnswerDatabase.map(row => row.parentId || row.id).filter(Boolean)));
        for (const id of rosterIds) {
            const part = questionParts.get(id);
            if (part?.label && !starts.has(part.label)) starts.set(part.label, part.start || ordered.length + 1);
            const children = childrenById.get(id);
            if (children?.length) {
                children.slice().sort((a, b) => a.childIndex - b.childIndex)
                    .forEach(child => ordered.push({ id: child.id, part }));
            } else {
                ordered.push({ id, part });
            }
        }
        const partCounts = new Map();
        const roster = new Map(ordered.map(({ id, part }, index) => {
            const label = part?.label || '';
            const start = part?.start || starts.get(label) || 0;
            const offset = partCounts.get(label) || 0;
            partCounts.set(label, offset + 1);
            return [id, { part: label, start, number: start ? start + offset : index + 1 }];
        }));
        const activePart = getActivePart(roots);
        const components = [];
        for (const root of roots) {
            for (const el of root.querySelectorAll(questionContainers)) {
                const scope = getShadowRoot(el) || el;
                const bounds = questionBounds(el);
                if (!bounds && (!el.isConnected || isHiddenInPage(el))) continue;
                if (scope.querySelector(questionComponents) || (!el.matches(questionComponents) && scope.querySelector(classicQuestions))) continue;
                const wrapper = el.closest(classicQuestions);
                const title = (wrapper || scope).querySelector('.title-itm, .titlex, .q-title, .question-title, h4, h5');
                const explicit = readDisplayNumber(title) || (el.matches('#quizz') ? getPracticeDisplayNumber() : null);
                const context = getComponentPart(el);
                const directId = getComponentQuestionId(el) || (wrapper && getComponentQuestionId(wrapper));
                const mountedId = getMountedParentId(el, questionComponents);
                const id = mountedId && !dbById.has(directId) && !roster.has(directId) ? mountedId : directId || mountedId;
                const parts = readLiveParts(scope);
                const split = parts.length > 1;
                (split ? parts : [{ group: null, kind: '', anchor: el }]).forEach(({ group, kind, anchor }, index) => {
                    const sourceKey = (group || parts[0]?.group)?.getAttribute('data-key') || el.getAttribute('data-key') ||
                        (mountedId && directId !== mountedId ? directId : '') || '';
                    const position = split ? questionBounds(anchor) || bounds : bounds;
                    components.push({ el, anchor, group, kind, id, context, index, sourceKey,
                        explicit: readDisplayNumber(group?.previousElementSibling) || (explicit ? explicit + index : null),
                        top: position?.top ?? Infinity, left: position?.left ?? 0 });
                });
            }
        }
        if (!components.length) {
            for (const root of roots) {
                const cards = findSortCards(root);
                if (cards.length < 2) continue;
                const el = cards[0].parentElement;
                const bounds = questionBounds(el);
                if (!bounds && (!el.isConnected || isHiddenInPage(el))) continue;
                const id = getComponentQuestionId(el) || (questionIds.length === 1 ? questionIds[0] : '');
                components.push({
                    el, anchor: el, group: null, kind: 'order', id,
                    context: getComponentPart(el), index: 0, sourceKey: '',
                    explicit: getPracticeDisplayNumber(),
                    top: bounds?.top ?? Infinity, left: bounds?.left ?? 0
                });
                break;
            }
        }
        components.sort((a, b) => a.top - b.top || a.left - b.left || documentOrder(a.el, b.el));
        const offsets = new Map();
        const lastSourceNumber = new Map();
        for (const { id, explicit, context, kind } of components) {
            const slot = roster.get(id);
            if (!slot || kind) continue;
            const part = slot.part || context.label || activePart.label;
            if (lastSourceNumber.get(part) > slot.number) offsets.set(part, null);
            lastSourceNumber.set(part, slot.number);
            if (!explicit) continue;
            const start = context.start || slot.start || activePart.start;
            const number = start && explicit < start ? explicit + start - 1 : explicit;
            const current = offsets.get(part);
            const delta = number - slot.number;
            offsets.set(part, current === undefined || current === delta ? delta : null);
        }
        const nextByPart = new Map();
        const seen = new Set();
        const usedIds = new Set();
        const usedSlots = new Set();
        const anonymousSlots = new Set();
        const rows = [];
        for (const { el, anchor, group, kind, id, context, index, explicit, sourceKey } of components) {
            const source = roster.get(id);
            const parentChildren = childrenById.get(id) || [];
            const declared = sourceKey && parentChildren.find(child => child.sourceKey === sourceKey && (!kind || child.qType === kind));
            const part = source?.part || context.label || questionParts.get(id)?.label || activePart.label;
            const firstChild = parentChildren.find(child => child.childIndex === 0);
            const groupStart = firstChild && roster.get(firstChild.id)?.number;
            const start = context.start || groupStart || source?.start || starts.get(part) || activePart.start || 1;
            const next = nextByPart.get(part) || start;
            const displayNumber = explicit ? (explicit < start ? explicit + start - 1 : explicit) :
                (source && offsets.get(part) !== null ? source.number + (offsets.get(part) || 0) : next);
            const solved = solveQuestionComponent(el, displayNumber, declared?.id || id, group, kind);
            const row = solved || { uid: 'dom_' + (id || rows.length) + '_' + index, questionId: id, displayNumber, renderedAnswers: [] };
            row.domElement = anchor;
            row.part = part;
            const key = row.questionId && (row.questionId !== id || !parentChildren.length) ?
                part + ':' + row.questionId + ':' + displayNumber : anchor;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({ row, id, kind, index });
            if (row.questionId && (row.questionId !== id || !parentChildren.length)) usedIds.add(row.questionId);
            const slot = part + ':' + displayNumber;
            usedSlots.add(slot);
            if (!row.questionId && !hasKnownAnswers(row)) anonymousSlots.add(slot);
            nextByPart.set(part, Math.max(next, displayNumber + 1));
        }

        const combined = rows.map(({ row, id, kind, index }) => {
            const children = childrenById.get(id);
            if (children && row.questionId === id) {
                const expected = kind === 'drag' ? 'fill' : kind;
                const free = children.filter(child => !usedIds.has(child.id) && (!expected || child.qType === expected));
                const entry = free.find(child => child.childIndex === index) || (free.length === 1 ? free[0] : null);
                if (entry) {
                    row.questionId = entry.id;
                    usedIds.add(entry.id);
                }
            }
            const db = dbById.get(row.questionId);
            return !hasKnownAnswers(row) && db
                ? { ...renderStoredQuestion(db, row.displayNumber), domElement: row.domElement, part: row.part }
                : row;
        });
        for (const [id, slot] of roster) {
            if (usedIds.has(id)) continue;
            const { part } = slot;
            let number = slot.number + (offsets.get(part) || 0);
            if (anonymousSlots.has(part + ':' + number)) continue;
            while (usedSlots.has(part + ':' + number)) number++;
            usedSlots.add(part + ':' + number);
            const db = dbById.get(id);
            combined.push(db ? { ...renderStoredQuestion(db, number), part } :
                { uid: 'pending_' + id, questionId: id, displayNumber: number, part, renderedAnswers: [] });
        }
        return combined.sort((a, b) => a.displayNumber - b.displayNumber || (a.part || '').localeCompare(b.part || ''));
    }

    function ensureOverlayRoot() {
        if (overlayRoot) return overlayRoot;
        overlayRoot = document.createElement('div');
        overlayRoot.id = 'olm-helper-overlay';
        overlayRoot.style.cssText = 'position:fixed;inset:0;overflow:hidden;box-sizing:border-box;z-index:2147483646;pointer-events:none;' +
            'padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
        document.documentElement.appendChild(overlayRoot);
        return overlayRoot;
    }

    function viewportBounds() {
        const view = window.visualViewport;
        const root = ensureOverlayRoot();
        const origin = root.getBoundingClientRect();
        const scaleX = (root.offsetWidth && origin.width / root.offsetWidth) || 1;
        const scaleY = (root.offsetHeight && origin.height / root.offsetHeight) || 1;
        const style = getComputedStyle(root);
        const inset = side => parseFloat(style.getPropertyValue('padding-' + side)) || 0;
        return {
            origin, scaleX, scaleY,
            left: ((view?.offsetLeft ?? 0) - origin.left) / scaleX + inset('left'),
            top: ((view?.offsetTop ?? 0) - origin.top) / scaleY + inset('top'),
            width: Math.max(0, (view?.width || window.innerWidth) / scaleX - inset('left') - inset('right')),
            height: Math.max(0, (view?.height || window.innerHeight) / scaleY - inset('top') - inset('bottom'))
        };
    }

    function clampPosition(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }

    function positionPanelNearButton(panel, btn, view = viewportBounds()) {
        if (!panel || !btn || panel.hidden) return;
        const list = panel.querySelector('#olm-scroll-list');
        const gap = 5;
        const buttonTop = btn.offsetTop;
        const buttonBottom = buttonTop + btn.offsetHeight;
        panel.style.maxWidth = Math.max(0, view.width - gap * 2) + 'px';
        const headerHeight = panel.firstElementChild.offsetHeight + 8;
        const expanded = panel.dataset.expanded === '1';
        const targetListHeight = expanded ? 200 : 118;
        const above = Math.max(0, buttonTop - view.top - gap * 2);
        const below = Math.max(0, view.top + view.height - buttonBottom - gap * 2);
        const freeHeight = Math.max(0, view.height - headerHeight - gap * 2);
        const besideButton = Math.max(above, below) - headerHeight;
        list.style.maxHeight = Math.max(0, Math.min(freeHeight, targetListHeight,
            Math.max(Math.min(96, freeHeight), besideButton))) + 'px';
        const height = panel.offsetHeight;
        const top = above >= height || above >= below ? buttonTop - height - gap : buttonBottom + gap;
        panel.style.left = clampPosition(btn.offsetLeft + btn.offsetWidth - panel.offsetWidth,
            view.left + gap, view.left + view.width - panel.offsetWidth - gap) + 'px';
        panel.style.top = clampPosition(top, view.top + gap, view.top + view.height - height - gap) + 'px';
    }

    function ensurePanelCreated() {
        let panel = document.getElementById('olm-mini-panel');
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = 'olm-mini-panel';
        panel.hidden = true;
        panel.style.cssText = [
            'position: absolute',
            'pointer-events: auto',
            'left: 0',
            'top: 0',
            'z-index: 1',
            'width: 138px',
            'max-width: 88vw',
            'background: #ffffff',
            'color: #0f172a',
            'padding: 3px 4px',
            'border-radius: 10px',
            'box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18)',
            'border: 1px solid #cbd5e1',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'font-size: 11px',
            'line-height: 1.38',
            'box-sizing: border-box'
        ].join(';');

        const actionStyle = 'width:44px;height:44px;padding:0;border:0;background:transparent;color:#1d4ed8;font-size:15px;cursor:pointer;';
        panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<button id="olm-fetch-now-btn" type="button" aria-label="Nạp đáp án" title="Nạp đáp án" style="' + actionStyle + '">⚡</button>' +
            '<button id="olm-total-count" type="button" aria-pressed="false" title="Mở rộng bảng" ' +
            'aria-label="Mở rộng bảng" style="min-height:44px;min-width:36px;padding:0;border:0;background:transparent;' +
            'font-size:9px;color:#475569;text-align:center;cursor:pointer;">0 câu</button>' +
            '<button id="olm-jump-active-btn" type="button" hidden aria-label="Đến câu đang làm" style="' + actionStyle + '">🎯</button>' +
            '</div><div id="olm-scroll-list" style="max-height:118px;overflow:auto;overscroll-behavior:contain;' +
            '-webkit-overflow-scrolling:touch;padding-right:2px;"></div>';
        ensureOverlayRoot().appendChild(panel);

        const btnFetch = panel.querySelector('#olm-fetch-now-btn');
        if (btnFetch) {
            btnFetch.addEventListener('click', (e) => {
                e.stopPropagation();
                autoExtractAndFetchExamQuestions(true);
            });
        }

        const sizeButton = panel.querySelector('#olm-total-count');
        sizeButton.addEventListener('click', () => {
            const expanded = panel.dataset.expanded !== '1';
            panel.dataset.expanded = expanded ? '1' : '0';
            panel.style.width = expanded ? '240px' : '138px';
            sizeButton.setAttribute('aria-pressed', String(expanded));
            sizeButton.title = expanded ? 'Thu gọn bảng' : 'Mở rộng bảng';
            sizeButton.setAttribute('aria-label', sizeButton.title);
            positionPanelNearButton(panel, document.getElementById('olm-mini-btn'));
        });

        const scrollList = panel.querySelector('#olm-scroll-list');
        scrollList.addEventListener('scroll', () => {
            if (isPanelOpen) saveScrollPosition(scrollList.scrollTop);
        }, { passive: true });

        let touchY = null;
        scrollList.addEventListener('touchstart', event => {
            touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
        }, { passive: true });
        scrollList.addEventListener('touchmove', event => {
            if (touchY === null || event.touches.length !== 1) return;
            const y = event.touches[0].clientY;
            const delta = y - touchY;
            touchY = y;
            const top = scrollList.scrollTop <= 0;
            const bottom = scrollList.scrollTop + scrollList.clientHeight >= scrollList.scrollHeight - 1;
            if (event.cancelable && ((top && delta > 0) || (bottom && delta < 0))) event.preventDefault();
        }, { passive: false });

        return panel;
    }

    let renderedItems = [];
    let visibleItems = [];
    let observedRoots = [];
    let activeFrame = 0;
    let lastPanelHtml = '';
    const ignoredMutations = '#olm-helper-overlay, [role="timer"], .countdown, .timer, #count-down, #remain-down, [data-countdown]';
    const navSelector = '#question-static, .quiz-nav-item, .btn-question-number, .sheet-question-item, .tw-olm-chip-question';
    const sectionSelector = '[role="tab"], .nav-tabs, .tw-tabs, [role="tabpanel"], .tab-pane, [data-section]';
    const popupSelector = openChoiceMenus + ', .dropdown-menu, .qlib-opt_dropdown';
    let observedTargets = new Map();

    const discoveryObserver = new MutationObserver(records => {
        for (const record of records) {
            if (overlayRoot?.contains(record.target)) continue;
            for (const node of [...record.addedNodes, ...record.removedNodes]) {
                if (node.nodeType !== 1 || node.matches(ignoredMutations)) continue;
                if (node.matches(popupSelector) || node.querySelector(popupSelector)) queueActiveUpdate();
                if (node.matches(questionContainers + ', ' + sectionSelector) ||
                    node.querySelector(questionContainers + ', ' + sectionSelector)) {
                    queueRender();
                    return;
                }
            }
        }
    });

    const questionObserver = new MutationObserver(records => {
        for (const record of records) {
            const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            if (target?.closest(ignoredMutations)) continue;
            if (target?.closest(popupSelector + ', ' + navSelector)) {
                queueActiveUpdate();
                continue;
            }
            queueRender();
            return;
        }
    });

    function observeQuestions(roots) {
        const targets = new Map();
        const visibilityAttrs = ['class', 'hidden', 'aria-hidden', 'aria-selected', 'style'];
        const localAttrs = [...visibilityAttrs, 'aria-expanded', 'src', 'data-src', 'data-id-quiz', 'data-qid', 'data-question-id',
            'ind', 'data-ind', 'data-id', 'data-accept', 'data-accepts', 'data-correct'];
        const selector = questionContainers + ', ' + sectionSelector + ', ' + navSelector + ', ' + popupSelector;
        for (const root of roots) {
            if (root.host?.matches(questionContainers)) targets.set(root, true);
            for (const el of root.querySelectorAll(selector)) {
                const question = el.matches(questionContainers);
                if (!question || !el.parentElement?.closest(questionContainers)) targets.set(el, true);
                if (!question) continue;
                for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
                    if (node.matches(questionContainers)) break;
                    if (!targets.has(node)) targets.set(node, false);
                }
            }
        }
        const sameRoots = roots.length === observedRoots.length && roots.every((root, index) => root === observedRoots[index]);
        if (sameRoots && targets.size === observedTargets.size &&
            Array.from(targets).every(([node, local]) => observedTargets.get(node) === local)) return;

        discoveryObserver.disconnect();
        questionObserver.disconnect();
        observedRoots.forEach(root => root.removeEventListener('scroll', queueActiveUpdate, true));
        observedRoots = roots;
        observedTargets = targets;
        for (const root of roots) {
            discoveryObserver.observe(root, { subtree: true, childList: true });
            root.addEventListener('scroll', queueActiveUpdate, { capture: true, passive: true });
        }
        for (const [target, local] of targets) {
            questionObserver.observe(target, local ?
                { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: localAttrs } :
                { attributes: true, attributeFilter: visibilityAttrs });
        }
    }

    function queueActiveUpdate() {
        if (!isPanelOpen || activeFrame || document.hidden) return;
        activeFrame = requestAnimationFrame(() => {
            activeFrame = 0;
            positionInlineHints();
            updateActiveQuestion();
        });
    }

    function updateActiveQuestion() {
        if (!isPanelOpen) return;
        const list = document.getElementById('olm-scroll-list');
        const jump = document.getElementById('olm-jump-active-btn');
        const current = getActiveQuestion(visibleItems, observedRoots);
        const index = renderedItems.indexOf(current);
        const active = index < 0 ? null : list.children[index];
        const previous = list.querySelector('[data-active="1"]');
        if (previous !== active) {
            previous?.removeAttribute('data-active');
            if (previous) previous.style.background = '#f8fafc';
            if (active) {
                active.setAttribute('data-active', '1');
                active.style.background = '#eff6ff';
            }
        }
        jump.hidden = !active;
        if (active) {
            jump.title = 'Đến câu ' + current.displayNumber + (current.part ? ' · ' + current.part : '');
            jump.setAttribute('aria-label', jump.title);
            jump.onclick = () => {
                const offset = active.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
                list.scrollTo({ top: offset, behavior: 'smooth' });
            };
        }
    }

    function renderLockedLicensePanel(panel, list, count) {
        clearHighlights();
        observeQuestions([]);
        count.textContent = '🔒 Khóa';
        if (panel.dataset.expanded !== '1') {
            panel.dataset.expanded = '1';
            panel.style.width = '248px';
        }
        const detectedUser = detectOlmUsername() || licenseState.olmUsername || '';
        const savedLic = readSavedHelperLicense();
        const savedKey = savedLic?.key || '';
        const hwidShort = licenseState.hwid ? (licenseState.hwid.slice(0, 12) + '...' + licenseState.hwid.slice(-4)) : 'Đang tạo...';
        const renewUrl = resolveHelperApiOrigin();
        const lockHtml = '<div id="olm-license-gate" style="padding:6px;display:flex;flex-direction:column;gap:6px;font-size:11px;">' +
            '<div style="font-weight:700;color:#1e3a8a;font-size:12px;">🔒 Kích hoạt Key Tiện Ích</div>' +
            '<div style="color:#475569;font-size:10px;line-height:1.35;">1 Key dùng chung cho Tool &amp; Tiện ích, khóa theo tài khoản OLM + thiết bị này.</div>' +
            '<div style="background:#f1f5f9;padding:4px 6px;border-radius:6px;font-size:10px;color:#334155;">' +
            '<div>💻 <b>Máy:</b> ' + escapeHtml(licenseState.deviceName || detectDeviceName()) + '</div>' +
            '<div>🆔 <b>HWID:</b> <span style="font-family:monospace;">' + escapeHtml(hwidShort) + '</span></div>' +
            '</div>' +
            (detectedUser
                ? '<div style="font-size:10px;color:#0f172a;">👤 <b>Tài khoản OLM:</b> <code>' + escapeHtml(detectedUser) + '</code></div>'
                : '<input id="olm-lic-user" type="text" placeholder="Tên đăng nhập OLM (vd: hs_...)" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:16px;">') +
            '<input id="olm-lic-key" type="text" value="' + escapeHtml(savedKey) + '" placeholder="Nhập Key (OLM-30D-XXXX-YYYY)" autocapitalize="characters" spellcheck="false" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font-size:16px;font-family:monospace;font-weight:700;text-transform:uppercase;">' +
            (licenseState.error ? '<div id="olm-lic-err" style="color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:4px 6px;border-radius:6px;font-size:10px;">' + escapeHtml(licenseState.error) + '</div>' : '<div id="olm-lic-err" style="display:none;color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:4px 6px;border-radius:6px;font-size:10px;"></div>') +
            '<button id="olm-lic-submit" type="button" style="width:100%;min-height:44px;padding:8px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:700;font-size:12px;cursor:pointer;">Kích hoạt &amp; Lưu máy</button>' +
            (licenseState.offline ? '<button id="olm-lic-retry" type="button" style="width:100%;min-height:44px;padding:8px 10px;border:1px solid #94a3b8;border-radius:6px;background:#f8fafc;color:#0f172a;font-weight:700;font-size:12px;cursor:pointer;">🔄 Thử lại kết nối</button>' : '') +
            (savedKey ? '<div style="display:flex;gap:6px;align-items:center;">' +
                '<button id="olm-lic-change" type="button" style="flex:1;min-height:44px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#334155;font-weight:600;font-size:11px;cursor:pointer;">Đổi key</button>' +
                '<a href="' + escapeHtml(renewUrl) + '" target="_blank" rel="noopener noreferrer" style="flex:1;min-height:44px;display:flex;align-items:center;justify-content:center;padding:6px 8px;border:1px solid #bfdbfe;border-radius:6px;background:#eff6ff;color:#1d4ed8;font-weight:600;font-size:11px;text-decoration:none;text-align:center;">Gia hạn / Mua key</a>' +
                '</div>' : '') +
            '</div>';

        if (lastPanelHtml !== lockHtml) {
            list.innerHTML = lockHtml;
            lastPanelHtml = lockHtml;
            const btn = list.querySelector('#olm-lic-submit');
            const retryBtn = list.querySelector('#olm-lic-retry');
            const changeBtn = list.querySelector('#olm-lic-change');
            const keyEl = list.querySelector('#olm-lic-key');
            const userEl = list.querySelector('#olm-lic-user');
            const errEl = list.querySelector('#olm-lic-err');
            if (retryBtn) {
                retryBtn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    retryBtn.disabled = true;
                    retryBtn.textContent = 'Đang kết nối...';
                    const ok = await verifyHelperLicense(true);
                    lastPanelHtml = '';
                    renderShuffledAnswersIntoPanel();
                    if (ok) {
                        autoExtractAndFetchExamQuestions(true);
                        schedulePoll();
                    }
                });
            }
            if (changeBtn) {
                changeBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    saveHelperLicense(null);
                    licenseState.error = '';
                    licenseState.offline = false;
                    licenseState.license = null;
                    lastPanelHtml = '';
                    renderLockedLicensePanel(panel, list, count);
                    list.querySelector('#olm-lic-key')?.focus();
                });
            }
            if (btn) {
                btn.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    btn.disabled = true;
                    btn.textContent = 'Đang xác thực...';
                    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
                    const res = await activateHelperLicense(keyEl?.value || '', userEl?.value || '');
                    if (res.ok) {
                        lastPanelHtml = '';
                        renderShuffledAnswersIntoPanel();
                        autoExtractAndFetchExamQuestions(true);
                        schedulePoll();
                    } else {
                        btn.disabled = false;
                        btn.textContent = 'Kích hoạt & Lưu máy';
                        if (errEl) {
                            errEl.textContent = res.error || 'Kích hoạt thất bại.';
                            errEl.style.display = 'block';
                        }
                    }
                });
            }
        }
        positionPanelNearButton(panel, document.getElementById('olm-mini-btn'));
    }

    function renderShuffledAnswersIntoPanel() {
        if (!isPanelOpen) return;
        syncPage();
        const panel = ensurePanelCreated();
        const list = panel.querySelector('#olm-scroll-list');
        const count = panel.querySelector('#olm-total-count');
        if (!licenseState.valid) {
            renderLockedLicensePanel(panel, list, count);
            return;
        }
        const roots = getAllQuestionRoots();
        clearHighlights();
        const items = buildAnswersFromScreen(roots);
        observeQuestions(roots);
        positionInlineHints();
        visibleItems = items;
        renderedItems = items;
        const navNumbers = new Set();
        if (!questionIds.length && !renderedItems.some(item => item.section)) {
            for (const root of roots) {
                const chips = root.querySelectorAll('.quiz-nav-item, .btn-question-number, .sheet-question-item, .tw-olm-chip-question');
                for (const chip of chips) {
                    const number = chip.textContent.trim().match(/^(?:câu\s*)?(\d+)$/i)?.[1];
                    if (number) navNumbers.add(number);
                }
            }
        }
        const total = Math.max(items.length, questionIds.length, navNumbers.size);
        count.textContent = items.filter(hasKnownAnswers).length + '/' + total + ' câu';
        const html = renderedItems.map(item =>
            '<div style="margin-bottom:3px;padding:3px 4px;background:#f8fafc;border-radius:6px;border-left:3px solid #16a34a;">' +
            '<div style="font-weight:700;color:#15803d;">Câu ' + item.displayNumber +
            (item.part ? ' · ' + escapeHtml(item.part) : '') +
            (item.section ? ' · ' + escapeHtml(item.section.toUpperCase()) : '') +
            (item.originalOrder ? ' <small style="color:#475569;">(thứ tự gốc)</small>' : '') + '</div>' +
            (hasKnownAnswers(item) ? item.renderedAnswers.map(answer =>
                '<div style="padding:2px 0;overflow-wrap:anywhere;">' + answer.html + '</div>').join('') :
                '<div style="color:#64748b;">Chưa có dữ liệu đáp án</div>') +
            '</div>').join('');
        const lic = licenseState.license;
        const statusBarHtml = lic
            ? '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px;padding:4px 6px;background:#eff6ff;border:1px solid #dbeafe;border-radius:6px;font-size:10px;color:#1e3a8a;">' +
              '<div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              '<b>@' + escapeHtml(lic.olmUsername || licenseState.olmUsername || '') + '</b> · ' +
              escapeHtml(lic.remainingText || 'Đang hoạt động') +
              '</div>' +
              '<button id="olm-lic-change-btn" type="button" style="flex-shrink:0;padding:2px 6px;border:1px solid #93c5fd;border-radius:4px;background:#fff;color:#1d4ed8;font-size:10px;font-weight:600;cursor:pointer;">Đổi key</button>' +
              '</div>'
            : '';
        const nextHtml = statusBarHtml + (html || '<div style="color:#92400e;padding:8px;">' + (items.length ?
            'Đã nhận diện câu hỏi. Chưa có dữ liệu đáp án cho các câu này.' :
            'Chưa nhận diện được câu hỏi. Hãy mở bài hoặc bấm <b>Nạp đáp án</b>.') + '</div>');
        if (lastPanelHtml !== nextHtml) {
            list.innerHTML = nextHtml;
            lastPanelHtml = nextHtml;
            list.scrollTop = savedScrollTop;
            const changeBtn = list.querySelector('#olm-lic-change-btn');
            if (changeBtn) {
                changeBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    licenseState.valid = false;
                    licenseState.error = '';
                    lastPanelHtml = '';
                    renderShuffledAnswersIntoPanel();
                });
            }
        }
        positionPanelNearButton(panel, document.getElementById('olm-mini-btn'));
        updateActiveQuestion();
    }

    function togglePanel() {
        const panel = ensurePanelCreated();
        const button = document.getElementById('olm-mini-btn');
        isPanelOpen = !isPanelOpen;
        button.setAttribute('aria-expanded', String(isPanelOpen));
        panel.hidden = !isPanelOpen;
        if (isPanelOpen) {
            verifyHelperLicense(false).then((ok) => {
                renderShuffledAnswersIntoPanel();
                if (ok) {
                    autoExtractAndFetchExamQuestions();
                    schedulePoll();
                }
            });
        } else {
            clearHighlights();
            observeQuestions([]);
            clearTimeout(pollTimer);
            pollTimer = 0;
        }
    }

    function createDraggableButton() {
        if (document.getElementById('olm-mini-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'olm-mini-btn';
        btn.type = 'button';
        btn.title = 'Hiện hoặc ẩn gợi ý OLM';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-controls', 'olm-mini-panel');
        btn.setAttribute('aria-expanded', 'false');
        btn.style.cssText = 'position:absolute;left:0;top:0;z-index:2;box-sizing:border-box;width:44px;height:44px;' +
            'display:grid;place-items:center;background:transparent;border:0;padding:0;pointer-events:auto;' +
            'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;';
        const icon = document.createElement('span');
        icon.textContent = '💡';
        icon.style.cssText = 'display:grid;place-items:center;width:20px;height:20px;box-sizing:border-box;font-size:10px;' +
            'background:#fff;border:1px solid #cbd5e1;border-radius:50%;box-shadow:0 1px 4px #0003;pointer-events:none;';
        btn.appendChild(icon);
        ensureOverlayRoot().appendChild(btn);

        // Keep the anchor relative to the visual viewport, independent of page scrolling or zoom panning.
        let anchor = null;
        let drag = null;
        let suppressClick = false;
        let layoutFrame = 0;
        function layout() {
            const view = viewportBounds();
            const maxX = Math.max(0, view.width - btn.offsetWidth);
            const maxY = Math.max(0, view.height - btn.offsetHeight);
            btn.style.left = view.left + clampPosition(anchor?.x ?? maxX - 4, 0, maxX) + 'px';
            btn.style.top = view.top + clampPosition(anchor?.y ?? maxY - 10, 0, maxY) + 'px';
            positionPanelNearButton(document.getElementById('olm-mini-panel'), btn, view);
        }
        function queueLayout() {
            if (layoutFrame) return;
            layoutFrame = requestAnimationFrame(() => {
                layoutFrame = 0;
                layout();
                queueActiveUpdate();
            });
        }

        btn.addEventListener('pointerdown', event => {
            if (!event.isPrimary || event.button !== 0) return;
            const view = viewportBounds();
            drag = { id: event.pointerId, x: event.clientX, y: event.clientY,
                left: btn.offsetLeft - view.left, top: btn.offsetTop - view.top, scaleX: view.scaleX, scaleY: view.scaleY };
            suppressClick = false;
            try { btn.setPointerCapture?.(event.pointerId); } catch (e) {}
        });
        btn.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.id) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (!suppressClick && Math.hypot(dx, dy) < 6) return;
            suppressClick = true;
            anchor = { x: drag.left + dx / drag.scaleX, y: drag.top + dy / drag.scaleY };
            queueLayout();
        });
        const stopDrag = event => {
            if (drag?.id === event.pointerId) drag = null;
        };
        btn.addEventListener('pointerup', stopDrag);
        btn.addEventListener('pointercancel', stopDrag);
        btn.addEventListener('lostpointercapture', stopDrag);
        btn.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') suppressClick = false;
        });
        btn.addEventListener('click', event => {
            event.stopPropagation();
            if (suppressClick) return;
            togglePanel();
        });
        layout();
        window.addEventListener('resize', queueLayout, { passive: true });
        window.visualViewport?.addEventListener('resize', queueLayout, { passive: true });
        window.visualViewport?.addEventListener('scroll', queueLayout, { passive: true });
    }

    let pollTimer = 0;
    function schedulePoll() {
        if (pollTimer || document.hidden || !isPanelOpen) return;
        pollTimer = setTimeout(() => {
            pollTimer = 0;
            if (document.hidden) return;
            const revision = pageRevision;
            syncPage();
            if (revision !== pageRevision) queueRender();
            autoExtractAndFetchExamQuestions();
            schedulePoll();
        }, 1500);
    }

    let warmupTimer = 0;
    function scheduleWarmup() {
        if (warmupTimer || isPanelOpen || document.hidden) return;
        warmupTimer = setTimeout(() => {
            warmupTimer = 0;
            if (!isPanelOpen && !document.hidden) autoExtractAndFetchExamQuestions();
        }, 350);
    }

    function handleNavigation() {
        const revision = pageRevision;
        syncPage();
        if (revision === pageRevision) return;
        queueRender();
        scheduleWarmup();
    }

    function init() {
        createDraggableButton();
        ensurePanelCreated();
        for (const method of ['pushState', 'replaceState']) {
            const original = history[method];
            try {
                history[method] = function () {
                    const result = original.apply(this, arguments);
                    handleNavigation();
                    return result;
                };
            } catch (e) {}
        }
        window.addEventListener('popstate', handleNavigation);
        verifyHelperLicense(true).then((ok) => {
            if (ok) {
                if (document.readyState !== 'complete') window.addEventListener('load', scheduleWarmup, { once: true });
                scheduleWarmup();
            } else if (!detectOlmUsername()) {
                for (const delay of [600, 1500]) {
                    setTimeout(() => {
                        if (licenseState.valid) return;
                        const u = detectOlmUsername();
                        if (u) {
                            licenseState.olmUsername = u;
                            if (isPanelOpen) {
                                lastPanelHtml = '';
                                renderShuffledAnswersIntoPanel();
                            }
                        }
                    }, delay);
                }
            }
            if (isPanelOpen) renderShuffledAnswersIntoPanel();
        });
        let lastVisibilityVerifyAt = 0;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                clearTimeout(pollTimer);
                clearTimeout(warmupTimer);
                pollTimer = 0;
                warmupTimer = 0;
                return;
            }
            syncPage();
            const now = Date.now();
            if (now - lastVisibilityVerifyAt >= 60000) {
                lastVisibilityVerifyAt = now;
                verifyHelperLicense(false).then((ok) => {
                    queueRender();
                    if (ok) {
                        schedulePoll();
                        scheduleWarmup();
                    }
                });
            } else if (licenseState.valid) {
                queueRender();
                schedulePoll();
                scheduleWarmup();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
