'use strict';

// Browser automation engine. Uses real DOM interaction (click / type with
// delays) rather than raw API calls, so the request pattern looks like a
// person working through the page.
//
// Puppeteer is an optional dependency: if it is not installed the server
// falls back to the plain HTTP client.

const H = require('./humanize');

let puppeteer;
let stealthInstalled = false;

function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  try {
    const puppeteerExtra = require('puppeteer-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    puppeteerExtra.use(stealth());
    puppeteer = puppeteerExtra;
    stealthInstalled = true;
  } catch {
    // Stealth plugin unavailable — plain puppeteer still works.
  }
  return puppeteer;
}

function isAvailable() {
  return loadPuppeteer() !== null;
}

async function launch() {
  const pptr = loadPuppeteer();
  if (!pptr) throw new Error('Puppeteer is not installed');

  const headless = String(process.env.PUPPETEER_HEADLESS || 'true').toLowerCase() !== 'false';
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=vi-VN,vi',
  ];

  const opts = { headless, args, slowMo: Number(process.env.PUPPETEER_SLOWMO || 0) };
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

  const browser = await pptr.launch(opts);
  return browser;
}

// Login through the real form.
async function login(browser, { username, password, loginUrl, log }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(H.pick(require('./olm-client').USER_AGENTS));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Find the username/password inputs from the live DOM.
  const selectors = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const pw = inputs.find((i) => (i.type || '').toLowerCase() === 'password');
    const txt = inputs.find(
      (i) => (i.type || '').toLowerCase() !== 'password' && (i.type || '').toLowerCase() !== 'hidden' && i.type !== 'checkbox'
    );
    return {
      username: txt ? (txt.name || txt.id || '') : '',
      password: pw ? (pw.name || pw.id || '') : '',
    };
  });

  if (!selectors.username || !selectors.password) {
    await page.close();
    throw new Error('Could not locate the login fields in the page');
  }

  const uSel = `input[name="${selectors.username}"], input#${selectors.username}`;
  const pSel = `input[name="${selectors.password}"], input#${selectors.password}`;

  const box = await page.$(uSel);
  if (box) {
    const b = await box.boundingBox();
    if (b) await H.moveMouseSmooth(page, { x: b.x + 5, y: b.y + 5 }, { x: b.x + b.width / 2, y: b.y + b.height / 2 });
  }
  await page.click(uSel, { delay: 60 });
  await H.typeText((ch) => page.keyboard.press(ch === '\b' ? 'Backspace' : ch), username);

  await page.click(pSel, { delay: 60 });
  await H.typeText((ch) => page.keyboard.press(ch === '\b' ? 'Backspace' : ch), password);

  await H.sleep(H.randInt(400, 1200));

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => null),
    page.click('button[type=submit], input[type=submit], .btn-login, .dang-nhap, button'),
  ]);

  const cookies = await page.cookies();
  const stillOnLogin = page.url().includes('dang-nhap');
  if (stillOnLogin) {
    await page.close();
    throw new Error('Login did not succeed (still on the login page)');
  }
  if (log) log('info', `Browser login OK (${cookies.length} cookies)`);

  return { page, cookies };
}// Read the currently selected modern OLM question without mutating its controls.
async function scanCurrentQuestion(page, index, subject, log) {
  const data = await page.evaluate(() => {
    function findElements(selector) {
      const results = [];
      function walk(node) {
        if (!node) return;
        try {
          if (node.querySelectorAll) {
            results.push(...node.querySelectorAll(selector));
          }
        } catch {}
        if (node.shadowRoot) walk(node.shadowRoot);
        const children = node.children || [];
        for (const child of children) walk(child);
      }
      walk(document);
      return results;
    }

    // 1. True / False detection (type-true-fasle or .tf-row)
    const tfRows = findElements('.tf-row');
    if (tfRows.length > 0) {
      const contentEl = findElements('.question-content, .question, .tw-content')[0];
      const statements = tfRows.map((row) => (row.innerText || '').replace(/[ĐS\s]+$/, '').trim()).filter(Boolean);
      if (statements.length) {
        return { type: 'true_false', text: (contentEl?.innerText || '').trim(), statements };
      }
    }

    // 2. Choice options detection (.qselect, .choice-item, .option, etc.)
    const optionEls = findElements('.qselect, .choice-item, .option, .answer-item, .tw-choice, [role="radio"], .content-option, .select-option');
    const validOptions = optionEls.filter((el) => {
      const txt = (el.innerText || '').trim();
      return txt.length > 0 && !/^(nộp bài|tiếp tục|kiểm tra|xác nhận)$/i.test(txt);
    });

    // 3. Short answer input detection
    const inputs = findElements('textarea.typing-para, .text-para, textarea, input.input-typing, input[type="text"]:not([id*="search"])');
    if (validOptions.length === 0 && inputs.length > 0) {
      const contentEl = findElements('.question-content, .question, .tw-content')[0];
      return { type: 'short_answer', text: (contentEl?.innerText || '').trim() };
    }

    // Default: Choice question
    const contentEl = findElements('.question-content, .question, .tw-content')[0];
    const options = validOptions.map((el) => (el.innerText || '').trim());
    return {
      type: 'choice',
      text: (contentEl?.innerText || '').trim(),
      options: options.length ? options : [],
    };
  });

  const hasImage = await page.evaluate(() => {
    const root = document.querySelector('default-root')?.shadowRoot;
    const content = root?.querySelector('.question-content') || document.querySelector('.question-content, .question');
    if (!content) return false;
    const img = content.querySelector('img:not(.emoji):not(.icon), canvas');
    if (img) return true;
    const svgs = Array.from(content.querySelectorAll('svg')).filter((s) => {
      const rect = s.getBoundingClientRect();
      return rect.width > 60 && rect.height > 60;
    });
    return svgs.length > 0;
  });
  let imageBase64 = null;
  if (hasImage) {
    if (log) log('info', `Câu ${index + 1}: phát hiện hình ảnh/sơ đồ -> chụp ảnh gửi AI Vision`);
    imageBase64 = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 }).catch(() => null);
  }
  return {
    id: `q_${index + 1}`,
    index,
    subject,
    type: data?.type || 'choice',
    text: data?.text || '',
    options: data?.options || [],
    statements: data?.statements || [],
    imageBase64,
    hasImage,
  };
}

async function fillCurrentQuestion(page, question, answer) {
  return page.evaluate(({ question, answer }) => {
    function findElements(selector) {
      const results = [];
      function walk(node) {
        if (!node) return;
        try {
          if (node.querySelectorAll) {
            results.push(...node.querySelectorAll(selector));
          }
        } catch {}
        if (node.shadowRoot) walk(node.shadowRoot);
        const children = node.children || [];
        for (const child of children) walk(child);
      }
      walk(document);
      return results;
    }

    if (question.type === 'true_false') {
      const rows = findElements('.tf-row');
      rows.forEach((row, i) => {
        const target = answer.statements?.[i];
        const button = Array.from(row.querySelectorAll('button, td, span, div, input')).find((el) => {
          const text = (el.innerText || el.value || '').trim();
          return text === (target ? 'Đ' : 'S');
        });
        if (button) button.click();
      });
      return { ok: true };
    }

    if (question.type === 'short_answer') {
      const inputs = findElements('textarea.typing-para, .text-para, textarea, input.input-typing, input[type="text"]:not([id*="search"])');
      const input = inputs[0];
      if (!input) return { ok: false, reason: 'short-answer-control-missing' };
      const value = String(answer.answer || '');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: input.value };
    }

    // Multiple choice question
    const optionEls = findElements('.qselect, .choice-item, .option, .answer-item, .tw-choice, [role="radio"], .content-option, .select-option');
    const validOptions = optionEls.filter((el) => {
      const txt = (el.innerText || '').trim();
      return txt.length > 0 && !/^(nộp bài|tiếp tục|kiểm tra|xác nhận)$/i.test(txt);
    });

    if (!validOptions.length) {
      return { ok: false, reason: 'no-options-found' };
    }

    let targetIdx = Number(answer.correctIndex);
    let chosen = null;

    // 1. By index
    if (Number.isInteger(targetIdx) && targetIdx >= 0 && targetIdx < validOptions.length) {
      chosen = validOptions[targetIdx];
    }

    // 2. By letter A, B, C, D
    if (!chosen && answer.answer) {
      const ansLetter = String(answer.answer).trim().toUpperCase();
      if (/^[A-D]$/.test(ansLetter)) {
        const letterIdx = ansLetter.charCodeAt(0) - 65;
        if (letterIdx < validOptions.length) {
          chosen = validOptions[letterIdx];
          targetIdx = letterIdx;
        }
      }
    }

    // 3. By text content match
    if (!chosen && answer.answer) {
      const ansStr = String(answer.answer).trim().toLowerCase();
      chosen = validOptions.find((el) => el.innerText.trim().toLowerCase().includes(ansStr));
    }

    // 4. Safe fallback: click option 0
    if (!chosen) {
      chosen = validOptions[0];
      targetIdx = 0;
    }

    chosen.click();
    const radio = chosen.querySelector('input[type="radio"], input[type="checkbox"], button');
    if (radio) radio.click();

    return { ok: true, selectedIndex: targetIdx };
  }, { question, answer });
}

async function solveModernQuiz(page, { homework, config = {}, log, emit }) {
  const total = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
  if (!total) throw new Error('Không tìm thấy chip câu hỏi trong giao diện OLM hiện đại.');
  const questions = [];
  emit?.('phase', { phase: 'scanning', total });
  for (let index = 0; index < total; index++) {
    await page.evaluate((i) => {
      const chips = document.querySelectorAll('.tw-olm-chip-question');
      if (chips[i] && !chips[i].classList.contains('tw-selected')) chips[i].click();
    }, index);
    await H.sleep(H.randInt(600, 1100));
    const question = await scanCurrentQuestion(page, index, homework.subject, log);
    question.scanStatus = question.text || question.imageBase64 ? 'scanned' : 'unresolved';
    questions.push(question);
    emit?.('scan-progress', { index, completed: index + 1, total });
  }
  if (log) log('info', `Đã quét và lưu ${questions.length}/${total} câu trước khi gọi AI.`);
  emit?.('scan-complete', { total: questions.length });

  const answerEngine = require('./answer-engine');
  const textQuestions = questions.filter((q) => !q.hasImage && q.scanStatus === 'scanned');
  const imageQuestions = questions.filter((q) => q.hasImage && q.scanStatus === 'scanned');
  const batchSize = Math.max(1, Number(config.aiBatchSize || process.env.AI_BATCH_SIZE || 6));
  const answers = new Map();
  const batches = [];
  for (let i = 0; i < textQuestions.length; i += batchSize) batches.push(textQuestions.slice(i, i + batchSize));
  for (const q of imageQuestions) batches.push([q]);

  if (log) {
    const curModel = answerEngine.currentModel();
    log('info', `🤖 Bắt đầu gọi AI giải ${questions.length} câu (${imageQuestions.length} câu hình/sơ đồ, ${textQuestions.length} câu chữ, model: ${curModel})...`);
  }

  emit?.('phase', { phase: 'solving', total: questions.length, batches: batches.length });
  let solvedCount = 0;

  // Parallel AI solving queue with concurrency 2
  const aiConcurrency = Math.min(2, Math.max(1, batches.length));
  const queue = batches.map((batch, idx) => ({ batch, idx }));

  async function aiWorker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { batch, idx } = item;
      const isSingle = batch.length === 1;
      const q = batch[0];
      const qNum = isSingle ? `Câu ${q.index + 1}` : `Nhóm ${idx + 1} (${batch.length} câu)`;
      const qDesc = String(q.text || '').replace(/\s+/g, ' ').slice(0, 45);

      if (log) log('info', `⏳ [AI] Đang giải ${qNum}: "${qDesc || (q.hasImage ? 'Xem hình ảnh' : '')}"...`);

      const startTime = Date.now();
      try {
        const solved = isSingle && q.hasImage
          ? [{ id: q.id, ...(await answerEngine.solveQuestion(q, { onLog: (lvl, msg) => log?.(lvl, msg) })) }]
          : await answerEngine.solveBatch(batch);

        for (const answer of solved) {
          answers.set(answer.id, answer);
          const ansText = answer.answer || (answer.correctIndex >= 0 ? `Đáp án ${String.fromCharCode(65 + answer.correctIndex)}` : 'Đã có đáp án');
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (log && isSingle) {
            log('success', `✔ [AI] ${qNum} đã giải xong -> ${ansText} (${elapsed}s)`);
          }
        }
        if (log && !isSingle) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          log('success', `✔ [AI] ${qNum} đã giải xong (${elapsed}s)`);
        }
      } catch (err) {
        if (log) log('warn', `⚠️ [AI] ${qNum} lỗi (${err.message}). Đang thử giải riêng từng câu...`);
        for (const singleQ of batch) {
          try {
            const singleAns = await answerEngine.solveQuestion(singleQ, { onLog: (lvl, msg) => log?.(lvl, msg) });
            answers.set(singleQ.id, { id: singleQ.id, ...singleAns });
            if (log) log('success', `✔ [AI] Câu ${singleQ.index + 1} giải thành công (dự phòng)`);
          } catch (fallbackErr) {
            answers.set(singleQ.id, { id: singleQ.id, error: fallbackErr.message, correctIndex: -1, answer: '' });
            if (log) log('error', `✖ [AI] Câu ${singleQ.index + 1} không thể giải: ${fallbackErr.message}`);
          }
        }
      }

      solvedCount += batch.length;
      emit?.('solve-progress', { completed: solvedCount, total: questions.length });
    }
  }

  await Promise.all(Array.from({ length: aiConcurrency }, () => aiWorker()));
  emit?.('solve-complete', { completed: solvedCount, total: questions.length });

  const plannedQuestions = questions.map((q) => ({ ...q, correctIndex: answers.get(q.id)?.correctIndex ?? -1 }));
  const plan = H.planWrongAnswers(plannedQuestions, config.scoreTarget);
  emit?.('phase', { phase: 'filling', total: questions.length });
  if (log) log('info', `✍ Bắt đầu điền đáp án vào trang OLM (${questions.length} câu)...`);

  let filled = 0;
  let failed = 0;
  const questionStatuses = new Map();
  for (const question of questions) {
    const answer = answers.get(question.id);
    if (!answer || answer.error) {
      failed++;
      questionStatuses.set(question.id, 'unresolved');
      continue;
    }
    const plannedWrongIndex = plannedQuestions[question.index]?.plannedWrong;
    const planned = plan.wrongIndices.has(question.index) && question.options.length > 1 && plannedWrongIndex >= 0
      ? { ...answer, correctIndex: plannedWrongIndex, answer: question.options[plannedWrongIndex] }
      : answer;
    await page.evaluate((i) => {
      const chips = document.querySelectorAll('.tw-olm-chip-question');
      if (chips[i] && !chips[i].classList.contains('tw-selected')) chips[i].click();
    }, question.index);
    await H.sleep(H.randInt(400, 800));
    const result = await fillCurrentQuestion(page, question, planned);
    if (!result.ok) {
      failed++;
      questionStatuses.set(question.id, 'fill-error');
      log?.('warn', `Câu ${question.index + 1}: không thể xác minh ô trả lời (${result.reason || 'unknown'})`);
    } else {
      filled++;
      questionStatuses.set(question.id, 'filled');
      if (log && (question.index % 5 === 0 || question.index === questions.length - 1)) {
        log('info', `✍ Đã điền câu ${question.index + 1}/${questions.length}...`);
      }
    }

    // Click #btn-done ("Kiểm tra đáp án" / "Lưu đáp án" trên OLM)
    await page.evaluate(() => {
      const btn = document.getElementById('btn-done') ||
                  document.querySelector('.btn-done, button.btn-done, button[id*="done"]');
      if (btn && !btn.disabled) btn.click();
    });

    emit?.('fill-progress', { completed: filled + failed, filled, failed, total: questions.length });
    await H.sleep(H.randInt(400, 700));
  }
  emit?.('fill-complete', { filled, failed, total: questions.length });

  // Delay submit setting
  const delayMin = Number(config.submitDelayMinutes || 0);
  if (delayMin > 0) {
    if (log) log('info', `Chờ ${delayMin} phút trước khi nộp bài theo cấu hình...`);
    if (emit) emit('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
    await H.sleep(delayMin * 60000);
  } else {
    await H.sleep(1500);
  }

  // Click "Xác nhận nộp" button (.btn-submit-cate)
  if (log) log('info', 'Bắt đầu nộp bài tự động...');
  const submitClicked = await page.evaluate(() => {
    const btn =
      document.querySelector('.btn-submit-cate') ||
      Array.from(document.querySelectorAll('button, a.btn, input[type=submit]')).find((b) =>
        /xác nhận nộp|nộp bài|nop bai/i.test(b.innerText || b.value || '')
      );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (submitClicked) {
    if (log) log('info', 'Đã nhấn nút "Xác nhận nộp bài"');
    await H.sleep(1500);

    // Confirm modal if any
    await page.evaluate(() => {
      const confirmBtn = Array.from(document.querySelectorAll('button, a.btn')).find(
        (b) =>
          /đồng ý|xác nhận|nộp|ok/i.test(b.innerText || '') &&
          !b.classList.contains('btn-submit-cate')
      );
      if (confirmBtn) confirmBtn.click();
    });

    await H.sleep(2500);
    if (log) log('success', `✔ Đã hoàn thành và nộp bài: ${homework.title}`);
  }

  return {
    engine: 'browser',
    phase: 'done',
    scanned: questions.length,
    solved: answers.size,
    filled,
    failed,
    submitted: Boolean(submitClicked),
    questions: questions.map((q) => ({ id: q.id, index: q.index, type: q.type, text: q.text, status: questionStatuses.get(q.id) || q.scanStatus })),
  };
}

// Work through one homework in the browser.
async function solveHomework(browser, { homework, session, config = {}, log, emit }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  await page.setUserAgent(H.pick(require('./olm-client').USER_AGENTS));

  // Inject session cookies if provided
  if (session && session.cookieJar) {
    const rawCookies = session.cookieJar.cookies || [];
    const pCookies = rawCookies.map((c) => ({
      name: c.key,
      value: c.value,
      domain: (c.domain || 'olm.vn').replace(/^\./, ''),
      path: c.path || '/',
    }));
    if (pCookies.length > 0) {
      await page.setCookie(...pCookies);
    }
  }

  try {
    if (log) log('info', `Mở bài tập: ${homework.url}`);
    await page.goto(homework.url, { waitUntil: 'networkidle2', timeout: 45000 });
    await H.sleep(H.randInt(2000, 3500));

    // Check if this is the modern OLM practice interface (LitElement with shadow DOM / chips)
    const isModernQuiz = await page.evaluate(() => {
      const root = document.querySelector('default-root');
      const chips = document.querySelectorAll('.tw-olm-chip-question');
      return !!(root || chips.length > 0);
    });

    if (isModernQuiz) {
      return await solveModernQuiz(page, { homework, config, log, emit });
    }


    // Fallback: older / generic question blocks
    const blocks = await page.evaluate(() => {
      const sels = [
        '.question-item',
        '.question',
        '.quiz-question',
        '.exercise-question',
        '[data-question-id]',
        'fieldset',
      ];
      for (const s of sels) {
        const found = Array.from(document.querySelectorAll(s));
        if (found.length > 0) return found.map((el, i) => ({ i }));
      }
      return [];
    });

    if (!blocks.length) {
      throw new Error('Không tìm thấy câu hỏi nào trên trang bài tập.');
    }

    // Generic submit fallback
    const submitted = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type=submit], a.btn, .btn-submit')).find((el) =>
        /nộp|nop|submit|gửi/i.test(el.textContent || el.value || '')
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });

    if (log) log('info', submitted ? 'Nút nộp bài đã được click' : 'Không tìm thấy nút nộp bài');
    await H.sleep(2000);

    return { engine: 'browser', submitted };
  } finally {
    await page.close().catch(() => null);
  }
}

module.exports = { isAvailable, launch, login, solveHomework };