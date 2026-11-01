'use strict';

const https = require('https');

// Cache providers that hit permanent errors (401 invalid key, 404, or 429 daily quota)
// so subsequent questions don't waste 20-30s retrying dead providers.
const disabledProviders = new Map();

function disableProvider(provider, reason) {
  if (!provider) return;
  const key = `${provider.baseUrl}::${provider.model}`;
  disabledProviders.set(key, { at: Date.now(), reason });
  console.log(`[answer-engine] Tạm ngưng provider "${provider.model}" (${provider.baseUrl}): ${reason}`);
}

function isProviderDisabled(provider) {
  const key = `${provider.baseUrl}::${provider.model}`;
  const info = disabledProviders.get(key);
  if (!info) return false;
  // Re-check after 20 minutes
  if (Date.now() - info.at > 20 * 60 * 1000) {
    disabledProviders.delete(key);
    return false;
  }
  return true;
}

// A provider is a (baseUrl, model, apiKey) triple. The first entry is primary;
// the rest are used automatically when a provider is out of quota or errors.
// FALLBACK_MODELS is a comma-separated list so several models can share one
// key (e.g. Gemini free tier, where each model has its own daily quota).
function providers() {
  const list = [];

  const primary = {
    baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
    model: process.env.OPENAI_MODEL || 'gemini-3.8-flash',
    apiKey: process.env.OPENAI_API_KEY || '',
    authHeader: (process.env.OPENAI_AUTH_HEADER || 'bearer').toLowerCase(),
    name: 'primary',
  };
  list.push(primary);

  if (process.env.FALLBACK_BASE_URL) {
    const base = process.env.FALLBACK_BASE_URL.trim().replace(/\/+$/, '');
    const key = process.env.FALLBACK_API_KEY || '';
    const authHeader = (process.env.FALLBACK_AUTH_HEADER || 'bearer').toLowerCase();
    const models = (process.env.FALLBACK_MODELS || process.env.FALLBACK_MODEL || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);

    models.forEach((model, i) => {
      list.push({ baseUrl: base, model, apiKey: key, authHeader, name: `fallback${i + 1}` });
    });
  }

  // Filter out empty keys, dummy keys, and providers that failed permanently
  return list.filter((p) => p.apiKey && !/PASTE_/.test(p.apiKey) && !isProviderDisabled(p));
}

function apiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function hasKey() {
  return providers().length > 0;
}

// The model actually in use. Gemini 3.8 Flash is the default: it handles both
// text and the vision screenshots the browser engine captures.
function currentModel() {
  return providers()[0]?.model || process.env.OPENAI_MODEL || 'gemini-3.8-flash';
}

// True when the configured base URL points at OpenAI itself rather than an
// OpenAI-compatible gateway (Gemini, Groq, OpenRouter...). The GPT-5/6 series
// needs a different payload shape than the Gemini OpenAI-compat endpoint.
// opencode zen proxies OpenAI models, so it needs the same payload shape.
function isOpenAiProvider(baseUrl) {
  const base = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').toLowerCase();
  return base.includes('api.openai.com') || base.includes('opencode.ai');
}

// Some gateways (e.g. opencode zen) expect the key in an 'x-api-key' header
// instead of 'Authorization: Bearer'.
function authHeaders(provider) {
  const p = provider || providers()[0];
  if (p.authHeader === 'x-api-key') {
    return { 'x-api-key': p.apiKey };
  }
  return { Authorization: `Bearer ${p.apiKey}` };
}

// GPT-5/6 series models reason by default, which adds latency and output
// tokens on every question. 'none' keeps answers fast for a 60-question run.
function reasoningEffort() {
  const v = process.env.OPENAI_REASONING_EFFORT;
  return v || 'none';
}

// Claude models on zen expose 'effort' rather than 'reasoning_effort', and
// reject 'temperature' entirely (capabilities.temperature = false).
function isClaudeModel(model) {
  return /claude/i.test(model || '');
}

// Builds the request body. Each provider family takes a different payload
// shape, so this branches on the target model rather than on the URL.
function buildPayload(userMessageContent, provider) {
  const p = provider || providers()[0];
  const payload = {
    model: p.model,
    messages: [{ role: 'user', content: userMessageContent }],
  };

  if (isClaudeModel(p.model)) {
    // Claude: no temperature, no response_format; use 'effort' + max_tokens.
    // Claude's effort levels are low|medium|high|xhigh|max - there is no 'none'.
    const effort = process.env.OPENAI_REASONING_EFFORT;
    payload.effort = !effort || effort === 'none' ? 'low' : effort;
    payload.max_tokens = Number(process.env.OPENAI_MAX_TOKENS) || 2048;
  } else if (isOpenAiProvider(p.baseUrl)) {
    payload.reasoning_effort = reasoningEffort();
    // JSON mode makes the model return a bare JSON object, so the parser
    // stops having to fish for the first '{' in a prose answer.
    // Some reasoning models reject json mode -> disable via OPENAI_JSON_MODE=0.
    if (process.env.OPENAI_JSON_MODE !== '0') {
      payload.response_format = { type: 'json_object' };
    }
    payload.max_completion_tokens = Number(process.env.OPENAI_MAX_TOKENS) || 2048;
  } else {
    payload.temperature = 0.1;
  }

  return payload;
}

function callAi(payload, { timeoutMs = 60000, provider } = {}) {
  const p = provider || providers()[0];
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${p.baseUrl}/chat/completions`);
    const data = JSON.stringify(payload);
    const req = https.request(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...authHeaders(p),
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Failed to parse AI response: ${body.slice(0, 200)}`));
          }
        } else {
          // Surface the provider's own message (quota, auth, model not found)
          // instead of a raw status code that hides the cause.
          let message = body.slice(0, 300);
          try {
            const parsed = JSON.parse(body);
            const errNode = Array.isArray(parsed) ? parsed[0]?.error : parsed?.error;
            message = errNode?.message || message;
          } catch {
            /* keep raw body */
          }
          const err = new Error(`AI HTTP ${res.statusCode}: ${message}`);
          err.status = res.statusCode;
          err.providerBody = body.slice(0, 2000);
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`AI request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Ask the model to solve one question (supports Vision screenshot, True/False, Short Answer, Choice).
async function solveQuestion(question, { retries = 1, onLog } = {}) {
  if (!hasKey()) {
    const err = new Error('OPENAI_API_KEY is not set on the server');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const allProviders = providers();
  if (allProviders.length === 0) {
    const err = new Error('Không còn AI model nào khả dụng hoặc tất cả model đã hết quota');
    err.code = 'ALL_PROVIDERS_EXHAUSTED';
    throw err;
  }
  let lastErr;

  const prompt = buildPrompt(question);

  // Build message content (text or multimodal with image_url)
  let userMessageContent = prompt;
  if (question.imageBase64) {
    userMessageContent = [
      { type: 'text', text: prompt },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${question.imageBase64}`,
        },
      },
    ];
  }

  // Walk the provider list: retry the current one, and on a quota/auth failure
  // permanently disable it for this run and move on immediately.
  for (let pi = 0; pi < allProviders.length; pi++) {
    const provider = allProviders[pi];
    const isLastProvider = pi === allProviders.length - 1;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (onLog && attempt === 0 && pi === 0) {
          onLog('info', `🤖 Đang gửi AI (${provider.model})...`);
        }
        const res = await callAi(
          buildPayload(userMessageContent, provider),
          { timeoutMs: question.imageBase64 ? 45000 : 30000, provider }
        );

        const content = res?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty model response');

        const parsed = parseModelJson(content);
        const options = question.options || [];
        let correctIndex = -1;

        if (question.type === 'true_false' || Array.isArray(question.statements)) {
          // Parse array of booleans for True/False statements
          let statements = [];
          if (Array.isArray(parsed.statements)) {
            statements = parsed.statements.map(s => {
              if (typeof s === 'boolean') return s;
              if (typeof s === 'object' && s !== null) return Boolean(s.isTrue ?? s.answer ?? true);
              return String(s).toLowerCase().startsWith('đ') || String(s).toLowerCase().startsWith('t');
            });
          }
          return {
            statements,
            answer: parsed.answer || '',
            explanation: parsed.explanation || '',
            kind: 'true_false',
            model: provider.model,
            raw: content,
          };
        }

        if (options.length > 0) {
          correctIndex = normalizeIndex(parsed.correctIndex ?? parsed.index ?? parsed.answer, options.length);
          if (correctIndex < 0) {
            // Model answered with the option text instead of an index.
            correctIndex = options.findIndex((o) =>
              String(o).trim().toLowerCase() === String(parsed.answer || '').trim().toLowerCase()
            );
          }
        }

        return {
          correctIndex,
          answer: parsed.answer ?? (correctIndex >= 0 ? options[correctIndex] : ''),
          explanation: parsed.explanation || '',
          kind: options.length > 0 ? 'choice' : (question.type || 'text'),
          model: provider.model,
          raw: content,
        };
      } catch (err) {
        lastErr = err;
        const status = err.status || err.response?.status;
        // Quota/rate-limit (429) is worth retrying unless daily quota exhausted.
        if (status && status >= 400 && status < 500 && status !== 429) {
          disableProvider(provider, `HTTP ${status}: ${err.message}`);
          if (onLog) onLog('warn', `⚠️ Model ${provider.model} lỗi (${err.message}), bỏ qua provider này.`);
          break;
        }
        if (status === 429 && /quota.*(day|per day)|exceeded your current quota/i.test(err.message || '')) {
          err.quotaExhausted = true;
          disableProvider(provider, `Hết quota ngày: ${err.message}`);
          if (onLog) onLog('warn', `⚠️ Model ${provider.model} hết quota ngày. Chuyển sang model dự phòng...`);
          break;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // This provider is unusable, fail over to the next
    if (!isLastProvider) {
      lastErr.providerModel = provider.model;
      continue;
    }
    break;
  }

  throw lastErr || new Error('Failed to get an answer from the model');
}

function buildPrompt(question) {
  const options = question.options || [];
  const lines = [];
  lines.push(`Môn học: ${question.subject || 'Toán/Lý/Hóa/Sinh/Sử/Địa/Văn'}`);
  lines.push(`Câu hỏi: ${question.text || '(Xem nội dung trong hình ảnh chụp màn hình kèm theo)'}`);

  if (question.imageBase64) {
    lines.push('(Lưu ý: Câu hỏi hoặc sơ đồ/công thức được đính kèm trong ảnh chụp màn hình, hãy quan sát kỹ ảnh để giải).');
  }

  if (question.type === 'true_false' || (question.statements && question.statements.length > 0)) {
    lines.push('\nĐây là dạng câu hỏi Đúng/Sai với các mệnh đề:');
    (question.statements || []).forEach((st, i) => {
      lines.push(`  [${String.fromCharCode(97 + i)}] ${st}`);
    });
    lines.push('\nHãy xác định từng mệnh đề là Đúng (true) hay Sai (false).');
    lines.push('Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"statements": [true, false, true, false], "explanation": "<giải thích ngắn>"}');
    return lines.join('\n');
  }

  if (options.length > 0) {
    lines.push('\nCác lựa chọn đáp án:');
    options.forEach((o, i) => lines.push(`  [${i}] ${o}`));
    lines.push('');
    lines.push(
      'Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng: ' +
        '{"correctIndex": <số thứ tự đáp án đúng từ 0 đến ' + (options.length - 1) + '>, "answer": "<ngắn gọn>", "explanation": "<giải thích ngắn>"}'
    );
  } else {
    lines.push('');
    lines.push(
      'Đây là câu hỏi trả lời ngắn/tự luận/điền số. ' +
      'Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng: ' +
        '{"answer": "<con số hoặc đáp án ngắn gọn nhất>", "explanation": "<giải thích ngắn>"}'
    );
  }
  return lines.join('\n');
}

function parseModelJson(content) {
  let text = String(content).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {
        /* fall through */
      }
    }
    return { answer: text };
  }
}

function buildBatchPrompt(questions) {
  const lines = [
    'Giải các câu hỏi dưới đây. Mỗi câu có một ID duy nhất.',
    'Trả về DUY NHẤT JSON hợp lệ dạng: {"answers":[{"id":"q_1","correctIndex":0,"answer":"...","statements":[true],"explanation":"..."}]}',
    'Không bỏ qua câu nào. Giữ nguyên chính xác ID được cung cấp.',
  ];

  for (const q of questions) {
    lines.push(`\\nID: ${q.id}`);
    lines.push(`Môn học: ${q.subject || ''}`);
    lines.push(`Câu hỏi: ${q.text || '(xem nội dung đã cung cấp)'}`);
    if (q.type === 'true_false' || Array.isArray(q.statements)) {
      lines.push('Mệnh đề Đúng/Sai:');
      (q.statements || []).forEach((s, i) => lines.push(`  [${i}] ${s}`));
    } else if (Array.isArray(q.options) && q.options.length) {
      lines.push('Lựa chọn:');
      q.options.forEach((o, i) => lines.push(`  [${i}] ${o}`));
    } else {
      lines.push('Dạng trả lời ngắn/tự luận.');
    }
  }
  return lines.join('\n');
}

function validateBatchAnswers(parsed, questions) {
  if (!parsed || !Array.isArray(parsed.answers)) {
    throw new Error('Batch response must contain an answers array');
  }
  const byId = new Map(questions.map((q) => [String(q.id), q]));
  const seen = new Set();
  const answers = [];
  for (const item of parsed.answers) {
    const id = String(item?.id || '');
    if (!byId.has(id)) throw new Error(`Batch response contains unknown question ID: ${id}`);
    if (seen.has(id)) throw new Error(`Batch response contains duplicate question ID: ${id}`);
    seen.add(id);
    const q = byId.get(id);
    const result = {
      id,
      correctIndex: -1,
      answer: item.answer ?? '',
      statements: Array.isArray(item.statements) ? item.statements.map((value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'object' && value !== null) return Boolean(value.isTrue ?? value.answer);
        const text = String(value).toLowerCase();
        return text.startsWith('đ') || text.startsWith('t') || text === 'true';
      }) : undefined,
      explanation: item.explanation || '',
    };
    if (q.type === 'true_false' || Array.isArray(q.statements)) {
      if (!Array.isArray(result.statements) || result.statements.length < (q.statements || []).length) {
        throw new Error(`Missing true/false statements for ${id}`);
      }
    } else if (Array.isArray(q.options) && q.options.length) {
      result.correctIndex = normalizeIndex(item.correctIndex ?? item.index ?? item.answer, q.options.length);
      if (result.correctIndex < 0) {
        result.correctIndex = q.options.findIndex((o) =>
          String(o).trim().toLowerCase() === String(item.answer || '').trim().toLowerCase()
        );
      }
      if (result.correctIndex < 0) throw new Error(`Invalid answer index for ${id}`);
      if (!result.answer) result.answer = q.options[result.correctIndex];
    }
    answers.push(result);
  }
  if (seen.size !== questions.length) {
    const missing = questions.filter((q) => !seen.has(String(q.id))).map((q) => q.id);
    throw new Error(`Batch response is missing question IDs: ${missing.join(', ')}`);
  }
  return answers;
}

async function solveBatch(questions, { retries = 1 } = {}) {
  if (!questions.length) return [];
  if (!hasKey()) {
    const err = new Error('AI key is not set on the server');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const prompt = buildBatchPrompt(questions);
  let lastErr;
  for (const provider of providers()) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await callAi(buildPayload(prompt, provider), { timeoutMs: 60000, provider });
        const content = response?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty batch model response');
        return validateBatchAnswers(parseModelJson(content), questions)
          .map((answer) => ({ ...answer, model: provider.model, raw: content }));
      } catch (err) {
        lastErr = err;
        const status = err.status || err.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) {
          disableProvider(provider, `HTTP ${status}: ${err.message}`);
          break;
        }
        if (status === 429 && /quota.*(day|per day)|exceeded your current quota/i.test(err.message || '')) {
          disableProvider(provider, `Hết quota ngày: ${err.message}`);
          break;
        }
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
  throw lastErr || new Error('Failed to solve batch');
}

// Accept a number, a numeric string, or an option letter.
function normalizeIndex(value, count) {
  if (value === null || value === undefined) return -1;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value >= 0 && value < count ? value : -1;
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 0 && n < count ? n : -1;
  }
  if (/^[a-zA-Z]$/.test(text)) {
    const n = text.toUpperCase().charCodeAt(0) - 65;
    return n >= 0 && n < count ? n : -1;
  }
  return -1;
}

// Solve a batch of questions with a small gap between calls.
async function solveAll(questions, { onProgress, gapMs = 800 } = {}) {
  const results = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (onProgress) onProgress(i, questions.length, q);
    try {
      const solved = await solveQuestion(q);
      results.push({ index: i, ok: true, ...solved });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message, correctIndex: -1, answer: '' });
    }
    if (i < questions.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return results;
}

module.exports = {
  solveQuestion,
  solveAll,
  hasKey,
  apiKey,
  currentModel,
  isOpenAiProvider,
  reasoningEffort,
  buildPayload,
  providers,
  buildBatchPrompt,
  validateBatchAnswers,
  solveBatch,
};