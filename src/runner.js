'use strict';

const { EventEmitter } = require('events');
const H = require('./humanize');
const answerEngine = require('./answer-engine');
const { parseQuestions, findSubmitInfo } = require('./question-parser');

const bus = new EventEmitter();
bus.setMaxListeners(200);

// Run state keyed by runId.
const runs = new Map();

function log(runId, level, message) {
  const entry = {
    ts: Date.now(),
    level, // info | warn | error | success
    message: String(message),
  };
  const run = runs.get(runId);
  if (run) {
    run.logs.push(entry);
    if (run.logs.length > 1000) run.logs.splice(0, run.logs.length - 1000);
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
    homeworks: homeworks.map((h) => ({ ...h, status: 'pending', result: null })),
    logs: [],
    config,
    submitAt: null,
  };
  runs.set(runId, run);

  log(runId, 'info', `Run started: ${homeworks.length} homework(s), target score "${config.scoreTarget}"`);
  emit(runId, 'started', { homeworks: run.homeworks.length });

  // Do the work in the background so the HTTP request returns immediately.
  (async () => {
    try {
      await executeRun(run, session, config);
      run.status = 'done';
      log(runId, 'success', 'Run finished');
      emit(runId, 'done', { status: 'done' });
    } catch (err) {
      run.status = 'error';
      log(runId, 'error', `Run failed: ${err.message}`);
      emit(runId, 'error', { message: err.message });
    }
  })();

  return run;
}

async function executeRun(run, session, config) {
  const H_speed = config.speed || 'normal';
  H.setSpeed(H.SPEEDS[H_speed] ? H.SPEEDS[H_speed].scale : 1);

  const { OlmClient } = require('./olm-client');
  const client = OlmClient.fromSerialized(session.cookieJar, session.ua);
  const browserEngine = require('./browser-engine');

  const useBrowser = config.engine === 'browser' || (config.engine === 'auto' && browserEngine.isAvailable());
  let browser = null;

  if (useBrowser) {
    log(run.id, 'info', 'Using browser automation engine');
    try {
      browser = await browserEngine.launch();
    } catch (err) {
      log(run.id, 'warn', `Browser launch failed (${err.message}); falling back to HTTP engine`);
      browser = null;
    }
  }

  const rateGuard = new H.RateGuard({ minGapMs: 2000 });
  const windowSpec = config.submitWindow || null;

  try {
    for (let hi = 0; hi < run.homeworks.length; hi++) {
      const hw = run.homeworks[hi];
      run.homeworks[hi].status = 'running';
      emit(run.id, 'homework-status', { index: hi, status: 'running', title: hw.title });

      log(run.id, 'info', `=== ${hw.title} ===`);

      if (browser) {
        try {
          const result = await browserEngine.solveHomework(browser, {
            homework: hw,
            session,
            config,
            log: (lvl, msg) => log(run.id, lvl, msg),
            emit: (type, payload) => emit(run.id, type, payload),
          });
          run.homeworks[hi].status = 'done';
          run.homeworks[hi].result = result;
          emit(run.id, 'homework-status', { index: hi, status: 'done' });
        } catch (err) {
          log(run.id, 'error', `Lỗi xử lý bài tập qua trình duyệt: ${err.message}`);
          run.homeworks[hi].status = 'error';
          run.homeworks[hi].result = { error: err.message };
          emit(run.id, 'homework-status', { index: hi, status: 'error', error: err.message });
        }
      } else {
        // HTTP engine fallback: fetch static page and submit form
        let questions;
        let html;
        try {
          html = await client.fetchHomeworkPage(hw.url);
          questions = parseQuestions(html, { url: hw.url });
          log(run.id, 'info', `Parsed ${questions.length} question(s)`);
        } catch (err) {
          log(run.id, 'error', `Could not read homework: ${err.message}`);
          run.homeworks[hi].status = 'error';
          run.homeworks[hi].result = { error: err.message };
          emit(run.id, 'homework-status', { index: hi, status: 'error', error: err.message });
          continue;
        }

        if (!questions.length) {
          log(run.id, 'warn', 'Không tìm thấy câu hỏi (dạng bài tương tác OLM yêu cầu Browser engine)');
          run.homeworks[hi].status = 'skipped';
          emit(run.id, 'homework-status', { index: hi, status: 'skipped' });
          continue;
        }

        const results = await answerEngine.solveAll(questions, {
          onProgress: (i, total, q) => {
            log(run.id, 'info', `Solving Q${i + 1}/${total}: ${String(q.text).slice(0, 70)}`);
            emit(run.id, 'progress', { index: i, total, question: String(q.text).slice(0, 120) });
          },
        });

        const plan = H.planWrongAnswers(questions, config.scoreTarget);
        const chosen = [];
        for (let qi = 0; qi < results.length; qi++) {
          const res = results[qi];
          const q = questions[qi];
          let chosenIndex = res.correctIndex;
          let chosenText = res.answer || '';
          let isWrong = false;

          if (res.ok && plan.wrongIndices.has(qi) && q.options.length > 1) {
            chosenIndex = q.plannedWrong;
            chosenText = q.options[chosenIndex];
            isWrong = true;
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
          log(run.id, 'info', `Nộp bài sau ${Math.round(waitMs / 1000)}s...`);
          const t = setTimeout(resolve, waitMs);
          if (t.unref) t.unref();
        });

        await rateGuard.waitForSlot();

        try {
          const res = await client.submitHomework(submitInfo.action, payload);
          const ok = res.status >= 200 && res.status < 400;
          log(run.id, ok ? 'success' : 'error', `Nộp bài hoàn tất (HTTP ${res.status})`);
          run.homeworks[hi].status = ok ? 'done' : 'error';
          run.homeworks[hi].result = { engine: 'http', status: res.status, action: submitInfo.action };
          emit(run.id, 'homework-status', { index: hi, status: ok ? 'done' : 'error' });
        } catch (err) {
          log(run.id, 'error', `Submit failed: ${err.message}`);
          run.homeworks[hi].status = 'error';
          run.homeworks[hi].result = { error: err.message };
          emit(run.id, 'homework-status', { index: hi, status: 'error', error: err.message });
        }
      }

      // Rest briefly between homeworks (3-5s)
      if (hi < run.homeworks.length - 1) {
        const rest = H.randInt(3000, 5000);
        log(run.id, 'info', `Nghỉ ${Math.round(rest / 1000)}s trước khi làm bài tiếp theo...`);
        emit(run.id, 'resting', { ms: rest });
        await new Promise((r) => setTimeout(r, rest));
      }
    }
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
      status: r.status,
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