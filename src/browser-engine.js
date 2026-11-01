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
      if (log) log('info', 'Phát hiện giao diện bài tập OLM (Trắc nghiệm trực tuyến)');
      const answerEngine = require('./answer-engine');

      const totalChips = await page.evaluate(() => document.querySelectorAll('.tw-olm-chip-question').length);
      const questionCount = totalChips > 0 ? totalChips : 1;
      if (log) log('info', `Tổng số câu hỏi: ${questionCount}`);

      let answeredCount = 0;

      for (let qi = 0; qi < questionCount; qi++) {
        // Jump to chip qi if not already on it
        await page.evaluate((idx) => {
          const chips = document.querySelectorAll('.tw-olm-chip-question');
          if (chips[idx] && !chips[idx].classList.contains('tw-selected')) {
            chips[idx].click();
          }
        }, qi);
        await H.sleep(H.randInt(800, 1500));

        // Read question data from shadowRoot
        const qData = await page.evaluate(() => {
          const root = document.querySelector('default-root')?.shadowRoot;
          const quizX = root?.querySelector('type-quiz-x')?.shadowRoot;
          if (!quizX) return null;

          const contentEl = quizX.querySelector('.question-content');
          const text = (contentEl?.innerText || '').trim();

          const optionEls = Array.from(quizX.querySelectorAll('.qselect'));
          const options = optionEls
            .map((el, i) => ({
              index: i,
              text: (el.innerText || '').trim(),
            }))
            .filter((o) => o.text.length > 0);

          return { text, options };
        });

        if (!qData || !qData.text || !qData.options.length) {
          if (log) log('warn', `Câu ${qi + 1}: Không tìm thấy nội dung câu hỏi, chuyển câu tiếp theo...`);
          continue;
        }

        if (log) log('info', `Giải câu ${qi + 1}/${questionCount}: ${qData.text.slice(0, 60)}...`);

        // Ask AI for the answer
        let chosenIdx = 0;
        let chosenText = qData.options[0]?.text || '';
        try {
          const solved = await answerEngine.solveQuestion({
            id: `q_${qi + 1}`,
            text: qData.text,
            options: qData.options.map((o) => o.text),
          });
          chosenIdx = solved.correctIndex >= 0 ? solved.correctIndex : 0;
          chosenText = solved.answer || qData.options[chosenIdx]?.text || '';
          if (log) log('info', `Câu ${qi + 1}: AI chọn [${chosenIdx + 1}] "${chosenText.slice(0, 45)}"`);
        } catch (err) {
          if (log) log('warn', `Câu ${qi + 1}: AI gặp lỗi (${err.message}), dùng lựa chọn mặc định`);
        }

        // Deliberately miss a question if target score is 8 or 9
        let missChance = 0;
        if (config.scoreTarget === '9') missChance = 0.10;
        else if (config.scoreTarget === '8') missChance = 0.20;
        else if (config.scoreTarget === '10' || config.scoreTarget === 'max') missChance = 0;

        if (missChance > 0 && Math.random() < missChance && qData.options.length > 1) {
          const alt = qData.options.map((_, i) => i).filter((i) => i !== chosenIdx);
          chosenIdx = alt[Math.floor(Math.random() * alt.length)];
          chosenText = qData.options[chosenIdx]?.text || '';
          if (log) log('info', `Câu ${qi + 1}: Cố tình chọn sai để đạt target "${config.scoreTarget} điểm"`);
        }

        // Click matching option in shadowRoot
        await page.evaluate(
          (targetIdx, targetText) => {
            const root = document.querySelector('default-root')?.shadowRoot;
            const quizX = root?.querySelector('type-quiz-x')?.shadowRoot;
            if (!quizX) return false;
            const optionEls = Array.from(quizX.querySelectorAll('.qselect'));
            let chosen = null;
            if (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < optionEls.length) {
              chosen = optionEls[targetIdx];
            }
            if (!chosen && targetText) {
              chosen = optionEls.find((el) => el.innerText.trim().toLowerCase().includes(targetText.toLowerCase()));
            }
            if (!chosen && optionEls.length > 0) chosen = optionEls[0];
            if (chosen) {
              chosen.click();
              return true;
            }
            return false;
          },
          chosenIdx,
          chosenText
        );

        await H.sleep(H.randInt(500, 1000));

        // Click #btn-done ("Kiểm tra đáp án")
        await page.evaluate(() => {
          const btn = document.getElementById('btn-done');
          if (btn && !btn.disabled) btn.click();
        });

        answeredCount++;
        await H.sleep(H.randInt(1200, 2000));
      }

      // All questions solved -> Submit exercise!
      if (log) log('info', `Đã trả lời ${answeredCount}/${questionCount} câu.`);

      // Check delay setting (nộp sau khoảng bao nhiêu phút)
      const delayMin = Number(config.submitDelayMinutes || 0);
      if (delayMin > 0) {
        if (log) log('info', `Chờ ${delayMin} phút trước khi nộp bài theo cấu hình...`);
        if (emit) emit('scheduled', { submitAt: new Date(Date.now() + delayMin * 60000).toISOString() });
        await H.sleep(delayMin * 60000);
      } else {
        await H.sleep(1500);
      }

      if (log) log('info', 'Bắt đầu nộp bài tự động...');

      // Click "Xác nhận nộp" button (.btn-submit-cate)
      const submitClicked = await page.evaluate(() => {
        const btn =
          document.querySelector('.btn-submit-cate') ||
          Array.from(document.querySelectorAll('button, a.btn')).find((b) =>
            /xác nhận nộp|nộp bài/i.test(b.innerText || '')
          );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (submitClicked) {
        if (log) log('info', 'Đã nhấn nút "Xác nhận nộp"');
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
        if (log) log('success', `Đã hoàn thành và nộp bài: ${homework.title}`);
        return { engine: 'browser', answered: answeredCount, submitted: true };
      }

      return { engine: 'browser', answered: answeredCount, submitted: false };
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