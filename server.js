'use strict';

if (require.main === module) require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const sessionStore = require('./src/session-store');
const licenseStore = require('./src/license-store');
const shared = require('./src/deployment-store');
const sessions = shared.configured ? shared.sessions : sessionStore;
const licenses = shared.configured ? shared.licenses : licenseStore;
const { OlmClient, trustedOlmUrl } = require('./src/olm-client');
const answerEngine = require('./src/answer-engine');
const browserEngine = require('./src/browser-engine');
const runner = require('./src/runner');
runner.hookConsole();
const H = require('./src/humanize');
const tunnelManager = require('./src/tunnel');
const { startWorkerLoop } = require('./scripts/run-worker');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
}
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const get = (route, ...handlers) => app.get(route, ...handlers.map(wrap));
const post = (route, ...handlers) => app.post(route, ...handlers.map(wrap));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const adminSessions = new Map();
const ADMIN_TTL = 8 * 60 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const OLM_SESSION_COOKIE = 'giaiolm_session';
const ADMIN_SESSION_COOKIE = 'giaiolm_admin';

function readSessionCookie(req, name) {
  const prefix = name + '=';
  const value = req.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length);
  return /^[a-f0-9]{48,64}$/.test(value || '') ? value : undefined;
}

function sessionCookieOptions(req, path) {
  const isHttps = shared.configured || req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  const reqOrigin = req.get('Origin');
  const isCrossOrigin = Boolean(reqOrigin && reqOrigin !== getRequestOrigin(req));
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: (isHttps && isCrossOrigin) ? 'none' : 'lax',
    path,
  };
}

function adminSession(token) {
  if (shared.configured) return shared.adminSessions.get(token);
  const expires = adminSessions.get(token);
  if (expires > Date.now()) return true;
  adminSessions.delete(token);
  return false;
}

const allowedOrigins = (process.env.PUBLIC_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const allowVercelOrigins = process.env.ALLOW_VERCEL_ORIGINS === 'true';
const isVercelOrigin = (origin) => {
  if (!allowVercelOrigins || !origin) return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && u.hostname.endsWith('.vercel.app');
  } catch {
    return false;
  }
};
const isAllowedPublicOrigin = (origin) => !origin || allowedOrigins.includes(origin) || isVercelOrigin(origin);
const isHelperOrigin = (origin) => {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'olm.vn' || u.hostname.endsWith('.olm.vn'));
  } catch {
    return false;
  }
};
app.use('/api/helper', cors({
  origin: (origin, cb) => cb(null, !origin || isHelperOrigin(origin) || allowedOrigins.includes(origin) || isVercelOrigin(origin)),
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedPublicOrigin(origin)),
  credentials: true,
  exposedHeaders: ['Retry-After'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-License-Key', 'X-Device-HWID'],
}));
function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = (forwardedProto === 'https' || forwardedProto === 'http') ? forwardedProto : req.protocol;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.get('Host');
  return host ? `${proto}://${host}` : '';
}

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/helper/')) return next();
  const origin = req.get('Origin');
  const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const expectedOrigin = getRequestOrigin(req);
  const fallbackOrigin = req.protocol + '://' + req.get('Host');
  if (!safeMethod && origin && origin !== expectedOrigin && origin !== fallbackOrigin && !allowedOrigins.includes(origin) && !isVercelOrigin(origin)) {
    return res.status(403).json({ error: 'Nguồn yêu cầu không được phép.' });
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  '/api',
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 120),
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/ready',
    message: { error: 'Too many requests, slow down.' },
  })
);

app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// --------------------------------------------------------------- helpers

async function requireSession(req, res, next) {
  const token = readSessionCookie(req, OLM_SESSION_COOKIE);
  const session = await sessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'NO_SESSION' });
  }
  req.olmSession = session;
  next();
}

async function requireAdmin(req, res, next) {
  if (!(await adminSession(readSessionCookie(req, ADMIN_SESSION_COOKIE)))) {
    return res.status(401).json({ error: 'Phiên quản trị không hợp lệ hoặc đã hết hạn.', code: 'UNAUTHORIZED' });
  }
  next();
}

async function requireLicense(req, res, next) {
  if (process.env.ENFORCE_LICENSE === 'false') {
    return next();
  }
  const key = req.get('X-License-Key');
  const hwid = req.get('X-Device-HWID');
  const olmUsername = req.olmSession.username;

  if (!key || !hwid) {
    return res.status(403).json({
      error: 'Bắt buộc phải nhập và kích hoạt mã bản quyền (Key) trước khi sử dụng tính năng.',
      code: 'NO_LICENSE',
    });
  }

  const result = await licenses.verify({ key, olmUsername, hwid });
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

get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

get('/api/ready', async (_req, res) => {
  try {
    if (shared.configured) await shared.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

const upstreamSlots = Math.max(1, Math.min(40, Number(process.env.UPSTREAM_REQUEST_SLOTS) || 12));
let activeUpstream = 0;

function upstream(handler) {
  return async (req, res) => {
    if (activeUpstream >= upstreamSlots) {
      return res.set('Retry-After', '5').status(503).json({ error: 'Dịch vụ OLM đang bận. Vui lòng thử lại sau.' });
    }
    activeUpstream++;
    try {
      if (shared.configured) await proxyManager.refreshSharedProxy();
      return await handler(req, res);
    } finally {
      activeUpstream--;
    }
  };
}

get('/api/admin/tunnel', requireAdmin, (req, res) => {
  const url = tunnelManager.getUrl();
  res.json({ ok: true, active: !!url, url: url || null });
});

post('/api/login', upstream(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Thiếu tên đăng nhập hoặc mật khẩu' });
  }

  const uStr = String(username).trim();
  const pStr = String(password);

  try {
    const client = new OlmClient();
    let serializedJar = null;

    // 1. Thử đăng nhập nhanh HTTP với 2 lần thử (tự động thử lại nếu Cloudflare 520 / timeout tạm thời)
    let fastHttpSuccess = false;
    let lastHttpErr = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await client.login(uStr, pStr);
        serializedJar = client.serialize();
        fastHttpSuccess = true;
        break;
      } catch (httpErr) {
        lastHttpErr = httpErr;
        if (/sai tên|sai mật khẩu|không chính xác/i.test(httpErr.message)) {
          throw httpErr;
        }
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 600));
        }
      }
    }

    if (!fastHttpSuccess) {
      console.warn(`[login] Fast HTTP login failed (${lastHttpErr?.message}), trying Browser login...`);

      // 2. Fallback sang form đăng nhập Chromium khi HTTP gặp sự cố.
      if (!shared.configured && browserEngine.isAvailable()) {
        const browser = await browserEngine.launch();
        try {
          const { page, cookies } = await browserEngine.login(browser, {
            username: uStr,
            password: pStr,
            loginUrl: client.loginPageUrl,
            ua: client.ua,
            log: (lvl, msg) => console.log('[browser-login]', lvl, msg),
          });
          await page.close().catch(() => {});

          const { CookieJar } = require('tough-cookie');
          const jar = new CookieJar();
          for (const c of cookies || []) {
            const cookieStr = [`${c.name}=${c.value}`, `Domain=${c.domain || new URL(client.baseUrl).hostname}`,
              `Path=${c.path || '/'}`, c.secure && 'Secure', c.httpOnly && 'HttpOnly',
              c.expires > 0 && `Expires=${new Date(c.expires * 1000).toUTCString()}`].filter(Boolean).join('; ');
            await jar.setCookie(cookieStr, client.baseUrl).catch(() => {});
          }
          if (!(await jar.getCookies(client.baseUrl)).length) throw new Error('OLM không trả về cookie phiên hợp lệ.');
          serializedJar = jar.toJSON();
        } finally {
          await browser.close().catch(() => {});
        }
      } else {
        throw lastHttpErr;
      }
    }

    if (!serializedJar) {
      throw new Error('Đăng nhập không thành công');
    }

    const session = await sessions.create(uStr, serializedJar, client.ua);
    res.cookie(OLM_SESSION_COOKIE, session.id, { ...sessionCookieOptions(req, '/api'), maxAge: SESSION_TTL });
    res.json({
      ok: true,
      username: session.username,
      message: 'Đăng nhập thành công',
    });
  } catch (err) {
    console.error('[login error]', err.message);
    const invalidCredentials = /không chính xác|sai mật khẩu|sai tên/i.test(err.message);
    res.status(invalidCredentials ? 401 : 502).json({
      error: invalidCredentials ? 'Tên đăng nhập hoặc mật khẩu OLM không chính xác.' : 'Chưa kết nối được OLM. Vui lòng thử lại sau.',
    });
  }
}));

post('/api/logout', async (req, res) => {
  const id = readSessionCookie(req, OLM_SESSION_COOKIE);
  if (id && await sessions.get(id)) {
    if (shared.configured) await shared.jobs.stop(id);
    else runner.stopRunsForSession(id);
    await sessions.destroy(id);
  }
  res.clearCookie(OLM_SESSION_COOKIE, sessionCookieOptions(req, '/api'));
  res.json({ ok: true });
});

get('/api/session', requireSession, (req, res) => {
  res.json({ ok: true, username: req.olmSession.username });
});

get('/api/homeworks', requireSession, requireLicense, upstream(async (req, res) => {
  try {
    const client = OlmClient.fromSerialized(req.olmSession.cookieJar, req.olmSession.ua);
    const { items } = await client.fetchHomeworks();
    try {
      await sessions.updateCookies(req.olmSession.id, client.serialize(), client.ua, req.olmSession);
    } catch {}
    res.json({ ok: true, count: items.length, homeworks: items });
  } catch (err) {
    console.error('[homeworks]', err.message);
    if (err.code === 'NO_SESSION' || /hết hạn|chưa đăng nhập/i.test(err.message)) {
      return res.status(401).json({ error: 'Phiên OLM đã hết hạn. Vui lòng đăng nhập lại.', code: 'NO_SESSION' });
    }
    res.status(502).json({ error: 'Chưa tải được danh sách bài từ OLM. Vui lòng thử lại.' });
  }
}));

post('/api/answer', requireSession, requireLicense, upstream(async (req, res) => {
  const { question } = req.body || {};
  if (typeof question?.text !== 'string' || !question.text.trim() || question.text.length > 12000 || (question.options && !Array.isArray(question.options))) {
    return res.status(400).json({ error: 'Missing question' });
  }
  try {
    const solved = await answerEngine.solveQuestion({
      type: question.type,
      statements: question.statements,
      text: question.text,
      options: question.options || [],
      subject: question.subject || '',
    });
    res.json({ ok: true, ...solved });
  } catch (err) {
    console.error('[answer]', err.message);
    res.status(500).json({ error: 'Chưa xử lý được câu hỏi. Vui lòng thử lại.' });
  }
}));

// --- License endpoints ---

function customerLicense(result) {
  const { key, olmUsername, deviceName, type, durationDays, expiresAt, status, remainingText } = result.license;
  return { ...result, license: { key, olmUsername, deviceName, type, durationDays, expiresAt, status, remainingText } };
}

post('/api/license/activate', requireSession, async (req, res) => {
  const { key, hwid, deviceName, name } = req.body || {};
  const result = await licenses.activate({ key, olmUsername: req.olmSession.username, hwid, deviceName, name });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  // Đồng bộ thời gian thực sang Web Quản Lý (Bên B) và các client khác
  runner.emit('global', 'license-sync', { syncType: 'activated', key, license: result.license });
  res.json(customerLicense(result));
});

post('/api/license/verify', requireSession, async (req, res) => {
  const { key, hwid, deviceName } = req.body || {};
  const result = await licenses.verify({ key, olmUsername: req.olmSession.username, hwid, deviceName });
  if (!result.ok || !result.valid) {
    return res.status(403).json(result);
  }
  res.json(customerLicense(result));
});

const helperLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  keyGenerator: (req) => (req.body?.key ? 'k:' + String(req.body.key).trim().toUpperCase() : '') + '|' + req.ip,
  message: { ok: false, error: 'Quá nhiều yêu cầu xác thực tiện ích. Vui lòng thử lại sau 1 phút.' },
});

function isValidOlmUsername(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.\-+@]{2,64}$/.test(trimmed);
}

function isValidHwid(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_-]{8,128}$/.test(trimmed);
}

post('/api/helper/activate', helperLimiter, async (req, res) => {
  const { key, olmUsername, hwid, deviceName, name } = req.body || {};
  if (!isValidOlmUsername(olmUsername)) {
    return res.status(400).json({ ok: false, error: 'Tên tài khoản OLM không hợp lệ.' });
  }
  if (!isValidHwid(hwid)) {
    return res.status(400).json({ ok: false, error: 'Mã thiết bị (HWID) không hợp lệ.' });
  }
  const result = await licenses.activate({ key, olmUsername, hwid, deviceName, name });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  runner.emit('global', 'license-sync', { syncType: 'activated', key, license: result.license });
  res.json(customerLicense(result));
});

post('/api/helper/verify', helperLimiter, async (req, res) => {
  const { key, olmUsername, hwid, deviceName } = req.body || {};
  if (!isValidOlmUsername(olmUsername)) {
    return res.status(403).json({ ok: false, valid: false, error: 'Tên tài khoản OLM không hợp lệ.' });
  }
  if (!isValidHwid(hwid)) {
    return res.status(403).json({ ok: false, valid: false, error: 'Mã thiết bị (HWID) không hợp lệ.' });
  }
  const result = await licenses.verify({ key, olmUsername, hwid, deviceName });
  if (!result.ok || !result.valid) {
    return res.status(403).json(result);
  }
  res.json(customerLicense(result));
});

function serveHelperScript(req, res, asAttachment) {
  const helperPath = path.join(__dirname, 'olm_helper.user.js');
  if (!fs.existsSync(helperPath)) {
    return res.status(404).send('// olm_helper.user.js not found');
  }
  const hostOrigin = (process.env.HELPER_API_ORIGIN || getRequestOrigin(req)).replace(/\/+$/, '');
  const content = fs.readFileSync(helperPath, 'utf8').replace(/__OLM_HELPER_API_ORIGIN__/g, hostOrigin);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  if (asAttachment) {
    res.setHeader('Content-Disposition', 'attachment; filename="olm_helper.user.js"');
  }
  res.send(content);
}

app.get('/api/helper/download', (req, res) => serveHelperScript(req, res, true));
app.get('/olm_helper.user.js', (req, res) => serveHelperScript(req, res, false));

// --- Admin endpoints (Protected) ---

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Thử đăng nhập quá nhiều lần. Vui lòng đợi 15 phút.' },
});

post('/api/admin/login', adminLoginLimiter, async (req, res) => {
  const configured = process.env.ADMIN_PASSWORD;
  if (!configured) return res.status(503).json({ error: 'Máy chủ chưa cấu hình ADMIN_PASSWORD.' });
  const password = req.body?.password;
  if (typeof password !== 'string' || Buffer.byteLength(password) !== Buffer.byteLength(configured) ||
      !timingSafeEqual(Buffer.from(password), Buffer.from(configured))) {
    return res.status(401).json({ error: 'Mật khẩu quản trị không đúng' });
  }
  const token = randomBytes(32).toString('hex');
  if (shared.configured) await shared.adminSessions.add(token);
  else {
    for (const previous of adminSessions.keys()) adminSession(previous);
    adminSessions.set(token, Date.now() + ADMIN_TTL);
  }
  res.cookie(ADMIN_SESSION_COOKIE, token, { ...sessionCookieOptions(req, '/api/admin'), maxAge: ADMIN_TTL });
  res.json({ ok: true });
});

post('/api/admin/logout', requireAdmin, async (req, res) => {
  const token = readSessionCookie(req, ADMIN_SESSION_COOKIE);
  if (shared.configured) await shared.adminSessions.delete(token);
  else adminSessions.delete(token);
  res.clearCookie(ADMIN_SESSION_COOKIE, sessionCookieOptions(req, '/api/admin'));
  res.json({ ok: true });
});

get('/api/admin/session', requireAdmin, (_req, res) => res.json({ ok: true }));

get('/api/admin/licenses', requireAdmin, async (req, res) => {
  res.json({ ok: true, licenses: await licenses.listAll() });
});

post('/api/admin/generate', requireAdmin, async (req, res) => {
  const { name, days, type, notes } = req.body || {};
  try {
    const lic = await licenses.createKey({ name, days, type, notes });
    runner.emit('global', 'license-sync', { syncType: 'created', key: lic.key, license: lic });
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

post('/api/admin/extend', requireAdmin, async (req, res) => {
  const { key, days } = req.body || {};
  try {
    const lic = await licenses.extendKey(key, days || 30);
    runner.emit('global', 'license-sync', { syncType: 'extended', key, license: lic });
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

post('/api/admin/reset-hwid', requireAdmin, async (req, res) => {
  const { key } = req.body || {};
  try {
    const lic = await licenses.resetHwid(key);
    runner.emit('global', 'license-sync', { syncType: 'hwid-reset', key, license: lic });
    res.json({ ok: true, license: lic });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

post('/api/admin/unbind-olm', requireAdmin, async (req, res) => {
  const { key } = req.body || {};
  try {
    const lic = await licenses.unbindOlm(key);
    runner.emit('global', 'license-sync', { syncType: 'olm-unbound', key, license: lic });
    res.json({ ok: true, license: lic, message: 'Đã xóa liên kết tài khoản OLM cho key' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

post('/api/admin/delete', requireAdmin, async (req, res) => {
  const { key } = req.body || {};
  try {
    const ok = await licenses.deleteKey(key);
    runner.emit('global', 'license-sync', { syncType: 'deleted', key });
    res.json({ ok, message: 'Đã xóa key' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

post('/api/admin/clear-all', requireAdmin, async (req, res) => {
  try {
    await licenses.clearAll();
    res.json({ ok: true, message: 'Đã xóa toàn bộ danh sách bản quyền' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

get('/api/admin/licenses/export', requireAdmin, async (req, res) => {
  const data = await licenses.exportAll();
  res.setHeader('Content-Disposition', `attachment; filename="olm_licenses_backup_${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({ ok: true, count: Object.keys(data).length, licenses: data });
});

post('/api/admin/licenses/import', requireAdmin, async (req, res) => {
  const { data, licenses: licList, merge = true } = req.body || {};
  try {
    const payload = data || licList;
    const result = await licenses.importAll(payload, { merge: merge !== false });
    res.json({ ok: true, message: `Đã khôi phục thành công ${result.count} mã bản quyền!`, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Proxy Management Endpoints ---
const proxyManager = require('./src/proxy');

get('/api/admin/proxy', requireAdmin, async (req, res) => {
  await proxyManager.refreshSharedProxy();
  const current = proxyManager.getRuntimeProxy();
  const parsed = proxyManager.parseProxy();
  res.json({
    ok: true,
    enabled: !!current,
    proxy: parsed ? parsed.serverArg : null,
    info: parsed ? { protocol: parsed.protocol, host: parsed.host, port: parsed.port } : null,
  });
});

post('/api/admin/proxy', requireAdmin, async (req, res) => {
  const { proxyUrl } = req.body || {};
  const trimmed = proxyUrl ? String(proxyUrl).trim() : '';

  try {
    if (!trimmed) {
      await proxyManager.saveProxy('');
      return res.json({ ok: true, message: 'Đã tắt sử dụng Proxy' });
    }
    const testResult = await proxyManager.testProxy(trimmed);
    await proxyManager.saveProxy(trimmed);
    res.json({
      ok: true,
      message: `Đã kết nối và lưu Proxy thành công! IP: ${testResult.ip} (${testResult.latency}ms)`,
      ...testResult,
    });
  } catch (err) {
    res.status(400).json({ error: `Kiểm tra proxy thất bại: ${err.message}` });
  }
});

post('/api/admin/proxy/test', requireAdmin, async (req, res) => {
  const { proxyUrl } = req.body || {};
  try {
    const result = await proxyManager.testProxy(proxyUrl);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});


// Start a run over the selected homeworks.
post('/api/run', requireSession, requireLicense, async (req, res) => {
  const { homeworks, config } = req.body || {};
  if (!Array.isArray(homeworks) || !homeworks.length || homeworks.length > 30) {
    return res.status(400).json({ error: 'Chọn từ 1 đến 30 bài tập.' });
  }
  if (!shared.configured && runner.hasActiveRun(req.olmSession.id)) {
    return res.status(409).json({ error: 'Tài khoản đang có một tác vụ chạy.' });
  }
  if (!shared.configured && runner.countActiveRuns() >= 12) {
    return res.status(503).json({ error: 'Máy chủ đang xử lý quá nhiều tác vụ.' });
  }
  const limit = (value, fallback, max, min = 1) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
  };
  const cfg = {
    scoreTarget: config?.scoreTarget || 'high',
    submitWindow: config?.submitWindow || null,
    submitDelayMinutes: limit(config?.submitDelayMinutes, 0, 60, 0),
    aiBatchSize: limit(config?.aiBatchSize ?? process.env.AI_BATCH_SIZE, 6, 12),
    concurrency: limit(config?.concurrency ?? process.env.RUN_CONCURRENCY, 4, 10),
    speed: config?.speed || 'normal',
    engine: config?.engine || process.env.OLM_ENGINE || 'auto',
  };
  if (!['auto', 'browser', 'http'].includes(cfg.engine)) {
    return res.status(400).json({ error: 'Engine không hợp lệ.' });
  }
  let selected;
  try {
    selected = homeworks.map((hw) => ({
      id: String(hw.id ?? '').slice(0, 200),
      title: String(hw.title ?? '').slice(0, 500),
      url: trustedOlmUrl(hw.url),
      subject: String(hw.subject ?? '').slice(0, 200),
      categoryType: hw.categoryType,
      isDone: hw.isDone === true,
      canRetry: hw.canRetry,
      forceRedo: hw.forceRedo === true,
      score: hw.score,
      config: {
        scoreTarget: hw.config?.scoreTarget ?? cfg.scoreTarget,
        submitDelayMinutes: limit(hw.config?.submitDelayMinutes, cfg.submitDelayMinutes, 60, 0),
      },
    }));
  } catch {
    return res.status(400).json({ error: 'Chỉ chấp nhận URL bài tập OLM hợp lệ.' });
  }

  const { olmSession: session } = req;
  const run = shared.configured
    ? await shared.jobs.enqueue({
      session, homeworks: selected, config: cfg,
      license: { key: req.get('X-License-Key'), hwid: req.get('X-Device-HWID') },
    })
    : await runner.startRun({ session, homeworks: selected, config: cfg, sessionId: session.id });
  res.status(shared.configured ? 202 : 200).json({
    ok: true, runId: run.id, status: run.status, homeworks: run.homeworks.length,
  });
});

async function ownedRun(id, sessionId) {
  if (shared.configured) return shared.jobs.get(id, sessionId);
  const run = runner.getRun(id);
  return run?.sessionId === sessionId ? shared.runSnapshot(run) : null;
}

get('/api/run/:runId', requireSession, async (req, res) => {
  const run = await ownedRun(req.params.runId, req.olmSession.id);
  if (!run) return res.status(404).json({ error: 'Không tìm thấy tác vụ.' });
  res.json({ ok: true, run });
});

async function stopRun(req, res) {
  const id = req.params.runId || req.body?.runId;
  const { id: sessionId } = req.olmSession;
  if (id && !(await ownedRun(id, sessionId))) return res.status(404).json({ error: 'Không tìm thấy tác vụ.' });
  if (shared.configured) {
    const status = await shared.jobs.stop(sessionId, id);
    return res.json({ ok: true, stopped: status === 'stopped', requested: status === 'running' });
  }
  if (id) return res.json({ ok: true, stopped: runner.stopRun(id) });
  runner.stopRunsForSession(sessionId);
  res.json({ ok: true });
}

post('/api/run/:runId/stop', requireSession, stopRun);
post('/api/run/stop', requireSession, stopRun);

get('/api/runs', requireSession, async (req, res) => {
  const id = req.olmSession.id;
  const runs = shared.configured ? await shared.jobs.list(id) : runner.listRuns(id);
  res.json({ ok: true, runs });
});

// Scope each stream to its authenticated account or the admin license feed.
get('/api/events', requireSession, (req, res) => {
  if (shared.configured) return res.status(410).json({ error: 'Dùng API trạng thái tác vụ.' });
  const id = req.olmSession.id;
  streamEvents(res, () => Boolean(sessionStore.get(id)), event => runner.getRun(event.runId)?.sessionId === id);
});

get('/api/admin/events', requireAdmin, (req, res) => {
  if (shared.configured) return res.status(410).json({ error: 'Dùng API danh sách key.' });
  const token = readSessionCookie(req, ADMIN_SESSION_COOKIE);
  streamEvents(res, () => adminSession(token), event => event.type === 'license-sync');
});

function streamEvents(res, authorized, acceptsEvent) {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform, no-store',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  const write = (data) => {
    if (!res.writableEnded && !res.write(data)) res.end();
  };
  const unsubscribe = runner.subscribe((event) => {
    if (acceptsEvent(event) && authorized()) write('data: ' + JSON.stringify(event) + '\n\n');
  });
  const heartbeat = setInterval(() => {
    if (authorized()) write(': ping\n\n');
    else res.end();
  }, 4000);
  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

// Manual submit for a homework the user picked themselves.
post('/api/submit', requireSession, requireLicense, upstream(async (req, res) => {
  const { url, answers, formAction } = req.body || {};
  if (typeof url !== 'string' || !Array.isArray(answers) ||
      answers.some((answer) => !answer || typeof answer !== 'object')) {
    return res.status(400).json({ error: 'Bài tập hoặc đáp án không hợp lệ.' });
  }

  let pageUrl;
  try {
    pageUrl = trustedOlmUrl(url);
    if (formAction) trustedOlmUrl(formAction);
  } catch {
    return res.status(400).json({ error: 'Chỉ chấp nhận URL OLM hợp lệ.' });
  }
  try {
    const client = OlmClient.fromSerialized(req.olmSession.cookieJar, req.olmSession.ua);
    const html = await client.fetchHomeworkPage(pageUrl);
    const { findSubmitInfo } = require('./src/question-parser');
    const info = findSubmitInfo(html, pageUrl);
    if (!info.action || (formAction && trustedOlmUrl(formAction) !== info.action)) {
      return res.status(400).json({ error: 'Không xác định được form nộp bài OLM.' });
    }
    const payload = Object.assign(Object.create(null), info.fields);
    for (const answer of answers) {
      const name = answer.name || 'question_' + answer.id;
      if (!(name in info.fields)) payload[name] = answer.value ?? '';
    }
    const result = await client.submitHomework(info.action, payload, {
      method: info.method, homeworkUrl: pageUrl, originalHtml: html,
    });
    res.json({ ok: true, status: result.status });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}));

// --------------------------------------------------------------- fallback

app.use('/api', (_req, res) => res.status(404).json({ error: 'API không tồn tại.' }));

get('/quan-ly-key', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
get('*', (_req, res) => res.sendStatus(404));

// ----------------------------------------------------------------- start

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const busy = err.status === 503 || ['57014', '53300', '57P01', 'ECONNREFUSED'].includes(err.code);
  const status = busy ? 503 : err.status >= 400 && err.status < 500 ? err.status : 500;
  if (busy) res.set('Retry-After', '5');
  if (status === 500) console.error('[api]', err.code || err.message);
  res.status(status).json({
    error: status === 500 ? 'Lỗi máy chủ.' :
      status === 503 ? 'Máy chủ đang bận. Vui lòng thử lại sau.' : err.status === 409 ? err.message : 'Yêu cầu không hợp lệ.',
  });
});

module.exports = app;
if (require.main === module) {
  async function start() {
    await shared.init();
    if (!shared.configured) {
      sessionStore.load();
      setInterval(() => {
        sessionStore.sweep();
        runner.sweepRuns();
      }, 15 * 60 * 1000).unref();
    }
    const runEmbeddedWorker = shared.configured
      && process.env.EMBEDDED_WORKER !== 'false'
      && process.env.RUN_EMBEDDED_WORKER !== 'false';
    const embeddedWorker = runEmbeddedWorker ? await startWorkerLoop() : null;
    embeddedWorker?.done.catch((error) => {
      console.error('[embedded-worker]', error.message);
    });
    const server = app.listen(PORT, HOST, () => {
      const openHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST === '::' ? '::1' : HOST;
      const urlHost = openHost.includes(':') ? `[${openHost}]` : openHost;
      console.log(`Mở web trên máy này tại http://${urlHost}:${server.address().port}`);
      if (embeddedWorker) console.log('[embedded-worker] Worker loop started in-process.');
      if (!shared.configured && process.env.AUTO_TUNNEL === 'true') tunnelManager.start(PORT).catch(() => {});
    });
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      embeddedWorker?.stop();
      server.close(async () => {
        if (embeddedWorker) await embeddedWorker.done.catch(() => {});
        await shared.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 15000).unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }
  start().catch(async (error) => {
    console.error('[startup]', error.message);
    await shared.close();
    process.exitCode = 1;
  });
}
