'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('events');
const H = require('./humanize');
const answerEngine = require('./answer-engine');
const { parseQuestions, findSubmitInfo } = require('./question-parser');
const logger = require('./logger');

const bus = new EventEmitter();
bus.setMaxListeners(200);

// Run state keyed by runId.
const runs = new Map();

function log(runId, level, message, hwId = null) {
  const entry = {
    ts: Date.now(),
    level, // info | warn | error | success
    message: String(message),
    hwId: hwId ? String(hwId) : null,
    runId,
  };
  const run = runs.get(runId);
  if (run) {
    run.logs.push(entry);
    if (run.logs.length > 1000) run.logs.splice(0, run.logs.length - 1000);
    if (hwId) {
      const hw = run.homeworks.find((h) => String(h.id) === String(hwId));
      if (hw) {
        if (!hw.logs) hw.logs = [];
        hw.logs.push(entry);
        if (hw.logs.length > 300) hw.logs.splice(0, hw.logs.length - 300);
      }
    }
  }

  // Print to terminal with originalConsole to avoid re-intercepting
  logger.originalConsole.log(`[OLM][${(level || 'info').toUpperCase()}] ${message}`);

  // Broadcast to all SSE clients immediately with 0 delay
  logger.broadcast(entry);
}

function emit(runId, type, payload = {}) {
  bus.emit('run-event', { runId, type, ts: Date.now(), ...payload });
}

function subscribe(fn) {
  const onLog = (data) => fn({ ...data, type: 'log' });
  const onEvent = (data) => fn(data);
  logger.bus.on('log', onLog);
  bus.on('run-event', onEvent);
  return () => {
    logger.bus.off('log', onLog);
    bus.off('run-event', onEvent);
  };
}

// --------------------------------------------------------------- Scheduling

// Schedule a submit at a specific moment. The promise resolves when the
// deadline arrives; if the server restarts, pending schedules are restored
// from disk by the caller of loadPendingSchedules().
const timers = new Map();

function scheduleAt(runId, submitAt, fn) {
  const delay = Math.max(0, new Date(submitAt).getTime() - Date.now());
  const timer = setTimeout(async () => {
    timers.delete(runId);
    try {
      await fn();
    } catch (err) {
      log(runId, 'error', `Scheduled submit failed: ${err.message}`);
    }
  }, delay);
  if (timer.unref) timer.unref();
  timers.set(runId, timer);
  return delay;
}

function cancelSchedule(runId) {
  const t = timers.get(runId);
  if (t) {
    clearTimeout(t);
    timers.delete(runId);
  }
}

// ------------------------------------------------------------------- Runs

async function startRun({ session, homeworks, config, sessionId, runId = randomUUID() }) {
  const abortController = new AbortController();
  const run = {
    id: runId,
    sessionId,
    status: 'running',
    startedAt: Date.now(),
    abortController,
    _browser: null,
    homeworks: homeworks.map((h) => ({
      ...h,
      status: 'pending',
      result: null,
      logs: [],
      progress: { scanned: 0, solved: 0, filled: 0, failed: 0, total: 0 },
    })),
    logs: [],
    config,
    submitAt: null,
    phase: 'starting',
    progress: { scanned: 0, solved: 0, filled: 0, failed: 0, total: 0 },
  };
  runs.set(runId, run);

  const concurrency = Math.max(1, Math.min(10, Number(config.concurrency || Math.min(10, homeworks.length || 1))));
  log(runId, 'info', `Bắt đầu tiến trình: ${homeworks.length} bài tập, đa luồng: ${concurrency} bài/lúc`);
  emit(runId, 'started', { homeworks: run.homeworks.length, concurrency });

  // Do the work in the background so the HTTP request returns immediately.
  (async () => {
    try {
      const scale = H.SPEEDS[config.speed]?.scale ?? 1;
      await H.withSpeed(scale, () => executeRun(run, session, config));
      if (run.status !== 'stopped') {
        const done = run.homeworks.filter((hw) => hw.result?.submitted === true).length;
        run.status = done === run.homeworks.length ? 'done' : done ? 'partial' : 'error';
        run.phase = run.status;
        log(runId, run.status === 'done' ? 'success' : 'warn', 'Đã nộp ' + done + '/' + run.homeworks.length + ' bài.');
        if (run.status === 'error') emit(runId, 'error', { status: run.status });
        else emit(runId, 'done', { status: run.status, completed: done, total: run.homeworks.length });
      }
    } catch (err) {
      if (run.status !== 'stopped') {
        run.status = 'error';
        run.phase = 'error';
        log(runId, 'error', `Tiến trình gặp lỗi: ${err.message}`);
        emit(runId, 'error', { message: err.message });
      }
    } finally {
      run.finishedAt = Date.now();
      sweepRuns();
    }
  })();

  return run;
}

async function executeRun(run, session, config) {
  const signal = run.abortController.signal;
  const { OlmClient } = require('./olm-client');
  const browserEngine = require('./browser-engine');

  const useBrowser = config.engine === 'browser' || (config.engine === 'auto' && browserEngine.isAvailable());
  let browser = null;

  if (useBrowser) {
    log(run.id, 'info', 'Khởi tạo Browser automation engine...');
    try {
      browser = await browserEngine.launch();
      run._browser = browser;
    } catch (err) {
      if (config.engine === 'browser') throw err;
      log(run.id, 'warn', `Khởi tạo browser thất bại (${err.message}); chuyển sang HTTP engine`);
      browser = null;
    }
  }

  let browserEnabled = Boolean(browser);
  let relaunchPromise = null;
  async function ensureBrowserConnected() {
    if (!browserEnabled) return null;
    if (browser && (typeof browser.isConnected !== 'function' || browser.isConnected())) {
      return browser;
    }
    if (!relaunchPromise) {
      relaunchPromise = (async () => {
        log(run.id, 'warn', 'Browser đã ngắt kết nối; đang khởi tạo lại...');
        try { if (browser) await browser.close().catch(() => {}); } catch {}
        const next = await browserEngine.launch();
        browser = next;
        run._browser = next;
        return next;
      })().finally(() => {
        relaunchPromise = null;
      });
    }
    return relaunchPromise;
  }

  function normalizeUrl(u) {
    try {
      const parsed = new URL(String(u), 'https://olm.vn');
      parsed.hash = '';
      return parsed.href.replace(/\/+$/, '');
    } catch {
      return String(u || '').trim().replace(/\/+$/, '');
    }
  }

  const rateGuard = new H.RateGuard({ minGapMs: 1500 });
  const windowSpec = config.submitWindow || null;
  const concurrency = Math.max(1, Math.min(10, Number(config.concurrency || Math.min(10, run.homeworks.length))));

  async function processHomework(hi) {
    if (run.abortController?.signal?.aborted || run.status === 'stopped') return;
    const hw = run.homeworks[hi];
    const hwConfig = {
      ...config,
      ...(hw.config || {}),
      scoreTarget: (hw.config && hw.config.scoreTarget !== undefined) ? hw.config.scoreTarget : (config.scoreTarget || '10'),
      submitDelayMinutes: (hw.config && hw.config.submitDelayMinutes !== undefined) ? Number(hw.config.submitDelayMinutes) : Number(config.submitDelayMinutes || 0),
    };
    hw.status = 'running';
    emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'running', title: hw.title });
    log(run.id, 'info', `▶ Bắt đầu xử lý bài [${hi + 1}/${run.homeworks.length}]: "${hw.title}" [Mục tiêu: ${H.formatScoreTarget(hwConfig.scoreTarget)} | Hoãn nộp: ${hwConfig.submitDelayMinutes}p]`, hw.id);

    if (browserEnabled) {
      try {
        const activeBrowser = await ensureBrowserConnected();
        let result = await browserEngine.solveHomework(activeBrowser, {
          homework: hw,
          session,
          config: hwConfig,
          signal: run.abortController?.signal,
          log: (lvl, msg) => log(run.id, lvl, msg, hw.id),
          emit: (type, payload) => {
            if (type === 'scheduled') setSubmitTime(hw, new Date(payload.submitAt));
            if (payload?.phase) hw.phase = payload.phase;
            if (type === 'scan-complete') {
              hw.progress.scanned = payload.total || 0;
              hw.progress.total = payload.total ?? hw.progress.total;
            } else if (type === 'scan-progress') {
              hw.progress.scanned = payload.completed || 0;
              hw.progress.total = payload.total ?? hw.progress.total;
            } else if (type === 'solve-progress') {
              hw.progress.solved = payload.completed ?? payload.solved ?? 0;
              hw.progress.total = payload.total || hw.progress.total;
            } else if (type === 'fill-progress') {
              hw.progress.filled = payload.filled || 0;
              hw.progress.failed = payload.failed || 0;
              hw.progress.total = payload.total || hw.progress.total;
            }
            for (const key of Object.keys(run.progress)) {
              run.progress[key] = run.homeworks.reduce((sum, item) => sum + item.progress[key], 0);
            }
            emit(run.id, type, { ...payload, completed: payload.completed ?? payload.solved, index: hi, hwId: hw.id });
          },
        });

        if (signal.aborted) return;
        // Check the assigned work on OLM when the browser missed the receipt.
        // An older result cannot confirm an attempt to redo the assignment.
        if (result.submitted !== true && hw.id && hw.isDone === false && !hw.forceRedo) {
          const confirmationSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
          let receipt;
          try {
            const client = OlmClient.fromSerialized(session.cookieJar, session.ua);
            const { items } = await client.fetchHomeworks({ signal: confirmationSignal, coursewareOnly: true });
            receipt = items.find(item => item.id === String(hw.id) && item.isDone && normalizeUrl(item.url) === normalizeUrl(hw.url));
          } catch {}
          if (signal.aborted) return;
          if (receipt) {
            result = { ...result, phase: 'done', submitted: true, score: receipt.score ?? result.score };
            log(run.id, 'success', 'OLM xác nhận đã nộp bài trong danh sách bài được giao.', hw.id);
          }
        }
        hw.result = result;
        hw.status = (result.lockedRedo || result.alreadyCompleted) ? 'skipped' :
          result.submitted === true ? 'done' : 'error';
        const score = result.score != null ? ' - Điểm: ' + result.score : '';
        const unfilled = result.submitted === true && result.failed > 0 ? ` (${result.failed} câu chưa điền được)` : '';
        log(run.id, hw.status === 'done' ? 'success' : 'warn',
          (hw.status === 'skipped' ? 'Bỏ qua bài đã hoàn thành hoặc bị khóa: ' :
            result.submitted === true ? 'Đã nộp: ' : 'Chưa xác nhận nộp: ') + hw.title + score + unfilled, hw.id);
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: hw.status, title: hw.title, result });
      } catch (err) {
        if (signal.aborted) return;
        log(run.id, 'error', `✖ Lỗi bài "${hw.title}": ${err.message}`, hw.id);
        hw.status = 'error';
        hw.result = { error: err.message };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'error', error: err.message });
      }
    } else {
      // HTTP engine fallback
      const client = OlmClient.fromSerialized(session.cookieJar, session.ua);
      let questions;
      let html;
      try {
        html = await client.fetchHomeworkPage(hw.url, { signal });
        questions = parseQuestions(html, { url: hw.url });
        log(run.id, 'info', `Tìm thấy ${questions.length} câu hỏi`, hw.id);
      } catch (err) {
        log(run.id, 'error', `Không thể đọc bài tập: ${err.message}`, hw.id);
        hw.status = 'error';
        hw.result = { error: err.message };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'error', error: err.message });
        return;
      }

      if (!questions.length) {
        log(run.id, 'warn', 'Không tìm thấy câu hỏi (dạng bài tương tác OLM yêu cầu Browser engine)', hw.id);
        hw.status = 'skipped';
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'skipped' });
        return;
      }

      try {
        for (const question of questions) {
          const sources = [...new Set(question.imageSources || [])];
          if (question.needsBrowser || sources.length > 4) throw new Error('Dạng hình này cần bộ giải Chromium.');
          if (sources.length) {
            question.images = await Promise.all(sources.map(src => client.fetchQuestionImage(src, hw.url, signal)));
          }
        }
        const results = await answerEngine.solveAll(questions, {
          signal,
          onProgress: (i, total, q) => {
            log(run.id, 'info', `Giải câu ${i + 1}/${total}: ${String(q.text).slice(0, 70)}`, hw.id);
            emit(run.id, 'progress', { index: i, total, question: String(q.text).slice(0, 120), hwId: hw.id });
          },
        });

        const planQuestions = questions.map((q, i) => ({
          ...q,
          index: i,
          correctIndex: results[i]?.correctIndex ?? -1
        }));
        const plan = H.planWrongAnswers(planQuestions, hwConfig.scoreTarget);
        if (results.length !== questions.length) throw new Error('Chưa đủ đáp án cho tất cả câu hỏi.');
        const chosen = [];
        for (let qi = 0; qi < results.length; qi++) {
          const res = results[qi];
          const q = questions[qi];
          if (!res?.ok || res.unresolved) throw new Error('Chưa giải được câu ' + (qi + 1) + '.');
          let chosenIndex = res.correctIndex;
          let chosenText = res.answer || '';
          let isWrong = false;

          if (res.ok && plan.wrongIndices.has(qi)) {
            const wrong = plan.plannedWrongs?.get(qi);
            if (wrong) {
              chosenIndex = wrong.correctIndex;
              chosenText = wrong.answer || '';
              isWrong = true;
            }
          }

          chosen.push({
            index: qi,
            questionId: q.id,
            correctIndex: res.correctIndex,
            chosenIndex,
            chosenText,
            fillAnswers: !isWrong ? res.fillAnswers : null,
            chosenIndices: !isWrong ? res.correctIndices : null,
            isWrong,
            explanation: res.explanation || '',
          });
        }

        const submitInfo = findSubmitInfo(html, hw.url);
        if (!submitInfo.action) throw new Error('Không tìm thấy form nộp bài.');
        const payload = buildSubmitPayload(chosen, questions, submitInfo);
        const timing = H.resolveSubmitWindow(windowSpec);
        const submitAt = new Date(Math.max(timing.submitAt.getTime(), Date.now() + hwConfig.submitDelayMinutes * 60000));
        setSubmitTime(hw, submitAt);
        const wait = Math.max(0, submitAt.getTime() - Date.now());
        if (wait) {
          emit(run.id, 'scheduled', { submitAt, hwId: hw.id });
          await delay(wait, undefined, { signal });
        }
        await rateGuard.waitForSlot({ signal });
        const response = await client.submitHomework(submitInfo.action, payload, {
          method: submitInfo.method, signal, homeworkUrl: hw.url, originalHtml: html,
        });
        log(run.id, 'success', 'OLM xác nhận đã nộp bài.', hw.id);
        hw.status = 'done';
        hw.result = { engine: 'http', status: response.status, submitted: true };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: hw.status });
      } catch (err) {
        if (signal.aborted) return;
        log(run.id, 'error', `Tác vụ chưa hoàn tất: ${err.message}`, hw.id);
        hw.status = 'error';
        hw.result = { error: err.message };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'error', error: err.message });
      }
    }
  }

  function setSubmitTime(hw, time) {
    hw.submitAt = time;
    const pending = run.homeworks.map(item => item.submitAt?.getTime()).filter(time => Number.isFinite(time) && time >= Date.now());
    run.submitAt = pending.length ? new Date(Math.min(...pending)) : null;
  }

  try {
    const queue = Array.from({ length: run.homeworks.length }, (_, i) => i);
    const workerCount = Math.min(concurrency, run.homeworks.length);
    log(run.id, 'info', `🚀 Bắt đầu xử lý song song ${workerCount} bài cùng lúc...`);

    async function worker(workerId) {
      if (workerId > 0) {
        await new Promise((r) => setTimeout(r, workerId * 3500));
      }
      while (queue.length > 0) {
        if (run.abortController?.signal?.aborted || run.status === 'stopped') break;
        const hi = queue.shift();
        if (hi === undefined) break;
        try {
          await processHomework(hi);
        } finally {
          setSubmitTime(run.homeworks[hi], null);
        }
        if (run.abortController?.signal?.aborted || run.status === 'stopped') break;
        if (queue.length > 0) {
          const rest = H.randInt(800, 1500);
          await new Promise((r) => setTimeout(r, rest));
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, (_, wid) => worker(wid)));
  } finally {
    if (browser) await browser.close().catch(() => null);
    run._browser = null;
    if (signal.aborted) {
      for (const hw of run.homeworks) {
        if (hw.status === 'pending' || hw.status === 'running') hw.status = 'stopped';
      }
    }
  }
}

// Build the POST body the site expects from the answers we picked.
function buildSubmitPayload(chosen, questions, submitInfo) {
  const payload = Object.assign(Object.create(null), submitInfo.fields);
  const append = (name, value) => {
    payload[name] = name in payload ? [].concat(payload[name], value) : value;
  };
  for (const [i, q] of questions.entries()) {
    const answer = chosen[i];
    const name = q.name || 'question_' + q.id;
    if (q.type === 'short_answer') {
      const values = answer.fillAnswers?.length ? answer.fillAnswers : [answer.chosenText];
      if (!q.fieldNames?.length || values.length !== q.fieldNames.length || values.some(value => !value)) {
        throw new Error('Thiếu giá trị cho ô nhập ở câu ' + (i + 1) + '.');
      }
      for (const [index, field] of q.fieldNames.entries()) {
        const value = values[index];
        append(field, value);
      }
      continue;
    }
    if (!q.optionValues?.length) {
      if (q.options.length || !answer.chosenText) throw new Error('Form không có giá trị hợp lệ cho câu ' + (i + 1) + '.');
      append(name, answer.chosenText);
      continue;
    }
    const selected = answer.chosenIndices || [answer.chosenIndex];
    if (!selected.length || selected.some((index) => q.optionValues[index] === undefined)) {
      throw new Error('Đáp án ngoài phạm vi ở câu ' + (i + 1) + '.');
    }
    const values = selected.map((index) => q.optionValues[index]);
    append(name, q.type === 'multi_choice' ? values : values[0]);
  }
  return payload;
}

// ------------------------------------------------------------- Public API

function getRun(runId) {
  return runs.get(runId) || null;
}

function listRuns(sessionId) {
  return [...runs.values()]
    .filter((run) => run.sessionId === sessionId)
    .map((r) => ({
      id: r.id,
      status: r.status,
      phase: r.phase,
      progress: { ...r.progress },
      startedAt: r.startedAt,
      submitAt: r.submitAt,
      homeworks: r.homeworks.map((h) => ({ title: h.title, status: h.status })),
    }))
    .reverse()
    .slice(0, 30);
}

function stopRun(runId) {
  const run = runs.get(runId);
  if (!run || run.status !== 'running') return false;
  run.status = 'stopped';
  run.phase = 'stopped';
  cancelSchedule(runId);
  if (run.abortController) {
    try { run.abortController.abort(); } catch {}
  }
  if (run._browser) {
    try { run._browser.close().catch(() => {}); } catch {}
    run._browser = null;
  }
  log(runId, 'warn', '⏹ Tiến trình giải bài đã được dừng lại.');
  emit(runId, 'stopped', { status: 'stopped' });
  return true;
}

function stopRunsForSession(sessionId) {
  if (!sessionId) return;
  for (const [id, r] of runs) {
    if (r.sessionId === sessionId && r.status === 'running') {
      stopRun(id);
    }
  }
}

function sweepRuns() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const finished = [...runs.values()].filter((run) => run.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
  for (const [i, run] of finished.entries()) {
    if (run.finishedAt < cutoff || i < finished.length - 100) runs.delete(run.id);
  }
}

function hasActiveRun(sessionId) {
  return [...runs.values()].some((run) => !run.finishedAt && run.sessionId === sessionId);
}

function countActiveRuns() {
  return [...runs.values()].filter((run) => !run.finishedAt).length;
}

module.exports = {
  startRun,
  stopRun,
  stopRunsForSession,
  getRun,
  listRuns,
  hasActiveRun,
  countActiveRuns,
  sweepRuns,
  subscribe,
  emit,
  log,
  scheduleAt,
  cancelSchedule,
  runs,
  getRecentLogs: logger.getRecentLogs,
  hookConsole: logger.hookConsole,
};
