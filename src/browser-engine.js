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

  const proxy = require('./proxy').parseProxy();

  const headless = String(process.env.PUPPETEER_HEADLESS || 'true').toLowerCase() !== 'false';
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
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

  const browser = await pptr.launch(opts);

  if (proxy && proxy.username && proxy.password) {
    browser.on('targetcreated', async (target) => {
      const p = await target.page().catch(() => null);
      if (p) {
        await p.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
      }
    });
  }

  return browser;
}

// Login through the real form.
async function login(browser, { username, password, loginUrl, log }) {
  const page = await browser.newPage();

  const proxy = require('./proxy').parseProxy();
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
  }

  await page.setViewport({ width: 1366, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(H.pick(require('./olm-client').USER_AGENTS));
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8' });

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

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
      } catch {}
    }

    try {
      await page.waitForSelector('input#username, input[name="username"], input[type="password"]', {
        visible: true,
        timeout: 10000,
      });
    } catch {}
  }

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
    const pageTitle = await page.title().catch(() => '');
    const pageHtml = await page.content().catch(() => '');
    await page.close().catch(() => {});
    if (/just a moment|cloudflare|attention required/i.test(pageTitle + pageHtml)) {
      throw new Error('Cloudflare yêu cầu xác minh bảo mật từ máy chủ. Vui lòng sử dụng tính năng "Đăng nhập bằng Cookie OLM" để đăng nhập ngay lập tức.');
    }
    throw new Error('Không thể tìm thấy ô đăng nhập OLM trên trang web. Vui lòng thử lại hoặc dùng Cookie.');
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
    await page.click('button.btn-submit, .btn-submit, input[type=submit]').catch(() => {});
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

  const cookies = await page.cookies();
  const hasSessionCookie = cookies.some((c) => c.name === 'onlinemath_session' || c.name === 'laravel_session');
  const currentUrl = page.url();
  const stillOnLogin = /dang-?nhap/i.test(currentUrl) && !hasSessionCookie;

  if (stillOnLogin) {
    const errText = await page.evaluate(() => {
      const modal = document.querySelector('.main-modal-v2-content, .swal2-html-container, .toast, .alert, .tw-text-danger, .text-danger');
      if (modal && modal.innerText.trim()) {
        const text = modal.innerText.trim();
        // Extract the error sentence if nested
        const m = text.match(/Tên đăng nhập hoặc mật khẩu[^.\n]+[.\n]?|tài khoản[^.\n]+[.\n]?|mật khẩu không chính xác/i);
        return m ? m[0].trim() : text;
      }
      const anyErr = Array.from(document.querySelectorAll('div, p, span')).find(el => 
        /không chính xác|sai mật khẩu|sai tên|tài khoản không tồn tại/i.test(el.innerText || '')
      );
      if (anyErr && anyErr.innerText.trim()) {
        const text = anyErr.innerText.trim();
        const m = text.match(/Tên đăng nhập hoặc mật khẩu[^.\n]+[.\n]?|tài khoản[^.\n]+[.\n]?|mật khẩu không chính xác/i);
        return m ? m[0].trim() : text;
      }
      return null;
    });
    await page.close().catch(() => {});
    throw new Error(errText || 'Tên đăng nhập hoặc mật khẩu OLM không chính xác.');
  }

  if (log) log('info', `Browser login OK (${cookies.length} cookies)`);
  return { page, cookies };
}

// Read the currently selected modern OLM question without mutating its controls.
async function scanCurrentQuestion(page, index, subject, log) {
  const data = await page.evaluate((idx) => {
    const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
    if (!root) return { type: 'choice', text: '', options: [] };

    // 1. Essay / Paragraph (<type-paragraph>)
    const typePara = root.querySelector('type-paragraph')?.shadowRoot || root.querySelector('type-paragraph');
    if (typePara) {
      const p = typePara.querySelector('#paragraph');
      let text = p ? p.innerText.trim() : '';
      text = text.replace(/Bài làm[\s\S]*$/i, '').trim();
      return {
        type: 'short_answer',
        text,
        options: []
      };
    }

    // 2. Fill-in-the-blank / Short answer (<type-fill-me>)
    const fillMe = root.querySelector('type-fill-me')?.shadowRoot || root.querySelector('type-fill-me');
    if (fillMe) {
      const p = fillMe.querySelector('#fillme-input, .question-content') || fillMe;
      let text = p ? p.innerText.trim() : '';
      text = text.replace(/Bài làm[\s\S]*$/i, '').trim();
      return {
        type: 'short_answer',
        text,
        options: []
      };
    }

    // 3. True / False (<type-true-fasle>)
    const tf = root.querySelector('type-true-fasle')?.shadowRoot || root.querySelector('type-true-fasle');
    if (tf) {
      const content = tf.querySelector('.question-content');
      const rows = Array.from(tf.querySelectorAll('.tf-row')).map((row) => (row.innerText || '').replace(/[ĐS\s]+$/, '').trim()).filter(Boolean);
      return {
        type: 'true_false',
        text: (content?.innerText || '').trim(),
        statements: rows
      };
    }

    // 4. General Short Answer / Textarea inside root
    const directTextarea = root.querySelector('textarea.typing-para, .text-para, textarea');
    if (directTextarea) {
      const qContent = root.querySelector('.question-content, #paragraph, .question');
      return {
        type: 'short_answer',
        text: (qContent?.innerText || '').trim(),
        options: []
      };
    }

    // 5. Choice (<type-quiz-x>, <type-quiz-multi>, <type-quiz-x-mobile>, or general)
    const quiz = root.querySelector('type-quiz-x, type-quiz-multi, type-quiz-x-mobile, type-quiz')?.shadowRoot ||
                 root.querySelector('type-quiz-x, type-quiz-multi, type-quiz-x-mobile, type-quiz') || root;
    const qContent = quiz.querySelector('.question-content, #paragraph, .question');
    const text = (qContent?.innerText || '').trim();

    // Query ONLY immediate option wrappers (.qselect or direct choices)
    let optionEls = Array.from(quiz.querySelectorAll('.qselect'));
    if (!optionEls.length) {
      optionEls = Array.from(quiz.querySelectorAll('.choice-item, .option, .answer-item'));
    }
    const options = optionEls.map(el => el.innerText.trim()).filter(Boolean);

    return {
      type: 'choice',
      text,
      options
    };
  }, index);

  const hasImage = await page.evaluate(() => {
    const root = document.querySelector('default-root')?.shadowRoot;
    const content = root?.querySelector('.question-content, #paragraph, #fillme-input') || document.querySelector('.question-content, .question');
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
    if (log) log('info', `Câu ${index + 1}: xử lý sơ đồ / hình ảnh`);
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
    const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
    if (!root) return { ok: false, reason: 'no-default-root' };

    // 1. True / False
    if (question.type === 'true_false') {
      const tf = root.querySelector('type-true-fasle')?.shadowRoot || root.querySelector('type-true-fasle');
      const rows = Array.from(tf?.querySelectorAll('.tf-row') || []);
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

    // 2. Short Answer / Essay / Fill-me (<type-paragraph>, <type-fill-me>, textarea, or input)
    if (question.type === 'short_answer') {
      const typePara = root.querySelector('type-paragraph')?.shadowRoot || root.querySelector('type-paragraph');
      const fillMe = root.querySelector('type-fill-me')?.shadowRoot || root.querySelector('type-fill-me');
      const input = fillMe?.querySelector('input') ||
                    typePara?.querySelector('textarea.typing-para, .text-para, textarea') ||
                    root.querySelector('textarea.typing-para, .text-para, textarea, input[type="text"], input:not([type])') ||
                    document.querySelector('textarea.typing-para, .text-para, textarea, input[type="text"], input:not([type])');
      if (!input) return { ok: false, reason: 'short-answer-control-missing' };
      
      const value = String(answer.answer || '').trim();
      input.focus();
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
      return { ok: true, value: input.value };
    }

    // 3. Multiple Choice
    const quiz = root.querySelector('type-quiz-x, type-quiz-multi, type-quiz-x-mobile, type-quiz')?.shadowRoot ||
                 root.querySelector('type-quiz-x, type-quiz-multi, type-quiz-x-mobile, type-quiz') || root;
    let optionEls = Array.from(quiz.querySelectorAll('.qselect'));
    if (!optionEls.length) {
      optionEls = Array.from(quiz.querySelectorAll('.choice-item, .option, .answer-item'));
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
      if (/^[A-D]$/.test(ansLetter)) {
        const letterIdx = ansLetter.charCodeAt(0) - 65;
        if (letterIdx < optionEls.length) {
          chosen = optionEls[letterIdx];
          targetIdx = letterIdx;
        }
      }
    }

    // C. By text content match
    if (!chosen && answer.answer) {
      const ansStr = String(answer.answer).trim().toLowerCase();
      chosen = optionEls.find((el) => el.innerText.trim().toLowerCase().includes(ansStr));
    }

    // D. Safe fallback: click option 0
    if (!chosen) {
      chosen = optionEls[0];
      targetIdx = 0;
    }

    chosen.click();
    return { ok: true, selectedIndex: targetIdx };
  }, { question, answer });
}

async function solveModernQuiz(page, { homework, config = {}, log, emit, signal }) {
  const total = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
  if (!total) throw new Error('Không tìm thấy chip câu hỏi trong giao diện OLM hiện đại.');
  const questions = [];
  emit?.('phase', { phase: 'scanning', total });
  if (log) log('info', `Bắt đầu nạp nhanh ${total} câu hỏi...`);
  for (let index = 0; index < total; index++) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    await page.evaluate((i) => {
      const chips = document.querySelectorAll('.tw-olm-chip-question');
      if (chips[i] && !chips[i].classList.contains('tw-selected')) chips[i].click();
    }, index);
    await H.sleep(H.randInt(150, 250));
    const question = await scanCurrentQuestion(page, index, homework.subject, log);
    question.scanStatus = question.text || question.imageBase64 ? 'scanned' : 'unresolved';
    questions.push(question);
    emit?.('scan-progress', { index, completed: index + 1, total });
    if (log) {
      const qDesc = String(question.text || '').replace(/\s+/g, ' ').slice(0, 45);
      log('info', `📋 Đã quét Câu ${index + 1}/${total}: "${qDesc || (question.hasImage ? 'Hình ảnh' : 'Trắc nghiệm')}"`);
    }
  }
  if (log) log('info', `Đã nạp xong toàn bộ ${questions.length}/${total} câu hỏi.`);
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
    log('info', `Đang xử lý ${questions.length} câu hỏi (${imageQuestions.length ? imageQuestions.length + ' câu hình/sơ đồ, ' : ''}${textQuestions.length} câu chữ)...`);
  }

  emit?.('phase', { phase: 'solving', total: questions.length, batches: batches.length });
  let solvedCount = 0;

  const aiConcurrency = Math.min(3, Math.max(1, batches.length));
  const queue = batches.map((batch, idx) => ({ batch, idx }));

  async function aiWorker() {
    while (queue.length > 0) {
      if (signal?.aborted) break;
      const item = queue.shift();
      if (!item) break;
      const { batch, idx } = item;
      const isSingle = batch.length === 1;
      const q = batch[0];
      const qNum = isSingle ? `Câu ${q.index + 1}` : `Nhóm ${idx + 1} (${batch.length} câu)`;
      const qDesc = String(q.text || '').replace(/\s+/g, ' ').slice(0, 45);

      if (log) log('info', `⏳ Đang xử lý ${qNum}: "${qDesc || (q.hasImage ? 'Xem hình ảnh' : '')}"...`);

      const startTime = Date.now();
      try {
        const solved = isSingle && q.hasImage
          ? [{ id: q.id, ...(await answerEngine.solveQuestion(q, { onLog: (lvl, msg) => log?.(lvl, msg) })) }]
          : await answerEngine.solveBatch(batch);

        for (const answer of solved) {
          answers.set(answer.id, answer);
          const ansText = answer.answer || (answer.correctIndex >= 0 ? `Đáp án ${String.fromCharCode(65 + answer.correctIndex)}` : 'Đã có đáp án');
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const matchedQ = batch.find((b) => b.id === answer.id) || q;
          if (log) {
            log('success', `✔ Câu ${matchedQ.index + 1} -> ${ansText} (${elapsed}s)`);
          }
        }
      } catch (err) {
        if (log) log('warn', `⚠️ ${qNum} đang thử xử lý lại từng câu...`);
        for (const singleQ of batch) {
          try {
            const singleAns = await answerEngine.solveQuestion(singleQ, { onLog: (lvl, msg) => log?.(lvl, msg) });
            answers.set(singleQ.id, { id: singleQ.id, ...singleAns });
            const sAns = singleAns.answer || (singleAns.correctIndex >= 0 ? `Đáp án ${String.fromCharCode(65 + singleAns.correctIndex)}` : 'Đã có đáp án');
            if (log) log('success', `✔ Câu ${singleQ.index + 1} -> ${sAns}`);
          } catch (fallbackErr) {
            answers.set(singleQ.id, { id: singleQ.id, error: fallbackErr.message, correctIndex: -1, answer: '' });
            if (log) log('error', `✖ Câu ${singleQ.index + 1} chưa xác định được đáp án`);
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

  const targetScoreStr = config.scoreTarget || '10';
  const wrongCount = plan.wrongIndices.size;
  const correctCount = questions.length - wrongCount;
  if (log) {
    log('info', `✍ Bắt đầu điền đáp án (${questions.length} câu, mục tiêu: ${targetScoreStr}đ -> đúng ${correctCount} câu, sai ${wrongCount} câu)...`);
  }

  let filled = 0;
  let failed = 0;
  const questionStatuses = new Map();
  for (const question of questions) {
    if (signal?.aborted) throw new Error('Tiến trình đã bị dừng bởi người dùng');
    const answer = answers.get(question.id);
    if (!answer || answer.error) {
      failed++;
      questionStatuses.set(question.id, 'unresolved');
      continue;
    }

    let planned = answer;
    if (plan.wrongIndices.has(question.index)) {
      const wrongData = plan.plannedWrongs?.get(question.index);
      if (wrongData) {
        planned = { ...answer, ...wrongData };
      }
    }

    await page.evaluate((i) => {
      const chips = document.querySelectorAll('.tw-olm-chip-question');
      if (chips[i] && !chips[i].classList.contains('tw-selected')) chips[i].click();
    }, question.index);
    await H.sleep(H.randInt(120, 220));
    const result = await fillCurrentQuestion(page, question, planned);
    if (!result.ok) {
      failed++;
      questionStatuses.set(question.id, 'fill-error');
      log?.('warn', `Câu ${question.index + 1}: không thể xác minh ô trả lời (${result.reason || 'unknown'})`);
    } else {
      filled++;
      questionStatuses.set(question.id, 'filled');
      if (log) {
        const chosenText = planned.answer || (planned.correctIndex >= 0 ? `Đáp án ${String.fromCharCode(65 + planned.correctIndex)}` : 'Đã chọn');
        log('info', `✍ Đã điền Câu ${question.index + 1}/${questions.length}: [${chosenText}]`);
      }
    }

    // Click #btn-done ("Kiểm tra đáp án" / "Lưu đáp án" trên OLM)
    await page.evaluate(() => {
      const btn = document.getElementById('btn-done') ||
                  document.querySelector('.btn-done, button.btn-done, button[id*="done"]');
      if (btn && !btn.disabled) btn.click();
    });

    emit?.('fill-progress', { completed: filled + failed, filled, failed, total: questions.length });
    await H.sleep(H.randInt(100, 180));
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

// Step-by-step interactive practice (for OLM /chu-de/... practice exercises)
async function solveFlowPractice(page, { homework, config = {}, log, emit, signal }) {
  const answerEngine = require('./answer-engine');
  const questions = [];
  const maxQuestions = 150;
  let step = 0;

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

    // 2. Scan current question with retries
    let question = null;
    for (let r = 0; r < 4; r++) {
      question = await scanCurrentQuestion(page, step, homework.subject, log);
      if (question.text || question.imageBase64) break;
      await H.sleep(400);
    }

    // Self-healing fallback: if step === 0 and no question found, check if result screen is still visible
    if (step === 0 && (!question || (!question.text && !question.imageBase64))) {
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
          const cBtn = Array.from(document.querySelectorAll('button, a, div, span')).find((b) =>
            /^(xác nhận|đồng ý)$/i.test((b.innerText || '').trim())
          );
          if (cBtn) (cBtn.closest('button, a, div[role=button]') || cBtn).click();
        });
        await H.sleep(2000);
        question = await scanCurrentQuestion(page, 0, homework.subject, log);
      }
    }

    if (!question || (!question.text && !question.imageBase64)) {
      if (log) log('info', `Không còn câu hỏi tiếp theo, hoàn tất bài tập.`);
      break;
    }

    questions.push(question);
    const qDesc = String(question.text || '').replace(/\s+/g, ' ').slice(0, 50);
    if (log) log('info', `⏳ Đang xử lý Câu ${step + 1}: "${qDesc || (question.imageBase64 ? 'Xem hình ảnh' : '')}"...`);
    emit?.('scan-progress', { completed: step + 1, total: step + 1 });

    // 3. Solve question with AI
    let answer;
    try {
      answer = await answerEngine.solveQuestion(question, { onLog: (lvl, msg) => log?.(lvl, msg) });
      const ansText = answer.answer || (answer.correctIndex >= 0 ? `Đáp án ${String.fromCharCode(65 + answer.correctIndex)}` : 'Đã có đáp án');
      if (log) log('success', `✔ Câu ${step + 1} -> ${ansText}`);
    } catch (err) {
      if (log) log('warn', `⚠️ Câu ${step + 1} gặp lỗi (${err.message}), chọn mặc định`);
      answer = { correctIndex: 0, answer: 'A' };
    }

    // 4. Fill answer
    await H.sleep(H.randInt(100, 180));
    const fillRes = await fillCurrentQuestion(page, question, answer);
    if (!fillRes.ok && log) {
      log('warn', `Câu ${step + 1}: Điền đáp án chưa tối ưu (${fillRes.reason || 'unknown'})`);
    }

    // 5. Click "Kiểm tra đáp án"
    await H.sleep(H.randInt(100, 200));
    await page.evaluate(() => {
      const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
      const allBtns = [
        ...Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button]')),
        ...(root ? Array.from(root.querySelectorAll('button, a.btn, input[type=submit], div[role=button]')) : [])
      ];
      const btn = allBtns.find((b) => /kiểm tra đáp án|nop bai|nộp bài|trả lời/i.test(b.innerText || b.value || ''));
      if (btn) btn.click();
    });

    if (log) log('info', `✍ Đã nộp đáp án Câu ${step + 1} -> Đang kiểm tra và chuyển câu...`);
    emit?.('fill-progress', { completed: step + 1, filled: step + 1, total: step + 1 });
    await H.sleep(H.randInt(250, 450));

    // 6. Check if done immediately after submit
    const doneAfterSubmit = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const modal = document.querySelector('.main-modal-v2, .swal2-container, .modal-finish, .modal-result');
      return (/chúc mừng bạn đã hoàn thành|bạn đã đạt|kết quả luyện tập|đừng nản lòng|hoàn thành/i.test(text) && !/kiểm tra đáp án/i.test(text)) ||
             !!(modal && /chúc mừng|kết quả|hoàn thành/i.test(modal.innerText));
    });
    if (doneAfterSubmit) {
      if (log) log('success', `🎉 Đã hoàn thành toàn bộ bài luyện tập!`);
      break;
    }

    // 7. Click "Tiếp" button if present
    await page.evaluate(() => {
      const root = document.querySelector('default-root')?.shadowRoot || document.querySelector('default-root');
      const allBtns = [
        ...Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button], span')),
        ...(root ? Array.from(root.querySelectorAll('button, a.btn, input[type=submit], div[role=button], span')) : [])
      ];
      const nextBtn = allBtns.find((b) => /^(tiếp|câu tiếp|làm tiếp|tiếp tục|next)$/i.test((b.innerText || b.value || '').trim()));
      if (nextBtn) nextBtn.click();
    });

    // 8. Wait for next question
    let advancedToNext = false;
    for (let w = 0; w < 8; w++) {
      await H.sleep(150);

      const checkState = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const modal = document.querySelector('.main-modal-v2, .swal2-container, .modal-finish, .modal-result');
        const isFinished = /chúc mừng bạn đã hoàn thành|bạn đã đạt|kết quả luyện tập|chúc mừng bạn/i.test(text) &&
                           !/kiểm tra đáp án/i.test(text);

        const allBtns = Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button]'));
        const hasCheckBtn = allBtns.some((b) => /kiểm tra đáp án|nop bai|nộp bài|trả lời/i.test(b.innerText || b.value || ''));

        // If next button still present, click it
        const nextBtn = allBtns.find((b) => /^(tiếp|câu tiếp|làm tiếp|tiếp tục|next)$/i.test((b.innerText || b.value || '').trim()));
        if (nextBtn) nextBtn.click();

        return {
          isFinished: isFinished || !!(modal && /chúc mừng|kết quả|hoàn thành/i.test(modal.innerText)),
          hasCheckBtn
        };
      });

      if (checkState.isFinished) {
        if (log) log('success', `🎉 Đã hoàn thành toàn bộ bài luyện tập!`);
        advancedToNext = false;
        break;
      }

      if (checkState.hasCheckBtn) {
        advancedToNext = true;
        break;
      }
    }

    if (!advancedToNext) {
      if (log) log('info', `Không còn câu hỏi tiếp theo, hoàn tất bài tập.`);
      break;
    }

    step++;
  }

  return {
    engine: 'browser',
    phase: 'done',
    mode: 'flow',
    scanned: questions.length,
    solved: questions.length,
    filled: questions.length,
    failed: 0,
    submitted: true,
    questions: questions.map((q, idx) => ({ id: q.id, index: idx, type: q.type, text: q.text, status: 'filled' })),
  };
}

// Work through one homework in the browser.
async function solveHomework(browser, { homework, session, config = {}, log, emit, signal }) {
  const page = await browser.newPage();

  const proxy = require('./proxy').parseProxy();
  if (proxy && proxy.username && proxy.password) {
    await page.authenticate({ username: proxy.username, password: proxy.password }).catch(() => {});
  }

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
    await page.setRequestInterception(true).catch(() => {});
    page.on('request', (req) => {
      const type = req.resourceType();
      const u = req.url().toLowerCase();
      if (type === 'media' || u.includes('analytics') || u.includes('facebook') || u.includes('doubleclick') || u.includes('clarity.ms') || u.includes('hotjar')) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });
  } catch {}

  try {
    if (log) log('info', `Mở bài tập: ${homework.url}`);
    try {
      await page.goto(homework.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    } catch (navErr) {
      if (log) log('warn', `Trang tải chậm (${navErr.message}), đang kiểm tra nội dung...`);
    }

    // 1. Chờ OLM Single Page Application mount giao diện
    try {
      await page.waitForFunction(() => {
        const hasRedo = document.querySelector('#btn-redo-practice') ||
                        Array.from(document.querySelectorAll('button, a, div[role=button]')).some(b => /luyện tập lại/i.test(b.innerText || ''));
        const hasChips = document.querySelector('.tw-olm-chip-question');
        const hasQuiz = document.querySelector('default-root') ||
                        document.querySelector('.question-content, #paragraph, type-quiz-x, type-quiz-x-mobile');
        const hasResult = document.querySelector('.practice-result, .box-result, .box-score') ||
                          /đừng nản lòng|kết quả luyện tập|xem đáp án/i.test(document.body?.innerText || '');
        return !!(hasRedo || hasChips || hasQuiz || hasResult);
      }, { timeout: 15000 });
    } catch {}

    // 2. Kiểm tra nếu bài tập đã hoàn thành từ trước (hiển thị nút "Luyện tập lại" hoặc màn hình kết quả "Đừng nản lòng")
    let redoClicked = false;
    for (let r = 0; r < 5; r++) {
      redoClicked = await page.evaluate(() => {
        const byId = document.getElementById('btn-redo-practice') || document.querySelector('[id*="redo"]');
        if (byId) {
          byId.click();
          return true;
        }

        const candidates = Array.from(document.querySelectorAll('button, a, div, span, p')).filter((el) => {
          const text = (el.innerText || el.textContent || '').trim();
          return /^(luyện tập lại|làm lại bài|làm lại|luyen tap lai)$/i.test(text) ||
                 (text.includes('Luyện tập lại') && text.length < 35);
        });

        if (candidates.length > 0) {
          const target = candidates[candidates.length - 1];
          const clickable = target.closest('button, a, div[role=button]') || target;
          clickable.click();
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          return true;
        }

        return false;
      });

      if (redoClicked) break;
      await H.sleep(600);
    }

    if (redoClicked) {
      if (log) log('info', 'Phát hiện bài đã làm từ trước -> Đang nhấn "Luyện tập lại" để làm lại bài...');

      // Chờ popup modal xác nhận xuất hiện ("Bạn có chắc xóa dữ liệu bài này để làm lại?")
      await H.sleep(1000);
      try {
        await page.waitForSelector('.popup-primary-button, .tw-olm-btn-primary-48, .modal-confirm, .swal2-confirm', {
          visible: true,
          timeout: 5000,
        });
      } catch {}

      // Nhấn nút "Xác nhận" trên popup
      await page.evaluate(() => {
        const popupBtn = document.querySelector('.popup-primary-button');
        if (popupBtn) {
          popupBtn.click();
          popupBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return;
        }
        const confirmBtns = Array.from(document.querySelectorAll('button, a, div, span')).filter((b) =>
          /^(xác nhận|đồng ý|xac nhan|dong y|ok)$/i.test((b.innerText || b.textContent || '').trim()) &&
          !b.classList.contains('btn-submit-cate')
        );
        if (confirmBtns.length > 0) {
          const btn = confirmBtns[confirmBtns.length - 1];
          const clickable = btn.closest('button, a, div[role=button]') || btn;
          clickable.click();
          clickable.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
      });

      if (log) log('info', 'Đã xác nhận làm lại bài, đang nạp câu hỏi mới...');

      // Chờ modal đóng và màn hình kết quả biến mất, câu hỏi mới nạp
      await H.sleep(2500);
    }

    // 3. Kiểm tra xem có chip câu hỏi trắc nghiệm hiện đại không (.tw-olm-chip-question)
    let chipsCount = 0;
    try {
      await page.waitForSelector('.tw-olm-chip-question', { timeout: 3500 });
      chipsCount = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
    } catch {
      chipsCount = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
    }

    if (chipsCount > 0) {
      if (log) log('info', `Giao diện bài thi trắc nghiệm (${chipsCount} câu) -> Bắt đầu giải siêu tốc...`);
      return await solveModernQuiz(page, { homework, config, log, emit, signal });
    }

    // B. Check if this is the modern OLM step-by-step flow practice interface
    const isFlowPractice = await page.evaluate(() => {
      const root = document.querySelector('default-root');
      const hasQuizElement = !!(
        root?.shadowRoot?.querySelector('type-quiz-x-mobile, type-quiz-x, type-paragraph, type-fill-me, type-true-fasle') ||
        document.querySelector('type-quiz-x-mobile, type-quiz-x, #question-container, .question-container')
      );
      const hasCheckBtn = Array.from(document.querySelectorAll('button, a.btn, input[type=submit], div[role=button]')).some((b) =>
        /kiểm tra đáp án|trả lời|tiếp tục|tiếp/i.test(b.innerText || b.value || '')
      );
      return !!(root || hasQuizElement || hasCheckBtn);
    });

    const isChuDeUrl = homework.url && homework.url.includes('/chu-de/');
    if (isFlowPractice || isChuDeUrl) {
      return await solveFlowPractice(page, { homework, config, log, emit, signal });
    }

    // C. Fallback: older / generic question blocks
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

module.exports = { isAvailable, launch, login, solveHomework, solveFlowPractice };