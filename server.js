'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const sessionStore = require('./src/session-store');
const { OlmClient } = require('./src/olm-client');
const answerEngine = require('./src/answer-engine');
const browserEngine = require('./src/browser-engine');
const runner = require('./src/runner');
const H = require('./src/humanize');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  '/api',
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' },
  })
);

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// --------------------------------------------------------------- helpers

function requireSession(req, res, next) {
  const token = req.get('X-Session-Id') || req.query.sessionId || (req.body && req.body.sessionId);
  const session = sessionStore.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'NO_SESSION' });
  }
  req.olmSession = session;
  req.olmClient = OlmClient.fromSerialized(session.cookieJar, session.ua);
  next();
}

// ----------------------------------------------------------------- routes

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    engine: process.env.OLM_ENGINE || 'auto',
    browserAvailable: browserEngine.isAvailable(),
    openaiConfigured: answerEngine.hasKey(),
    uptime: Math.round(process.uptime()),
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Missing username or password' });
  }

  try {
    const client = new OlmClient();
    await client.login(String(username), String(password));
    const session = sessionStore.create(String(username), client.serialize(), client.ua);
    res.json({
      ok: true,
      sessionId: session.id,
      username: session.username,
      message: 'Logged in',
    });
  } catch (err) {
    console.error('[login]', err.message);
    res.status(401).json({ error: err.message || 'Login failed' });
  }
});

app.post('/api/logout', requireSession, (req, res) => {
  sessionStore.destroy(req.olmSession.id);
  res.json({ ok: true });
});

app.get('/api/session', requireSession, (req, res) => {
  res.json({ ok: true, username: req.olmSession.username, createdAt: req.olmSession.createdAt });
});

app.get('/api/homeworks', requireSession, async (req, res) => {
  try {
    const { url, items } = await req.olmClient.fetchHomeworks();
    res.json({ ok: true, source: url, count: items.length, homeworks: items });
  } catch (err) {
    console.error('[homeworks]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/answer', async (req, res) => {
  const { question } = req.body || {};
  if (!question || !question.text) {
    return res.status(400).json({ error: 'Missing question' });
  }
  try {
    const solved = await answerEngine.solveQuestion({
      text: question.text,
      options: question.options || [],
      subject: question.subject || '',
    });
    res.json({ ok: true, ...solved });
  } catch (err) {
    console.error('[answer]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start a run over the selected homeworks.
app.post('/api/run', requireSession, async (req, res) => {
  const { homeworks, config } = req.body || {};
  if (!Array.isArray(homeworks) || homeworks.length === 0) {
    return res.status(400).json({ error: 'No homeworks selected' });
  }

  const cfg = {
    scoreTarget: config?.scoreTarget || 'high',
    submitWindow: config?.submitWindow || null,
    speed: config?.speed || 'normal',
    engine: config?.engine || process.env.OLM_ENGINE || 'auto',
  };

  try {
    const run = await runner.startRun({
      session: req.olmSession,
      homeworks,
      config: cfg,
      sessionId: req.olmSession.id,
    });
    res.json({ ok: true, runId: run.id, homeworks: run.homeworks.length });
  } catch (err) {
    console.error('[run]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/run/:runId', (req, res) => {
  const run = runner.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    ok: true,
    run: {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      submitAt: run.submitAt,
      homeworks: run.homeworks,
      logs: run.logs.slice(-200),
    },
  });
});

app.get('/api/runs', (req, res) => {
  res.json({ ok: true, runs: runner.listRuns() });
});

// Server-sent events stream for the live log tab.
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      /* client vanished */
    }
  };

  const unsub = runner.subscribe(send);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(ping);
    unsub();
  });
});

// Manual submit for a homework the user picked themselves.
app.post('/api/submit', requireSession, async (req, res) => {
  const { url, answers, formAction } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing homework url' });

  try {
    const html = await req.olmClient.fetchHomeworkPage(url);
    const { findSubmitInfo } = require('./src/question-parser');
    const info = findSubmitInfo(html, url);
    const action = formAction || info.action;

    const payload = {};
    for (const a of answers || []) {
      payload[a.name || `question_${a.id}`] = a.value ?? '';
    }

    const result = await req.olmClient.submitHomework(action, payload);
    res.json({ ok: true, status: result.status, action });
  } catch (err) {
    console.error('[submit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------- fallback

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ----------------------------------------------------------------- start

sessionStore.load();
setInterval(() => sessionStore.sweep(), 15 * 60 * 1000).unref();

app.listen(PORT, HOST, () => {
  console.log(`\n  OLM solver backend`);
  console.log(`  listening   http://${HOST}:${PORT}`);
  console.log(`  browser     ${browserEngine.isAvailable() ? 'available' : 'not installed (HTTP engine only)'}`);
  console.log(`  openai      ${answerEngine.hasKey() ? 'configured' : 'MISSING OPENAI_API_KEY'}\n`);
});