'use strict';

const cheerio = require('cheerio');
const { cleanScienceText, normalizeMathStructureInCheerio } = require('./science-normalizer');

const XOR_KEY = '1047823200';

function xorBinaryWithKey(i, a) {
  if (!a || !i) return i;
  let o = '';
  const u = a.length;
  for (let _ = 0; _ < i.length; _++) {
    o += String.fromCharCode(i.charCodeAt(_) ^ a.charCodeAt(_ % u));
  }
  return o;
}

function xorDecodeBase64(i) {
  if (!i || typeof i !== 'string') return '';
  try {
    const bin = Buffer.from(i, 'base64').toString('binary');
    const o = xorBinaryWithKey(bin, XOR_KEY);
    return Buffer.from(o, 'binary').toString('utf8');
  } catch (e) {
    return '';
  }
}

function cleanText(str) {
  return cleanScienceText(str);
}

function extractPrimaryPipeVariant(str) {
  const s = String(str || '');
  if (!s.includes('|')) return s;
  const pipeCount = (s.match(/\|/g) || []).length;
  if (
    pipeCount % 2 === 0 &&
    (/^\s*\|[^|]+\|\s*$/.test(s) || /(?:^|[=+\-*/^<>(\s])\|[^|]+\|(?:$|[=+\-*/^<>)\s])/.test(s))
  ) {
    return s;
  }
  const first = s.split('|')[0];
  return first !== '' ? first : s;
}

/**
 * Trích xuất đề bài đầy đủ từ HTML câu hỏi đã giải mã (bỏ phần đáp án và lời giải)
 */
function extractFullStem($) {
  const $clone = cheerio.load($.html());
  $clone('.exp, .explanation, .giai-chi-tiet, .loigiai, .huong-dan, .quiz-list, ol.true-false, ul.true-false, .true-false, table.true-false, svg, style, script').remove();
  normalizeMathStructureInCheerio($clone);
  const fullText = cleanText($clone.root().text()).replace(/(?:trả lời|tra loi|bài làm|bai lam)[\s:]*$/i, '').trim();
  if (fullText && fullText.length >= 3) {
    return fullText.slice(0, 2000);
  }
  return cleanText($clone('p').first().text()) || cleanText($clone.root().text().slice(0, 2000));
}

/**
 * Kiểm tra xem 1 phần tử <li> có được đánh dấu là đáp án đúng hay không
 */
function isElemMarkedCorrect($ctx, elem) {
  const $el = $ctx(elem);
  return (
    $el.hasClass('correctAnswer') ||
    ($el.attr('class') || '').includes('correctAnswer') ||
    $el.attr('data-correct') === '1' ||
    $el.attr('correct') === 'true'
  );
}

/**
 * Giải mã danh sách câu hỏi nhận được từ API get-question-of-ids / get-test / get-lesson
 * Hỗ trợ trọn bộ:
 * - Trắc nghiệm 1 lựa chọn & Nhiều lựa chọn (thẻ <li class="correctAnswer">, data-correct, hoặc tiền tố #)
 * - Câu hỏi chùm / Tổ hợp nhiều câu trắc nghiệm trong 1 câu (q_type 22 hoặc nhiều <ol class="quiz-list">)
 * - Đúng / Sai 4 mệnh đề hoặc nhiều nhóm Đúng/Sai (q_type 13, ol.true-false)
 * - Điền ô trống / Trả lời ngắn / Ô điền số (input[data-accept], data-accepts, data-ans, span.dragtext)
 * - Select-Text / Dropdown trong câu (span.selecttext ngăn cách bởi ||)
 * - Tự luận ngắn / Điền đáp án (q_type 18 hoặc đoạn <p>Đáp án: ...</p>)
 */
function decodeQuestionsPayload(questionsList) {
  const result = [];
  if (typeof questionsList === 'string') {
    try {
      questionsList = JSON.parse(questionsList);
    } catch (e) {
      return result;
    }
  }
  if (!Array.isArray(questionsList)) return result;

  for (let idx = 0; idx < questionsList.length; idx++) {
    const q = questionsList[idx];
    if (!q) continue;

    let html = '';
    if (q.content && typeof q.content === 'string') {
      // Nếu content là HTML trực tiếp hoặc Base64 XOR
      if (!/^[A-Za-z0-9+/]{8,}={0,2}$/.test(q.content.trim())) {
        html = q.content;
      } else {
        const decoded = xorDecodeBase64(q.content.trim());
        html = /<\/?[a-z][\w:-]*(?:\s[^>]*|\s*\/?)>/i.test(decoded) && !decoded.includes('�') ? decoded : q.content;
      }
    } else if (q.question_content || q.text) {
      html = q.question_content || q.text;
    }

    if (!html) continue;

    const $ = cheerio.load(html);
    const stem = extractFullStem($);

    // 0. Dạng Đúng / Sai (True / False: q_type 13 hoặc có ol.true-false / .true-false)
    const isTrueFalse =
      String(q.q_type || q.type || '') === '13' ||
      $('ol.true-false, .true-false, table.true-false').length > 0;

    if (isTrueFalse) {
      const $tfDoc = cheerio.load(html);
      $tfDoc('.exp, .explanation, .giai-chi-tiet, .loigiai').remove();
      normalizeMathStructureInCheerio($tfDoc);

      const tfList = [];
      let tfItems = $tfDoc('ol.true-false li, ul.true-false li, .true-false li');
      if (tfItems.length === 0) {
        tfItems = $tfDoc('li').filter((_, el) => !$tfDoc(el).hasClass('OlmEditorTheme__listItem') || $tfDoc(el).siblings('li').length > 0);
      }
      const hasExplicitTfCorrect = tfItems.toArray().some((elem) => isElemMarkedCorrect($tfDoc, elem));

      tfItems.each((optIdx, elem) => {
        const rawItemText = cleanText($tfDoc(elem).text());
        const isCorrect = hasExplicitTfCorrect
          ? isElemMarkedCorrect($tfDoc, elem)
          : rawItemText.startsWith('#');
        const text = rawItemText.replace(/^#+\s*/, '').trim();
        tfList.push({
          index: optIdx,
          value: isCorrect ? 1 : 0, // 1 là Đúng, 0 là Sai
          label: isCorrect ? 'Đúng' : 'Sai',
          text,
        });
      });

      const tfSummary = tfList.map((item, i) => `${String.fromCharCode(97 + (i % 26))}) ${item.label}`).join('; ');
      const $expDoc = cheerio.load(html);
      normalizeMathStructureInCheerio($expDoc);
      const exp = cleanText($expDoc('.exp, .explanation, .giai-chi-tiet').text());

      result.push({
        index: idx,
        id: q.id,
        stem,
        options: tfList.map((t) => t.text),
        isTrueFalse: true,
        tfAnswers: tfList,
        correctIndices: tfList.filter(item => item.value === 1).map(item => item.index),
        correctIndex: -1,
        correctText: tfSummary,
        answer: tfSummary,
        explanation: exp,
        rawHtml: html,
        qType: '13',
      });
      continue;
    }

    // 1. Dạng Trắc nghiệm lựa chọn có thẻ <li> (Single choice, Multiple choice & Compound Multi-Question q_type 22)
    // Loại bỏ các thẻ <li> nằm trong phần lời giải (.exp)
    const $noExp = cheerio.load(html);
    $noExp('.exp, .explanation, .giai-chi-tiet, .loigiai').remove();
    // Chuẩn hóa toàn bộ cấu trúc KaTeX (.mfrac, .msupsub, .sqrt), MathML và <sup>/<sub> trước khi lấy text
    normalizeMathStructureInCheerio($noExp);

    const quizLists = $noExp('ol.quiz-list, ul.quiz-list, .quiz-list');
    const sortLists = $noExp('ol.sort-list, ul.sort-list, .sort-list');
    const linkLists = $noExp('ol.link-list, ul.link-list, .link-list');
    const groupLists = $noExp('ol.group-list, ul.group-list, .group-list');
    const underLines = $noExp('span.under-line, .under-line');

    let items;
    if (quizLists.length > 0) {
      items = quizLists.find('li');
    } else if (sortLists.length > 0 || linkLists.length > 0 || groupLists.length > 0) {
      items = $noExp([]);
    } else {
      // Loại bỏ các thẻ <ul><li class="OlmEditorTheme__listItem"> đứng lẻ làm tiêu đề mục (vd "A. Trắc nghiệm")
      items = $noExp('li').filter((_, el) => {
        const $el = $noExp(el);
        if ($el.hasClass('OlmEditorTheme__listItem') && $el.siblings('li').length === 0) return false;
        return true;
      });
    }

    let correctIndices = [];
    let correctTexts = [];
    let options = [];
    let subQuestions = null;
    let linkPairs = null;
    let groups = null;
    let sortItems = null;
    let isUnderline = false;

    const hasExplicitLiCorrect = items.toArray().some((elem) => isElemMarkedCorrect($noExp, elem));

    if (quizLists.length > 1) {
      // Dạng bài tập / đề cương gộp nhiều câu trắc nghiệm con (<ol class="quiz-list">) trong cùng 1 câu lớn
      subQuestions = [];
      let globalOptOffset = 0;

      quizLists.each((subIdx, ql) => {
        const $ql = $noExp(ql);
        const subLis = $ql.find('li');
        const subOptions = [];
        const hasExplicitSubCorrect = subLis.toArray().some(elem => isElemMarkedCorrect($noExp, elem));
        const subCorrectIndices = [];
        const subCorrectTexts = [];
        const dataKey = $ql.attr('data-key') || String(subIdx);

        subLis.each((localIdx, elem) => {
          const rawLiText = cleanText($noExp(elem).text());
          const isCorrect = hasExplicitSubCorrect
            ? isElemMarkedCorrect($noExp, elem)
            : rawLiText.startsWith('#');
          let text = rawLiText.replace(/^#+\s*/, '').trim();
          if (!text) {
            const imgSrc = $noExp(elem).find('img').attr('src') || '';
            if (imgSrc) text = `[Hình ảnh: ${imgSrc}]`;
          }
          const globalIdx = globalOptOffset + localIdx;
          options.push(text);
          subOptions.push(text);
          if (isCorrect) {
            correctIndices.push(globalIdx);
            correctTexts.push(text);
            subCorrectIndices.push(localIdx);
            subCorrectTexts.push(text);
          }
        });

        // Nếu 1 câu con trong đề bị giáo viên quên gắn class .correctAnswer (như câu SMTP trong đề Tin 12),
        // vẫn ghi nhận subQuestion để không làm lệch vị trí các câu con tiếp theo
        const primaryLocalIdx = subCorrectIndices.length > 0 ? subCorrectIndices[0] : -1;
        subQuestions.push({
          subIndex: subIdx,
          dataKey,
          options: subOptions,
          correctIndex: primaryLocalIdx,
          correctIndices: subCorrectIndices,
          correctText: subCorrectTexts.join('; '),
          globalOffset: globalOptOffset,
        });

        globalOptOffset += subLis.length;
      });
    } else if (items.length > 0) {
      items.each((optIdx, elem) => {
        const rawLiText = cleanText($noExp(elem).text());
        const isCorrect = hasExplicitLiCorrect
          ? isElemMarkedCorrect($noExp, elem)
          : rawLiText.startsWith('#');
        let text = rawLiText.replace(/^#+\s*/, '').trim();
        if (!text) {
          const imgSrc = $noExp(elem).find('img').attr('src') || '';
          if (imgSrc) text = `[Hình ảnh: ${imgSrc}]`;
        }
        options.push(text);
        if (isCorrect) {
          correctIndices.push(optIdx);
          correctTexts.push(text);
        }
      });
    }

    // 1a. Dạng Sắp xếp thứ tự (q_type: 5 / ol.sort-list, ul.sort-list): Thứ tự thẻ <li> trong HTML gốc là thứ tự đúng 0..N-1
    if (sortLists.length > 0) {
      sortItems = [];
      sortLists.find('li').each((sIdx, elem) => {
        const text = cleanText($noExp(elem).text());
        if (text) {
          sortItems.push(text);
          options.push(text);
          correctIndices.push(sIdx);
          correctTexts.push(text);
        }
      });
    }

    // 1b. Dạng Nối cột / Ghép đôi (q_type: 6 / ol.link-list, ul.link-list): <li>Left || Right</li>
    if (linkLists.length > 0) {
      linkPairs = [];
      linkLists.find('li').each((_, elem) => {
        const rawLi = $noExp(elem).text();
        const parts = String(rawLi || '').split('||').map((p) => cleanText(p)).filter(Boolean);
        if (parts.length >= 2) {
          linkPairs.push({ left: parts[0], right: parts[1] });
        }
      });
    }

    // 1c. Dạng Phân loại / Gom nhóm (q_type: 10 / ol.group-list, ul.group-list): <li>GroupTitle || Item1 || Item2...</li>
    if (groupLists.length > 0) {
      groups = [];
      groupLists.find('li').each((_, elem) => {
        const rawLi = $noExp(elem).text();
        const parts = String(rawLi || '').split('||').map((p) => cleanText(p)).filter(Boolean);
        if (parts.length >= 2) {
          groups.push({
            title: parts[0],
            items: parts.slice(1),
          });
        }
      });
    }

    // 1d. Dạng Gạch chân từ / câu trong đoạn văn (q_type: 9 / span.under-line)
    if (underLines.length > 0 && options.length === 0) {
      isUnderline = true;
      const hasExplicitUlCorrect = underLines.toArray().some((elem) => isElemMarkedCorrect($noExp, elem));
      underLines.each((uIdx, elem) => {
        const rawUlText = cleanText($noExp(elem).text());
        const isCorrect = hasExplicitUlCorrect
          ? isElemMarkedCorrect($noExp, elem)
          : rawUlText.startsWith('#');
        const text = rawUlText.replace(/^#+\s*/, '').trim();
        options.push(text);
        if (isCorrect) {
          correctIndices.push(uIdx);
          correctTexts.push(text);
        }
      });
    }

    let directAnswerText = correctTexts.join('; ');
    if (!directAnswerText && linkPairs && linkPairs.length > 0) {
      directAnswerText = linkPairs.map((p) => `${p.left} -> ${p.right}`).join('; ');
    }
    if (!directAnswerText && groups && groups.length > 0) {
      directAnswerText = groups.map((g) => `${g.title}: ${g.items.join(', ')}`).join(' | ');
    }
    let directCorrectIndex = correctIndices.length > 0 ? correctIndices[0] : -1;

    // 2. Dạng Điền vào ô trống (Fill in blank / q_type: 2): có thẻ <input data-accept="...">
    const fillAnswers = [];
    $noExp('input[data-accept], input[data-accepts], input[data-ans]').each((_, inp) => {
      const rawAcc = $noExp(inp).attr('data-accept') || $noExp(inp).attr('data-accepts') || $noExp(inp).attr('data-ans');
      if (rawAcc !== undefined && rawAcc !== null) {
        // Nếu có nhiều đáp án chấp nhận ngăn cách bởi || hoặc |, luôn lấy đáp án chuẩn đầu tiên
        // Loại bỏ thẻ HTML bị giáo viên粘贴 nhầm vào data-accept (vd: "<strong>describing" -> "describing")
        const strippedAcc = extractPrimaryPipeVariant(String(rawAcc).split('||')[0]).replace(/<!--[\s\S]*?-->|<[^>]+>/g, '');
        const primaryAcc = cleanText(strippedAcc);
        if (primaryAcc) fillAnswers.push(primaryAcc);
      }
    });

    if (!directAnswerText && fillAnswers.length > 0) {
      directAnswerText = fillAnswers.length > 1 ? fillAnswers.join(' | ') : fillAnswers[0];
    }

    // 2b. Dạng Select-Text / Dropdown trong văn bản (q_type: 11 / span.selecttext):
    // Trong OLM, các lựa chọn ngăn cách bởi "||" và phần tử ĐẦU TIÊN luôn là đáp án đúng (hoặc phần tử có dấu #)
    const selectTextAnswers = [];
    $noExp('span.selecttext, .selecttext').each((_, span) => {
      const rawSpanText = cleanText($noExp(span).text());
      const parts = rawSpanText.split('||').map((p) => cleanText(p)).filter(Boolean);
      if (parts.length > 0) {
        const markedCorrect = parts.find((p) => p.startsWith('#'));
        const chosen = markedCorrect ? markedCorrect.replace(/^#+\s*/, '').trim() : parts[0];
        selectTextAnswers.push(chosen);
      }
    });
    if (selectTextAnswers.length > 0 && !directAnswerText) {
      directAnswerText = selectTextAnswers.join('; ');
    }

    // 2c. Dạng Kéo thả chữ vào chỗ trống (span.dragtext)
    const dragAnswers = [];
    $noExp('span.dragtext, .dragtext').each((_, el) => {
      const rawDrag = cleanText($noExp(el).text());
      if (rawDrag) {
        const firstPart = extractPrimaryPipeVariant(rawDrag.split('||')[0]).replace(/^#+\s*/, '').trim();
        if (firstPart) dragAnswers.push(firstPart);
      }
    });
    if (!directAnswerText && dragAnswers.length > 0) {
      directAnswerText = dragAnswers.join('; ');
      if (fillAnswers.length === 0) fillAnswers.push(...dragAnswers);
    }

    // 3. Dạng Tự luận ngắn / Điền đáp án (q_type: 18 hoặc có thẻ Đáp án: trong lời giải)
    const $fullNorm = cheerio.load(html);
    normalizeMathStructureInCheerio($fullNorm);

    if (!directAnswerText) {
      const allP = $fullNorm('p, div').map((_, el) => cleanText($fullNorm(el).text())).get();
      for (let pIdx = 0; pIdx < allP.length; pIdx++) {
        const pText = allP[pIdx];
        if (/^(?:đáp án|đáp số|kết quả)[\s\:\.]*$/i.test(pText) && pIdx + 1 < allP.length) {
          directAnswerText = allP[pIdx + 1];
          break;
        } else if (/^(?:đáp án|đáp số|kết quả)\s*(?:đúng\s*là|là)?[\s\:\.]+(.+)$/i.test(pText)) {
          const m = pText.match(/^(?:đáp án|đáp số|kết quả)\s*(?:đúng\s*là|là)?[\s\:\.]+(.+)$/i);
          if (m && m[1].trim().length <= 80) {
            directAnswerText = m[1].trim().replace(/\.$/, '');
            break;
          }
        }
      }

      // Với q_type 18 (Đoạn văn tự kiểm tra / Tự luận):
      if (!directAnswerText && String(q.q_type || q.type || '') === '18') {
        const $expRoot = $fullNorm('.exp-in').length ? $fullNorm('.exp-in').first() : $fullNorm('.exp, .explanation, .giai-chi-tiet').first();
        if ($expRoot && $expRoot.length) {
          const clone = $expRoot.clone();
          clone.find('h3, h4, svg, script, style, img').remove();
          const paragraphs = [];
          clone.find('p, li').each((_, el) => {
            const t = cleanText($fullNorm(el).text());
            if (t && !/^hướng dẫn giải[\s:]*$/i.test(t)) {
              paragraphs.push(t);
            }
          });
          if (paragraphs.length > 0) {
            directAnswerText = paragraphs.join('\n');
          } else {
            const fb = cleanText(clone.text()).replace(/^hướng dẫn giải[\s:]*/i, '').trim();
            if (fb) directAnswerText = fb;
          }
        }
      }
    }

    // 4. Trích xuất lời giải chi tiết (nếu có)
    const exp = cleanText($fullNorm('.exp, .explanation, .giai-chi-tiet').text());

    result.push({
      index: idx,
      id: q.id,
      stem,
      options,
      correctIndices,
      correctIndex: directCorrectIndex,
      correctTexts,
      correctText: directAnswerText,
      answer: directAnswerText,
      answers: fillAnswers.length > 0 ? fillAnswers : (correctTexts.length > 0 ? correctTexts : (directAnswerText ? [directAnswerText] : [])),
      fillAnswers: fillAnswers.length > 0 ? fillAnswers : null,
      selectTextAnswers: selectTextAnswers.length > 0 ? selectTextAnswers : null,
      linkPairs: linkPairs && linkPairs.length > 0 ? linkPairs : null,
      groups: groups && groups.length > 0 ? groups : null,
      sortItems: sortItems && sortItems.length > 0 ? sortItems : null,
      isLinkList: Boolean(linkPairs && linkPairs.length > 0),
      isGroupList: Boolean(groups && groups.length > 0),
      isSortList: Boolean(sortItems && sortItems.length > 0),
      isUnderline,
      subQuestions,
      explanation: exp,
      rawHtml: html,
      qType: String(q.q_type || q.type || '1'),
    });
  }

  return result;
}

module.exports = {
  XOR_KEY,
  xorBinaryWithKey,
  xorDecodeBase64,
  cleanText,
  extractPrimaryPipeVariant,
  decodeQuestionsPayload,
};
