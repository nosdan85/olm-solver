'use strict';

// Hỗ trợ các dạng câu hỏi mở rộng của OLM ngoài trắc nghiệm/điền khuyết:
//   - Dropdown (chọn từ menu thả xuống)
//   - Kéo-thả vào ô trống (drag & drop)
//   - Gom nhóm / phân loại (grouping / classify)
//   - Ghép đôi / nối cột (matching)
//   - Chọn vị trí trên hình (hotspot)
//   - Gạch chân / chọn từ trong đoạn (underline / word select)
//   - Tự luận (essay / paragraph)
//
// OLM dùng Shadow DOM rất nhiều (default-root > type-*-mobile), nên mọi truy vấn
// phải đi xuyên qua các open shadow root. File này gom phần dò kiểu dạng + phần
// điền đáp án cho các dạng này.

// ---------------------------------------------------------------------------
// DOM helpers (chạy trong ngữ cảnh trang, phải tự chứa, không dùng biến ngoài)
// ---------------------------------------------------------------------------

// Thu thập mọi open shadow root bên trong một element.
function collectShadowRoots(el, out = [], depth = 0) {
  if (!el || !el.querySelectorAll || depth > 12) return out;
  for (const node of el.querySelectorAll('*')) {
    if (node.shadowRoot) {
      out.push(node.shadowRoot);
      collectShadowRoots(node.shadowRoot, out, depth + 1);
    }
  }
  return out;
}

// Tìm phần tử đầu tiên khớp selector, xuyên qua mọi open shadow root.
function deepQuery(root, selector) {
  try {
    const direct = root.querySelector(selector);
    if (direct) return direct;
  } catch {}
  const roots = collectShadowRoots(root);
  for (const sr of roots) {
    try {
      const found = sr.querySelector(selector);
      if (found) return found;
    } catch {}
  }
  return null;
}

// Thu thập TẤT CẢ phần tử khớp selector (kể cả trong shadow root).
function deepQueryAll(root, selector) {
  const out = [];
  try {
    out.push(...Array.from(root.querySelectorAll(selector)));
  } catch {}
  const roots = collectShadowRoots(root);
  for (const sr of roots) {
    try {
      out.push(...Array.from(sr.querySelectorAll(selector)));
    } catch {}
  }
  // Loại bỏ trùng lặp
  return Array.from(new Set(out));
}

// Gộp các element đang hiển thị được.
function isVisible(el) {
  if (!el) return false;
  try {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return false;
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  } catch {
    return false;
  }
}

// Lấy text thực của một element (bỏ khoảng trắng thừa).
function elText(el) {
  if (!el) return '';
  return (el.innerText || el.textContent || '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/\s*=/g, '≠')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// NHẬN DIỆN DẠNG CÂU HỎI
// ---------------------------------------------------------------------------

// Chạy trong trang. Trả về descriptor dạng câu hỏi, hoặc null nếu không khớp
// dạng nào trong nhóm mở rộng.
function detectInPage(index) {
  const item = document.querySelectorAll('.itemx.q-view-itemx.question')[index] ||
    document.getElementById('user-test-' + index) || document.querySelectorAll('.quizx.question-hold')[index] ||
    document.querySelectorAll('default-root')[index];
  const scope = item || document.querySelector('default-root') || document;
  const root = scope.shadowRoot || scope;

  const txt = (el) => elText(el);

  // --- 1. Dropdown: <select> native hoặc hộp có mũi tên ▼ ---
  const selects = deepQueryAll(root, 'select').filter(isVisible);
  if (selects.length) {
    const sel = selects[0];
    const options = Array.from(sel.options || []).map((o) => elText(o)).filter(Boolean);
    // Bỏ option rỗng placeholder đầu tiên nếu có
    const cleaned = options.filter((o) => o && o !== '--' && o !== 'Chọn');
    const stem = txt(sel.closest('.question-content, .question, [class*=question]')) ||
                 txt(deepQuery(root, '.question-content'));
    return {
      type: 'dropdown',
      text: stem,
      options: cleaned.length ? cleaned : options,
      selectCount: selects.length,
    };
  }

  // Dropdown tuần dựng (div + mũi tên), không phải <select>
  const caretEls = deepQueryAll(root, '[class*=dropdown], [class*=select-box], [class*=tw-select], .qselect-dropdown').filter(isVisible);
  for (const el of caretEls) {
    const opts = deepQueryAll(el, '[role=option], .dropdown-item, .option-item, li').filter(isVisible);
    if (opts.length >= 2) {
      return {
        type: 'dropdown',
        text: txt(el.closest('.question-content, .question')) || txt(deepQuery(root, '.question-content')),
        options: opts.map(txt).filter(Boolean),
        customDropdown: true,
      };
    }
  }

  // --- 2. Kéo-thả / Gom nhóm: phần tử draggable ---
  const draggables = deepQueryAll(root, '[draggable="true"], [data-draggable], .tw-drag-item, .drag-item, .sortable-item, .qdrag').filter(isVisible);
  if (draggables.length >= 2) {
    // Gom nhóm: có các hộp đích riêng biệt (dạng .group-box / .dropzone / .category)
    const zones = deepQueryAll(root, '[data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup').filter(isVisible);
    const isGrouping = zones.length >= 2 && /nhóm|phân loại|gom nhóm|group|categor|danh mục/i.test(
      txt(root) + ' ' + zones.map(txt).join(' ')
    );
    const stem = txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400);
    return {
      type: isGrouping ? 'grouping' : 'drag_drop',
      text: stem,
      items: draggables.map(txt).filter(Boolean),
      targets: zones.map(txt).filter(Boolean),
      draggableCount: draggables.length,
      zoneCount: zones.length,
    };
  }

  // --- 2b. OLM modern type-drag-text (điền từ vào chỗ trống) ---
  const dragTextComp = deepQuery(root, 'type-drag-text');
  if (dragTextComp) {
    return {
      type: 'drag_text',
      text: txt(dragTextComp) || 'Complete the sentences using the words and phrases given.',
      compTag: 'type-drag-text',
    };
  }

  // --- 2c. OLM modern type-fill-me (điền khuyết) ---
  const fillMeComp = deepQuery(root, 'type-fill-me, type-fill-me-mobile');
  if (fillMeComp) {
    return {
      type: 'fill_me',
      text: txt(fillMeComp) || 'Complete the sentence using the correct form of the word.',
      compTag: 'type-fill-me',
    };
  }

  // --- 3. Ghép đôi / nối cột: hai cột + các chấm tròn nhỏ hoặc boxlink ---
  const boxLefts = deepQueryAll(root, '.boxlink.left');
  const boxRights = deepQueryAll(root, '.boxlink.right');
  if (boxLefts.length > 0 && boxRights.length > 0) {
    return {
      type: 'matching',
      subType: 'boxlink',
      text: txt(deepQuery(root, '.question-content, #paragraph, type-link-list')) || 'Match the words with the definitions.',
      left: boxLefts.map(txt).filter(Boolean),
      right: boxRights.map(txt).filter(Boolean),
      boxCount: boxLefts.length,
    };
  }

  const pairDots = deepQueryAll(root, '[class*=pair-dot], [class*=match-dot], [class*=connect-dot], [class*=line-dot], [data-pair], [data-match]').filter(isVisible);
  if (pairDots.length >= 2) {
    const left = deepQueryAll(root, '[class*=col-a], [class*=column-a], [class*=left-col], [data-col="A"]').filter(isVisible);
    const right = deepQueryAll(root, '[class*=col-b], [class*=column-b], [class*=right-col], [data-col="B"]').filter(isVisible);
    const leftItems = (left.length ? left : deepQueryAll(root, '[class*=match-item], [class*=pair-item]')).filter(isVisible);
    const rightItems = (right.length ? right : []).filter(isVisible);
    return {
      type: 'matching',
      text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
      left: leftItems.map(txt).filter(Boolean),
      right: rightItems.map(txt).filter(Boolean),
      dotCount: pairDots.length,
    };
  }

  // --- 4. Hotspot: ảnh lớn + lớp con dạng vùng nhấn ---
  const hotspotZones = deepQueryAll(root, '[class*=hotspot], [data-hotspot], [class*=click-area], [class*=target-zone], [class*=answer-area]').filter(isVisible);
  const bigImg = deepQueryAll(root, 'img, canvas').filter((el) => {
    if (!isVisible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 200 && r.height > 150;
  })[0];
  if ((hotspotZones.length >= 1 && bigImg) || (hotspotZones.length >= 4)) {
    return {
      type: 'hotspot',
      text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
      zones: hotspotZones.map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: txt(el),
          x: (r.left + r.width / 2) / window.innerWidth,
          y: (r.top + r.height / 2) / window.innerHeight,
          width: r.width / window.innerWidth,
          height: r.height / window.innerHeight,
        };
      }),
    };
  }

  // --- 5. Gạch chân / chọn từ trong đoạn văn ---
  const wordEls = deepQueryAll(root, '[class*=underline], [class*=word-select], [class*=highlight-word], [data-word], [class*=token]').filter(isVisible);
  if (wordEls.length >= 2) {
    const stem = txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400);
    return {
      type: 'word_select',
      text: stem,
      words: wordEls.map(txt).filter(Boolean),
    };
  }

  // --- 6. Tự luận: contenteditable / textarea / iframe soạn thảo ---
  const editors = deepQueryAll(root, '[contenteditable="true"], textarea, .ProseMirror, .ql-editor, [class*=rich-text], [class*=editor], [contenteditable]').filter(isVisible);
  if (editors.length) {
    const stem = txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400);
    return {
      type: 'essay',
      text: stem,
      hasAttachment: deepQueryAll(root, '[class*=upload], [class*=attach], input[type=file], [class*=image-upload]').length > 0,
    };
  }

  // --- 7. Sắp xếp từ / thứ tự (Rearrange / Word Order - q_type: 3, 9) ---
  const orderComp = deepQuery(root, 'type-order, type-order-mobile, type-rearrange, .sortable-list, .word-pool, .source-words');
  if (orderComp) {
    const wordItems = deepQueryAll(root, '.word-item, .sortable-item, .qdrag, .source-words button, .word-pool button').filter(isVisible);
    if (wordItems.length >= 2) {
      return {
        type: 'rearrange',
        text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
        words: wordItems.map(txt).filter(Boolean),
      };
    }
  }

  // --- 8. Luyện nói / Ghi âm (Speaking / Recording - q_type: 10, 15) ---
  const speakComp = deepQuery(root, 'type-speaking, type-record, .speaking-prompt, .btn-record, [data-action="record"], .mic-icon');
  if (speakComp) {
    const prompt = txt(deepQuery(root, '.speaking-prompt, .target-sentence, .question-content, #paragraph'));
    return {
      type: 'speaking',
      text: prompt,
      prompt,
    };
  }

  // --- 9. Ô chữ / Tìm từ (Crossword & Word Search - q_type: 16) ---
  const cwGrid = deepQuery(root, 'table.crossword-grid, .cw-cell, .word-search-grid, .ws-cell');
  if (cwGrid) {
    const isCrossword = !!deepQuery(root, 'table.crossword-grid, .cw-cell');
    return {
      type: isCrossword ? 'crossword' : 'word_search',
      text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
      isCrossword,
    };
  }

  // --- 10. Trình soạn thảo Code (Code Editor - q_type: 19) ---
  const codeEditor = deepQuery(root, '.cm-editor, .cm-content, .ace_editor, .monaco-editor');
  if (codeEditor) {
    return {
      type: 'code_editor',
      text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
    };
  }

  // --- 11. Trả lời ngắn số THPT (Strict Numerical Short Answer - q_type: 2, 14) ---
  const shortNumInput = deepQuery(root, 'type-short-answer input, input.short-ans-input');
  if (shortNumInput) {
    return {
      type: 'strict_short_answer',
      text: txt(deepQuery(root, '.question-content, #paragraph')) || txt(root).slice(0, 400),
      pattern: shortNumInput.getAttribute('pattern') || '',
      placeholder: shortNumInput.getAttribute('placeholder') || '',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ĐIỀN ĐÁP ÁN CHO CÁC DẠNG MỞ RỘNG
// ---------------------------------------------------------------------------

function getQuestionIndex(question) {
  return Number.isSafeInteger(question?.index) && question.index >= 0 ? question.index : 0;
}

// Click the selected element once.
async function clickEl(page, handle) {
  try {
    await handle.click({ delay: 30 });
  } catch {
    try {
      await page.evaluate((el) => {
        el.click();
      }, handle);
    } catch {}
  }
}

// --- Dropdown ---
async function fillDropdown(page, question, answer) {
  const targetText = String(answer.answer ?? '').trim();
  const targetIdx = Number.isInteger(answer.correctIndex) && answer.correctIndex >= 0 ? answer.correctIndex : -1;

  // Chuẩn hóa Unicode NFC chống lệch bảng mã tiếng Việt
  const norm = (s) => String(s || '').trim().normalize('NFC').toLowerCase();

  // Ưu tiên <select> native: set value + fire change.
  const native = await page.evaluate(({ text, idx, questionIndex }) => {
    const normVi = (s) => String(s || '').trim().normalize('NFC').toLowerCase();
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[questionIndex] ||
      document.getElementById('user-test-' + questionIndex) || document.querySelectorAll('.quizx.question-hold')[questionIndex];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try { all.push(...Array.from(r.querySelectorAll('select'))); } catch {}
      try {
        for (const n of r.querySelectorAll('*')) {
          if (n.shadowRoot) walk(n.shadowRoot);
        }
      } catch {}
    };
    walk(root);
    const sel = all.find((s) => s.offsetWidth > 0 || s.offsetHeight > 0);
    if (!sel) return { ok: false, reason: 'no-native-select' };

    const opts = Array.from(sel.options);
    let target = -1;
    if (text) target = opts.findIndex(o => normVi(o.textContent) === normVi(text));
    const usable = opts.filter(o => !o.disabled && !['', '--', 'chọn'].includes(normVi(o.textContent)));
    if (target < 0 && idx >= 0 && idx < usable.length) target = opts.indexOf(usable[idx]);
    if (target < 0 && text) {
      target = opts.findIndex((o) => {
        const ot = normVi(o.textContent);
        const nt = normVi(text);
        return ot.includes(nt) || nt.includes(ot);
      });
    }
    if (target < 0) return { ok: false, reason: 'option-not-found' };

    sel.value = opts[target].value;
    sel.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, selectedIndex: target, value: sel.value };
  }, { text: targetText, idx: targetIdx, questionIndex: question.index || 0 });

  if (native.ok) return native;

  // Dropdown tuần dựng: click để mở, rồi click option.
  const custom = await page.evaluate(({ text, idx, questionIndex }) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[questionIndex] ||
      document.getElementById('user-test-' + questionIndex) || document.querySelectorAll('.quizx.question-hold')[questionIndex];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[class*=dropdown], [class*=select-box], [class*=tw-select], .qselect-dropdown')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const box = all.find((s) => s.offsetWidth > 0 || s.offsetHeight > 0);
    if (!box) return { ok: false, reason: 'no-dropdown' };
    box.click();
    return { ok: true, opened: true };
  }, { text: targetText, idx: targetIdx, questionIndex: question.index || 0 });

  if (!custom.ok) return custom;

  await new Promise((r) => setTimeout(r, 400));

  const picked = await page.evaluate(({ text, idx, questionIndex }) => {
    const normVi = (s) => String(s || '').trim().normalize('NFC').toLowerCase();
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[questionIndex] ||
      document.getElementById('user-test-' + questionIndex) || document.querySelectorAll('.quizx.question-hold')[questionIndex];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[role=option], .dropdown-item, .option-item, [class*=dropdown-item], li')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const opts = all.filter((o) => {
      const r = o.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!opts.length) return { ok: false, reason: 'no-options-opened' };

    let target = -1;
    if (idx >= 0 && idx < opts.length) target = idx;
    if (target < 0) {
      target = opts.findIndex((o) => normVi(o.innerText) === normVi(text));
    }
    if (target < 0 && text) {
      target = opts.findIndex((o) => {
        const ot = normVi(o.innerText);
        const nt = normVi(text);
        return ot.includes(nt) || nt.includes(ot);
      });
    }
    if (target < 0) return { ok: false, reason: 'option-not-found' };

    const opt = opts[target];
    opt.click();
    return { ok: true, selectedIndex: target };
  }, { text: targetText, idx: targetIdx, questionIndex: question.index || 0 });

  return picked;
}

// --- Kéo thả / Gom nhóm ---
async function fillDragDrop(page, question, answer) {
  const mapping = Array.isArray(answer.mapping) ? answer.mapping : [];
  if (!mapping.length) return { ok: false, reason: 'no-mapping' };

  const qIndex = getQuestionIndex(question);

  // Lấy danh sách thẻ nguồn và các ô đích từ DOM (theo thứ tự hiển thị).
  const boxes = await page.evaluate((idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[draggable="true"], [data-draggable], .tw-drag-item, .drag-item, .sortable-item, .qdrag, [data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const visible = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    return visible.map((el, index) => {
      el.setAttribute('data-olm-audit-drag', String(index));
      const r = el.getBoundingClientRect();
      return {
        id: String(index),
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        isZone: el.matches('[data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup'),
      };
    });
  }, qIndex);

  if (!boxes.length) return { ok: false, reason: 'no-drag-elements' };

  const sources = boxes.filter((b) => !b.isZone);
  const zones = boxes.filter((b) => b.isZone);

  const placement = (src, target) => page.evaluate(({ source, zone, text }) => {
    let sourceNode, targetNode;
    const collect = (root) => {
      for (const element of root.querySelectorAll('*')) {
        if (element.getAttribute('data-olm-audit-drag') === source) sourceNode = element;
        if (element.getAttribute('data-olm-audit-drag') === zone) targetNode = element;
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    };
    collect(document);
    if (!targetNode) return false;
    return Boolean(sourceNode && targetNode.contains(sourceNode)) ||
      Boolean(text && Array.from(targetNode.children).some((node) => (node.innerText || '').trim() === text));
  }, { source: src.id, zone: target.id, text: src.text });

  let placed = 0;
  for (const m of mapping) {
    const itemIdx = Number(m.item);
    const targetIdx = Number(m.target);
    if (!Number.isInteger(itemIdx) || !Number.isInteger(targetIdx)) continue;

    const src = sources[itemIdx];
    const zone = zones[targetIdx] || boxes.find((b) => b.text === (question.targets || [])[targetIdx]);
    if (!src || !zone) continue;
    if (await placement(src, zone)) { placed++; continue; }

    // Kéo thả chuột nâng cao: delay 100ms, nhích 5px kích hoạt threshold, 20 steps di chuyển
    try {
      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 100));
      // Nhích nhẹ 5px để kích hoạt threshold của SortableJS / jQuery UI
      await page.mouse.move(src.x + 5, src.y + 5);
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          src.x + 5 + ((zone.x - (src.x + 5)) * i) / steps,
          src.y + 5 + ((zone.y - (src.y + 5)) * i) / steps
        );
      }
      await page.mouse.move(zone.x, zone.y);
      await new Promise((r) => setTimeout(r, 100));
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 200));
      if (await placement(src, zone)) { placed++; continue; }
    } catch {
      await page.mouse.up().catch(() => {});
    }

    // Dự phòng HTML5 DragEvent với DataTransfer dùng chung
    try {
      await page.evaluate(({ si, ti, idx }) => {
        const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
          document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
          document.querySelectorAll('default-root')[idx];
        const scope = item || document.querySelector('default-root') || document;
        const root = scope.shadowRoot || scope;
        const all = [];
        const walk = (r) => {
          try {
            all.push(...Array.from(r.querySelectorAll('[draggable="true"], [data-draggable], .tw-drag-item, .drag-item, .sortable-item, .qdrag, [data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup')));
          } catch {}
          try {
            for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
          } catch {}
        };
        walk(root);
        const visible = all.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        });
        const sources = visible.filter((el) => !el.matches('[data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup'));
        const zones = visible.filter((el) => el.matches('[data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup'));
        const src = sources[si];
        const tgt = zones[ti];
        if (!src || !tgt) return;
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, 'dragstart');
        fire(tgt, 'dragenter');
        fire(tgt, 'dragover');
        fire(tgt, 'drop');
        fire(src, 'dragend');
      }, { si: itemIdx, ti: targetIdx, idx: qIndex });
      if (await placement(src, zone)) placed++;
    } catch {}
  }

  if (placed !== mapping.length) return { ok: false, reason: 'drag-unconfirmed', placed };
  return { ok: true, placed };
}

// --- Ghép đôi / Nối cột (q_type: 5) ---
async function fillMatching(page, question, answer) {
  // 1. Hỗ trợ dạng nối cột hiện đại của OLM (<type-link-list> / .boxlink.left & .boxlink.right)
  const boxlinkRes = await page.evaluate(async () => {
    function getAllDeep(sel, root = document) {
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch {}
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot)); } catch {}
        }
      }
      return Array.from(new Set(results));
    }
    const boxLefts = getAllDeep('.boxlink.left');
    const boxRights = getAllDeep('.boxlink.right');
    if (boxLefts.length === 0 || boxRights.length === 0) return { matched: 0 };

    const lines = () => getAllDeep('svg line, svg polyline, [data-connected="true"], .boxlink.connected').length;
    let count = 0;
    for (let i = 0; i < boxLefts.length; i++) {
      const l = boxLefts[i];
      const r = boxRights.find(x => x.id && x.id === l.id);
      if (r) {
        const previous = lines();
        l.click();
        await new Promise(res => setTimeout(res, 250));
        r.click();
        await new Promise(res => setTimeout(res, 250));
        if (lines() > previous) count++;
      }
    }
    return { matched: count, total: boxLefts.length };
  });

  if (boxlinkRes?.matched > 0 && boxlinkRes.matched === boxlinkRes.total) {
    return { ok: true, paired: boxlinkRes.matched };
  }

  const pairs = Array.isArray(answer.pairs) ? answer.pairs : [];
  if (!pairs.length) return { ok: false, reason: 'no-pairs' };

  // Cơ chế Click-to-Connect: Click chấm ở cột A -> chờ 150ms -> Click chấm ở cột B
  const qIndex = getQuestionIndex(question);
  const dots = await page.evaluate((idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[class*=pair-dot], [class*=match-dot], [class*=connect-dot], [class*=line-dot], [data-pair], [data-match], [class*=dot]')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const visible = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });
    return visible.map((el) => {
      const r = el.getBoundingClientRect();
      const half = window.innerWidth / 2;
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        side: r.left < half ? 'A' : 'B',
      };
    });
  }, qIndex);

  if (dots.length < 2) return { ok: false, reason: 'no-pair-dots' };

  const sideA = dots.filter((d) => d.side === 'A');
  const sideB = dots.filter((d) => d.side === 'B');

  const connections = () => page.evaluate(() => {
    const count = (root) => root.querySelectorAll('svg line, svg polyline, [data-connected="true"]').length +
      Array.from(root.querySelectorAll('*')).reduce((total, node) => total + (node.shadowRoot ? count(node.shadowRoot) : 0), 0);
    return count(document);
  });

  let paired = 0;
  for (const p of pairs) {
    const li = Number(p.left);
    const ri = Number(p.right);
    if (!Number.isInteger(li) || !Number.isInteger(ri)) continue;
    const a = sideA[li] || dots[li];
    const b = sideB[ri] || dots[sideA.length + ri];
    if (!a || !b) continue;
    try {
      const before = await connections();
      await page.mouse.click(a.x, a.y);
      await new Promise((r) => setTimeout(r, 150));
      await page.mouse.click(b.x, b.y);
      await new Promise((r) => setTimeout(r, 200));
      if (await connections() > before) paired++;
    } catch {}
  }

  if (paired !== pairs.length) return { ok: false, reason: 'pair-unconfirmed', paired };
  return { ok: true, paired };
}

// --- Điền từ dạng Drag-Text (<type-drag-text>) ---
async function fillDragText(page, question, answer) {
  const qIndex = getQuestionIndex(question);
  const res = await page.evaluate(async (targetAns, idx) => {
    function getAllDeep(sel, root = document) {
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch {}
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot)); } catch {}
        }
      }
      return Array.from(new Set(results));
    }
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const searchRoot = item ? (item.shadowRoot || item) : document;
    const comps = getAllDeep('type-drag-text', searchRoot);
    const comp = item ? comps[0] : (comps[idx] || comps[0]);
    if (!comp) return { ok: false, reason: 'comp-not-found' };

    const correctMap = comp.answerCorrect || {};
    const bankWords = Array.from(comp.renderRoot?.querySelectorAll('.item-drag .drag-select') || []);
    const blanks = Array.from(comp.renderRoot?.querySelectorAll('.dragtext[name=dragtext][ind]') || []);

    const filled = [];
    for (const [blankInd, wordId] of Object.entries(correctMap)) {
      const blank = blanks.find(b => b.getAttribute('ind') === blankInd);
      const word = bankWords.find(w => w.getAttribute('data-id') === String(wordId));
      if (blank && word) {
        blanks.forEach(b => b.classList.remove('selectpoint'));
        blank.classList.add('selectpoint');
        word.click();
        filled.push({ blankInd, word: word.innerText.trim() });
        await new Promise(res => setTimeout(res, 250));
      }
    }
    return { ok: filled.length > 0, filled };
  }, answer.answer, qIndex);

  return res;
}

// --- Điền khuyết hiện đại (<type-fill-me>) ---
async function fillFillMe(page, question, answer) {
  const cleanVal = String(answer.answer || '').trim();
  const qIndex = getQuestionIndex(question);
  const res = await page.evaluate(async (targetAns, idx) => {
    function getAllDeep(sel, root = document) {
      let results = [];
      try { results.push(...Array.from(root.querySelectorAll(sel))); } catch {}
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.shadowRoot) {
          try { results.push(...getAllDeep(sel, n.shadowRoot)); } catch {}
        }
      }
      return Array.from(new Set(results));
    }
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const searchRoot = item ? (item.shadowRoot || item) : document;
    const comps = getAllDeep('type-fill-me, type-fill-me-mobile', searchRoot);
    const comp = item ? comps[0] : (comps[idx] || comps[0]);
    if (!comp) return { ok: false, reason: 'type-fill-me-not-found' };

    const input = comp.shadowRoot?.querySelector('#fillme-input input, input[placeholder="?"]');
    if (input) {
      input.value = targetAns;
      input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    comp.userAnswer = { '0': targetAns };
    return { ok: true, userAnswer: comp.userAnswer };
  }, cleanVal, qIndex);

  return res;
}

// --- Điểm nóng ảnh (Hotspot - q_type: 11) ---
async function fillHotspot(page, question, answer) {
  const qIndex = getQuestionIndex(question);
  // Cuộn ảnh vào giữa màn hình trước khi tính tọa độ Viewport (tránh lệch tọa độ CDP mouse.click)
  await page.evaluate((idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const img = root.querySelector('img.hotspot-img, img.question-img, img, canvas') || document.querySelector('img.hotspot-img, img.question-img, img, canvas');
    if (img) img.scrollIntoView({ behavior: 'instant', block: 'center' });
  }, qIndex).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));

  const zones = await page.evaluate((idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[class*=hotspot], [data-hotspot], [class*=click-area], [class*=target-zone], [class*=answer-area]')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    return all
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
        };
      });
  }, qIndex);

  if (!zones.length) return { ok: false, reason: 'no-hotspot-zones' };

  const desc = String(answer.answer || '').trim().toLowerCase();
  let target = -1;
  if (desc) {
    target = zones.findIndex((z) => z.text && desc.includes(z.text.toLowerCase()));
    if (target < 0) {
      target = zones.findIndex((z) => z.text && z.text.toLowerCase().includes(desc));
    }
  }
  if (target < 0 && answer.box && typeof answer.box === 'object') {
    const b = answer.box;
    let vw = 1366;
    let vh = 900;
    try {
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      vw = vp.w || vw;
      vh = vp.h || vh;
    } catch {}
    const rx = (b.x || 0) * vw;
    const ry = (b.y || 0) * vh;
    let best = -1;
    let bestDist = Infinity;
    zones.forEach((z, i) => {
      const d = Math.abs(z.x - rx) + Math.abs(z.y - ry);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    target = best;
  }
  if (target < 0) target = 0;

  const z = zones[target];
  try {
    await page.mouse.click(z.x, z.y);
  } catch {
    return { ok: false, reason: 'hotspot-click-failed' };
  }
  await new Promise((r) => setTimeout(r, 200));
  return { ok: true, zone: target };
}

// --- Gạch chân / chọn từ (q_type: 8) ---
async function fillWordSelect(page, question, answer) {
  const idxs = Array.isArray(answer.correctIndices)
    ? answer.correctIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
    : [];
  if (!idxs.length) return { ok: false, reason: 'no-word-indices' };

  // Kiểm tra trạng thái isSelected !== shouldSelect trước khi click
  const qIndex = getQuestionIndex(question);
  const res = await page.evaluate((targetIndices, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('span.word, [class*=underline], [class*=word-select], [class*=highlight-word], [data-word], [class*=token]')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const wordEls = all.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    });

    if (!wordEls.length) return { ok: false, reason: 'no-word-elements' };

    const targetSet = new Set(targetIndices);
    let changed = 0;
    wordEls.forEach((el, i) => {
      const shouldSelect = targetSet.has(i);
      const isSelected = el.classList.contains('selected') || el.classList.contains('underlined') || el.classList.contains('active') || el.classList.contains('tw-selected');
      if (shouldSelect !== isSelected) {
        el.click();
        changed++;
      }
    });
    return { ok: changed > 0 || targetSet.size > 0, changed };
  }, idxs, qIndex);

  return res;
}

// --- Tự luận Lexical / Editor (q_type: 18) ---
async function fillEssay(page, question, answer) {
  const essayText = String(answer.answer || '').trim();
  if (!essayText) return { ok: false, reason: 'no-essay-text' };

  const qIndex = getQuestionIndex(question);
  const placeholderSel = 'textarea.typing-para, textarea.text-para, type-paragraph, type-paragraph-mobile, div[data-placeholder]';
  const editorSelector = 'div[contenteditable="true"][data-lexical-editor="true"], type-paragraph div[contenteditable="true"], type-paragraph-mobile div[contenteditable="true"], div.ContentEditable__root';

  // 1. Click mở khung soạn thảo nếu vẫn đang ở trạng thái placeholder (hỗ trợ Shadow DOM)
  await page.evaluate((idx, sel) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const walkFind = (r) => {
      try {
        const direct = r.querySelector(sel);
        if (direct) return direct;
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) {
          if (n.shadowRoot) {
            const found = walkFind(n.shadowRoot);
            if (found) return found;
          }
        }
      } catch {}
      return null;
    };
    const ph = walkFind(root);
    if (ph) ph.click();
  }, qIndex, placeholderSel).catch(() => {});

  // 2. Chờ Lexical Editor thực sự mount vào DOM (kể cả trong Shadow DOM) và focus/click vào nó
  const editorBox = await (async () => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const box = await page.evaluate((idx, sel) => {
        const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
          document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
          document.querySelectorAll('default-root')[idx];
        const scope = item || document.querySelector('default-root') || document;
        const root = scope.shadowRoot || scope;
        const walkFind = (r) => {
          try {
            const direct = r.querySelector(sel);
            if (direct) return direct;
          } catch {}
          try {
            for (const n of r.querySelectorAll('*')) {
              if (n.shadowRoot) {
                const found = walkFind(n.shadowRoot);
                if (found) return found;
              }
            }
          } catch {}
          return null;
        };
        const el = walkFind(root);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        el.focus();
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        } catch {}
        return rect.width > 0 && rect.height > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : { x: 0, y: 0 };
      }, qIndex, editorSelector).catch(() => null);
      if (box) return box;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  })();

  if (editorBox && editorBox.x > 0 && editorBox.y > 0) {
    await page.mouse.click(editorBox.x, editorBox.y).catch(() => {});
  }

  // 3. Chèn toàn bộ đoạn văn tức thì qua CDP Input.insertText (Lexical bắt sự kiện này chuẩn 100%)
  try {
    const client = await page.target().createCDPSession();
    try {
      await client.send('Input.insertText', { text: essayText });
    } finally {
      await client.detach().catch(() => {});
    }
  } catch {
    await page.keyboard.type(essayText, { delay: 10 }).catch(() => {});
  }

  // 4. Đợi 200ms rồi bấm nút #btn-done nằm TRONG phạm vi câu tự luận đó để lưu bài
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate((idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const walkFind = (r, sel) => {
      try {
        const direct = r.querySelector(sel);
        if (direct) return direct;
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) {
          if (n.shadowRoot) {
            const found = walkFind(n.shadowRoot, sel);
            if (found) return found;
          }
        }
      } catch {}
      return null;
    };
    const doneBtn = walkFind(root, 'type-paragraph #btn-done, type-paragraph-mobile #btn-done, #btn-done');
    if (doneBtn && (doneBtn.offsetParent !== null || doneBtn.offsetWidth > 0 || doneBtn.offsetHeight > 0)) {
      doneBtn.click();
    }
  }, qIndex).catch(() => {});

  return { ok: true, method: 'lexical-cdp' };
}

// --- Sắp xếp từ / thứ tự (Rearrange / Word Order - q_type: 3, 9) ---
async function fillRearrange(page, question, answer) {
  const targetWords = Array.isArray(answer.words)
    ? answer.words
    : String(answer.answer || answer.correctText || '').trim().split(/\s+/);
  if (!targetWords.length) return { ok: false, reason: 'no-target-words' };

  const qIndex = getQuestionIndex(question);
  return page.evaluate((words, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const norm = (s) => String(s || '').trim().normalize('NFC').toLowerCase().replace(/[.,!?;:]/g, '');

    const pool = root.querySelector('.word-pool, .source-words, .box-words, type-order, type-order-mobile, type-rearrange') || root;
    const poolBtns = Array.from(pool.querySelectorAll('.word-item, .qdrag, button, .sortable-item, [data-word]'));

    let clicked = 0;
    for (const w of words) {
      const nw = norm(w);
      const btn = poolBtns.find((b) => {
        if (b.classList.contains('used') || b.classList.contains('disabled') || b.disabled) return false;
        return norm(b.innerText || b.textContent || '') === nw;
      });
      if (btn) {
        btn.click();
        btn.classList.add('used');
        clicked++;
      }
    }
    return { ok: clicked > 0, clicked, total: words.length };
  }, targetWords, qIndex);
}

// --- Luyện nói / Ghi âm (Speaking / Recording - q_type: 10, 15) ---
async function fillSpeaking(page, question, answer) {
  const targetText = String(answer.answer || question.prompt || '').trim();
  const qIndex = getQuestionIndex(question);
  return page.evaluate(async (text, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;

    const walkFind = (r, sel) => {
      try {
        const direct = r.querySelector(sel);
        if (direct) return direct;
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) {
          if (n.shadowRoot) {
            const found = walkFind(n.shadowRoot, sel);
            if (found) return found;
          }
        }
      } catch {}
      return null;
    };

    const component = walkFind(root, 'type-speaking, type-record, type-speaking-mobile, type-record-mobile');
    if (typeof component?.setTranscript === 'function') {
      if (!text) return { ok: false, reason: 'empty-transcript' };
      const result = await component.setTranscript(text);
      const actual = component.transcript ?? component.userAnswer;
      return result === true || actual === text
        ? { ok: true, text }
        : { ok: false, reason: 'transcript-unconfirmed' };
    }

    const searchRoot = component?.shadowRoot || component || root;
    const micBtn = walkFind(
      searchRoot,
      '.btn-record, [data-action="record"], .mic-icon, button[class*="record"], button[class*="mic"], button[aria-label*="record" i], button[aria-label*="mic" i]'
    );
    if (micBtn) {
      micBtn.click();
      return { ok: true, method: 'mic-click', text };
    }
    return { ok: false, reason: text ? 'transcript-unsupported' : 'empty-transcript' };
  }, targetText, qIndex);
}

// --- Ô chữ / Tìm từ (Crossword & Word Search - q_type: 16) ---
async function fillCrossword(page, question, answer) {
  const data = answer.grid || answer.answer || '';
  const qIndex = getQuestionIndex(question);
  return page.evaluate((d, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const inputs = Array.from(root.querySelectorAll('table.crossword-grid input.cw-cell, .cw-cell, input[data-row]'));
    if (!inputs.length) return { ok: false, reason: 'no-crossword-inputs' };

    let filled = 0;
    if (Array.isArray(d)) {
      d.forEach((cell) => {
        const inp = inputs.find((i) => i.getAttribute('data-row') == cell.r && i.getAttribute('data-col') == cell.c);
        if (inp) {
          inp.value = String(cell.char || '').toUpperCase();
          inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          filled++;
        }
      });
    }
    return { ok: filled > 0, filled };
  }, data, qIndex);
}

// --- Trình soạn thảo Code (Code Editor - q_type: 19) ---
async function fillCodeEditor(page, question, answer) {
  const code = String(answer.code || answer.answer || '').trim();
  if (!code) return { ok: false, reason: 'no-code-provided' };

  const qIndex = getQuestionIndex(question);
  return page.evaluate((codeText, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const cm = root.querySelector('.cm-content');
    if (cm) {
      cm.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', codeText);
      cm.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      return { ok: true, type: 'codemirror' };
    }
    if (window.ace && typeof window.ace.edit === 'function') {
      const aceEl = root.querySelector('.ace_editor');
      if (aceEl) {
        const editor = window.ace.edit(aceEl);
        if (editor) {
          editor.setValue(codeText, 1);
          return { ok: true, type: 'ace' };
        }
      }
    }
    const ta = root.querySelector('textarea.code-input, textarea');
    if (ta) {
      ta.value = codeText;
      ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return { ok: true, type: 'textarea' };
    }
    return { ok: false, reason: 'no-code-editor-found' };
  }, code, qIndex);
}

// --- Trả lời ngắn số THPT (Strict Numerical Short Answer - q_type: 2, 14) ---
async function fillStrictShortAnswer(page, question, answer) {
  const val = String(answer.answer || answer.correctText || '').trim();
  const qIndex = getQuestionIndex(question);
  return page.evaluate((numStr, idx) => {
    const item = document.querySelectorAll('.itemx.q-view-itemx.question')[idx] ||
      document.getElementById('user-test-' + idx) || document.querySelectorAll('.quizx.question-hold')[idx] ||
      document.querySelectorAll('default-root')[idx];
    const scope = item || document.querySelector('default-root') || document;
    const root = scope.shadowRoot || scope;
    const inp = root.querySelector('type-short-answer input, input.short-ans-input, input.tw-input-content-default-md');
    if (!inp) return { ok: false, reason: 'no-short-ans-input' };

    const placeholder = inp.getAttribute('placeholder') || '';
    const pattern = inp.getAttribute('pattern') || '';
    let finalStr = numStr;
    if (placeholder.includes(',') || /^[0-9,-]+$/.test(pattern)) {
      finalStr = finalStr.replace('.', ',');
    }
    const proto = HTMLInputElement.prototype;
    const setVal = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setVal) setVal.call(inp, finalStr); else inp.value = finalStr;

    inp.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    inp.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
    inp.dispatchEvent(new Event('focusout', { bubbles: true, composed: true }));
    return { ok: true, value: finalStr };
  }, val, qIndex);
}

// ---------------------------------------------------------------------------
// API công khai
// ---------------------------------------------------------------------------

// Dò dạng câu hỏi mở rộng. Trả về null nếu câu hỏi thuộc dạng cơ bản
// (trắc nghiệm / điền khuyết / đúng-sai) vốn đã được xử lý ở browser-engine.
async function detect(page, index = 0) {
  try {
    const questionIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    const functions = [collectShadowRoots, deepQuery, deepQueryAll, isVisible, elText, detectInPage];
    const source = functions.map(fn => fn.toString()).join('\n');
    const res = await page.evaluate(`(() => { ${source}; return detectInPage(${questionIndex}); })()`);
    if (res && res.type) return res;
  } catch {}
  return null;
}

// Điền đáp án cho dạng mở rộng.
async function fill(page, question, answer) {
  switch (question.type) {
    case 'dropdown':
      return fillDropdown(page, question, answer);
    case 'drag_drop':
    case 'grouping':
      return fillDragDrop(page, question, answer);
    case 'matching':
      return fillMatching(page, question, answer);
    case 'hotspot':
      return fillHotspot(page, question, answer);
    case 'word_select':
    case 'underline':
      return fillWordSelect(page, question, answer);
    case 'essay':
      return fillEssay(page, question, answer);
    case 'rearrange':
    case 'order':
      return fillRearrange(page, question, answer);
    case 'speaking':
    case 'record':
      return fillSpeaking(page, question, answer);
    case 'crossword':
    case 'word_search':
      return fillCrossword(page, question, answer);
    case 'code_editor':
      return fillCodeEditor(page, question, answer);
    case 'strict_short_answer':
      return fillStrictShortAnswer(page, question, answer);
    case 'drag_text':
      return fillDragText(page, question, answer);
    case 'fill_me':
      return fillFillMe(page, question, answer);
    default:
      return { ok: false, reason: `unsupported-extended-type:${question.type}` };
  }
}

// Có phải dạng mở rộng không (dùng để quyết định đường đi trong browser-engine)
function isExtended(type) {
  return [
    'dropdown', 'drag_drop', 'grouping', 'matching', 'hotspot',
    'word_select', 'underline', 'essay', 'rearrange', 'order',
    'speaking', 'record', 'crossword', 'word_search', 'code_editor',
    'strict_short_answer', 'drag_text', 'fill_me'
  ].includes(type);
}

module.exports = { detect, fill, isExtended };
