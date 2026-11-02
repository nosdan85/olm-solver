'use strict';

const { EventEmitter } = require('events');
const H = require('./humanize');
const answerEngine = require('./answer-engine');
const { parseQuestions, findSubmitInfo } = require('./question-parser');

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
  bus.emit('log', { runId, ...entry });
}

function emit(runId, type, payload = {}) {
  bus.emit('run-event', { runId, type, ts: Date.now(), ...payload });
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

async function startRun({ session, homeworks, config, sessionId }) {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const run = {
    id: runId,
    sessionId,
    status: 'running',
    startedAt: Date.now(),
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

  const concurrency = Math.max(1, Math.min(6, Number(config.concurrency || 2)));
  log(runId, 'info', `Bắt đầu tiến trình: ${homeworks.length} bài tập, mức điểm "${config.scoreTarget}", đa luồng: ${concurrency} bài/lúc`);
  emit(runId, 'started', { homeworks: run.homeworks.length, concurrency });

  // Do the work in the background so the HTTP request returns immediately.
  (async () => {
    try {
      await executeRun(run, session, config);
      run.status = 'done';
      run.phase = 'done';
      log(runId, 'success', `Đã hoàn thành toàn bộ ${homeworks.length} bài tập!`);
      emit(runId, 'done', { status: 'done' });
    } catch (err) {
      run.status = 'error';
      run.phase = 'error';
      log(runId, 'error', `Tiến trình gặp lỗi: ${err.message}`);
      emit(runId, 'error', { message: err.message });
    }
  })();

  return run;
}

async function executeRun(run, session, config) {
  const H_speed = config.speed || 'normal';
  H.setSpeed(H.SPEEDS[H_speed] ? H.SPEEDS[H_speed].scale : 1);

  const { OlmClient } = require('./olm-client');
  const browserEngine = require('./browser-engine');

  const useBrowser = config.engine === 'browser' || (config.engine === 'auto' && browserEngine.isAvailable());
  let browser = null;

  if (useBrowser) {
    log(run.id, 'info', 'Khởi tạo Browser automation engine...');
    try {
      browser = await browserEngine.launch();
    } catch (err) {
      log(run.id, 'warn', `Khởi tạo browser thất bại (${err.message}); chuyển sang HTTP engine`);
      browser = null;
    }
  }

  const rateGuard = new H.RateGuard({ minGapMs: 1500 });
  const windowSpec = config.submitWindow || null;
  const concurrency = Math.max(1, Math.min(6, Number(config.concurrency || 2)));

  async function processHomework(hi) {
    const hw = run.homeworks[hi];
    hw.status = 'running';
    emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'running', title: hw.title });
    log(run.id, 'info', `▶ Bắt đầu xử lý bài [${hi + 1}/${run.homeworks.length}]: "${hw.title}"`, hw.id);

    if (browser) {
      try {
        const result = await browserEngine.solveHomework(browser, {
          homework: hw,
          session,
          config,
          log: (lvl, msg) => log(run.id, lvl, msg, hw.id),
          emit: (type, payload) => {
            if (payload?.phase) hw.phase = payload.phase;
            if (type === 'scan-complete') {
              hw.progress.scanned = payload.total || 0;
              hw.progress.total = payload.total || 0;
            } else if (type === 'scan-progress') {
              hw.progress.scanned = payload.completed || 0;
              hw.progress.total = payload.total || 0;
            } else if (type === 'solve-progress') {
              hw.progress.solved = payload.completed || 0;
              hw.progress.total = payload.total || hw.progress.total;
            } else if (type === 'fill-progress') {
              hw.progress.filled = payload.filled || 0;
              hw.progress.failed = payload.failed || 0;
              hw.progress.total = payload.total || hw.progress.total;
            }
            emit(run.id, type, { ...payload, index: hi, hwId: hw.id });
          },
        });

        hw.result = result;
        hw.status = result.failed > 0 ? 'partial' : 'done';
        hw.snapshot = (result.questions || []).map((q) => ({ id: q.id, index: q.index, type: q.type, text: q.text, status: q.status }));
        log(run.id, 'success', `✔ Hoàn tất bài "${hw.title}" (Đã điền: ${result.filled}/${result.scanned} câu)`, hw.id);
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: hw.status, title: hw.title, result });
      } catch (err) {
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
        html = await client.fetchHomeworkPage(hw.url);
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

      const results = await answerEngine.solveAll(questions, {
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
      const plan = H.planWrongAnswers(planQuestions, config.scoreTarget);
      const chosen = [];
      for (let qi = 0; qi < results.length; qi++) {
        const res = results[qi];
        const q = questions[qi];
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
        } else if (!res.ok) {
          if (q.options.length > 1) {
            chosenIndex = Math.floor(Math.random() * q.options.length);
            chosenText = q.options[chosenIndex];
          }
        }

        chosen.push({
          index: qi,
          questionId: q.id,
          correctIndex: res.correctIndex,
          chosenIndex,
          chosenText,
          isWrong,
          explanation: res.explanation || '',
        });
      }

      const submitInfo = findSubmitInfo(html, hw.url);
      const payload = buildSubmitPayload(chosen, questions, submitInfo);

      const timing = H.resolveSubmitWindow(windowSpec);
      const submitAt = timing.submitAt;
      run.submitAt = submitAt;

      await new Promise((resolve) => {
        const waitMs = Math.max(0, submitAt.getTime() - Date.now());
        if (waitMs === 0) return resolve();
        log(run.id, 'info', `Nộp bài sau ${Math.round(waitMs / 1000)}s...`, hw.id);
        const t = setTimeout(resolve, waitMs);
        if (t.unref) t.unref();
      });

      await rateGuard.waitForSlot();

      try {
        const res = await client.submitHomework(submitInfo.action, payload);
        const ok = res.status >= 200 && res.status < 400;
        log(run.id, ok ? 'success' : 'error', `Nộp bài hoàn tất (HTTP ${res.status})`, hw.id);
        hw.status = ok ? 'done' : 'error';
        hw.result = { engine: 'http', status: res.status, action: submitInfo.action };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: hw.status });
      } catch (err) {
        log(run.id, 'error', `Submit failed: ${err.message}`, hw.id);
        hw.status = 'error';
        hw.result = { error: err.message };
        emit(run.id, 'homework-status', { index: hi, hwId: hw.id, status: 'error', error: err.message });
      }
    }
  }

  try {
    const queue = Array.from({ length: run.homeworks.length }, (_, i) => i);
    const workerCount = Math.min(concurrency, run.homeworks.length);
    log(run.id, 'info', `🚀 Bắt đầu xử lý song song ${workerCount} bài cùng lúc...`);

    async function worker(workerId) {
      while (queue.length > 0) {
        const hi = queue.shift();
        if (hi === undefined) break;
        await processHomework(hi);
        if (queue.length > 0) {
          const rest = H.randInt(1500, 3000);
          await new Promise((r) => setTimeout(r, rest));
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, (_, wid) => worker(wid)));
  } finally {
    if (browser) await browser.close().catch(() => null);
  }
}

// Build the POST body the site expects from the answers we picked.
function buildSubmitPayload(chosen, questions, submitInfo) {
  const payload = {};

  // Group answers by question name so radios/checkboxes get their own field.
  const byName = new Map();
  for (let i = 0; i < chosen.length; i++) {
    const q = questions[i];
    const c = chosen[i];
    if (q.name) {
      const existing = byName.get(q.name) || [];
      existing.push(c.chosenIndex);
      byName.set(q.name, existing);
    } else {
      payload[`question_${q.id}`] = c.chosenText ?? '';
    }
  }
  for (const [name, indices] of byName) {
    payload[name] = indices.length === 1 ? String(indices[0]) : indices.map(String);
  }

  payload['__questionCount'] = String(chosen.length);
  return payload;
}

// ------------------------------------------------------------- Public API

function getRun(runId) {
  return runs.get(runId) || null;
}

function listRuns() {
  return [...runs.values()]
    .map((r) => ({
      id: r.id,
      phase: r.phase,
      progress: { ...r.progress },
      startedAt: r.startedAt,
      submitAt: r.submitAt,
      homeworks: r.homeworks.map((h) => ({ title: h.title, status: h.status })),
    }))
    .reverse()
    .slice(0, 30);
}

function subscribe(handler) {
  bus.on('log', handler);
  bus.on('run-event', handler);
  return () => {
    bus.off('log', handler);
    bus.off('run-event', handler);
  };
}

module.exports = { startRun, getRun, listRuns, subscribe, log, scheduleAt, cancelSchedule, runs };