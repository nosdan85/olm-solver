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
  return base.includes('api.openai.com') || base.includes('opencode.ai') || base.includes('digishop.work');
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

function isReasoningModel(model) {
  return /^(gpt-5|gpt-6|o1|o3|o4)/i.test(model || '');
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
    payload.max_tokens = Number(process.env.OPENAI_MAX_TOKENS) || 4096;
  } else if (isReasoningModel(p.model) || isOpenAiProvider(p.baseUrl)) {
    payload.reasoning_effort = reasoningEffort();
    if (process.env.OPENAI_JSON_MODE !== '0') {
      payload.response_format = { type: 'json_object' };
    }
    // digishop supports max_tokens / max_completion_tokens
    const maxTokens = Number(process.env.OPENAI_MAX_TOKENS) || 4096;
    payload.max_tokens = maxTokens;
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
        const res = await callAi(
          buildPayload(userMessageContent, provider),
          { timeoutMs: question.imageBase64 ? 45000 : 30000, provider }
        );

        const content = res?.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty model response');

        const parsed = parseModelJson(content);
        const options = question.options || [];
        let correctIndex = -1;

        if (question.type === 'true_false' || (Array.isArray(question.statements) && question.statements.length > 0)) {
          // Parse array of booleans for True/False statements
          let statements = [];
          if (Array.isArray(parsed.statements)) {
            statements = parsed.statements.map(s => {
              if (typeof s === 'boolean') return s;
              if (typeof s === 'object' && s !== null) return Boolean(s.isTrue ?? s.answer ?? true);
              return String(s).toLowerCase().startsWith('đ') || String(s).toLowerCase().startsWith('t');
            });
          }
          const expected = (question.statements || []).length;
          const resolved = statements.length >= expected && expected > 0;
          return {
            statements: resolved ? statements : undefined,
            answer: parsed.answer || '',
            explanation: parsed.explanation || '',
            kind: 'true_false',
            unresolved: !resolved,
            reason: resolved ? undefined : 'missing-statements',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'multi_choice') {
          let correctIndices = [];
          if (Array.isArray(parsed.correctIndices)) {
            correctIndices = parsed.correctIndices.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < options.length);
          } else if (Number.isInteger(parsed.correctIndex)) {
            correctIndices = [parsed.correctIndex];
          }
          if (!correctIndices.length && parsed.answer) {
            const byText = matchOptionIndex(parsed.answer, options);
            if (byText >= 0) correctIndices = [byText];
          }
          return {
            correctIndices,
            answer: parsed.answer || (correctIndices[0] !== undefined ? options[correctIndices[0]] : ''),
            explanation: parsed.explanation || '',
            kind: 'multi_choice',
            unresolved: correctIndices.length === 0,
            reason: correctIndices.length ? undefined : 'no-correct-indices',
            model: provider.model,
            raw: content,
          };
        }

        // --- Các dạng câu hỏi mới ---
        if (question.type === 'dropdown') {
          const idx = normalizeIndex(parsed.correctIndex ?? parsed.answer, options.length);
          if (idx < 0 && parsed.answer) {
            const byText = matchOptionIndex(parsed.answer, options);
            if (byText >= 0) correctIndex = byText;
          } else if (idx >= 0) {
            correctIndex = idx;
          }
          return {
            correctIndex,
            answer: correctIndex >= 0 ? (options[correctIndex] || parsed.answer || '') : (parsed.answer || ''),
            explanation: parsed.explanation || '',
            kind: 'dropdown',
            unresolved: correctIndex < 0,
            reason: correctIndex >= 0 ? undefined : 'dropdown-unmatched',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'matching') {
          const pairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
          return {
            pairs,
            answer: parsed.answer || '',
            explanation: parsed.explanation || '',
            kind: 'matching',
            unresolved: !pairs.length,
            reason: pairs.length ? undefined : 'missing-pairs',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'drag_drop' || question.type === 'grouping') {
          const mapping = Array.isArray(parsed.mapping) ? parsed.mapping : [];
          return {
            mapping,
            answer: parsed.answer || '',
            explanation: parsed.explanation || '',
            kind: question.type,
            unresolved: !mapping.length,
            reason: mapping.length ? undefined : 'missing-mapping',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'hotspot') {
          return {
            answer: parsed.answer || '',
            box: parsed.box && typeof parsed.box === 'object' ? parsed.box : null,
            explanation: parsed.explanation || '',
            kind: 'hotspot',
            unresolved: !parsed.answer,
            reason: parsed.answer ? undefined : 'missing-hotspot',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'essay') {
          const text = parsed.answer || parsed.explanation || '';
          return {
            answer: text,
            explanation: parsed.explanation || text,
            kind: 'essay',
            unresolved: !text,
            reason: text ? undefined : 'missing-essay',
            model: provider.model,
            raw: content,
          };
        }

        if (question.type === 'word_select' || question.type === 'underline') {
          const idxs = Array.isArray(parsed.correctIndices)
            ? parsed.correctIndices.map(Number).filter(n => Number.isInteger(n) && n >= 0)
            : [];
          return {
            correctIndices: idxs,
            answer: parsed.answer || '',
            explanation: parsed.explanation || '',
            kind: question.type,
            unresolved: !idxs.length,
            reason: idxs.length ? undefined : 'missing-word-indices',
            model: provider.model,
            raw: content,
          };
        }

        if (options.length > 0) {
          // --- Sửa lỗi: index và nội dung answer phải khớp nhau ---
          const idxFromIndex = normalizeIndex(parsed.correctIndex ?? parsed.index, options.length);
          const idxFromAnswer = parsed.answer ? matchOptionIndex(parsed.answer, options) : -1;

          if (idxFromIndex >= 0 && idxFromAnswer >= 0 && idxFromIndex !== idxFromAnswer) {
            // Nội dung answer khớp 1 đáp án cụ thể nhưng index sai -> tin answer.
            correctIndex = idxFromAnswer;
          } else if (idxFromIndex >= 0) {
            correctIndex = idxFromIndex;
          } else if (idxFromAnswer >= 0) {
            correctIndex = idxFromAnswer;
          } else if (parsed.explanation) {
            const expMatch = String(parsed.explanation).match(/(?:chọn|đáp án|phương án)\s*\(?([A-D])\)?/i);
            if (expMatch) {
              const n = expMatch[1].toUpperCase().charCodeAt(0) - 65;
              if (n >= 0 && n < options.length) correctIndex = n;
            }
          }
        }

        return {
          correctIndex,
          answer: correctIndex >= 0 ? (options[correctIndex] || parsed.answer || '') : (parsed.answer ?? ''),
          explanation: parsed.explanation || '',
          kind: options.length > 0 ? 'choice' : (question.type || 'text'),
          // KHÔNG đoán bừa: đánh dấu unresolved để câu được xử lý lại.
          unresolved: options.length > 0 && correctIndex < 0,
          reason: options.length > 0 && correctIndex < 0 ? 'unmatched-answer' : undefined,
          model: provider.model,
          raw: content,
        };
      } catch (err) {
        lastErr = err;
        const status = err.status || err.response?.status;
        // Quota/rate-limit (429) is worth retrying unless daily quota exhausted.
        if (status && status >= 400 && status < 500 && status !== 429) {
          disableProvider(provider, `HTTP ${status}: ${err.message}`);
          if (onLog) onLog('warn', `⚠️ Kênh chính gián đoạn (${err.message}), chuyển sang kênh dự phòng...`);
          break;
        }
        if (status === 429 && /quota.*(day|per day)|exceeded your current quota/i.test(err.message || '')) {
          err.quotaExhausted = true;
          disableProvider(provider, `Hết quota ngày: ${err.message}`);
          if (onLog) onLog('warn', `⚠️ Kênh chính đạt giới hạn. Đang chuyển sang kênh dự phòng...`);
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
  const hasImage = !!question.imageBase64;
  lines.push(`Môn học: ${question.subject || 'Toán/Lý/Hóa/Sinh/Sử/Địa/Văn'}`);
  // Chỉ trỏ tới ảnh khi ảnh thực sự được đính kèm. Trước đây dòng này luôn
  // ghi "(Xem nội dung trong hình ảnh...)" kể cả khi không có ảnh, khiến model
  // tưởng mình đang thiếu dữ kiện và từ chối trả lời.
  lines.push(
    `Câu hỏi: ${question.text || (hasImage
      ? '(Nội dung nằm trong hình ảnh chụp màn hình kèm theo)'
      : '(KHÔNG đọc được nội dung câu hỏi - hãy trả về "không xác định" thay vì đoán bừa)')}`
  );

  if (hasImage) {
    lines.push('(Lưu ý: Câu hỏi, sơ đồ hoặc công thức nằm trong ảnh chụp màn hình kèm theo. Hãy quan sát kỹ ảnh, đọc đúng số liệu và công thức trước khi giải.)');
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

  if (question.type === 'multi_choice') {
    lines.push('\nĐây là dạng câu hỏi CHỌN NHIỀU ĐÁP ÁN ĐÚNG (chọn những phát biểu / câu đúng):');
    options.forEach((o, i) => {
      const letter = String.fromCharCode(65 + i);
      lines.push(`  [${i}] (Đáp án ${letter}): ${o}`);
    });
    lines.push('\nHãy chọn TẤT CẢ các đáp án đúng (có thể có 1, 2, 3 hoặc tất cả các đáp án đúng).');
    lines.push('Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"correctIndices": [0, 2], "explanation": "<phân tích cẩn thận từng ý>", "answer": "<nội dung các ý đúng>"}');
    return lines.join('\n');
  }

  // --- Nhóm câu hỏi Điền đáp án: dropdown, kéo-thả, gom nhóm ---
  if (question.type === 'dropdown') {
    lines.push('\nĐây là dạng câu hỏi CHỌN TỪ MENU THẢ XUỐNG (dropdown).');
    lines.push('Các lựa chọn có sẵn:');
    options.forEach((o, i) => lines.push(`  [${i}] ${o}`));
    lines.push('\nChọn đúng MỘT lựa chọn. Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"correctIndex": <chỉ số lựa chọn đúng>, "answer": "<nội dung lựa chọn đúng>", "explanation": "<giải thích ngắn>"}');
    return lines.join('\n');
  }

  if (question.type === 'drag_drop' || question.type === 'grouping') {
    lines.push('\nĐây là dạng câu hỏi KÉO THẢ / GOM NHÓM (kéo thẻ vào ô trống hoặc vào nhóm).');
    if (Array.isArray(question.items) && question.items.length) {
      lines.push('Các thẻ cần đặt:');
      question.items.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
    }
    if (Array.isArray(question.targets) && question.targets.length) {
      lines.push('Các ô / nhóm đích:');
      question.targets.forEach((t, i) => lines.push(`  [${i}] ${typeof t === 'string' ? t : t.label}`));
    }
    lines.push('\nHãy xác định thẻ nào thuộc ô/nhóm nào. Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"mapping": [{"item": <chỉ số thẻ>, "target": <chỉ số ô đích>}], "answer": "<mô tả ngắn>", "explanation": "<giải thích ngắn>"}');
    lines.push('Nếu không xác định được, trả về "mapping": [] và answer là "không xác định".');
    return lines.join('\n');
  }

  // --- Nhóm câu hỏi Kết nối và Hình ảnh ---
  if (question.type === 'matching') {
    lines.push('\nĐây là dạng câu hỏi GHÉP ĐÔI (nối cột A với cột B).');
    if (Array.isArray(question.left) && question.left.length) {
      lines.push('Cột A:');
      question.left.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
    }
    if (Array.isArray(question.right) && question.right.length) {
      lines.push('Cột B:');
      question.right.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
    }
    lines.push('\nHãy nối mỗi ý cột A với đúng một ý cột B. Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"pairs": [{"left": <chỉ số cột A>, "right": <chỉ số cột B>}], "answer": "<mô tả ngắn>", "explanation": "<giải thích ngắn>"}');
    return lines.join('\n');
  }

  if (question.type === 'hotspot') {
    lines.push('\nĐây là dạng câu hỏi CHỌN VỊ TRÍ TRÊN HÌNH (hotspot).');
    lines.push('Hãy xác định vị trí/vùng đúng trên hình ảnh kèm theo.');
    lines.push('Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"answer": "<mô tả vị trí>", "box": {"x": <tọa độ x tương đối 0-1>, "y": <tọa độ y tương đối 0-1>, "width": <bề rộng 0-1>, "height": <chiều cao 0-1>}, "explanation": "<giải thích ngắn>"}');
    lines.push('Toạ độ box dùng đơn vị 0-1 so với kích thước ảnh. Nếu không xác định được, trả về answer là "không xác định".');
    return lines.join('\n');
  }

  if (question.type === 'essay') {
    lines.push('\nĐây là dạng câu hỏi TỰ LUẬN (nhập liời giải hoặc nộp ảnh bài làm).');
    lines.push('Hãy viết lời giải chi tiết, đúng chương trình SGK.');
    lines.push('Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"answer": "<lời giải đầy đủ>", "explanation": "<lời giải đầy đủ>"}');
    return lines.join('\n');
  }

  if (question.type === 'word_select' || question.type === 'underline') {
    lines.push('\nĐây là dạng câu hỏi GẠCH CHÂN / CHỌN TỪ TRONG ĐOẠN VĂN.');
    if (Array.isArray(question.words) && question.words.length) {
      lines.push('Các từ/cụm từ trong đoạn:');
      question.words.forEach((w, i) => lines.push(`  [${i}] ${typeof w === 'string' ? w : w.text}`));
    }
    lines.push('\nHãy chọn từ/cụm từ đúng theo yêu cầu. Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng:');
    lines.push('{"correctIndices": [<các chỉ số đúng>], "answer": "<từ đã chọn>", "explanation": "<giải thích ngắn>"}');
    return lines.join('\n');
  }

  if (options.length > 0) {
    lines.push('\nDanh sách 4 đáp án lựa chọn (A, B, C, D):');
    options.forEach((o, i) => {
      const letter = String.fromCharCode(65 + i);
      lines.push(`  [${i}] (Đáp án ${letter}): ${o}`);
    });
    lines.push('');
    lines.push('YÊU CẦU BẮT BUỘC:');
    lines.push('1. Đọc kỹ câu hỏi và đối chiếu với cả 4 đáp án trên (A, B, C, D).');
    lines.push('2. Chọn ra đúng 1 đáp án chính xác nhất trong 4 lựa chọn trên.');
    lines.push('3. Điền vào "correctIndex" là chỉ số của đáp án (0 cho A, 1 cho B, 2 cho C, 3 cho D).');
    lines.push('4. Điền vào "answer" nội dung đáp án đã chọn.');
    lines.push(
      'Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng: ' +
        '{"explanation": "<suy luận phân tích loại trừ ngắn>", "correctIndex": <số thứ tự đáp án đúng từ 0 đến ' + (options.length - 1) + '>, "answer": "<nội dung đáp án đúng>"}'
    );
  } else {
    lines.push('');
    lines.push(
      'Đây là câu hỏi trả lời ngắn/tự luận/điền số/đếm số lượng chất. ' +
      'Trả về DUY NHẤT một chuỗi JSON hợp lệ dạng: ' +
        '{"explanation": "<phân tích, loại trừ và đếm cẩn thận từng dữ kiện>", "answer": "<con số hoặc đáp án ngắn gọn nhất>"}'
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
    'Bạn là chuyên gia giải bài tập và đề thi chuẩn xác 100% theo chương trình SGK mới của Bộ GD&ĐT (Chương trình GDPT 2018).',
    'Giải các câu hỏi dưới đây. Mỗi câu có một ID duy nhất.',
    'Trả về DUY NHẤT JSON hợp lệ dạng: {"answers":[{"id":"q_1","explanation":"<phân tích loại trừ trước>","correctIndex":0,"correctIndices":[0,2],"answer":"...","statements":[true]}]}',
    'Không bỏ qua câu nào. Giữ nguyên chính xác ID được cung cấp.',
    'Quy tắc giải chuẩn xác:',
    '1. Luôn viết "explanation" trước để phân tích cẩn thận từng chất, công thức hóa học, mệnh đề hoặc số liệu.',
    '2. Đối với câu trắc nghiệm 1 đáp án: chỉ định "correctIndex" (0 cho A, 1 cho B, 2 cho C, 3 cho D) và "answer".',
    '3. Đối với câu trắc nghiệm chọn nhiều đáp án đúng ("chọn những câu đúng"): chỉ định "correctIndices" là mảng các chỉ số đúng (ví dụ: [0, 2]).',
    '4. Đối với câu Đúng/Sai: "statements" là mảng boolean [true, false,...] theo đúng thứ tự các ý.',
    '5. Đối với câu trả lời ngắn/điền số/đếm số chất:',
    '   - Đọc kỹ yêu cầu đề bài (ví dụ: đếm số chất, tính khối lượng, sắp xếp dãy số thứ tự tăng dần).',
    '   - Với câu điền số hoặc dãy số, CHỈ ĐIỀN CON SỐ (ví dụ: 123 hoặc 4370 hoặc 80,2), KHÔNG điền kèm đơn vị tính như kg, g, %, tấn nếu không bắt buộc.',
    '   - Tuân thủ quy tắc làm tròn số của đề bài (hàng đơn vị, hàng phần chục, hàng phần trăm).',
  ];

  for (const q of questions) {
    lines.push(`\nID: ${q.id}`);
    lines.push(`Môn học: ${q.subject || ''}`);
    lines.push('Câu hỏi: ' + (q.text || '(xem nội dung đã cung cấp)'));
    if (q.type === 'true_false' || (Array.isArray(q.statements) && q.statements.length > 0)) {
      lines.push('Mệnh đề Đúng/Sai:');
      (q.statements || []).forEach((s, i) => lines.push(`  [${i}] ${s}`));
    } else if (q.type === 'multi_choice') {
      lines.push('Dạng chọn nhiều đáp án đúng (chọn những phát biểu / câu đúng):');
      (q.options || []).forEach((o, i) => lines.push(`  [${i}] ${o}`));
      lines.push(`(Quy ước: ${(q.options || []).map((_, i) => `${String.fromCharCode(65 + i)}=[${i}]`).join(', ')})`);
      lines.push('-> Chọn TẤT CẢ các đáp án đúng và trả về mảng "correctIndices": [...]');
    } else if (q.type === 'dropdown') {
      lines.push('Dạng chọn từ menu thả xuống (dropdown) - chọn đúng 1 lựa chọn:');
      (q.options || []).forEach((o, i) => lines.push(`  [${i}] ${o}`));
      lines.push('-> Trả về "correctIndex" (chỉ số lựa chọn đúng) và "answer" (nội dung lựa chọn đúng).');
    } else if (q.type === 'drag_drop' || q.type === 'grouping') {
      lines.push(q.type === 'grouping'
        ? 'Dạng gom nhóm / phân loại - kéo từng thẻ vào đúng nhóm:'
        : 'Dạng kéo thả vào ô trống:');
      if (Array.isArray(q.items) && q.items.length) {
        lines.push('Các thẻ:');
        q.items.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
      }
      if (Array.isArray(q.targets) && q.targets.length) {
        lines.push('Các ô/nhóm đích:');
        q.targets.forEach((t, i) => lines.push(`  [${i}] ${typeof t === 'string' ? t : t.label}`));
      }
      lines.push('-> Trả về "mapping": [{"item": <chỉ số thẻ>, "target": <chỉ số ô đích>}].');
    } else if (q.type === 'matching') {
      lines.push('Dạng ghép đôi / nối cột:');
      if (Array.isArray(q.left) && q.left.length) {
        lines.push('Cột A:');
        q.left.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
      }
      if (Array.isArray(q.right) && q.right.length) {
        lines.push('Cột B:');
        q.right.forEach((it, i) => lines.push(`  [${i}] ${typeof it === 'string' ? it : it.text}`));
      }
      lines.push('-> Trả về "pairs": [{"left": <chỉ số cột A>, "right": <chỉ số cột B>}].');
    } else if (q.type === 'hotspot') {
      lines.push('Dạng chọn vị trí trên hình (hotspot).');
      lines.push('-> Trả về "answer" (mô tả vị trí) và "box" {"x","y","width","height"} theo toạ độ tương đối 0-1.');
    } else if (q.type === 'word_select' || q.type === 'underline') {
      lines.push('Dạng gạch chân / chọn từ trong đoạn văn:');
      if (Array.isArray(q.words) && q.words.length) {
        q.words.forEach((w, i) => lines.push(`  [${i}] ${typeof w === 'string' ? w : w.text}`));
      }
      lines.push('-> Trả về "correctIndices": [<các chỉ số từ đúng>].');
    } else if (q.type === 'essay') {
      lines.push('Dạng tự luận - viết lời giải chi tiết vào "answer".');
    } else if (Array.isArray(q.options) && q.options.length) {
      lines.push('Danh sách 4 đáp án lựa chọn:');
      q.options.forEach((o, i) => lines.push(`  [${i}] ${o}`));
      lines.push(`(Quy ước: ${q.options.map((_, i) => `${String.fromCharCode(65 + i)}=[${i}]`).join(', ')})`);
      lines.push('-> Bắt buộc đối chiếu 4 đáp án A, B, C, D ở trên và chọn ra đúng 1 đáp án chuẩn xác nhất.');
    } else {
      lines.push('Dạng tự luận/trả lời ngắn/điền số: ghi đáp án ngắn gọn nhất theo chuẩn SGK vào "answer".');
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
      statements: undefined,
      explanation: item.explanation || '',
    };
    if (q.type === 'true_false' || (Array.isArray(q.statements) && q.statements.length > 0)) {
      // Chỉ dạng Đúng/Sai mới dùng "statements". Các dạng khác bỏ qua để
      // tránh rò rỉ mảng boolean không liên quan.
      result.statements = Array.isArray(item.statements) ? item.statements.map((value) => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'object' && value !== null) return Boolean(value.isTrue ?? value.answer);
        const text = String(value).toLowerCase();
        return text.startsWith('đ') || text.startsWith('t') || text === 'true';
      }) : undefined;
      const expected = (q.statements || []).length;
      if (!Array.isArray(result.statements) || result.statements.length < expected || expected === 0) {
        // Không được đoán "toàn bộ Đúng" khi model không trả về mệnh đề.
        // Báo lỗi để batch được thử lại (cuối cùng fallback sang giải từng câu).
        throw new Error(`Missing true/false statements for ${id}`);
      }
    } else if (q.type === 'multi_choice') {
      let correctIndices = [];
      if (Array.isArray(item.correctIndices)) {
        correctIndices = item.correctIndices.map(Number);
        const bad = correctIndices.find((n) => !Number.isInteger(n) || n < 0 || n >= (q.options || []).length);
        if (bad !== undefined) throw new Error(`Invalid answer index ${bad} for ${id}`);
      } else if (item.correctIndex !== undefined && item.correctIndex !== null) {
        const n = Number(item.correctIndex);
        if (!Number.isInteger(n) || n < 0 || n >= (q.options || []).length) {
          throw new Error(`Invalid answer index ${item.correctIndex} for ${id}`);
        }
        correctIndices = [n];
      }
      if (!correctIndices.length && item.answer) {
        // Thử khớp theo nội dung đáp án khi model không đưa chỉ số.
        const cleanAns = String(item.answer).trim().toLowerCase();
        const byText = (q.options || []).findIndex((o) => {
          const co = String(o).trim().toLowerCase();
          return co === cleanAns || (cleanAns.length >= 4 && (co.includes(cleanAns) || cleanAns.includes(co)));
        });
        if (byText >= 0) correctIndices = [byText];
      }
      result.correctIndices = correctIndices;
      result.correctIndex = correctIndices[0] ?? -1;
      if (!result.answer && result.correctIndex >= 0) result.answer = (q.options && q.options[result.correctIndex]) || '';
      if (result.correctIndex < 0) {
        result.unresolved = true;
        result.reason = 'no-correct-indices';
      }
    } else if (Array.isArray(q.options) && q.options.length) {
      // --- Sửa lỗi: index và nội dung answer phải khớp nhau ---
      // Trước đây khi model trả correctIndex sai (vd 9) code reset về 0 nhưng
      // vẫn giữ answer gốc, khiến fillCurrentQuestion click nhầm đáp án A.
      const rawIndex = item.correctIndex ?? item.index;
      const idxFromIndex = normalizeIndex(rawIndex, q.options.length);
      const idxFromAnswer = item.answer ? matchOptionIndex(item.answer, q.options) : -1;

      let chosen = -1;
      if (idxFromIndex >= 0 && idxFromAnswer >= 0 && idxFromIndex !== idxFromAnswer) {
        // Nội dung answer khớp được 1 đáp án cụ thể nhưng index không khớp
        // -> tin nội dung answer (model thường chép lại đáp án đúng).
        chosen = idxFromAnswer;
      } else if (idxFromIndex >= 0) {
        chosen = idxFromIndex;
      } else if (idxFromAnswer >= 0) {
        chosen = idxFromAnswer;
      } else if (item.explanation) {
        const expMatch = String(item.explanation).match(/(?:chọn|đáp án|phương án)\s*\(?([A-D])\)?/i);
        if (expMatch) {
          const n = expMatch[1].toUpperCase().charCodeAt(0) - 65;
          if (n >= 0 && n < q.options.length) chosen = n;
        }
      }

      result.correctIndex = chosen;
      if (chosen < 0) {
        // Index được cung cấp nhưng nằm ngoài phạm vi -> dữ liệu model sai.
        // Báo lỗi để batch thử lại. TUYỆT ĐỐI không fallback sang đáp án A.
        if (rawIndex !== undefined && rawIndex !== null && rawIndex !== '') {
          throw new Error(`Invalid answer index ${rawIndex} for ${id}`);
        }
        // KHÔNG đoán bừa đáp án A. Đánh dấu unresolved để xử lý lại.
        result.unresolved = true;
        result.reason = 'unmatched-answer';
      } else {
        result.answer = q.options[chosen] || result.answer || '';
      }
    } else if (['dropdown', 'drag_drop', 'grouping', 'matching', 'hotspot', 'essay', 'word_select', 'underline'].includes(q.type)) {
      // Các dạng mới: giữ nguyên dữ liệu model trả về, chỉ chuẩn hoá.
      if (q.type === 'dropdown') {
        const idx = normalizeIndex(item.correctIndex ?? item.answer, q.options.length);
        if (idx >= 0) {
          result.correctIndex = idx;
          result.answer = q.options[idx] || result.answer || '';
        } else {
          result.unresolved = true;
          result.reason = 'dropdown-unmatched';
        }
      } else if (q.type === 'matching') {
        result.pairs = Array.isArray(item.pairs) ? item.pairs : [];
        if (!result.pairs.length) { result.unresolved = true; result.reason = 'missing-pairs'; }
      } else if (q.type === 'drag_drop' || q.type === 'grouping') {
        result.mapping = Array.isArray(item.mapping) ? item.mapping : [];
        if (!result.mapping.length) { result.unresolved = true; result.reason = 'missing-mapping'; }
      } else if (q.type === 'hotspot') {
        result.box = item.box && typeof item.box === 'object' ? item.box : null;
        if (!result.answer) { result.unresolved = true; result.reason = 'missing-hotspot'; }
      } else if (q.type === 'word_select' || q.type === 'underline') {
        const idxs = Array.isArray(item.correctIndices)
          ? item.correctIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
          : [];
        result.correctIndices = idxs;
        if (!idxs.length) { result.unresolved = true; result.reason = 'missing-word-indices'; }
      } else if (q.type === 'essay') {
        if (!result.answer) { result.unresolved = true; result.reason = 'missing-essay'; }
      }
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

// Tìm chỉ số của đáp án khớp với một chuỗi trả lời tự do của model.
// Ưu tiên khớp chính xác, sau đó khớp theo chữ cái (A/B/C/D), rồi mới khớp chuỗi con.
function matchOptionIndex(answerText, options) {
  if (!answerText || !Array.isArray(options) || !options.length) return -1;
  const cleanAns = String(answerText).trim().toLowerCase();
  if (!cleanAns) return -1;

  // Bỏ tiền tố nhãn đáp án ở cả hai vế để so khớp công bằng.
  const stripLabel = (s) =>
    String(s).trim().replace(/^(?:[A-D\d][\.\)\:\-]\s*|\([A-D\d]\)\s*|\[[A-D\d]\]\s*)/i, '').trim().toLowerCase();

  const ansBody = stripLabel(cleanAns);

  // 1. Khớp chính xác (đã bỏ nhãn)
  let idx = options.findIndex((o) => stripLabel(o) === ansBody);
  if (idx >= 0) return idx;

  // 2. Model trả về đúng một chữ cái (A/B/C/D) -> ánh xạ theo vị trí
  const letterMatch = cleanAns.match(/^(?:đáp án|phương án|lựa chọn|chọn)?\s*[\(\[]?\s*([a-dA-D])\s*[\)\]\.\:]?$/i);
  if (letterMatch) {
    const n = letterMatch[1].toUpperCase().charCodeAt(0) - 65;
    if (n >= 0 && n < options.length) return n;
  }

  // 3. Khớp chuỗi con (chỉ khi đủ dài để tránh trùng số/ chữ cái đơn lẻ)
  if (ansBody.length >= 4) {
    idx = options.findIndex((o) => {
      const ob = stripLabel(o);
      if (!ob) return false;
      return ob.includes(ansBody) || ansBody.includes(ob);
    });
    if (idx >= 0) return idx;
  }

  return -1;
}

// Accept a number, a numeric string, or an option letter (A, B, C, D, Đáp án B, (B), [B]).
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
  const m = text.match(/^(?:đáp án|phương án|lựa chọn|câu)?\s*[\(\[]?\s*([a-dA-D])\s*[\)\]\.\:]?$/i) ||
            text.match(/^[\[\(]?([a-dA-D])[\]\)\.]?$/i);
  if (m) {
    const n = m[1].toUpperCase().charCodeAt(0) - 65;
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
  buildPrompt,
  normalizeIndex,
  matchOptionIndex,
};