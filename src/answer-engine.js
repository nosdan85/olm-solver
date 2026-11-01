'use strict';

const https = require('https');

const OPENAI_URL = () => {
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
  return `${base}/chat/completions`;
};

function apiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function hasKey() {
  return Boolean(apiKey());
}

function callAi(payload) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(OPENAI_URL());
    const data = JSON.stringify(payload);
    const req = https.request(fullUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Authorization': `Bearer ${apiKey()}`,
      },
      timeout: 30000,
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
          reject(new Error(`AI HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('AI request timeout'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Ask the model to solve one question (supports Vision screenshot, True/False, Short Answer, Choice).
async function solveQuestion(question, { retries = 2 } = {}) {
  if (!hasKey()) {
    const err = new Error('OPENAI_API_KEY is not set on the server');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const prompt = buildPrompt(question);
  let lastErr;

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

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await callAi({
        model: process.env.OPENAI_MODEL || 'gemini-flash-lite-latest',
        temperature: 0.1,
        messages: [
          { role: 'user', content: userMessageContent },
        ],
      });

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
        raw: content,
      };
    } catch (err) {
      const apiMessage = err.response?.data?.error?.message;
      lastErr = apiMessage ? new Error(`AI API error: ${apiMessage}`) : err;
      const status = err.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) break;
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
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

module.exports = { solveQuestion, solveAll, hasKey, apiKey };