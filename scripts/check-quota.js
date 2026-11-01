'use strict';

// Checks the Gemini free-tier quota state for this API key.
//
// The Gemini API exposes no "current usage" endpoint, so the only way to read
// the real numbers is to make a request and read the 429 error body, which
// carries quotaId / quotaValue / dimensions / retryAfter.
//
// Usage: node scripts/check-quota.js [model ...]

require('dotenv').config();
const https = require('https');

const BASE = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const DEFAULT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
];

function post(model, key) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] });
    const req = https.request(
      new URL(BASE),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 45000,
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

// "66357s" | "18h25m57s" -> seconds
function parseDuration(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  const str = String(value);
  if (/^\d+(\.\d+)?s$/.test(str)) return parseFloat(str);
  const h = str.match(/(\d+)h/);
  const m = str.match(/(\d+)m/);
  const s = str.match(/(\d+(?:\.\d+)?)s/);
  if (!h && !m && !s) return 0;
  return (h ? +h[1] * 3600 : 0) + (m ? +m[1] * 60 : 0) + (s ? parseFloat(s[1]) : 0);
}

function describe(res) {
  if (res.status === 200) return { state: 'OK', detail: 'còn quota' };
  if (res.status === 0) return { state: 'TIMEOUT', detail: res.body };

  let err = {};
  try {
    const j = JSON.parse(res.body);
    err = (Array.isArray(j) ? j[0]?.error : j?.error) || {};
  } catch {
    return { state: `HTTP ${res.status}`, detail: res.body.slice(0, 160).replace(/\s+/g, ' ') };
  }

  const violation = (err.details || []).flatMap((d) => d.violations || [])[0] || {};
  const quotaId = violation.quotaId || '';
  // retryDelay comes back as a duration string like "66357s" (or "18h25m57s").
  const retryRaw = (err.details || []).find((d) => d.retryDelay)?.retryDelay;
  const retrySec = parseDuration(retryRaw);

  if (res.status === 429) {
    const perDay = /PerDay/i.test(quotaId) || /per day/i.test(err.message || '');
    const resetIn = retrySec
      ? `${Math.floor(retrySec / 3600)}h${String(Math.round((retrySec % 3600) / 60)).padStart(2, '0')}m`
      : '?';
    return {
      state: perDay ? 'HẾT (ngày)' : 'HẾT (phút)',
      detail: `${violation.quotaValue ?? '?'} req/${perDay ? 'ngày' : 'phút'}`,
      quotaId,
      resetIn,
    };
  }
  if (res.status === 404) return { state: 'KHÔNG CÓ', detail: (err.message || '').slice(0, 120) };
  if (res.status === 401 || res.status === 403) return { state: 'SAI KEY', detail: (err.message || '').slice(0, 120) };
  return { state: `HTTP ${res.status}`, detail: (err.message || res.body).slice(0, 160).replace(/\s+/g, ' ') };
}

(async () => {
  // The Gemini key lives in FALLBACK_API_KEY when the primary provider is
  // OpenAI/opencode zen; fall back to OPENAI_API_KEY for a Gemini-only setup.
  const key = process.env.FALLBACK_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) {
    console.error('Thiếu FALLBACK_API_KEY (hoặc OPENAI_API_KEY) trong .env');
    process.exit(1);
  }

  const models = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_MODELS;
  console.log(`\n  Kiểm tra quota Gemini free tier — key: ${key.slice(0, 8)}...\n`);

  for (const model of models) {
    let d = { state: 'LỖI', detail: '' };
    // A timeout means "unknown", not "no quota" — retry before drawing a conclusion.
    for (let attempt = 0; attempt < 3; attempt++) {
      d = describe(await post(model, key));
      if (d.state !== 'TIMEOUT') break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const line = `  ${model.padEnd(26)} ${d.state.padEnd(16)} ${d.detail}`;
    console.log(d.resetIn ? `${line}   reset ~${d.resetIn}` : line);
  }
  console.log('');
})();