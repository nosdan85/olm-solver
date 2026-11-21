'use strict';

/**
 * Adaptive Solver - Bộ "tự ứng biến" quét toàn bộ thông tin trên DevTools cho MỌI dạng bài:
 *   1. OBSERVE  - Quét toàn bộ DOM (Light DOM, Shadow DOM), Accessibility Tree (CDP),
 *                 thuộc tính/class/role/aria (data-ans, data-accept, data-tf-value, ind, correctAnswer...),
 *                 Web Components AST / properties (jsonQuestion_json, answers, right),
 *                 window globals (data_exam, BASEEXAM) và chụp screenshot.
 *                 Mỗi phần tử tương tác được gắn mã định danh tạm thời `data-agid`.
 *   2. PLAN     - Đọc toàn bộ dữ liệu DevTools để nhận diện đáp án và dạng câu hỏi:
 *                 - Fast-path heuristic: ánh xạ trực tiếp từ DevTools data / server data (< 5ms).
 *                 - Multimodal AI: phân tích toàn bộ cây DevTools + ngữ cảnh trang để thao tác chính xác.
 *                 - Điều hướng vòng đời bài: nhận diện bài khóa làm lại (`locked_result`),
 *                   bấm nút Làm lại / Bắt đầu làm bài (`start_or_redo`), bấm Kiểm tra / Câu tiếp (`next_question`),
 *                   hoặc bấm Nộp bài / Xác nhận nộp (`submit_exam`).
 *   3. ACT      - Thực thi bằng chuột/bàn phím thật qua CDP (đồng bộ LitElement / Web Components).
 *   4. VERIFY   - Quét lại, so sánh trạng thái trước/sau (class selected, value, aria-checked, modal...).
 */

const crypto = require('crypto');
const answerEngine = require('./answer-engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 1. OBSERVE: Quét toàn bộ giao diện hiện tại trên DevTools.
 */
async function observe(page, { withScreenshot = true, includeLifecycleButtons = false, questionIndex = null } = {}) {
  const snapshot = await page.evaluate(({ incLifecycle, questionIndex }) => {
    const isVisible = (el) => {
      if (!el || typeof el.getBoundingClientRect !== 'function') return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };

    // Duyệt sâu mọi node kể cả Shadow DOM (không duyệt iframe để tránh detached Frame do quảng cáo/tracking)
    const allEls = [];
    const walk = (root, depth = 0) => {
      if (!root || depth > 12 || allEls.length >= 12000) return;
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n;
      while (allEls.length < 12000 && (n = tw.nextNode())) {
        allEls.push(n);
        if (n.shadowRoot) walk(n.shadowRoot, depth + 1);
      }
    };
    walk(document);

    const texOf = (el) => {
      if (!el) return '';
      let c;
      if (el.nodeType === 11) {
        c = document.createElement('div');
        c.innerHTML = el.innerHTML || '';
      } else if (typeof el.cloneNode === 'function') {
        c = el.cloneNode(true);
      } else {
        return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      }
      c.querySelectorAll?.('.katex, .MathJax, mjx-container').forEach((k) => {
        const tex = k.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
          k.querySelector('math')?.getAttribute('alttext') || k.getAttribute('data-latex') || '';
        if (tex) {
          k.replaceWith(document.createTextNode(` $${tex.trim()}$ `));
        } else {
          k.querySelectorAll?.('.katex-mathml, mjx-assistive-mml').forEach((m) => m.remove());
        }
      });
      c.querySelectorAll?.('sup').forEach((s) => {
        const t = (s.textContent || '').trim();
        if (t) s.replaceWith(document.createTextNode(`^(${t})`));
      });
      c.querySelectorAll?.('sub').forEach((s) => {
        const t = (s.textContent || '').trim();
        if (t) s.replaceWith(document.createTextNode(`_(${t})`));
      });
      c.querySelectorAll?.('script, style, svg').forEach((s) => s.remove());
      return (c.innerText || c.textContent || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
    };

    const extractIconHint = (el) => {
      const hints = [];
      const aria = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.getAttribute?.('data-original-title');
      if (aria) hints.push(aria.trim());
      const imgs = el.querySelectorAll ? Array.from(el.querySelectorAll('img, [style*="mask-image"], [style*="background-image"]')) : [];
      if (el.tagName === 'IMG') imgs.unshift(el);
      for (const node of imgs) {
        const alt = node.getAttribute?.('alt') || node.getAttribute?.('title') || '';
        if (alt) hints.push(alt.trim());
        const src = node.getAttribute?.('src') || node.getAttribute?.('style') || '';
        const m = src.match(/([a-z0-9_-]+)\.(?:svg|png|webp)/i);
        if (m && m[1]) hints.push(`icon:${m[1]}`);
      }
      const ownStyle = el.getAttribute?.('style') || '';
      const sm = ownStyle.match(/([a-z0-9_-]+)\.(?:svg|png|webp)/i);
      if (sm && sm[1]) hints.push(`icon:${sm[1]}`);
      return Array.from(new Set(hints.filter(Boolean))).join(' | ').slice(0, 100) || undefined;
    };

    const isNoise = (el) => {
      if (incLifecycle) {
        // Khi quét lifecycle (tìm nút làm bài / làm lại / nộp bài / câu tiếp), chỉ bỏ qua thanh chat hoặc quảng cáo
        return !!el.closest?.('#chat, .chat, .exp, .explanation, .giai-chi-tiet, .loigiai');
      }
      return !!el.closest?.(
        'header, nav, footer, .navbar, .sidebar, .menu, #chat, .chat, .tw-header, .breadcrumb, .exp, .explanation, .giai-chi-tiet, .loigiai'
      );
    };

    // Nhận diện phần tử "có thể tương tác" theo NGỮ NGHĨA DevTools
    const isInteractive = (el) => {
      const tag = el.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'OPTION'].includes(tag)) return true;
      if (tag === 'A' && (el.classList?.contains('btn') || el.getAttribute('role') === 'button' || incLifecycle)) return true;
      if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
      const role = el.getAttribute('role');
      if (role && /button|radio|checkbox|option|switch|tab|textbox|combobox|listbox|menuitem|slider|gridcell/.test(role)) return true;
      if (el.hasAttribute('onclick') || (el.hasAttribute('draggable') && el.getAttribute('draggable') === 'true')) return true;
      if (el.hasAttribute('ind') || el.hasAttribute('data-ind') || el.hasAttribute('data-tf-value') || el.hasAttribute('data-id') ||
          el.hasAttribute('data-accept') || el.hasAttribute('data-accepts') || el.hasAttribute('data-ans') ||
          el.hasAttribute('data-correct') || el.classList?.contains('correctAnswer')) return true;
      const cls = String(el.className || '');
      if (/qselect|option|choice|answer|drag|drop|blank|select|box-?link|item-?drag|tf-|toggle|word|chip|cell|slot|zone|target|btn-|tw-olm-btn|popup-primary|swal2-confirm|sortable-item|olm-input-text|\bup\b|\bdown\b/i.test(cls)) return true;
      const cs = getComputedStyle(el);
      if (cs.cursor === 'pointer' && texOf(el).length < 200) return true;
      return false;
    };

    // Tìm vùng câu hỏi chính
    const questionRoots = allEls.filter((el) =>
      isVisible(el) && /question|quiz|itemx|card-body|box-static|type-|content-question|q-view|exam/i.test(el.tagName + ' ' + (el.className || '') + ' ' + (el.id || ''))
    );
    const listItem = questionIndex == null ? null :
      document.querySelectorAll('.itemx.q-view-itemx.question')[questionIndex];
    const within = (element, scope) => {
      for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
        if (current === scope) return true;
      }
      return false;
    };
    let mainRoot = null;
    let bestScore = -1;
    for (const r of questionRoots) {
      const t = texOf(r).length;
      const rect = r.getBoundingClientRect();
      const score = Math.min(t, 3000) + (rect.top < innerHeight ? 500 : 0) - (rect.width * rect.height > innerWidth * innerHeight * 0.95 ? 800 : 0);
      if (score > bestScore) { bestScore = score; mainRoot = r; }
    }

    if (listItem) mainRoot = listItem;

    const elements = [];
    const symbol = Symbol.for('olm.adaptive.nodes');
    const registry = window[symbol] ||= {
      prefix: String(crypto.getRandomValues(new Uint32Array(1))[0]),
      sequence: 0, ids: new WeakMap(), nodes: new Map(),
    };
    for (const [id, ref] of registry.nodes) if (!ref.deref()?.isConnected) registry.nodes.delete(id);
    for (const el of allEls) {
      if ((listItem && !within(el, listItem)) || !isInteractive(el) || !isVisible(el) || isNoise(el)) continue;
      const parent = el.parentElement;
      const elText = texOf(el);
      const iconHint = extractIconHint(el);
      if (
        parent &&
        !el.matches('input, button, select, textarea, [contenteditable], [role=radio], [role=checkbox], [role=option]') &&
        elements.length &&
        elements[elements.length - 1].__el === parent &&
        texOf(parent) === elText &&
        !el.hasAttribute('data-tf-value') &&
        !el.hasAttribute('ind') &&
        !el.hasAttribute('data-ind')
      ) {
        continue;
      }
      let id = registry.ids.get(el);
      if (!id) {
        id = 'ag' + registry.prefix + String(++registry.sequence);
        registry.ids.set(el, id);
      }
      registry.nodes.set(id, new WeakRef(el));
      el.setAttribute('data-agid', id);
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of Array.from(el.attributes || [])) {
        if (/^(class|style|data-agid|d|points|xmlns.*|src)$/i.test(a.name)) continue;
        if (String(a.value).length > 120) continue;
        attrs[a.name] = a.value;
      }
      const img = el.querySelector?.('img');
      const state = {
        answerText: el.isContentEditable ? (el.innerText || '').slice(0, 250) : undefined,
        checked: el.checked ?? undefined,
        value: (el.value !== undefined && typeof el.value === 'string') ? el.value.slice(0, 80) : undefined,
        ariaChecked: el.getAttribute('aria-checked') || undefined,
        ariaSelected: el.getAttribute('aria-selected') || undefined,
        dataValue: el.getAttribute('data-value') || undefined,
        selectedClass: /(^|\s)(active|selected|checked|qchecked|tw-selected|chosen|picked)(\s|$)/.test(String(el.className || '')) || undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        hasCorrectClass: (el.classList?.contains('correctAnswer') || el.closest?.('.correctAnswer') !== null) || undefined,
        isCorrectMarker: (el.getAttribute('data-correct') === '1' || el.getAttribute('correct') === 'true' || el.getAttribute('data-is-correct') === 'true' || el.getAttribute('data-true') === '1') || undefined,
        dataAccept: el.getAttribute('data-accept') || el.getAttribute('data-accepts') || el.getAttribute('data-ans') || undefined,
      };
      const isKnownQuizItem = el.hasAttribute('data-tf-value') || el.hasAttribute('ind') || el.hasAttribute('data-ind') ||
        el.hasAttribute('data-ans-id') || el.hasAttribute('data-accept') || el.hasAttribute('data-ans') ||
        /qiradio|qselect|choice|option|boxlink|drag-item|tf-/i.test(el.className || '') ||
        ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()) || el.getAttribute('role') === 'radio';
      const inQuestion = listItem ? within(el, listItem) : ((mainRoot ? within(el, mainRoot) : true) || isKnownQuizItem);

      elements.push({
        __el: el,
        id,
        tag: el.tagName.toLowerCase(),
        type: el.type || undefined,
        role: el.getAttribute('role') || undefined,
        cls: String(el.className || '').slice(0, 80) || undefined,
        text: elText.slice(0, 160) || undefined,
        icon: iconHint,
        img: img ? (img.getAttribute('src') || '').slice(-80) : undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        attrs: Object.keys(attrs).length ? attrs : undefined,
        inQuestion,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        state,
      });
    }

    if (incLifecycle) {
      const lifecycle = element => /nộp|submit|tiếp|kiểm tra|bắt đầu|làm lại|kết thúc|xác nhận|hoàn thành/i.test(
        [element.text, element.icon, element.cls, element.attrs?.id, element.attrs?.['aria-label']].join(' '));
      elements.sort((a, b) => Number(lifecycle(b)) - Number(lifecycle(a)));
    }
    elements.length = Math.min(elements.length, 180);
    const bodyText = texOf(document.body).slice(0, 3500);
    const questionText = mainRoot ? texOf(mainRoot).slice(0, 3000) : bodyText.slice(0, 3000);
    const signature = elements
      .filter((e) => e.inQuestion !== false)
      .map((e) => `${e.tag}.${(e.cls || '').split(/\s+/).filter((c) => !/\d{3,}/.test(c)).slice(0, 2).join('.')}${e.role ? '@' + e.role : ''}`)
      .slice(0, 40)
      .join('|');

    // Thu thập tín hiệu DevTools toàn trang (Page Meta)
    const hasScoreBanner =
      /(?:tổng điểm tối đa|kết quả bài làm|kết quả luyện tập|chúc mừng bạn đã hoàn thành|tốt lắm|cứ chăm chỉ|bứt phá ngay thôi|đừng nản lòng|điểm của bạn)/i.test(bodyText) &&
      /(?:đúng\s*\d+\s*\/\s*\d+\s*câu|\b\d+(?:[.,]\d+)?\s*\/\s*10\b)/i.test(bodyText);
    const scoreMatch = bodyText.match(/\b(\d+(?:[.,]\d+)?)\s*\/\s*10\b/);
    const correctMatch = bodyText.match(/Đúng\s*(\d+\s*\/\s*\d+)\s*câu/i);
    const hasQuizElements = allEls.some((el) =>
      isVisible(el) &&
      (el.matches?.('.qselect, [data-tf-value], .drag-item, .boxlink, .under-line, .sortable-item, type-quiz-x-mobile, type-quiz-x, type-mix, type-true-false-mobile, type-fill-me-mobile, type-sort-list-mobile, type-drag-text-mobile, .itemx.question, .quizx.question-hold') ||
       /^(type-quiz|type-true|type-fill|type-drag|type-match|type-mix|type-group|type-two|type-link|type-under|type-select|type-paragraph|type-sort)/i.test(el.tagName || ''))
    );

    const openModals = allEls
      .filter((el) => isVisible(el) && el.matches?.('.swal2-popup, .modal.show, .modal.in, .main-modal-v2:not(.tw-hidden), #dialogConfirm, [role="dialog"]'))
      .map((m) => texOf(m).slice(0, 250))
      .filter(Boolean);

    // =========================================================================
    // DEVTOOLS DEEP MINING: Nhận diện dạng câu hỏi & đáp án trực tiếp từ DevTools
    // =========================================================================
    let devToolsQuestionType = 'unknown';
    const activeScope = listItem || mainRoot || document;
    const hasSortStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-sort/i.test(el.tagName || '') ||
        /\bsortable-item\b/i.test(el.className || '')
      )
    );
    const hasTfStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-true-false|type-true-fasle|type-tf-mobile/i.test(el.tagName || '') ||
        el.hasAttribute('data-tf-value') ||
        /\b(?:tf-row|tf-box|qiradio)\b/i.test(el.className || '')
      )
    );
    const hasFillStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-fill-me|type-paragraph/i.test(el.tagName || '') ||
        /\b(?:fillme-input|box-fill)\b/i.test(el.className || '') ||
        (el.tagName === 'INPUT' && !['radio', 'checkbox', 'button', 'submit', 'hidden'].includes((el.type || '').toLowerCase()))
      )
    );
    const hasChoiceStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-quiz-x|type-quiz-multi/i.test(el.tagName || '') ||
        /\bqselect\b/i.test(el.className || '') ||
        el.getAttribute('role') === 'radio'
      )
    );
    const hasDragStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-drag/i.test(el.tagName || '') ||
        /\b(?:drag-item|drag-drop|drag-select)\b/i.test(el.className || '')
      )
    );
    const hasMatchStructure = allEls.some((el) =>
      within(el, activeScope) && (
        /type-two-list|type-link-list/i.test(el.tagName || '') ||
        /\bboxlink\b/i.test(el.className || '')
      )
    );

    if (hasSortStructure) devToolsQuestionType = 'sort_list';
    else if (hasTfStructure) devToolsQuestionType = 'true_false';
    else if (hasDragStructure) devToolsQuestionType = 'drag_drop';
    else if (hasFillStructure) devToolsQuestionType = 'short_answer';
    else if (hasChoiceStructure) devToolsQuestionType = 'multiple_choice';
    else if (hasMatchStructure) devToolsQuestionType = 'matching';

    // Khai thác đáp án trực tiếp từ DevTools (Web Components, DOM attributes, window globals)
    const extractPrimaryPipe = (str) => {
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
    };
    let devToolsAnswerHints = null;
    const webComps = allEls.filter((el) =>
      within(el, activeScope) && /^(type-quiz|type-true|type-fill|type-drag|type-match|type-mix|type-group|type-two|type-link|type-under|type-select|type-paragraph|type-sort)/i.test(el.tagName || '')
    );

    for (const comp of webComps) {
      const compRoot = comp.shadowRoot || comp.renderRoot || comp;

      // 0a. type-sort-list-mobile: thẻ li.sortable-item[name="0..N-1"] chứa sẵn thứ tự đúng trong thuộc tính name
      if (/type-sort/i.test(comp.tagName)) {
        const sortLis = Array.from(compRoot.querySelectorAll?.('li.sortable-item[name]') || []);
        if (sortLis.length > 0) {
          const currentOrder = sortLis.map((li) => Number(li.getAttribute('name')));
          devToolsAnswerHints = {
            qType: 5,
            isSortList: true,
            currentOrder,
            targetOrder: currentOrder.map((_, idx) => idx),
            source: 'devtools-wc-sort-list',
          };
          break;
        }
      }

      // 0b. type-drag-text-mobile: comp.answerCorrect = {"0":"0","1":"1",...} chứa map vị trí ô trống -> data-id đáp án
      if (/type-drag-text/i.test(comp.tagName) && comp.answerCorrect && typeof comp.answerCorrect === 'object' && !Array.isArray(comp.answerCorrect)) {
        devToolsAnswerHints = {
          qType: 3,
          isDragText: true,
          dragAnswerMap: comp.answerCorrect,
          source: 'devtools-wc-drag-text',
        };
        break;
      }

      // 1. type-fill-me: AST của câu hỏi trong jsonQuestion_json có chứa đáp án ở thuộc tính content
      const compFillNodes = [];
      const walkFillNodes = (nodes) => {
        if (!Array.isArray(nodes)) return;
        for (const n of nodes) {
          if (!n || typeof n !== 'object') continue;
          if (n.type === 'fillme-input') compFillNodes.push(n);
          if (Array.isArray(n.children)) walkFillNodes(n.children);
        }
      };
      walkFillNodes(comp.jsonQuestion_json?.root?.children || comp.jsonQuestion?.root?.children || []);
      if (compFillNodes.length > 0) {
        const vals = compFillNodes
          .map((n) => n.content ? extractPrimaryPipe(String(n.content).split('||')[0]).replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim() : '')
          .filter((v) => Boolean(v) && !/^@.*@$|@(?:p\.|Math\.)/.test(v));
        if (vals.length > 0) {
          devToolsAnswerHints = {
            qType: 2,
            fillAnswers: vals,
            answer: vals[0],
            answers: vals,
            source: 'devtools-wc-fillme-ast',
          };
          break;
        }
      }

      // 2. input[data-accept], input[data-accepts], input[data-ans]
      const acceptInps = Array.from(compRoot.querySelectorAll?.('input[data-accept], input[data-accepts], input[data-ans]') || []);
      if (acceptInps.length > 0) {
        const vals = acceptInps
          .map((inp) => inp.getAttribute('data-accept') || inp.getAttribute('data-accepts') || inp.getAttribute('data-ans') || '')
          .map((v) => extractPrimaryPipe(String(v).split('||')[0]).replace(/<!--[\s\S]*?-->|<[^>]+>/g, '').trim())
          .filter((v) => Boolean(v) && !/^@.*@$|@(?:p\.|Math\.)/.test(v));
        if (vals.length > 0) {
          devToolsAnswerHints = {
            qType: 2,
            fillAnswers: vals,
            answer: vals[0],
            answers: vals,
            source: 'devtools-wc-data-accept',
          };
          break;
        }
      }

      // 3. True / False: comp.answers, comp.data.answers, comp.jsonQuestion.data.answers
      const isTfComp = /true-false|true-fasle|tf-mobile/i.test(comp.tagName);
      const tfData = comp.answers ?? comp.data?.answers ?? comp.jsonQuestion?.data?.answers ?? comp.jsonQuestion?.answers;
      if (isTfComp && Array.isArray(tfData) && tfData.length > 0) {
        devToolsAnswerHints = {
          isTrueFalse: true,
          qType: 13,
          tfAnswers: tfData.map((v, i) => ({
            index: i,
            value: (v === 1 || v === true || v === '1' || v?.value === 1 || v?.answer === 'Đúng' || v?.isCorrect === true) ? 1 : 0,
          })),
          source: 'devtools-wc-tf-prop',
        };
        break;
      }

      // 4. Trắc nghiệm: right / correct / answerCorrect
      const rightProp = comp.right ?? comp.correct ?? comp.answerCorrect ?? comp.data?.right ?? comp.data?.correct ?? comp.jsonQuestion?.correct;
      if (rightProp !== undefined && rightProp !== null) {
        if (Array.isArray(rightProp)) {
          const rInds = rightProp.map(Number).filter((n) => Number.isInteger(n) && n >= 0);
          if (rInds.length > 0) {
            devToolsAnswerHints = {
              qType: 1,
              correctIndex: rInds[0],
              correctIndices: rInds,
              source: 'devtools-wc-choice-prop-array',
            };
            break;
          }
        } else if (typeof rightProp !== 'object') {
          const rNum = Number(rightProp);
          if (Number.isInteger(rNum) && rNum >= 0) {
            devToolsAnswerHints = {
              qType: 1,
              correctIndex: rNum,
              correctIndices: [rNum],
              source: 'devtools-wc-choice-prop',
            };
            break;
          }
        }
      }

      // 5. Drag-drop / Pairs
      const pairsData = comp.pairs ?? comp.data?.pairs ?? comp.jsonQuestion?.data?.pairs ?? comp.mapping ?? comp.data?.mapping;
      if (Array.isArray(pairsData) && pairsData.length > 0) {
        devToolsAnswerHints = {
          pairs: pairsData,
          mapping: pairsData,
          source: 'devtools-wc-pairs',
        };
        break;
      }
    }

    // B. Quét các thẻ có class .correctAnswer hoặc [data-correct="1"] trên trang
    if (!devToolsAnswerHints) {
      const correctEls = allEls.filter((el) => within(el, activeScope) && isVisible(el) && (
        el.matches?.('.correctAnswer, [data-correct="1"], [correct="true"], [data-true="1"]') ||
        el.classList?.contains('correctAnswer')
      ));
      if (correctEls.length > 0) {
        const inds = correctEls
          .map((el) => Number(el.getAttribute('ind') ?? el.getAttribute('data-ind')))
          .filter((n) => Number.isInteger(n) && n >= 0);
        const texts = correctEls.map((el) => (el.innerText || '').replace(/^#+\s*/, '').trim()).filter(Boolean);
        if (inds.length > 0 || texts.length > 0) {
          devToolsAnswerHints = {
            qType: 1,
            correctIndex: inds.length > 0 ? inds[0] : 0,
            correctIndices: inds,
            correctTexts: texts,
            answer: texts.join('; '),
            source: 'devtools-dom-correct-class',
          };
        }
      }
    }

    // C. Quét window globals (data_exam, BASEEXAM, data_quiz)
    if (!devToolsAnswerHints) {
      try {
        const curIdq = new URLSearchParams(location.search).get('idq');
        const allQuizzes = window.data_exam?.questions || window.data_exam?.list_quiz ||
          window.BASEEXAM?.questions || window.data_quiz || window.all_quizzes || [];
        if (Array.isArray(allQuizzes) && allQuizzes.length > 0) {
          const found = (curIdq ? allQuizzes.find(q => String(q.id) === String(curIdq)) : null) || (questionIndex != null ? allQuizzes[questionIndex] : null);
          if (found) {
            const rawAns = found.ans || found.correct || found.answer || found.right;
            if (rawAns !== undefined && rawAns !== null) {
              devToolsAnswerHints = {
                answer: typeof rawAns === 'string' ? rawAns : undefined,
                correctIndex: Number.isInteger(found.right) ? found.right : (Number.isInteger(found.correct) ? found.correct : -1),
                qType: found.type,
                options: found.options,
                source: 'devtools-window-global',
              };
            }
          }
        }
      } catch {}
    }

    const pageMeta = {
      hasScoreBanner,
      scoreOnPage: scoreMatch ? scoreMatch[1].replace(',', '.') : null,
      correctOnPage: correctMatch ? correctMatch[1].replace(/\s+/g, '') : null,
      hasQuizElements,
      isResultLike: hasScoreBanner && !hasQuizElements,
      openModals,
      hasDataExam: !!(window.data_exam && window.data_exam.list_id_quiz),
      hasBaseExam: !!window.BASEEXAM,
      devToolsQuestionType,
      devToolsAnswerHints,
    };

    return {
      url: location.href,
      title: document.title,
      bodyText: bodyText.slice(0, 2000),
      questionText,
      requiresImage: Boolean(mainRoot && allEls.some(el => within(el, mainRoot) && isVisible(el) &&
        el.matches('img:not(.icon):not(.emoji), canvas') && el.getBoundingClientRect().width > 25)),
      pageMeta,
      signature,
      elements: elements.map(({ __el, ...rest }) => rest),
    };
  }, { incLifecycle: includeLifecycleButtons, questionIndex });

  // Accessibility tree từ CDP (bổ sung ngữ nghĩa cho các component lạ)
  try {
    const client = await page.target().createCDPSession();
    try {
      const { nodes } = await client.send('Accessibility.getFullAXTree');
      snapshot.axSummary = (nodes || [])
        .filter((n) => !n.ignored && n.role && /radio|checkbox|button|textbox|combobox|option|switch|listitem|cell|dialog/.test(n.role.value || ''))
        .slice(0, 80)
        .map((n) => `${n.role.value}:${(n.name?.value || '').slice(0, 60)}${n.properties?.some((p) => p.name === 'checked' && p.value?.value === 'true') ? '[x]' : ''}`);
    } finally {
      await client.detach().catch(() => {});
    }
  } catch { /* optional */ }

  if (withScreenshot) {
    try {
      if (questionIndex != null) {
        const item = await page.evaluateHandle(index => document.querySelectorAll('.itemx.q-view-itemx.question')[index], questionIndex);
        try { await item.asElement()?.scrollIntoView(); }
        finally { await item.dispose(); }
      }
      snapshot.screenshot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 });
    } catch { /* ignore */ }
  }

  snapshot.sigHash = crypto.createHash('md5').update(snapshot.signature || '').digest('hex').slice(0, 12);
  return snapshot;
}

/**
 * 2. PLAN: Hỏi AI kế hoạch hành động cho câu hỏi hiện tại.
 */
async function requestPlan(prompt, snapshot, validate, signal) {
  const visual = snapshot.screenshot
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + snapshot.screenshot } }]
    : null;
  if (!visual && snapshot.requiresImage) throw new Error('Thiếu ảnh câu hỏi để Adaptive xử lý.');
  let lastError;
  for (const provider of answerEngine.providers()) {
    const inputs = visual ? (snapshot.requiresImage ? [visual] : [visual, prompt]) : [prompt];
    for (const input of inputs) {
      try {
        signal?.throwIfAborted();
        const result = await answerEngine.callAi(answerEngine.buildPayload(input, provider), {
          provider, timeoutMs: 30000, signal,
        });
        const parsed = answerEngine.parseModelJson(result?.choices?.[0]?.message?.content || '');
        if (validate(parsed)) return parsed;
        lastError = new Error('Phản hồi Adaptive thiếu dữ liệu thao tác.');
        break;
      } catch (error) {
        signal?.throwIfAborted();
        lastError = error;
        if (![400, 415, 422].includes(error.status)) break;
      }
    }
  }
  throw lastError || new Error('Chưa có AI provider khả dụng.');
}

/**
 * Fast-Path Heuristic Planner: Khi có đáp án chính xác từ server (API / DOM)
 * hoặc thu thập được từ DevTools (Web Components, DOM data-*, window globals),
 * ánh xạ nhanh và chính xác vào các phần tử tương tác đã quét trên DevTools (< 5ms)
 * mà không cần gọi LLM bên ngoài, giúp hoàn thành bài thi cực nhanh (< 1 phút).
 */
function inferFastAdaptivePlan(snapshot, knownAnswer) {
  const isBogus = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return true;
    if (/^@[a-zA-Z0-9_.\[\]()+\-*/\s]+@$/.test(s) || /@(?:p\.|Math\.)/.test(s)) return true;
    if (/^(?:không xác định|chưa thể xác định|unresolved|null|undefined)$/i.test(s)) return true;
    if (/^[\s;,\.\|\-]+$/.test(s)) return true;
    return false;
  };

  const hasDirectKnown = knownAnswer && !knownAnswer.unresolved && (
    !isBogus(knownAnswer.answer || knownAnswer.correctText) ||
    (Number.isInteger(knownAnswer.correctIndex) && knownAnswer.correctIndex >= 0) ||
    (Array.isArray(knownAnswer.correctIndices) && knownAnswer.correctIndices.length > 0) ||
    (Array.isArray(knownAnswer.tfAnswers) && knownAnswer.tfAnswers.length > 0) ||
    (Array.isArray(knownAnswer.statements) && knownAnswer.statements.length > 0) ||
    (Array.isArray(knownAnswer.fillAnswers) && knownAnswer.fillAnswers.some(x => !isBogus(x))) ||
    (Array.isArray(knownAnswer.pairs) && knownAnswer.pairs.length > 0) ||
    (Array.isArray(knownAnswer.mapping) && knownAnswer.mapping.length > 0)
  );

  const answerSource = hasDirectKnown ? knownAnswer : snapshot.pageMeta?.devToolsAnswerHints;
  if (!answerSource || answerSource.unresolved) return null;
  const elements = snapshot.elements || [];
  if (!elements.length) return null;

  // 1. Dạng Đúng / Sai (True / False, qType: 13)
  const isTf = answerSource.isTrueFalse ||
    (Array.isArray(answerSource.tfAnswers) && answerSource.tfAnswers.length > 0) ||
    (Array.isArray(answerSource.statements) && answerSource.statements.length > 0) ||
    answerSource.qType === 13 || answerSource.qType === '13';

  if (isTf) {
    const tfList = Array.isArray(answerSource.tfAnswers) && answerSource.tfAnswers.length > 0
      ? answerSource.tfAnswers
      : (Array.isArray(answerSource.statements) ? answerSource.statements : []);

    const tfEls = elements.filter(e => {
      const tfVal = e.attrs?.['data-tf-value'];
      const ind = e.attrs?.['ind'] ?? e.attrs?.['data-ind'];
      const cls = e.cls || '';
      return tfVal !== undefined || /qiradio|tf-/i.test(cls) || (ind !== undefined && (e.text === 'Đ' || e.text === 'S'));
    });

    if (tfEls.length > 0 && tfList.length > 0) {
      const actions = [];
      for (let i = 0; i < tfList.length; i++) {
        const item = tfList[i];
        const wantTrue = item.value === 1 || item.value === true || item.value === '1' ||
          item.isCorrect === true || item.answer === 'Đúng' || item.answer === true;
        const targetTfVal = wantTrue ? '1' : '0';

        // Khớp theo ind hoặc text 'Đ' / 'S'
        let candidate = tfEls.find(e => {
          const ind = e.attrs?.['ind'] ?? e.attrs?.['data-ind'];
          const tfVal = e.attrs?.['data-tf-value'];
          const indMatch = ind !== undefined && (ind === String(i) || Number(ind) === i);
          const valMatch = tfVal !== undefined ? tfVal === targetTfVal : (wantTrue ? e.text === 'Đ' : e.text === 'S');
          return indMatch && valMatch;
        });

        if (!candidate) {
          // Khớp theo cặp 2 nút mỗi dòng (0: Đúng, 1: Sai)
          const rowEls = tfEls.slice(i * 2, i * 2 + 2);
          if (rowEls.length === 2) {
            candidate = wantTrue ? rowEls[0] : rowEls[1];
          }
        }

        if (candidate) {
          const isSelected = candidate.state?.selectedClass || candidate.state?.checked || candidate.state?.ariaChecked === 'true';
          if (!isSelected) {
            actions.push({ do: 'click', id: candidate.id });
          }
        }
      }

      if (actions.length > 0) {
        return {
          pageState: 'question',
          reasoning: `Adaptive DevTools: Chọn ${actions.length} ý đúng/sai theo đáp án đề thi (${answerSource.source || 'server'})`,
          actions,
          expect: 'true_false selected',
        };
      } else if (tfList.length > 0) {
        return {
          pageState: 'question',
          reasoning: 'Adaptive DevTools: Tất cả các ý đúng/sai đã được chọn chính xác',
          actions: [],
          expect: 'already selected',
        };
      }
    }
  }

  // 2. Dạng Điền khuyết / Trả lời ngắn (Short Answer, qType: 2, fill_me)
  const isShort = ['short_answer', 'strict_short_answer', 'fill_me'].includes(answerSource.qType) ||
    answerSource.qType === 2 || answerSource.qType === '2' ||
    (Array.isArray(answerSource.fillAnswers) && answerSource.fillAnswers.some(x => !isBogus(x))) ||
    (!isTf && !answerSource.options?.length && !isBogus(answerSource.answer || answerSource.correctText));

  if (isShort) {
    const rawFills = Array.isArray(answerSource.fillAnswers) && answerSource.fillAnswers.length > 0
      ? answerSource.fillAnswers
      : (Array.isArray(answerSource.answers) ? answerSource.answers : [answerSource.answer || answerSource.correctText]);
    const fillAnswers = rawFills.filter(x => !isBogus(x));

    if (fillAnswers.length > 0) {
      const inputEls = elements.filter(e => {
        const tag = e.tag;
        const type = (e.type || '').toLowerCase();
        const isTextInput = (tag === 'input' && !['radio', 'checkbox', 'button', 'submit', 'image', 'hidden'].includes(type)) || tag === 'textarea';
        const isEditable = e.state?.answerText !== undefined || e.attrs?.['contenteditable'] === 'true' || /fillme|box-fill|blank/i.test(e.cls || '');
        return (isTextInput || isEditable) && !e.state?.disabled;
      });

      if (inputEls.length > 0) {
        const actions = [];
        for (let k = 0; k < fillAnswers.length; k++) {
          const val = String(fillAnswers[k] ?? '').trim();
          if (!val) continue;
          const targetInput = inputEls[k] || inputEls[0];
          if (targetInput) {
            const currentVal = (targetInput.state?.value ?? targetInput.state?.answerText ?? '').trim();
            if (currentVal !== val) {
              actions.push({ do: 'type', id: targetInput.id, text: val });
            }
          }
        }
        if (actions.length > 0) {
          return {
            pageState: 'question',
            reasoning: `Adaptive DevTools: Điền ${actions.length} ô trả lời ngắn (${answerSource.source || 'server'})`,
            actions,
            expect: 'short answer typed',
          };
        } else {
          return {
            pageState: 'question',
            reasoning: 'Adaptive DevTools: Các ô trả lời ngắn đã được điền đúng giá trị',
            actions: [],
            expect: 'already filled',
          };
        }
      }
    }
  }

  // 3. Trắc nghiệm được đánh dấu correctAnswer hoặc data-correct="1" trên DevTools
  const correctClassEls = elements.filter(e => e.state?.hasCorrectClass || e.state?.isCorrectMarker);
  if (correctClassEls.length > 0 && !isTf && !isShort) {
    const actions = [];
    for (const cEl of correctClassEls) {
      const isSelected = cEl.state?.selectedClass || cEl.state?.checked || cEl.state?.ariaChecked === 'true';
      if (!isSelected) {
        actions.push({ do: 'click', id: cEl.id });
      }
    }
    if (actions.length > 0) {
      return {
        pageState: 'question',
        reasoning: `Adaptive DevTools: Chọn ${actions.length} đáp án đúng theo thuộc tính/class correctAnswer từ DevTools`,
        actions,
        expect: 'correct class elements selected',
      };
    }
  }

  // 4. Dạng Trắc nghiệm (Multiple Choice, qType: 1)
  const hasChoice = (Number.isInteger(answerSource.correctIndex) && answerSource.correctIndex >= 0) ||
    (Array.isArray(answerSource.correctIndices) && answerSource.correctIndices.length > 0);

  if (hasChoice && !isTf) {
    const targetIndices = Array.isArray(answerSource.correctIndices) && answerSource.correctIndices.length > 0
      ? answerSource.correctIndices
      : [answerSource.correctIndex];

    const choiceEls = elements.filter(e => {
      const cls = e.cls || '';
      const role = e.role || '';
      return /qselect|choice|option|boxlink|answer/i.test(cls) ||
        ['radio', 'checkbox', 'option'].includes(role) ||
        (e.tag === 'input' && ['radio', 'checkbox'].includes(e.type)) ||
        e.attrs?.['data-ans-id'] !== undefined;
    });

    if (choiceEls.length > 0) {
      const actions = [];
      const normOpt = (s) => String(s || '').replace(/^[a-f][.)]\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
      for (const idx of targetIndices) {
        // Ưu tiên 1: Khớp chính xác theo thuộc tính ind / data-ind (bất chấp OLM đảo vị trí đáp án trên màn hình)
        let candidate = choiceEls.find(e => {
          const ind = e.attrs?.['ind'] ?? e.attrs?.['data-ind'];
          return ind !== undefined && Number(ind) === Number(idx);
        });
        // Ưu tiên 2: Khớp theo nội dung chữ đáp án (chống đảo đáp án khi không có thuộc tính ind)
        if (!candidate && answerSource.options?.[idx]) {
          const optText = normOpt(answerSource.options[idx]);
          if (optText) {
            candidate = choiceEls.find(e => {
              const et = normOpt(e.text);
              return et === optText || et.includes(optText) || optText.includes(et);
            });
          }
        }
        // Ưu tiên 3: Fallback theo vị trí DOM chỉ khi không có cả ind lẫn text
        if (!candidate) {
          candidate = choiceEls[idx];
        }
        if (candidate) {
          const isSelected = candidate.state?.selectedClass || candidate.state?.checked || candidate.state?.ariaChecked === 'true';
          if (!isSelected) {
            actions.push({ do: 'click', id: candidate.id });
          }
        }
      }
      if (actions.length > 0) {
        return {
          pageState: 'question',
          reasoning: `Adaptive DevTools: Chọn ${actions.length} đáp án trắc nghiệm (${answerSource.source || 'server'})`,
          actions,
          expect: 'choice selected',
        };
      }
    }
  }

  return null;
}

async function plan(snapshot, knownAnswer, feedback) {
  if (!feedback) {
    const fastPlan = inferFastAdaptivePlan(snapshot, knownAnswer);
    if (fastPlan) return fastPlan;
  }

  if (!answerEngine.hasKey()) throw new Error('Chưa cấu hình AI key cho Adaptive Solver');

  const compactEls = snapshot.elements.map((e) => {
    const o = { id: e.id, tag: e.tag };
    for (const k of ['type', 'role', 'cls', 'text', 'icon', 'img', 'placeholder', 'attrs', 'inQuestion', 'box']) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    const st = Object.fromEntries(Object.entries(e.state || {}).filter(([, v]) => v !== undefined));
    if (Object.keys(st).length) o.state = st;
    return o;
  });

  const isBogusVal = (v) => {
    const s = String(v ?? '').trim();
    if (!s) return true;
    if (/^@[a-zA-Z0-9_.\[\]()+\-*/\s]+@$/.test(s) || /@(?:p\.|Math\.)/.test(s)) return true;
    if (/^(?:không xác định|chưa thể xác định|unresolved|null|undefined)$/i.test(s)) return true;
    if (/^[\s;,\.\|\-]+$/.test(s)) return true;
    return false;
  };

  const hasValidKnown = knownAnswer && !knownAnswer.unresolved && (
    !isBogusVal(knownAnswer.answer || knownAnswer.correctText) ||
    Number.isInteger(knownAnswer.correctIndex) && knownAnswer.correctIndex >= 0 ||
    knownAnswer.correctIndices?.length || knownAnswer.statements?.length || knownAnswer.pairs?.length || knownAnswer.mapping?.length ||
    (Array.isArray(knownAnswer.tfAnswers) && knownAnswer.tfAnswers.length > 0) ||
    (Array.isArray(knownAnswer.fillAnswers) && knownAnswer.fillAnswers.some((x) => !isBogusVal(x))) ||
    (Array.isArray(knownAnswer.subQuestions) && knownAnswer.subQuestions.length > 0)
  );

  const known = hasValidKnown ? {
    answer: !isBogusVal(knownAnswer.answer || knownAnswer.correctText) ? (knownAnswer.answer || knownAnswer.correctText) : undefined,
    correctTexts: Array.isArray(knownAnswer.correctTexts) ? knownAnswer.correctTexts.filter((x) => !isBogusVal(x)) : undefined,
    correctIndices: knownAnswer.correctIndices,
    correctIndex: knownAnswer.correctIndex,
    statements: knownAnswer.statements,
    pairs: knownAnswer.pairs,
    mapping: knownAnswer.mapping,
    tfAnswers: knownAnswer.tfAnswers?.map((t) => ({ text: t.text, value: t.value ? 'Đúng' : 'Sai' })),
    fillAnswers: Array.isArray(knownAnswer.fillAnswers || knownAnswer.answers)
      ? (knownAnswer.fillAnswers || knownAnswer.answers).filter((x) => !isBogusVal(x))
      : undefined,
    subQuestions: knownAnswer.subQuestions?.slice(0, 15)?.map((sq) => ({
      stem: sq.stem?.slice(0, 120),
      answer: sq.correctText,
      correctIndex: sq.correctIndex,
    })),
    options: knownAnswer.options,
    qType: knownAnswer.qType,
  } : null;

  const prompt = [
    'Bạn là một agent điều khiển trình duyệt qua DevTools, đang đứng trước MỘT màn hình bài tập trên web olm.vn.',
    'Nhiệm vụ: chọn/điền ĐÚNG đáp án vào giao diện bằng các hành động chuột/bàn phím dựa trên DỮ LIỆU DEVTOOLS.',
    'Dạng giao diện có thể là bất kỳ:',
    'trắc nghiệm 1/nhiều đáp án, đúng/sai, điền ô trống, dropdown, kéo thả, nối cột, sắp xếp, gạch chân từ, chọn ô trên bảng, tự luận, toán MathQuill...',
    '',
    known ? `ĐÁP ÁN CHÍNH XÁC ĐÃ BIẾT (từ API/server, ưu tiên tuyệt đối): ${JSON.stringify(known)}`
      : (snapshot.pageMeta?.devToolsAnswerHints
        ? `ĐÁP ÁN ĐÃ THU THẬP TỪ DEVTOOLS (DOM/Web Components/Globals): ${JSON.stringify(snapshot.pageMeta.devToolsAnswerHints)}`
        : 'Chưa có đáp án sẵn: Hãy đọc kỹ toàn bộ dữ liệu DevTools (thuộc tính data-*, state phần tử, Accessibility Tree) để nhận diện đáp án và dạng câu hỏi.'),
    '',
    `DẠNG CÂU HỎI DEVTOOLS NHẬN DIỆN: ${snapshot.pageMeta?.devToolsQuestionType || 'chưa phân loại'}`,
    `THÔNG TIN TRANG (DevTools PageMeta): ${JSON.stringify(snapshot.pageMeta || {})}`,
    `NỘI DUNG CÂU HỎI (LaTeX trong $...$):\n${snapshot.questionText}`,
    '',
    `CÁC PHẦN TỬ TƯƠNG TÁC (id dùng để thao tác; box=[x,y,w,h]; state=trạng thái hiện tại):\n${JSON.stringify(compactEls)}`,
    snapshot.axSummary?.length ? `\nACCESSIBILITY TREE: ${snapshot.axSummary.join(' ; ')}` : '',
    feedback ? `\nPHẢN HỒI LẦN TRƯỚC (kế hoạch trước CHƯA thành công, hãy đổi cách): ${feedback}` : '',
    '',
    'QUY TẮC CỐT LÕI:',
    '- ĐỌC VÀ DÙNG DỮ LIỆU DEVTOOLS: Tuyệt đối KHÔNG đoán mò hay tự giải theo văn bản câu hỏi khi DevTools có dữ liệu. Dùng dữ liệu DevTools (data-ans, data-accept, data-tf-value, ind, hasCorrectClass, isCorrectMarker, Accessibility tree) để xác định đáp án chính xác và thao tác vào đúng phần tử tương ứng.',
    '- Chỉ thao tác phần tử trong vùng câu hỏi; KHÔNG bấm nút nộp bài / kiểm tra / tiếp theo / thoát / làm lại / xem đáp án / link điều hướng.',
    '- Nếu màn hình hiện tại là TRANG KẾT QUẢ BÀI LÀM (đã chấm điểm, không có câu hỏi cần trả lời), trả về "pageState": "result_screen" và "actions": [].',
    '- Nếu phần tử đã ở đúng trạng thái thì không bấm lại (bấm lại sẽ bỏ chọn).',
    '- Kéo thả: dùng action "drag" với from/to. Dropdown tuỳ biến: click mở rồi click option.',
    '- Phím chỉ dùng trên ô nhập đã chỉ định. Cho phép mũi tên, Home, End, Backspace, Delete; không dùng phím để nộp hoặc chuyển câu.',
    '- Ô nhập: action "type" với text (sẽ tự xoá nội dung cũ).',
    'Trả về DUY NHẤT JSON: {"pageState":"question|result_screen|lobby","reasoning":"ngắn gọn","actions":[{"do":"click|type|select|drag|key|wait","id":"agX","text":"...","from":"agX","to":"agY","key":"ArrowRight","ms":300}],"expect":"mô tả trạng thái mong đợi sau khi làm"}',
  ].join('\n');

  return requestPlan(prompt, snapshot, parsed => Array.isArray(parsed?.actions));
}

/**
 * 3. ACT: Thực thi kế hoạch bằng chuột / bàn phím thật.
 */
async function locate(page, agid) {
  if (!/^ag\d+$/.test(agid || '')) return null;
  try {
    const handle = await page.evaluateHandle((id) => {
      const node = window[Symbol.for('olm.adaptive.nodes')]?.nodes.get(id)?.deref();
      const el = node?.isConnected ? node : null;
      if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      return el;
    }, agid).catch(() => null);
    if (!handle) return null;
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => {});
      return null;
    }
    const box = await el.boundingBox().catch(() => null);
    if (!box) {
      await el.dispose().catch(() => {});
      return null;
    }
    return { el, box };
  } catch {
    return null;
  }
}

const BLOCKED_QUESTION_TEXT = /nộp bài|nop bai|kiểm tra|kiem tra|tiếp theo|câu tiếp|thoát|đăng xuất|xác nhận nộp|submit|làm lại|xem đáp án|bài liên quan/i;
const BLOCKED_LIFECYCLE_TEXT = /thoát|đăng xuất|bài liên quan|báo lỗi|bao loi|xóa tài khoản/i;

async function act(page, actions, log, { allowLifecycleClicks = false, signal } = {}) {
  const done = [];
  for (const a of actions.slice(0, 30)) {
    signal?.throwIfAborted();
    let t;
    let dst;
    try {
      if (a.do === 'wait') { await sleep(Math.max(0, Math.min(Number(a.ms) || 300, 2000))); continue; }
      if (!['click', 'type', 'select', 'drag', 'key'].includes(a.do)) continue;

      t = a.do === 'drag' ? await locate(page, a.from) : await locate(page, a.id);
      if (!t || !t.box) { done.push(`miss ${a.id || a.from}`); continue; }
      const cx = t.box.x + t.box.width / 2;
      const cy = t.box.y + t.box.height / 2;

      const label = await t.el.evaluate((n) => (n.innerText || n.value || n.getAttribute?.('aria-label') || n.getAttribute?.('title') || '').trim().slice(0, 40)).catch(() => '');
      const blockedRegex = allowLifecycleClicks ? BLOCKED_LIFECYCLE_TEXT : BLOCKED_QUESTION_TEXT;
      if (a.do === 'click' && blockedRegex.test(label)) { done.push(`skip-blocked "${label}"`); continue; }

      if (a.do === 'key') {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete'].includes(a.key)) continue;
        const editable = await t.el.evaluate(node => node.matches('textarea, input:not([type]), input[type=text], input[type=number], [contenteditable=true]') && !node.readOnly && !node.disabled).catch(() => false);
        if (!editable) continue;
        await t.el.focus().catch(() => {});
        await page.keyboard.press(a.key).catch(() => {});
      } else if (a.do === 'click') {
        await page.mouse.click(cx, cy);
      } else if (a.do === 'type') {
        await page.mouse.click(cx, cy);
        await sleep(50);
        await t.el.evaluate((n, text) => {
          if ('value' in n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA')) {
            if (n._valueTracker) try { n._valueTracker.setValue(''); } catch { /* */ }
            const proto = n.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(n, text);
            n.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            n.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          }
          // LitElement Web Component sync: type-fill-me, type-fill-me-mobile, type-paragraph-mobile
          const host = n.getRootNode?.()?.host || n.closest?.('type-fill-me, type-fill-me-mobile, type-paragraph-mobile, type-quiz-x-mobile, type-true-false-mobile');
          if (host) {
            if (typeof host.onChange === 'function') {
              try { host.onChange({ currentTarget: n, target: n }); } catch {}
            }
            const indKey = n.getAttribute('ind') ?? n.getAttribute('data-ind') ?? '0';
            host.userAnswer = Object.assign({}, host.userAnswer || {}, { [indKey]: text });
            if (typeof host.requestUpdate === 'function') {
              try { host.requestUpdate(); } catch {}
            }
          }
        }, String(a.text ?? '')).catch(() => { });
        await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        const text = String(a.text ?? '');
        if (text.length > 25) {
          try {
            const client = await page.target().createCDPSession();
            try {
              await client.send('Input.insertText', { text });
            } finally {
              await client.detach().catch(() => {});
            }
          } catch {
            await page.keyboard.type(text, { delay: 15 }).catch(() => {});
          }
        } else {
          await page.keyboard.type(text, { delay: 15 }).catch(() => {});
        }
        await t.el.evaluate((n) => {
          n.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          n.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
          n.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
        }).catch(() => { });
      } else if (a.do === 'select') {
        const ok = await t.el.evaluate((n, val) => {
          if (n.tagName !== 'SELECT') return false;
          const opt = Array.from(n.options).find((o) => o.text.trim() === val || o.value === val) ||
            Array.from(n.options).find((o) => o.text.trim().toLowerCase().includes(String(val).toLowerCase()));
          if (!opt) return false;
          n.value = opt.value;
          n.dispatchEvent(new Event('input', { bubbles: true }));
          n.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }, a.text).catch(() => false);
        if (!ok) await page.mouse.click(cx, cy);
      } else if (a.do === 'drag') {
        dst = await locate(page, a.to);
        if (!dst || !dst.box) { done.push(`miss ${a.to}`); continue; }
        const tx = dst.box.x + dst.box.width / 2;
        const ty = dst.box.y + dst.box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        for (let s = 1; s <= 12; s++) {
          await page.mouse.move(cx + ((tx - cx) * s) / 12, cy + ((ty - cy) * s) / 12);
          await sleep(15);
        }
        await page.mouse.up();
        await page.evaluate((fromId, toId) => {
          const q = (id) => {
            const f = (r) => r.querySelector?.(`[data-agid="${id}"]`) || Array.from(r.querySelectorAll?.('*') || []).map((e) => e.shadowRoot && f(e.shadowRoot)).find(Boolean);
            return f(document);
          };
          const src = q(fromId); const dst2 = q(toId);
          if (!src || !dst2) return;
          const dt = new DataTransfer();
          src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
          dst2.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
          dst2.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
          dst2.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
          src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        }, a.from, a.to).catch(() => { });
      }
      done.push(`${a.do} ${a.id || `${a.from}->${a.to}`}${a.text ? ` "${String(a.text).slice(0, 30)}"` : ''}`);
      await sleep(120);
    } catch (e) {
      done.push(`err ${a.do}: ${e.message}`);
    } finally {
      try { await t?.el?.dispose(); } catch {}
      try { await dst?.el?.dispose(); } catch {}
    }
  }
  log?.('info', `🤖 [Adaptive] Đã thực thi: ${done.join(' | ')}`);
  return done;
}

/**
 * 4. VERIFY: So sánh trạng thái trước / sau.
 */
function diffState(before, after) {
  const previous = new Map(before.elements.map((element) => [element.id, element.state || {}]));
  const keys = ['checked', 'value', 'answerText', 'ariaChecked', 'ariaSelected', 'dataValue', 'selectedClass'];
  return after.elements.flatMap((element) => {
    const prior = previous.get(element.id);
    if (!prior) return [];
    return keys.filter((key) => prior[key] !== element.state?.[key] && (prior[key] != null || element.state?.[key] != null))
      .map((key) => element.id + ': ' + key);
  });
}

/**
 * API 1: Tự ứng biến điền câu hỏi hiện tại (hỗ trợ mọi dạng câu hỏi mới & phát hiện trang kết quả khóa làm lại).
 * @returns {Promise<{ok:boolean, method?:string, rounds:number, text?:string, isResultScreen?:boolean, score?:string}>}
 */
async function solveAdaptively(page, { knownAnswer = null, log = null, maxRounds = 2, questionIndex = null } = {}) {
  let feedback = null;

  for (let round = 1; round <= maxRounds; round++) {
    const needScreenshot = !knownAnswer || round > 1;
    const before = await observe(page, { withScreenshot: needScreenshot, includeLifecycleButtons: false, questionIndex });

    // Nếu DevTools phát hiện ngay trang kết quả bài làm (không có câu hỏi trên màn hình)
    if (before.pageMeta?.isResultLike) {
      log?.('warn', `🔒 [Adaptive DevTools] Phát hiện màn hình kết quả bài làm (${before.pageMeta.scoreOnPage || '?'}/10), không có câu hỏi trên trang!`);
      return {
        ok: false,
        reason: 'no-question-on-screen',
        isResultScreen: true,
        score: before.pageMeta.scoreOnPage,
        rounds: round,
      };
    }

    if (!before.elements.length) {
      return { ok: false, reason: 'no-interactive-elements', rounds: round };
    }

    if (round === 1) {
      const hintSource = before.pageMeta?.devToolsAnswerHints?.source ? ` (đáp án từ ${before.pageMeta.devToolsAnswerHints.source})` : '';
      const typeHint = before.pageMeta?.devToolsQuestionType && before.pageMeta.devToolsQuestionType !== 'unknown' ? ` [Dạng: ${before.pageMeta.devToolsQuestionType}]` : '';
      log?.('info', `🔬 [Adaptive DevTools] Quét được ${before.elements.length} phần tử tương tác, signature=${before.sigHash}${typeHint}${hintSource}. Đang xử lý qua DevTools...`);

      // Fast-path DevTools cho dạng Sắp xếp thứ tự (type-sort-list-mobile) và Kéo thả từ (type-drag-text-mobile)
      if (before.pageMeta?.devToolsQuestionType === 'sort_list' || before.pageMeta?.devToolsAnswerHints?.isSortList || before.pageMeta?.devToolsAnswerHints?.isDragText) {
        const directRes = await page.evaluate(async (qIdx) => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const listItem = qIdx == null ? null : document.querySelectorAll('.itemx.q-view-itemx.question')[qIdx];
          const scope = listItem || document;

          const findComp = (root, d = 0) => {
            if (!root || d > 10) return null;
            for (const el of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
              const tag = (el.tagName || '').toLowerCase();
              if (/^type-(sort|drag-text)/i.test(tag)) return el;
              if (el.shadowRoot) {
                const sub = findComp(el.shadowRoot, d + 1);
                if (sub) return sub;
              }
            }
            return null;
          };

          const comp = findComp(scope);
          if (!comp) return null;
          const tag = comp.tagName.toLowerCase();
          const sr = comp.shadowRoot || comp.renderRoot || comp;

          if (tag.includes('sort')) {
            let moves = 0;
            for (let pass = 0; pass < 35; pass++) {
              const items = Array.from(sr.querySelectorAll('li.sortable-item[name]'));
              if (!items.length) return null;
              const names = items.map((li) => Number(li.getAttribute('name')));
              let moved = false;
              for (let i = 1; i < items.length; i++) {
                if (names[i] < names[i - 1]) {
                  const upBtn = items[i].querySelector('.up, span.up, img[alt="up"]');
                  if (upBtn) {
                    upBtn.click();
                    moves++;
                    moved = true;
                    await wait(110);
                    break;
                  }
                }
              }
              if (!moved) break;
            }
            const finalOrder = Array.from(sr.querySelectorAll('li.sortable-item[name]')).map((li) => Number(li.getAttribute('name')));
            return { ok: true, method: 'adaptive-devtools-sort', text: `Sắp xếp thứ tự [${finalOrder.join(', ')}] (${moves} bước)` };
          }

          if (tag.includes('drag-text') && comp.answerCorrect && typeof comp.answerCorrect === 'object') {
            const answerCorrect = comp.answerCorrect;
            const blanks = Array.from(sr.querySelectorAll('.olm-input-text, .box-fill, .drag-blank, [class*="input-text"], [ind]'))
              .filter((el) => !el.classList.contains('select-option-item') && !el.classList.contains('box-select-option-content'));
            const keys = Object.keys(answerCorrect).sort((a, b) => Number(a) - Number(b));
            let filled = 0;
            for (const k of keys) {
              const targetId = String(answerCorrect[k]);
              const blank = blanks[Number(k)];
              if (blank) {
                blank.click();
                await wait(150);
              }
              const opt = sr.querySelector(`.drag-select[data-id="${targetId}"], .select-option-item[data-id="${targetId}"]`);
              if (opt) {
                opt.click();
                filled++;
                await wait(150);
              }
            }
            if (filled > 0) {
              return { ok: filled === keys.length, method: 'adaptive-devtools-dragtext', text: `Điền ${filled}/${keys.length} ô kéo thả từ DevTools` };
            }
          }
          return null;
        }, questionIndex).catch(() => null);

        if (directRes?.ok) {
          log?.('success', `✅ [Adaptive DevTools] ${directRes.text}`);
          return { ...directRes, rounds: round };
        }
      }
    }

    let planRes;
    try {
      planRes = await plan(before, knownAnswer, feedback);
    } catch (e) {
      log?.('warn', `🧠 [Adaptive] Không lập được kế hoạch: ${e.message}`);
      return { ok: false, reason: 'plan-failed', rounds: round };
    }
    log?.('info', `🧠 [Adaptive] Kế hoạch: ${planRes.reasoning || ''} (${planRes.actions.length} bước)`);

    const isResultByAi =
      planRes.pageState === 'result_screen' ||
      /trang kết quả|màn hình kết quả|không có câu hỏi|đã hoàn thành bài/i.test(planRes.reasoning || '');

    if (!planRes.actions.length) {
      if (planRes.reasoning && (planRes.reasoning.includes('đã được chọn') || planRes.reasoning.includes('đã được điền'))) {
        return { ok: true, method: 'adaptive-fast', rounds: round, text: planRes.expect || 'already-filled' };
      }
      return {
        ok: false,
        reason: 'no-question-on-screen',
        isResultScreen: !before.pageMeta?.hasQuizElements && (isResultByAi || !!before.pageMeta?.hasScoreBanner),
        score: before.pageMeta?.scoreOnPage || null,
        rounds: round,
      };
    }

    const available = new Set(before.elements.filter(element => !element.state?.disabled).map(element => element.id));
    const actions = planRes.actions.filter(action => action && (
      action.do === 'wait' || ['click', 'type', 'select', 'key'].includes(action.do) && available.has(action.id) ||
      action.do === 'drag' && available.has(action.from) && available.has(action.to)
    ));
    await act(page, actions, log, { allowLifecycleClicks: false });
    await sleep(400);

    const after = await observe(page, { withScreenshot: false, includeLifecycleButtons: false, questionIndex });
    const changes = diffState(before, after);
    if (changes.length > 0) {
      log?.('success', `✅ [Adaptive] Giao diện đã thay đổi đúng hướng (${changes.length} thay đổi) sau ${round} vòng.`);
      return { ok: true, method: 'adaptive-ai', rounds: round, text: planRes.expect || '', changes };
    }
    feedback = `Không có phần tử nào thay đổi trạng thái sau các hành động: ${JSON.stringify(planRes.actions).slice(0, 600)}. Có thể cần click vào phần tử con/cha khác, dùng kéo thả, hoặc mở dropdown trước.`;
    log?.('warn', `🔁 [Adaptive] Vòng ${round}: chưa thấy thay đổi, đang thử cách khác...`);
  }
  return { ok: false, reason: 'no-effect', rounds: maxRounds };
}

/**
 * API 2: Dùng AI quét toàn bộ DevTools để giải quyết các nút điều khiển vòng đời bài tập khi code tĩnh không tìm thấy:
 *   - stage = 'start_or_redo': Kiểm tra xem bài đã khóa làm lại (`locked_result`), hay có nút Làm lại (`clicked_redo`),
 *                              hay có nút Bắt đầu làm bài (`clicked_start`), hay đang ở màn hình câu hỏi (`in_question`).
 *   - stage = 'next_question': Tìm và bấm nút Kiểm tra đáp án / Câu tiếp theo / Tiếp tục (kể cả nút chỉ có icon).
 *   - stage = 'submit_exam'  : Tìm và bấm nút Nộp bài / Kết thúc bài thi / Hoàn thành và bấm xác nhận trên Modal.
 */
async function resolvePageLifecycleWithAI(page, { stage = 'start_or_redo', log = null, signal } = {}) {
  signal?.throwIfAborted();
  if (!answerEngine.hasKey()) return { ok: false, status: 'no-ai-key' };

  const snapshot = await observe(page, { withScreenshot: true, includeLifecycleButtons: true });
  const compactEls = snapshot.elements.map((e) => {
    const o = { id: e.id, tag: e.tag };
    for (const k of ['type', 'role', 'cls', 'text', 'icon', 'img', 'attrs', 'box']) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    const st = Object.fromEntries(Object.entries(e.state || {}).filter(([, v]) => v !== undefined));
    if (Object.keys(st).length) o.state = st;
    return o;
  });

  const stageInstruction = {
    start_or_redo: [
      'NHIỆM VỤ (stage = start_or_redo):',
      'Phân tích toàn bộ DevTools + ảnh chụp màn hình để xác định trạng thái trang bài tập OLM hiện tại:',
      '1. Nếu đây là TRANG KẾT QUẢ BÀI LÀM ĐÃ NỘP (có điểm số X/10, số câu đúng X/Y...) VÀ KHÔNG CÓ nút "Làm lại" / "Luyện tập lại" / "Bắt đầu" nào (giáo viên đã khóa làm lại):',
      '   -> Trả về "status": "locked_result", "score": "<điểm số trên trang nếu có>", "actions": [].',
      '2. Nếu có nút "Làm lại bài" / "Luyện tập lại" / "Làm lại đề" (hoặc đang hiện popup xác nhận làm lại):',
      '   -> Trả về "status": "clicked_redo" và "actions": [{"do":"click","id":"agX"}] để bấm nút đó.',
      '3. Nếu đây là sảnh chờ và có nút "Bắt đầu làm bài" / "Bắt đầu thi" / "Vào thi" / "Làm bài" / "Tiếp tục làm bài" (hoặc popup xác nhận vào thi):',
      '   -> Trả về "status": "clicked_start" và "actions": [{"do":"click","id":"agX"}] để bấm nút đó.',
      '4. Nếu trên màn hình ĐANG HIỂN THỊ CÂU HỎI để làm bài:',
      '   -> Trả về "status": "in_question", "actions": [].',
    ].join('\n'),
    next_question: [
      'NHIỆM VỤ (stage = next_question):',
      'Tìm và bấm nút để NỘP CÂU HIỆN TẠI hoặc CHUYỂN SANG CÂU TIẾP THEO (ví dụ: nút "Kiểm tra đáp án", "Trả lời", "Câu tiếp", "Tiếp theo", "Tiếp tục", hoặc nút mũi tên phải icon:arrow-right).',
      'Lưu ý: KHÔNG bấm nút "Kết thúc bài thi" (icon:sticky-note-text-square-orange) hay "Bài liên quan" trừ khi đó là nút duy nhất để hoàn thành câu cuối.',
      'Trả về "status": "clicked_next" và "actions": [{"do":"click","id":"agX"}]. Nếu là trang kết quả bài làm đã nộp, trả về "status": "locked_result", "actions": [].',
    ].join('\n'),
    submit_exam: [
      'NHIỆM VỤ (stage = submit_exam):',
      'Tìm và bấm nút NỘP BÀI TỔNG THỂ / KẾT THÚC BÀI THI / HOÀN THÀNH (ví dụ: nút có chữ "Nộp bài", "Kết thúc bài thi", "Kết thúc luyện tập", "Hoàn thành", hoặc nút có icon:sticky-note-text-square-orange / aria-label="Kết thúc bài thi").',
      'Nếu đang có hộp thoại Modal xác nhận nộp bài mở sẵn trên màn hình, hãy bấm nút xác nhận ("Xác nhận", "Đồng ý", "Nộp bài", "Có") trong Modal đó.',
      'KHÔNG bấm nút "Báo lỗi", "Hủy", "Đóng", "Bài liên quan".',
      'Trả về "status": "clicked_submit" và "actions": [{"do":"click","id":"agX"}]. Nếu trang đã ở màn hình kết quả điểm số rồi, trả về "status": "already_submitted", "actions": [].',
    ].join('\n'),
  }[stage] || '';

  const prompt = [
    'Bạn là chuyên gia tự động hóa trình duyệt qua DevTools trên nền tảng olm.vn.',
    stageInstruction,
    '',
    `THÔNG TIN TRANG (PageMeta): ${JSON.stringify(snapshot.pageMeta || {})}`,
    `VĂN BẢN TRÊN TRANG:\n${snapshot.bodyText}`,
    '',
    `DANH SÁCH PHẦN TỬ TƯƠNG TÁC TRÊN DEVTOOLS:\n${JSON.stringify(compactEls)}`,
    snapshot.axSummary?.length ? `\nACCESSIBILITY TREE: ${snapshot.axSummary.join(' ; ')}` : '',
    '',
    'Trả về DUY NHẤT JSON: {"status":"locked_result|clicked_redo|clicked_start|in_question|clicked_next|clicked_submit|already_submitted|none","score":"...","reasoning":"ngắn gọn","actions":[{"do":"click","id":"agX"}]}',
  ].join('\n');

  let parsed;
  try {
    parsed = await requestPlan(prompt, { ...snapshot, requiresImage: false }, result => typeof result?.status === 'string', signal);
  } catch {
    signal?.throwIfAborted();
    return { ok: false, status: 'ai-failed' };
  }

  if (stage === 'start_or_redo' && (parsed.status === 'locked_result' || (parsed.status === 'none' && !snapshot.pageMeta?.hasQuizElements))) {
    parsed.status = 'locked_result';
    log?.('warn', `🔒 [AI DevTools] Bài không cho xem hoặc không cho làm lại (${parsed.reasoning || 'không tìm thấy nút bấm làm bài hoặc luyện tập lại'}).`);
  } else {
    log?.('info', `🧠 [Adaptive DevTools - ${stage}] AI chẩn đoán: status=${parsed.status} (${parsed.reasoning || ''})`);
  }

  if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
    const ids = new Set(snapshot.elements.map(element => element.id));
    const done = await act(page, parsed.actions.filter(action => action?.do === 'click' && ids.has(action.id)),
      log, { allowLifecycleClicks: true, signal });
    if (parsed.status.startsWith('clicked_') && !done.some(action => action.startsWith('click '))) {
      return { ok: false, status: 'action-not-executed' };
    }
    await sleep(1000);
    signal?.throwIfAborted();

    // Submission confirmation is handled by the browser engine.
    if (stage === 'start_or_redo') {
      const confirmClicked = await page.evaluate(() => {
        const isVis = (el) => el && (el.offsetWidth > 0 || el.offsetHeight > 0);
        const modals = Array.from(document.querySelectorAll(
          '.swal2-container.swal2-shown, .modal.show, .modal.in, .main-modal-v2:not(.tw-hidden), #dialogConfirm, [role="dialog"], .bootbox.modal'
        )).filter(isVis);
        for (const m of modals) {
          const btns = Array.from(m.querySelectorAll('button, a.btn, div[role="button"], input[type="button"]')).filter(isVis);
          const okBtn = btns.find((b) => {
            const t = (b.innerText || b.textContent || b.value || '').trim().toLowerCase();
            if (/báo lỗi|bao loi|hủy|huy|đóng|dong|không|khong|cancel|close/.test(t)) return false;
            return /xác nhận|xac nhan|đồng ý|dong y|nộp bài|nop bai|vẫn nộp|ok|có|co|tiếp tục|bắt đầu/i.test(t) ||
              b.id === 'btn-confirm-dialog-confirm-v2' || b.id === 'dialog-yes' ||
              b.classList.contains('popup-primary-button') || b.classList.contains('swal2-confirm');
          });
          if (okBtn) {
            okBtn.click();
            return (okBtn.innerText || 'Xác nhận').trim();
          }
        }
        return null;
      }).catch(() => null);

      if (confirmClicked) {
        log?.('info', `🤖 [Adaptive Lifecycle] Đã tự động xác nhận hộp thoại Modal ("${confirmClicked}")`);
        await sleep(1500);
      }
    }
  }

  if (parsed.status.startsWith('clicked_') && !parsed.actions?.length) return { ok: false, status: 'action-not-executed' };
  return {
    ok: parsed.status !== 'none',
    status: parsed.status,
    score: parsed.score || snapshot.pageMeta?.scoreOnPage || null,
    reasoning: parsed.reasoning || '',
  };
}

module.exports = {
  observe,
  plan,
  act,
  diffState,
  solveAdaptively,
  resolvePageLifecycleWithAI,
};
