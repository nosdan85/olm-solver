'use strict';

// Browser automation engine. Uses real DOM interaction (click / type with
// delays) rather than raw API calls, so the request pattern looks like a
// person working through the page.
//
// Puppeteer is an optional dependency: if it is not installed the server
// falls back to the plain HTTP client.

const { setTimeout: delay } = require('node:timers/promises');
const H = require('./humanize');
const extendedTypes = require('./extended-types');
const { cleanScienceText } = require('./science-normalizer');

let puppeteer;

function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  return puppeteer;
}

function isAvailable() {
  return loadPuppeteer() !== null;
}

async function launch() {
  const pptr = loadPuppeteer();
  if (!pptr) throw new Error('Puppeteer is not installed');

  const proxy = require('./proxy').parseProxy();

  const headless = String(process.env.PUPPETEER_HEADLESS || 'true').toLowerCase() !== 'false';
  const args = [
    ...(process.env.PUPPETEER_NO_SANDBOX === 'true' ? ['--no-sandbox'] : []),
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=vi-VN,vi',
    ...(proxy ? [`--proxy-server=${proxy.serverArg}`] : []),
  ];

  const opts = {
    headless,
    args,
    slowMo: Number(process.env.PUPPETEER_SLOWMO || 0),
    protocolTimeout: 300000,
  };
  const fs = require('fs');
  const chromeCandidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);

  for (const cPath of chromeCandidates) {
    if (fs.existsSync(cPath)) {
      opts.executablePath = cPath;
      break;
    }
  }

  return pptr.launch(opts);
}

async function guardOlmPage(page) {
  const { trustedOlmUrl } = require('./olm-client');
  const blockedTrackerHosts = /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|googleadservices\.com|adservice\.google\.com|facebook\.net|connect\.facebook\.net|analytics\.tiktok\.com|hotjar\.com|clarity\.ms|mixpanel\.com|segment\.io|sentry\.io|mc\.yandex\.ru|scorecardresearch\.com|quantserve\.com|criteo\.com|taboola\.com|outbrain\.com)$/i;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;
    const url = request.url();
    let allowed = false;
    try {
      trustedOlmUrl(url);
      allowed = true;
    } catch {
      const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      if (!mainNavigation) {
        try {
          const target = new URL(url);
          if (['data:', 'blob:', 'about:'].includes(target.protocol)) {
            allowed = true;
          } else if (['http:', 'https:'].includes(target.protocol)) {
            allowed = !blockedTrackerHosts.test(target.hostname);
          }
        } catch {
          allowed = false;
        }
      }
    }
    (allowed ? request.continue() : request.abort('blockedbyclient')).catch(() => {});
  });
}

// Login through the real form.
async function login(browser, { username, password, loginUrl = 'https://olm.vn/dangnhap', ua, log }) {
  const page = await browser.newPage();
  let success = false;
  try {
    await guardOlmPage(page);

  const proxy = require('./proxy').parseProxy();
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => { });
  }

  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(ua || H.pick(require('./olm-client').USER_AGENTS));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });

  let navErr = null;
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    navErr = err;
  }

  if (navErr) {
    const errMsg = navErr.message || '';
    await page.close().catch(() => { });
    if (/ERR_PROXY|proxy/i.test(errMsg)) {
      throw new Error('Lỗi kết nối Proxy (Proxy hiện không hoạt động hoặc bị từ chối kết nối). Vui lòng tắt Proxy trong cài đặt hoặc đổi Proxy mới.');
    }
    throw new Error(`Không thể kết nối đến trang đăng nhập OLM (${errMsg}). Vui lòng kiểm tra lại mạng.`);
  }

  // Wait up to 20s for login inputs to be rendered (allowing Cloudflare Turnstile or SPA scripts to mount)
  try {
    await page.waitForSelector('input#username, input[name="username"], input[type="password"]', {
      visible: true,
      timeout: 15000,
    });
  } catch {
    const title = await page.title().catch(() => '');
    if (log) log('info', `Waiting for login inputs timed out. Page title: "${title}", URL: "${page.url()}"`);

    // Check if Cloudflare Turnstile frame is present and attempt to click checkbox
    for (const frame of page.frames()) {
      try {
        const cfBox = await frame.$('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
        if (cfBox) {
          if (log) log('info', 'Found Cloudflare Turnstile checkbox, clicking...');
          await cfBox.click();
          await H.sleep(3000);
          break;
        }
      } catch { }
    }

    try {
      await page.waitForSelector('input#username, input[name="username"], input[type="password"]', {
        visible: true,
        timeout: 10000,
      });
    } catch { }
  }

  // Find the username/password inputs from the live DOM.
  const selectors = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const pw = inputs.find((i) => i.id === 'password' || i.name === 'password' || (i.type || '').toLowerCase() === 'password');
    const txt = inputs.find(
      (i) => i.id === 'username' || i.name === 'username' || (
        (i.type || '').toLowerCase() !== 'password' &&
        (i.type || '').toLowerCase() !== 'hidden' &&
        i.type !== 'checkbox' &&
        (i.offsetWidth > 0 || i.offsetHeight > 0)
      )
    );
    const select = input => {
      if (!input) return '';
      if (input.id) return 'input#' + CSS.escape(input.id);
      if (input.name) return 'input[name=' + CSS.escape(input.name) + ']';
      input.setAttribute('data-olm-login-field', input === pw ? 'password' : 'username');
      return 'input[data-olm-login-field=' + (input === pw ? 'password' : 'username') + ']';
    };
    return { username: select(txt), password: select(pw) };
  });

  if (!selectors.username || !selectors.password) {
    const pageTitle = await page.title().catch(() => '');
    const pageHtml = await page.content().catch(() => '');
    await page.close().catch(() => { });
    if (/just a moment|cloudflare|attention required/i.test(pageTitle + pageHtml)) {
      throw new Error('Cloudflare yêu cầu xác minh bảo mật từ máy chủ. Vui lòng thử lại sau.');
    }
    throw new Error('Không thể tìm thấy ô đăng nhập OLM trên trang web. Vui lòng thử lại.');
  }

  const uSel = selectors.username;
  const pSel = selectors.password;

  const box = await page.$(uSel);
  if (box) {
    const b = await box.boundingBox();
    if (b) await H.moveMouseSmooth(page, { x: b.x + 5, y: b.y + 5 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }
  await page.click(uSel, { delay: 60 });
  await page.keyboard.type(username, { delay: 40 });

  await page.click(pSel, { delay: 60 });
  await page.keyboard.type(password, { delay: 40 });

  await H.sleep(H.randInt(400, 800));

  // Click the real "Đăng nhập" button (.btn-submit)
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.btn-submit, button.btn-submit') ||
      Array.from(document.querySelectorAll('button, input[type=submit]')).find((b) =>
        /đăng nhập|dang nhap/i.test(b.innerText || b.value || '') && !/quên mật khẩu|forget/i.test(b.innerText || '')
      );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!clicked) {
    await page.click('button.btn-submit, .btn-submit, input[type=submit]').catch(() => { });
  }

  // Wait for redirect to dashboard, or cookies, or error alert
  try {
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.waitForFunction(() => {
        const modal = document.querySelector('.main-modal-v2-content, .swal2-html-container, .toast, .alert, .tw-text-danger, .text-danger');
        return !!(modal && modal.innerText.trim());
      }, { timeout: 15000 }),
    ]);
  } catch {
    /* OLM may update via SPA or show error alert */
  }

  await H.sleep(2000);

  const cookies = await page.browserContext().cookies();
  const currentUrl = page.url();
  const stillOnLogin = /dang-?nhap/i.test(currentUrl) || await page.evaluate(() => {
    return !!(document.querySelector('input[type="password"]') || /Tên đăng nhập hoặc mật khẩu|đăng nhập bằng/i.test(document.body?.innerText || ''));
  });

  if (stillOnLogin) {
    const errText = await page.evaluate(() => {
      const modal = document.querySelector('.main-modal-v2-content, .swal2-html-container, .toast, .alert, .tw-text-danger, .text-danger');
      if (modal && modal.innerText.trim()) {
        const text = modal.innerText.trim();
        const m = text.match(/Tên đăng nhập hoặc mật khẩu[^.\n]+[.\n]?|tài khoản[^.\n]+[.\n]?|mật khẩu không chính xác[^.\n]*[.\n]?/i);
        return m ? m[0].trim() : text;
      }
      const anyErr = Array.from(document.querySelectorAll('div, p, span')).find(el =>
        /không chính xác|sai mật khẩu|sai tên|tài khoản không tồn tại|bị khóa/i.test(el.innerText || '')
      );
      if (anyErr && anyErr.innerText.trim()) {
        const text = anyErr.innerText.trim();
        const m = text.match(/Tên đăng nhập hoặc mật khẩu[^.\n]+[.\n]?|tài khoản[^.\n]+[.\n]?|mật khẩu không chính xác[^.\n]*[.\n]?/i);
        return m ? m[0].trim() : text;
      }
      return null;
    });
    await page.close().catch(() => { });
    throw new Error(errText || 'Tên đăng nhập hoặc mật khẩu OLM không chính xác.');
  }

    if (log) log('info', `Browser login OK (${cookies.length} cookies)`);
    success = true;
    return { page, cookies };
  } finally {
    if (!success) await page.close().catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// OLM giao diện mới (đã bỏ Shadow DOM).
//
// Cấu trúc quan sát được trên trang thật:
//   div.box-list-static-question
//     div.itemx.q-view-itemx.question      <- 1 element = 1 câu
//       span.titlex                          <- "Câu 1  1đ"
//       div.card > div.card-body > div.box-static-content
//         <p> đề bài (KaTeX) ...
//         div.qselect[data-ind="0".."3"]     <- 1 option
//           span.qiradio                      <- vòng tròn radio
//           div.qsign                         <- nội dung đáp án
//
// Toàn bộ selector cũ (default-root, type-quiz-*, .tw-olm-chip-question,
// .question-content) đã không còn tồn tại. Các hàm dưới đây được inject vào
// page.evaluate, nên không dùng được biến ngoài closure.
// ---------------------------------------------------------------------------

// Chuẩn hoá text tiếng Việt để so khớp nhãn nút (bỏ dấu, gộp whitespace).
function normalizeVi(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

// Nhãn nút hành động theo câu (nộp từng câu) và nút chuyển câu.
const ACTION_SUBMIT_LABELS = ['nop cau', 'kiem tra dap an', 'tra loi', 'nop bai', 'xac nhan nop'];
const ACTION_NEXT_LABELS = ['cau tiep', 'tiep tuc', 'cau sau', 'lam tiep', 'next'];

// Script đọc trạng thái trang: dùng chung cho detector, solver list và solver
// sequential. Phải là một hàm tự chứa (serialize qua page.evaluate).
function inspectQuestionSurfaceScript() {
  const normalizeVi = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();

  const ACTION_SUBMIT_LABELS = ['nop cau', 'kiem tra dap an', 'tra loi', 'nop bai', 'xac nhan nop'];
  const ACTION_NEXT_LABELS = ['cau tiep', 'tiep tuc', 'cau sau', 'lam tiep', 'next'];

  const isVisible = (el) => {
    if (!el) return false;
    if (el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    return true;
  };

  const labelOf = (el) => normalizeVi(el.innerText || el.value || el.getAttribute('aria-label') || '');

  // Thu thập mọi node có thể là nút hành động trong document + open shadow roots.
  const collectRoots = () => {
    const roots = [document];
    const walk = (node, depth) => {
      if (depth > 6) return;
      const kids = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (const el of kids) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot, depth + 1); }
      }
    };
    walk(document, 0);
    return roots;
  };

  const roots = collectRoots();

  // Giao diện làm bài thật: default-root > div.previewquiz.prod >
  // type-quiz-x-mobile > shadowRoot > div#quiz-list chứa .qselect[ind].
  // Lưu ý: dùng attribute `ind` (khác với `data-ind` của màn xem trước).
  const quizHost = roots.map((r) => r.querySelector?.('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-under-line-mobile, type-under-line, type-fill-me-mobile, type-fill-me, type-true-false-mobile, type-true-fasle, type-true-false, type-drag-text, type-select-text-mobile, type-select-text, type-paragraph-mobile, type-paragraph')).find(Boolean) || null;
  const quizRoot = quizHost?.shadowRoot || null;

  const allActionCandidates = [];
  for (const root of roots) {
    const nodes = root.querySelectorAll('button, a[role="button"], a.btn, div[role="button"], input[type="submit"], [class*="btn-submit"], [class*="submit"]');
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      if (!label) continue;
      const isSubmit = ACTION_SUBMIT_LABELS.some((k) => label === k || label.startsWith(k));
      const isNext = ACTION_NEXT_LABELS.some((k) => label === k || label.startsWith(k));
      if (!isSubmit && !isNext) continue;
      allActionCandidates.push({
        kind: isSubmit ? 'submit' : 'next',
        label,
        cls: String(el.className || '').slice(0, 120),
        inItem: !!el.closest('.itemx.q-view-itemx.question'),
        itemIndex: (() => {
          const item = el.closest('.itemx.q-view-itemx.question');
          if (!item) return -1;
          const all = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question'));
          return all.indexOf(item);
        })(),
        visible: true,
      });
    }
  }

  let items = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question, .itemx, .tw-olm-question, .box-question, .card-question, .question-item'));
  if (!items.length) {
    items = Array.from(document.querySelectorAll('type-quiz-x, type-quiz-multi, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-under-line-mobile, type-under-line, type-fill-blank, type-fill-me-mobile, type-fill-me, type-true-false, type-true-false-mobile, type-drag-drop, type-drag-text, type-select-text-mobile, type-select-text, type-paragraph, type-paragraph-mobile, .previewquiz'));
  }
  const visibleItems = items.filter(isVisible);

  // Nhận diện các nút tác vụ trong Shadow DOM legacy mới: #btn-done và
  // nút ngoài shadow "Kiểm tra đáp án".
  // Nhận diện giao diện làm bài thật: câu hỏi nằm trong shadow root của
  // type-quiz-x-mobile; nút "Kiểm tra đáp án" nằm ngoài shadow root.
  if (quizRoot) {
    const done = roots.map((r) => r.querySelector?.('#btn-done')).find(Boolean) || null;
    const checkButton = Array.from(document.querySelectorAll('button, a[role="button"], a.btn, div[role="button"]'))
      .find((b) => isVisible(b) && labelOf(b) === 'kiem tra dap an');
    const action = checkButton || (done && isVisible(done) ? done : null);
    if (action) {
      allActionCandidates.push({
        kind: 'submit', label: labelOf(action) || 'btn-done',
        cls: String(action.className || ''), inItem: false, itemIndex: -1,
        visible: true, source: checkButton ? 'document' : 'shadow',
      });
    }

    const shadowQuestion = quizRoot.querySelector('.question-content, #question-content, #border-word, #link-list, #group-list, #paragraph') || quizRoot;
    const shadowOptions = Array.from(quizRoot.querySelectorAll('.qselect, [ind], [data-ind]'));
    shadowOptions.sort((a, b) => {
      const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
      const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
      if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
      if (Number.isFinite(ai)) return -1;
      if (Number.isFinite(bi)) return 1;
      return 0;
    });
    const shadowText = shadowQuestion ? (shadowQuestion.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const shadowOptionMeta = shadowOptions.map((el) => {
      const t = el.querySelector('.qsign, .content, .option-text, label')?.innerText || el.innerText || '';
      return { ind: el.getAttribute('ind') ?? el.getAttribute('data-ind'), text: String(t).replace(/\s+/g, ' ').trim() };
    }).filter((x) => x.text);

    const shadowQuestionInfo = {
      index: 0, title: '', stem: shadowText,
      optionCount: shadowOptionMeta.length,
      options: shadowOptionMeta.map((x) => x.text),
      optionIndices: shadowOptionMeta.map((x) => Number(x.ind)),
      hasInput: !!quizRoot.querySelector('input:not([type="checkbox"]), textarea'),
      hasTextarea: !!quizRoot.querySelector('textarea'),
      hasSelect: !!quizRoot.querySelector('select'),
      hasImage: !!quizRoot.querySelector('img:not(.emoji):not(.icon), canvas'),
      fingerprint: `${shadowText}||${shadowOptionMeta.map((x) => x.text).join('|')}`.slice(0, 400),
    };
    const bodyText = normalizeVi(document.body ? document.body.innerText : '');
    const resultEls = Array.from(document.querySelectorAll('.practice-result, .box-result, .box-score, .result-box, [class*="ket-qua"], .lst-result')).filter(isVisible);
    const navChips = Array.from(document.querySelectorAll('.tw-olm-chip-question, .q-nav-item, [data-question-nav], .chip-question, .question-chip, .box-number-question .item, .palette-item'))
      .filter((el) => !el.closest('.q-handle, #cate-pdf-container'));
    const omrHandles = document.querySelectorAll('.q-handle-fc, .q-handle-tf, .q-handle-dg, .q-handle-nrq, #cate-pdf-container .q-handle');
    const hasOmrPdf = omrHandles.length > 0 || (!!document.querySelector('#cate-pdf-container') && !!document.querySelector('#cate-pdf-container #question-list-container'));
    return {
      itemCount: items.length, visibleItemCount: 1, questions: [shadowQuestionInfo],
      actions: allActionCandidates, itemScopedActions: [], pageLevelActions: allActionCandidates,
      hasResult: resultEls.length > 0 || /ket qua|dang cham diem|ban da nop/.test(bodyText),
      chipCount: navChips.length,
      hasOmrPdf,
      omrCount: omrHandles.length,
      hasLegacyRoot: true, legacyQuizCount: 1, shadowQuestionCount: 1,
    };
  }

  // Mô tả 1 câu: stem, option, control — đều scope trong chính item đó.
  const readItem = (item, index) => {
    const titleEl = item.querySelector('.titlex');
    const contentEl = item.querySelector('.box-static-content') || item.querySelector('.card-body') || item;

    // Stem: clone content rồi bỏ phần option để không lẫn đáp án vào đề bài.
    const stemParts = [];
    if (contentEl) {
      const clone = contentEl.cloneNode(true);
      clone.querySelectorAll('.qselect, .qsign').forEach((n) => n.remove());
      const t = (clone.innerText || '').replace(/\s+/g, ' ').trim();
      if (t) stemParts.push(t);
    }
    const stem = stemParts.join(' ').trim();

    // Option: .qselect trong item, sort theo data-ind.
    const optionEls = Array.from(item.querySelectorAll('.qselect'));
    optionEls.sort((a, b) => {
      const ai = Number(a.getAttribute('data-ind'));
      const bi = Number(b.getAttribute('data-ind'));
      if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
      if (Number.isFinite(ai)) return -1;
      if (Number.isFinite(bi)) return 1;
      return 0;
    });

    const texOf = (el) => {
      const ann = el.querySelector('annotation[encoding="application/x-tex"]');
      if (ann && ann.textContent.trim()) return ann.textContent.trim();
      return null;
    };

    const options = optionEls.map((el) => {
      const sign = el.querySelector('.qsign') || el;
      const tex = texOf(sign);
      let t = tex || (sign.innerText || '');
      t = String(t).replace(/^[\s\xA0]+|[\s\xA0]+$/g, '');
      const stripped = t.replace(/^(?:[A-D][.):]|\([A-D]\))\s+/i, '').trim();
      return stripped || t.trim();
    }).filter(Boolean);

    const inputs = Array.from(item.querySelectorAll('input')).filter(isVisible);
    const textareas = Array.from(item.querySelectorAll('textarea')).filter(isVisible);
    const selects = Array.from(item.querySelectorAll('select')).filter(isVisible);

    return {
      index,
      title: titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim() : '',
      stem,
      optionCount: optionEls.length,
      options,
      hasInput: inputs.length > 0,
      hasTextarea: textareas.length > 0,
      hasSelect: selects.length > 0,
      hasImage: !!item.querySelector('img:not(.emoji):not(.icon), canvas'),
      // Fingerprint dùng để phát hiện "câu đã đổi" trong luồng sequential.
      fingerprint: `${stem}||${options.join('|')}`.slice(0, 400),
    };
  };

  const questionItems = visibleItems.map((el, i) => readItem(el, i));

  // Màn hình kết quả / đã nộp.
  const resultEls = Array.from(document.querySelectorAll('.practice-result, .box-result, .box-score, .result-box, [class*="ket-qua"], .lst-result'))
    .filter(isVisible);
  const bodyText = normalizeVi(document.body ? document.body.innerText : '');
  const navChips = Array.from(document.querySelectorAll('.tw-olm-chip-question, .q-nav-item, [data-question-nav], .chip-question, .question-chip, .box-number-question .item, .palette-item'))
    .filter((el) => !el.closest('.q-handle, #cate-pdf-container'));
  const omrHandles = document.querySelectorAll('.q-handle-fc, .q-handle-tf, .q-handle-dg, .q-handle-nrq, #cate-pdf-container .q-handle');
  const hasOmrPdf = omrHandles.length > 0 || (!!document.querySelector('#cate-pdf-container') && !!document.querySelector('#cate-pdf-container #question-list-container'));

  return {
    itemCount: items.length,
    visibleItemCount: visibleItems.length,
    questions: questionItems,
    actions: allActionCandidates,
    itemScopedActions: allActionCandidates.filter((a) => a.inItem),
    pageLevelActions: allActionCandidates.filter((a) => !a.inItem),
    hasResult: resultEls.length > 0 || /ket qua|dang cham diem|ban da nop/.test(bodyText),
    chipCount: navChips.length,
    hasOmrPdf,
    omrCount: omrHandles.length,
    hasLegacyRoot: !!document.querySelector('default-root'),
    legacyQuizCount: document.querySelectorAll('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-under-line-mobile, type-under-line, type-fill-me-mobile, type-fill-me, type-true-false-mobile, type-true-fasle, type-true-false, type-drag-text, type-select-text-mobile, type-select-text').length,
  };
}

// Gọi inspectQuestionSurfaceScript trên page và trả về snapshot.
async function inspectQuestionSurface(page) {
  return page.evaluate(inspectQuestionSurfaceScript);
}

// Phân loại bài theo DOM, KHÔNG theo URL.
//
// Ưu tiên tuyệt đối: omr-pdf -> chip -> nhiều item -> một item + nút hành động thuộc item.
// Điều kiện "nút hành động thuộc item" là điều kiện bắt buộc để kết luận
// sequential: một trang list đang mount có thể chỉ render 1 item, nếu suy ra
// sequential chỉ từ số item thì sẽ bấm nộp từng câu trên bài list.
function classifyMode(surface) {
  if (!surface) return { mode: 'unknown', reason: 'no-surface' };
  if (surface.hasOmrPdf || surface.omrCount > 0) {
    return { mode: 'omr-pdf', reason: `Đề thi PDF/Word kèm phiếu trả lời OMR (${surface.omrCount || 0} dòng)` };
  }
  if (surface.chipCount > 0) return { mode: 'chips', reason: 'chip-question' };
  if (surface.visibleItemCount >= 2) {
    const hasGlobalSubmit = surface.pageLevelActions.some((a) => a.kind === 'submit');
    const hasAnyAction = surface.actions.length > 0;
    // /chu-de/ thường mở bằng màn hình xem trước: tất cả câu và option được
    // render nhưng chưa có nút submit. Click option đầu tiên mới khởi tạo
    // giao diện làm bài thật (default-root + nút Kiểm tra đáp án).
    if (!hasGlobalSubmit && !hasAnyAction) {
      return { mode: 'preview', reason: `${surface.visibleItemCount} câu xem trước, chưa có nút thao tác` };
    }
    return { mode: 'list', reason: `${surface.visibleItemCount} câu hiển thị đồng thời` };
  }
  if (surface.visibleItemCount === 1) {
    const scoped = surface.itemScopedActions.filter((a) => a.kind === 'submit');
    if (scoped.length) {
      return { mode: 'sequential', reason: `1 câu + nút "${scoped[0].label}" thuộc câu` };
    }
    if (surface.pageLevelActions.some((a) => a.kind === 'submit') || surface.actions.some((a) => a.kind === 'submit')) {
      return { mode: 'flow', reason: '1 câu + nút nộp ở cấp trang' };
    }
    if (surface.hasLegacyRoot || surface.legacyQuizCount > 0) {
      return { mode: 'legacy', reason: '1 câu giao diện Shadow DOM' };
    }
    return { mode: 'unknown', reason: '1 câu hiển thị nhưng không có nút hành động thuộc câu' };
  }
  if (surface.pageLevelActions.some((a) => a.kind === 'submit') || surface.actions.some((a) => a.kind === 'submit')) {
    return { mode: 'flow', reason: 'nút nộp ở cấp trang' };
  }
  if (surface.hasLegacyRoot || surface.legacyQuizCount > 0) {
    return { mode: 'legacy', reason: 'giao diện Shadow DOM cũ' };
  }
  return { mode: 'unknown', reason: 'không khớp cấu trúc nào' };
}

// Chờ trạng thái trang chuyển, thay vì sleep cố định.
// next: hàm trả về snapshot mới. isSettled(snapshot): trạng thái đã đổi.
async function waitForTransition(page, before, isSettled, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await H.sleep(intervalMs);
    let now;
    try {
      now = await inspectQuestionSurface(page);
    } catch {
      continue;
    }
    if (isSettled(now, before)) return { ok: true, snapshot: now };
  }
  return { ok: false, snapshot: null };
}

// So khớp câu hỏi với payload đáp án decoded từ API dựa trên trọng số Stem + Options + Statements
function matchDirectAnswer(question, directAnswersList = [], directAnswersMap = new Map(), index = 0) {
  if (typeof directAnswersList === 'number') {
    [directAnswersList, directAnswersMap] = [directAnswersMap, index];
  }
  if (!question || !Array.isArray(directAnswersList)) return null;
  const id = String(question.olmId || '');
  if (id) {
    const byId = directAnswersMap instanceof Map ? directAnswersMap.get(id) : null;
    const found = String(byId?.id || '') === id ? byId : directAnswersList.find(item => String(item.id) === id);
    return found ? { ...found } : null;
  }

  const normalize = value => cleanScienceText(value).replace(/\s+/g, '');
  const stem = normalize(question.text || question.stem);
  if (stem) {
    const statements = (question.statements || []).map(normalize).filter(Boolean);
    const options = (question.options || []).map(normalize).filter(Boolean);
    const sameList = (a, b) => a.length === b.length && JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
    const stemMatches = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      return shorter.length >= 40 && (longer.startsWith(shorter) || longer.includes(shorter));
    };
    const matchesFilter = (requireExact) => directAnswersList.filter(item => {
      const itemStem = normalize(item.stem || item.text);
      if (requireExact ? stem !== itemStem : !stemMatches(stem, itemStem)) return false;
      if (question.type === 'true_false' || statements.length) {
        return statements.length > 0 && sameList(statements, (item.tfAnswers || []).map(row => normalize(row.text)));
      }
      if (options.length) return sameList(options, (item.options || []).map(normalize));
      return stem.length >= 5 && !question.hasImage && !item.tfAnswers?.length && !item.options?.length;
    });
    const exactMatches = matchesFilter(true);
    if (exactMatches.length === 1) return { ...exactMatches[0] };
    if (exactMatches.length > 1) return null;
    const fuzzyMatches = matchesFilter(false);
    return fuzzyMatches.length === 1 ? { ...fuzzyMatches[0] } : null;
  }

  // Fallback 3: Chỉ khi KHÔNG quét được nội dung stem/text (!stem && !id) và không bị xáo trộn câu hỏi
  if (
    !question.isShuffled &&
    (directAnswersList.length === 1 || question.allowIndexFallback === true) &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < directAnswersList.length
  ) {
    return { ...directAnswersList[index] };
  }

  return null;
}

/**
 * Đọc trực tiếp đáp án từ Live DOM / Web Components (Shadow DOM properties, dataset, window state)
 * Phục vụ trường hợp câu hỏi sinh động trên client hoặc ngoài gói get-question-of-ids
 */
async function extractLiveDomAnswer(page, index = 0) {
  return page.evaluate((idx) => {
    function getAllDeep(sel, root = document, depth = 0) {
      if (depth > 12) return [];
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch (e) { }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch (e) { }
        }
      }
      return Array.from(new Set(results));
    }

    const modernItems = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question'));
    const scopeRoot = modernItems[idx] || document.querySelector(`#user-test-${idx}`) || document;

    // 1. Kiểm tra Web Component properties (type-quiz-x, type-fill-me, type-true-false, type-drag-text, type-sort-list)
    const webComps = getAllDeep(
      'type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi, type-fill-me-mobile, type-fill-me, type-true-false-mobile, type-true-fasle, type-true-false, type-drag-text-mobile, type-drag-text, type-sort-list-mobile, type-sort-list, type-two-list, type-link-list',
      scopeRoot === document ? document : scopeRoot
    );
    for (const comp of webComps) {
      const compRoot = comp.shadowRoot || comp.renderRoot || comp;

      // 0a. type-sort-list-mobile: thẻ li.sortable-item[name="0..N-1"]
      if (/type-sort/i.test(comp.tagName)) {
        const sortLis = Array.from(compRoot.querySelectorAll('li.sortable-item[name]'));
        if (sortLis.length > 0) {
          const texts = sortLis
            .slice()
            .sort((a, b) => Number(a.getAttribute('name')) - Number(b.getAttribute('name')))
            .map((li) => (li.innerText || '').trim())
            .filter(Boolean);
          return {
            isSortList: true,
            qType: 5,
            sortItems: texts,
            correctTexts: texts,
            answer: texts.join(' -> '),
            source: 'live-dom-sort-list',
          };
        }
      }

      // 0b. type-drag-text-mobile: comp.answerCorrect = {"0":"0","1":"1",...}
      if (/type-drag-text/i.test(comp.tagName) && comp.answerCorrect && typeof comp.answerCorrect === 'object' && !Array.isArray(comp.answerCorrect)) {
        return {
          isDragText: true,
          qType: 3,
          dragAnswerMap: comp.answerCorrect,
          answer: JSON.stringify(comp.answerCorrect),
          source: 'live-dom-drag-text',
        };
      }

      // a. type-fill-me: AST của câu hỏi trong jsonQuestion_json có chứa đáp án ở thuộc tính content
      const compFillNodes = [];
      const walkFillNodes = (nodes) => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          if (n.type === 'fillme-input') compFillNodes.push(n);
          if (Array.isArray(n.children)) walkFillNodes(n.children);
        }
      };
      walkFillNodes(comp.jsonQuestion_json?.root?.children || comp.jsonQuestion?.root?.children || []);
      if (compFillNodes.length > 0) {
        const vals = compFillNodes
          .map((n) => n.content ? String(n.content).split('||')[0].split('|')[0].replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim() : '')
          .filter((v) => Boolean(v) && !/^@.*@$|@(?:p\.|Math\.)/.test(v));
        if (vals.length > 0) {
          return {
            correctIndex: -1,
            correctIndices: [],
            answer: vals[0],
            answers: vals,
            fillAnswers: vals,
            source: 'live-dom-fillme-ast',
          };
        }
      }

      // b. input[data-accept] hoặc data-ans
      const acceptInps = Array.from(compRoot.querySelectorAll('input[data-accept], input[data-accepts], input[data-ans]'));
      if (acceptInps.length > 0) {
        const vals = acceptInps
          .map((inp) => inp.getAttribute('data-accept') || inp.getAttribute('data-accepts') || inp.getAttribute('data-ans') || '')
          .map((v) => String(v).split('||')[0].split('|')[0].replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').trim())
          .filter((v) => Boolean(v) && !/^@.*@$|@(?:p\.|Math\.)/.test(v));
        if (vals.length > 0) {
          return {
            correctIndex: -1,
            correctIndices: [],
            answer: vals[0],
            answers: vals,
            fillAnswers: vals,
            source: 'live-dom-accept',
          };
        }
      }

      // c. Đúng/Sai: comp.answers, comp.data.answers, comp.jsonQuestion.data.answers
      const isTfComp = /true-false|true-fasle|tf-mobile/i.test(comp.tagName);
      const tfData = comp.answers ?? comp.data?.answers ?? comp.jsonQuestion?.data?.answers ?? comp.jsonQuestion?.answers;
      if (isTfComp && Array.isArray(tfData) && tfData.length > 0) {
        return {
          isTrueFalse: true,
          qType: 13,
          tfAnswers: tfData.map((v, i) => ({
            index: i,
            value: (v === 1 || v === true || v === '1' || v?.value === 1 || v?.answer === 'Đúng' || v?.isCorrect === true) ? 1 : 0,
          })),
          source: 'live-dom-tf-comp',
        };
      }

      // d. Kiểm tra thuộc tính right / answerCorrect trên LitElement / Custom Element
      const rightProp = comp.right ?? comp.correct ?? comp.answerCorrect ?? comp.data?.right ?? comp.data?.correct;
      if (rightProp !== undefined && rightProp !== null) {
        if (Array.isArray(rightProp)) {
          const rInds = rightProp.map(Number).filter((n) => Number.isInteger(n) && n >= 0);
          if (rInds.length > 0) {
            const opts = Array.from(compRoot.querySelectorAll('.qselect, [ind], [data-ind]'));
            const matchedOpts = opts.filter((o) => rInds.includes(Number(o.getAttribute('ind') ?? o.getAttribute('data-ind'))));
            const texts = matchedOpts.map((o) => (o.innerText || '').trim()).filter(Boolean);
            return {
              correctIndex: rInds[0],
              correctIndices: rInds,
              answer: texts.join('; '),
              correctTexts: texts,
              source: 'live-dom-prop-array',
            };
          }
        } else if (typeof rightProp !== 'object') {
          const rNum = Number(rightProp);
          if (Number.isInteger(rNum) && rNum >= 0) {
            const opts = Array.from(compRoot.querySelectorAll('.qselect, [ind], [data-ind]'));
            const matchedOpt = opts.find((o) => Number(o.getAttribute('ind') ?? o.getAttribute('data-ind')) === rNum) || opts[rNum];
            const text = matchedOpt ? (matchedOpt.innerText || '').trim() : '';
            return {
              correctIndex: rNum,
              correctIndices: [rNum],
              answer: text,
              source: 'live-dom-prop',
            };
          }
        }
      }

      // e. Pairs / Drag / Matching
      const pairsData = comp.pairs ?? comp.data?.pairs ?? comp.jsonQuestion?.data?.pairs ?? comp.mapping ?? comp.data?.mapping;
      if (Array.isArray(pairsData) && pairsData.length > 0) {
        return {
          pairs: pairsData,
          mapping: pairsData,
          source: 'live-dom-pairs',
        };
      }
    }

    // 2. Kiểm tra trực tiếp các thẻ input[data-accept] trên scopeRoot
    const directAccepts = getAllDeep('input[data-accept], input[data-accepts], input[data-ans]', scopeRoot);
    if (directAccepts.length > 0) {
      const vals = directAccepts
        .map((inp) => inp.getAttribute('data-accept') || inp.getAttribute('data-accepts') || inp.getAttribute('data-ans') || '')
        .map((v) => String(v).split('||')[0].split('|')[0].replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').trim())
        .filter((v) => Boolean(v) && !/^@.*@$|@(?:p\.|Math\.)/.test(v));
      if (vals.length > 0) {
        return {
          correctIndex: -1,
          correctIndices: [],
          answer: vals[0],
          answers: vals,
          fillAnswers: vals,
          source: 'live-dom-input',
        };
      }
    }

    // 3. Kiểm tra thẻ có class .correctAnswer hoặc [data-correct="1"] trong DOM
    const correctEls = getAllDeep('.qselect.correctAnswer, li.correctAnswer, [data-correct="1"], [correct="true"], [data-true="1"]', scopeRoot);
    if (correctEls.length > 0) {
      const inds = correctEls
        .map((el) => Number(el.getAttribute('ind') ?? el.getAttribute('data-ind')))
        .filter((n) => Number.isInteger(n) && n >= 0);
      const texts = correctEls.map((el) => (el.innerText || '').replace(/^#+\s*/, '').trim()).filter(Boolean);
      if (inds.length > 0 || texts.length > 0) {
        return {
          correctIndex: inds.length > 0 ? inds[0] : 0,
          correctIndices: inds,
          correctTexts: texts,
          correctText: texts.join('; '),
          answer: texts.join('; '),
          source: 'live-dom-class',
        };
      }
    }

    // 4. Kiểm tra window globals (data_exam, BASEEXAM, data_quiz)
    try {
      const curIdq = new URLSearchParams(location.search).get('idq');
      const allQuizzes = window.data_exam?.questions || window.data_exam?.list_quiz ||
        window.BASEEXAM?.questions || window.data_quiz || window.all_quizzes || [];
      if (Array.isArray(allQuizzes) && allQuizzes.length > 0) {
        const found = (curIdq ? allQuizzes.find(q => String(q.id) === String(curIdq)) : null) || allQuizzes[idx];
        if (found) {
          const rawAns = found.ans || found.correct || found.answer || found.right;
          if (rawAns !== undefined && rawAns !== null) {
            return {
              answer: typeof rawAns === 'string' ? rawAns : undefined,
              correctIndex: Number.isInteger(found.right) ? found.right : (Number.isInteger(found.correct) ? found.correct : -1),
              qType: found.type,
              options: found.options,
              source: 'window-data-exam',
            };
          }
        }
      }
    } catch {}

    return null;
  }, index).catch(() => null);
}

// Choose the same question for scan, screenshot and input filling.
function questionScopeScript(index) {
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible';
  const items = [...document.querySelectorAll('.itemx.q-view-itemx.question')];
  if (items[index] && visible(items[index])) return items[index];
  const examItem = document.querySelector(`#user-test-${index}, .quizx[data-id="${index}"]`);
  if (examItem && visible(examItem)) return examItem;
  const root = document.querySelector('default-root');
  if (root && (root.shadowRoot || visible(root))) return root;
  const questions = [...document.querySelectorAll('.question, .quizx.question-hold')]
    .filter(el => visible(el) && !el.parentElement?.closest('.question, .quizx.question-hold'));
  return questions[index] || (questions.length === 1 ? questions[0] : document.querySelector('.question-content'));
}

function shortInputsScript(scope) {
  const fields = [];
  function walk(root) {
    if (!root) return;
    if (root.shadowRoot) walk(root.shadowRoot);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      const mathField = el.matches('.mq-editable-field, .mathquill-editable') &&
        !el.parentElement?.closest('.mq-editable-field, .mathquill-editable');
      const textField = el.matches('input:not([type]), input[type="text"], input[type="number"], textarea, [contenteditable="true"]') &&
        !el.closest('.mq-editable-field, .mathquill-editable');
      if ((mathField || textField) &&
          !el.disabled && !el.readOnly && el.getClientRects().length && getComputedStyle(el).visibility === 'visible' &&
          !/otp|search|password|email|consult|phone/i.test((el.name || '') + ' ' + el.id)) fields.push(el);
    }
  }
  walk(scope);
  return fields;
}

async function fillShortAnswer(page, question, answer) {
  const scope = await page.evaluateHandle(questionScopeScript, question.index || 0);
  try {
    if (!scope.asElement()) return { ok: false, reason: 'short-answer-scope-missing' };
    const values = Array.isArray(answer.fillAnswers) && answer.fillAnswers.length
      ? answer.fillAnswers.map(value => String(value ?? '').trim())
      : [String(answer.answer ?? answer.correctText ?? '').trim()];
    const handles = await page.evaluateHandle(shortInputsScript, scope);
    try {
      const fields = [...(await handles.getProperties()).values()].map(handle => handle.asElement()).filter(Boolean);
      try {
        if (!fields.length || fields.length !== values.length || values.some(value => !value)) {
          return { ok: false, reason: 'short-answer-count-mismatch' };
        }
        for (const [i, field] of fields.entries()) {
          const entered = await field.evaluate((el, value) => {
            if (el.matches('.mq-editable-field, .mathquill-editable')) {
              const mq = window.MathQuill?.getInterface?.(2) || window.MQ;
              const input = typeof mq === 'function' ? mq(el) : mq?.MathField?.(el);
              if (typeof input?.latex !== 'function') return false;
              const latex = value.replace(/^\$+|\$+$/g, '');
              input.latex(latex);
              el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
              return input.latex().replace(/\s+/g, '') === latex.replace(/\s+/g, '');
            }
            if (el.type === 'number' && /^-?\d+,\d+$/.test(value)) value = value.replace(',', '.');
            el.focus();
            if (el.isContentEditable) {
              el.textContent = value;
            } else {
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
            }
            // Đồng bộ trực tiếp vào LitElement model (type-fill-me / type-fill-me-mobile)
            const hostWc = el.getRootNode()?.host;
            if (hostWc && typeof hostWc.onChange === 'function') {
              try { hostWc.onChange({ currentTarget: el, target: el }); } catch {}
            }
            if (hostWc) {
              const indKey = el.getAttribute('ind') ?? el.getAttribute('data-ind') ?? String(i);
              hostWc.userAnswer = Object.assign({}, hostWc.userAnswer || {}, { [indKey]: value });
              if (typeof hostWc.requestUpdate === 'function') {
                try { hostWc.requestUpdate(); } catch {}
              }
            }
            el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, composed: true }));
            el.blur();
            return (el.isContentEditable ? el.textContent : el.value) === value;
          }, values[i]);
          if (!entered) return { ok: false, reason: 'short-answer-rejected' };
        }
        return { ok: true, method: 'short-answer', text: values.join(' | ') };
      } finally {
        await Promise.all(fields.map(field => field.dispose()));
      }
    } finally {
      await handles.dispose();
    }
  } finally {
    await scope.dispose();
  }
}

async function scanCurrentQuestion(page, index, subject, log) {
  const data = await page.evaluate((idx) => {
    function parseMathMLNodeDOM(node) {
      if (!node) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      const tag = (node.tagName || '').toLowerCase().replace(/^m:/, '');
      if (tag === 'annotation') return '';
      const children = Array.from(node.childNodes || []).filter(
        (c) => c.nodeType === 1 || (c.nodeType === 3 && (c.nodeValue || '').trim() !== '')
      );
      const elemChildren = Array.from(node.children || []);
      if (tag === 'mfrac' && elemChildren.length >= 2) {
        return `(${parseMathMLNodeDOM(elemChildren[0]).trim()})/(${parseMathMLNodeDOM(elemChildren[1]).trim()})`;
      }
      if (tag === 'msup' && elemChildren.length >= 2) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()}^(${parseMathMLNodeDOM(elemChildren[1]).trim()})`;
      }
      if (tag === 'msub' && elemChildren.length >= 2) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()})_(${parseMathMLNodeDOM(elemChildren[1]).trim()})`.replace(')_', '_');
      }
      if (tag === 'msubsup' && elemChildren.length >= 3) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()}_(${parseMathMLNodeDOM(elemChildren[1]).trim()})^(${parseMathMLNodeDOM(elemChildren[2]).trim()})`;
      }
      if (tag === 'msqrt') {
        return `√(${children.map(parseMathMLNodeDOM).join('').trim()})`;
      }
      if (tag === 'mroot' && elemChildren.length >= 2) {
        const base = parseMathMLNodeDOM(elemChildren[0]).trim();
        const rIdx = parseMathMLNodeDOM(elemChildren[1]).trim();
        return rIdx === '3' ? `∛(${base})` : `√[${rIdx}](${base})`;
      }
      return children.map(parseMathMLNodeDOM).join('');
    }

    function normalizeMathDOM(rootEl) {
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
      rootEl.querySelectorAll('.katex, .MathJax, mjx-container').forEach((k) => {
        const tex =
          k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ||
          k.querySelector('math')?.getAttribute('alttext') ||
          k.getAttribute('data-latex') ||
          k.getAttribute('alttext') ||
          '';
        if (tex) {
          k.replaceWith(document.createTextNode(' $' + tex + '$ '));
          return;
        }
        const mathEl = k.querySelector('.katex-mathml math, math');
        if (mathEl && mathEl.querySelector('mfrac, msup, msub, msubsup, msqrt, mroot')) {
          const parsedMml = parseMathMLNodeDOM(mathEl).trim();
          if (parsedMml) {
            k.replaceWith(document.createTextNode(' ' + parsedMml + ' '));
            return;
          }
        }
        k.querySelectorAll('.katex-mathml, mjx-assistive-mml, .MJX_Assistive_MathML').forEach((m) => m.remove());
        const khtml = k.querySelector('.katex-html') || k;
        Array.from(khtml.querySelectorAll('.sqrt')).reverse().forEach((sq) => {
          const rootIdx = sq.querySelector('.root')?.textContent?.trim() || '';
          const vlist = sq.querySelector('.vlist-t .vlist');
          let rad = '';
          if (vlist && vlist.children.length > 0) rad = vlist.children[0].textContent?.trim() || '';
          else {
            const cloneSq = sq.cloneNode(true);
            cloneSq.querySelectorAll('.root, .sqrt-sign, svg').forEach((n) => n.remove());
            rad = cloneSq.textContent?.trim() || '';
          }
          sq.replaceWith(document.createTextNode(rootIdx ? (rootIdx === '3' ? `∛(${rad})` : `√[${rootIdx}](${rad})`) : `√(${rad})`));
        });
        Array.from(khtml.querySelectorAll('.msupsub')).reverse().forEach((ss) => {
          const vlist = ss.querySelector('.vlist-t .vlist');
          if (vlist && vlist.children.length > 0) {
            const parts = [];
            Array.from(vlist.children).forEach((ch) => {
              const txt = (ch.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
              if (!txt) return;
              const topMatch = (ch.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
              const topVal = topMatch ? parseFloat(topMatch[1]) : -3.0;
              if (topVal < -2.75) parts.push(/^[°∘o0]$/.test(txt) ? '°' : `^(${txt})`);
              else parts.push(`_(${txt})`);
            });
            if (parts.length > 0) {
              ss.replaceWith(document.createTextNode(parts.join('')));
              return;
            }
          }
          const rawSs = (ss.textContent || '').trim();
          if (rawSs) ss.replaceWith(document.createTextNode(`^(${rawSs})`));
        });
        Array.from(khtml.querySelectorAll('.mfrac')).reverse().forEach((mf) => {
          const vlist = mf.querySelector('.vlist-t .vlist');
          if (vlist && vlist.children.length >= 2) {
            const children = Array.from(vlist.children);
            const lineIdx = children.findIndex((c) => c.querySelector('.frac-line') || c.classList?.contains('frac-line'));
            let num = '';
            let den = '';
            if (lineIdx > 0 && lineIdx < children.length - 1) {
              den = children.slice(0, lineIdx).map((c) => c.textContent.trim()).filter(Boolean).join('');
              num = children.slice(lineIdx + 1).map((c) => c.textContent.trim()).filter(Boolean).join('');
            } else {
              const nonLine = children.filter((c) => !c.querySelector('.frac-line') && !c.classList?.contains('frac-line'));
              if (nonLine.length >= 2) {
                const withTop = nonLine.map((c, i) => {
                  const m = (c.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
                  return { el: c, top: m ? parseFloat(m[1]) : -i };
                });
                withTop.sort((a, b) => a.top - b.top);
                num = withTop[0].el.textContent.trim();
                den = withTop[withTop.length - 1].el.textContent.trim();
              }
            }
            if (num || den) mf.replaceWith(document.createTextNode(` (${num})/(${den}) `));
          }
        });
      });
      Array.from(rootEl.querySelectorAll('sup')).reverse().forEach((sup) => {
        const txt = (sup.textContent || '').trim();
        if (!txt) { sup.remove(); return; }
        const nextTxt = sup.nextSibling?.textContent || '';
        if (/^[°∘o0]$/.test(txt) && (/^[CFK]\b/i.test(nextTxt.trim()) || txt === '°' || txt === '∘')) sup.replaceWith(document.createTextNode('°'));
        else sup.replaceWith(document.createTextNode(`^(${txt})`));
      });
      Array.from(rootEl.querySelectorAll('sub')).reverse().forEach((sub) => {
        const txt = (sub.textContent || '').trim();
        if (!txt) { sub.remove(); return; }
        sub.replaceWith(document.createTextNode(`_(${txt})`));
      });
      return rootEl;
    }

    // Hàm trích xuất text sạch chống lặp chữ KaTeX và hỗ trợ Media-only prompts (Audio/Image)
    function extractStemText(el) {
      if (!el) return '';
      let clone;
      if (el.nodeType === 11 || (typeof ShadowRoot !== 'undefined' && el instanceof ShadowRoot)) {
        clone = document.createElement('div');
        clone.innerHTML = el.innerHTML || '';
      } else {
        clone = el.cloneNode(true);
      }
      clone.querySelectorAll('table').forEach((t) => {
        if (t.querySelector('.tf-box, [data-tf-value], .qiradio, input[type="radio"]')) t.remove();
      });
      clone.querySelectorAll('.qselect, .qsign, .choice-item, .option, .answer-item, .quiz-option, .tf-row, .tf-box, .exp, .explanation, .giai-chi-tiet, .loigiai, .emoji, .icon, svg, script, style').forEach((n) => n.remove());
      normalizeMathDOM(clone);

      const audio = clone.querySelector('audio source, audio');
      const audioSrc = audio?.src || audio?.getAttribute('src') || '';
      const img = clone.querySelector('img:not(.emoji):not(.icon)');
      const imgSrc = img?.src || img?.getAttribute('src') || '';

      let text = (clone.innerText || clone.textContent || '')
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/\s*=/g, '≠')
        .replace(/\s+/g, ' ')
        .replace(/(?:trả lời|tra loi|bài làm|bai lam)[\s:]*$/i, '')
        .trim();
      if (!text && audioSrc) text = `[Audio prompt: ${audioSrc}]`;
      if (!text && imgSrc) text = `[Image prompt: ${imgSrc}]`;
      return text;
    }

    function extractOptionText(el) {
      if (!el) return '';
      const sign = el.querySelector('.qsign, .content, .option-text, label') || el;
      const clone = sign.cloneNode(true);
      normalizeMathDOM(clone);
      clone.querySelectorAll('script, style, svg').forEach((n) => n.remove());
      let t = (clone.innerText || clone.textContent || '')
        .replace(/[\uE000-\uF8FF]/g, '')
        .replace(/\s*=/g, '≠')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\u200B\xA0]+|[\s\u200B\xA0]+$/g, '');
      const stripped = t.replace(/^(?:[A-D][.):]|\([A-D]\))\s+/i, '').trim();
      if (!stripped && !t) {
        const img = sign.querySelector('img:not(.emoji):not(.icon)');
        if (img) return `[Hình ảnh: ${img.getAttribute('src') || img.src || 'option'}]`;
      }
      return stripped || t;
    }

    function getAllDeepScan(sel, rootNode = document, depth = 0) {
      if (depth > 12) return [];
      const results = [];
      try { results.push(...Array.from(rootNode.querySelectorAll(sel))); } catch (e) {}
      const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeepScan(sel, n.shadowRoot, depth + 1)); } catch (e) {}
        }
      }
      return Array.from(new Set(results));
    }

    function extractReactQuestionId(startEl, allowUrlIdq = true) {
      if (allowUrlIdq) {
        try {
          const urlIdq = new URLSearchParams(window.location.search).get('idq');
          if (urlIdq && /^\d{5,}$/.test(String(urlIdq))) return String(urlIdq);
        } catch (e) {}
      }
      const defRootSr = document.querySelector('default-root')?.shadowRoot;
      const activeWc = defRootSr?.querySelector('type-mix, type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi, type-fill-me-mobile, type-fill-me, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-link-list, type-under-line-mobile, type-under-line, type-true-false-mobile, type-true-fasle, type-true-false, type-drag-text, type-select-text-mobile, type-select-text, type-paragraph-mobile, type-paragraph');
      const candidates = [activeWc, startEl, document.querySelector('.question-content, #paragraph, .question, .box-question')].filter(Boolean);
      for (const el of candidates) {
        const hostEl = el?.getRootNode?.()?.host || el;
        const wcId = hostEl?.jsonQuestion?.id || hostEl?.data?.id || el?.jsonQuestion?.id || el?.data?.id;
        if (wcId && /^\d{5,}$/.test(String(wcId))) return String(wcId);
        const attrId = el.getAttribute?.('data-id-quiz') || el.getAttribute?.('data-qid') || el.closest?.('[data-id-quiz]')?.getAttribute('data-id-quiz');
        if (attrId && /^\d{5,}$/.test(String(attrId))) return String(attrId);
        let curr = el;
        for (let depth = 0; depth < 8 && curr; depth++) {
          const fiberKey = Object.keys(curr).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
          if (fiberKey && curr[fiberKey]) {
            let f = curr[fiberKey];
            for (let fDepth = 0; fDepth < 12 && f; fDepth++) {
              const p = f.memoizedProps || f.pendingProps;
              if (p && typeof p === 'object') {
                const qid = p.question?.id || p.data?.id || p.quiz?.id || p.item?.id || p.id_quiz || p.questionId;
                if (qid && /^\d{5,}$/.test(String(qid))) return String(qid);
              }
              f = f.return;
            }
          }
          curr = curr.parentElement;
        }
      }
      return null;
    }

    // Ưu tiên layout OLM mới: tất cả câu được render cùng lúc và phải scope
    // đúng item theo index. Không được fallback document-wide ở nhánh này.
    const modernItems = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question'));
    const modernQuestion = modernItems[idx];
    if (modernQuestion) {
      const content = modernQuestion.querySelector('.box-static-content, .card-body') || modernQuestion;
      const stem = extractStemText(content);
      const optionEls = Array.from(modernQuestion.querySelectorAll('.qselect'));
      optionEls.sort((a, b) => {
        const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
        const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        return 0;
      });
      const options = optionEls.map((el, i) => extractOptionText(el) || '[Phương án ' + (i + 1) + ']');
      const hasInput = !!modernQuestion.querySelector('input, textarea, select');
      const hasImage = !!modernQuestion.querySelector('img:not(.emoji):not(.icon), canvas') ||
        Array.from(modernQuestion.querySelectorAll('svg')).some((svg) => {
          const rect = svg.getBoundingClientRect();
          return rect.width > 50 && rect.height > 50;
        });
      return {
        type: options.length ? 'choice' : (hasInput ? 'short_answer' : 'choice'),
        olmId: extractReactQuestionId(modernQuestion, false),
        text: stem,
        options,
        hasImage,
      };
    }

    const defRoot = document.querySelector('default-root');
    const baseRoot = defRoot?.shadowRoot || defRoot || document;
    const typeMixHost = baseRoot.querySelector('type-mix');
    const root = typeMixHost?.shadowRoot || typeMixHost || baseRoot;

    // 0. Compound <type-mix> (chứa nhiều <type-quiz-x-mobile> hoặc bảng Đúng/Sai .tf-row / [data-tf-value])
    if (typeMixHost) {
      const mixTfRows = getAllDeepScan('tr, .tf-row', root).filter((r) => r.querySelector('.tf-box, [data-tf-value]'));
      if (mixTfRows.length > 0) {
        const rows = mixTfRows
          .map((row) => {
            const td = row.querySelector('td:not(.tf-box)') || row;
            return extractOptionText(td).replace(/(?:^|\s)[a-d][\)\.]\s*/i, '').replace(/[ĐS\s]+$/, '').trim();
          })
          .filter(Boolean);
        return {
          type: 'true_false',
          olmId: extractReactQuestionId(typeMixHost),
          text: extractStemText(root) || rows[0] || 'Câu hỏi Đúng/Sai',
          statements: rows,
          options: [],
        };
      }
      const mixQSelects = getAllDeepScan('.qselect', root).filter((el) => !el.hasAttribute('data-tf-value'));
      if (mixQSelects.length > 0) {
        const options = mixQSelects.slice(0, 16).map((el) => extractOptionText(el)).filter(Boolean);
        return {
          type: 'choice',
          olmId: extractReactQuestionId(typeMixHost),
          text: extractStemText(root) || options[0] || 'Câu hỏi trắc nghiệm tổ hợp',
          options,
        };
      }
    }

    // 0a. Modern Link-List / Matching (<type-link-list>)
    const linkListComp = root.querySelector('type-link-list')?.shadowRoot || root.querySelector('type-link-list');
    if (linkListComp) {
      const stem = extractStemText(linkListComp) || 'Match the words with the definitions.';
      return {
        type: 'matching',
        text: stem,
        options: []
      };
    }

    // 0b. Modern Drag-Text (<type-drag-text>)
    const dragTextComp = root.querySelector('type-drag-text')?.shadowRoot || root.querySelector('type-drag-text');
    if (dragTextComp) {
      const stem = extractStemText(dragTextComp) || 'Complete the sentences using the words and phrases given.';
      return {
        type: 'drag_text',
        text: stem,
        options: []
      };
    }

    // OLM practice mới: default-root > type-quiz-x-mobile > shadowRoot.
    // Câu nằm trong .question-content, option là .qselect[ind].
    const quizHost = root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi');
    const quiz = quizHost?.shadowRoot || quizHost;
    if (quiz) {
      const content = quiz.querySelector('.question-content, #question-content, #paragraph') || quiz;
      const text = extractStemText(content);
      let optionEls = Array.from(quiz.querySelectorAll('.qselect, [ind], [data-ind]')).filter(
        (el) => !el.closest('.exp, .explanation, .giai-chi-tiet, .loigiai')
      );
      const visOptionEls = optionEls.filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      if (visOptionEls.length >= 2) optionEls = visOptionEls;
      optionEls.sort((a, b) => {
        const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
        const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        if (Number.isFinite(ai)) return -1;
        if (Number.isFinite(bi)) return 1;
        return 0;
      });
      const options = optionEls.map((el, i) => extractOptionText(el) || '[Phương án ' + (i + 1) + ']');
      if (text || options.length) {
        const hasTfBox = !!quiz.querySelector('.tf-box, [data-tf-value], tr.tf-row');
        const isMultiQuizTag = /type-quiz-multi/i.test(quizHost?.tagName || '');
        const hasCheckbox = !!quiz.querySelector('.qcheckbox, input[type="checkbox"]');
        const isMulti = isMultiQuizTag || hasCheckbox;

        let qType = 'choice';
        if (hasTfBox) qType = 'true_false';
        else if (isMulti) qType = 'multi_choice';
        else if (options.length) qType = 'choice';
        else if (quiz.querySelector('input, textarea, select')) qType = 'short_answer';

        return {
          type: qType,
          olmId: extractReactQuestionId(quizHost || content),
          text,
          options,
          statements: hasTfBox ? options : undefined,
          hasImage: !!quiz.querySelector('img:not(.emoji):not(.icon), canvas'),
        };
      }
    }

    // 1. Fill-in-the-blank / Short answer (<type-fill-me-mobile>, <type-fill-me>)
    const fillMe = root.querySelector('type-fill-me-mobile, type-fill-me')?.shadowRoot ||
      root.querySelector('type-fill-me-mobile, type-fill-me');
    if (fillMe) {
      const p = fillMe.querySelector('#fillme-input, .question-content') || fillMe;
      let text = extractStemText(p);
      text = text.replace(/Bài làm[\s\S]*$/i, '').trim();
      return {
        type: 'short_answer',
        olmId: extractReactQuestionId(p),
        text,
        options: []
      };
    }

    // 2. Essay / Paragraph (<type-paragraph-mobile>, <type-paragraph>)
    const typePara = root.querySelector('type-paragraph-mobile, type-paragraph')?.shadowRoot ||
      root.querySelector('type-paragraph-mobile, type-paragraph');
    if (typePara) {
      const p = typePara.querySelector('#paragraph, .question-content') || typePara;
      let text = extractStemText(p);
      text = text.replace(/Bài làm[\s\S]*$/i, '').trim();
      return {
        type: 'short_answer',
        olmId: extractReactQuestionId(p),
        text,
        options: []
      };
    }

    // 3. True / False table (<type-true-false-mobile>, <type-true-fasle>, <type-tf-mobile> hoặc bảng .tf-box / [data-tf-value])
    const tf = root.querySelector('type-true-false-mobile, type-true-fasle, type-tf-mobile, type-true-false')?.shadowRoot ||
      root.querySelector('type-true-false-mobile, type-true-fasle, type-tf-mobile, type-true-false');
    const tfRowsInDom = Array.from(root.querySelectorAll('tr, .tf-row')).filter((r) => r.querySelector('.tf-box, [data-tf-value], input[type="radio"]'));
    if (tf || tfRowsInDom.length > 0) {
      const content = (tf ? tf.querySelector('.question-content, #paragraph, .question') || tf : null) ||
        root.querySelector('.question-content, #paragraph, .question') || root;
      const rawRows = tf ? Array.from(tf.querySelectorAll('.tf-row, tr, [class*="statement"]')).filter((r) => !r.querySelector('th')) : tfRowsInDom;
      const rows = rawRows
        .map((row) => extractOptionText(row)
          .replace(/^(?:câu|ý|mệnh đề)?\s*[a-d][\)\.\:]\s*/i, '')
          .replace(/\b(?:đúng|sai)\s+(?:đúng|sai)\s*$/i, '')
          .replace(/[ĐS\s]+$/, '')
          .trim())
        .filter((t) => t && !/^(?:mệnh đề|nội dung| phát biểu|đúng\s*sai)$/i.test(t));
      return {
        type: 'true_false',
        olmId: extractReactQuestionId(content),
        text: extractStemText(content),
        statements: rows,
        options: []
      };
    }

    // 4. Multi-choice / "Chọn những câu đúng" (<type-quiz-multi-mobile>, <type-quiz-multi>, or type-quiz-x with true/false statement prompt)
    const multiQuiz = root.querySelector('type-quiz-multi-mobile, type-quiz-multi')?.shadowRoot ||
      root.querySelector('type-quiz-multi-mobile, type-quiz-multi');
    if (multiQuiz) {
      const qContent = multiQuiz.querySelector('.question-content, #paragraph, .question') || multiQuiz;
      const text = extractStemText(qContent);
      let optionEls = Array.from(multiQuiz.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option'));
      if (optionEls.some((el) => el.hasAttribute('ind') || el.hasAttribute('data-ind'))) {
        optionEls.sort((a, b) => {
          const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
          const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
          if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
          return 0;
        });
      }
      const options = optionEls.map((el, i) => extractOptionText(el) || '[Phương án ' + (i + 1) + ']');
      return {
        type: 'multi_choice',
        olmId: extractReactQuestionId(qContent),
        text,
        options
      };
    }

    // 5a. Advanced OLM Web Components (<type-two-list-mobile>, <type-group-list-mobile>, <type-under-line-mobile>, <type-select-text-mobile>, <type-drag-text>)
    const advComp = root.querySelector('type-two-list-mobile, type-two-list, type-group-list-mobile, type-group-list, type-under-line-mobile, type-under-line, type-select-text-mobile, type-select-text, type-drag-text')?.shadowRoot ||
      root.querySelector('type-two-list-mobile, type-two-list, type-group-list-mobile, type-group-list, type-under-line-mobile, type-under-line, type-select-text-mobile, type-select-text, type-drag-text');
    if (advComp) {
      const qContent = advComp.querySelector('.question-content, #border-word, #link-list, #group-list, #paragraph, .question') || advComp;
      const ulSpans = Array.from(advComp.querySelectorAll('span.under-line[ind-ans], .under-line[ind-ans], span.under-line'));
      const options = ulSpans.length > 0 ? ulSpans.map((el) => extractOptionText(el)).filter(Boolean) : [];
      return {
        type: ulSpans.length > 0 ? 'word_select' : 'interactive',
        olmId: extractReactQuestionId(qContent),
        text: extractStemText(qContent),
        options,
      };
    }

    // 5b. Direct Textarea / Input inside root (Trả lời ngắn hoặc Tự luận)
    const directTextarea = Array.from(root.querySelectorAll('textarea.typing-para, .text-para, textarea, input.trigger-curriculum-cate, input[placeholder="?"]'))
      .find((el) => (el.offsetWidth > 0 || el.offsetHeight > 0) && !el.classList.contains('mq-textarea') && !/otp|phone|consult|search/i.test((el.name || '') + ' ' + (el.id || '')));
    if (directTextarea) {
      const qContent = root.querySelector('.question-content, #paragraph, .question') || document.querySelector('.question-content, #paragraph, .question');
      return {
        type: 'short_answer',
        olmId: extractReactQuestionId(qContent || directTextarea),
        text: extractStemText(qContent),
        options: []
      };
    }

    // 6. Single Choice (<type-quiz-x-mobile>, <type-quiz-x>, or general)
    const singleQuiz = root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz')?.shadowRoot ||
      root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz') || root;
    const qContent = singleQuiz.querySelector('.question-content, #paragraph, .question') ||
      root.querySelector('.question-content, #paragraph, .question') ||
      document.querySelector('.question-content, #paragraph, .question');
    const text = extractStemText(qContent);

    // Query option wrappers across singleQuiz shadowRoot, root, or document
    let optionEls = Array.from(singleQuiz.querySelectorAll('.qselect'));
    if (!optionEls.length) {
      optionEls = Array.from(singleQuiz.querySelectorAll('[ind], [data-ind], .choice-item, .option, .answer-item, .quiz-option'));
    }
    if (!optionEls.length && root !== singleQuiz) {
      optionEls = Array.from(root.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option, .answer-item'));
    }
    if (!optionEls.length) {
      optionEls = Array.from(document.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option, .answer-item'));
    }
    optionEls = optionEls.filter((el) => !el.closest('.exp, .explanation, .giai-chi-tiet, .loigiai') && !el.closest('.tf-box'));
    if (optionEls.some((el) => el.hasAttribute('ind') || el.hasAttribute('data-ind'))) {
      optionEls.sort((a, b) => {
        const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
        const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        return 0;
      });
    }

    const options = optionEls.map((el, i) => extractOptionText(el) || '[Phương án ' + (i + 1) + ']');

    return {
      type: options.length > 0 ? 'choice' : 'short_answer',
      olmId: extractReactQuestionId(qContent),
      text,
      options
    };
  }, index);

  // If choice question but options are empty, poll up to 1.5s for Lit components to finish rendering
  if ((data?.type === 'choice' || data?.type === 'multi_choice') && (!data.options || data.options.length === 0)) {
    for (let r = 0; r < 6; r++) {
      await H.sleep(250);
      const pollOpts = await page.evaluate(() => {
        const extractOpt = (el) => {
          const sign = el.querySelector('.qsign, .content, .option-text, label') || el;
          const clone = sign.cloneNode(true);
          clone.querySelectorAll('.katex, .MathJax').forEach((k) => {
            const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() || '';
            if (tex) k.replaceWith(document.createTextNode(' ' + tex + ' '));
          });
          let t = (clone.innerText || clone.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s*=/g, '≠').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ');
          t = t.replace(/^[\s\u200B\xA0]+|[\s\u200B\xA0]+$/g, '');
          return t.replace(/^(?:[A-D][.):]|\([A-D]\))\s+/i, '').trim();
        };
        const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root') || document;
        const quiz = root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi')?.shadowRoot ||
          root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz-multi') || root;
        let els = Array.from(quiz.querySelectorAll('.qselect'));
        if (!els.length) els = Array.from(quiz.querySelectorAll('[ind], [data-ind], .choice-item, .option, .answer-item'));
        if (!els.length && root !== quiz) els = Array.from(root.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option'));
        if (!els.length) els = Array.from(document.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option'));
        if (els.some((el) => el.hasAttribute('ind') || el.hasAttribute('data-ind'))) {
          els.sort((a, b) => {
            const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
            const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
            if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
            return 0;
          });
        }
        return els.map(extractOpt).filter(Boolean);
      });
      if (pollOpts && pollOpts.length > 0) {
        data.options = pollOpts;
        break;
      }
    }
  }

  // --- Dạng câu hỏi mở rộng (dropdown, kéo-thả, gom nhóm, ghép đôi, hotspot,
  //     gạch chân, tự luận).
  // Không áp dụng khi dạng cơ bản đã được xử lý tốt (short_answer, true_false,
  // multi_choice) để không làm hỏng các dạng đang chạy ổn.
  const BASIC_HANDLED = ['short_answer', 'true_false', 'multi_choice'];
  const EXTENDED_OVERRIDE_TYPES = new Set([
    'dropdown', 'speaking', 'rearrange', 'crossword', 'word_search',
    'code_editor', 'hotspot', 'word_select', 'drag_drop', 'grouping', 'essay',
  ]);
  let extended = null;
  if (!BASIC_HANDLED.includes(data?.type) || data?.type === 'short_answer') {
    const detected = await extendedTypes.detect(page, index);
    if (data?.type !== 'short_answer' || EXTENDED_OVERRIDE_TYPES.has(detected?.type)) {
      extended = detected;
    }
  }

  let hasImage = Boolean(data?.hasImage);
  let imageBase64 = null;
  let blankCount = 0;
  const textContent = (extended?.text || data?.text || '').trim();
  const optionList = extended?.options || data?.options || [];
  const scope = await page.evaluateHandle(questionScopeScript, index);
  try {
    const element = scope.asElement();
    if (element) {
      const visual = await element.evaluate((el) => {
        const visit = (root, depth = 0) => {
          if (depth > 12) return [];
          const elements = [...root.querySelectorAll('*')];
          return elements.concat(elements.flatMap(node => node.shadowRoot ? visit(node.shadowRoot, depth + 1) : []));
        };
        const nodes = visit(el);
        return {
          image: nodes.some(node => node.matches('img:not(.emoji):not(.icon), canvas, svg') &&
            node.getBoundingClientRect().width >= 20 && node.getBoundingClientRect().height >= 16),
          complexMath: nodes.some(node => node.matches('math, mjx-container, .katex, .MathJax, .mfrac, [data-latex]')),
        };
      });
      hasImage ||= visual.image;
      if (data?.type === 'short_answer' || ['strict_short_answer', 'fill_me'].includes(extended?.type)) {
        const fields = await page.evaluateHandle(shortInputsScript, scope);
        try { blankCount = await fields.evaluate(nodes => nodes.length); }
        finally { await fields.dispose(); }
      }
      if (hasImage || visual.complexMath || textContent.length < 5 ||
          (data?.type === 'choice' && optionList.length < 2)) {
        const bounds = await element.boundingBox();
        if (bounds && bounds.width <= 1900 && bounds.height <= 2400) {
          await element.evaluate(async el => {
            el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            const roots = [el];
            for (const root of roots) {
              for (const child of root.querySelectorAll('*')) if (child.shadowRoot) roots.push(child.shadowRoot);
            }
            const pending = roots.flatMap(root => [...root.querySelectorAll('img')]).filter(img => !img.complete);
            await Promise.race([
              Promise.allSettled(pending.map(img => img.decode())),
              new Promise(resolve => setTimeout(resolve, 1000)),
            ]);
          });
          imageBase64 = await element.screenshot({ encoding: 'base64', type: 'jpeg', quality: 82 });
        } else if (bounds) {
          await element.scrollIntoView();
          imageBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 82 });
        }
      }
    }
  } catch (err) {
    log?.('warn', 'Không chụp được ảnh câu ' + (index + 1) + '.');
  } finally {
    await scope.dispose();
  }

  const result = {
    id: `q_${index + 1}`,
    olmId: data?.olmId || null,
    index,
    subject,
    type: extended?.type || data?.type || 'choice',
    text: extended?.text || data?.text || '',
    options: extended?.options || data?.options || [],
    statements: data?.statements || [],
    items: extended?.items || [],
    targets: extended?.targets || [],
    left: extended?.left || [],
    right: extended?.right || [],
    zones: extended?.zones || [],
    words: extended?.words || [],
    imageBase64,
    hasImage,
    blankCount,
  };
  return result;
}

/**
 * Unified Dynamic DOM Question Fill & DevTools Inspector
 * Nhận diện động và điền câu trả lời cho mọi form OLM:
 * 1. Đúng / Sai (True / False - 2 nút Đ/S theo từng hàng mệnh đề)
 * 2. Trắc nghiệm (Radio / Checkbox theo ind hoặc text)
 * 3. Công thức Toán học (MathQuill / LaTeX)
 * 4. Điền ô trống (Text / Number / Textarea / Contenteditable)
 * 5. Menu thả xuống (Select dropdown)
 * 6. Kéo thả / Gom nhóm / Nối cặp (thông qua extended-types)
 * 7. Tự chẩn đoán DevTools (Snapshot toàn bộ interactive elements khi gặp form lạ)
 */
async function fillTrueFalse(page, question, answer) {
  const scope = await page.evaluateHandle(questionScopeScript, question.index || 0);
  try {
    const surface = scope.asElement();
    if (!surface) return { ok: false, reason: 'missing-true-false-scope' };
    return await surface.evaluate(async (root, answer) => {
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility === 'visible';
      const trees = [root];
      for (const tree of trees) {
        if (tree.shadowRoot) trees.push(tree.shadowRoot);
        for (const node of tree.querySelectorAll('*')) if (node.shadowRoot) trees.push(node.shadowRoot);
      }
      const control = '.tf-box, [data-tf-value], input[type="radio"], [role="radio"], .tf-btn';
      const candidates = [...new Set(trees.flatMap(tree => [...tree.querySelectorAll('tr, .tf-row, [class*="statement"]')]))]
        .filter(row => visible(row) && row.querySelector(control) && !row.closest('.explanation, .exp, .loigiai'));
      const rows = candidates.filter(row => !candidates.some(other => other !== row && row.contains(other)));
      const choiceValue = value => {
        if (value === true || value === 1 || value === '1') return '1';
        if (value === false || value === 0 || value === '0') return '0';
        return null;
      };
      const normalize = text => String(text || '').normalize('NFC')
        .replace(/^(?:ý\s*)?[a-d][.):]\s*/i, '').replace(/\$|\\(?:left|right)\b/g, '')
        .replace(/[−–]/g, '-').replace(/\s+/g, '');
      const rowText = row => {
        const clone = row.cloneNode(true);
        for (const math of clone.querySelectorAll('.katex, mjx-container, math')) {
          const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent || math.getAttribute('alttext');
          if (tex) math.replaceWith(document.createTextNode(tex));
        }
        clone.querySelectorAll(control + ', button').forEach(node => node.remove());
        return normalize(clone.textContent);
      };
      const direct = answer.tfAnswers || [];
      let expected;
      if (Array.isArray(answer.statements) && answer.statements.length === rows.length) {
        expected = answer.statements.map(choiceValue);
      } else if (direct.length === rows.length) {
        const seen = new Set();
        expected = rows.map(row => {
          // Khớp theo thuộc tính ind trên radio button nếu có (đặc thù đề thi OLM)
          const indEl = row.querySelector('[ind], [data-ind]');
          const indVal = indEl?.getAttribute('ind') ?? indEl?.getAttribute('data-ind');
          if (indVal !== null && indVal !== undefined && Number.isInteger(Number(indVal))) {
            const itemByInd = direct.find(item => item.index === Number(indVal));
            if (itemByInd && !seen.has(itemByInd)) {
              seen.add(itemByInd);
              return choiceValue(itemByInd.value);
            }
          }
          const text = rowText(row);
          const matches = direct.filter(item => text && normalize(item.text) === text);
          if (matches.length !== 1 || seen.has(matches[0])) return null;
          seen.add(matches[0]);
          return choiceValue(matches[0].value);
        });
      }
      if (!rows.length || !expected || expected.some(value => value == null)) {
        return { ok: false, reason: 'true-false-statements-unmatched' };
      }

      const selected = el => el.matches(':checked, [aria-checked="true"], [aria-pressed="true"], .active, .selected, .qchecked, .tw-selected') ||
        Boolean(el.querySelector('input:checked, [aria-checked="true"], .qchecked'));
      const waitFor = async test => {
        for (let i = 0; i < 6; i++) {
          if (test()) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      };
      let filled = 0;
      for (const [index, row] of rows.entries()) {
        const value = expected[index];
        const label = value === '1' ? /^(?:đ|đúng|true)$/i : /^(?:s|sai|false)$/i;
        const target = [...row.querySelectorAll('[data-tf-value], button, label, input[type="radio"], [role="radio"], .tf-btn')]
          .find(el => visible(el) && (el.getAttribute('data-tf-value') === value || !el.closest('.tf-box') &&
            label.test((el.innerText || el.getAttribute('aria-label') || el.value || '').trim())));
        if (target) {
          if (!selected(target)) target.click();
          if (await waitFor(() => selected(target))) filled++;
          continue;
        }
        const box = row.querySelector('.tf-box');
        const toggle = box?.querySelector('.qselect') || box;
        if (!toggle || !visible(toggle)) continue;
        const current = () => toggle.getAttribute('data-value');
        for (let attempt = 0; attempt < 3 && current() !== value; attempt++) {
          const before = current();
          toggle.click();
          if (!await waitFor(() => current() !== before)) break;
        }
        if (current() === value) filled++;
      }
      return { ok: filled === rows.length, filled, rows: rows.length, method: 'true-false',
        reason: filled === rows.length ? undefined : 'true-false-state-unconfirmed' };
    }, answer);
  } finally {
    await scope.dispose();
  }
}

async function inspectAndFillAnyQuestion(page, targetAnswer, question = {}, log = null) {
  if (!targetAnswer || targetAnswer.unresolved || (!targetAnswer.answer && !targetAnswer.correctText && !(targetAnswer.correctIndex >= 0) &&
    !(Array.isArray(targetAnswer.correctIndices) && targetAnswer.correctIndices.length) && !targetAnswer.isTrueFalse &&
    !(Array.isArray(targetAnswer.fillAnswers) && targetAnswer.fillAnswers.length) &&
    !targetAnswer.statements?.length && !targetAnswer.tfAnswers?.length && !targetAnswer.pairs?.length && !targetAnswer.mapping?.length && !targetAnswer.box)) {
    // 1. Đọc toàn bộ dữ liệu DevTools từ Live DOM / Web Components trước
    const liveDomAnswer = await extractLiveDomAnswer(page, question.index);
    if (liveDomAnswer && !liveDomAnswer.unresolved) {
      targetAnswer = liveDomAnswer;
      if (log) log('info', `🎯 [DevTools Live DOM] Đọc được đáp án từ DevTools (${liveDomAnswer.source || 'DOM'}): ${liveDomAnswer.answer || liveDomAnswer.correctText || JSON.stringify(liveDomAnswer.fillAnswers || liveDomAnswer.tfAnswers)}`);
    } else {
      // 2. Chuyển sang Adaptive Solver để quét sâu toàn bộ DOM + Web Components + DevTools state
      try {
        const adaptive = require('./adaptive-solver');
        const adRes = await adaptive.solveAdaptively(page, { knownAnswer: targetAnswer, log, questionIndex: question.index });
        if (adRes.ok) return adRes;
      } catch { /* ignore */ }
      return { ok: false, reason: 'no-answer' };
    }
  }

  if (['short_answer', 'strict_short_answer', 'fill_me'].includes(question.type)) {
    return fillCurrentQuestion(page, question, targetAnswer, log);
  }

  if (question.type === 'true_false' || targetAnswer.isTrueFalse || targetAnswer.tfAnswers?.length) {
    const tfRes = await fillTrueFalse(page, question, targetAnswer);
    if (tfRes && tfRes.ok) return tfRes;
  }

  // Hỗ trợ trực tiếp Web Component Sắp xếp thứ tự (type-sort-list-mobile / type-sort-list) và Kéo thả từ (type-drag-text-mobile)
  const sortOrDragRes = await page.evaluate(async (qIdx) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const items = [...document.querySelectorAll('.itemx.q-view-itemx.question')];
    const scopeRoot = (items[qIdx] && items[qIdx].getClientRects().length) ? items[qIdx] : document;
    const findComp = (root, d = 0) => {
      if (!root || d > 10) return null;
      for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
        const tag = (el.tagName || '').toLowerCase();
        if (/^type-(sort-list|drag-text)/i.test(tag)) return el;
        if (el.shadowRoot) {
          const sub = findComp(el.shadowRoot, d + 1);
          if (sub) return sub;
        }
      }
      return null;
    };
    const comp = findComp(scopeRoot);
    if (!comp) return null;
    const tag = comp.tagName.toLowerCase();
    const sr = comp.shadowRoot || comp.renderRoot || comp;

    if (tag.includes('sort-list')) {
      for (let pass = 0; pass < 35; pass++) {
        const lis = Array.from(sr.querySelectorAll('li.sortable-item[name]'));
        if (!lis.length) return null;
        const names = lis.map((li) => Number(li.getAttribute('name')));
        let moved = false;
        for (let i = 1; i < lis.length; i++) {
          if (names[i] < names[i - 1]) {
            const upBtn = lis[i].querySelector('.up, span.up, img[alt="up"]');
            if (upBtn) {
              upBtn.click();
              moved = true;
              await wait(110);
              break;
            }
          }
        }
        if (!moved) break;
      }
      return { ok: true, method: 'sort-list-mobile' };
    }

    if (tag.includes('drag-text') && comp.answerCorrect && typeof comp.answerCorrect === 'object') {
      const answerCorrect = comp.answerCorrect;
      const blanks = Array.from(sr.querySelectorAll('.olm-input-text, .box-fill, .drag-blank, [class*="input-text"], [ind]'))
        .filter((el) => !el.classList.contains('select-option-item') && !el.classList.contains('box-select-option-content'));
      const keys = Object.keys(answerCorrect).sort((a, b) => Number(a) - Number(b));
      let filled = 0;
      for (const k of keys) {
        const targetId = String(answerCorrect[k]);
        const blank = blanks[Number(k)];
        if (blank) {
          blank.click();
          await wait(150);
        }
        const opt = sr.querySelector(`.drag-select[data-id="${targetId}"], .select-option-item[data-id="${targetId}"]`);
        if (opt) {
          opt.click();
          filled++;
          await wait(150);
        }
      }
      if (filled > 0) {
        return { ok: filled === keys.length, method: 'drag-text-mobile', filled, total: keys.length };
      }
    }
    return null;
  }, question.index || 0).catch(() => null);
  if (sortOrDragRes && sortOrDragRes.ok) return sortOrDragRes;

  const multipleSurfaces = await page.evaluate(() =>
    document.querySelectorAll('.itemx.q-view-itemx.question, .quizx.question-hold, [id^="user-test-"]').length > 1);

  // Dạng mở rộng đặc thù (drag-drop, gom nhóm, nối cột)
  if (question.type && extendedTypes.isExtended(question.type) && (!multipleSurfaces || question.type === 'dropdown')) {
    try {
      const extRes = await extendedTypes.fill(page, question, targetAnswer);
      if (extRes && extRes.ok) return extRes;
    } catch { }
  }

  // 1. Phân tích DOM và lấy tọa độ các nút cần click
  const scope = await page.evaluateHandle(questionScopeScript, question.index || 0);
  if (!scope.asElement()) {
    await scope.dispose();
    return { ok: false, reason: 'question-scope-missing' };
  }
  const evalRes = await page.evaluate((ans, surface) => {
    function getAllDeep(sel, root = surface.shadowRoot || surface, depth = 0) {
      if (depth > 12) return [];
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch { }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch { }
        }
      }
      return Array.from(new Set(results));
    }

    const root = surface.shadowRoot || surface;

    // 0. Form 0: NỐI CỘT / GHÉP ĐÔI (type-link-list / .boxlink & type-two-list-mobile)
    const boxlinkLefts = getAllDeep('.boxlink.left');
    const boxlinkRights = getAllDeep('.boxlink.right');
    if (boxlinkLefts.length > 0 && boxlinkRights.length > 0) {
      let linkedCount = 0;
      for (const leftEl of boxlinkLefts) {
        const matchRight = boxlinkRights.find(r => r.id && r.id === leftEl.id);
        if (matchRight) {
          leftEl.click();
          matchRight.click();
          linkedCount++;
        }
      }
      if (linkedCount > 0) {
        return { ok: true, method: 'link-list-matching', text: `Đã nối ${linkedCount} cặp chính xác theo OLM ID` };
      }
    }

    // 0a2. Form 0a2: TWO-LIST / LINK-LIST (<type-two-list-mobile>, <type-two-list>, q_type: 6)
    const twoListComps = getAllDeep('type-two-list-mobile, type-two-list');
    if (twoListComps.length > 0 && Array.isArray(ans.linkPairs) && ans.linkPairs.length > 0) {
      const comp = twoListComps[0];
      const rootEl = comp.renderRoot || comp.shadowRoot || comp;
      const normTxt = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const rows = Array.from(rootEl.querySelectorAll('.two-column-row') || []);
      let matchedPairs = 0;
      const usedOptionIds = new Set();

      for (let rIdx = 0; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        const leftText = normTxt(row.querySelector('.two-column-left')?.innerText || '');
        const slot = row.querySelector('.two-list.select-option, .two-column-right [ind]');
        if (!slot) continue;

        const pair = ans.linkPairs.find((p) => normTxt(p.left) === leftText) ||
          ans.linkPairs.find((p) => leftText && normTxt(p.left) && (leftText.includes(normTxt(p.left)) || normTxt(p.left).includes(leftText))) ||
          ans.linkPairs[rIdx];
        if (!pair || !pair.right) continue;

        const targetRight = normTxt(pair.right);
        // Nếu ô bên phải đã có sẵn đáp án thì xóa trước hoặc chọn điểm đích
        if (slot.children.length > 0) {
          HTMLElement.prototype.click.call(slot);
        }
        Array.from(rootEl.querySelectorAll('.two-list.select-option')).forEach((s) => s.classList.remove('selectpoint'));
        slot.classList.add('selectpoint');
        HTMLElement.prototype.click.call(slot);

        const options = Array.from(rootEl.querySelectorAll('.box-select-option .drag-select.select-option-item, .drag-select.select-option-item') || []);
        const matchedOpt = options.find((o) => !usedOptionIds.has(o.getAttribute('data-id')) && normTxt(o.innerText) === targetRight) ||
          options.find((o) => !usedOptionIds.has(o.getAttribute('data-id')) && targetRight && (normTxt(o.innerText).includes(targetRight) || targetRight.includes(normTxt(o.innerText))));
        if (matchedOpt) {
          const optId = matchedOpt.getAttribute('data-id');
          if (optId) usedOptionIds.add(optId);
          HTMLElement.prototype.click.call(matchedOpt);
          matchedPairs++;
        }
      }
      if (matchedPairs > 0) {
        return { ok: true, method: 'two-list-matching', text: `Đã nối ${matchedPairs}/${rows.length} cặp cột` };
      }
    }

    // 0b. Form 0b: DRAG-TEXT (<type-drag-text>)
    const dragComps = getAllDeep('type-drag-text');
    if (dragComps.length > 0) {
      const comp = dragComps[0];
      const correctMap = comp.answerCorrect || comp.data?.answerCorrect || {};
      const rootEl = comp.renderRoot || comp.shadowRoot || comp;
      const bankWords = Array.from(rootEl.querySelectorAll('.item-drag .drag-select, .drag-select') || []);
      const blanks = Array.from(rootEl.querySelectorAll('.dragtext[name=dragtext][ind], [name=dragtext]') || []);
      let filled = 0;
      for (const [blankInd, wordId] of Object.entries(correctMap)) {
        const blank = blanks.find(b => b.getAttribute('ind') === blankInd);
        const word = bankWords.find(w => w.getAttribute('data-id') === String(wordId));
        if (blank && word) {
          blanks.forEach(b => b.classList.remove('selectpoint'));
          blank.classList.add('selectpoint');
          HTMLElement.prototype.click.call(word);
          filled++;
        }
      }
      if (filled > 0) {
        return { ok: true, method: 'drag-text', text: `Đã điền ${filled} từ dạng drag-text` };
      }
    }

    // 0c. Form 0c: FILL-ME (<type-fill-me>, <type-fill-me-mobile> - hỗ trợ cả đơn ô trống, đa ô trống và nhiều type-fill-me trong <type-mix>)
    const fillMeComps = getAllDeep('type-fill-me, type-fill-me-mobile');
    if (fillMeComps.length > 0) {
      const fillVals = (Array.isArray(ans.fillAnswers) && ans.fillAnswers.length > 0)
        ? ans.fillAnswers.map((v) => String(v ?? '').trim()).filter(Boolean)
        : (Array.isArray(ans.answers) && ans.answers.length > 0
          ? ans.answers.map((v) => String(v ?? '').trim()).filter(Boolean)
          : String(ans.answer || ans.correctText || '').split('|').map((v) => v.trim()).filter(Boolean));

      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      let globalIdx = 0;
      const filledTexts = [];

      for (const comp of fillMeComps) {
        const rootEl = comp.shadowRoot || comp.renderRoot || comp;
        const inputs = Array.from(rootEl.querySelectorAll('#fillme-input input, input[placeholder="?"], input[type="text"], input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'));
        const compFillNodes = [];
        const walkFillNodes = (nodes) => {
          if (!Array.isArray(nodes)) return;
          for (const n of nodes) {
            if (!n || typeof n !== 'object') continue;
            if (n.type === 'fillme-input') compFillNodes.push(n);
            if (Array.isArray(n.children)) walkFillNodes(n.children);
          }
        };
        walkFillNodes(comp.jsonQuestion_json?.root?.children || []);

        const ua = {};
        inputs.forEach((input, localIdx) => {
          const rawNodeContent = compFillNodes[localIdx]?.content || '';
          const cleanNodeVal = rawNodeContent
            ? String(rawNodeContent).split('||')[0].split('|')[0].replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
            : '';
          const validNodeVal = cleanNodeVal && !/^@.*@$|@(?:p\.|Math\.)/.test(cleanNodeVal) ? cleanNodeVal : '';

          const directAcc = input.getAttribute('data-accept') || input.getAttribute('data-accepts') || input.getAttribute('data-ans') || '';
          const cleanDirect = directAcc
            ? String(directAcc).split('||')[0].split('|')[0].replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').trim()
            : '';
          const validDirect = cleanDirect && !/^@.*@$|@(?:p\.|Math\.)/.test(cleanDirect) ? cleanDirect : '';
          const val = validNodeVal || validDirect || (fillVals[globalIdx] !== undefined ? fillVals[globalIdx] : (fillVals[0] || ''));
          globalIdx++;
          if (!val) return;

          input.focus();
          if (input._valueTracker) {
            try { input._valueTracker.setValue(''); } catch { }
          }
          if (nativeSetter) nativeSetter.call(input, val);
          else input.value = val;
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          if (typeof comp.onChange === 'function') {
            try { comp.onChange({ currentTarget: input, target: input }); } catch { }
          }
          input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, composed: true }));
          input.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));
          input.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
          const indKey = input.getAttribute('ind') ?? input.getAttribute('data-ind') ?? String(localIdx);
          ua[indKey] = val;
          filledTexts.push(val);
        });
        if (Object.keys(ua).length > 0) {
          comp.userAnswer = Object.assign({}, comp.userAnswer || {}, ua);
          if (typeof comp.requestUpdate === 'function') {
            try { comp.requestUpdate(); } catch { }
          }
        }
      }

      if (filledTexts.length > 0) {
        return { ok: true, method: 'fill-me', text: `Đã điền: ${filledTexts.join(' | ')}` };
      }
    }

    // 0d. Form 0d: GROUP-LIST (<type-group-list-mobile>, <type-group-list>, q_type: 10)
    const groupListComps = getAllDeep('type-group-list-mobile, type-group-list');
    if (groupListComps.length > 0 && Array.isArray(ans.groups) && ans.groups.length > 0) {
      const comp = groupListComps[0];
      const rootEl = comp.renderRoot || comp.shadowRoot || comp;
      const normTxt = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      let movedCount = 0;

      for (const grp of ans.groups) {
        const targetGroupTitle = normTxt(grp.title);
        // 1. Mobile button (.name-group-item)
        const groupBtns = Array.from(rootEl.querySelectorAll('.box-select-option .name-group-item, .name-group-item') || []);
        const matchedGroupBtn = groupBtns.find((b) => normTxt(b.getAttribute('data-group-name') || b.innerText) === targetGroupTitle) ||
          groupBtns.find((b) => {
            const gName = normTxt(b.getAttribute('data-group-name') || b.innerText);
            return gName && targetGroupTitle && (gName.includes(targetGroupTitle) || targetGroupTitle.includes(gName));
          });

        // 2. Desktop droppable list (ul.item-in[data-group], .ui-droppable[data-group])
        const dropUls = Array.from(rootEl.querySelectorAll('ul.item-in[data-group], .ui-droppable[data-group], .drop-into [data-group]') || []);
        const matchedDropUl = dropUls.find((u) => normTxt(u.getAttribute('data-group') || '') === targetGroupTitle) ||
          dropUls.find((u) => {
            const gName = normTxt(u.getAttribute('data-group') || '');
            return gName && targetGroupTitle && (gName.includes(targetGroupTitle) || targetGroupTitle.includes(gName));
          });

        const actualGroupKey = matchedDropUl?.getAttribute('data-group') || matchedGroupBtn?.getAttribute('data-group-name') || grp.title;
        if (!matchedGroupBtn && !matchedDropUl && typeof comp.moveUserAnswerItem !== 'function') continue;

        for (const itemStr of (grp.items || [])) {
          const targetItemTxt = normTxt(itemStr);
          const dragItems = Array.from(rootEl.querySelectorAll('.drag-item.select-option, .drag-item[data-id]') || []);
          const matchedItem = dragItems.find((el) => {
            const curGrp = normTxt(el.getAttribute('data-group') || el.parentElement?.getAttribute('data-group') || '');
            if (curGrp && curGrp === targetGroupTitle) return false;
            const iTxt = normTxt(el.querySelector('.item-text')?.innerText || el.innerText || el.getAttribute('name'));
            return iTxt === targetItemTxt;
          }) || dragItems.find((el) => {
            const curGrp = normTxt(el.getAttribute('data-group') || el.parentElement?.getAttribute('data-group') || '');
            if (curGrp && curGrp === targetGroupTitle) return false;
            const iTxt = normTxt(el.querySelector('.item-text')?.innerText || el.innerText || el.getAttribute('name'));
            return iTxt && targetItemTxt && (iTxt.includes(targetItemTxt) || targetItemTxt.includes(iTxt));
          });

          if (matchedItem) {
            const rawId = matchedItem.getAttribute('data-id');
            const parsedId = rawId !== null && rawId !== '' && Number.isFinite(Number(rawId)) ? Number(rawId) : rawId;
            if (matchedGroupBtn) {
              HTMLElement.prototype.click.call(matchedItem);
              HTMLElement.prototype.click.call(matchedGroupBtn);
            } else if (matchedDropUl) {
              if (typeof comp.moveUserAnswerItem === 'function') {
                comp.moveUserAnswerItem(parsedId, String(actualGroupKey));
              }
              matchedDropUl.appendChild(matchedItem);
              matchedItem.setAttribute('data-group', String(actualGroupKey));
            } else if (typeof comp.moveUserAnswerItem === 'function') {
              comp.moveUserAnswerItem(parsedId, String(actualGroupKey));
            }
            movedCount++;
          }
        }
      }
      if (movedCount > 0) {
        return { ok: true, method: 'group-list', text: `Đã phân loại ${movedCount} mục vào ${ans.groups.length} nhóm` };
      }
    }

    // 0e. Form 0e: UNDER-LINE (<type-under-line-mobile>, <type-under-line>, span.under-line[ind-ans], q_type: 9)
    const underLineComps = getAllDeep('type-under-line-mobile, type-under-line');
    const underLineSpans = getAllDeep('span.under-line[ind-ans], .under-line[ind-ans], span.under-line');
    if ((underLineComps.length > 0 || underLineSpans.length > 0) && ((Array.isArray(ans.correctIndices) && ans.correctIndices.length > 0) || (Array.isArray(ans.correctTexts) && ans.correctTexts.length > 0))) {
      const targetIndSet = new Set((ans.correctIndices || []).map((n) => Number(n)));
      const normTxt = (s) => String(s || '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      const targetTextSet = new Set((ans.correctTexts || []).map(normTxt).filter(Boolean));
      let clickedUl = 0;
      const clickedUlTexts = [];

      underLineSpans.forEach((spanEl, fallbackIdx) => {
        const rawInd = spanEl.getAttribute('ind-ans') ?? spanEl.getAttribute('ind') ?? spanEl.getAttribute('data-ind');
        const indNum = rawInd !== null && rawInd !== '' ? Number(rawInd) : fallbackIdx;
        const sTxt = normTxt(spanEl.innerText);
        const shouldSelect = targetIndSet.has(indNum) || (targetIndSet.size === 0 && targetTextSet.has(sTxt));
        const isSelected = spanEl.classList.contains('selected') || spanEl.classList.contains('active') || spanEl.classList.contains('underlined') || spanEl.classList.contains('choose') || spanEl.classList.contains('checked');
        if (shouldSelect && !isSelected) {
          HTMLElement.prototype.click.call(spanEl);
          clickedUl++;
          clickedUlTexts.push((spanEl.innerText || '').trim());
        } else if (shouldSelect && isSelected) {
          clickedUl++;
          clickedUlTexts.push((spanEl.innerText || '').trim());
        }
      });

      if (clickedUl > 0) {
        return { ok: true, method: 'under-line', text: clickedUlTexts.join(' | ') };
      }
    }
    function parseMathMLNodeDOM(node) {
      if (!node) return '';
      if (node.nodeType === 3) return node.nodeValue || '';
      if (node.nodeType !== 1) return '';
      const tag = (node.tagName || '').toLowerCase().replace(/^m:/, '');
      if (tag === 'annotation') return '';
      const children = Array.from(node.childNodes || []).filter(
        (c) => c.nodeType === 1 || (c.nodeType === 3 && (c.nodeValue || '').trim() !== '')
      );
      const elemChildren = Array.from(node.children || []);
      if (tag === 'mfrac' && elemChildren.length >= 2) {
        return `(${parseMathMLNodeDOM(elemChildren[0]).trim()})/(${parseMathMLNodeDOM(elemChildren[1]).trim()})`;
      }
      if (tag === 'msup' && elemChildren.length >= 2) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()}^(${parseMathMLNodeDOM(elemChildren[1]).trim()})`;
      }
      if (tag === 'msub' && elemChildren.length >= 2) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()}_(${parseMathMLNodeDOM(elemChildren[1]).trim()})`;
      }
      if (tag === 'msubsup' && elemChildren.length >= 3) {
        return `${parseMathMLNodeDOM(elemChildren[0]).trim()}_(${parseMathMLNodeDOM(elemChildren[1]).trim()})^(${parseMathMLNodeDOM(elemChildren[2]).trim()})`;
      }
      if (tag === 'msqrt') {
        return `√(${children.map(parseMathMLNodeDOM).join('').trim()})`;
      }
      if (tag === 'mroot' && elemChildren.length >= 2) {
        const base = parseMathMLNodeDOM(elemChildren[0]).trim();
        const rIdx = parseMathMLNodeDOM(elemChildren[1]).trim();
        return rIdx === '3' ? `∛(${base})` : `√[${rIdx}](${base})`;
      }
      return children.map(parseMathMLNodeDOM).join('');
    }

    function normalizeMathDOM(rootEl) {
      if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
      rootEl.querySelectorAll('.katex, .MathJax, mjx-container').forEach((k) => {
        const tex =
          k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ||
          k.querySelector('math')?.getAttribute('alttext') ||
          k.getAttribute('data-latex') ||
          k.getAttribute('alttext') ||
          '';
        if (tex) {
          k.replaceWith(document.createTextNode(' $' + tex + '$ '));
          return;
        }
        const mathEl = k.querySelector('.katex-mathml math, math');
        if (mathEl && mathEl.querySelector('mfrac, msup, msub, msubsup, msqrt, mroot')) {
          const parsedMml = parseMathMLNodeDOM(mathEl).trim();
          if (parsedMml) {
            k.replaceWith(document.createTextNode(' ' + parsedMml + ' '));
            return;
          }
        }
        k.querySelectorAll('.katex-mathml, mjx-assistive-mml, .MJX_Assistive_MathML').forEach((m) => m.remove());
        const khtml = k.querySelector('.katex-html') || k;
        Array.from(khtml.querySelectorAll('.sqrt')).reverse().forEach((sq) => {
          const rootIdx = sq.querySelector('.root')?.textContent?.trim() || '';
          const vlist = sq.querySelector('.vlist-t .vlist');
          let rad = '';
          if (vlist && vlist.children.length > 0) rad = vlist.children[0].textContent?.trim() || '';
          else {
            const cloneSq = sq.cloneNode(true);
            cloneSq.querySelectorAll('.root, .sqrt-sign, svg').forEach((n) => n.remove());
            rad = cloneSq.textContent?.trim() || '';
          }
          sq.replaceWith(document.createTextNode(rootIdx ? (rootIdx === '3' ? `∛(${rad})` : `√[${rootIdx}](${rad})`) : `√(${rad})`));
        });
        Array.from(khtml.querySelectorAll('.msupsub')).reverse().forEach((ss) => {
          const vlist = ss.querySelector('.vlist-t .vlist');
          if (vlist && vlist.children.length > 0) {
            const parts = [];
            Array.from(vlist.children).forEach((ch) => {
              const txt = (ch.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
              if (!txt) return;
              const topMatch = (ch.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
              const topVal = topMatch ? parseFloat(topMatch[1]) : -3.0;
              if (topVal < -2.75) parts.push(/^[°∘o0]$/.test(txt) ? '°' : `^(${txt})`);
              else parts.push(`_(${txt})`);
            });
            if (parts.length > 0) {
              ss.replaceWith(document.createTextNode(parts.join('')));
              return;
            }
          }
          const rawSs = (ss.textContent || '').trim();
          if (rawSs) ss.replaceWith(document.createTextNode(`^(${rawSs})`));
        });
        Array.from(khtml.querySelectorAll('.mfrac')).reverse().forEach((mf) => {
          const vlist = mf.querySelector('.vlist-t .vlist');
          if (vlist && vlist.children.length >= 2) {
            const children = Array.from(vlist.children);
            const lineIdx = children.findIndex((c) => c.querySelector('.frac-line') || c.classList?.contains('frac-line'));
            let num = '';
            let den = '';
            if (lineIdx > 0 && lineIdx < children.length - 1) {
              den = children.slice(0, lineIdx).map((c) => c.textContent.trim()).filter(Boolean).join('');
              num = children.slice(lineIdx + 1).map((c) => c.textContent.trim()).filter(Boolean).join('');
            } else {
              const nonLine = children.filter((c) => !c.querySelector('.frac-line') && !c.classList?.contains('frac-line'));
              if (nonLine.length >= 2) {
                const withTop = nonLine.map((c, i) => {
                  const m = (c.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
                  return { el: c, top: m ? parseFloat(m[1]) : -i };
                });
                withTop.sort((a, b) => a.top - b.top);
                num = withTop[0].el.textContent.trim();
                den = withTop[withTop.length - 1].el.textContent.trim();
              }
            }
            if (num || den) mf.replaceWith(document.createTextNode(` (${num})/(${den}) `));
          }
        });
      });
      Array.from(rootEl.querySelectorAll('sup')).reverse().forEach((sup) => {
        const txt = (sup.textContent || '').trim();
        if (!txt) { sup.remove(); return; }
        const nextTxt = sup.nextSibling?.textContent || '';
        if (/^[°∘o0]$/.test(txt) && (/^[CFK]\b/i.test(nextTxt.trim()) || txt === '°' || txt === '∘')) sup.replaceWith(document.createTextNode('°'));
        else sup.replaceWith(document.createTextNode(`^(${txt})`));
      });
      Array.from(rootEl.querySelectorAll('sub')).reverse().forEach((sub) => {
        const txt = (sub.textContent || '').trim();
        if (!txt) { sub.remove(); return; }
        sub.replaceWith(document.createTextNode(`_(${txt})`));
      });
      return rootEl;
    }

    // Helper đọc text phương án sạch (chống lặp chữ KaTeX 2 lần và đồng bộ ký hiệu LaTeX/KaTeX-HTML)
    const extractOptionCleanText = (el) => {
      if (!el) return '';
      const isTrOrTfRow = el.tagName === 'TR' || el.classList?.contains('tf-row');
      const sign = isTrOrTfRow
        ? (el.querySelector('td:not(.tf-box), .statement-text, .tf-text') || el)
        : (el.querySelector('.qsign, .content, .option-text, label') || el);
      const clone = sign.cloneNode(true);
      if (isTrOrTfRow) {
        clone.querySelectorAll('.tf-box, .qiradio, [data-tf-value]').forEach((n) => n.remove());
      }
      normalizeMathDOM(clone);
      clone.querySelectorAll('script, style, svg').forEach((n) => n.remove());
      let t = (clone.innerText || clone.textContent || sign.innerText || '').replace(/\s+/g, ' ').trim();
      t = t.replace(/^(?:[A-D][.):]|\([A-D]\))\s+/i, '').trim();
      if (!t) {
        const img = sign.querySelector('img:not(.emoji):not(.icon)');
        if (img) return `[Hình ảnh: ${img.getAttribute('src') || img.src || 'option'}]`;
      }
      return t;
    };

    const SUP_MAP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', 'ⁿ': 'n', 'ⁱ': 'i' };
    const SUB_MAP = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9', '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', 'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j', 'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o', 'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u', 'ᵥ': 'v', 'ₓ': 'x' };

    // Chuẩn hóa biểu thức khoa học toàn diện (Toán - Lý - Hóa - Sinh - Tin từ lớp 1 đến Đại học)
    const cleanScience = (str, opt = {}) => {
      if (str === null || str === undefined) return '';
      let s = String(str);
      s = s.replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');
      s = s.replace(/\u00A0/g, ' ');
      s = s.replace(/[\r\n\t]+/g, ' ');
      s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, (m) => '^(' + m.split('').map((c) => SUP_MAP[c] || c).join('') + ')');
      s = s.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/g, (m) => '_(' + m.split('').map((c) => SUB_MAP[c] || c).join('') + ')');
      s = s.replace(/℃/g, '°C').replace(/℉/g, '°F').replace(/K/g, 'K');
      s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘o0])\s*\}\s*([CFK])\b/g, '°$1');
      s = s.replace(/\^\(\s*(?:\\circ|\\degree|[°∘o0])\s*\)\s*([CFK])\b/g, '°$1');
      s = s.replace(/\^(?:\\circ|\\degree|[°∘])\s*([CFK])\b/g, '°$1');
      s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘])\s*\}/g, '°').replace(/\^\(\s*(?:\\circ|\\degree|[°∘])\s*\)/g, '°');
      s = s.replace(/\\(?:circ|degree)(?![a-zA-Z])/g, '°').replace(/[∘˚º]/g, '°');
      s = s.replace(/°\s+([CFK])\b/g, '°$1');
      s = s.replace(/(\d)\s*\^\(\s*[0o]\s*\)\s*([CFK])\b/g, '$1°$2');
      s = s.replace(/\b([tT])\s*\(\s*0\s*C\s*\)/g, '$1(°C)');
      s = s.replace(/\\(?:prime)(?![a-zA-Z])/g, "'");
      s = s.replace(/″|''/g, "''").replace(/‴|'''/g, "'''").replace(/[’‘′`]/g, "'");
      s = s.replace(/[\u2212\u2013\u2014]/g, '-');
      s = s.replace(/\\(?:cdot|bullet|centerdot)(?![a-zA-Z])|[\u22C5\u2022\u2219]/g, '·');
      s = s.replace(/\\times(?![a-zA-Z])|\u00D7/g, '×');
      s = s.replace(/\\div(?![a-zA-Z])|\u00F7/g, ':');
      s = s.replace(/\\pm(?![a-zA-Z])|\u00B1/g, '±').replace(/\\mp(?![a-zA-Z])|\u2213/g, '∓');
      s = s.replace(/\\(?:oplus)(?![a-zA-Z])|\u2295/g, '⊕').replace(/\\(?:otimes)(?![a-zA-Z])|\u2297/g, '⊗').replace(/\\(?:odot)(?![a-zA-Z])|\u2299/g, '⊙');
      s = s.replace(/(\d)\s*[\.·×]\s*10\s*\^/g, '$1·10^');
      s = s.replace(/î€\s*=|\s*=/g, '≠');
      s = s.replace(/\\(?:neq|ne|not=)(?![a-zA-Z])/g, '≠');
      s = s.replace(/\\gt(?![a-zA-Z])/g, '>').replace(/\\lt(?![a-zA-Z])/g, '<');
      s = s.replace(/\\(?:ge|geq|geqslant)(?![a-zA-Z])|⩾/g, '≥').replace(/\\(?:le|leq|leqslant)(?![a-zA-Z])|⩽/g, '≤');
      s = s.replace(/\\(?:approx|thickapprox)(?![a-zA-Z])/g, '≈').replace(/\\(?:sim|thicksim)(?![a-zA-Z])|∼/g, '~');
      s = s.replace(/\\(?:simeq|cong)(?![a-zA-Z])|≃/g, '≅').replace(/\\equiv(?![a-zA-Z])/g, '≡').replace(/\\propto(?![a-zA-Z])/g, '∝');
      s = s.replace(/\\xrightarrow(?:\[[^\]]*\])?\{[^{}]*\}/g, '→').replace(/\\xleftarrow(?:\[[^\]]*\])?\{[^{}]*\}/g, '←');
      s = s.replace(/\\(?:to|rightarrow|longrightarrow|mapsto)(?![a-zA-Z])|⟶|↦/g, '→').replace(/\\(?:leftarrow|longleftarrow)(?![a-zA-Z])|⟵/g, '←');
      s = s.replace(/\\(?:leftrightarrow|longleftrightarrow)(?![a-zA-Z])|⟷/g, '↔');
      s = s.replace(/\\(?:Rightarrow|implies|Longrightarrow)(?![a-zA-Z])|⟹/g, '⇒').replace(/\\(?:Leftarrow|Longleftarrow)(?![a-zA-Z])|⟸/g, '⇐').replace(/\\(?:Leftrightarrow|iff|Longleftrightarrow)(?![a-zA-Z])|⟺/g, '⇔');
      s = s.replace(/\\(?:rightleftharpoons|leftrightarrows|equilibrium)(?![a-zA-Z])|⇄/g, '⇌');
      s = s.replace(/\\uparrow(?![a-zA-Z])/g, '↑').replace(/\\downarrow(?![a-zA-Z])/g, '↓');
      s = s.replace(/\\(?:land|wedge)(?![a-zA-Z])/g, '∧').replace(/\\(?:lor|vee)(?![a-zA-Z])/g, '∨').replace(/\\(?:lnot|neg)(?![a-zA-Z])/g, '¬');
      s = s.replace(/\\forall(?![a-zA-Z])/g, '∀').replace(/\\exists(?![a-zA-Z])/g, '∃').replace(/\\nexists(?![a-zA-Z])/g, '∄');
      s = s.replace(/\\in(?![a-zA-Z])/g, '∈').replace(/\\notin(?![a-zA-Z])/g, '∉').replace(/\\ni(?![a-zA-Z])/g, '∋');
      s = s.replace(/\\subset(?![a-zA-Z])/g, '⊂').replace(/\\supset(?![a-zA-Z])/g, '⊃').replace(/\\subseteq(?![a-zA-Z])/g, '⊆').replace(/\\supseteq(?![a-zA-Z])/g, '⊇');
      s = s.replace(/\\cup(?![a-zA-Z])/g, '∪').replace(/\\cap(?![a-zA-Z])/g, '∩').replace(/\\(?:setminus|backslash)(?![a-zA-Z])|∖/g, '\\');
      s = s.replace(/\\(?:emptyset|varnothing)(?![a-zA-Z])|⌀/g, '∅');
      s = s.replace(/\\mathbb\{R\}|\\mathbf\{R\}|\\bf R|ℝ/g, 'R').replace(/\\mathbb\{N\}|\\mathbf\{N\}|\\bf N|ℕ/g, 'N').replace(/\\mathbb\{Z\}|\\mathbf\{Z\}|\\bf Z|ℤ/g, 'Z').replace(/\\mathbb\{Q\}|\\mathbf\{Q\}|\\bf Q|ℚ/g, 'Q').replace(/\\mathbb\{C\}|\\mathbf\{C\}|\\bf C|ℂ/g, 'C').replace(/\\mathbb\{P\}|\\mathbf\{P\}|\\bf P|ℙ/g, 'P');
      s = s.replace(/\\iint(?![a-zA-Z])\s*|∬\s*/g, '∬').replace(/\\iiint(?![a-zA-Z])\s*|∭\s*/g, '∭').replace(/\\oint(?![a-zA-Z])\s*|∮\s*/g, '∮').replace(/\\int(?![a-zA-Z])\s*|∫\s*/g, '∫');
      s = s.replace(/\\partial(?![a-zA-Z])/g, '∂').replace(/\\nabla(?![a-zA-Z])/g, '∇');
      s = s.replace(/\\mathrm\{d\}|\\text\{d\}|\\rm d/g, 'd');
      s = s.replace(/\\infty(?![a-zA-Z])/g, '∞').replace(/\\lim(?![a-zA-Z])/g, 'lim').replace(/\\sum(?![a-zA-Z])/g, '∑').replace(/\\prod(?![a-zA-Z])/g, '∏');
      s = s.replace(/\\(?:arcsin|arccos|arctan|arccot|sinh|cosh|tanh|coth|sin|cos|tan|cot|sec|csc|ln|log|lg|exp)(?![a-zA-Z])/g, (m) => m.slice(1));
      s = s.replace(/\\tg(?![a-zA-Z])/g, 'tan').replace(/\\cotg(?![a-zA-Z])/g, 'cot');
      for (let f = 0; f < 4; f++) {
        s = s.replace(/\\(?:dfrac|frac|tfrac|cfrac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');
        s = s.replace(/\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, 'C($1,$2)');
      }
      s = s.replace(/\\sqrt\[3\]\s*\{([^{}]+)\}/g, '∛($1)').replace(/\\sqrt\[([^{}]+)\]\s*\{([^{}]+)\}/g, '√[$1]($2)').replace(/\\sqrt\s*\{([^{}]+)\}/g, '√($1)');
      s = s.replace(/√\s*([a-zA-Z0-9]+)/g, '√($1)');
      s = s.replace(/\\(?:overrightarrow|overleftarrow|vec|vect)\s*\{([^{}]+)\}/g, 'vectơ $1');
      s = s.replace(/\\(?:widehat|wideparen)\s*\{([^{}]+)\}/g, 'góc $1');
      s = s.replace(/\\(?:overline|bar|underline|hat)\s*\{([^{}]+)\}/g, '$1');
      s = s.replace(/\\perp(?![a-zA-Z])/g, '⊥').replace(/\\parallel(?![a-zA-Z])|\u2225/g, '∥').replace(/\\(?:angle|measuredangle|sphericalangle)(?![a-zA-Z])|∡|∢/g, '∠').replace(/\\(?:triangle|bigtriangleup|vartriangle)(?![a-zA-Z])/g, '△');
      s = s.replace(/\\Gamma(?![a-zA-Z])/g, 'Γ').replace(/\\Delta(?![a-zA-Z])|\u2206|𝛥/g, 'Δ').replace(/\\Theta(?![a-zA-Z])/g, 'Θ').replace(/\\Lambda(?![a-zA-Z])/g, 'Λ').replace(/\\Xi(?![a-zA-Z])/g, 'Ξ').replace(/\\Pi(?![a-zA-Z])/g, 'Π').replace(/\\Sigma(?![a-zA-Z])/g, 'Σ').replace(/\\Upsilon(?![a-zA-Z])/g, 'Υ').replace(/\\Phi(?![a-zA-Z])/g, 'Φ').replace(/\\Psi(?![a-zA-Z])/g, 'Ψ').replace(/\\Omega(?![a-zA-Z])|\u2126/g, 'Ω');
      s = s.replace(/\\alpha(?![a-zA-Z])/g, 'α').replace(/\\beta(?![a-zA-Z])/g, 'β').replace(/\\gamma(?![a-zA-Z])/g, 'γ').replace(/\\delta(?![a-zA-Z])/g, 'δ').replace(/\\(?:varepsilon|epsilon)(?![a-zA-Z])|ϵ/g, 'ε').replace(/\\zeta(?![a-zA-Z])/g, 'ζ').replace(/\\eta(?![a-zA-Z])/g, 'η').replace(/\\(?:vartheta|theta)(?![a-zA-Z])|ϑ/g, 'θ').replace(/\\iota(?![a-zA-Z])/g, 'ι').replace(/\\(?:varkappa|kappa)(?![a-zA-Z])/g, 'κ').replace(/\\lambda(?![a-zA-Z])/g, 'λ').replace(/\\(?:mu|micro)(?![a-zA-Z])|\u00B5/g, 'μ').replace(/\\nu(?![a-zA-Z])/g, 'ν').replace(/\\xi(?![a-zA-Z])/g, 'ξ').replace(/\\(?:varpi|pi)(?![a-zA-Z])/g, 'π').replace(/\\(?:varrho|rho)(?![a-zA-Z])|ϱ/g, 'ρ').replace(/\\(?:varsigma|sigma)(?![a-zA-Z])|ς/g, 'σ').replace(/\\tau(?![a-zA-Z])/g, 'τ').replace(/\\upsilon(?![a-zA-Z])/g, 'υ').replace(/\\(?:varphi|phi)(?![a-zA-Z])|\u03D5/g, 'φ').replace(/\\chi(?![a-zA-Z])/g, 'χ').replace(/\\psi(?![a-zA-Z])/g, 'ψ').replace(/\\omega(?![a-zA-Z])/g, 'ω');
      s = s.replace(/\\hbar(?![a-zA-Z])/g, 'ℏ').replace(/\\ell(?![a-zA-Z])/g, 'ℓ').replace(/\\AA(?![a-zA-Z])|\u212B/g, 'Å');
      s = s.replace(/\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|limits|nolimits|left|right|big|Big|bigg|Bigg|middle)(?![a-zA-Z])/g, '');
      for (let t = 0; t < 3; t++) {
        s = s.replace(/\\(?:mathrm|text|mbox|hbox|mathit|mathbf|mathsf|mathcal|mathscr|mathfrak|textbf|textit|textrm|operatorname)\s*\{([^{}]*)\}/g, '$1');
      }
      s = s.replace(/\\(?:quad|qquad|space|thinspace|enspace|;|!|,|:)(?![a-zA-Z])/g, ' ');
      s = s.replace(/\\\(\s*|\s*\\\)/g, ' ').replace(/\\\[\s*|\s*\\\]/g, ' ').replace(/\$+/g, '');
      s = s.replace(/[\uE000-\uF8FF]/g, '');
      s = s.replace(/\^\{\s*([a-zA-Z0-9+\-]+)\s*\}/g, '^$1').replace(/\^\(\s*([a-zA-Z0-9+\-]+)\s*\)/g, '^$1');
      s = s.replace(/_\{\s*([a-zA-Z0-9+\-]+)\s*\}/g, '_$1').replace(/_\(\s*([a-zA-Z0-9+\-]+)\s*\)/g, '_$1');
      s = s.replace(/\s*\^\s*/g, '^').replace(/\s*_\s*/g, '_');
      s = s.replace(/\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)\s*\/\s*\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)/g, '$1/$2');
      s = s.replace(/\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)\s*\//g, '$1/');
      s = s.replace(/\/\s*\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)/g, '/$1');
      s = s.replace(/\s*([,;])\s*/g, '$1 ');
      s = s.replace(/(\d)\s*,\s*(\d)/g, '$1,$2');
      s = s.replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')');
      s = s.replace(/\s*\[\s*/g, '[').replace(/\s*\]\s*/g, ']');
      s = s.replace(/[{}]/g, ''); // Bỏ các dấu ngoặc nhọn phân nhóm còn sót lại trong công thức hóa học/toán học LaTeX
      s = s.replace(/\s+/g, ' ').trim();
      if (opt.stripSubSupMarkers) {
        s = s.replace(/[\^_]\(?([a-zA-Z0-9+\-]+)\)?/g, '$1');
      }
      if (opt.ignoreCase) s = s.toLowerCase();
      return s;
    };
    const cleanMathStr = cleanScience;
    const looseScienceKey = (str) => cleanScience(str, { ignoreCase: true, stripSubSupMarkers: true }).replace(/[\s\.\·\(\)]+/g, '');

    // B. Form 2: TRẮC NGHIỆM ĐƠN / NHIỀU ĐÁP ÁN / CÂU HỎI CHÙM (Radio / Checkbox - q_type: 1, 12, 22)
    const selectAnswers = ans.selectTextAnswers || (ans.answer ? String(ans.answer).split(';').map(s => s.trim()) : []);
    const selectTriggers = getAllDeep('button.select-option, .select-option, select.selecttext, select');
    if (selectTriggers.length > 0 && selectAnswers.length > 0) {
      let filledDropdownCount = 0;
      const filledDetails = [];

      for (let sIdx = 0; sIdx < selectTriggers.length && sIdx < selectAnswers.length; sIdx++) {
        const trigger = selectTriggers[sIdx];
        const targetVal = selectAnswers[sIdx].toLowerCase();

        if (trigger.tagName === 'SELECT') {
          const opt = Array.from(trigger.options).find(o => o.text.trim().toLowerCase() === targetVal || o.value.trim().toLowerCase() === targetVal);
          if (opt) {
            trigger.value = opt.value;
            trigger.dispatchEvent(new Event('change', { bubbles: true }));
            filledDropdownCount++;
            filledDetails.push(opt.text.trim());
          }
        } else {
          const box = trigger.closest('.box-select-text, .selecttext-box, p, div')?.querySelector('.box-select-option') ||
            root.querySelectorAll('.box-select-option')[sIdx];

          let clickedOption = false;
          if (box) {
            const items = Array.from(box.querySelectorAll('.select-option-item'));
            const matchItem = items.find(it => (it.innerText || '').trim().toLowerCase() === targetVal);
            if (matchItem) {
              matchItem.click();
              clickedOption = true;
              filledDropdownCount++;
              filledDetails.push((matchItem.innerText || '').trim());
            }
          }
          if (!clickedOption) {
            trigger.click();
            const allItems = Array.from(root.querySelectorAll('.select-option-item'));
            const matchItem = allItems.find(it => (it.innerText || '').trim().toLowerCase() === targetVal && (it.offsetWidth > 0 || it.offsetHeight > 0));
            if (matchItem) {
              matchItem.click();
              filledDropdownCount++;
              filledDetails.push((matchItem.innerText || '').trim());
            }
          }
        }
      }

      if (filledDropdownCount > 0) {
        return { ok: true, method: 'select-text', text: filledDetails.join(' | ') };
      }
    }

    let targetInds = ans.correctIndices || (ans.correctIndex >= 0 ? [ans.correctIndex] : []);
    if (Array.isArray(ans.statements) && ans.statements.length > 0) {
      targetInds = ans.statements.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    } else if (ans.isTrueFalse && Array.isArray(ans.tfAnswers) && ans.tfAnswers.length > 0) {
      // Nếu câu Đúng/Sai hiển thị dưới dạng danh sách .qselect (Chọn các phát biểu đúng):
      // Chỉ lấy index của các mệnh đề có value === 1 (Đúng)
      targetInds = ans.tfAnswers
        .filter((t) => Number(t.value) === 1)
        .map((t, idx) => (t.index !== undefined ? Number(t.index) : idx));
    }

    const rawQSelects = getAllDeep('[ind], [data-ind], .qselect').filter(
      (o) => (o.offsetWidth > 0 || o.offsetHeight > 0) && !o.closest('.exp, .explanation, .giai-chi-tiet, .loigiai') && !o.closest('.tf-box') && !o.hasAttribute('data-tf-value')
    );
    const activeQSelects = rawQSelects.filter((o) => !o.classList.contains('disable-event') && !o.closest('.disable-event'));
    const allOpts = activeQSelects.length > 0 ? activeQSelects : rawQSelects;
    const hasQSelectOptions = allOpts.length > 0;

    if (Array.isArray(targetInds) && targetInds.length > 0 && (!ans.isTrueFalse || hasQSelectOptions)) {
      let clickedCount = 0;
      const clickedTexts = [];
      const hasCheckbox = getAllDeep('.qcheckbox, input[type="checkbox"]').length > 0;
      const targetSet = new Set(targetInds.map(Number));

      // Tập hợp nội dung text của các đáp án đúng để hỗ trợ trường hợp đảo vị trí hoặc fallback AI
      const trueTextsClean = new Set();
      const trueTextsLoose = new Set();
      if (ans.isTrueFalse && Array.isArray(ans.tfAnswers)) {
        ans.tfAnswers
          .filter((t) => Number(t.value) === 1 && t.text)
          .forEach((t) => {
            const c = cleanMathStr(t.text);
            if (c) trueTextsClean.add(c);
            const l = looseScienceKey(t.text);
            if (l) trueTextsLoose.add(l);
          });
      } else if (Array.isArray(ans.correctTexts) && ans.correctTexts.length > 0) {
        ans.correctTexts.forEach((t) => {
          const c = cleanMathStr(t);
          if (c) trueTextsClean.add(c);
          const l = looseScienceKey(t);
          if (l) trueTextsLoose.add(l);
        });
      }

      // Kiểm tra xem đây có phải dạng Câu hỏi chùm / Tổ hợp nhiều câu trắc nghiệm con trong 1 màn hình (q_type 22)
      const zeroIndCount = allOpts.filter((o) => (o.getAttribute('ind') ?? o.getAttribute('data-ind')) === '0').length;
      const isCompoundMultiQ =
        (Array.isArray(ans.subQuestions) && ans.subQuestions.length > 1) ||
        (allOpts.length >= 8 && zeroIndCount >= 2);

      if (isCompoundMultiQ && allOpts.length >= 4) {
        // Nhóm các phương án theo từng câu hỏi con (<ol class="quiz-list">, host <type-quiz-x-mobile>, ranh giới ind="0", hoặc fallback chu kỳ 4)
        let optGroups = [];
        const groupMap = new Map();
        for (const o of allOpts) {
          const rootNode = o.getRootNode ? o.getRootNode() : null;
          const shadowHost = (rootNode && rootNode.host && /type-quiz/i.test(rootNode.host.tagName || '')) ? rootNode.host : null;
          const parentList = o.closest('ol.quiz-list, ul.quiz-list, .quiz-list, .one-quiz-item, .quiz-item, .sub-quiz, .question-part, [data-sub-index], [data-question-id], ol, ul, .sub-question') || shadowHost;
          if (parentList) {
            if (!groupMap.has(parentList)) groupMap.set(parentList, []);
            groupMap.get(parentList).push(o);
          }
        }
        if (groupMap.size >= 2) {
          optGroups = Array.from(groupMap.values());
        } else if (zeroIndCount >= 2) {
          let currentGroup = [];
          for (const o of allOpts) {
            const rawInd = o.getAttribute('ind') ?? o.getAttribute('data-ind');
            if (rawInd === '0' && currentGroup.length > 0) {
              optGroups.push(currentGroup);
              currentGroup = [];
            }
            currentGroup.push(o);
          }
          if (currentGroup.length > 0) optGroups.push(currentGroup);
        } else {
          for (let i = 0; i < allOpts.length; i += 4) {
            optGroups.push(allOpts.slice(i, i + 4));
          }
        }

        const subQuestionsList = Array.isArray(ans.subQuestions) ? ans.subQuestions : [];
        const usedSubQIndices = new Set();

        for (let gIdx = 0; gIdx < optGroups.length; gIdx++) {
          const groupOpts = optGroups[gIdx];
          let subQ = null;

          // Tìm câu hỏi con khớp chính xác với bộ 4 phương án trên màn hình (chống đảo thứ tự câu con trong <type-mix>)
          if (subQuestionsList.length > 0) {
            const domTextsClean = groupOpts.map((el) => cleanScience(extractOptionCleanText(el)));
            const domTextsLoose = groupOpts.map((el) => looseScienceKey(extractOptionCleanText(el)));
            let bestSubIdx = -1;
            let bestScore = 0;

            for (let sIdx = 0; sIdx < subQuestionsList.length; sIdx++) {
              if (usedSubQIndices.has(sIdx)) continue;
              const cand = subQuestionsList[sIdx];
              const candOpts = Array.isArray(cand.options) ? cand.options : [];
              if (candOpts.length === 0) continue;

              let score = 0;
              for (const cOptRaw of candOpts) {
                const cOptClean = cleanScience(cOptRaw);
                const cOptLoose = looseScienceKey(cOptRaw);
                if (cOptClean && domTextsClean.includes(cOptClean)) {
                  score += 3;
                } else if (cOptLoose && domTextsLoose.includes(cOptLoose)) {
                  score += 2;
                }
              }
              if (score > bestScore) {
                bestScore = score;
                bestSubIdx = sIdx;
                if (score >= candOpts.length * 3) break;
              }
            }

            if (bestSubIdx >= 0 && bestScore >= 4) {
              usedSubQIndices.add(bestSubIdx);
              subQ = subQuestionsList[bestSubIdx];
            } else if (!usedSubQIndices.has(gIdx) && subQuestionsList[gIdx]) {
              usedSubQIndices.add(gIdx);
              subQ = subQuestionsList[gIdx];
            }
          }

          let pickedEl = null;

          if (subQ && subQ.correctText) {
            const cSubAns = cleanScience(subQ.correctText);
            const cSubAnsNoSpace = cSubAns.replace(/\s+/g, '');
            const cSubLoose = looseScienceKey(subQ.correctText);
            pickedEl =
              groupOpts.find((el) => {
                const cOpt = cleanScience(extractOptionCleanText(el));
                return cOpt && (cOpt === cSubAns || cOpt.replace(/\s+/g, '') === cSubAnsNoSpace);
              }) ||
              groupOpts.find((el) => {
                const lOpt = looseScienceKey(extractOptionCleanText(el));
                return lOpt && lOpt === cSubLoose;
              }) ||
              null;
          }

          if (!pickedEl && subQ && Number.isInteger(subQ.correctIndex) && subQ.correctIndex >= 0) {
            pickedEl =
              groupOpts.find((el) => Number(el.getAttribute('ind') ?? el.getAttribute('data-ind')) === subQ.correctIndex) ||
              groupOpts[subQ.correctIndex] ||
              null;
          }

          if (!pickedEl && !subQ && trueTextsClean.size > 0) {
            pickedEl = groupOpts.find((el) => trueTextsClean.has(cleanMathStr(extractOptionCleanText(el)))) || null;
          }

          if (pickedEl) {
            const clickTarget = pickedEl.querySelector('.qiradio, input[type=radio], .qicheckbox, input[type=checkbox], label') || pickedEl;
            try { clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
            HTMLElement.prototype.click.call(clickTarget);
            clickedCount++;
            clickedTexts.push(extractOptionCleanText(pickedEl) || `Câu con ${gIdx + 1}`);
          }
        }

        if (optGroups.length) {
          return { ok: clickedCount === optGroups.length, method: 'compound-subquestions', text: `Đã chọn ${clickedCount}/${optGroups.length} câu trắc nghiệm con` };
        }
      }

      const isMulti = targetInds.length > 1 || hasCheckbox || Boolean(ans.isTrueFalse && hasQSelectOptions);
      const uniqueOpts = new Map();
      allOpts.forEach((o, fallbackIdx) => {
        const rawInd = o.getAttribute('ind') ?? o.getAttribute('data-ind');
        const ind = rawInd !== null && rawInd !== '' ? Number(rawInd) : fallbackIdx;
        if (Number.isInteger(ind) && !uniqueOpts.has(ind)) uniqueOpts.set(ind, o);
      });

      if (isMulti && uniqueOpts.size > 0) {
        for (const [ind, el] of uniqueOpts.entries()) {
          const rawInd = el.getAttribute('ind') ?? el.getAttribute('data-ind');
          const hasExplicitInd = rawInd !== null && rawInd !== '';
          const optRaw = extractOptionCleanText(el);
          const optClean = cleanMathStr(optRaw);
          const optLoose = looseScienceKey(optRaw);
          const isTextMatched = (optClean && trueTextsClean.has(optClean)) || (optLoose && trueTextsLoose.has(optLoose));

          // Nếu có thuộc tính ind rõ ràng từ DOM và targetSet có phần tử -> Ưu tiên 100% targetSet từ OLM API
          // Nếu không có ind DOM hoặc targetSet rỗng -> So khớp theo nội dung text (chuẩn hóa science)
          const shouldSelect = (hasExplicitInd && targetSet.size > 0)
            ? targetSet.has(ind)
            : (isTextMatched || targetSet.has(ind));
          const input = el.querySelector('input[type="checkbox"], input[type="radio"]') || (el.tagName === 'INPUT' ? el : null);
          const isCurrentlySelected =
            (input && input.checked) ||
            el.classList.contains('qchecked') ||
            el.classList.contains('tw-selected') ||
            el.classList.contains('active') ||
            el.classList.contains('underlined') ||
            el.classList.contains('selected') ||
            !!el.querySelector('input:checked');

          // Chỉ click khi trạng thái hiện tại KHÁC với trạng thái mong muốn
          // Tuyệt đối không bắn 2 sự kiện click liên tiếp trên cùng 1 checkbox vì sẽ làm đảo trạng thái Bật -> Tắt!
          if (isCurrentlySelected !== shouldSelect) {
            const clickTarget = input || el.querySelector('.qicheckbox, .qiradio, label') || el;
            try { clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
            HTMLElement.prototype.click.call(clickTarget);
            const afterFirstClick =
              (input && input.checked) ||
              el.classList.contains('qchecked') ||
              el.classList.contains('tw-selected') ||
              el.classList.contains('active') ||
              el.classList.contains('underlined') ||
              el.classList.contains('selected') ||
              !!el.querySelector('input:checked');
            if (afterFirstClick !== shouldSelect && clickTarget !== el) {
              HTMLElement.prototype.click.call(el);
            }
          }
          if (shouldSelect) {
            clickedCount++;
            clickedTexts.push(extractOptionCleanText(el) || el.innerText.trim() || `Option ${ind + 1}`);
          }
        }
      } else {
        // Single choice:
        let selectedEl = null;
        const primaryInd = Number(targetInds[0]);
        const targetAnsText = String(ans.answer || ans.correctText || '').trim();
        const cTargetAns = cleanScience(targetAnsText);
        const cTargetAnsLower = cleanScience(targetAnsText, { ignoreCase: true });
        const cTargetAnsNoSpace = cTargetAns.replace(/\s+/g, '');
        const cTargetAnsLowerNoSpace = cTargetAnsLower.replace(/\s+/g, '');
        const cTargetLoose = looseScienceKey(targetAnsText);

        // Tầng 1 (Chính xác tuyệt đối 100%): Khớp CẢ biểu thức khoa học VÀ đúng thuộc tính ind gốc từ API OLM
        if (cTargetAns && Number.isInteger(primaryInd) && primaryInd >= 0) {
          selectedEl = allOpts.find((el) => {
            const rawInd = el.getAttribute('ind') ?? el.getAttribute('data-ind');
            const cOpt = cleanScience(extractOptionCleanText(el));
            return rawInd !== null && rawInd !== '' && Number(rawInd) === primaryInd && (cOpt === cTargetAns || cOpt.replace(/\s+/g, '') === cTargetAnsNoSpace);
          }) || null;
        }

        // Tầng 2: So khớp exact science formula (giữ nguyên chữ hoa F != f, đạo hàm ', khoảng [a;b] != (a;b))
        if (!selectedEl && cTargetAns) {
          const exactMatches = allOpts.filter((el) => {
            const cOpt = cleanScience(extractOptionCleanText(el));
            return cOpt && (cOpt === cTargetAns || cOpt.replace(/\s+/g, '') === cTargetAnsNoSpace);
          });
          if (exactMatches.length === 1) {
            selectedEl = exactMatches[0];
          } else if (exactMatches.length > 1 && Number.isInteger(primaryInd) && primaryInd >= 0) {
            selectedEl = exactMatches.find((el) => Number(el.getAttribute('ind') ?? el.getAttribute('data-ind')) === primaryInd) || exactMatches[0];
          }
        }

        // Tầng 3: Nếu có thuộc tính [ind="..."] / [data-ind="..."] trùng khớp với API OLM
        if (!selectedEl && ans.source !== 'ai-engine' && Number.isInteger(primaryInd) && primaryInd >= 0) {
          selectedEl = allOpts.find((el) => {
            const rawInd = el.getAttribute('ind') ?? el.getAttribute('data-ind');
            return rawInd !== null && rawInd !== '' && Number(rawInd) === primaryInd;
          }) || null;
        }

        // Tầng 4: So khớp nới lỏng (không phân biệt hoa thường & bỏ khác biệt sup/sub m^2 vs m2 khi không có xung đột)
        if (!selectedEl && cTargetAnsLower) {
          const lowerMatches = allOpts.filter((el) => {
            const rawOpt = extractOptionCleanText(el);
            const cOpt = cleanScience(rawOpt, { ignoreCase: true });
            return cOpt && (
              cOpt === cTargetAnsLower ||
              cOpt.replace(/\s+/g, '') === cTargetAnsLowerNoSpace ||
              (cTargetLoose.length >= 2 && looseScienceKey(rawOpt) === cTargetLoose)
            );
          });
          if (lowerMatches.length === 1) {
            selectedEl = lowerMatches[0];
          } else if (lowerMatches.length > 1 && Number.isInteger(primaryInd) && primaryInd >= 0) {
            selectedEl = lowerMatches.find((el) => Number(el.getAttribute('ind') ?? el.getAttribute('data-ind')) === primaryInd) || lowerMatches[0];
          }
        }

        // Tầng 5: So khớp một phần text (partial match cho câu tự luận/diễn giải)
        if (!selectedEl && cTargetAnsLower && cTargetAnsLower.length >= 4) {
          const partialMatches = allOpts.filter((el) => {
            const cOpt = cleanScience(extractOptionCleanText(el), { ignoreCase: true });
            return cOpt && cOpt.length >= 4 && (cOpt.includes(cTargetAnsLower) || cTargetAnsLower.includes(cOpt));
          });
          if (partialMatches.length === 1) {
            selectedEl = partialMatches[0];
          }
        }

        // Tầng 6: Fallback theo vị trí hiển thị
        if (!selectedEl && Number.isInteger(primaryInd) && primaryInd >= 0) {
          selectedEl = uniqueOpts.get(primaryInd) || allOpts[primaryInd] || null;
        }

        if (selectedEl) {
          const clickTarget = selectedEl.querySelector('.qiradio, input[type=radio], .qicheckbox, input[type=checkbox], label') || selectedEl;
          try { clickTarget.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) { }
          HTMLElement.prototype.click.call(clickTarget);
          clickedCount++;
          clickedTexts.push(extractOptionCleanText(selectedEl) || selectedEl.innerText.trim() || `Option ${primaryInd + 1}`);
        }
      }

      if (clickedCount > 0) {
        return { ok: true, method: 'inds', text: clickedTexts.join(' | ') };
      }
    }

    // C. Form 3: CÔNG THỨC TOÁN (MathQuill / LaTeX - q_type: 2)
    const isBogusAnswerStr = (v) => {
      const s = String(v ?? '').trim();
      if (!s) return true;
      if (/^@.*@$|@(?:p\.|Math\.)/.test(s)) return true;
      if (/^(?:không xác định|chưa thể xác định|unresolved)$/i.test(s)) return true;
      if (/^[\s;,\.\|\-]+$/.test(s)) return true;
      return false;
    };
    const rawVal = ans.answer || ans.correctText || '';
    const mqFields = getAllDeep('.mq-editable-field, .mathquill-rendered-math, .mq-root-block')
      .filter((e) => e.offsetWidth > 0 || e.offsetHeight > 0);
    if (mqFields.length > 0 && rawVal && !isBogusAnswerStr(rawVal)) {
      const mq = mqFields[0];
      // Gọi trực tiếp API nội bộ MathQuill trên window của OLM
      try {
        const MQ = window.MathQuill?.getInterface ? window.MathQuill.getInterface(2) : (window.MQ || null);
        if (MQ && typeof MQ === 'function') {
          const mqInst = MQ(mq);
          if (mqInst && typeof mqInst.latex === 'function') {
            mqInst.latex(rawVal);
          }
        }
      } catch { }

      const mqTextarea = mq.querySelector('textarea.mq-textarea, textarea') || getAllDeep('textarea.mq-textarea')[0];
      if (mqTextarea) {
        mqTextarea.focus();
        mqTextarea.value = rawVal;
        mqTextarea.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        mqTextarea.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        mqTextarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
      }
      return {
        ok: true,
        method: 'mathquill',
        text: rawVal
      };
    }

    // D. Form 4: ĐIỀN Ô TRỐNG & TỰ LUẬN (Textarea typing-para, text input, blank, contenteditable)
    const targetText = String(ans.answer || ans.correctText || '').trim();
    const validMultiAnswers = Array.isArray(ans.answers)
      ? ans.answers.map((v) => String(v ?? '').trim()).filter((v) => !isBogusAnswerStr(v))
      : [];
    if ((!isBogusAnswerStr(targetText) || validMultiAnswers.length > 0) && !ans.isTrueFalse) {
      // 1. Dạng đề thi THPT Phần III (Trả lời ngắn / Điền số dạng input placeholder="?")
      const fillMeInput = getAllDeep('input[placeholder="?"], input[data-fillme-placeholder="?"], input.trigger-curriculum-cate', root)
        .find((el) => (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) && !isBogusAnswerStr(targetText));
      if (fillMeInput) {
        try { fillMeInput.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { }
        fillMeInput.focus();
        if (fillMeInput._valueTracker) {
          try { fillMeInput._valueTracker.setValue(''); } catch { }
        }
        const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setVal) setVal.call(fillMeInput, targetText); else fillMeInput.value = targetText;
        const hostWc = fillMeInput.getRootNode()?.host;
        if (hostWc && typeof hostWc.onChange === 'function') {
          try { hostWc.onChange({ currentTarget: fillMeInput, target: fillMeInput }); } catch {}
        }
        fillMeInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        fillMeInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        fillMeInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        fillMeInput.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        fillMeInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        const r = fillMeInput.getBoundingClientRect();
        return {
          ok: true,
          method: 'fillme-input',
          text: targetText,
          needsKeyboard: true,
          inputBox: r.width > 0 && r.height > 0 ? { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 } : null
        };
      }

      const primaryInputs = getAllDeep('type-fill-me-mobile input, type-fill-me input, textarea.typing-para, textarea.text-para, textarea[placeholder*="câu trả lời"], textarea, .input-ans, .blank, input.tw-input-content-default-md, input[type=text], input:not([type]), [contenteditable="true"]')
        .filter((el) => {
          if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return false;
          const name = el.getAttribute('name') || '';
          const id = el.getAttribute('id') || '';
          if (/otp|phone|consult|search|filter/i.test(name + ' ' + id)) return false;
          return el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'submit' && el.type !== 'button';
        });

      // Hỗ trợ điền nhiều ô trống cùng lúc trong 1 câu (Multi-blank)
      if (primaryInputs.length > 1 && validMultiAnswers.length >= primaryInputs.length) {
        primaryInputs.forEach((inputEl, idx) => {
          const val = validMultiAnswers[idx] !== undefined ? String(validMultiAnswers[idx]).trim() : '';
          if (!val || isBogusAnswerStr(val)) return;
          try { inputEl.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { }
          inputEl.focus();
          if (inputEl._valueTracker) {
            try { inputEl._valueTracker.setValue(''); } catch { }
          }
          const proto = inputEl instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setVal = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setVal) setVal.call(inputEl, val); else inputEl.value = val;
          inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          inputEl.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          inputEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        });
        return {
          ok: true,
          method: 'multi-blank',
          text: validMultiAnswers.join(' | '),
          needsKeyboard: false
        };
      }

      const inp = (!isBogusAnswerStr(targetText) && primaryInputs.length <= 1)
        ? (primaryInputs[0] || getAllDeep('textarea.typing-para, textarea, input.tw-input-content-default-md, input[type=text], input:not([type]), [contenteditable="true"]')
            .find((el) => (el.offsetWidth > 0 || el.offsetHeight > 0) && !/otp|phone|consult/i.test((el.name || '') + ' ' + (el.id || ''))))
        : null;

      if (inp) {
        try { inp.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { }
        inp.focus();

        if (inp.tagName === 'TEXTAREA' || inp.tagName === 'INPUT') {
          if (inp._valueTracker) {
            try { inp._valueTracker.setValue(''); } catch { }
          }
          // Gán qua prototype descriptor + phát đủ 5 sự kiện chuẩn: input, change, keyup (Enter), blur, focusout
          const proto = inp instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setVal = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setVal) setVal.call(inp, targetText); else inp.value = targetText;

          inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
          inp.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
          inp.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        } else {
          inp.innerText = targetText;
          inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        }

        const r = inp.getBoundingClientRect();
        const isLexicalPara = inp.classList?.contains('typing-para') || inp.classList?.contains('text-para') || String(inp.placeholder || '').includes('câu trả lời');
        return {
          ok: true,
          method: isLexicalPara ? 'lexical-para' : 'input-typed',
          isLexicalPara,
          text: targetText,
          needsKeyboard: true,
          inputBox: r.width > 0 && r.height > 0 ? { x: r.x + Math.min(100, r.width / 2), y: r.y + Math.min(30, r.height / 2) } : null
        };
      }

      // E. Form 5: DROPDOWN / MENU THẢ XUỐNG (<select> - Chuẩn hóa NFC tiếng Việt và xóa &nbsp;)
      const selects = getAllDeep('select, .custom-select').filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      if (selects.length > 0) {
        const sel = selects[0];
        if (sel.tagName === 'SELECT') {
          const cleanText = (str) => String(str || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
          const normTarget = cleanText(targetText);
          const opt = Array.from(sel.options).find((o) => {
            const normText = cleanText(o.text);
            const normVal = cleanText(o.value);
            return normText === normTarget || normVal === normTarget || normText.includes(normTarget);
          });
          if (opt) {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, method: 'select', text: opt.text };
          }
        }
      }

      // F. Khớp theo text trong các option nếu không có thuộc tính ind (sort độ dài giảm dần để ưu tiên option dài nhất)
      const cleanStr = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
      const opts = getAllDeep('.qselect, .choice-item, .ans-item').filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      const sortedOpts = [...opts].sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
      const matched = sortedOpts.find((el) => {
        const cEl = cleanStr(el.innerText);
        const cTarget = cleanStr(targetText);
        return cEl && cTarget && (cEl === cTarget || cEl.includes(cTarget) || cTarget.includes(cEl));
      });
      if (matched) {
        matched.click();
        return { ok: true, method: 'text', text: matched.innerText.trim() };
      }
    }

    // G. Chẩn đoán DevTools (DevTools Diagnostic Snapshot):
    const interactiveElements = getAllDeep('button, input, select, textarea, [contenteditable], [ind], [data-ind], [role], [data-tf-value], .qselect, .mq-editable-field')
      .filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)
      .slice(0, 10)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: el.className ? String(el.className).slice(0, 50) : undefined,
        ind: el.getAttribute('ind') || el.getAttribute('data-ind') || undefined,
        role: el.getAttribute('role') || undefined,
        type: el.type || undefined,
        tf: el.getAttribute('data-tf-value') || undefined,
        text: (el.innerText || el.value || '').trim().slice(0, 30) || undefined,
      }));

    return { ok: false, reason: 'no-matching-control', diagnostic: interactiveElements };
  }, targetAnswer, scope).finally(() => scope.dispose());

  // 3. Nếu input cần gõ bàn phím ảo (Textarea tự luận, text input, MathQuill)
  if (evalRes.ok && evalRes.needsKeyboard) {
    const textToType = String(evalRes.text || targetAnswer.answer || targetAnswer.correctText || '').trim();
    if (textToType) {
      if (evalRes.inputBox && evalRes.inputBox.x > 0 && evalRes.inputBox.y > 0) {
        await page.mouse.click(evalRes.inputBox.x, evalRes.inputBox.y);
        await H.sleep(200);
      }
      if (evalRes.isLexicalPara) {
        const edBox = await page.evaluate(() => {
          const ed = document.querySelector('div[contenteditable="true"], div.ContentEditable__root');
          if (!ed) return null;
          ed.focus();
          const r = ed.getBoundingClientRect();
          return { x: r.x + 50, y: r.y + Math.min(30, r.height / 2) };
        });
        if (edBox) {
          await page.mouse.click(edBox.x, edBox.y);
          await H.sleep(150);
        }
      } else {
        await page.evaluate(() => {
          const ed = document.querySelector('div[contenteditable="true"], div.ContentEditable__root');
          if (ed) ed.focus();
        }).catch(() => { });
      }
      // Xóa sạch nội dung cũ nếu có
      await page.keyboard.down('Control').catch(() => { });
      await page.keyboard.press('KeyA').catch(() => { });
      await page.keyboard.up('Control').catch(() => { });
      await page.keyboard.press('Backspace').catch(() => { });

      // Đối với Lexical hoặc văn bản tự luận dài: Dùng CDP Input.insertText tức thì (1ms) + đồng bộ _valueTracker
      if (evalRes.isLexicalPara || textToType.length > 25 || textToType.includes('\n')) {
        try {
          const client = await page.target().createCDPSession();
          try {
            await client.send('Input.insertText', { text: textToType });
          } finally {
            await client.detach().catch(() => { });
          }
        } catch {
          await page.keyboard.type(textToType, { delay: 5 }).catch(() => { });
        }
        if (!evalRes.isLexicalPara) {
          await page.evaluate((val) => {
            const el = document.activeElement;
            if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
              if (el._valueTracker) {
                try { el._valueTracker.setValue(''); } catch { }
              }
              const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setVal = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setVal) setVal.call(el, val); else el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
              el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }
          }, textToType).catch(() => { });
        }
      } else {
        await page.keyboard.type(textToType, { delay: 15 }).catch(() => { });
      }
      await H.sleep(150);
      // Click ra ngoài để kích hoạt change/blur event
      await page.mouse.click(10, 10).catch(() => { });
      await H.sleep(100);
    }
  }

  // 4. Nếu không điền được và có diagnostic DevTools snapshot
  if (!evalRes.ok && evalRes.diagnostic && evalRes.diagnostic.length > 0 && log) {
    const diagSummary = evalRes.diagnostic.map((d) => `<${d.tag}${d.id ? ' #' + d.id : ''}${d.ind !== undefined ? ' ind=' + d.ind : ''}${d.tf !== undefined ? ' tf=' + d.tf : ''}>`).join(', ');
    log('warn', `🔍 [DevTools Snapshot] Thẻ tương tác tìm thấy: ${diagSummary}`);
  }

  // 5. Không handler nào khớp -> Adaptive Solver (quét DevTools + AI lập kế hoạch + thao tác thật + kiểm chứng)
  if (!evalRes.ok && !question?.__noAdaptive) {
    try {
      const adaptive = require('./adaptive-solver');
      const adRes = await adaptive.solveAdaptively(page, { knownAnswer: targetAnswer, log, questionIndex: question.index });
      if (adRes.ok) return { ...adRes, ok: true };
      if (adRes.isResultScreen) {
        return { ...evalRes, ok: false, isResultScreen: true, score: adRes.score || null, reason: 'no-question-on-screen' };
      }
    } catch (e) {
      if (log) log('warn', `🧠 [Adaptive] Lỗi: ${e.message}`);
    }
  }

  return evalRes;
}

async function fillCurrentQuestion(page, question, answer, log = null) {
  if (!answer || answer.unresolved) {
    const liveDomAnswer = await extractLiveDomAnswer(page, question.index);
    if (liveDomAnswer && !liveDomAnswer.unresolved) {
      answer = liveDomAnswer;
      if (log) log('info', `🎯 [DevTools Live DOM] Đọc được đáp án từ DevTools (${liveDomAnswer.source || 'DOM'}): ${liveDomAnswer.answer || liveDomAnswer.correctText || JSON.stringify(liveDomAnswer.fillAnswers || liveDomAnswer.tfAnswers)}`);
    } else {
      if (question.__noAdaptive) return { ok: false, reason: 'no-answer' };
      const adaptive = require('./adaptive-solver');
      return adaptive.solveAdaptively(page, { log, questionIndex: question.index });
    }
  }
  // 1. Short Answer / Fill-me (<type-fill-me-mobile>, <type-paragraph-mobile>, input, textarea)
  if (['short_answer', 'strict_short_answer', 'fill_me'].includes(question.type)) {
    const result = await fillShortAnswer(page, question, answer);
    if (result.ok || question.__noAdaptive) return result;
    const adaptive = require('./adaptive-solver');
    return adaptive.solveAdaptively(page, { knownAnswer: answer, log, questionIndex: question.index });
  }

  if (question.type === 'true_false' || answer.isTrueFalse || answer.tfAnswers?.length) {
    const result = await fillTrueFalse(page, question, answer);
    if (result.ok || question.__noAdaptive) return result;
    const adaptive = require('./adaptive-solver');
    return adaptive.solveAdaptively(page, { knownAnswer: answer, log, questionIndex: question.index });
  }

  // 2b. Các dạng câu hỏi mở rộng (dropdown, kéo-thả, gom nhóm, ghép đôi,
  //     hotspot, gạch chân, tự luận) -> xử lý ở module chuyên dụng.
  if (extendedTypes.isExtended(question.type)) {
    return inspectAndFillAnyQuestion(page, answer, question, log);
  }

  // 3. Multi-choice / "Chọn những câu đúng thôi" (<type-quiz-multi-mobile>)
  if (question.type === 'multi_choice') {
    const scope = await page.evaluateHandle(questionScopeScript, question.index || 0);
    if (!scope.asElement()) {
      await scope.dispose();
      return { ok: false, reason: 'question-scope-missing' };
    }
    return page.evaluate((answer, surface) => {
      const root = surface.shadowRoot || surface;
      const quiz = root.querySelector('type-quiz-multi-mobile, type-quiz-multi, type-quiz-x-mobile, type-quiz-x');
      const compRoot = quiz?.shadowRoot || quiz || root;
      const optionEls = Array.from(compRoot.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option'));
      if (!optionEls.length) return { ok: false, reason: 'no-options-found' };
      if (optionEls.some((el) => el.hasAttribute('ind') || el.hasAttribute('data-ind'))) {
        optionEls.sort((a, b) => {
          const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
          const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
          if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
          return 0;
        });
      }

      const correctSet = new Set(Array.isArray(answer.correctIndices) ? answer.correctIndices : []);
      // KHÔNG tự chọn đáp án A khi AI không xác định được.
      if (!correctSet.size) return { ok: false, reason: 'no-correct-indices' };
      let selected = 0;
      optionEls.forEach((el, idx) => {
        const shouldSelect = correctSet.has(idx);
        const isSelected = el.classList.contains('tw-selected') || el.classList.contains('selected') || el.classList.contains('active') || !!el.querySelector('input:checked');
        if (shouldSelect !== isSelected) {
          el.scrollIntoView({ behavior: 'instant', block: 'center' });
          el.click();
        }
        if (shouldSelect) selected++;
      });
      return { ok: selected > 0, selected };
    }, answer, scope).finally(() => scope.dispose());
  }

  // 4. Single Multiple Choice
  // Giao diện mới: mọi câu nằm trong DOM cùng lúc, nên PHẢI scope option theo
  // container của đúng câu đang làm (question.index). Fallback toàn trang sẽ
  // chọn nhầm option của câu khác.
  const fillRes = await page.evaluate(({ question, answer }) => {
    const modernItems = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question'));
    const index = question.index || 0;
    const modernQuestion = modernItems[index] || document.getElementById('user-test-' + index) ||
      document.querySelectorAll('.quizx.question-hold')[index];

    const readOptionText = (el) => {
      const sign = el.querySelector('.qsign') || el;
      const tex = sign.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      let t = tex || sign.innerText || '';
      t = String(t).replace(/^[\s\xA0]+|[\s\xA0]+$/g, '');
      return t.replace(/^(?:[A-D][.):]|\([A-D]\))\s+/i, '').trim() || t.trim();
    };

    let optionEls = [];
    let scope = 'modern';
    if (modernQuestion) {
      optionEls = Array.from(modernQuestion.querySelectorAll('.qselect'));
      optionEls.sort((a, b) => {
        const ai = Number(a.getAttribute('ind') ?? a.getAttribute('data-ind'));
        const bi = Number(b.getAttribute('ind') ?? b.getAttribute('data-ind'));
        if (Number.isFinite(ai) && Number.isFinite(bi)) return ai - bi;
        return 0;
      });
    }
    if (!optionEls.length) {
      const defRoot = document.querySelector('default-root');
      const root = defRoot?.shadowRoot || defRoot || document;
      const quizHost = root.querySelector('type-quiz-x-mobile, type-quiz-x, type-quiz-multi-mobile, type-quiz');
      const quizRoot = quizHost?.shadowRoot || quizHost || root;
      optionEls = Array.from(quizRoot.querySelectorAll('.qselect, [ind], [data-ind], .choice-item, .option, .answer-item'));
      const visOpts = optionEls.filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0);
      if (visOpts.length >= 2) optionEls = visOpts;
      if (optionEls.some((el) => el.hasAttribute('ind') || el.hasAttribute('data-ind'))) {
        optionEls.sort((a, b) => Number(a.getAttribute('ind') ?? a.getAttribute('data-ind')) - Number(b.getAttribute('ind') ?? b.getAttribute('data-ind')));
      }
      scope = 'legacy-shadow';
    }
    if (!optionEls.length) {
      return { ok: false, reason: 'no-options-found' };
    }

    let targetIdx = Number(answer.correctIndex);
    let chosen = null;

    // A. By index
    if (Number.isInteger(targetIdx) && targetIdx >= 0 && targetIdx < optionEls.length) {
      chosen = optionEls[targetIdx];
    }

    // B. By letter A, B, C, D
    if (!chosen && answer.answer) {
      const ansLetter = String(answer.answer).trim().toUpperCase();
      const m = ansLetter.match(/^[\[\(]?([A-D])[\]\)\.]?$/) || ansLetter.match(/^(?:đáp án|phương án)\s*([A-D])/i);
      if (m) {
        const letterIdx = m[1].toUpperCase().charCodeAt(0) - 65;
        if (letterIdx < optionEls.length) {
          chosen = optionEls[letterIdx];
          targetIdx = letterIdx;
        }
      }
    }

    // C. By text content match
    if (!chosen && answer.answer) {
      const ansStr = String(answer.answer).trim().toLowerCase();
      // Try exact match first
      chosen = optionEls.find((el) => readOptionText(el).toLowerCase() === ansStr);
      // Substring match only if length >= 4 to avoid single number/letter collisions
      if (!chosen && ansStr.length >= 4) {
        chosen = optionEls.find((el) => {
          const text = readOptionText(el).toLowerCase();
          return text.includes(ansStr) || ansStr.includes(text);
        });
      }
      if (chosen) targetIdx = optionEls.indexOf(chosen);
    }

    // D. KHÔNG đoán bừa đáp án A.
    // Trước đây fallback click optionEls[0], tức submit đáp án sai với full
    // confidence khi AI không xác định được. Giờ trả lỗi để câu được xử lý lại.
    if (!chosen) {
      return { ok: false, reason: 'answer-unmatched' };
    }

    chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
    const radio = chosen.querySelector('.qiradio, input[type=radio]') || chosen;
    if (!radio.matches(':checked, [aria-checked="true"], .selected, .qchecked, .tw-selected') &&
        !chosen.matches('[aria-checked="true"], .selected, .qchecked, .tw-selected')) radio.click();
    return { ok: true, selectedIndex: targetIdx, scope };
  }, { question, answer });

  if (!fillRes.ok && !question?.__noAdaptive) {
    try {
      const adaptive = require('./adaptive-solver');
      const adRes = await adaptive.solveAdaptively(page, { knownAnswer: answer, log, questionIndex: question.index });
      if (adRes.ok) return { ...adRes, ok: true };
      if (adRes.isResultScreen) {
        return { ...fillRes, ok: false, isResultScreen: true, score: adRes.score || null, reason: 'no-question-on-screen' };
      }
    } catch (e) {
      if (log) log('warn', `🧠 [Adaptive] Lỗi: ${e.message}`);
    }
  }

  return fillRes;
}

// Màn hình XEM TRƯỚC của /chu-de/: hiển thị toàn bộ câu nhưng chưa vào chế độ
// làm bài. Click vào option của câu đầu tiên để khởi tạo giao diện làm bài
// thật (default-root + nút "Kiểm tra đáp án").
async function enterPracticeFromPreview(page, { log } = {}) {
  const clicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question'));
    const first = items[0];
    if (!first) return false;
    const opt = first.querySelector('.qselect');
    if (!opt) return false;
    opt.scrollIntoView({ behavior: 'instant', block: 'center' });
    opt.click();
    return true;
  });
  if (!clicked) return { ok: false, reason: 'no-preview-option' };
  if (log) log('info', '🖱 Đã mở chế độ làm bài từ màn hình xem trước.');

  // Chờ giao diện làm bài mount.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const dr = document.querySelector('default-root');
      const sr = dr?.shadowRoot;
      const qc = sr?.querySelector('#question-container');
      const hasCheckBtn = Array.from(document.querySelectorAll('button')).some((b) =>
        /kiểm tra đáp án/i.test(b.innerText || ''));
      return {
        hasShadow: !!sr,
        hasQuestionContainer: !!qc,
        hasCheckBtn,
        nQselect: sr ? sr.querySelectorAll('.qselect').length : 0,
        nItemx: document.querySelectorAll('.itemx.q-view-itemx.question').length,
      };
    }).catch(() => ({}));
    if (state.hasShadow && (state.hasQuestionContainer || state.nQselect > 0)) {
      return { ok: true, state };
    }
    await H.sleep(500);
  }
  return { ok: false, reason: 'practice-ui-timeout' };
}

// Bài dạng list: mọi câu đã render cùng lúc, điền theo index rồi nộp tổng thể
// (nếu bài có nút nộp tổng thể). KHÔNG click nút nộp từng câu.
async function solveListQuestions(page, { homework, config = {}, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const surface = await inspectQuestionSurface(page);
  const total = surface.visibleItemCount;
  if (!total) throw new Error('Không tìm thấy câu hỏi nào trong danh sách bài.');

  const questions = [];
  emit?.('phase', { phase: 'scanning', total });
  if (log) log('info', `Bài dạng danh sách: phát hiện ${total} câu hỏi.`);

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const question = await scanCurrentQuestion(page, index, homework.subject, log);
    question.scanStatus = question.text || question.imageBase64 ? 'scanned' : 'unresolved';
    questions.push(question);
    emit?.('scan-progress', { index, completed: index + 1, total });
    if (log) {
      const qDesc = String(question.text || '').replace(/\s+/g, ' ').slice(0, 45);
      const optDesc = (question.options || []).map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join(' | ');
      log('info', `📋 Đã quét Câu ${index + 1}/${total}: "${qDesc || (question.hasImage ? 'Hình ảnh' : 'Trắc nghiệm')}"${optDesc ? ` [${question.options.length} đáp án: ${optDesc}]` : ''}`);
    }
  }

  const answers = await solveQuestionsWithAi(questions, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
  const fillResults = await fillQuestions(page, questions, answers, { homework, config, log, emit, signal });

  const wait = Number(config.submitDelayMinutes || 0) * 60000;
  if (wait > 0) {
    emit?.('scheduled', { submitAt: new Date(Date.now() + wait).toISOString() });
    await delay(wait, undefined, { signal });
  }
  signal?.throwIfAborted();
  const { ok: confirmed } = await submitFinalExam(page, { log, signal });
  const score = confirmed ? await readScoreFromPage(page) : null;
  if (confirmed && log) log('success', `✔ Đã nộp bài "${homework.title || ''}" (Đã điền: ${fillResults.filled}/${questions.length} câu)${score ? ` — Điểm: ${score}` : ''}`);
  return {
    phase: confirmed ? 'done' : 'filled',
    submitted: confirmed,
    total: questions.length,
    scanned: questions.length,
    solved: fillResults.solved,
    filled: fillResults.filled,
    failed: fillResults.failed,
    score,
    questions: questions.map((q, i) => ({ id: q.id, index: i, type: q.type, text: q.text, status: fillResults.status[i] })),
  };
}

// Bài dạng tuần tự: mỗi câu phải nộp riêng rồi mới hiện câu tiếp theo.
async function solveSequentialQuestions(page, { homework, config = {}, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const maxQuestions = 200;
  const questions = [];
  let step = 0;
  let submitted = false;

  while (step < maxQuestions) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');

    const before = await inspectQuestionSurface(page);
    if ((before.hasResult || !before.questions.length) && await submissionConfirmed(page, { signal })) {
      submitted = true;
      break;
    }
    const current = before.questions[0];
    if (!current || (!current.stem && !current.optionCount)) {
      // Có thể đã xong bài nhưng chưa hiện màn kết quả -> thử nút chuyển câu.
      const advanced = await clickNextAction(page, { log });
      if (!advanced.clicked) {
        break;
      }
      const moved = await waitForTransition(page, before, (now, prev) =>
        now.questions.length > 0 || now.hasResult, { timeoutMs: 10000 });
      if (!moved.ok) break;
      continue;
    }

    const question = await scanCurrentQuestion(page, 0, homework.subject, log);
    question.scanStatus = question.text || question.imageBase64 ? 'scanned' : 'unresolved';
    questions.push(question);
    emit?.('scan-progress', { index: step, completed: step + 1, total: null });
    if (log) {
      const qDesc = String(question.text || '').replace(/\s+/g, ' ').slice(0, 45);
      log('info', `📋 Đã quét Câu ${step + 1}: "${qDesc || 'Trắc nghiệm'}"`);
    }

    const answers = await solveQuestionsWithAi([question], { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    const answer = answers.get(question.id);
    let fillState = 'unresolved';
    {
      // Câu có thể đã đổi trong lúc chờ AI -> không điền đáp án cũ.
      const now = await inspectQuestionSurface(page);
      if (now.questions[0] && now.questions[0].fingerprint === current.fingerprint) {
        const fillRes = await fillCurrentQuestion(page, question, answer, log);
        fillState = fillRes.ok ? 'filled' : 'fill-error';
        if (!fillRes.ok && log) log('warn', `⚠️ Câu ${step + 1}: không điền được đáp án (${fillRes.reason || 'unknown'}).`);
      } else {
        fillState = 'transition-timeout';
      }
    }
    questions[questions.length - 1].status = fillState;

    // Nút nộp câu: chỉ click nút thuộc câu đang làm.
    const submittedThis = await clickItemScopedSubmit(page, { log });
    if (!submittedThis.clicked) {
      if (log) log('error', `✖ Câu ${step + 1}: không tìm thấy nút nộp câu, dừng.`);
      questions[questions.length - 1].status = 'action-missing';
      break;
    }

    // Đợi OLM chấm câu và chuyển nút sang "Câu tiếp theo" / "Tiếp tục" (Lần bấm 2)
    await H.sleep(700);
    await clickNextAction(page, { log }).catch(() => { });

    const moved = await waitForTransition(page, before, (now, prev) => {
      if (now.hasResult) return true;
      if (!now.questions.length) return true;
      return now.questions[0].fingerprint !== prev.questions[0]?.fingerprint;
    }, { timeoutMs: 15000 });
    if (!moved.ok) {
      if (log) log('error', `✖ Câu ${step + 1}: đã bấm nộp nhưng câu không chuyển, dừng.`);
      questions[questions.length - 1].status = 'transition-timeout';
      break;
    }
    if (moved.snapshot?.hasResult) {
      break;
    }
    step++;
  }

  if (!submitted) submitted = await submissionConfirmed(page, { timeout: 6000, signal });
  if (!submitted && !questions.length) throw new Error('Không đọc được câu hỏi nào trên trang bài.');
  const score = submitted ? await readScoreFromPage(page) : null;
  const filled = questions.filter((q) => q.status === 'filled').length;
  const failed = questions.filter((q) => q.status && q.status !== 'filled').length;
  if (log) {
    log(submitted ? 'success' : 'warn',
      submitted
        ? `✔ Đã nộp bài "${homework.title || ''}" (${filled}/${questions.length} câu)${score ? ` — Điểm: ${score}` : ''}`
        : `⚠️ Đã xử lý ${questions.length} câu (${filled} câu điền thành công). Chưa có xác nhận nộp bài từ OLM.`);
  }
  return {
    phase: submitted ? 'done' : 'stopped',
    submitted,
    total: questions.length,
    scanned: questions.length,
    solved: questions.filter((q) => q.status === 'filled' || q.status === 'fill-error').length,
    filled,
    failed,
    score,
    questions: questions.map((q, i) => ({ id: q.id, index: i, type: q.type, text: q.text, status: q.status })),
  };
}

// Giải nhóm câu bằng AI (dùng chung cho list và sequential).
async function solveQuestionsWithAi(questions, { config, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const answerEngine = require('./answer-engine');
  const answers = new Map();
  for (const question of questions) {
    const known = matchDirectAnswer(question, directAnswersList, directAnswersMap);
    if (known && (known.answer || known.correctIndex >= 0 || known.correctIndices?.length || known.tfAnswers?.length || known.fillAnswers?.length)) {
      answers.set(question.id, known);
    }
  }
  const pending = questions.filter(question => !answers.has(question.id));
  const textQuestions = pending.filter((q) => !q.hasImage && !q.imageBase64 && q.scanStatus === 'scanned');
  const imageQuestions = pending.filter((q) => q.imageBase64 && q.scanStatus === 'scanned');
  const batchSize = Math.max(1, Number(config.aiBatchSize || process.env.AI_BATCH_SIZE || 5));

  const batches = [];
  for (let i = 0; i < textQuestions.length; i += batchSize) batches.push(textQuestions.slice(i, i + batchSize));
  for (const q of imageQuestions) batches.push([q]);

  if (log && questions.length) {
    log('info', `Đang xử lý ${questions.length} câu hỏi (${imageQuestions.length ? imageQuestions.length + ' câu hình, ' : ''}${textQuestions.length} câu chữ)...`);
  }
  emit?.('phase', { phase: 'solving', total: questions.length, batches: batches.length });

  const queue = batches.map((batch, idx) => ({ batch, idx }));
  const aiConcurrency = Math.min(3, Math.max(1, batches.length));
  let solvedCount = answers.size;

  async function aiWorker() {
    while (queue.length > 0) {
      if (signal?.aborted) break;
      const item = queue.shift();
      const batch = item.batch;
      let result = null;
      try {
        result = batch.length > 1
          ? await answerEngine.solveBatch(batch, { signal })
          : await answerEngine.solveQuestion(batch[0], { signal });
      } catch (err) {
        signal?.throwIfAborted();
        if (batch.length === 1) {
          log?.('warn', 'AI chưa giải được câu ' + (batch[0].index + 1) + '.');
          continue;
        }
      }
      const list = result == null ? [] : Array.isArray(result) ? result : [result];
      if (batch.length > 1) {
        const valid = new Set(list.filter(answer => !answer.unresolved).map(answer => String(answer.id)));
        const retry = batch.filter(question => !valid.has(String(question.id)));
        const singles = await answerEngine.solveAll(retry, { signal, gapMs: 0 });
        list.push(...singles.filter(answer => answer.ok).map(answer => ({ ...answer, id: retry[answer.index].id })));
      }
      const byId = new Map(batch.map((q) => [String(q.id), q]));
      list.forEach((ans) => {
        const q = batch.length === 1 ? batch[0] : byId.get(String(ans?.id));
        if (!q || !ans || ans.unresolved) return;
        answers.set(q.id, ans);
        solvedCount++;
        const optLetter = ans.correctIndex >= 0 ? `[Đáp án ${String.fromCharCode(65 + ans.correctIndex)}]` : '';
        if (log) log('success', `✔ Câu ${q.index + 1} -> ${optLetter} ${String(ans.answer || '').slice(0, 40)}`);
      });
      emit?.('solve-progress', { completed: solvedCount, total: questions.length });
    }
  }

  await Promise.all(Array.from({ length: aiConcurrency }, aiWorker));
  return answers;
}

// Điền đáp án cho các câu đã giải. Trả về số liệu fill/failed và trạng thái từng câu.
async function fillQuestions(page, questions, answers, { config, log, emit, signal }) {
  const H2 = require('./humanize');
  const status = questions.map(() => 'unresolved');
  let filled = 0;
  let solved = 0;

  // Lập kế hoạch điểm mục tiêu cho toàn bộ câu hỏi
  const planQuestions = questions.map((q, idx) => {
    const ans = answers.get(q.id);
    return {
      ...q,
      index: idx,
      correctIndex: ans?.correctIndex ?? -1,
      options: q.options || ans?.options || []
    };
  });
  const plan = H2.planWrongAnswers(planQuestions, config?.scoreTarget);

  for (let i = 0; i < questions.length; i++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const question = questions[i];
    const answer = answers.get(question.id);
    if (answer) solved++;
    const planned = answer ? applyWrongPlan(question, answer, i, plan) : null;
    await H2.sleep(H2.randInt(120, 220));
    const fillRes = await fillCurrentQuestion(page, question, planned, log);
    if (fillRes.ok) {
      filled++;
      status[i] = 'filled';
      if (log) log('info', `✍ Đã chọn đáp án Câu ${i + 1}/${questions.length}: ${planned?.answer || fillRes.text || ''}${planned?.isWrong ? ' (cố tình chọn sai để đạt điểm mục tiêu)' : ''}`);
    } else {
      status[i] = 'fill-error';
      if (log) log('warn', `⚠️ Không điền được Câu ${i + 1}: ${fillRes.reason || 'unknown'}`);
    }
    emit?.('fill-progress', { filled, completed: i + 1, total: questions.length });
  }
  return { filled, solved, failed: questions.length - filled, status };
}

// Áp kế hoạch cố tình sai một số câu (humanize) theo scoreTarget.
function applyWrongPlan(question, answer, index, plan) {
  if (!answer || answer.unresolved || !plan?.wrongIndices.has(index)) return answer;
  if (answer.statements?.length) {
    return { ...answer, statements: answer.statements.map((value, i) => i === 0 ? !value : value), isWrong: true };
  }
  if (answer.tfAnswers?.length) {
    return { ...answer, tfAnswers: answer.tfAnswers.map((item, i) =>
      i === 0 ? { ...item, value: item.value === 1 ? 0 : 1, label: item.value === 1 ? 'Sai' : 'Đúng' } : item), isWrong: true };
  }
  const options = question.options?.length ? question.options : answer.options || [];
  const correct = answer.correctIndices?.length ? answer.correctIndices : [answer.correctIndex];
  if (options.length > 1 && correct.every(i => Number.isInteger(i) && i >= 0 && i < options.length)) {
    const pick = options.findIndex((_, i) => !correct.includes(i));
    if (pick >= 0) return { ...answer, correctIndex: pick, correctIndices: [pick], answer: options[pick],
      correctText: options[pick], correctTexts: [options[pick]], displayIndex: pick, isWrong: true };
  }
  if (['short_answer', 'strict_short_answer', 'fill_me'].includes(question.type)) {
    const values = answer.fillAnswers?.length ? [...answer.fillAnswers] : [String(answer.answer ?? '')];
    if (values[0]) {
      const value = values[0].trim();
      const numeric = /^[-+]?\d+(?:[.,]\d+)?$/.test(value);
      values[0] = numeric ? (Number(value.replace(',', '.')) === 0 ? '1' : '0') : value + '?';
      return { ...answer, answer: values[0], fillAnswers: values, isWrong: true };
    }
  }
  return answer;
}

// Click nút nộp THUỘC CÂU ĐANG LÀM (nút nằm trong item của câu hiện tại).
async function clickItemScopedSubmit(page, { log } = {}) {
  let res = await page.evaluate(() => {
    const normalizeVi = (value) => String(value || '')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    let items = Array.from(document.querySelectorAll('.itemx.q-view-itemx.question, .itemx, .tw-olm-question, .card-body, .previewquiz')).filter(isVisible);
    const item = items[0] || document;
    const LABELS = ['nop cau', 'kiem tra dap an', 'tra loi'];
    const cands = Array.from(item.querySelectorAll('button, a[role="button"], a.btn, div[role="button"], input[type="submit"], [class*="submit"], #btn-done'));
    const target = cands.find((el) => {
      if (!isVisible(el)) return false;
      const t = normalizeVi(el.innerText || el.value || '');
      return LABELS.some((k) => t === k || t.startsWith(k));
    });
    if (!target) return { clicked: false, reason: 'not-found' };
    target.scrollIntoView({ behavior: 'instant', block: 'center' });
    target.click();
    return { clicked: true, label: normalizeVi(target.innerText || target.value || '') };
  });
  if (!res.clicked) {
    try {
      const adaptive = require('./adaptive-solver');
      const aiNext = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'next_question', log });
      if (aiNext.status === 'clicked_next') {
        res = { clicked: true, label: 'adaptive-ai-next' };
      }
    } catch { /* ignore */ }
  }
  if (res.clicked && log) log('info', `🖱 Đã nộp câu${res.label ? ` "${res.label}"` : ''}.`);
  return res;
}

// Click nút chuyển câu ("Câu tiếp", "Tiếp tục"). Không click nút nộp.
async function clickNextAction(page, { log } = {}) {
  let res = await page.evaluate(() => {
    const normalizeVi = (value) => String(value || '')
      .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    };
    const LABELS = ['cau tiep', 'tiep tuc', 'cau sau', 'lam tiep'];
    const cands = Array.from(document.querySelectorAll('button, a[role="button"], a.btn, div[role="button"]'));
    const target = cands.find((el) => {
      if (!isVisible(el)) return false;
      const t = normalizeVi(el.innerText || el.value || '');
      return LABELS.some((k) => t === k || t.startsWith(k));
    });
    if (!target) return { clicked: false, reason: 'not-found' };
    target.click();
    return { clicked: true, label: normalizeVi(target.innerText || target.value || '') };
  });
  if (!res.clicked) {
    try {
      const adaptive = require('./adaptive-solver');
      const aiNext = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'next_question', log });
      if (aiNext.status === 'clicked_next') {
        res = { clicked: true, label: 'adaptive-ai-next' };
      }
    } catch { /* ignore */ }
  }
  if (res.clicked && log) log('info', `🖱 Đã nhấn "${res.label}" để sang câu tiếp.`);
  return res;
}

// Đọc điểm từ trang sau khi nộp.
async function readScoreFromPage(page) {
  const score = await page.evaluate(() => {
    const roots = [document];
    for (const root of roots) for (const el of root.querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    const text = roots.map(root => root === document ? document.body?.innerText :
      [...root.children].filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible')
        .map(el => el.innerText || '').join(' ')).join(' ');
    const m = text.match(/(\d+(?:[.,]\d+)?)\s*\/\s*(?:100|10)\b/i) ||
      text.match(/điểm\s*[:：]\s*(\d+(?:[.,]\d+)?)/i) ||
      text.match(/bạn\s+đạt\s+(\d+(?:[.,]\d+)?)/i);
    return m ? m[1] : null;
  }).catch(() => null);
  return score ? String(score).replace(',', '.') : null;
}

// ===========================================================================
// CÁC HÀM TƯƠNG TÁC FORM CHUẨN XÁC THEO KIẾN TRÚC OLM (CHỐNG MẤT ĐÁP ÁN & TRƯỢT STATE)
// ===========================================================================

// Hàm chỉ dùng khi đã giải xong TẤT CẢ các chip câu hỏi (Exam/Matrix Mode)
function submissionPageAction({ action = 'observe', omr = false } = {}) {
  const roots = [document];
  for (const root of roots) {
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const visible = element => {
    if (!element?.getClientRects().length || getComputedStyle(element).visibility !== 'visible') return false;
    for (let node = element; node; node = node.parentElement || node.getRootNode().host) {
      if (getComputedStyle(node).opacity === '0' || node.matches('[hidden], [aria-hidden="true"]')) return false;
    }
    return true;
  };
  const find = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(visible);
  const label = element => (element.innerText || element.value || element.getAttribute('aria-label') ||
    element.getAttribute('title') || '').trim().replace(/\s+/g, ' ');
  const active = element => !element.matches(':disabled, [aria-disabled="true"]');
  const buttons = 'button, a.btn, [role="button"], input[type="submit"]';
  const submitSelectors = [
    '.btn-submit-cate, #btn-submit-cate',
    '.btn-done-submit-exam, .btn-submit-exam, #btn-submit-test, #btn-finish',
    '.tw-btn-submit, .cmd-finish, button[data-action="submit-test"]',
    'button[aria-label*="kết thúc bài thi" i], button[aria-label*="kết thúc luyện tập" i]',
  ];
  const submitLabel = /^(nộp bài(?: thi| tự luận)?|kết thúc bài thi|kết thúc luyện tập|hoàn thành luyện tập|hoàn thành bài|kết thúc|xác nhận nộp|submit(?: exam| test)?)(?:\s*[.!…])?$/i;
  const submit = submitSelectors.map(selector => find(selector).find(active)).find(Boolean) ||
    find(buttons).find(button => active(button) && submitLabel.test(label(button)));

  const success = /đã nộp bài|nộp bài thành công|bài làm đang được chấm|đã ghi nhận bài làm|bài (?:làm )?đã (?:được )?nộp/i;
  const failure = /(?:chưa|không thể|không) (?:xác nhận (?:đã )?)?nộp bài|nộp bài (?:không thành công|thất bại)/i;
  const resultTitle = /kết quả (?:bài làm|luyện tập|bài thi)|điểm (?:của bạn|bài làm|bài thi|thang\s*10)|tổng điểm tối đa|chúc mừng bạn đã hoàn thành/i;
  const score = /\d+(?:[.,]\d+)?\s*\/\s*(?:100|10)(?!\d)|(?:^|\s)điểm(?: số| bài thi| thang\s*10)?\s*[:：]?\s*\d|\d+(?:[.,]\d+)?\s*điểm\b|đúng\s*\d+\s*\/\s*\d+\s*câu/i;
  const resultSelectors = '.practice-result, .box-result, .box-score, .result-box, .test-result, .toolbar-done-item, .lst-result, [class*="ket-qua"], [data-submission-status="submitted"]';
  const notices = find('[role="status"], [role="alert"], .swal2-popup');
  if (notices.some(element => success.test(element.innerText) && !failure.test(element.innerText))) return 'submitted';
  const results = find(resultSelectors);
  for (const element of results) {
    const text = element.innerText || '';
    if (failure.test(text)) continue;
    if (element.dataset.submissionStatus === 'submitted' || success.test(text) ||
        (!submit && (score.test(text) || resultTitle.test(text) && /\d/.test(text)))) return 'submitted';
    // On PDF/Word exams OLM puts the numeric grade alone in a bold element.
    if (!submit && element.matches('.lst-result') &&
        [...element.querySelectorAll('b')].some(grade => visible(grade) && /^\d+(?:[.,]\d+)?$/.test(grade.innerText.trim()))) {
      return 'submitted';
    }
  }

  for (const root of roots) {
    if (submit) break;
    const container = root === document ? document.body : root;
    if (!container) continue;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const pieces = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent.trim() && visible(node.parentElement || root.host)) pieces.push(node.textContent.trim());
    }
    const text = pieces.join(' ');
    if (failure.test(text)) continue;
    if (success.test(text) || resultTitle.test(text) && score.test(text)) return 'submitted';
    const counts = text.match(/đúng\s*(\d+)\s*\/\s*(\d+)\s*câu\s+sai\s*(\d+)\s*\/\s*(\d+)\s*câu/iu);
    if (counts && Number(counts[2]) > 0 && counts[2] === counts[4] &&
        Number(counts[1]) + Number(counts[3]) === Number(counts[2]) && score.test(text) &&
        /thời gian làm bài|xem đáp án|làm lại bài|luyện tập lại/i.test(text)) return 'submitted';
  }

  if (omr && !submit) {
    const exam = window.BASEEXAM;
    const doneExam = [true, 1, '1'].includes(exam?.vals?.done_exam) ||
      [true, 1, '1'].includes(typeof exam?.getData === 'function' ? exam.getData('done_exam') : undefined);
    if (doneExam) return 'submitted';
  }

  if (action === 'submit') {
    if (submit) {
      submit.scrollIntoView({ behavior: 'instant', block: 'center' });
      submit.click();
      return 'clicked';
    }
    if (omr && typeof window.BASEEXAM?.submitExam === 'function') {
      window.BASEEXAM.submitExam();
      return 'clicked';
    }
    if (omr && typeof window.EXAM_FILE?.handleSubmit === 'function') {
      window.EXAM_FILE.handleSubmit({ force: true, save: true });
      return 'clicked';
    }
  }

  if (action === 'confirm') {
    const dialogs = '#dialogConfirm, dialog[open], [role="dialog"], .swal2-popup, .bootbox.modal, .modal.show, .modal.in, .dialogbox.show, .main-modal-v2';
    const confirmLabel = /^(có|đồng ý|xác nhận(?: nộp(?: bài)?)?|vẫn nộp(?: bài)?|nộp bài(?: thi)?|ok|co|dong y|xac nhan|van nop)[.!…]?$/i;
    const known = find('#btn-confirm-dialog-confirm-v2, #dialog-yes');
    const scoped = find(dialogs).filter(dialog =>
      /nộp bài|xác nhận nộp|kết thúc (?:bài|luyện tập)|vẫn nộp/i.test(dialog.innerText || '')
    ).flatMap(dialog => [...dialog.querySelectorAll(buttons + ', a, .btn')].filter(visible));
    const confirm = [...known, ...scoped].find(button => active(button) &&
      (confirmLabel.test(label(button)) || (known.includes(button) && !label(button))));
    if (confirm) {
      confirm.click();
      return 'confirmed';
    }
  }
  return false;
}

async function waitForSubmissionAction(page, { action, omr, timeout, signal }) {
  try {
    const result = await page.waitForFunction(submissionPageAction, { timeout, polling: 200, signal }, { action, omr });
    try {
      return await result.jsonValue();
    } finally {
      await result.dispose().catch(() => {});
    }
  } catch {
    signal?.throwIfAborted();
    return false;
  }
}

async function submissionConfirmed(page, { timeout = 0, signal, omr } = {}) {
  signal?.throwIfAborted();
  if (!timeout) return await page.evaluate(submissionPageAction, { omr }).catch(() => false) === 'submitted';
  return await waitForSubmissionAction(page, { timeout, signal, omr }) === 'submitted';
}

async function submitFinalExam(page, { log, signal, omr = false } = {}) {
  signal?.throwIfAborted();
  await page.evaluate(() => document.activeElement?.blur()).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 700, timeout: 5000, signal }).catch(() => {});
  signal?.throwIfAborted();

  let action;
  try {
    action = await page.evaluate(submissionPageAction, { action: 'submit', omr });
  } catch (error) {
    // The click can navigate before Chrome returns its result.
    if (!/execution context|cannot find context|navigation|detached/i.test(error.message)) throw error;
    action = 'clicked';
  }

  if (action === 'submitted') {
    log?.('success', 'OLM đã hiển thị xác nhận nộp bài.');
    return { ok: true, autoSubmitted: true };
  }
  if (!action && !omr) {
    const adaptive = require('./adaptive-solver');
    signal?.throwIfAborted();
    const result = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'submit_exam', log, signal }).catch(() => null);
    if (result?.status === 'clicked_submit') action = 'clicked';
  }
  signal?.throwIfAborted();
  if (!action) return { ok: await submissionConfirmed(page, { timeout: 5000, signal, omr }), confirmed: false };

  const receipt = await waitForSubmissionAction(page, { action: 'confirm', timeout: 12000, signal, omr });
  const confirmed = receipt === 'confirmed';
  const ok = receipt === 'submitted' ||
    (confirmed && await submissionConfirmed(page, { timeout: 12000, signal, omr }));
  return { ok, confirmed };
}

// Điền các ô trống cho dạng Fill-in-the-blank (Hỗ trợ câu có nhiều ô trống cùng lúc)
async function fillBlanks(page, answersArray) {
  return page.evaluate((answers) => {
    function getAllDeep(sel, root = document, depth = 0) {
      if (depth > 12) return [];
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch { }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch { }
        }
      }
      return Array.from(new Set(results));
    }

    // Hỗ trợ Web Component type-fill-me
    const fillMeComps = getAllDeep('type-fill-me, type-fill-me-mobile');
    if (fillMeComps.length > 0) {
      const val0 = answers[0] !== undefined ? String(answers[0]).trim() : '';
      for (const comp of fillMeComps) {
        comp.userAnswer = { '0': val0 };
        const input = comp.shadowRoot?.querySelector('#fillme-input input, input[placeholder="?"]');
        if (input) {
          input.value = val0;
          input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        }
      }
    }

    const inputs = getAllDeep(
      'input[type="text"], input:not([type]), input.tw-input-content-default-md, input.blank, input.input-ans'
    ).filter((el) => {
      // Bỏ qua input chỉnh kích cỡ chữ trên toolbar (#input-font-size)
      if (el.id === 'input-font-size' || el.classList.contains('font-size')) return false;
      return el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0;
    });

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )?.set;

    let filledCount = 0;
    inputs.forEach((input, index) => {
      const val = answers[index] !== undefined ? String(answers[index]).trim() : (answers[0] !== undefined ? String(answers[0]).trim() : '');
      if (!val) return;

      input.focus();
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(input, val);
      } else {
        input.value = val;
      }

      // Phát đầy đủ chuỗi 5 sự kiện từ lúc gõ đến lúc rời ô
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      filledCount++;
    });
    return { ok: filledCount > 0 || fillMeComps.length > 0, filledCount };
  }, Array.isArray(answersArray) ? answersArray : [answersArray]);
}

// Gõ công thức Toán học MathQuill bằng API nội bộ window.MathQuill
async function fillMathQuill(page, latexAnswers) {
  return page.evaluate((latexList) => {
    const mqFields = Array.from(document.querySelectorAll('.mq-editable-field, .mathquill-editable, .mq-root-block'));
    if (!window.MathQuill) return { ok: false, reason: 'no-mathquill-api' };
    const MQ = window.MathQuill.getInterface ? window.MathQuill.getInterface(2) : window.MathQuill;

    let filledCount = 0;
    mqFields.forEach((field, idx) => {
      const latex = latexList[idx] ?? latexList[0];
      if (!latex) return;
      const mathField = MQ(field);
      if (mathField && typeof mathField.latex === 'function') {
        mathField.latex(''); // Xóa trắng công thức cũ
        mathField.latex(latex); // Nạp trực tiếp cây công thức LaTeX chuẩn
        const hiddenTextarea = field.querySelector('textarea.mq-textarea') || field.querySelector('textarea');
        if (hiddenTextarea) {
          hiddenTextarea.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenTextarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          hiddenTextarea.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }
        filledCount++;
      }
    });
    return { ok: filledCount > 0, filledCount };
  }, Array.isArray(latexAnswers) ? latexAnswers : [latexAnswers]);
}

// Điền bài viết tự luận vào Lexical Editor bằng CDP Input.insertText
async function fillLexicalParagraph(page, essayText) {
  // 1. Click mở khung soạn thảo nếu vẫn đang ở trạng thái placeholder
  const placeholder = await page.$('textarea.typing-para, textarea.text-para, type-paragraph, div[data-placeholder]').catch(() => null);
  if (placeholder) {
    await placeholder.click().catch(() => { });
  }

  // 2. Chờ Lexical Editor thực sự mount vào DOM
  const editorSelector = 'div[contenteditable="true"][data-lexical-editor="true"], type-paragraph div[contenteditable="true"], div.ContentEditable__root';
  await page.waitForSelector(editorSelector, { visible: true, timeout: 5000 }).catch(() => { });
  await page.click(editorSelector).catch(() => { });

  // 3. Xóa nội dung cũ (nếu có) bằng lệnh selectAll của document
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    }
  }, editorSelector).catch(() => { });

  // 4. Chèn toàn bộ đoạn văn tức thì qua CDP Input.insertText (Lexical bắt sự kiện này chuẩn 100%)
  try {
    const client = await page.target().createCDPSession();
    try {
      await client.send('Input.insertText', { text: essayText });
    } finally {
      await client.detach().catch(() => { });
    }
  } catch {
    await page.keyboard.type(essayText, { delay: 10 }).catch(() => { });
  }

  // 5. Đợi 200ms rồi bấm nút #btn-done nằm TRONG phạm vi câu tự luận đó để lưu bài
  await H.sleep(200);
  await page.evaluate(() => {
    const doneBtn = document.querySelector('type-paragraph #btn-done, type-paragraph-mobile #btn-done, #btn-done');
    if (doneBtn && (doneBtn.offsetParent !== null || doneBtn.offsetWidth > 0 || doneBtn.offsetHeight > 0)) {
      doneBtn.click();
    }
  }).catch(() => { });

  return { ok: true, method: 'lexical-cdp' };
}

// Kéo thả OLM kết hợp cả HTML5 DragEvent Simulation và Chuột vật lý có threshold
async function dragAndDropOLM(page, sourceSelector, targetSelector) {
  // Đưa cả 2 phần tử vào khung nhìn trước khi lấy tọa độ
  await page.evaluate((sSel, tSel) => {
    const src = document.querySelector(sSel);
    const tgt = document.querySelector(tSel);
    if (src) src.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    if (tgt) tgt.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }, sourceSelector, targetSelector).catch(() => { });

  await H.sleep(150);

  // Kiểm tra xem thẻ dùng HTML5 draggable="true" hay thư viện chuột (Sortable/jQuery UI)
  const isHtml5Drag = await page.evaluate((sSel) => {
    const src = document.querySelector(sSel);
    return src && src.getAttribute('draggable') === 'true';
  }, sourceSelector).catch(() => false);

  if (isHtml5Drag) {
    // Phát chuỗi sự kiện HTML5 DragEvent kèm DataTransfer dùng chung
    await page.evaluate((sSel, tSel) => {
      const src = document.querySelector(sSel);
      const tgt = document.querySelector(tSel);
      if (!src || !tgt) return;

      const dataTransfer = new DataTransfer();
      const fire = (el, type) => {
        const rect = el.getBoundingClientRect();
        const evt = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          dataTransfer
        });
        el.dispatchEvent(evt);
      };

      fire(src, 'pointerdown');
      fire(src, 'mousedown');
      fire(src, 'dragstart');
      fire(tgt, 'dragenter');
      fire(tgt, 'dragover');
      fire(tgt, 'drop');
      fire(src, 'dragend');
      fire(tgt, 'mouseup');
    }, sourceSelector, targetSelector).catch(() => { });
  }

  // Luôn chạy bồi thêm thao tác kéo chuột vật lý có ngưỡng kích hoạt (threshold 5px) cho SortableJS/Touch
  const boxes = await page.evaluate((sSel, tSel) => {
    const s = document.querySelector(sSel)?.getBoundingClientRect();
    const t = document.querySelector(tSel)?.getBoundingClientRect();
    if (!s || !t) return null;
    return {
      x1: s.left + s.width / 2,
      y1: s.top + s.height / 2,
      x2: t.left + t.width / 2,
      y2: t.top + t.height / 2
    };
  }, sourceSelector, targetSelector).catch(() => null);

  if (boxes) {
    await page.mouse.move(boxes.x1, boxes.y1);
    await page.mouse.down();
    await H.sleep(100);
    // Nhích 5px để vượt drag threshold của SortableJS
    await page.mouse.move(boxes.x1 + 5, boxes.y1 + 5, { steps: 3 });
    await page.mouse.move(boxes.x2, boxes.y2, { steps: 20 });
    await H.sleep(120);
    await page.mouse.up();
  }
}

async function solveModernQuiz(page, { homework, config = {}, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const answerEngine = require('./answer-engine');
  const totalChips = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
  if (!totalChips) throw new Error('Không tìm thấy chip câu hỏi trong giao diện OLM hiện đại.');
  const total = config.maxQuestions ? Math.min(totalChips, Number(config.maxQuestions)) : totalChips;
  const quizPlan = H.planWrongAnswers(Array.from({ length: total }, () => ({})), config.scoreTarget);

  emit?.('phase', { phase: 'solving', total });
  if (log) log('info', 'Bắt đầu giải tuần tự ' + total + ' câu hỏi (Quét 1 câu -> Giải 1 câu -> Chọn đáp án -> Nộp câu -> Sang câu tiếp)...');

  let filled = 0;
  let failed = 0;
  const questions = [];
  const questionStatuses = new Map();

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const stepStart = Date.now();

    // 1. Cuộn thanh chip tới câu index và click bằng chuột thật
    const chipBox = await page.evaluate((i) => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question'));
      const chip = chips[i];
      if (!chip) return null;
      chip.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' });
      const r = chip.getBoundingClientRect();
      const isSelected = chip.classList.contains('tw-selected') || chip.classList.contains('selected') || chip.classList.contains('active');
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, isSelected, text: chip.innerText.trim() };
    }, index);

    if (chipBox) {
      if (!chipBox.isSelected) {
        await page.mouse.click(chipBox.x, chipBox.y);
      }
      await H.sleep(directAnswersList.length > 0 ? 120 : 250);
    }

    // 2. Quét nhanh nội dung câu hiện tại
    const question = await scanCurrentQuestion(page, index, homework.subject, log);
    question.scanStatus = question.text || question.imageBase64 ? 'scanned' : 'unresolved';
    questions.push(question);

    const cleanOneLine = (s) => String(s || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s*=/g, '≠').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    const qDesc = cleanOneLine(question.text).slice(0, 50);
    const optDesc = (question.options || []).map((o, idx) => String.fromCharCode(65 + idx) + '. ' + cleanOneLine(o)).join(' | ');
    if (log) {
      log('info', '📋 [Câu ' + (index + 1) + '/' + total + '] Quét: "' + (qDesc || (question.hasImage ? 'Hình ảnh' : 'Trắc nghiệm')) + '"' + (optDesc ? ' [' + optDesc + ']' : ''));
    }

    // 3. Tra cứu đáp án chính xác từ OLM Network API + URL idq + Live DOM Web Components
    const urlIdq = await page.evaluate(() => {
      const m = location.href.match(/idq=(\d+)/);
      return m ? m[1] : null;
    }).catch(() => null);
    let directAns = (urlIdq && directAnswersMap.has(String(urlIdq)))
      ? { ...directAnswersMap.get(String(urlIdq)) }
      : null;
    if (!directAns) {
      directAns = matchDirectAnswer(question, directAnswersList, directAnswersMap, index);
    }
    if (!directAns) {
      directAns = await extractLiveDomAnswer(page, index);
    }
    let answer = null;

    const hasDirectAnswer = directAns && (
      directAns.isTrueFalse ||
      directAns.isLinkList ||
      directAns.isGroupList ||
      directAns.isUnderline ||
      (directAns.correctIndices && directAns.correctIndices.length > 0) ||
      (directAns.answer && String(directAns.answer).trim().length > 0) ||
      (directAns.selectTextAnswers && directAns.selectTextAnswers.length > 0) ||
      (directAns.fillAnswers && directAns.fillAnswers.length > 0)
    );
    if (hasDirectAnswer) {
      answer = { ...directAns, source: directAns.source || 'olm-api',
        answer: directAns.correctText || directAns.answer || question.options[directAns.correctIndex] || '',
        correctIndices: directAns.correctIndices || (directAns.correctIndex >= 0 ? [directAns.correctIndex] : []),
      };
      answer = applyWrongPlan(question, answer, index, quizPlan);
      const displayIdxForLog = answer.displayIndex !== undefined ? answer.displayIndex : answer.correctIndex;
      const optLetter = !answer.isTrueFalse && answer.correctIndices.length > 1
        ? (answer.correctIndices.length > 4 || (answer.subQuestions && answer.subQuestions.length > 1)
          ? `[Tổ hợp ${answer.correctIndices.length} câu trả lời] `
          : '[Nhiều đáp án: ' + answer.correctIndices.map(i => String.fromCharCode(65 + i)).join(', ') + '] ')
        : (displayIdxForLog >= 0 && displayIdxForLog < 26 ? '[Đáp án ' + String.fromCharCode(65 + displayIdxForLog) + '] ' : '');
      if (log) log('info', '🎯 [OLM API Key] Câu ' + (index + 1) + ' -> ' + optLetter + (answer.answer || '').slice(0, 120) + (answer.isWrong ? ' (cố tình chọn sai để đạt điểm mục tiêu)' : ''));
    } else {
      // Gọi AI Engine (Gemini) để giải câu hỏi này (đặc biệt câu tự luận, trả lời ngắn, hoặc câu ngoài API)
      if (log) log('info', `🤖 [AI Answer Engine] Đang giải câu ${index + 1} (${question.type || 'tự luận'})...`);
      try {
        if (question.hasImage && !question.imageBase64) throw new Error('Chưa có ảnh câu hỏi');
        const aiAns = await answerEngine.solveQuestion(question, { signal });
        if (aiAns && !aiAns.unresolved) {
          answer = {
            ...aiAns,
            source: 'ai-engine',
            isTrueFalse: Array.isArray(aiAns.statements) && aiAns.statements.length > 0,
            tfAnswers: Array.isArray(aiAns.statements) ? aiAns.statements.map((s, sIdx) => ({
              index: sIdx,
              value: s ? 1 : 0,
              label: s ? 'Đúng' : 'Sai'
            })) : undefined
          };
          if (log) log('success', `✔ [AI Answer] Câu ${index + 1} -> ${answer.answer || ''}`);
        } else {
          answer = { correctIndex: -1, correctIndices: [], answer: '', unresolved: true };
        }
      } catch (err) {
        if (log) log('warn', `⚠️ Không thể giải câu ${index + 1} bằng AI: ${err.message}`);
        answer = { correctIndex: -1, correctIndices: [], answer: '', unresolved: true };
      }
    }

    if (answer?.source === 'ai-engine') answer = applyWrongPlan(question, answer, index, quizPlan);

    // 4. Điền hoặc chọn đáp án cho câu đó trên giao diện OLM (Qua bộ Inspector Đa Năng)
    let fillRes = { ok: false };
    fillRes = await inspectAndFillAnyQuestion(page, answer || {}, question, log);
    if (!fillRes.ok && !fillRes.isResultScreen && answer && !answer.unresolved) {
      if (answer.tfAnswers?.length && question.statements?.length && answer.source !== 'ai-engine') {
        try {
          const aiAnswer = await answerEngine.solveQuestion(question, { signal });
          if (!aiAnswer.unresolved) {
            answer = aiAnswer;
            fillRes = await fillTrueFalse(page, question, answer);
          }
        } catch { signal?.throwIfAborted(); }
      }
      if (!fillRes.ok && (!fillRes.reason || !fillRes.reason.includes('result'))) {
        fillRes = await fillCurrentQuestion(page, question, answer, log);
      }
    }

    if (fillRes.isResultScreen) {
      if (log) log('warn', `🔒 [Adaptive DevTools] Phát hiện màn hình kết quả bài làm đã nộp (không có câu hỏi). Dừng quét ngay lập tức!`);
      break;
    }

    if (fillRes.ok) {
      filled++;
      questionStatuses.set(question.id, 'filled');
      const displayIdxForLog = answer.displayIndex !== undefined ? answer.displayIndex : answer.correctIndex;
      const optLetter = displayIdxForLog >= 0 ? '[Đáp án ' + String.fromCharCode(65 + displayIdxForLog) + '] ' : '';
      const chosenText = optLetter + cleanOneLine(answer.answer || 'Đã chọn');
      if (log) log('success', '✔ Đã chọn Câu ' + (index + 1) + '/' + total + ': ' + chosenText);
    } else {
      failed++;
      questionStatuses.set(question.id, 'failed');
      if (log) log('warn', '⚠️ Câu ' + (index + 1) + '/' + total + ': Không điền được đáp án (' + (fillRes.reason || 'unresolved') + ')');
    }

    if (!fillRes.ok) {
      emit?.('fill-progress', { completed: index + 1, filled, failed, total });
      continue;
    }

    // 5. Nhấn nút nộp câu ('Kiểm tra đáp án' / #btn-done / 'Xem đáp án' / 'Trả lời') bằng CDP Real Mouse Click
    const checkBtnBox = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('#btn-done, button.tw-olm-btn-primary-48, button, div[role=button]'));
      const root = document.querySelector('default-root')?.shadowRoot;
      if (root) allBtns.push(...Array.from(root.querySelectorAll('#btn-done, button, div[role=button]')));
      const checkBtn = allBtns.find((b) => {
        if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
        return !b.disabled && (/^(kiểm tra(?:\s+đáp\s+án)?|trả lời|nộp câu|hoàn thành)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()) || b.id === 'btn-done');
      });
      if (checkBtn) {
        checkBtn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        const r = checkBtn.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    if (checkBtnBox) {
      await page.mouse.click(checkBtnBox.x, checkBtnBox.y);
      await H.sleep(directAnswersList.length > 0 ? 200 : 600);
    }

    // Bấm nút 'Tiếp tục' / #btn-next / .btn-next-question nếu có để chuyển câu mượt mà
    const nextClicked = await page.evaluate(() => {
      const btn = document.querySelector('#btn-next, .btn-next-question') ||
        Array.from(document.querySelectorAll('button')).find(b => (b.offsetWidth > 0 || b.offsetHeight > 0) && !b.disabled && /^(tiếp tục|câu sau|câu tiếp|tiếp theo)$/i.test((b.innerText || '').trim()));
      if (btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0)) {
        btn.click();
        return true;
      }
      return false;
    }).catch(() => false);

    // Chỉ gọi Adaptive AI khi thực sự kẹt ở câu cuối mà không có cả nút Kiểm tra lẫn nút Tiếp tục;
    // ở các câu giữa, vòng lặp kế tiếp đã tự click chip[index + 1].
    if (!checkBtnBox && !nextClicked && index === total - 1) {
      try {
        const adaptive = require('./adaptive-solver');
        const aiNext = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'next_question', log });
        if (aiNext.status === 'locked_result') break;
        await H.sleep(300);
      } catch { /* ignore */ }
    }

    // Đồng bộ trạng thái Palette câu hỏi trên OLM
    await page.evaluate((idx) => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question, .q-nav-item, [data-question-nav]'));
      const chip = chips[idx];
      if (chip && !chip.classList.contains('answered') && !chip.classList.contains('done') && !chip.classList.contains('tw-selected')) {
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur();
        }
      }
    }, index).catch(() => { });

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    if (log) log('info', 'Đã xử lý câu ' + (index + 1) + '/' + total + ' (' + elapsed + ' giây).');

    emit?.('fill-progress', { completed: index + 1, filled, failed, total });
    if (!directAnswersList.length) await H.sleep(50);
  }

  emit?.('fill-complete', { filled, failed, total: questions.length });

  // Delay submit setting nếu có
  const delayMin = Number(config.submitDelayMinutes || 0);
  if (delayMin > 0) {
    if (log) log('info', 'Chờ ' + delayMin + ' phút trước khi nộp toàn bộ theo cấu hình...');
    if (emit) emit('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
    await delay(delayMin * 60000, undefined, { signal });
    signal?.throwIfAborted();
  } else {
    await H.sleep(600);
  }

  // === QUY TRÌNH AUTO-SUBMIT 4 BƯỚC AN TOÀN CHỐNG MẤT ĐIỂM & CHỐNG LỖI NAVIGATION ===
  if (log) log('info', 'Hoàn tất các câu -> Bắt đầu quy trình nộp bài...');

  // Bước 1: Blur active element & Chờ request save-answer của câu cuối gửi xong
  try {
    await page.evaluate(() => {
      if (document.activeElement && typeof document.activeElement.blur === 'function') {
        document.activeElement.blur();
      }
    });
  } catch (e) { }
  await page.waitForNetworkIdle({ idleTime: 600, timeout: 3000 }).catch(() => { });
  await H.sleep(800);

  signal?.throwIfAborted();
  const { ok: confirmed } = await submitFinalExam(page, { log, signal });

  // Đợi navigation nếu trang đang chuyển hướng
  await page.waitForNavigation({ timeout: 2500 }).catch(() => { });
  await H.sleep(800);

  // Bước 4: Đọc điểm số OLM báo (từ màn hình kết quả HOẶC từ bảng chip tw-success của OLM)
  let scoreAchieved = null;
  let scoreText = '';
  for (let sAttempt = 0; sAttempt < 6; sAttempt++) {
    try {
      const scoreData = await page.evaluate(() => {
        const defRoot = document.querySelector('default-root');
        const root = defRoot?.shadowRoot || defRoot || document;
        const text = ((document.body ? document.body.innerText : '') + ' ' + (root.innerText || '')).replace(/\s+/g, ' ');
        const match =
          text.match(/(?:Điểm|Điểm số|Kết quả|Số điểm|Đạt)\s*[:：]?\s*([0-9]+(?:[\.,][0-9]+)?)\s*(?:\/\s*([0-9]+))?/i) ||
          text.match(/([0-9]+(?:[\.,][0-9]+)?)\s*\/\s*10\s*điểm/i);

        return { matchStr: match?.[0], numStr: match?.[1] };
      });

      if (scoreData?.numStr) {
        scoreAchieved = scoreData.numStr.replace(',', '.');
        scoreText = scoreData.matchStr;
        break;
      }


    } catch (e) {
      await H.sleep(800);
    }
    await H.sleep(500);
  }

  if (scoreAchieved === null) {
    const chipScore = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question'));
      if (!chips.length) return null;
      const success = chips.filter(c => c.className.includes('tw-success')).length;
      return (success / chips.length * 10).toFixed(1).replace(/\.0$/, '');
    }).catch(() => null);
    if (chipScore !== null) scoreAchieved = chipScore;
  }

  const isAllFilledSuccess = filled > 0 && failed === 0;
  const isSubmittedOrDone = confirmed || (scoreAchieved !== null && isAllFilledSuccess);

  if (isSubmittedOrDone && scoreAchieved !== null) {
    if (log) log('success', '🎯 Kết quả chấm điểm OLM: ' + (scoreText || (scoreAchieved + ' điểm')));
  }

  return {
    engine: 'browser',
    phase: isSubmittedOrDone ? 'done' : 'filled',
    scanned: questions.length,
    solved: filled,
    filled,
    failed,
    score: isSubmittedOrDone ? scoreAchieved : null,
    submitted: isSubmittedOrDone,
    questions: questions.map((q) => ({ id: q.id, index: q.index, type: q.type, text: q.text, status: questionStatuses.get(q.id) || q.scanStatus })),
  };
}


// Giải dạng bài thi kiểm tra tuần tự (Làm hết tất cả câu hỏi rồi mới nộp tổng thể bài thi)
async function solveExamQuestions(page, { homework, config = {}, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const total = directAnswersList.length || 0;
  if (!total) throw new Error('Không nhận được danh sách câu hỏi và đáp án từ API OLM.');

  emit?.('phase', { phase: 'solving', total });
  if (log) log('info', `Bắt đầu giải bài thi kiểm tra (${total} câu) -> Tự động khớp đề và điền đáp án chuẩn xác...`);

  const { wrongIndices: wrongIndicesSet } = H.planWrongAnswers(Array.from({ length: total }, () => ({})), config.scoreTarget);

  // Kiểm tra xem trang có phải giao diện Đề thi Ma trận / Toàn cảnh (Classic Exam)
  const isClassicExam = await page.evaluate(() => {
    return !!(
      (window.data_exam && window.data_exam.list_id_quiz) ||
      document.querySelector('#dialogConfirm') ||
      document.querySelector('[id^="user-test-"], .quizx.question-hold')
    );
  }).catch(() => false);

  if (isClassicExam) {
    if (log) log('info', `Phát hiện giao diện Đề thi Ma trận / Toàn cảnh (#user-test-... / list_id_quiz) -> Tự động điền theo từng container câu hỏi...`);
    let filled = 0;
    let failed = 0;
    const questions = [];

    for (let index = 0; index < total; index++) {
      if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
      const stepStart = Date.now();
      const shouldFail = wrongIndicesSet.has(index);

      // Click chip nếu có
      await page.evaluate((idx) => {
        const chip = document.querySelector(`.item-q[data-id="${idx}"], button.item-q[data-id="${idx}"]`);
        if (chip) chip.click();
      }, index).catch(() => { });
      await H.sleep(150);

      const fillRes = await page.evaluate((idx, decodedList, forceWrong) => {
        function extractOptionCleanText(el) {
          if (!el) return '';
          const clone = el.cloneNode(true);
          clone.querySelectorAll('.katex').forEach(k => {
            const tex = k.querySelector('annotation[encoding="application/x-tex"]');
            if (tex) k.replaceWith(' ' + tex.textContent + ' ');
            else {
              const mathml = k.querySelector('.katex-mathml');
              if (mathml) mathml.remove();
            }
          });
          clone.querySelectorAll('mjx-assistive-mml, .MJX_Assistive_MathML, script, style').forEach(n => n.remove());
          return (clone.innerText || clone.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
        }

        const container = document.querySelector(`#user-test-${idx}`) || document.querySelector(`.quizx[data-id="${idx}"]`) || document.querySelector(`.quizx.question-hold:nth-of-type(${idx + 1})`);
        if (!container) return { ok: false, error: 'Container not found' };

        const idq = container.getAttribute('data-id-quiz');
        const q = (decodedList || []).find(item => idq && String(item.id) === String(idq));
        if (!q) return { ok: false, idq, error: 'Question data not found' };

        // Nếu là câu hỏi chùm (<type-mix> có nhiều subQuestions hoặc bảng Đúng/Sai > 4 dòng), chuyển sang bộ Inspector Đa Năng
        if ((Array.isArray(q.subQuestions) && q.subQuestions.length > 1) || (Array.isArray(q.tfAnswers) && q.tfAnswers.length > 4)) {
          return { ok: false, type: 'compound', idq, error: 'Delegate compound question to inspectAndFillAnyQuestion' };
        }

        if (String(q.qType) === '13' || q.isTrueFalse || container.querySelector('.tf-box, [data-tf-value]')) {
          return { ok: false, type: 'tf', idq };
        }

        // 2. Trắc nghiệm đơn hoặc nhiều lựa chọn (.qselect)
        const qselects = Array.from(container.querySelectorAll('.qselect:not(.tf-box .qselect)'));
        if (qselects.length > 0 && (String(q.qType) === '1' || (q.options && q.options.length > 0))) {
          const isMulti = q.correctIndices && q.correctIndices.length > 1 && !q.isTrueFalse;
          if (!isMulti) {
            if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0) return { ok: false, type: 'single', idq };
            let targetInd = q.correctIndex;
            if (forceWrong && qselects.length > 1) targetInd = (targetInd + 1) % qselects.length;
            const opt = container.querySelector(`.qselect[ind="${targetInd}"], .qselect[data-ind="${targetInd}"]`) || qselects[targetInd];
            if (opt) {
              opt.click();
              return { ok: true, type: 'single', idq, targetInd };
            }
            return { ok: false, type: 'single', error: `Option ind=${targetInd} not found` };
          } else {
            const targetSet = new Set(forceWrong ? [0] : q.correctIndices.map(Number));
            qselects.forEach((opt, i) => {
              const rawInd = opt.getAttribute('ind') ?? opt.getAttribute('data-ind');
              const ind = rawInd !== null && rawInd !== '' ? Number(rawInd) : i;
              const isAct = opt.classList.contains('active') || opt.classList.contains('selected') || opt.classList.contains('qchecked') || opt.getAttribute('data-value') === '1' || !!opt.querySelector('input:checked');
              if (targetSet.has(ind) && !isAct) opt.click();
              else if (!targetSet.has(ind) && isAct) opt.click();
            });
            return { ok: true, type: 'multi', idq };
          }
        }

        // 3. Điền ngắn / số / nhiều ô trống (Type 2)
        const inputs = Array.from(container.querySelectorAll('input.trigger-curriculum-cate, input[type="text"], input[type="number"], input:not([type="radio"]):not([type="checkbox"])'));
        const fillList = Array.isArray(q.fillAnswers) && q.fillAnswers.length > 0
          ? q.fillAnswers
          : [String(q.correctText || q.answer || '').trim()].filter(Boolean);
        if (inputs.length > 0 && fillList.length > 0) {
          inputs.forEach((inp, i) => {
            let val = fillList[i] !== undefined ? String(fillList[i]).trim() : String(fillList[0]).trim();
            if (forceWrong && i === 0) val = val + '99';
            inp.focus();
            const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(inp, val);
            else inp.value = val;
            inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            inp.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
          });
          return { ok: true, type: 'input', idq, ansText: fillList.join(' | ') };
        }

        return { ok: false, type: 'unknown', idq };
      }, index, directAnswersList, shouldFail);

      const qItem = directAnswersList.find(d => fillRes.idq && String(d.id) === String(fillRes.idq));
      const qDesc = (qItem?.stem || qItem?.text || `Câu ${index + 1}`).slice(0, 50);

      let applied = fillRes;
      if (!applied.ok) {
        const scanned = await scanCurrentQuestion(page, index, homework.subject, log);
        let verified = qItem || matchDirectAnswer({ ...scanned, olmId: fillRes.idq || scanned.olmId }, directAnswersList, directAnswersMap);
        if (shouldFail && verified?.tfAnswers?.length) {
          verified = { ...verified, tfAnswers: verified.tfAnswers.map((item, index) =>
            index === 0 ? { ...item, value: item.value === 1 ? 0 : 1 } : item) };
        }
        applied = await inspectAndFillAnyQuestion(page, verified, scanned, log);
      }
      if (applied.ok) filled++;
      else {
        failed++;
        log?.('warn', 'Không xác minh được đáp án câu ' + (index + 1) + ': ' + (applied.reason || fillRes.error || 'unknown'));
      }
      questions.push({ id: qItem?.id || index, index: index + 1, text: qDesc, status: applied.ok ? 'filled' : 'failed' });
      emit?.('fill-progress', { completed: index + 1, filled, failed, total });

      const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      if (log) log('info', `⚡ Câu ${index + 1}/${total} hoàn tất (${elapsed}s)`);
    }

    // Hoãn nộp bài nếu người dùng cấu hình submitDelayMinutes
    const delayMin = Number(config.submitDelayMinutes || 0);
    if (delayMin > 0) {
      if (log) log('info', `⏳ Hoãn nộp: Đang chờ ${delayMin} phút trước khi nộp bài theo cấu hình yêu cầu...`);
      emit?.('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
      await delay(delayMin * 60000, undefined, { signal });
      signal?.throwIfAborted();
    }

    if (log) log('info', 'Hoàn tất toàn bộ câu hỏi đề ma trận -> Đang nộp bài thi (#btn-done & #dialogConfirm)...');
    const { ok: confirmed } = await submitFinalExam(page, { log, signal });

    let scoreAchieved = null;
    let scoreText = '';
    for (let sAttempt = 0; sAttempt < 8; sAttempt++) {
      try {
        const scoreData = await page.evaluate(() => {
          const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
          const match =
            text.match(/Điểm thang 10:\s*([0-9]+(?:[\.,][0-9]+)?)/i) ||
            text.match(/Điểm bài thi:\s*([0-9]+(?:[\.,][0-9]+)?)\s*\/\s*([0-9]+(?:[\.,][0-9]+)?)/i) ||
            text.match(/([0-9]+(?:[\.,][0-9]+)?)\s*\/\s*10(?:\s*điểm)?/i) ||
            text.match(/(?:Điểm|Điểm số|Kết quả|Số điểm|Đạt)\s*[:：]?\s*([0-9]+(?:[\.,][0-9]+)?)\s*(?:\/\s*([0-9]+))?/i) ||
            text.match(/Số câu đúng:\s*([0-9]+)/i) ||
            null;
          return {
            matchStr: match ? match[0] : null,
            numStr: match ? match[1] : null,
          };
        }).catch(() => null);

        if (scoreData?.numStr) {
          scoreAchieved = scoreData.numStr.replace(',', '.');
          scoreText = scoreData.matchStr;
          break;
        }
      } catch { }
      await H.sleep(800);
    }

    if (scoreAchieved === null) {
    const chipScore = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question'));
      if (!chips.length) return null;
      const success = chips.filter(c => c.className.includes('tw-success')).length;
      return (success / chips.length * 10).toFixed(1).replace(/\.0$/, '');
    }).catch(() => null);
    if (chipScore !== null) scoreAchieved = chipScore;
  }

  if (confirmed && scoreAchieved !== null) {
      if (log) log('success', '🎯 Kết quả chấm điểm OLM: ' + (scoreText || (scoreAchieved + ' điểm')));
    }

    return {
      engine: 'browser',
      mode: 'exam-classic',
      phase: 'done',
      scanned: total,
      solved: total,
      filled,
      failed,
      submitted: confirmed,
      score: confirmed ? scoreAchieved : null,
      questions,
    };
  }

  let filled = 0;
  let failed = 0;
  const questions = [];

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const stepStart = Date.now();
    const shouldFail = wrongIndicesSet.has(index);

    // 0. Cuộn thanh chip tới câu index và click chuột thật để kích hoạt câu hiển thị chính xác
    const chipBox = await page.evaluate((idx) => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question, .chip-practice, .question-chip, .item-q, button.item-q'));
      const chip = chips[idx] || chips.find((c) => c.innerText.trim() === String(idx + 1));
      if (!chip) return null;
      try { chip.scrollIntoView({ behavior: 'instant', inline: 'center', block: 'nearest' }); } catch (e) {}
      const r = chip.getBoundingClientRect();
      const isSelected = chip.classList.contains('tw-selected') || chip.classList.contains('selected') || chip.classList.contains('active');
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, isSelected };
    }, index).catch(() => null);

    if (chipBox && !chipBox.isSelected) {
      await page.mouse.click(chipBox.x, chipBox.y);
      await H.sleep(250);
    }

    // 1. Đọc nội dung câu hỏi và đáp án đang hiển thị trên màn hình
    const currentQData = await scanCurrentQuestion(page, index, homework?.subject, log);

    // Chặn lỗi quét ảo trên màn hình kết quả: Nếu màn hình hiện tại không có bất kỳ câu hỏi nào mà đang ở trang kết quả bài làm đã nộp
    if (!currentQData?.text && (!currentQData?.options || currentQData.options.length === 0) && (!currentQData?.statements || currentQData.statements.length === 0)) {
      const isStuckOnResultScreen = await page.evaluate(() => {
        const txt = (document.body?.innerText || '').toLowerCase();
        const hasResultKeywords = /(?:tổng điểm tối đa|kết quả bài làm|kết quả luyện tập|chúc mừng bạn đã hoàn thành|tốt lắm|cứ chăm chỉ|bứt phá ngay thôi)/i.test(txt) &&
          /(?:đúng\s*\d+\/\d+\s*câu|\b\d+(?:[.,]\d+)?\s*\/\s*10\b)/i.test(txt);
        const hasAnyQuizEl = !!document.querySelector('type-quiz-x-mobile, type-quiz-x, type-mix, type-true-false-mobile, type-fill-me-mobile, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-under-line-mobile, type-under-line, type-select-text-mobile, type-select-text, type-drag-text, .qselect, [data-tf-value], .question-content, .itemx');
        return hasResultKeywords && !hasAnyQuizEl;
      }).catch(() => false);

      if (isStuckOnResultScreen) {
        if (log) log('warn', `🔒 Màn hình hiện tại là trang kết quả bài làm (OLM không hiển thị câu hỏi và đã khóa làm lại). Dừng quét ngay lập tức!`);
        break;
      }
    }

    // 2. Tìm đáp án khớp nhất qua matchDirectAnswer + fallback idq URL + Live DOM
    const urlIdq = await page.evaluate(() => {
      const m = location.href.match(/idq=(\d+)/);
      return m ? m[1] : null;
    }).catch(() => null);

    let directAns = null;
    if (urlIdq && directAnswersMap.has(String(urlIdq))) {
      directAns = { ...directAnswersMap.get(String(urlIdq)) };
    }
    if (!directAns) {
      directAns = matchDirectAnswer(currentQData, directAnswersList, directAnswersMap, index);
    }
    if (!directAns) {
      directAns = await extractLiveDomAnswer(page, index);
    }
    if (!directAns) directAns = { correctIndex: -1, answer: '', unresolved: true };

    // Clone để tránh sửa trực tiếp directAnswersList khi áp dụng điểm mục tiêu
    directAns = { ...directAns };
    let actuallyFailed = false;
    if (shouldFail) {
      const optLen = (directAns?.options?.length || currentQData?.options?.length || 4);
      if (directAns.correctIndex >= 0 && optLen > 1 && !directAns.isTrueFalse) {
        directAns.correctIndex = (directAns.correctIndex + 1) % optLen;
        directAns.correctIndices = [directAns.correctIndex];
        directAns.answer = (directAns?.options?.[directAns.correctIndex] || currentQData?.options?.[directAns.correctIndex] || '');
        directAns.correctText = directAns.answer;
        directAns.correctTexts = [directAns.answer];
        actuallyFailed = true;
      }
    }

    const qDesc = (currentQData.text || directAns.stem || directAns.text || '').slice(0, 50);
    const ansPreview = String(directAns.answer || '').replace(/\s+/g, ' ').slice(0, 90);
    const optLetter = directAns.correctIndices && directAns.correctIndices.length > 1 && !directAns.isTrueFalse
      ? (directAns.correctIndices.length > 4 || (directAns.subQuestions && directAns.subQuestions.length > 1)
        ? `[Tổ hợp ${directAns.correctIndices.length} câu trả lời] `
        : '[Nhiều đáp án: ' + directAns.correctIndices.map(i => String.fromCharCode(65 + i)).join(', ') + '] ')
      : (directAns.correctIndex >= 0 && directAns.correctIndex < 26 && !directAns.isTrueFalse ? '[Đáp án ' + String.fromCharCode(65 + directAns.correctIndex) + '] ' : '');

    if (log) {
      log('info', `📋 [Câu ${index + 1}/${total}] Quét: "${qDesc}"`);
      log('info', `🎯 [OLM API Key] Câu ${index + 1} -> ${optLetter}${ansPreview}${actuallyFailed ? ' (cố tình chọn sai để đạt điểm mục tiêu)' : ''}`);
    }

    // 3. Điền đáp án vào câu hỏi hiện tại trên màn hình (Qua bộ Inspector Đa Năng)
    const fillRes = await inspectAndFillAnyQuestion(page, directAns, { id: directAns.id || index, stem: currentQData.text || directAns.stem, options: currentQData.options }, log);

    if (fillRes.isResultScreen) {
      if (log) log('warn', `🔒 [Adaptive DevTools] Phát hiện màn hình kết quả bài làm (Điểm: ${fillRes.score || '?'}/10, không có câu hỏi trên trang). Dừng quét ngay lập tức!`);
      break;
    }

    if (fillRes.ok) {
      filled++;
      if (log) log('success', `✔ Đã chọn Câu ${index + 1}/${total}: ${optLetter}${ansPreview || 'Đã chọn'}`);
    } else {
      failed++;
      if (log) log('warn', `⚠️ Câu ${index + 1}/${total}: Không điền được đáp án`);
    }

    questions.push({ id: directAns.id || index, index: index + 1, text: qDesc, status: fillRes.ok ? 'filled' : 'failed' });
    emit?.('fill-progress', { completed: index + 1, filled, failed, total });

    const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
    if (log) log('info', `⚡ Câu ${index + 1}/${total} hoàn tất (${elapsed}s)`);

    // 4. Nếu chưa phải câu cuối: Bấm nút Next 1 lần duy nhất và CHỜ câu tiếp theo render thực sự
    if (index < total - 1) {
      const nextClicked = await page.evaluate(() => {
        const isVis = (el) => el && !el.disabled && (el.offsetWidth > 0 || el.offsetHeight > 0);
        const directNext = document.querySelector('.btn-next-question');
        if (isVis(directNext)) {
          directNext.click();
          return true;
        }
        const allBtns = Array.from(document.querySelectorAll('button, div[role=button], a.btn'));
        const nextBtn = allBtns.find(b =>
          isVis(b) &&
          !b.closest('div[role=dialog]') &&
          b.id !== 'btn-done' &&
          (b.classList.contains('btn-next-question') ||
           /^(câu tiếp|cau tiep|tiếp theo|tiep theo)$/i.test((b.innerText || '').trim()) ||
           b.innerHTML.includes('arrow-right.svg') ||
           (b.classList.contains('tw-olm-btn-primary-48') && !/kiểm tra|kiem tra|done/i.test((b.innerText || '') + ' ' + (b.id || ''))))
        );
        if (nextBtn) {
          nextBtn.click();
          return true;
        }
        const nextPartBtn = allBtns.find(b => isVis(b) && /^(phần tiếp|phan tiep)$/i.test((b.innerText || '').trim()));
        if (nextPartBtn) {
          nextPartBtn.click();
          return true;
        }
        return false;
      });

      if (!nextClicked) {
        try {
          const adaptive = require('./adaptive-solver');
          const aiNext = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'next_question', log });
          if (aiNext.status === 'locked_result') break;
        } catch { /* ignore */ }
      }

      // Chờ giao diện chuyển sang câu mới (Hỗ trợ cả Light DOM và Shadow DOM default-root)
      await H.sleep(180);
      try {
        await page.waitForFunction((oldStem) => {
          function getDeepQuestionText() {
            const lightEl = document.querySelector('.question-content, .box-content, .box-static-content, .card-body');
            if (lightEl && lightEl.innerText.trim()) return lightEl.innerText.trim().replace(/\s+/g, ' ');
            const dr = document.querySelector('default-root')?.shadowRoot;
            if (dr) {
              const comp = dr.querySelector('type-quiz-x, type-quiz-x-mobile, type-true-fasle, type-true-false, type-true-false-mobile, type-fill-me, type-fill-me-mobile, type-quiz-multi, type-quiz-multi-mobile, type-paragraph, type-paragraph-mobile, type-group-list-mobile, type-group-list, type-two-list-mobile, type-two-list, type-under-line-mobile, type-under-line, type-select-text-mobile, type-select-text, type-drag-text');
              const sr = comp?.shadowRoot || dr;
              const qEl = sr.querySelector('.question-content, #question-content, #border-word, #link-list, #group-list, #paragraph') || sr;
              if (qEl && qEl.innerText) return qEl.innerText.trim().replace(/\s+/g, ' ');
            }
            return '';
          }
          const newStem = getDeepQuestionText();
          return newStem && newStem !== oldStem;
        }, { timeout: 1500 }, currentQData.text || '').catch(() => { });
      } catch { }
      await H.sleep(100);
    }
  }

  // Hoãn nộp bài nếu người dùng cấu hình submitDelayMinutes
  const delayMin = Number(config.submitDelayMinutes || 0);
  if (delayMin > 0) {
    if (log) log('info', `⏳ Hoãn nộp: Đang chờ ${delayMin} phút trước khi nộp bài theo cấu hình yêu cầu...`);
    emit?.('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
    await delay(delayMin * 60000, undefined, { signal });
    signal?.throwIfAborted();
  }

  // 5. Nộp bài thi qua submitFinalExam (Chống race condition & modal cảnh báo)
  if (log) log('info', 'Hoàn tất trả lời toàn bộ các câu hỏi -> Đang nộp toàn bài thi (submitFinalExam)...');
  const { ok: confirmed } = await submitFinalExam(page, { log, signal });

  // 6. Đọc điểm số OLM báo (an toàn chống navigation crash)
  let scoreAchieved = null;
  let scoreText = '';
  for (let sAttempt = 0; sAttempt < 8; sAttempt++) {
    try {
      const scoreData = await page.evaluate(() => {
        const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        const match =
          text.match(/([0-9]+(?:[\.,][0-9]+)?)\s*\/\s*10(?:\s*điểm)?/i) ||
          text.match(/(?:Điểm|Điểm số|Kết quả|Số điểm|Đạt)\s*[:：]?\s*([0-9]+(?:[\.,][0-9]+)?)\s*(?:\/\s*([0-9]+))?/i);
        return {
          matchStr: match ? match[0] : null,
          numStr: match ? match[1] : null,
        };
      }).catch(() => null);

      if (scoreData?.numStr) {
        scoreAchieved = scoreData.numStr.replace(',', '.');
        scoreText = scoreData.matchStr;
        break;
      }
    } catch { }
    await H.sleep(800);
  }

  if (scoreAchieved === null) {
    const chipScore = await page.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question'));
      if (!chips.length) return null;
      const success = chips.filter(c => c.className.includes('tw-success')).length;
      return (success / chips.length * 10).toFixed(1).replace(/\.0$/, '');
    }).catch(() => null);
    if (chipScore !== null) scoreAchieved = chipScore;
  }

  if (confirmed && scoreAchieved !== null) {
    if (log) log('success', '🎯 Kết quả chấm điểm OLM: ' + (scoreText || (scoreAchieved + ' điểm')));
  }

  return {
    engine: 'browser',
    phase: 'done',
    scanned: questions.length,
    solved: filled,
    filled,
    failed,
    score: confirmed ? scoreAchieved : null,
    submitted: confirmed,
    questions,
  };
}

async function saveMaterialResult(page) {
  return page.evaluate(async () => {
    const response = await window.baseCategoryUtils?.saveResult?.({
      time_stored: Math.floor(Date.now() / 1000),
      save_star: 1,
    });
    return response === true || response?.success === true || response?.ok === true;
  }).catch(() => false);
}

// Step-by-step interactive practice (for OLM /chu-de/... practice exercises)
async function solveFlowPractice(page, { homework, config = {}, log, emit, signal, directAnswersList = [], directAnswersMap = new Map() }) {
  const answerEngine = require('./answer-engine');
  const questions = [];
  const maxQuestions = 150;
  const scorePlan = H.planWrongAnswers(Array.from({ length: directAnswersList.length }, () => ({})), config.scoreTarget);
  let step = 0;
  let finishMaterial = false;

  if (log) log('info', `Bắt đầu giải luyện tập tương tác (Target: ${config.scoreTarget || '10'}đ)...`);
  emit?.('phase', { phase: 'solving' });

  while (step < maxQuestions) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    // 1. Check if practice is finished (only after completing at least 1 question)
    if (step > 0) {
      const finishCheck = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const modal = document.querySelector('.main-modal-v2, .swal2-container, .modal-finish, .modal-result');
        const hasFinishWords = /chúc mừng bạn đã hoàn thành|bạn đã đạt|kết quả luyện tập|đừng nản lòng|hoàn thành bài tập/i.test(text);
        const hasCheckBtn = Array.from(document.querySelectorAll('button, a.btn, input[type=submit]')).some((b) =>
          /kiểm tra đáp án/i.test(b.innerText || b.value || '')
        );
        return (hasFinishWords && !hasCheckBtn) || !!(modal && /chúc mừng|kết quả|hoàn thành/i.test(modal.innerText));
      });

      if (finishCheck) {
        if (log) log('success', `🎉 Đã hoàn thành toàn bộ bài tập: "${homework.title}"`);
        break;
      }
    }

    // 2. Scan current question with retries (allow more time on step 0 for SPA to mount)
    let question = null;
    const maxRetries = step === 0 ? 12 : 5;
    for (let r = 0; r < maxRetries; r++) {
      question = await scanCurrentQuestion(page, step, homework.subject, log);
      if (question.text || question.imageBase64) break;
      await H.sleep(step === 0 ? 600 : 350);
    }

    // Self-healing fallback: if step === 0 and no question found, check if result screen is actively visible
    if (step === 0 && (!question || (!question.text && !question.imageBase64))) {
      const isResultScreen = await page.evaluate(() => {
        const text = document.body ? document.body.innerText || '' : '';
        return /đừng nản lòng|kết quả luyện tập|kết quả bài làm|chúc mừng bạn đã hoàn thành/i.test(text);
      });

      if (isResultScreen) {
        const redoClicked = await page.evaluate(() => {
          const byId = document.getElementById('btn-redo-practice') || document.querySelector('[id*="redo"]');
          if (byId) { byId.click(); return true; }
          const candidates = Array.from(document.querySelectorAll('button, a, div, span, p')).filter((el) => {
            const t = (el.innerText || el.textContent || '').trim();
            return /luyện tập lại|làm lại bài/i.test(t) && t.length < 35;
          });
          if (candidates.length > 0) {
            const btn = candidates[candidates.length - 1];
            (btn.closest('button, a, div[role=button]') || btn).click();
            return true;
          }
          return false;
        });

        if (redoClicked) {
          if (log) log('info', 'Phát hiện màn hình bài cũ, đang nhấn "Luyện tập lại"...');
          await H.sleep(1200);
          await page.evaluate(() => {
            const popupBtn = document.querySelector('.popup-primary-button, .tw-olm-btn-primary-48, .modal-confirm, .swal2-confirm');
            if (popupBtn) {
              popupBtn.click();
              return;
            }
            const cBtn = Array.from(document.querySelectorAll('button, a, div, span')).find((b) =>
              /^(xác nhận|đồng ý|xac nhan|dong y|ok)$/i.test((b.innerText || '').trim())
            );
            if (cBtn) {
              const clickable = cBtn.closest('button, a, div[role=button]') || cBtn;
              clickable.click();
            }
          });
          await H.sleep(2000);
          question = await scanCurrentQuestion(page, 0, homework.subject, log);
        }
      }
    }

    if (!question || (!question.text && !question.imageBase64)) {
      if (step === 0) {
        const resultInfo = await page.evaluate(() => {
          const text = document.body ? document.body.innerText || '' : '';
          const isResult = /đừng nản lòng|kết quả luyện tập|kết quả bài làm|chúc mừng bạn đã hoàn thành|bạn không có quyền xóa/i.test(text);
          const cannotDelete = text.includes('Bạn không có quyền xóa bài làm này');
          const scoreMatch = text.match(/(\d+(?:[.,]\d+)?)\s*\/\s*10\b/);
          const correctMatch = text.match(/Đúng\s*(\d+)\s*\/\s*(\d+)\s*câu/i);
          return {
            isResult,
            cannotDelete,
            score: scoreMatch ? Number(scoreMatch[1].replace(',', '.')) : null,
            scoreRaw: scoreMatch ? scoreMatch[0] : null,
            correct: correctMatch ? Number(correctMatch[1]) : null,
            total: correctMatch ? Number(correctMatch[2]) : null,
          };
        });

        if (resultInfo.cannotDelete || resultInfo.isResult) {
          if (log) log('warn', `🔒 [OLM] Bài tập đã làm trước đó và không cho phép xóa bài làm để làm lại. Ghi nhận bài hoàn thành (Điểm: ${resultInfo.scoreRaw || 'Đã có kết quả'}).`);
          return {
            engine: 'browser',
            phase: 'done',
            mode: 'flow',
            scanned: resultInfo.total ?? 0,
            solved: resultInfo.correct ?? 0,
            filled: resultInfo.correct ?? 0,
            failed: 0,
            submitted: true,
            score: resultInfo.score,
            alreadyCompleted: true,
            questions: [],
          };
        }

        const bodyLen = await page.evaluate(() => (document.body?.innerText || '').length);
        if (bodyLen < 50) {
          throw new Error('Trang OLM chưa tải xong nội dung (Lỗi mạng hoặc tải chậm). Vui lòng thử lại.');
        }
      }

      // Kiểm tra nút "Làm lại câu sai" nếu xuất hiện ở cuối đợt
      const hasRetryWrong = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const btn = btns.find((b) => /làm lại câu sai/i.test((b.innerText || '').trim()));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (hasRetryWrong) {
        if (log) log('info', '🔄 [OLM] Phát hiện màn hình "Làm lại câu sai". Đang bấm để tiếp tục sửa câu sai...');
        await H.sleep(2500);
        continue;
      }

      if (log) log('info', `Không còn câu hỏi tiếp theo, hoàn tất bài tập.`);
      break;
    }

    questions.push(question);
    const qDesc = String(question.text || '').replace(/\s+/g, ' ').slice(0, 50);
    const optDesc = (question.options || []).map((o, idx) => `${String.fromCharCode(65 + idx)}. ${o}`).join(' | ');
    if (log) log('info', `⏳ Đang xử lý Câu ${step + 1}: "${qDesc || (question.imageBase64 ? 'Xem hình ảnh' : '')}"${optDesc ? ` [4 đáp án: ${optDesc}]` : ''}`);
    emit?.('scan-progress', { completed: step + 1, total: step + 1 });

    // 3. Tra cứu đáp án chính xác từ API OLM qua matchDirectAnswer + fallback Live DOM
    let directAns = matchDirectAnswer(question, directAnswersList, directAnswersMap, step);
    const hasBogusDirect = directAns && (
      /^@.*@$|@(?:p\.|Math\.)/.test(String(directAns.answer || '')) ||
      (Array.isArray(directAns.answers) && directAns.answers.some((a) => /^@.*@$|@(?:p\.|Math\.)/.test(String(a || ''))))
    );
    if (!directAns || hasBogusDirect) {
      const liveDomAns = await extractLiveDomAnswer(page, step);
      if (liveDomAns) directAns = liveDomAns;
      else if (hasBogusDirect) directAns = null;
    }

    let answer;
    if (directAns) {
      const ansVal = directAns.correctText || directAns.answer || (directAns.options && directAns.correctIndex >= 0 ? directAns.options[directAns.correctIndex] : '');
      answer = {
        ...directAns,
        correctIndex: directAns.correctIndex,
        correctIndices: directAns.correctIndices || (directAns.correctIndex >= 0 ? [directAns.correctIndex] : []),
        answer: ansVal,
        source: directAns.source || 'olm-api',
      };
      const optLetter = answer.correctIndices.length > 1 && !answer.isTrueFalse
        ? '[Nhiều đáp án: ' + answer.correctIndices.map(i => String.fromCharCode(65 + i)).join(', ') + '] '
        : (answer.correctIndex >= 0 && !answer.isTrueFalse ? '[Đáp án ' + String.fromCharCode(65 + answer.correctIndex) + '] ' : '');
      if (log) log('info', '🎯 [OLM API Key] Câu ' + (step + 1) + ' -> ' + optLetter + (answer.answer || ''));
    } else {
      // Fallback: solve with AI nếu không có trong gói OLM network API
      try {
        if (question.hasImage && !question.imageBase64) throw new Error('Chưa có ảnh câu hỏi');
        answer = await answerEngine.solveQuestion(question, { signal, onLog: (lvl, msg) => log?.(lvl, msg) });
        let attempts = 0;
        while (answer.unresolved && attempts < 2) {
          attempts++;
          if (log) log('warn', `⚠️ Câu ${step + 1}: AI không xác định được đáp án (${answer.reason || 'unknown'}), thử lại lần ${attempts}...`);
          await H.sleep(600);
          try {
            const retry = await answerEngine.solveQuestion(
              { ...question, __requireAnswer: true },
              { signal, onLog: (lvl, msg) => log?.(lvl, msg) }
            );
            if (!retry.unresolved) answer = retry;
            else if (retry.answer && !answer.answer) answer = retry;
          } catch { }
        }
        const optLetter = answer.correctIndex >= 0 ? `[Đáp án ${String.fromCharCode(65 + answer.correctIndex)}] ` : '';
        const ansText = optLetter ? `${optLetter}${answer.answer || ''}` : (answer.answer || 'Đã có đáp án');
        if (!answer.unresolved) log?.('success', `✔ Câu ${step + 1} -> ${ansText}`);
      } catch (err) {
        if (log) log('warn', `⚠️ Câu ${step + 1} gặp lỗi (${err.message}), sẽ bỏ qua đáp án`);
        answer = { correctIndex: -1, answer: '', unresolved: true, reason: 'solve-error' };
      }
    }

    answer = applyWrongPlan(question, answer, step, scorePlan);
    // 4. Fill answer (luôn gọi inspectAndFillAnyQuestion: đọc toàn bộ dữ liệu DevTools để nhận diện đáp án và dạng câu hỏi rồi điền)
    await H.sleep(H.randInt(100, 180));
    let fillRes = await inspectAndFillAnyQuestion(page, answer, question, log);
    if (fillRes.isResultScreen) {
      if (log) log('warn', `🔒 [Adaptive DevTools] Trang đang ở màn hình kết quả/học liệu hoàn tất -> Kết thúc bài!`);
      break;
    }
    if (!fillRes.ok && (!answer.unresolved || answer.correctIndex >= 0 || answer.answer)) {
      fillRes = await fillCurrentQuestion(page, question, answer);
    }
    if (!fillRes.ok && log) {
      log('warn', `Câu ${step + 1}: Điền đáp án chưa tối ưu (${fillRes.reason || 'unknown'})`);
    }
    question.status = fillRes.ok ? 'filled' : 'fill-error';

    // 5. Click "Kiểm tra đáp án" (#btn-done hoặc nút kiểm tra)
    await H.sleep(H.randInt(100, 200));
    await page.evaluate(() => {
      const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
      const allBtns = [
        ...Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button]')),
        ...(root ? Array.from(root.querySelectorAll('button, a.btn, input[type=submit], div[role=button]')) : [])
      ];
      const btn = document.querySelector('#btn-done') ||
        document.querySelector('button.cmd-check') ||
        allBtns.find((b) => /kiểm tra|nop bai|nộp bài|trả lời/i.test((b.innerText || b.value || '').trim()));
      if (btn) btn.click();
    });

    const filledCount = questions.filter(item => item.status === 'filled').length;
    emit?.('fill-progress', { completed: step + 1, filled: filledCount, failed: questions.length - filledCount, total: step + 1 });
    await H.sleep(H.randInt(400, 700));

    // 6. Check if done immediately after submit
    const doneAfterSubmit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const modal = document.querySelector('.main-modal-v2, .swal2-container, .modal-finish, .modal-result');
      return (/chúc mừng|bạn đã đạt|kết quả luyện tập|đừng nản lòng|hoàn thành/i.test(text) && !/kiểm tra/i.test(text)) ||
        !!(modal && /chúc mừng|kết quả|hoàn thành/i.test(modal.innerText));
    });
    if (doneAfterSubmit) {
      log?.('info', 'Đã đến màn hình kết quả, đang chờ OLM xác nhận.');
      break;
    }

    // 7. Click "Tiếp" button if present
    await page.evaluate(() => {
      const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
      const allBtns = [
        ...Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button], span')),
        ...(root ? Array.from(root.querySelectorAll('button, a.btn, input[type=submit], div[role=button], span')) : [])
      ];
      const nextBtn = document.querySelector('#btn-next') ||
        allBtns.find((b) => /^(tiếp|câu tiếp|làm tiếp|tiếp tục|next)$/i.test((b.innerText || b.value || '').trim()));
      if (nextBtn && (nextBtn.offsetWidth > 0 || nextBtn.offsetHeight > 0)) nextBtn.click();
    });

    // 8. Chờ OLM chuyển sang câu hỏi tiếp theo hoặc hiển thị màn hình hoàn thành
    let advancedToNext = false;
    let finishDetected = false;

    for (let w = 0; w < 30; w++) {
      await H.sleep(300);

      const checkState = await page.evaluate(() => {
        const text = document.body ? document.body.innerText || '' : '';
        const modal = document.querySelector('.main-modal-v2, .swal2-container, .modal-finish, .modal-result');
        const isFinished = /(?:chúc mừng bạn đã hoàn thành|kết quả luyện tập|chúc mừng bạn|tổng điểm tối đa|hoàn thành bài tập|đừng nản lòng)/i.test(text) &&
          !/kiểm tra đáp án/i.test(text);

        const allBtns = Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button]'));
        const nextBtn = document.querySelector('#btn-next') ||
          allBtns.find((b) => /^(tiếp|câu tiếp|làm tiếp|tiếp tục|next)$/i.test((b.innerText || b.value || '').trim()));
        if (nextBtn && (nextBtn.offsetWidth > 0 || nextBtn.offsetHeight > 0)) {
          nextBtn.click();
        }

        const hasCheckBtn = allBtns.some((b) => /kiểm tra/i.test((b.innerText || b.value || '').trim()));
        return {
          isFinished: isFinished || !!(modal && /chúc mừng|kết quả|hoàn thành/i.test(modal.innerText)),
          hasCheckBtn
        };
      });

      if (checkState.isFinished) {
        if (log) log('success', `🎉 Đã hoàn thành toàn bộ bài luyện tập!`);
        finishDetected = true;
        break;
      }

      // Kiểm tra xem câu hỏi tiếp theo đã nạp nội dung mới chưa
      const nextQ = await scanCurrentQuestion(page, 0, homework.subject, null).catch(() => null);
      if (nextQ && (nextQ.text || nextQ.imageBase64)) {
        const nextText = String(nextQ.text || '').trim();
        const curText = String(question.text || '').trim();
        if (nextText && curText && nextText !== curText) {
          advancedToNext = true;
          break;
        }
      }
    }

    if (finishDetected) break;

    if (!advancedToNext) {
      // Kiểm tra xem có xuất hiện màn hình trung gian "Làm lại câu sai" không
      const hasRetry = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const btn = btns.find((b) => /làm lại câu sai/i.test((b.innerText || '').trim()));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (hasRetry) {
        if (log) log('info', '🔄 [OLM] Phát hiện màn hình "Làm lại câu sai". Đang bấm để tiếp tục sửa câu sai...');
        await H.sleep(2500);
        continue;
      }

      if (directAnswersList.length > 0 && step < directAnswersList.length - 1) {
        if (log) log('warn', `⚠️ Câu ${step + 1}: Chờ câu tiếp theo quá thời gian, thử quét tiếp...`);
      } else {
        if (log) log('info', `Không còn câu hỏi tiếp theo, hoàn tất bài tập.`);
        break;
      }
    }

    step++;
  }

  // Delay submit setting nếu người dùng yêu cầu hoãn nộp
  const delayMin = Number(config.submitDelayMinutes || 0);
  if (delayMin > 0) {
    if (log) log('info', `⏳ Hoãn nộp: Đang chờ ${delayMin} phút trước khi nộp bài theo cấu hình yêu cầu...`);
    if (emit) emit('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
    await delay(delayMin * 60000, undefined, { signal });
    signal?.throwIfAborted();
  } else {
    await H.sleep(600);
  }

  signal?.throwIfAborted();
  const savedMaterial = finishMaterial && await saveMaterialResult(page);
  let submitted = savedMaterial || (await submitFinalExam(page, { log, signal })).ok;

  // Đọc kết quả điểm số thực tế từ OLM DOM (chính xác 100%, không báo khống)
  const officialResult = await page.evaluate(() => {
    const text = document.body ? document.body.innerText || '' : '';
    const scoreMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*10/);
    const correctMatch = text.match(/Đúng\s*(\d+)\s*\/\s*(\d+)\s*câu/i);
    const wrongMatch = text.match(/Sai\s*(\d+)\s*\/\s*(\d+)\s*câu/i);
    const timeMatch = text.match(/Thời gian làm bài\s*([^\n\r]+)/i);
    let score = scoreMatch ? Number(scoreMatch[1]) : null;
    if (score === null && correctMatch && Number(correctMatch[2]) > 0) {
      score = Number(((Number(correctMatch[1]) / Number(correctMatch[2])) * 10).toFixed(1));
    }
    return {
      score,
      scoreRaw: scoreMatch ? scoreMatch[0] : (score !== null ? `${score}/10` : null),
      correct: correctMatch ? Number(correctMatch[1]) : null,
      total: correctMatch ? Number(correctMatch[2]) : null,
      wrong: wrongMatch ? Number(wrongMatch[1]) : null,
      time: timeMatch ? timeMatch[1].trim() : null,
    };
  }).catch(() => ({}));

  if (!submitted && (officialResult.score != null || officialResult.correct != null)) {
    submitted = true;
  }

  if (submitted && officialResult.score != null && log) {
    log('success', `🏆 [OLM Thật] Kết quả bài làm: ${officialResult.scoreRaw} | Đúng: ${officialResult.correct}/${officialResult.total || '?'} câu | Sai: ${officialResult.wrong ?? '?'} câu${officialResult.time ? ` | Thời gian: ${officialResult.time}` : ''}`);
  }

  return {
    engine: 'browser',
    phase: submitted ? 'done' : 'filled',
    mode: 'flow',
    scanned: officialResult.total || questions.length,
    solved: officialResult.correct ?? questions.length,
    filled: questions.filter(q => q.status === 'filled').length,
    failed: questions.filter(q => q.status !== 'filled').length,
    score: submitted ? officialResult.score ?? await readScoreFromPage(page) : null,
    submitted,
    questions: questions.map((q, idx) => ({ id: q.id, index: idx, type: q.type, text: q.text, status: q.status || 'unresolved' })),
  };
}

// Giải đề thi PDF / Word kèm phiếu trả lời OMR (exam-file.js + view-categories-pdf.js)
async function solveOmrPdfExam(page, { homework, config = {}, log, emit, signal }) {
  // 1. Đóng overlay bắt đầu thi (#exam-start-overlay / #btn-start-exam-overlay) nếu đang hiển thị
  await page.evaluate(() => {
    const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
    const startOverlayBtn = document.querySelector('#btn-start-exam-overlay');
    if (isVis(startOverlayBtn)) {
      startOverlayBtn.click();
    } else if (window.BASEEXAM?.handleStartExam && isVis(document.querySelector('#exam-start-overlay:not(.tw-hidden)'))) {
      window.BASEEXAM.handleStartExam();
    }
  }).catch(() => { });
  await H.sleep(800);

  // 2. Kiểm tra xem bài thi OMR đã nộp từ trước chưa (done_exam / .lst-result)
  const checkOmrDoneState = async () => {
    const isDone = await submissionConfirmed(page, { signal, omr: true });
    return page.evaluate((isDone) => {
      const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
      const redoBtn = document.querySelector('.btn-redo-exam button, #btn-redo-exam, .btn-redo-exam');
      const scoreEl = document.querySelector('.lst-result b.tw-text-20, .lst-result b');
      const bodyText = document.body ? document.body.innerText || '' : '';
      const correctMatch = bodyText.match(/Số câu đúng\s*(\d+)\s*\/\s*(\d+)/i) || bodyText.match(/(\d+)\s*\/\s*(\d+)\s*câu/i);
      let score = scoreEl ? parseFloat(scoreEl.innerText.trim().replace(',', '.')) : null;
      if (score === null || Number.isNaN(score)) {
        const sm = bodyText.match(/Điểm\s*(\d+(?:[.,]\d+)?)/i);
        if (sm) score = parseFloat(sm[1].replace(',', '.'));
      }
      let rBox = null;
      if (isVis(redoBtn)) {
        const r = redoBtn.getBoundingClientRect();
        rBox = { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (redoBtn.innerText || 'Làm lại bài').trim() };
      }
      return {
        isDone,
        canRedo: !!rBox,
        redoBox: rBox,
        score: Number.isFinite(score) ? score : null,
        correct: correctMatch ? Number(correctMatch[1]) : null,
        total: correctMatch ? Number(correctMatch[2]) : document.querySelectorAll('.q-handle').length,
        correctText: correctMatch ? `${correctMatch[1]}/${correctMatch[2]} câu` : null,
      };
    }, isDone).catch(() => ({ isDone, canRedo: false }));
  };

  let omrState = await checkOmrDoneState();
  if (omrState.isDone && omrState.canRedo && omrState.redoBox) {
    if (log) log('info', `🔄 Đề thi PDF/Word đã làm trước đó -> Đang nhấn "${omrState.redoBox.text}" để làm lại...`);
    await page.mouse.click(omrState.redoBox.x, omrState.redoBox.y);
    await H.sleep(1000);
    await page.evaluate(() => {
      const confirmBtn = document.querySelector('#btn-confirm-dialog-confirm-v2, .popup-primary-button, #dialog-yes, .swal2-confirm');
      if (confirmBtn && (confirmBtn.offsetWidth > 0 || confirmBtn.offsetHeight > 0)) {
        confirmBtn.click();
      }
    }).catch(() => { });
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => { });
    await H.sleep(1500);
    await page.evaluate(() => {
      const startOverlayBtn = document.querySelector('#btn-start-exam-overlay');
      if (startOverlayBtn && (startOverlayBtn.offsetWidth > 0 || startOverlayBtn.offsetHeight > 0)) {
        startOverlayBtn.click();
      }
    }).catch(() => { });
    await H.sleep(1000);
    omrState = await checkOmrDoneState();
  }

  if (omrState.isDone) {
    const sc = Number.isFinite(omrState.score) ? String(omrState.score) : null;
    if (log) {
      log(
        'info',
        `ℹ️ Bài thi PDF/Word "${homework.title}" đã được nộp từ trước (Điểm: ${sc == null ? 'chưa đọc được' : sc + '/10'}${omrState.correctText ? ` | Đúng: ${omrState.correctText}` : ''}) và giáo viên khóa không cho phép làm lại.`
      );
    }
    return {
      engine: 'browser',
      mode: 'omr-pdf',
      phase: 'done',
      scanned: omrState.total ?? 0,
      solved: omrState.correct ?? 0,
      filled: omrState.correct ?? 0,
      failed: 0,
      submitted: true,
      alreadyCompleted: true,
      score: sc,
      questions: [],
    };
  }

  // 3. Giải mã đáp án gốc từ API /course/teacher-categories/{id}/get-crt-ans-file
  const answerKey = await page.evaluate(async () => {
    try {
      const idCate = window.baseCategoryUtils?.getData?.('id_category') ||
        (window.location.pathname.match(/-(\d+)$/)?.[1]);
      if (idCate && typeof window._apiGet === 'function') {
        const raw = await window._apiGet(`/course/teacher-categories/${idCate}/get-crt-ans-file`);
        if (raw) {
          let decodedStr = '';
          if (window.baseCategoryUtils?.OlmEncode?.decode) {
            decodedStr = window.baseCategoryUtils.OlmEncode.decode(raw);
          } else {
            const bin = atob(raw);
            if (/^\s*[\[{]/.test(bin)) {
              decodedStr = bin;
            } else {
              const key = '1047823200';
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i) ^ key.charCodeAt(i % key.length);
              }
              decodedStr = new TextDecoder('utf-8').decode(bytes);
            }
          }
          const parsed = JSON.parse(decodedStr);
          if (window.EXAM_FILE?.values) {
            window.EXAM_FILE.values.result_question = parsed;
          }
          return parsed;
        }
      }
      const existing = window.EXAM_FILE?.values?.result_question;
      if (existing && (existing.fc || existing.tf || existing.dg || existing.nrq)) {
        return existing;
      }
      return null;
    } catch {
      return null;
    }
  });

  if (!answerKey || (!answerKey.fc && !answerKey.tf && !answerKey.dg && !answerKey.nrq)) {
    throw new Error('Không lấy được đáp án phiếu trả lời OMR từ máy chủ OLM (get-crt-ans-file).');
  }

  const flatQuestions = [];
  const sections = ['fc', 'tf', 'dg', 'nrq'];
  for (const sec of sections) {
    const secObj = answerKey[sec];
    if (secObj && typeof secObj === 'object') {
      const qids = Object.keys(secObj).sort((a, b) => Number(a) - Number(b));
      for (const qid of qids) {
        flatQuestions.push({
          type: sec,
          qid: String(qid),
          answer: secObj[qid]?.answer,
          score: secObj[qid]?.score,
        });
      }
    }
  }

  const total = flatQuestions.length;
  if (log) log('success', `🎯 [OLM OMR API] Đã giải mã thành công đáp án chính xác cho ${total} câu trên phiếu trả lời PDF/Word!`);
  emit?.('phase', { phase: 'solving', total });

  // 4. Tính toán số câu cố tình làm sai nếu người dùng đặt mục tiêu điểm < 10
  const wrongIndices = new Set();
  const targetScoreNum = parseFloat(config.scoreTarget);
  if (Number.isFinite(targetScoreNum) && targetScoreNum >= 0 && targetScoreNum < 10 && total > 0) {
    const wrongCount = Math.max(0, Math.round(total * (10 - targetScoreNum) / 10));
    for (let i = 0; i < wrongCount && i < total; i++) {
      wrongIndices.add(total - 1 - i);
    }
    if (wrongCount > 0 && log) {
      log('info', `🎯 [Mục tiêu ${targetScoreNum}đ] Sẽ cố tình làm sai ${wrongCount}/${total} câu trên phiếu OMR.`);
    }
  }

  let filled = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const q = flatQuestions[i];
    const isWrong = wrongIndices.has(i);

    if (q.type === 'fc') {
      let targetInds = Array.isArray(q.answer) ? q.answer.map(Number) : [Number(q.answer ?? 0)];
      const fcRes = await page.evaluate((qid, inds, makeWrong) => {
        const row = document.querySelector(`.q-handle-fc[data-id="fc-${qid}"], #fc-${qid}`);
        if (!row) return { ok: false, inds };
        row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        const spans = Array.from(row.querySelectorAll('.tw-olm-chip-question, .q-ans'));
        if (makeWrong && spans.length > 0) {
          const available = spans.map(s => Number(s.getAttribute('data-id'))).filter(Number.isFinite);
          const alt = available.find(id => !inds.includes(id));
          if (alt !== undefined) inds = [alt];
          else if (spans.length > 1) inds = [((inds[0] || 0) + 1) % spans.length];
        }
        // Bỏ chọn những ô đang checked nhưng không nằm trong inds
        for (const sp of spans) {
          const idNum = Number(sp.getAttribute('data-id'));
          const isChecked = sp.classList.contains('checked') || sp.classList.contains('tw-selected');
          if (isChecked && !inds.includes(idNum)) {
            sp.click();
            sp.classList.remove('checked', 'tw-selected');
          }
        }
        // Chọn đúng các ô trong inds
        for (const targetIdx of inds) {
          const sp = spans.find(s => Number(s.getAttribute('data-id')) === targetIdx);
          if (sp) {
            if (!sp.classList.contains('checked')) {
              sp.click();
            }
            sp.classList.add('checked', 'tw-selected');
          }
        }
        return { ok: true, inds };
      }, q.qid, targetInds, isWrong);

      if (fcRes?.ok) {
        filled++;
        q.status = 'filled';
        const usedInds = Array.isArray(fcRes.inds) ? fcRes.inds : targetInds;
        const letters = usedInds.map(idx => String.fromCharCode(65 + idx)).join(', ');
        if (log) log('success', `✔ [Phiếu OMR - Trắc nghiệm] Câu ${q.qid}: Chọn đáp án ${letters}${isWrong ? ' (cố tình sai theo mục tiêu)' : ''}`);
      } else {
        failed++;
        q.status = 'failed';
      }
    } else if (q.type === 'tf') {
      let ansArr;
      if (Array.isArray(q.answer)) {
        ansArr = q.answer.map(Number);
      } else if (q.answer && typeof q.answer === 'object') {
        ansArr = ['A', 'B', 'C', 'D'].map((lt, idx) => Number(q.answer[lt] ?? q.answer[idx] ?? 1));
      } else {
        ansArr = [1, 1, 1, 1];
      }
      if (isWrong && ansArr.length > 0) {
        ansArr[0] = ansArr[0] === 1 ? 0 : 1;
      }
      const ok = await page.evaluate((qid, arr) => {
        const letters = ['A', 'B', 'C', 'D'];
        let foundAny = false;
        letters.forEach((lt, idx) => {
          const targetVal = Number(arr[idx] ?? 1);
          const row = document.querySelector(`.q-handle-tf[data-id="tf-${qid}-${lt}"], #tf-${qid}-${lt}`);
          if (!row) return;
          foundAny = true;
          row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
          const spans = Array.from(row.querySelectorAll('.tw-olm-chip-question, .q-ans'));
          for (const sp of spans) {
            const idNum = Number(sp.getAttribute('data-id'));
            if (sp.classList.contains('checked') && idNum !== targetVal) {
              sp.click();
              sp.classList.remove('checked', 'tw-selected');
            }
          }
          const targetSp = spans.find(s => Number(s.getAttribute('data-id')) === targetVal);
          if (targetSp) {
            if (!targetSp.classList.contains('checked')) {
              targetSp.click();
            }
            targetSp.classList.add('checked', 'tw-selected');
          }
        });
        return foundAny;
      }, q.qid, ansArr);

      if (ok) {
        filled++;
        q.status = 'filled';
        const desc = ansArr.map((v, idx) => `${String.fromCharCode(97 + idx)})${v === 1 ? 'Đ' : 'S'}`).join(' ');
        if (log) log('success', `✔ [Phiếu OMR - Đúng/Sai] Câu ${q.qid}: ${desc}${isWrong ? ' (cố tình sai theo mục tiêu)' : ''}`);
      } else {
        failed++;
        q.status = 'failed';
      }
    } else if (q.type === 'dg') {
      const ansStr = isWrong ? '9999' : String(q.answer ?? '').trim();
      const ok = await page.evaluate((qid, val) => {
        const row = document.querySelector(`.q-handle-dg[data-id="dg-${qid}"], #dg-${qid}`);
        if (!row) return false;
        row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        const input = row.querySelector('textarea[name="digit"], input[name="digit"], input, textarea');
        if (!input) return false;
        const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, val);
        else input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        return true;
      }, q.qid, ansStr);

      if (ok) {
        filled++;
        q.status = 'filled';
        if (log) log('success', `✔ [Phiếu OMR - Điền đáp án] Câu ${q.qid}: "${ansStr}"${isWrong ? ' (cố tình sai theo mục tiêu)' : ''}`);
      } else {
        failed++;
        q.status = 'failed';
      }
    } else if (q.type === 'nrq') {
      const ok = await page.evaluate((qid, rawAns, makeWrong) => {
        const row = document.querySelector(`.q-handle-nrq[data-id="nrq-${qid}"], #nrq-${qid}`);
        if (!row) return { ok: false };
        const bubbleCols = Array.from(row.querySelectorAll('.nrq-bubble[data-col]')).map(b => Number(b.getAttribute('data-col'))).filter(Number.isFinite);
        const domColCount = bubbleCols.length > 0 ? Math.max(...bubbleCols) + 1 : 4;
        const parseSlots = (val, colCount) => {
          const maxCols = Math.max(4, colCount);
          if (makeWrong) return Array.from({ length: maxCols }, () => '9');
          if (Array.isArray(val) && val.length > 0) {
            const arr = val.map(x => (x == null ? '' : String(x)));
            while (arr.length < maxCols) arr.push('');
            return arr;
          }
          const s = String(val ?? '').trim().replace(/\./g, ',').replace(/\s/g, '');
          const slots = [];
          for (let c = 0; c < s.length; c++) {
            const ch = s[c];
            if (slots.length === 0 && ch === '-') slots.push('-');
            else if (slots.length >= 1 && ch === ',') slots.push(',');
            else if (/^[0-9]$/.test(ch)) slots.push(ch);
          }
          const finalLen = Math.max(maxCols, slots.length);
          while (slots.length < finalLen) slots.push('');
          return slots;
        };
        const slots = parseSlots(rawAns, domColCount);
        row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        const hiddenInput = row.querySelector('input[name="nrq-slots-json"]');
        if (hiddenInput) {
          hiddenInput.value = JSON.stringify(slots);
          hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
          hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        for (let col = 0; col < slots.length; col++) {
          const targetCh = slots[col];
          const colBubbles = Array.from(row.querySelectorAll(`.nrq-bubble[data-col="${col}"]`));
          for (const b of colBubbles) {
            const ch = String(b.getAttribute('data-ch') ?? '');
            const isChecked = b.classList.contains('checked') || b.getAttribute('aria-pressed') === 'true';
            if (isChecked && ch !== targetCh) b.click();
          }
          if (targetCh !== '') {
            const targetBtn = row.querySelector(`.nrq-bubble[data-col="${col}"][data-ch="${targetCh}"]`);
            if (targetBtn && !targetBtn.classList.contains('checked') && targetBtn.getAttribute('aria-pressed') !== 'true') {
              targetBtn.click();
            }
          }
        }
        if (window.EXAM_FILE?.values?.user_ans) {
          window.EXAM_FILE.values.user_ans.nrq = window.EXAM_FILE.values.user_ans.nrq || {};
          window.EXAM_FILE.values.user_ans.nrq[qid] = slots;
          window.EXAM_FILE.syncNrqUserAnsToDom?.();
        }
        return { ok: true, text: slots.join('') };
      }, q.qid, q.answer, isWrong);

      if (ok?.ok) {
        filled++;
        q.status = 'filled';
        if (log) log('success', `✔ [Phiếu OMR - Trả lời ngắn] Câu ${q.qid}: "${ok.text}"${isWrong ? ' (cố tình sai theo mục tiêu)' : ''}`);
      } else {
        failed++;
        q.status = 'failed';
      }
    }

    emit?.('fill-progress', { completed: i + 1, filled, failed, total });
    await H.sleep(80);
  }

  // Chờ setTimeout(..., 100) của React FCQuestion/TFQuestion hoàn tất rồi đồng bộ vào localStorage của EXAM_FILE
  await H.sleep(250);
  await page.evaluate(() => {
    try {
      window.EXAM_FILE?.autoSave?.();
    } catch { }
  }).catch(() => { });

  // 5. Hoãn nộp nếu có cấu hình submitDelayMinutes
  const delayMin = Number(config.submitDelayMinutes || 0);
  if (delayMin > 0) {
    if (log) log('info', `⏳ Hoãn nộp: Chờ ${delayMin} phút trước khi nộp phiếu trả lời OMR...`);
    emit?.('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
    await delay(delayMin * 60000, undefined, { signal });
    signal?.throwIfAborted();
  } else {
    await H.sleep(500);
  }

  // 6. Nhấn nút Nộp bài (.btn-submit-cate) và xác nhận
  signal?.throwIfAborted();
  if (log) log('info', '📤 Đang nộp phiếu trả lời PDF/Word lên máy chủ OLM...');
  const { ok: submitted } = await submitFinalExam(page, { log, signal, omr: true });
  const finalScore = submitted ? (await checkOmrDoneState()).score ?? await readScoreFromPage(page) : null;

  if (submitted && log) {
    log('success', 'Hoàn tất nộp đề thi PDF/Word "' + homework.title + '"' +
      (finalScore != null ? ' · Điểm: ' + finalScore : ''));
  }

  return {
    engine: 'browser',
    mode: 'omr-pdf',
    phase: submitted ? 'done' : 'filled',
    scanned: total,
    solved: filled,
    filled,
    failed,
    submitted,
    score: finalScore,
    questions: flatQuestions.map((q, idx) => ({ id: `${q.type}-${q.qid}`, index: idx, type: q.type, status: q.status || (failed === 0 ? 'filled' : 'failed') })),
  };
}

// Work through one homework in the browser.
async function solveHomework(browser, { homework, session, config = {}, log, emit, signal }) {
  const { trustedOlmUrl } = require('./olm-client');
  const homeworkUrl = trustedOlmUrl(homework.url);
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    await guardOlmPage(page);

    const proxy = require('./proxy').parseProxy();
    if (proxy && proxy.username && proxy.password) {
      await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => { });
    }

    // deviceScaleFactor=2 -> ảnh chụp sắc nét hơn gấp 2, giúp Vision AI đọc
    // đúng công thức/sơ đồ (bài Hóa 12 nhiều công thức).
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
    await page.setUserAgent((session && session.ua) || H.pick(require('./olm-client').USER_AGENTS));

    // Bẫy 3: Bẻ khóa chống gian lận OLM (Giả lập Fullscreen + Chặn phát hiện chuyển tab / mất focus + Ẩn navigator.webdriver)
    // và Giả lập Microphone / Speech Recognition cho dạng câu hỏi Luyện nói / Ghi âm (q_type: 10, 15)
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = window.chrome || { runtime: {} };
        Object.defineProperty(document, 'fullscreenElement', { get: () => document.documentElement });
        Object.defineProperty(document, 'webkitFullscreenElement', { get: () => document.documentElement });
        Element.prototype.requestFullscreen = async () => Promise.resolve();

        Object.defineProperty(document, 'hidden', { get: () => false });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        window.addEventListener('blur', (e) => e.stopImmediatePropagation(), true);
        document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);

        // Mock Microphone & Speech Recognition
        if (navigator.mediaDevices) {
          let audio;
          navigator.mediaDevices.getUserMedia = async () => {
            if (!audio) {
              const context = new (window.AudioContext || window.webkitAudioContext)();
              const oscillator = context.createOscillator();
              const destination = context.createMediaStreamDestination();
              oscillator.connect(destination);
              oscillator.start();
              audio = { context, oscillator, destination };
            }
            return audio.destination.stream.clone();
          };
          addEventListener('pagehide', event => {
            if (!event.persisted && audio) {
              audio.oscillator.stop();
              audio.context.close().catch(() => {});
              audio = null;
            }
          });
        }
        window.webkitSpeechRecognition = window.SpeechRecognition = class {
          constructor() {
            this.continuous = false;
            this.interimResults = false;
          }
          start() {
            setTimeout(() => {
              const prompt = document.querySelector('.speaking-prompt, .target-sentence, .question-content')?.innerText || '';
              if (typeof this.onresult === 'function') {
                this.onresult({
                  results: [[{ transcript: prompt.trim(), confidence: 0.99 }]]
                });
              }
              if (typeof this.onend === 'function') this.onend();
            }, 400);
          }
          stop() {
            if (typeof this.onend === 'function') this.onend();
          }
          abort() { }
        };
      } catch { }
    }).catch(() => { });

    // OLM Direct Decoder: Intercept 'get-question-of-ids' response
    const olmDirectDecoder = require('./olm-direct-decoder');
    const directAnswersMap = new Map();
    const directAnswersList = [];

    const pendingResponses = new Set();
    const readResponse = async (res) => {
      try {
        const url = res.url();
        // Bắt mọi lỗi hoặc thông báo mạng từ API OLM và in ra log đúng nguyên văn
        if ((url.includes('/course/') || url.includes('/classes/') || url.includes('/api/')) && res.status() >= 400) {
          try {
            const errText = await res.text();
            let msg = errText;
            try {
              const parsed = JSON.parse(errText);
              msg = parsed.message?.[0] || parsed.error || parsed.message || errText;
            } catch { }
            if (log) log('warn', `[OLM Phản hồi HTTP ${res.status()}] ${msg}`);
          } catch { }
        }

        if (url.includes('get-question-of-ids') || url.includes('/course/question/') || url.includes('get-test') || url.includes('get-lesson') || url.includes('courseware/get-test')) {
          const ct = res.headers()['content-type'] || '';
          if (ct.includes('json') || ct.includes('javascript') || ct.includes('text')) {
            const text = await res.text();
            const parsed = JSON.parse(text);
            const rawList = Array.isArray(parsed) ? parsed : (parsed.data?.questions || parsed.data?.content || parsed.data || parsed.questions || []);
            if (Array.isArray(rawList) && rawList.length > 0) {
              const decoded = olmDirectDecoder.decodeQuestionsPayload(rawList);
              let addedCount = 0;
              decoded.forEach((item) => {
                const qKey = item.id == null ? null : String(item.id);
                if (qKey && directAnswersMap.has(qKey)) {
                  return; // Tránh trùng lặp khi OLM gọi lại API nhiều lần
                }
                directAnswersList.push(item);
                addedCount++;
                if (qKey !== null) directAnswersMap.set(qKey, item);
              });
              if (log && addedCount > 0) log('success', '🎯 [OLM Network API] Đã giải mã thành công ' + addedCount + ' câu hỏi kèm đáp án chính xác từ server OLM!');
            }
          }
        }
      } catch { }
    };
    page.on('response', res => {
      const task = readResponse(res);
      pendingResponses.add(task);
      task.finally(() => pendingResponses.delete(task));
    });
    async function waitForAnswers() {
      if (directAnswersList.length > 0 && pendingResponses.size === 0) {
        signal?.throwIfAborted();
        return;
      }
      await page.waitForNetworkIdle({ idleTime: 250, timeout: 1500 }).catch(() => {});
      if (pendingResponses.size > 0) {
        await Promise.race([Promise.allSettled([...pendingResponses]), delay(1000, undefined, { ref: false })]);
      }
      signal?.throwIfAborted();
    }

    // Inject session cookies if provided (supports both cookieJar and browserEngine.login session.cookies)
    const jar = session?.cookieJar || session?.client?.jar;
    let rawCookies = Array.isArray(session?.cookies) && session.cookies.length > 0
      ? session.cookies
      : jar?.cookies;
    if (!rawCookies && jar && typeof jar.getCookies === 'function') {
      rawCookies = await jar.getCookies('https://olm.vn').catch(() => []);
    }
    if (Array.isArray(rawCookies) && rawCookies.length > 0) {
      const pCookies = rawCookies.map((c) => ({
        name: c.key || c.name,
        value: c.value,
        domain: (c.hostOnly ? '' : '.') + (c.domain || 'olm.vn').replace(/^\./, ''),
        path: c.path || '/',
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        ...(typeof c.expires === 'number' && c.expires > 0
          ? { expires: c.expires }
          : (c.expires && Number.isFinite(Date.parse(c.expires)) ? { expires: Date.parse(c.expires) / 1000 } : {})),
      }));
      if (pCookies.length > 0) {
        await context.setCookie(...pCookies);
      }
    }

      if (log) log('info', `Mở bài tập: ${homework.url}`);
      let navOk = false;
      let lastNavErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
        try {
          if (log && attempt > 1) log('info', `Đang thử tải lại trang bài tập (lần ${attempt}/3)...`);
          await page.goto(homeworkUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          navOk = true;
          break;
        } catch (navErr) {
          lastNavErr = navErr;
          if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
          if (log) log('warn', `Trang tải chậm (${navErr.message})`);
          await H.sleep(1500);
        }
      }
      if (!navOk) {
        throw new Error(`Không thể tải trang bài tập OLM (${lastNavErr?.message || 'net::ERR_TIMED_OUT'}). Vui lòng kiểm tra lại kết nối mạng.`);
      }

    // Check if Cloudflare Turnstile challenge is present
    try {
      const pageTitle = await page.title().catch(() => '');
      if (/just a moment|cloudflare/i.test(pageTitle)) {
        if (log) log('info', 'Đang vượt bảo vệ Cloudflare...');
        for (const frame of page.frames()) {
          try {
            const cfBox = await frame.$('input[type="checkbox"], #challenge-stage, .ctp-checkbox-label');
            if (cfBox) {
              await cfBox.click();
              await H.sleep(3000);
              break;
            }
          } catch { }
        }
      }
    } catch { }

    // 1. Chờ OLM Single Page Application mount giao diện
    try {
      await page.waitForFunction(() => {
        const hasRedo = document.querySelector('#btn-redo-practice, #btn-redo-exam, .btn-redo-exam') ||
          Array.from(document.querySelectorAll('button, a, div[role=button]')).some(b => {
            if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
            return /^(luyện tập lại|làm lại bài|làm lại)$/i.test((b.innerText || '').trim());
          });
        const hasChips = document.querySelector('.tw-olm-chip-question');
        // Giao diện mới: danh sách câu render trong .itemx.q-view-itemx.question
        const hasModernItems = document.querySelector('.itemx.q-view-itemx.question, .box-list-static-question');
        const hasQuiz = document.querySelector('default-root') ||
          document.querySelector('.question-content, #paragraph, type-quiz-x, type-quiz-x-mobile');
        const hasResult = document.querySelector('.practice-result, .box-result, .box-score') ||
          /đừng nản lòng|kết quả luyện tập|xem đáp án/i.test(document.body?.innerText || '');
        const hasStart = document.querySelector('#btn-start, #btn-start-test, #btn-start-exam, .btn-start-exam, .btn-start, .btn-start-test, .btn-do-homework, #btn-continue') ||
          Array.from(document.querySelectorAll('button, a, div[role=button]')).some(b => {
            if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
            const norm = (b.innerText || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
            return /^(bat dau lam bai|bat dau thi|bat dau|vao thi|vao lam bai|tiep tuc lam bai|lam tiep)$/i.test(norm);
          });
        const hasLoginReq = /bạn cần đăng nhập để có thể làm bài thi này|yêu cầu đăng nhập/i.test(document.body?.innerText || '');
        const hasMedia = document.querySelector('video, iframe, canvas.pdf-canvas, .omr-sheet, .sheet-answer');
        return !!(hasRedo || hasChips || hasModernItems || hasQuiz || hasResult || hasStart || hasLoginReq || hasMedia);
      }, { timeout: 15000 });
    } catch { }

    // Tự động khôi phục phiên đăng nhập nếu OLM báo "Yêu cầu đăng nhập: Bạn cần đăng nhập để có thể làm bài thi này"
    const needsRelogin = await page.evaluate(() => {
      return /bạn cần đăng nhập để có thể làm bài thi này|yêu cầu đăng nhập/i.test(document.body ? document.body.innerText : '');
    }).catch(() => false);

    if (needsRelogin || /\/dang-?nhap(?:[/?#]|$)/i.test(page.url())) {
      throw new Error('Phiên OLM đã hết hạn. Vui lòng đăng xuất rồi đăng nhập lại.');
    }

    // Bẫy 1: Ưu tiên số 1 - Kiểm tra xem bài có đang làm dở không ("Tiếp tục làm bài" / "Làm tiếp")
    const continueBox = await page.evaluate(() => {
      function getAllDeep(sel, root = document, depth = 0) {
      if (depth > 12) return [];
        let results = [];
        try { results.push(...Array.from(root.querySelectorAll(sel))); } catch { }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        let n;
        while ((n = walker.nextNode())) {
          if (n.shadowRoot) {
            try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch { }
          }
        }
        return Array.from(new Set(results));
      }
      const allBtns = getAllDeep('button, a, div[role=button], input[type=button]');
      const btn = allBtns.find(b => {
        if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
        const t = (b.innerText || b.textContent || b.value || '').trim();
        const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        return /^(tiep tuc lam bai|lam tiep|vao lam tiep|tiep tuc)$/i.test(norm) ||
          b.id === 'btn-continue' || b.id === 'btn-continue-test' || b.classList.contains('btn-continue');
      });
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: btn.innerText.trim() };
    });

    if (continueBox) {
      if (log) log('info', `Phát hiện bài đang làm dở -> Nhấn "${continueBox.text}" để làm tiếp...`);
      await page.mouse.click(continueBox.x, continueBox.y);
      await H.sleep(2000);
    }

    // 2. Tự động bấm "Làm lại bài" / "Luyện tập lại" (#btn-redo-practice, #btn-redo-exam) nếu trang đang ở màn hình kết quả bài cũ
    let redoClicked = false;
    for (let rCheck = 0; rCheck < 5; rCheck++) {
      const redoScreenState = await page.evaluate(() => {
        const text = (document.body ? document.body.innerText || '' : '').toLowerCase();
        const hasRedoBtn = !!Array.from(document.querySelectorAll('#btn-redo-practice, #btn-redo-exam, [id*="redo"], button, a, div[role=button], .btn')).find(el => {
          if (el.offsetWidth <= 0 && el.offsetHeight <= 0) return false;
          if (el.id === 'btn-redo-practice' || el.id === 'btn-redo-exam' || (el.id && el.id.includes('redo'))) return true;
          const t = (el.innerText || el.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
          return /^(lam lai bai|luyen tap lai|lam lai|lam lai de)$/i.test(t);
        });
        const hasResultBox = !!document.querySelector('.practice-result, .box-result, .box-score, [class*="ket-qua"], .test-result, .toolbar-done-item, .lst-result');
        const hasResultText = /(?:kết quả luyện tập|kết quả bài làm|chúc mừng bạn đã hoàn thành|điểm của bạn|đừng nản lòng|hãy giữ vững phong độ|tốt lắm|cứ chăm chỉ|bứt phá ngay thôi|tổng điểm tối đa|xuất sắc|xem đáp án)/i.test(text);
        const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question'))
          .filter(c => !c.closest('.q-handle, #cate-pdf-container'));
        const anyChipDone = chips.length > 0 && chips.some(c =>
          c.className.includes('tw-success') || c.className.includes('tw-wrong') ||
          c.className.includes('answered') || c.className.includes('done')
        );
        const hasCheckBtn = Array.from(document.querySelectorAll('button, a, input[type=submit]')).some(b => /kiểm tra đáp án/i.test(b.innerText || b.value || ''));
        const isFreshQuiz = (chips.length > 0 && !anyChipDone) || (hasCheckBtn && !hasRedoBtn);
        return {
          isResultScreen: hasRedoBtn || hasResultBox || hasResultText || anyChipDone,
          isFreshQuiz: isFreshQuiz && !hasRedoBtn,
          hasRedoBtn: !!hasRedoBtn
        };
      }).catch(() => ({ isResultScreen: false, isFreshQuiz: false, hasRedoBtn: false }));

      if (!redoScreenState.isFreshQuiz && (redoScreenState.isResultScreen || redoScreenState.hasRedoBtn || config.forceRedo || homework.forceRedo || homework.isDone)) {
        const redoTarget = await page.evaluate(() => {
          const byId = document.getElementById('btn-redo-practice') || document.getElementById('btn-redo-exam') || document.querySelector('[id*="redo"]');
          if (byId && (byId.offsetWidth > 0 || byId.offsetHeight > 0)) {
            byId.scrollIntoView({ behavior: 'instant', block: 'center' });
            const r = byId.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: byId.innerText.trim() || 'Làm lại bài' };
          }

          const allBtns = Array.from(document.querySelectorAll('button, a, div[role=button], .btn')).filter(el => {
            const text = (el.innerText || el.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
            const isVis = el.offsetWidth > 0 || el.offsetHeight > 0;
            return isVis && /^(lam lai bai|luyen tap lai|lam lai|lam lai de)$/i.test(text);
          });

          if (allBtns.length > 0) {
            const target = allBtns[0];
            target.scrollIntoView({ behavior: 'instant', block: 'center' });
            const r = target.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: target.innerText.trim() };
          }
          return null;
        }).catch(() => null);

        if (redoTarget) {
          if (log) log('info', `Phát hiện màn hình kết quả bài cũ -> Đang nhấn "${redoTarget.text}" để làm lại bài...`);
          await page.mouse.click(redoTarget.x, redoTarget.y);
          redoClicked = true;
          break;
        }
      }
      if (redoScreenState.isFreshQuiz) break;
      await H.sleep(600);
    }

    if (redoClicked) {
      // Chờ popup modal xác nhận xuất hiện ("Bạn có chắc xóa dữ liệu bài này để làm lại?")
      await H.sleep(1200);

      const confirmBox = await page.evaluate(() => {
        // Ưu tiên 1: Nút #btn-confirm-dialog-confirm-v2 / .popup-primary-button chuẩn của OLM (Loại trừ nút Báo lỗi / Hủy)
        const popupBtns = Array.from(document.querySelectorAll('#btn-confirm-dialog-confirm-v2, .popup-primary-button, button.popup-primary-button, .swal2-confirm'));
        const validPopupBtn = popupBtns.find(b => {
          if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
          const norm = (b.innerText || b.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          return !/bao loi|huy|dong|khong|cancel|close/.test(norm);
        });
        if (validPopupBtn) {
          validPopupBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          const r = validPopupBtn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (validPopupBtn.innerText || 'Xác nhận').trim() };
        }

        // Ưu tiên 2: Modal container đang thực sự hiển thị
        const modals = Array.from(document.querySelectorAll(
          '.swal2-container.swal2-shown, .modal.show, .modal.in, .main-modal-v2:not(.tw-hidden), [role="dialog"], .bootbox.modal, div.tw-z-50'
        )).filter(m => m.offsetWidth > 0 && m.offsetHeight > 0);
        for (const modalContainer of modals) {
          const allBtns = Array.from(modalContainer.querySelectorAll('button, a, div[role=button]'));
          const visibleConfirm = allBtns.find(b => {
            if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
            const t = (b.innerText || b.textContent || '').trim();
            const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (/bao loi|huy|dong|khong|cancel|close/.test(norm)) return false;
            return /^(xac nhan|dong y|ok|co|lam lai)$/i.test(norm) ||
              b.classList.contains('swal2-confirm') || b.classList.contains('popup-primary-button') ||
              b.classList.contains('tw-olm-btn-primary-48');
          });
          if (visibleConfirm) {
            visibleConfirm.scrollIntoView({ behavior: 'instant', block: 'center' });
            const r = visibleConfirm.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: visibleConfirm.innerText.trim() };
          }
        }
        return null;
      }).catch(() => null);

      if (confirmBox) {
        if (log) log('info', `Đã xác nhận làm lại bài trên Modal ("${confirmBox.text}")...`);
        const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => null);
        await page.mouse.click(confirmBox.x, confirmBox.y);
        await navPromise;
        await H.sleep(500);
      }

      // Kiểm tra xem OLM có từ chối làm lại bài không (ví dụ: "Bạn không có quyền xóa bài làm này!")
      const redoBlockedReason = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText || '' : '';
        const match = bodyText.match(/Bạn không có quyền xóa bài làm này|không được phép làm lại|hết số lần làm bài|không thể làm lại/i);
        if (match) return match[0];
        const errorToast = document.querySelector('.swal2-html-container, .toast-error, .tw-text-error-default, .alert-danger, [role=alert]');
        if (errorToast && /không có quyền|không thể|thất bại|lỗi/i.test(errorToast.innerText)) {
          return errorToast.innerText.trim();
        }
        return null;
      }).catch(() => null);

      if (redoBlockedReason) {
        throw new Error(`OLM từ chối làm lại: "${redoBlockedReason}"`);
      }

      // Chờ modal đóng và màn hình câu hỏi mới hoặc nút Bắt đầu làm bài (.btn-start-exam) nạp
      await page.waitForFunction(() => {
        const hasQuiz = document.querySelector('type-quiz-x-mobile, type-quiz-x, default-root, #question-container, .question-container');
        const hasStart = document.querySelector('.btn-start-exam, #btn-start-exam, #btn-start, .btn-start-test');
        const hasCheckBtn = Array.from(document.querySelectorAll('button, a.btn, input[type=submit]')).some(b => /kiểm tra đáp án/i.test(b.innerText || b.value || ''));
        const isPracticeActive = !!(document.querySelector('.tw-olm-chip-question, .item-q, .itemx, .card-body'));
        const hasModal = !!document.querySelector('.main-modal-v2:not(.tw-hidden), div[role=dialog]');
        return (hasQuiz || hasStart || hasCheckBtn || isPracticeActive) && !hasModal;
      }, { timeout: 8000 }).catch(() => { });
      await H.sleep(300);
    }


    // Helper: Tìm và nhấn nút "Bắt đầu làm bài" / "Làm bài" / "Vào thi" / "Tiếp tục" trên màn hình sảnh chờ
    async function findAndClickStartButton(maxTries = 4) {
      let startBox = null;
      for (let sTry = 0; sTry < maxTries; sTry++) {
        startBox = await page.evaluate(() => {
          const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
          const startOverlay = document.querySelector('#exam-start-overlay:not(.tw-hidden), #btn-start-exam-overlay');
          if (!isVis(startOverlay)) {
            const navChips = Array.from(document.querySelectorAll('.tw-olm-chip-question'))
              .filter(c => !c.closest('.q-handle, #cate-pdf-container'));
            if (navChips.length > 0 || isVis(document.querySelector('.btn-submit-cate, .btn-next-question'))) {
              return { alreadyInQuiz: true };
            }
          }
          function getAllDeep(sel, root = document, depth = 0) {
      if (depth > 12) return [];
            let results = [];
            try { results.push(...Array.from(root.querySelectorAll(sel))); } catch { }
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let n;
            while ((n = walker.nextNode())) {
              if (n.shadowRoot) {
                try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch { }
              }
            }
            return Array.from(new Set(results));
          }
          const allBtns = getAllDeep('button, a, div[role=button], input[type=button], input[type=submit], span[role=button], [role="button"], .btn');
          // Ưu tiên 1: Nút bấm có class hoặc ID chuẩn của OLM để vào thi
          let startBtn = allBtns.find(b => {
            const r = b.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            return b.id === 'btn-start-exam-overlay' || b.id === 'btn-start-exam' || b.id === 'btn-start' || b.id === 'btn-start-test' ||
              b.classList.contains('btn-start-exam') || b.classList.contains('btn-start-test') ||
              b.classList.contains('btn-start') || b.classList.contains('btn-do-homework');
          });

          // Ưu tiên 2: Tìm theo text chính xác (tránh trùng tên bài học "Luyện tập...")
          // Hỗ trợ toàn bộ 11 dạng học liệu OLM (Đề thi, Luyện tập, Ma trận, PDF/Word, Tự luận, Lý thuyết tương tác, Video có điểm dừng, Mô phỏng, Game hóa, Tài liệu, Liên kết)
          if (!startBtn) {
            startBtn = allBtns.find(b => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const t = (b.innerText || b.textContent || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
              const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
              const isExactStart = /^(?:bat dau lam bai|bat dau thi|bat dau choi|choi ngay|bat dau hoc|bat dau|vao thi|vao lam bai|vao lam|vao hoc|lam bai tu luan|lam bai|tiep tuc lam bai|tiep tuc hoc|lam tiep|thuc hanh|mo mo phong|xem tai lieu|start|play)$/i.test(norm);
              return isExactStart;
            });
          }
          if (!startBtn) return null;
          startBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
          const r = startBtn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (startBtn.innerText || startBtn.value || '').trim() };
        }).catch(() => null);

        if (startBox?.alreadyInQuiz) return false;
        if (startBox) break;
        await H.sleep(450);
      }

      if (startBox && !startBox.alreadyInQuiz) {
        if (log) log('info', `Phát hiện nút "${startBox.text}" -> Đang nhấn bằng chuột thật CDP để vào làm bài...`);
        await page.mouse.click(startBox.x, startBox.y);
        await H.sleep(1500);

        // Bẫy 2: Chống Modal Backdrop Trap - Chỉ tìm nút bấm BÊN TRONG Modal container đang mở (Loại trừ Báo lỗi / Hủy)
        const confirmBox = await page.evaluate(() => {
          const directPopupBtn = document.querySelector('#btn-confirm-dialog-confirm-v2, .popup-primary-button, button.popup-primary-button, .swal2-confirm');
          if (directPopupBtn && (directPopupBtn.offsetWidth > 0 || directPopupBtn.offsetHeight > 0)) {
            const norm = (directPopupBtn.innerText || directPopupBtn.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            if (!/bao loi|huy|dong|khong|cancel|close/.test(norm)) {
              directPopupBtn.scrollIntoView({ behavior: 'instant', block: 'center' });
              const r = directPopupBtn.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (directPopupBtn.innerText || 'Xác nhận').trim() };
            }
          }
          const modals = Array.from(document.querySelectorAll(
            '.swal2-container.swal2-shown, .modal.show, .modal.in, .main-modal-v2:not(.tw-hidden), [role="dialog"], .bootbox.modal, div.tw-z-50'
          )).filter(m => m.offsetWidth > 0 && m.offsetHeight > 0);
          for (const modalContainer of modals) {
            const allBtns = Array.from(modalContainer.querySelectorAll('button, a, div[role=button], input[type=button]'));
            const visibleConfirm = allBtns.find(b => {
              const r = b.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const t = (b.innerText || b.textContent || '').trim();
              const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
              if (/bao loi|huy|dong|khong|cancel|close/.test(norm)) return false;
              return /(?:xac nhan|dong y|ok|co|tiep tuc|bat dau|lam bai|toan man hinh|bat toan man hinh|cho phep|dong y thi)/i.test(norm) ||
                b.classList.contains('swal2-confirm') || b.classList.contains('popup-primary-button') ||
                b.classList.contains('btn-primary') || b.classList.contains('tw-olm-btn-primary-48');
            });
            if (visibleConfirm) {
              visibleConfirm.scrollIntoView({ behavior: 'instant', block: 'center' });
              const r = visibleConfirm.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (visibleConfirm.innerText || '').trim() };
            }
          }
          return null;
        }).catch(() => null);

        if (confirmBox) {
          if (log) log('info', `Đã xác nhận trên Popup ("${confirmBox.text}")...`);
          const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 4000 }).catch(() => null);
          await page.mouse.click(confirmBox.x, confirmBox.y);
          await navPromise;
          await H.sleep(2000);
        }

        // Tự động đóng hướng dẫn / tour guide ("Đã hiểu") nếu xuất hiện sau khi nhấn vào thi
        await page.evaluate(() => {
          const guideBtns = Array.from(document.querySelectorAll('button, a, div[role=button]')).filter(b => {
            const t = (b.innerText || b.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            return /^(da hieu|dong|bo qua|tiep tuc)$/i.test(t) && (b.offsetWidth > 0 || b.offsetHeight > 0);
          });
          if (guideBtns.length > 0) {
            guideBtns[guideBtns.length - 1].click();
          }
        }).catch(() => { });

        // Tự động cấp quyền Fullscreen nếu OLM yêu cầu chống gian lận
        await page.evaluate(() => {
          if (document.documentElement && document.documentElement.requestFullscreen && !document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(() => { });
          }
        }).catch(() => { });

        return true;
      }
      return false;
    }

    // Nhấn nút bắt đầu thi nếu có trên sảnh chờ
    await findAndClickStartButton();

    // Kiểm tra ngay: Nếu bài đã làm xong trước đó, đang đứng ở màn hình Kết quả (ví dụ: 7.14/10, Tổng điểm tối đa 20/28)
    // VÀ giáo viên/OLM KHÔNG cho phép làm lại (không có nút Làm lại bài, không có nút Bắt đầu, không có câu hỏi nào trên trang)
    // -> Dừng ngay lập tức, tuyệt đối không lấy danh sách câu hỏi ngầm từ API ra quét ảo!
    if (!redoClicked) {
      const lockedResultCheck = await page.evaluate(() => {
        if (window.VIDEO_UI_V2) return { isLockedResult: false };
        function getAllDeep(sel, root = document, depth = 0) {
      if (depth > 12) return [];
          let results = [];
          try { results.push(...Array.from(root.querySelectorAll(sel))); } catch {}
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let n;
          while ((n = walker.nextNode())) {
            if (n.shadowRoot) {
              try { results.push(...getAllDeep(sel, n.shadowRoot, depth + 1)); } catch {}
            }
          }
          return Array.from(new Set(results));
        }
        const bodyText = document.body ? document.body.innerText || '' : '';
        const hasScoreSummary =
          /(?:tổng điểm tối đa|kết quả luyện tập|kết quả bài làm|chúc mừng bạn đã hoàn thành|tốt lắm|cứ chăm chỉ|bứt phá ngay thôi|đừng nản lòng|hãy giữ vững phong độ)/i.test(bodyText) &&
          /(?:đúng\s*\d+\/\d+\s*câu|\b\d+(?:[.,]\d+)?\s*\/\s*10\b)/i.test(bodyText);
        if (!hasScoreSummary) return { isLockedResult: false };

        const quizNodes = getAllDeep('.qselect, [data-tf-value], type-quiz-x-mobile, type-quiz-x, type-mix, type-true-false-mobile, type-fill-me-mobile, .itemx.question, .tw-olm-chip-question')
          .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0);
        if (quizNodes.length > 0) return { isLockedResult: false };

        const allBtns = getAllDeep('button, a, div[role=button], .btn').filter(b => b.offsetWidth > 0 || b.offsetHeight > 0);
        const hasRedoOrStart = allBtns.some(b => {
          const norm = (b.innerText || b.textContent || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
          return /^(lam lai bai|luyen tap lai|lam lai|lam lai de|bat dau lam bai|bat dau thi|vao thi|lam tiep|tiep tuc lam bai)$/i.test(norm);
        });
        if (hasRedoOrStart) return { isLockedResult: false };

        const scoreMatch = bodyText.match(/\b(\d+(?:[.,]\d+)?)\s*\/\s*10\b/);
        return {
          isLockedResult: true,
          score: scoreMatch ? scoreMatch[1].replace(',', '.') : null,
        };
      }).catch(() => ({ isLockedResult: false }));

      if (lockedResultCheck?.isLockedResult && await submissionConfirmed(page, { signal })) {
        const finalScore = lockedResultCheck.score || (homework.score != null ? String(homework.score) : 'đã chấm');
        if (log) {
          log('warn', `🔒 Bài "${homework.title}" không cho xem hoặc không cho làm lại (Điểm: ${finalScore}/10, không có nút làm bài hoặc luyện tập lại). Hệ thống tự động bỏ qua!`);
        }
        return {
          engine: 'browser',
          phase: 'done',
          lockedRedo: true,
          canRetry: false,
          scanned: 0,
          solved: 0,
          filled: 0,
          failed: 0,
          submitted: true,
          alreadyCompleted: true,
          score: lockedResultCheck.score || (homework.score != null ? String(homework.score) : null),
        };
      }
    }

    // Tự động đóng modal hướng dẫn "Đã hiểu" nếu có
    await page.evaluate(() => {
      const guideBtn = Array.from(document.querySelectorAll('button, a, div[role=button]')).find(b =>
        /^(đã hiểu|da hieu|đóng|dong)$/i.test((b.innerText || b.textContent || '').trim()) &&
        (b.offsetWidth > 0 || b.offsetHeight > 0)
      );
      if (guideBtn) {
        guideBtn.click();
      }
    });
    await H.sleep(500);

    // 3. Phân loại bài theo DOM (KHÔNG theo URL: /chu-de/ có thể là list
    //    hoặc tuần tự, tùy từng bài).
    let surface = null;
    let mode = { mode: 'unknown', reason: 'chưa đọc được trạng thái trang' };
    for (let attempt = 0; attempt < 15; attempt++) {
      // Kiểm tra xem có phải dạng bài thi kiểm tra tuần tự (exam mode)
      // Lưu ý: Không nhận diện nhầm bài luyện tập dạng chips (.tw-olm-chip-question + #btn-done "Kiểm tra đáp án")
      // vốn có nút cuộn thanh chip chứa arrow-right.svg
      const isExam = await page.evaluate(() => {
        const hasChips = document.querySelectorAll('.tw-olm-chip-question').length > 0;
        const hasCheckBtn = !!document.querySelector('#btn-done');
        if (hasChips && hasCheckBtn) return false;
        const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
        if (
          isVis(document.querySelector('.btn-submit-cate, #btn-submit-cate')) ||
          isVis(document.querySelector('.btn-next-question')) ||
          isVis(document.querySelector('.btn-list-contest-sections')) ||
          (window.data_exam && window.data_exam.list_id_quiz) ||
          document.querySelector('#dialogConfirm, [id^="user-test-"], .quizx.question-hold')
        ) {
          return true;
        }
        const allBtns = Array.from(document.querySelectorAll('button, a, div[role=button]'));
        return allBtns.some(b =>
          b.getAttribute('aria-label') === 'Kết thúc bài thi' ||
          /kết thúc bài thi/i.test(b.innerText || b.getAttribute('title') || '') ||
          b.innerHTML.includes('sticky-note-text-square-orange.svg')
        );
      });

      if (attempt === 0 && (!directAnswersList.length || pendingResponses.size > 0)) {
        await waitForAnswers();
      }
      if (isExam && directAnswersList.length > 0) {
        mode = { mode: 'exam', reason: `Bài thi tuần tự nộp bài ở cuối, ${directAnswersList.length} câu` };
        break;
      }

      surface = await inspectQuestionSurface(page);
      mode = classifyMode(surface);
      if (mode.mode !== 'unknown') {
        if (!directAnswersList.length || pendingResponses.size > 0) await waitForAnswers();
        break;
      }

      const specialCheck = await page.evaluate(() => {
        if (window.VIDEO_UI_V2?.values || document.querySelector('[data-timeline-marker], .video-checkpoint')) {
          return { isSpecial: true, reason: 'Video tương tác V2 (có điểm dừng câu hỏi)' };
        }
        const isMedia = !!document.querySelector('video, iframe[src*="youtube"], iframe[src*="video"], .jwplayer, .video-js, #player-video, iframe[src*="drive.google"], iframe[src*="docs.google"], iframe[src*="officeapps"], iframe[src*="phet"], .simulation-container, .game-container');
        const hasQuizUi = !!document.querySelector('.itemx.q-view-itemx.question, .tw-olm-chip-question, .qselect, type-quiz-x-mobile, type-quiz-x, .quizx.question-hold');
        if (isMedia && !hasQuizUi) {
          return { isSpecial: true, reason: 'Học liệu Video / Tài liệu / Mô phỏng' };
        }
        return null;
      }).catch(() => null);
      if (specialCheck?.isSpecial) {
        mode = { mode: 'special_material', reason: specialCheck.reason };
        break;
      }

      // Nếu không nhận diện được: Kiểm tra xem sảnh chờ có nút Bắt đầu / Làm bài chưa được bấm không
      const clickedStart = await findAndClickStartButton(1);
      if (clickedStart) {
        await H.sleep(1000);
        continue;
      }

      await H.sleep(400);
    }

    // Fallback thông minh qua Adaptive AI DevTools: Nếu sau 15 lần vẫn unknown, nhờ AI quét toàn bộ DevTools để xử lý
    if (mode.mode === 'unknown') {
      try {
        const adaptive = require('./adaptive-solver');
        const aiLife = await adaptive.resolvePageLifecycleWithAI(page, { stage: 'start_or_redo', log, signal });
        if (aiLife.status === 'locked_result' && await submissionConfirmed(page, { signal })) {
          const finalScore = await readScoreFromPage(page);
          if (log) {
            log('warn', `🔒 Bài "${homework.title}" đã có kết quả trên OLM (Điểm: ${finalScore ?? 'chưa đọc được'}).`);
          }
          return {
            engine: 'browser',
            phase: 'done',
            lockedRedo: true,
            canRetry: false,
            scanned: 0,
            solved: 0,
            filled: 0,
            failed: 0,
            submitted: true,
            alreadyCompleted: true,
            score: finalScore,
          };
        }
        if (aiLife.status === 'clicked_redo' || aiLife.status === 'clicked_start') {
          await H.sleep(2000);
          surface = await inspectQuestionSurface(page);
          mode = classifyMode(surface);
        }
      } catch (e) {
        if (log) log('warn', `🧠 [Adaptive Lifecycle] Lỗi: ${e.message}`);
      }
    }

    // Fallback thông minh: Nếu sau khi AI kiểm tra mà vẫn unknown nhưng API OLM đã giải mã thành công câu hỏi
    if (!directAnswersList.length || pendingResponses.size) await waitForAnswers();
    if (mode.mode === 'unknown' && directAnswersList.length > 0) {
      const fallbackCheck = await page.evaluate(() => {
        const chips = Array.from(document.querySelectorAll('.tw-olm-chip-question, .q-nav-item, [data-question-nav], .chip-question, .box-number-question .item, .palette-item'))
          .filter((el) => !el.closest('.q-handle, #cate-pdf-container')).length;
        const hasQ = !!document.querySelector('.question-content, .box-content, .card-body, .previewquiz, type-quiz-x, type-quiz-multi, .itemx');
        return { chips, hasQ };
      }).catch(() => ({ chips: 0, hasQ: false }));

      if (fallbackCheck.chips > 0) {
        mode = { mode: 'chips', reason: `Phát hiện ${fallbackCheck.chips} chip câu hỏi (fallback từ ${directAnswersList.length} câu API)` };
      } else {
        mode = { mode: 'exam', reason: `Fallback bài thi tuần tự / đề ma trận (${directAnswersList.length} câu API)` };
      }
    }

    if (log) log('info', `🔎 Nhận diện dạng bài: ${mode.mode} (${mode.reason})`);

    // Dạng OMR PDF/Word Exam (#cate-pdf-container + .q-handle-fc / .q-handle-tf / .q-handle-dg / .q-handle-nrq)
    if (mode.mode === 'omr-pdf') {
      return await solveOmrPdfExam(page, { homework, config, log, emit, signal });
    }

    // Dạng 2 & 3: Đề thi / Đề ma trận dạng bài thi tuần tự
    if (mode.mode === 'exam') {
      return await solveExamQuestions(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    // Dạng 1: Luyện tập / Đề thi dạng chip câu hỏi
    if (mode.mode === 'chips') {
      if (log) log('info', `Phát hiện bài thi trắc nghiệm (${surface.chipCount} câu) -> Bắt đầu nạp nhanh, giải AI theo nhóm và nộp bài tổng thể...`);
      return await solveModernQuiz(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    if (mode.mode === 'list') {
      return await solveListQuestions(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    if (mode.mode === 'sequential') {
      if (log) log('info', 'Phát hiện bài nộp từng câu (mỗi câu phải nộp riêng mới mở câu tiếp theo)...');
      return await solveSequentialQuestions(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    if (mode.mode === 'flow') {
      if (log) log('info', 'Bài tập luyện tập tương tác sinh câu hỏi động -> Giải theo luồng Flow Practice...');
      return await solveFlowPractice(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    if (mode.mode === 'legacy') {
      // Giao diện Shadow DOM cũ: giữ nguyên đường cũ.
      if (log) log('info', 'Phát hiện giao diện OLM cũ -> Giải theo luồng Flow Practice...');
      return await solveFlowPractice(page, { homework, config, log, emit, signal, directAnswersList, directAnswersMap });
    }

    // Dạng 4: [Lý thuyết tương tác] / [Video Youtube có điểm dừng] / [Tài liệu] / [Mô phỏng, thí nghiệm ảo] / [Liên kết] / [Game hóa] / [Đề thi Tự luận độc lập]
    const specialMaterial = await page.evaluate(() => {
      const isVideo = !!(window.VIDEO_UI_V2?.values || document.querySelector('[data-timeline-marker], video, iframe[src*="youtube"], iframe[src*="video"], .jwplayer, .video-js, #player-video, .video-checkpoint'));
      const hasOmrQuestions = document.querySelectorAll('.q-handle, .q-handle-fc, .q-handle-tf, .q-handle-dg, .q-handle-nrq').length > 0;
      const isDocViewer = !hasOmrQuestions && !!document.querySelector('#iframe_content, iframe[src*="drive.google"], iframe[src*="docs.google"], iframe[src*="officeapps"], embed[type="application/pdf"], canvas.pdf-canvas, .pdf-viewer');
      const isSimulationOrGame = !hasOmrQuestions && !!document.querySelector('iframe[src*="phet"], iframe[src*="simulation"], iframe[src*="game"], .simulation-container, .game-container, #game-canvas, canvas.game');
      const isExternalLink = !hasOmrQuestions && !!document.querySelector('.link-resource, a.btn-open-link, iframe.external-link');
      const essayEditor = !hasOmrQuestions && document.querySelector('.ck-editor__editable, .ql-editor, #essay-content, textarea.essay-input, .box-essay textarea, [contenteditable="true"].OlmEditorTheme__root');
      const allBtns = Array.from(document.querySelectorAll('button, a, div[role=button], input[type=submit]'));
      const doneBtn = allBtns.find(b => {
        if (b.offsetWidth <= 0 && b.offsetHeight <= 0) return false;
        const t = (b.innerText || b.textContent || b.value || '').trim();
        const norm = t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
        return /^(da hoc xong|hoan thanh bai hoc|hoan thanh|da hieu|xac nhan da hoc|da xem xong|nop bai tu luan|luu bai lam|nop bai)$/i.test(norm) ||
          b.classList.contains('btn-finish-lesson') || b.id === 'btn-finish-lesson';
      });
      if (essayEditor) {
        const stemEl = document.querySelector('.question-content, .essay-question, .box-question, .card-body') || document.body;
        return {
          isTheory: true,
          isEssayExam: true,
          essayPrompt: (stemEl.innerText || '').trim().slice(0, 2000),
          btnBox: doneBtn ? (() => { const r = doneBtn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: (doneBtn.innerText || 'Nộp bài').trim() }; })() : null,
        };
      }
      if (doneBtn) {
        const r = doneBtn.getBoundingClientRect();
        return { isTheory: true, isVideo, isDocViewer, isSimulationOrGame, isExternalLink, btnBox: { x: r.x + r.width / 2, y: r.y + r.height / 2, text: doneBtn.innerText.trim() } };
      }
      return (isVideo || isDocViewer || isSimulationOrGame || isExternalLink)
        ? { isTheory: true, isVideo, isDocViewer, isSimulationOrGame, isExternalLink, btnBox: null }
        : null;
    });

    if (specialMaterial && (specialMaterial.isTheory || homework.categoryType === 'theory')) {
      if (specialMaterial.isEssayExam) {
        if (log) log('info', '🔎 Nhận diện dạng bài: [Đề thi Tự luận] -> Đang giải tự luận bằng AI và nộp bài...');
        let essayAnswer = directAnswersList[0]?.answer || directAnswersList[0]?.correctText || '';
        if (!essayAnswer && specialMaterial.essayPrompt) {
          const { solveQuestion } = require('./answer-engine');
          const answer = await solveQuestion({
            type: 'essay', text: specialMaterial.essayPrompt, options: [], subject: homework.subject || '',
          }, { signal });
          essayAnswer = !answer.unresolved && typeof answer.answer === 'string' ? answer.answer.trim() : '';
        }
        if (!essayAnswer) throw new Error('Chưa giải được đề tự luận.');
        signal?.throwIfAborted();
        const lexFilled = await fillLexicalParagraph(page, essayAnswer).then(() => true).catch(() => false);
        await page.evaluate((ansText, skipLexical) => {
          const ed = document.querySelector('.ck-editor__editable, .ql-editor, [contenteditable="true"]');
          if (ed) {
            const isLexical = ed.getAttribute('data-lexical-editor') === 'true' || ed.classList.contains('ContentEditable__root') || Boolean(ed.closest('type-paragraph, type-paragraph-mobile'));
            if (!(skipLexical && isLexical && (ed.innerText || ed.textContent || '').trim().length > 0)) {
              ed.focus();
              ed.textContent = ansText;
              ed.dispatchEvent(new Event('input', { bubbles: true }));
              ed.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          if (!skipLexical) {
            const ta = document.querySelector('#essay-content, textarea.essay-input, .box-essay textarea, textarea');
            if (ta) {
              ta.value = ansText;
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              ta.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        }, essayAnswer, lexFilled).catch(() => { });
        await H.sleep(1000);
        const { ok: confirmed } = await submitFinalExam(page, { log, signal });
        return {
          engine: 'browser',
          phase: confirmed ? 'done' : 'filled',
          scanned: 1,
          solved: 1,
          filled: 1,
          submitted: confirmed,
          score: confirmed ? await readScoreFromPage(page) : null,
        };
      }

      if (log) log('info', '🔎 Nhận diện dạng bài: [Lý thuyết tương tác / Video có điểm dừng / Tài liệu / Mô phỏng / Game hóa] -> Đang hoàn thành học liệu...');
      if (specialMaterial.isVideo) {
        // Kiểm tra giao diện Video V2 mới của OLM (window.VIDEO_UI_V2 / data-timeline-marker)
        const v2Meta = await page.evaluate(() => {
          const v = window.VIDEO_UI_V2?.values;
          if (!v) return null;
          const rec = v.record || {};
          const markers = Array.isArray(v.list_marker) ? v.list_marker : [];
          const totalq = markers.reduce((sum, m) => sum + (Array.isArray(m.l) ? m.l.length : 1), 0);
          return {
            hasV2: true,
            markers,
            totalq,
            totalTime: Number(rec.total_time || 600),
            ended: Number(rec.ended || 0),
            score10: Number(rec.score_10 || 0),
            correct: Number(rec.correct || 0),
            dataLog: Array.isArray(v.data_log) ? v.data_log : [],
            idRecord: window.baseCategoryUtils?.values?.id_record || rec._id || null,
          };
        }).catch(() => null);

        if (v2Meta && v2Meta.hasV2) {
          const targetNum = Number(config.scoreTarget || 10);
          if (log) log('info', `🎬 [Video V2] Phát hiện video tương tác (${v2Meta.totalq} điểm dừng câu hỏi, thời lượng ${v2Meta.totalTime}s, điểm hiện tại: ${v2Meta.score10}/10)`);

          const allLoggedCorrect = v2Meta.dataLog.length >= v2Meta.totalq &&
            v2Meta.dataLog.every((entry) => Array.isArray(entry?.result) && entry.result.length > 0 && entry.result.every((r) => Number(r) === 1));

          // Nếu chưa giải đủ câu hỏi điểm dừng (hoặc có câu sai / yêu cầu làm lại), xóa record cũ để mở lại toàn bộ điểm dừng và giải từng câu
          if (v2Meta.totalq > 0 && (!allLoggedCorrect || config.redo || config.forceRedo || v2Meta.score10 < targetNum)) {
            if (v2Meta.idRecord) {
              await page.evaluate(async (idRec) => {
                const bcu = window.baseCategoryUtils;
                if (bcu && typeof window._apiDelete === 'function') {
                  try {
                    await window._apiDelete('/course/teacher-static/' + idRec, {
                      id_cate: bcu.values.id_category,
                      id_user: bcu.values.id_page_user,
                    });
                    bcu.clearCategoryStorageData?.();
                  } catch { }
                }
              }, v2Meta.idRecord).catch(() => { });
              await page.goto(homeworkUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => { });
              await H.sleep(2000);
            }

            const ansMapObj = {};
            for (const d of directAnswersList) {
              if (d && d.id != null) ansMapObj[String(d.id)] = d;
            }

            for (let mIdx = 0; mIdx < v2Meta.markers.length; mIdx++) {
              signal?.throwIfAborted();
              const mk = v2Meta.markers[mIdx];
              const qId = String(Array.isArray(mk.l) ? mk.l[0] : (mk.l || ''));
              if (log) log('info', `⏱️ [Video V2] Điểm dừng ${mIdx + 1}/${v2Meta.markers.length} (${mk.t}s - ID câu: ${qId})`);

              await page.evaluate((idx, t) => {
                const m = document.querySelector('[data-timeline-marker]');
                const fk = m && Object.keys(m).find((k) => k.startsWith('__reactFiber$'));
                let cur = m?.[fk];
                while (cur) {
                  if (cur.memoizedProps?.onCurrentTimeChange) cur.memoizedProps.onCurrentTimeChange(t);
                  if (cur.memoizedProps?.onStopPointReached) {
                    cur.memoizedProps.onStopPointReached(idx, cur.memoizedProps.markers?.[idx]);
                    return true;
                  }
                  cur = cur.return;
                }
                return false;
              }, mIdx, mk.t).catch(() => false);
              await H.sleep(1200);

              // Giải câu hỏi tại điểm dừng (type-sort-list-mobile, type-drag-text-mobile, type-quiz-x-mobile, ...)
              const checkpointFill = await page.evaluate(async (ansMap, targetQId) => {
                const wait = (ms) => new Promise((r) => setTimeout(r, ms));
                const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                let comp = null;
                const walk = (root, d = 0) => {
                  if (!root || d > 10 || comp) return;
                  for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
                    const tag = (el.tagName || '').toLowerCase();
                    if (tag.startsWith('type-')) { comp = el; return; }
                    if (el.shadowRoot) walk(el.shadowRoot, d + 1);
                  }
                };
                walk(document);
                if (!comp) return { ok: false, reason: 'no-comp' };
                const tag = comp.tagName.toLowerCase();
                const sr = comp.shadowRoot || comp.renderRoot || comp;

                if (tag.includes('sort-list')) {
                  for (let pass = 0; pass < 35; pass++) {
                    const items = Array.from(sr.querySelectorAll('li.sortable-item[name]'));
                    if (!items.length) return { ok: false, reason: 'no-sort-items' };
                    const names = items.map((li) => Number(li.getAttribute('name')));
                    let moved = false;
                    for (let i = 1; i < items.length; i++) {
                      if (names[i] < names[i - 1]) {
                        const upBtn = items[i].querySelector('.up, span.up, img[alt="up"]');
                        if (upBtn) {
                          upBtn.click();
                          moved = true;
                          await wait(110);
                          break;
                        }
                      }
                    }
                    if (!moved) break;
                  }
                  return { ok: true, tag };
                }

                if (tag.includes('drag-text') && comp.answerCorrect && typeof comp.answerCorrect === 'object') {
                  const answerCorrect = comp.answerCorrect;
                  const blanks = Array.from(sr.querySelectorAll('.olm-input-text, .box-fill, .drag-blank, [class*="input-text"], [ind]'))
                    .filter((el) => !el.classList.contains('select-option-item') && !el.classList.contains('box-select-option-content'));
                  const keys = Object.keys(answerCorrect).sort((a, b) => Number(a) - Number(b));
                  let filled = 0;
                  for (const k of keys) {
                    const targetId = String(answerCorrect[k]);
                    const blank = blanks[Number(k)];
                    if (blank) {
                      blank.click();
                      await wait(150);
                    }
                    const opt = sr.querySelector(`.drag-select[data-id="${targetId}"], .select-option-item[data-id="${targetId}"]`);
                    if (opt) {
                      opt.click();
                      filled++;
                      await wait(150);
                    }
                  }
                  return { ok: filled === keys.length, tag, filled };
                }

                if (tag.includes('quiz-x') || tag.includes('quiz-multi')) {
                  const decoded = ansMap[targetQId] || Object.values(ansMap).find((a) => {
                    const txt = norm(sr.innerText || '');
                    return a.correctTexts?.length && a.correctTexts.every((ct) => txt.includes(norm(ct).slice(0, 35)));
                  });
                  if (!decoded) return { ok: false, tag, reason: 'no-decoded' };
                  const qselects = Array.from(sr.querySelectorAll('.qselect, [ind], li[data-ind]'));
                  const wantTexts = (decoded.correctTexts || []).map(norm);
                  const wantInds = new Set((decoded.correctIndices || []).map(Number));
                  let clicked = 0;
                  for (const el of qselects) {
                    const elText = norm(el.innerText || '').replace(/^[a-f][.)]\s*/i, '');
                    const indAttr = el.getAttribute('ind') ?? el.getAttribute('data-ind');
                    const byText = wantTexts.some((wt) => wt && (elText === wt || elText.includes(wt) || wt.includes(elText)));
                    const byInd = !wantTexts.length && indAttr != null && wantInds.has(Number(indAttr));
                    if (byText || byInd) {
                      el.click();
                      clicked++;
                      await wait(110);
                    }
                  }
                  return { ok: clicked > 0, tag, clicked };
                }
                return { ok: false, tag, reason: 'fallback' };
              }, ansMapObj, qId).catch(() => ({ ok: false }));

              if (!checkpointFill.ok) {
                const matched = directAnswersMap.get(qId) || directAnswersList[mIdx] || null;
                await inspectAndFillAnyQuestion(page, matched, { index: 0 }, log).catch(() => { });
              }

              await H.sleep(400);
              await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetWidth > 0);
                const checkBtn = btns.find((x) => /kiểm tra đáp án|trả lời|nộp bài/i.test((x.innerText || '').trim()));
                if (checkBtn) checkBtn.click();
              }).catch(() => { });
              await H.sleep(1400);

              await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button')).filter((b) => b.offsetWidth > 0);
                const contBtn = btns.find((x) => /tiếp tục xem|tiếp tục|xem tiếp|đóng/i.test((x.innerText || '').trim()));
                if (contBtn) contBtn.click();
              }).catch(() => { });
              await H.sleep(800);
            }

            // Tải lại trang để đồng bộ data_log và id_record mới nhất từ server trước khi chốt 100% thời lượng
            await page.goto(homeworkUrl, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => { });
            await H.sleep(1800);
          }

          // Chốt tiến độ xem 100% thời lượng + toàn bộ data_log câu hỏi đúng qua createTeacherStatic
          const v2Submit = await page.evaluate(async (targetScore10) => {
            const bcu = window.baseCategoryUtils;
            const v = window.VIDEO_UI_V2?.values || {};
            const rec = v.record || {};
            const markers = Array.isArray(v.list_marker) ? v.list_marker : [];
            const totalq = markers.reduce((sum, m) => sum + (Array.isArray(m.l) ? m.l.length : 1), 0);
            const totalTime = Number(rec.total_time || 600);
            // Lấy data_log mới nhất từ Zustand store hoặc VIDEO_UI_V2.values
            let dataLog = Array.isArray(v.data_log) ? v.data_log : [];
            if (totalq > 0 && dataLog.length === 0 && Number(rec.ended || 0) !== 1) {
              return { ok: false, reason: 'empty-data-log', totalq };
            }
            const idRecord = bcu?.values?.id_record || rec._id;

            // Nếu đã có record trên server, xóa trước để tránh lỗi 403 "Bài làm đã được nộp trước đó"
            if (idRecord && typeof window._apiDelete === 'function') {
              try {
                await window._apiDelete('/course/teacher-static/' + idRecord, {
                  id_cate: bcu.values.id_category,
                  id_user: bcu.values.id_page_user,
                });
                bcu.clearCategoryStorageData?.();
              } catch { }
            }

            const ratio = Math.max(0, Math.min(1, Number(targetScore10 || 10) / 10));
            const targetPercent = Math.round(ratio * 100);
            const targetTimeSpent = Math.round(totalTime * ratio);

            const payload = {
              score: targetPercent,
              data_log: JSON.stringify(dataLog),
              total_time: totalTime,
              current_time: totalTime,
              correct: totalq,
              totalq,
              count_problems: totalq,
              time_spent: targetTimeSpent,
              date_end: Math.floor(Date.now() / 1000),
              ended: 1,
              save_star: 1,
            };
            const out = await bcu?.createTeacherStatic?.(payload);
            return out ? {
              ok: true,
              score: out.score,
              score_10: out.score_10,
              correct: out.correct,
              totalq,
            } : { ok: false };
          }, targetNum).catch(() => ({ ok: false }));

          if (v2Submit && v2Submit.ok) {
            if (log) log('success', `✔ [Video V2] Đã hoàn thành bài giảng video "${homework.title}" — Đúng: ${v2Submit.correct}/${v2Submit.totalq} câu | Điểm: ${v2Submit.score_10}/10`);
            return {
              engine: 'browser',
              phase: 'done',
              scanned: v2Meta.totalq || 1,
              solved: v2Submit.correct ?? (v2Meta.totalq || 1),
              filled: v2Submit.correct ?? (v2Meta.totalq || 1),
              submitted: true,
              score: v2Submit.score_10 != null ? String(v2Submit.score_10) : '10',
            };
          }
          if (v2Submit && v2Submit.reason === 'empty-data-log') {
            if (log) log('warn', `⚠ [Video V2] Chưa ghi nhận được data_log cho ${v2Meta.totalq} điểm dừng câu hỏi — không thể xác nhận hoàn thành.`);
            return {
              engine: 'browser',
              phase: 'incomplete',
              scanned: v2Meta.totalq || 1,
              solved: 0,
              filled: 0,
              submitted: false,
              error: 'Video V2 chưa ghi nhận được đáp án các điểm dừng (data_log trống).',
            };
          }
        }

        // Hỗ trợ Video Youtube có điểm dừng (checkpoints cũ) và HTML5 video
        for (let vStep = 0; vStep < 8; vStep++) {
          await page.evaluate(() => {
            const v = document.querySelector('video');
            if (v) {
              v.muted = true;
              v.play().catch(() => { });
              if (Number.isFinite(v.duration) && v.duration > 1) {
                v.currentTime = Math.max(0, v.duration - 0.5);
              }
            }
            try {
              if (window.player && typeof window.player.getDuration === 'function' && typeof window.player.seekTo === 'function') {
                const dur = window.player.getDuration();
                if (dur > 1) window.player.seekTo(Math.max(0, dur - 1), true);
              }
            } catch { }
          }).catch(() => { });
          await H.sleep(1200);

          // Nếu tại điểm dừng xuất hiện câu hỏi tương tác, tự động điền và bấm Kiểm tra / Tiếp tục
          if (directAnswersList.length > 0) {
            const qScan = await scanCurrentQuestion(page, vStep, homework.subject, log).catch(() => null);
            if (qScan && (qScan.text || (qScan.options && qScan.options.length > 0))) {
              const matched = matchDirectAnswer(qScan, directAnswersList, directAnswersMap, vStep);
              if (matched) {
                await inspectAndFillAnyQuestion(page, matched, qScan, log).catch(() => { });
              }
            }
          }
          const clickedContinue = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, a.btn, div[role=button]')).filter(b => b.offsetWidth > 0 || b.offsetHeight > 0);
            const btn = btns.find(b => /kiểm tra|trả lời|tiếp tục xem|tiếp tục|bỏ qua|hoàn thành/i.test((b.innerText || '').trim()));
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          }).catch(() => false);
          if (!clickedContinue) break;
          await H.sleep(1000);
        }
      }
      // Lưu trạng thái hoàn thành học liệu qua API nội bộ baseCategoryUtils của OLM
      signal?.throwIfAborted();
      const saved = await saveMaterialResult(page);

      if (!saved && specialMaterial.btnBox) {
        await H.sleep(1500);
        signal?.throwIfAborted();
        await page.mouse.click(specialMaterial.btnBox.x, specialMaterial.btnBox.y);
      }
      const confirmed = saved || await submissionConfirmed(page, { timeout: 6000, signal });
      if (confirmed && log) log('success', '✔ Đã hoàn thành học liệu: ' + homework.title);
      return {
        engine: 'browser',
        phase: 'done',
        scanned: 1,
        solved: 1,
        filled: 1,
        submitted: confirmed,
        score: confirmed ? await readScoreFromPage(page) : null,
      };
    }

    // Dạng 6: [Đề PDF / Phiếu tô đáp án]
    const isPdfOmr = await page.evaluate(() => {
      const hasPdf = !!document.querySelector('canvas.pdf-canvas, .pdf-viewer, #viewerContainer, embed[type="application/pdf"], iframe[src*="pdf"]');
      const hasOmr = !!document.querySelector('.omr-sheet, .sheet-answer, .answer-sheet, .list-answer-circle, #omr-container, .box-omr');
      return hasPdf || hasOmr;
    });

    if (isPdfOmr && directAnswersList.length > 0) {
      if (log) log('info', `🔎 Nhận diện dạng bài: [Đề PDF / Phiếu tô đáp án] (${directAnswersList.length} câu) -> Bắt đầu tô đáp án OMR...`);
      let filled = 0;
      for (let qIdx = 0; qIdx < directAnswersList.length; qIdx++) {
        signal?.throwIfAborted();
        const qNum = qIdx + 1;
        const optionIndex = directAnswersList[qIdx]?.correctIndex;
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) continue;
        const ansLetter = 'ABCD'[optionIndex];
        const applied = await page.evaluate((num, letter) => {
          const rows = Array.from(document.querySelectorAll('.omr-sheet .item, .sheet-answer .row, .item-answer, tr, .question-omr'));
          const row = rows.find(r => {
            const t = r.innerText || '';
            return new RegExp(`(?:^|\\D)${num}(?:\\D|$)`).test(t);
          });
          if (row) {
            const bubbles = Array.from(row.querySelectorAll('button, label, span, .circle-answer, input[type="radio"]'));
            const targetBubble = bubbles.find(b => (b.innerText || b.value || b.getAttribute('data-val') || '').trim().toUpperCase() === letter);
            if (targetBubble) {
              targetBubble.click();
              return true;
            }
          }
          return false;
        }, qNum, ansLetter).catch(() => false);
        if (applied) filled++;
        await H.sleep(150);
      }
      signal?.throwIfAborted();
      const { ok: confirmed } = await submitFinalExam(page, { log, signal });
      return {
        engine: 'browser',
        phase: confirmed ? 'done' : 'filled',
        scanned: directAnswersList.length,
        solved: filled,
        filled,
        failed: directAnswersList.length - filled,
        submitted: confirmed,
      };
    }

    // Không nhận diện được dạng bài -> Adaptive mode: lặp quét DevTools + AI thao tác từng câu
    {
      const adaptive = require('./adaptive-solver');
      if (log) log('info', `🧭 [Adaptive] Dạng bài chưa có handler riêng (${mode.reason}) -> chuyển sang chế độ tự ứng biến...`);
      let solvedCount = 0;
      for (let step = 0; step < 60; step++) {
        if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
        const snap = await adaptive.observe(page, { withScreenshot: false });
        const qKey = String(snap.questionText || '').slice(0, 160);
        const known = matchDirectAnswer({ text: snap.questionText, options: [] }, directAnswersList, directAnswersMap, step);
        const r = await adaptive.solveAdaptively(page, { knownAnswer: known, log });
        if (r.ok) solvedCount++;
        // Chuyển câu: thử nút kiểm tra/tiếp theo; nếu nội dung không đổi -> dừng
        await page.evaluate(() => {
          const vis = (b) => b && (b.offsetWidth > 0 || b.offsetHeight > 0) && !b.disabled;
          const btns = Array.from(document.querySelectorAll('button, a.btn, div[role=button]')).filter(vis);
          const b = btns.find((x) => /kiểm tra|trả lời/i.test(x.innerText || '')) ||
            btns.find((x) => /^(tiếp|tiếp theo|câu tiếp|tiếp tục)$/i.test((x.innerText || '').trim()));
          if (b) b.click();
        }).catch(() => { });
        await H.sleep(1200);
        await page.evaluate(() => {
          const b = Array.from(document.querySelectorAll('button, a.btn')).find((x) => (x.offsetWidth > 0) && /^(tiếp|tiếp theo|câu tiếp|tiếp tục)$/i.test((x.innerText || '').trim()));
          if (b) b.click();
        }).catch(() => { });
        await H.sleep(1000);
        const next = await adaptive.observe(page, { withScreenshot: false });
        if (String(next.questionText || '').slice(0, 160) === qKey) break;
      }
      if (solvedCount > 0) {
        const { ok: confirmed } = await submitFinalExam(page, { log, signal });
        const score = confirmed ? await readScoreFromPage(page).catch(() => null) : null;
        return { engine: 'browser', mode: 'adaptive', phase: 'done', scanned: solvedCount, solved: solvedCount, filled: solvedCount, submitted: confirmed, score };
      }
    }

    // Không nhận diện được nút bấm làm bài / luyện tập lại và không có câu hỏi -> Log bài không cho xem hoặc không cho làm lại
    if (log) {
      log('warn', `🔒 Bài "${homework.title}" không cho xem hoặc không cho làm lại (AI không quét được nút bấm làm bài hoặc luyện tập lại trên trang).`);
    }
    return {
      engine: 'browser',
      phase: 'done',
      lockedRedo: true,
      canRetry: false,
      scanned: 0,
      solved: 0,
      filled: 0,
      failed: 0,
      submitted: false,
      score: homework.score != null ? String(homework.score) : null,
    };
  } finally {
    await context.close().catch(() => null);
  }
}

module.exports = {
  isAvailable,
  launch,
  login,
  solveHomework,
  solveFlowPractice,
  solveListQuestions,
  solveSequentialQuestions,
  solveModernQuiz,
  solveExamQuestions,
  solveOmrPdfExam,
  submitFinalExam,
  fillBlanks,
  fillMathQuill,
  fillLexicalParagraph,
  dragAndDropOLM,
  scanCurrentQuestion,
  fillCurrentQuestion,
  inspectAndFillAnyQuestion,
  inspectQuestionSurface,
  classifyMode,
  matchDirectAnswer,
  extractLiveDomAnswer,
};
