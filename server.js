'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const sessionStore = require('./src/session-store');
const licenseStore = require('./src/license-store');
const { OlmClient } = require('./src/olm-client');
const answerEngine = require('./src/answer-engine');
const browserEngine = require('./src/browser-engine');
const runner = require('./src/runner');
const H = require('./src/humanize');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin@olm888';

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id', 'X-License-Key', 'X-Device-HWID', 'X-Admin-Password', 'X-Admin-Token'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  '/api',
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 120),
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

function requireAdmin(req, res, next) {
  const token = req.get('X-Admin-Token') || req.get('X-Admin-Password') || req.query.adminKey || (req.body && req.body.adminKey);
  if (!token || token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mật khẩu quản trị không đúng hoặc chưa được cung cấp.', code: 'UNAUTHORIZED' });
  }
  next();
}

function requireLicense(req, res, next) {
  if (process.env.ENFORCE_LICENSE === 'false') {
    return next();
  }
  const key = req.get('X-License-Key') || req.query.licenseKey || (req.body && req.body.licenseKey);
  const hwid = req.get('X-Device-HWID') || req.query.hwid || (req.body && req.body.hwid);

  if (!key || !hwid) {
    return res.status(403).json({
      error: 'Yêu cầu kích hoạt bản quyền để sử dụng tính năng giải bài tập.',
      code: 'NO_LICENSE',
    });
  }

  const result = licenseStore.verify({ key, hwid });
  if (!result.ok || !result.valid) {
    return res.status(403).json({
      error: result.error || 'Bản quyền không hợp lệ hoặc đã hết hạn.',
      code: 'INVALID_LICENSE',
      expired: result.expired || false,
    });
  }

  req.license = result.license;
  next();
}

// ----------------------------------------------------------------- routes

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    engine: process.env.OLM_ENGINE || 'auto',
    browserAvailable: browserEngine.isAvailable(),
    openaiConfigured: answerEngine.hasKey(),
    model: answerEngine.currentModel(),
    provider: answerEngine.isOpenAiProvider() ? 'openai' : 'openai-compatible',
    fallbacks: answerEngine.providers().slice(1).map((p) => p.model),
    uptime: Math.round(process.uptime()),
  });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  }

  const uStr = String(username).trim();
  const pStr = String(password);

  try {
    const client = new OlmClient();
    let serializedJar = null;

    // 1. Try fast HTTP login first
    try {
      await client.login(uStr, pStr);
      serializedJar = client.serialize();
    } catch (httpErr) {
      console.warn(`[login] Fast HTTP login failed (${httpErr.message}), trying Browser login...`);

      // 2. Fallback to Browser login (Stealth Chrome bypasses Cloudflare 403)
      if (browserEngine.isAvailable()) {
        const browser = await browserEngine.launch();
        try {
          const { page, cookies } = await browserEngine.login(browser, {
            username: uStr,
            password: pStr,
            loginUrl: client.loginPageUrl,
            log: (lvl, msg) => console.log('[browser-login]', lvl, msg),
          });
          await page.close().catch(() => {});

          const { CookieJar } = require('tough-cookie');
          const jar = new CookieJar();
          for (const c of cookies || []) {
            const cookieStr = `${c.name}=${c.value}; Domain=${c.domain || 'olm.vn'}; Path=${c.path || '/'}`;
            await jar.setCookie(cookieStr, 'https://olm.vn').catch(() => {});
          }
          serializedJar = jar.toJSON();
        } finally {
          await browser.close().catch(() => {});
        }
      } else {
        throw httpErr;
      }
    }

    if (!serializedJar) {
      throw new Error('Đăng nhập không thành công');
    }

    const session = sessionStore.create(uStr, serializedJar, client.ua);
    res.json({
      ok: true,
      sessionId: session.id,
      username: session.username,
      message: 'Đăng nhập thành công',
    });
  } catch (err) {
    console.error('[login error]', err.message);
    let msg = err.message || 'Đăng nhập thất bại';
    if (/không chính xác|sai mật khẩu|sai tên/i.test(msg)) {
      msg = 'Tên đăng nhập hoặc mật khẩu OLM không chính xác.';
    }
    res.status(401).json({ error: msg });
  }
});

app.post('/api/login-cookie', async (req, res) => {
  const { cookie, cookieString } = req.body || {};
  const rawCookie = String(cookie || cookieString || '').trim();
  if (!rawCookie) {
    return res.status(400).json({ error: 'Vui lòng cung cấp chuỗi Cookie OLM' });
  }

  try {
    const { CookieJar } = require('tough-cookie');
    const jar = new CookieJar();
    const parts = rawCookie.split(';');
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed || !trimmed.includes('=')) continue;
      const [name, ...val] = trimmed.split('=');
      const cookieStr = `${name.trim()}=${val.join('=').trim()}; Domain=olm.vn; Path=/`;
      await jar.setCookie(cookieStr, 'https://olm.vn').catch(() => {});
    }

    const client = OlmClient.fromSerialized(jar.toJSON());
    // Verify cookie validity by checking homeworks or main page
    let username = 'Học sinh OLM';
    try {
      const { items } = await client.fetchHomeworks();
      if (items && items.length > 0 && items[0].author) {
        username = items[0].author;
      }
    } catch {
      const r = await client.request('GET', 'https://olm.vn', { timeout: 15000 });
      if (r.status >= 400 || (typeof r.data === 'string' && r.data.includes('/dangnhap') && !rawCookie.includes('onlinemath_session'))) {
        throw new Error('Cookie OLM không hợp lệ hoặc đã hết hạn.');
      }
    }

    const session = sessionStore.create(username, client.serialize(), client.ua);
    res.json({
      ok: true,
      sessionId: session.id,
      username: session.username,
      message: 'Đăng nhập bằng Cookie thành công!',
    });
  } catch (err) {
    console.error('[login-cookie error]', err.message);
    res.status(401).json({ error: err.message || 'Không thể đăng nhập bằng Cookie này' });
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

// --- License endpoints (Public) ---

app.post('/api/license/activate', (req, res) => {
  const { key, name, hwid, deviceInfo } = req.body || {};
  const result = licenseStore.activate({ key, name, hwid, deviceInfo });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/license/verify', (req, res) => {
  const { key, hwid } = req.body || {};
  const result = licenseStore.verify({ key, hwid });
  if (!result.ok || !result.valid) {
    return res.status(403).json(result);
  }
  res.json(result);
});

// --- Admin endpoints (Protected) ---

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Mật khẩu quản trị không đúng' });
  }
  res.json({ ok: true, token: ADMIN_PASSWORD, message: 'Đăng nhập thành công' });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.json({ ok: true, licenses: licenseStore.listAll() });
});

app.post('/api/admin/generate', requireAdmin, (req, res) => {
  const { name, type, notes } = req.body || {};
  try {
    const lic = licenseStore.createKey({ name, type, notes });
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/extend', requireAdmin, (req, res) => {
  const { key, days } = req.body || {};
  try {
    const lic = licenseStore.extendKey(key, days || 30);
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/reset-hwid', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  try {
    const lic = licenseStore.resetHwid(key);
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/delete', requireAdmin, (req, res) => {
  const { key } = req.body || {};
  try {
    const ok = licenseStore.deleteKey(key);
    res.json({ ok, message: 'Đã xóa key' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/admin/licenses/export', requireAdmin, (req, res) => {
  const data = licenseStore.exportAll();
  res.setHeader('Content-Disposition', `attachment; filename="olm_licenses_backup_${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ ok: true, count: Object.keys(data).length, licenses: data });
});

app.post('/api/admin/licenses/import', requireAdmin, (req, res) => {
  const { data, licenses: licList, merge = true } = req.body || {};
  try {
    const payload = data || licList;
    const result = licenseStore.importAll(payload, { merge: merge !== false });
    res.json({ ok: true, message: `Đã khôi phục thành công ${result.count} mã bản quyền!`, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Start a run over the selected homeworks.
app.post('/api/run', requireLicense, requireSession, async (req, res) => {
  const { homeworks, config } = req.body || {};
  if (!Array.isArray(homeworks) || homeworks.length === 0) {
    return res.status(400).json({ error: 'No homeworks selected' });
  }

  const cfg = {
    scoreTarget: config?.scoreTarget || 'high',
    submitWindow: config?.submitWindow || null,
    submitDelayMinutes: Number(config?.submitDelayMinutes || 0),
    aiBatchSize: Math.max(1, Math.min(12, Number(config?.aiBatchSize || process.env.AI_BATCH_SIZE || 6))),
    concurrency: Math.max(1, Math.min(6, Number(config?.concurrency || process.env.RUN_CONCURRENCY || 2))),
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
      phase: run.phase,
      progress: run.progress,
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
  console.log(`  openai      ${answerEngine.hasKey() ? 'configured' : 'MISSING OPENAI_API_KEY'}`);
  console.log(`  model       ${answerEngine.currentModel()} (${answerEngine.isOpenAiProvider() ? 'openai' : 'openai-compatible'})`);
  const fallbacks = answerEngine.providers().slice(1);
  if (fallbacks.length) {
    console.log(`  fallbacks   ${fallbacks.map((p) => p.model).join(', ')}`);
  }
  console.log('');
});