'use strict';

/**
 * Universal Science, Math & All-Subject Symbol Normalizer (Lớp 1 đến Đại học)
 *
 * Hỗ trợ nhận diện và chuẩn hóa toàn diện ký hiệu, công thức các môn:
 * - Toán học (Số học, Đại số, Hình học, Giải tích, Đại số tuyến tính, Xác suất thống kê, Toán rời rạc)
 * - Vật lý (Cơ học, Nhiệt học, Điện từ, Quang học, Hạt nhân, Lượng tử, Kỹ thuật điện)
 * - Hóa học (Vô cơ, Hữu cơ, Điện hóa, Nhiệt động hóa học, Cấu hình electron, Phản ứng)
 * - Sinh học (Di truyền, Phân tử ADN/ARN, Nhiễm sắc thể, Lai giống)
 * - Tin học & Logic học (Cổng logic, Hệ đếm, Thuật toán, CSDL, Biểu thức quan hệ)
 * - Kinh tế & Thống kê (Kinh tế lượng, Vi mô, Vĩ mô)
 *
 * Xử lý triệt để cấu trúc DOM phức tạp của OLM:
 * - KaTeX `.katex-html` không có `<annotation>` (đặc biệt `.mfrac` bị ngược mẫu số trước tử số trong `.vlist`, `.msupsub`, `.sqrt`)
 * - MathML (`<math>`, `<mfrac>`, `<msup>`, `<msub>`, `<msubsup>`, `<msqrt>`, `<mroot>`)
 * - MathJax (`<mjx-container>`) & MathQuill (`.mq-root-block`)
 * - HTML `<sup>`, `<sub>`
 */

/**
 * Chuyển đổi đệ quy cây MathML (DOM hoặc Cheerio node) sang chuỗi toán học tuyến tính chuẩn
 */
function parseMathMLNodeDOM(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.nodeValue || '';
  if (node.nodeType !== 1) return '';

  const tag = (node.tagName || '').toLowerCase().replace(/^m:/, '');
  const children = Array.from(node.childNodes || []).filter(
    (c) => c.nodeType === 1 || (c.nodeType === 3 && (c.nodeValue || '').trim() !== '')
  );
  const elemChildren = Array.from(node.children || []);

  if (tag === 'annotation') return '';
  if (tag === 'mfrac' && elemChildren.length >= 2) {
    const num = parseMathMLNodeDOM(elemChildren[0]).trim();
    const den = parseMathMLNodeDOM(elemChildren[1]).trim();
    return `(${num})/(${den})`;
  }
  if (tag === 'msup' && elemChildren.length >= 2) {
    const base = parseMathMLNodeDOM(elemChildren[0]).trim();
    const sup = parseMathMLNodeDOM(elemChildren[1]).trim();
    return `${base}^(${sup})`;
  }
  if (tag === 'msub' && elemChildren.length >= 2) {
    const base = parseMathMLNodeDOM(elemChildren[0]).trim();
    const sub = parseMathMLNodeDOM(elemChildren[1]).trim();
    return `${base}_(${sub})`;
  }
  if (tag === 'msubsup' && elemChildren.length >= 3) {
    const base = parseMathMLNodeDOM(elemChildren[0]).trim();
    const sub = parseMathMLNodeDOM(elemChildren[1]).trim();
    const sup = parseMathMLNodeDOM(elemChildren[2]).trim();
    return `${base}_(${sub})^(${sup})`;
  }
  if (tag === 'msqrt') {
    const inner = children.map(parseMathMLNodeDOM).join('').trim();
    return `√(${inner})`;
  }
  if (tag === 'mroot' && elemChildren.length >= 2) {
    const base = parseMathMLNodeDOM(elemChildren[0]).trim();
    const idx = parseMathMLNodeDOM(elemChildren[1]).trim();
    return idx === '3' ? `∛(${base})` : `√[${idx}](${base})`;
  }
  if (tag === 'mover' && elemChildren.length >= 2) {
    const base = parseMathMLNodeDOM(elemChildren[0]).trim();
    const over = parseMathMLNodeDOM(elemChildren[1]).trim();
    if (over === '→' || over === '⇀' || over === '¯') return `vectơ ${base}`;
    return `${base}${over}`;
  }
  return children.map(parseMathMLNodeDOM).join('');
}

/**
 * Chuẩn hóa cấu trúc Toán học trực tiếp trên cây Browser DOM (trước khi đọc innerText/textContent)
 * Giải quyết triệt để lỗi KaTeX `.mfrac` bị đọc ngược `mΔTQ` thay vì `(Q)/(mΔT)` và mất số mũ `.msupsub` / `<sup>`
 */
function normalizeMathStructureInDOM(rootEl) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return rootEl;
  const doc = rootEl.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return rootEl;

  // 1. Xử lý các khối .katex và .MathJax
  rootEl.querySelectorAll('.katex, .MathJax, mjx-container').forEach((k) => {
    const tex =
      k.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ||
      k.querySelector('math')?.getAttribute('alttext') ||
      k.getAttribute('data-latex') ||
      k.getAttribute('alttext') ||
      '';
    if (tex) {
      k.replaceWith(doc.createTextNode(' $' + tex + '$ '));
      return;
    }

    // Nếu không có annotation nhưng có MathML có cấu trúc (<mfrac>, <msup>, <msub>, <msqrt>)
    const mathEl = k.querySelector('.katex-mathml math, math');
    if (mathEl && mathEl.querySelector('mfrac, msup, msub, msubsup, msqrt, mroot')) {
      const parsedMml = parseMathMLNodeDOM(mathEl).trim();
      if (parsedMml) {
        k.replaceWith(doc.createTextNode(' ' + parsedMml + ' '));
        return;
      }
    }

    // Xóa .katex-mathml và assistive mml để không bị lặp chữ 2 lần
    k.querySelectorAll('.katex-mathml, mjx-assistive-mml, .MJX_Assistive_MathML').forEach((m) => m.remove());

    // Xử lý cấu trúc .katex-html từ trong ra ngoài (bottom-up)
    const khtml = k.querySelector('.katex-html') || k;

    // 1a. Căn thức (.sqrt) trong .katex-html
    const sqrts = Array.from(khtml.querySelectorAll('.sqrt')).reverse();
    sqrts.forEach((sq) => {
      const rootIdx = sq.querySelector('.root')?.textContent?.trim() || '';
      const vlist = sq.querySelector('.vlist-t .vlist');
      let rad = '';
      if (vlist && vlist.children.length > 0) {
        rad = vlist.children[0].textContent?.trim() || '';
      } else {
        const cloneSq = sq.cloneNode(true);
        cloneSq.querySelectorAll('.root, .sqrt-sign, svg').forEach((n) => n.remove());
        rad = cloneSq.textContent?.trim() || '';
      }
      const rep = rootIdx ? (rootIdx === '3' ? `∛(${rad})` : `√[${rootIdx}](${rad})`) : `√(${rad})`;
      sq.replaceWith(doc.createTextNode(rep));
    });

    // 1b. Số mũ & Chỉ số dưới (.msupsub) trong .katex-html
    const supsubs = Array.from(khtml.querySelectorAll('.msupsub')).reverse();
    supsubs.forEach((ss) => {
      const vlist = ss.querySelector('.vlist-t .vlist');
      if (vlist && vlist.children.length > 0) {
        const parts = [];
        Array.from(vlist.children).forEach((ch) => {
          const txt = (ch.textContent || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (!txt) return;
          const style = ch.getAttribute('style') || '';
          const topMatch = style.match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
          const topVal = topMatch ? parseFloat(topMatch[1]) : -3.0;
          // Trong KaTeX, baseline là -2.5em: top < -2.75em là số mũ (^), top >= -2.75em là chỉ số dưới (_)
          if (topVal < -2.75) {
            if (/^[°∘o0]$/.test(txt)) parts.push('°');
            else parts.push(`^(${txt})`);
          } else {
            parts.push(`_(${txt})`);
          }
        });
        if (parts.length > 0) {
          ss.replaceWith(doc.createTextNode(parts.join('')));
          return;
        }
      }
      const rawSs = (ss.textContent || '').trim();
      if (rawSs) {
        ss.replaceWith(doc.createTextNode(`^(${rawSs})`));
      }
    });

    // 1c. Phân số (.mfrac) trong .katex-html
    // Lưu ý quan trọng: Trong .katex-html, .mfrac > .vlist-t > .vlist-r > .vlist xếp các phần tử từ DƯỚI lên TRÊN:
    // Child trước .frac-line (top ít âm hơn, vd -2.314em) là MẪU SỐ (Denominator).
    // Child sau .frac-line (top âm nhiều hơn, vd -3.677em) là TỬ SỐ (Numerator).
    const mfracs = Array.from(khtml.querySelectorAll('.mfrac')).reverse();
    mfracs.forEach((mf) => {
      const vlist = mf.querySelector('.vlist-t .vlist');
      if (vlist && vlist.children.length >= 2) {
        const children = Array.from(vlist.children);
        const lineIdx = children.findIndex((c) => c.querySelector('.frac-line') || c.classList?.contains('frac-line'));
        let num = '';
        let den = '';
        if (lineIdx > 0 && lineIdx < children.length - 1) {
          den = children.slice(0, lineIdx).map((c) => c.textContent.trim()).filter(Boolean).join('');
          num = children.slice(lineIdx + 1).map((c) => c.textContent.trim()).filter(Boolean).join('');
        } else {
          // Phân loại theo tọa độ top (càng âm càng nằm ở trên -> tử số)
          const nonLine = children.filter((c) => !c.querySelector('.frac-line') && !c.classList?.contains('frac-line'));
          if (nonLine.length >= 2) {
            const withTop = nonLine.map((c, idx) => {
              const m = (c.getAttribute('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
              return { el: c, top: m ? parseFloat(m[1]) : -idx };
            });
            withTop.sort((a, b) => a.top - b.top); // Nhỏ nhất (âm nhất) lên đầu = Tử số
            num = withTop[0].el.textContent.trim();
            den = withTop[withTop.length - 1].el.textContent.trim();
          }
        }
        if (num || den) {
          mf.replaceWith(doc.createTextNode(` (${num})/(${den}) `));
        }
      }
    });
  });

  // 2. Xử lý thẻ HTML <sup> và <sub> thông thường (ngoài hoặc còn sót)
  Array.from(rootEl.querySelectorAll('sup')).reverse().forEach((sup) => {
    const txt = (sup.textContent || '').trim();
    if (!txt) {
      sup.remove();
      return;
    }
    const nextTxt = sup.nextSibling?.textContent || '';
    if (/^[°∘o0]$/.test(txt) && (/^[CFK]\b/i.test(nextTxt.trim()) || txt === '°' || txt === '∘')) {
      sup.replaceWith(doc.createTextNode('°'));
    } else {
      sup.replaceWith(doc.createTextNode(`^(${txt})`));
    }
  });

  Array.from(rootEl.querySelectorAll('sub')).reverse().forEach((sub) => {
    const txt = (sub.textContent || '').trim();
    if (!txt) {
      sub.remove();
      return;
    }
    sub.replaceWith(doc.createTextNode(`_(${txt})`));
  });

  return rootEl;
}

/**
 * Chuẩn hóa cấu trúc Toán học trên cây Cheerio ($root) cho olm-direct-decoder
 */
function normalizeMathStructureInCheerio($, rootContext = null) {
  if (!$) return;
  const scope = rootContext ? $(rootContext) : $.root();

  function parseMathMLCheerio(elem) {
    if (!elem) return '';
    if (elem.type === 'text') return elem.data || '';
    if (elem.type !== 'tag') return '';
    const tag = (elem.name || '').toLowerCase().replace(/^m:/, '');
    if (tag === 'annotation') return '';
    const children = (elem.children || []).filter(
      (c) => c.type === 'tag' || (c.type === 'text' && (c.data || '').trim() !== '')
    );
    const elemChildren = (elem.children || []).filter((c) => c.type === 'tag');

    if (tag === 'mfrac' && elemChildren.length >= 2) {
      return `(${parseMathMLCheerio(elemChildren[0]).trim()})/(${parseMathMLCheerio(elemChildren[1]).trim()})`;
    }
    if (tag === 'msup' && elemChildren.length >= 2) {
      return `${parseMathMLCheerio(elemChildren[0]).trim()} padding_sup^(${parseMathMLCheerio(elemChildren[1]).trim()})`.replace(' padding_sup', '');
    }
    if (tag === 'msub' && elemChildren.length >= 2) {
      return `${parseMathMLCheerio(elemChildren[0]).trim()}_(${parseMathMLCheerio(elemChildren[1]).trim()})`;
    }
    if (tag === 'msubsup' && elemChildren.length >= 3) {
      return `${parseMathMLCheerio(elemChildren[0]).trim()}_(${parseMathMLCheerio(elemChildren[1]).trim()})^(${parseMathMLCheerio(elemChildren[2]).trim()})`;
    }
    if (tag === 'msqrt') {
      return `√(${children.map(parseMathMLCheerio).join('').trim()})`;
    }
    if (tag === 'mroot' && elemChildren.length >= 2) {
      const base = parseMathMLCheerio(elemChildren[0]).trim();
      const idx = parseMathMLCheerio(elemChildren[1]).trim();
      return idx === '3' ? `∛(${base})` : `√[${idx}](${base})`;
    }
    if (['mover', 'munder', 'munderover'].includes(tag) && elemChildren.length >= 2) {
      const [base, first, second] = elemChildren.map(parseMathMLCheerio);
      return tag === 'mover' ? `${base}^(${first})` : `${base}_(${first})${second ? `^(${second})` : ''}`;
    }
    if (tag === 'mtable') return `[${elemChildren.map(parseMathMLCheerio).join('; ')}]`;
    if (tag === 'mtr') return elemChildren.map(parseMathMLCheerio).join(', ');
    return children.map(parseMathMLCheerio).join('');
  }

  scope.find('.katex, .MathJax, mjx-container').each((_, k) => {
    const $k = $(k);
    const tex =
      $k.find('annotation[encoding="application/x-tex"]').text().trim() ||
      $k.find('math').attr('alttext') ||
      $k.attr('data-latex') ||
      $k.attr('alttext') ||
      '';
    if (tex) {
      $k.replaceWith($('<span>').text(' $' + tex + '$ '));
      return;
    }

    const mathEl = $k.find('.katex-mathml math, math').first();
    if (mathEl.length && mathEl.find('mfrac, msup, msub, msubsup, msqrt, mroot').length > 0) {
      const parsed = parseMathMLCheerio(mathEl[0]).trim();
      if (parsed) {
        $k.replaceWith($('<span>').text(' ' + parsed + ' '));
        return;
      }
    }

    $k.find('.katex-mathml, mjx-assistive-mml, .MJX_Assistive_MathML').remove();

    // Xử lý .sqrt trong .katex-html
    const sqrts = $k.find('.sqrt').toArray().reverse();
    sqrts.forEach((sq) => {
      const $sq = $(sq);
      const rootIdx = $sq.find('.root').text().trim();
      const vlist = $sq.find('.vlist-t .vlist').first();
      let rad = '';
      if (vlist.length && vlist.children().length > 0) {
        rad = vlist.children().first().text().trim();
      } else {
        const $c = $sq.clone();
        $c.find('.root, .sqrt-sign, svg').remove();
        rad = $c.text().trim();
      }
      const rep = rootIdx ? (rootIdx === '3' ? `∛(${rad})` : `√[${rootIdx}](${rad})`) : `√(${rad})`;
      $sq.replaceWith(rep);
    });

    // Xử lý .msupsub trong .katex-html
    const supsubs = $k.find('.msupsub').toArray().reverse();
    supsubs.forEach((ss) => {
      const $ss = $(ss);
      const vlist = $ss.find('.vlist-t .vlist').first();
      if (vlist.length && vlist.children().length > 0) {
        const parts = [];
        vlist.children().each((__, ch) => {
          const $ch = $(ch);
          const txt = $ch.text().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
          if (!txt) return;
          const style = $ch.attr('style') || '';
          const topMatch = style.match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
          const topVal = topMatch ? parseFloat(topMatch[1]) : -3.0;
          if (topVal < -2.75) {
            if (/^[°∘o0]$/.test(txt)) parts.push('°');
            else parts.push(`^(${txt})`);
          } else {
            parts.push(`_(${txt})`);
          }
        });
        if (parts.length > 0) {
          $ss.replaceWith(parts.join(''));
          return;
        }
      }
      const rawSs = $ss.text().trim();
      if (rawSs) $ss.replaceWith(`^(${rawSs})`);
    });

    // Xử lý .mfrac trong .katex-html
    const mfracs = $k.find('.mfrac').toArray().reverse();
    mfracs.forEach((mf) => {
      const $mf = $(mf);
      const vlist = $mf.find('.vlist-t .vlist').first();
      if (vlist.length && vlist.children().length >= 2) {
        const children = vlist.children().toArray();
        const lineIdx = children.findIndex((c) => $(c).find('.frac-line').length > 0 || $(c).hasClass('frac-line'));
        let num = '';
        let den = '';
        if (lineIdx > 0 && lineIdx < children.length - 1) {
          den = children.slice(0, lineIdx).map((c) => $(c).text().trim()).filter(Boolean).join('');
          num = children.slice(lineIdx + 1).map((c) => $(c).text().trim()).filter(Boolean).join('');
        } else {
          const nonLine = children.filter((c) => $(c).find('.frac-line').length === 0 && !$(c).hasClass('frac-line'));
          if (nonLine.length >= 2) {
            const withTop = nonLine.map((c, idx) => {
              const m = ($(c).attr('style') || '').match(/top:\s*([+-]?\d+(?:\.\d+)?)em/i);
              return { el: c, top: m ? parseFloat(m[1]) : -idx };
            });
            withTop.sort((a, b) => a.top - b.top);
            num = $(withTop[0].el).text().trim();
            den = $(withTop[withTop.length - 1].el).text().trim();
          }
        }
        if (num || den) {
          $mf.replaceWith(` (${num})/(${den}) `);
        }
      }
    });
  });

  scope.find('math').each((_, element) => {
    const math = $(element);
    const tex = math.find('annotation[encoding="application/x-tex"]').first().text().trim() || math.attr('alttext');
    const notation = tex ? ` $${tex}$ ` : ` ${parseMathMLCheerio(element)} `;
    math.replaceWith($('<span>').text(notation));
  });

  // 2. Xử lý thẻ HTML <sup> và <sub>
  const sups = scope.find('sup').toArray().reverse();
  sups.forEach((sup) => {
    const $sup = $(sup);
    const txt = $sup.text().trim();
    if (!txt) {
      $sup.remove();
      return;
    }
    const nextNode = sup.nextSibling;
    const nextTxt = nextNode && nextNode.data ? nextNode.data : '';
    if (/^[°∘o0]$/.test(txt) && (/^[CFK]\b/i.test(nextTxt.trim()) || txt === '°' || txt === '∘')) {
      $sup.replaceWith('°');
    } else {
      $sup.replaceWith(`^(${txt})`);
    }
  });

  const subs = scope.find('sub').toArray().reverse();
  subs.forEach((sub) => {
    const $sub = $(sub);
    const txt = $sub.text().trim();
    if (!txt) {
      $sub.remove();
      return;
    }
    $sub.replaceWith(`_(${txt})`);
  });
}

// Bảng ánh xạ chữ số/ký tự mũ & chỉ số dưới Unicode
const SUPERSCRIPT_MAP = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
  'ⁿ': 'n', 'ⁱ': 'i',
};

const SUBSCRIPT_MAP = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
  'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
  'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u',
  'ᵥ': 'v', 'ₓ': 'x',
};

function cleanScienceText(str, options = {}) {
  if (str === null || str === undefined) return '';
  let s = String(str);

  // 1. Chuẩn hóa khoảng trắng & ký tự điều khiển Unicode đặc biệt
  s = s.replace(/[\u200B-\u200D\uFEFF\u2060]/g, ''); // Zero-width spaces & word joiner
  s = s.replace(/\u00A0/g, ' '); // Non-breaking space
  s = s.replace(/[\r\n\t]+/g, ' ');

  // 2. Chuẩn hóa Unicode Superscript & Subscript sang dạng ^(...) và _(...)
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ]+/g, (match) => {
    const conv = match.split('').map((ch) => SUPERSCRIPT_MAP[ch] || ch).join('');
    return `^(${conv})`;
  });
  s = s.replace(/[₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+/g, (match) => {
    const conv = match.split('').map((ch) => SUBSCRIPT_MAP[ch] || ch).join('');
    return `_(${conv})`;
  });

  // 3. Chuẩn hóa Nhiệt độ, Độ góc, Độ C/F/K (Vật lý, Hóa học, Địa lý, Toán Hình học)
  s = s.replace(/℃/g, '°C').replace(/℉/g, '°F').replace(/K/g, 'K');
  s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘o0])\s*\}\s*([CFK])\b/g, '°$1');
  s = s.replace(/\^\(\s*(?:\\circ|\\degree|[°∘o0])\s*\)\s*([CFK])\b/g, '°$1');
  s = s.replace(/\^(?:\\circ|\\degree|[°∘])\s*([CFK])\b/g, '°$1');
  s = s.replace(/\^\{\s*(?:\\circ|\\degree|[°∘])\s*\}/g, '°');
  s = s.replace(/\^\(\s*(?:\\circ|\\degree|[°∘])\s*\)/g, '°');
  s = s.replace(/\\(?:circ|degree)(?![a-zA-Z])/g, '°');
  s = s.replace(/[∘˚º]/g, '°');
  s = s.replace(/°\s+([CFK])\b/g, '°$1');
  // Nhiệt độ viết kiểu 100 0C hoặc t(0C)
  s = s.replace(/(\d)\s*\^\(\s*[0o]\s*\)\s*([CFK])\b/g, '$1°$2');
  s = s.replace(/\b([tT])\s*\(\s*0\s*C\s*\)/g, '$1(°C)');

  // 4. Chuẩn hóa các biến thể dấu phẩy ĐẠO HÀM (Primes / Derivatives - Giải tích 11, 12, Đại học)
  s = s.replace(/\\(?:prime)(?![a-zA-Z])/g, "'");
  s = s.replace(/″|''/g, "''");
  s = s.replace(/‴|'''/g, "'''");
  s = s.replace(/[’‘′`]/g, "'");

  // 5. Chuẩn hóa dấu trừ & phép toán cơ bản (Lớp 1 - Đại học)
  s = s.replace(/[\u2212\u2013\u2014]/g, '-'); // Minus sign / En-dash / Em-dash
  s = s.replace(/\\(?:cdot|bullet|centerdot)(?![a-zA-Z])|[\u22C5\u2022\u2219]/g, '·'); // Dot multiplication
  s = s.replace(/\\times(?![a-zA-Z])|\u00D7/g, '×'); // Cross multiplication
  s = s.replace(/\\div(?![a-zA-Z])|\u00F7/g, ':'); // Division
  s = s.replace(/\\pm(?![a-zA-Z])|\u00B1/g, '±'); // Plus-minus
  s = s.replace(/\\mp(?![a-zA-Z])|\u2213/g, '∓'); // Minus-plus
  s = s.replace(/\\(?:ast|star)(?![a-zA-Z])|\u2217/g, '*');
  s = s.replace(/\\(?:oplus)(?![a-zA-Z])|\u2295/g, '⊕');
  s = s.replace(/\\(?:otimes)(?![a-zA-Z])|\u2297/g, '⊗');
  s = s.replace(/\\(?:odot)(?![a-zA-Z])|\u2299/g, '⊙');

  // Chuẩn hóa số mũ cơ số 10 trong Vật lý/Hóa học: 1,8.10^5 vs 1,8·10^5 vs 1,8×10^5
  s = s.replace(/(\d)\s*[\.·×]\s*10\s*\^/g, '$1·10^');

  // 6. Ký hiệu So sánh & Quan hệ Toán học / Tin học
  s = s.replace(/î€\s*=|\s*=/g, '≠');
  s = s.replace(/\\(?:neq|ne|not=)(?![a-zA-Z])/g, '≠');
  s = s.replace(/\\gt(?![a-zA-Z])/g, '>');
  s = s.replace(/\\lt(?![a-zA-Z])/g, '<');
  s = s.replace(/\\(?:ge|geq|geqslant)(?![a-zA-Z])|⩾/g, '≥');
  s = s.replace(/\\(?:le|leq|leqslant)(?![a-zA-Z])|⩽/g, '≤');
  s = s.replace(/\\(?:approx|thickapprox)(?![a-zA-Z])/g, '≈');
  s = s.replace(/\\(?:sim|thicksim)(?![a-zA-Z])|∼/g, '~');
  s = s.replace(/\\(?:simeq|cong)(?![a-zA-Z])|≃/g, '≅');
  s = s.replace(/\\equiv(?![a-zA-Z])/g, '≡');
  s = s.replace(/\\propto(?![a-zA-Z])/g, '∝');
  s = s.replace(/\\(?:ll)(?![a-zA-Z])/g, '≪');
  s = s.replace(/\\(?:gg)(?![a-zA-Z])/g, '≫');
  s = s.replace(/\\(?:mid| divides )(?![a-zA-Z])/g, '|');
  s = s.replace(/\\(?:nmid)(?![a-zA-Z])/g, '∤');

  // 7. Ký hiệu Logic, Phản ứng Hóa học & Mũi tên (Toán, Hóa, Sinh, Tin)
  s = s.replace(/\\xrightarrow(?:\[[^\]]*\])?\{[^{}]*\}/g, '→');
  s = s.replace(/\\xleftarrow(?:\[[^\]]*\])?\{[^{}]*\}/g, '←');
  s = s.replace(/\\(?:to|rightarrow|longrightarrow|mapsto)(?![a-zA-Z])|⟶|↦/g, '→');
  s = s.replace(/\\(?:leftarrow|longleftarrow)(?![a-zA-Z])|⟵/g, '←');
  s = s.replace(/\\(?:leftrightarrow|longleftrightarrow)(?![a-zA-Z])|⟷/g, '↔');
  s = s.replace(/\\(?:Rightarrow|implies|Longrightarrow)(?![a-zA-Z])|⟹/g, '⇒');
  s = s.replace(/\\(?:Leftarrow|Longleftarrow)(?![a-zA-Z])|⟸/g, '⇐');
  s = s.replace(/\\(?:Leftrightarrow|iff|Longleftrightarrow)(?![a-zA-Z])|⟺/g, '⇔');
  s = s.replace(/\\(?:rightleftharpoons|leftrightarrows|equilibrium)(?![a-zA-Z])|⇄/g, '⇌'); // Phản ứng thuận nghịch
  s = s.replace(/\\(?:uparrow)(?![a-zA-Z])/g, '↑'); // Khí bay hơi
  s = s.replace(/\\(?:downarrow)(?![a-zA-Z])/g, '↓'); // Kết tủa
  s = s.replace(/\\(?:land|wedge)(?![a-zA-Z])/g, '∧'); // Logic AND
  s = s.replace(/\\(?:lor|vee)(?![a-zA-Z])/g, '∨'); // Logic OR
  s = s.replace(/\\(?:lnot|neg)(?![a-zA-Z])/g, '¬'); // Logic NOT
  s = s.replace(/\\(?:vdash)(?![a-zA-Z])/g, '⊢');
  s = s.replace(/\\(?:models)(?![a-zA-Z])/g, '⊨');
  s = s.replace(/\\(?:therefore)(?![a-zA-Z])/g, '∴');
  s = s.replace(/\\(?:because)(?![a-zA-Z])/g, '∵');

  // 8. Ký hiệu Tập hợp, Không gian & Đại số Tuyến tính
  s = s.replace(/\\forall(?![a-zA-Z])/g, '∀');
  s = s.replace(/\\exists(?![a-zA-Z])/g, '∃');
  s = s.replace(/\\nexists(?![a-zA-Z])/g, '∄');
  s = s.replace(/\\in(?![a-zA-Z])/g, '∈');
  s = s.replace(/\\notin(?![a-zA-Z])/g, '∉');
  s = s.replace(/\\ni(?![a-zA-Z])/g, '∋');
  s = s.replace(/\\subset(?![a-zA-Z])/g, '⊂');
  s = s.replace(/\\supset(?![a-zA-Z])/g, '⊃');
  s = s.replace(/\\subseteq(?![a-zA-Z])/g, '⊆');
  s = s.replace(/\\supseteq(?![a-zA-Z])/g, '⊇');
  s = s.replace(/\\(?:nsubset|nsubseteq|not\\subset)(?![a-zA-Z])/g, '⊄');
  s = s.replace(/\\cup(?![a-zA-Z])/g, '∪');
  s = s.replace(/\\cap(?![a-zA-Z])/g, '∩');
  s = s.replace(/\\(?:setminus|backslash)(?![a-zA-Z])|∖/g, '\\');
  s = s.replace(/\\(?:emptyset|varnothing)(?![a-zA-Z])|⌀/g, '∅');
  s = s.replace(/\\mathbb\{R\}|\\mathbf\{R\}|\\bf R|ℝ/g, 'R');
  s = s.replace(/\\mathbb\{N\}|\\mathbf\{N\}|\\bf N|ℕ/g, 'N');
  s = s.replace(/\\mathbb\{Z\}|\\mathbf\{Z\}|\\bf Z|ℤ/g, 'Z');
  s = s.replace(/\\mathbb\{Q\}|\\mathbf\{Q\}|\\bf Q|ℚ/g, 'Q');
  s = s.replace(/\\mathbb\{C\}|\\mathbf\{C\}|\\bf C|ℂ/g, 'C');
  s = s.replace(/\\mathbb\{P\}|\\mathbf\{P\}|\\bf P|ℙ/g, 'P');
  s = s.replace(/\\mathbb\{F\}|\\mathbf\{F\}|\\bf F|𝔽/g, 'F');
  s = s.replace(/\\mathbb\{K\}|\\mathbf\{K\}|\\bf K|𝕂/g, 'K');
  s = s.replace(/\\langle(?![a-zA-Z])/g, '⟨');
  s = s.replace(/\\rangle(?![a-zA-Z])/g, '⟩');

  // 9. Tích phân, Vi phân, Đạo hàm riêng, Gradient, Chuỗi & Giới hạn (Giải tích THPT & Đại học)
  s = s.replace(/\\iiint(?![a-zA-Z])\s*|∭\s*/g, '∭');
  s = s.replace(/\\iint(?![a-zA-Z])\s*|∬\s*/g, '∬');
  s = s.replace(/\\oint(?![a-zA-Z])\s*|∮\s*/g, '∮');
  s = s.replace(/\\int(?![a-zA-Z])\s*|∫\s*/g, '∫');
  s = s.replace(/\\partial(?![a-zA-Z])/g, '∂');
  s = s.replace(/\\nabla(?![a-zA-Z])/g, '∇');
  s = s.replace(/\\mathrm\{d\}|\\text\{d\}|\\rm d/g, 'd');
  s = s.replace(/\\infty(?![a-zA-Z])/g, '∞');
  s = s.replace(/\\(?:limsup)(?![a-zA-Z])/g, 'limsup');
  s = s.replace(/\\(?:liminf)(?![a-zA-Z])/g, 'liminf');
  s = s.replace(/\\lim(?![a-zA-Z])/g, 'lim');
  s = s.replace(/\\(?:sup)(?![a-zA-Z])/g, 'sup');
  s = s.replace(/\\(?:inf)(?![a-zA-Z])/g, 'inf');
  s = s.replace(/\\(?:max)(?![a-zA-Z])/g, 'max');
  s = s.replace(/\\(?:min)(?![a-zA-Z])/g, 'min');
  s = s.replace(/\\(?:det)(?![a-zA-Z])/g, 'det');
  s = s.replace(/\\(?:dim)(?![a-zA-Z])/g, 'dim');
  s = s.replace(/\\(?:ker)(?![a-zA-Z])/g, 'ker');
  s = s.replace(/\\(?:gcd)(?![a-zA-Z])/g, 'gcd');
  s = s.replace(/\\(?:lcm)(?![a-zA-Z])/g, 'lcm');
  s = s.replace(/\\(?:bmod|pmod|mod)(?![a-zA-Z])/g, 'mod');
  s = s.replace(/\\sum(?![a-zA-Z])/g, '∑');
  s = s.replace(/\\prod(?![a-zA-Z])/g, '∏');
  s = s.replace(/\\coprod(?![a-zA-Z])/g, '∐');

  // 10. Hàm Lượng giác, اللوغاريتم (Logarit), Hàm Hyperbolic
  s = s.replace(/\\(?:arcsin|arccos|arctan|arccot|sinh|cosh|tanh|coth|sin|cos|tan|cot|sec|csc|ln|log|lg|exp)(?![a-zA-Z])/g, (m) => m.slice(1));
  s = s.replace(/\\tg(?![a-zA-Z])/g, 'tan');
  s = s.replace(/\\cotg(?![a-zA-Z])/g, 'cot');

  // 11. Căn thức, Phân số & Tổ hợp (\frac, \sqrt, \binom)
  for (let f = 0; f < 4; f++) {
    s = s.replace(/\\(?:dfrac|frac|tfrac|cfrac)\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)');
    s = s.replace(/\\binom\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, 'C($1,$2)');
  }
  s = s.replace(/\\sqrt\[3\]\s*\{([^{}]+)\}/g, '∛($1)');
  s = s.replace(/\\sqrt\[4\]\s*\{([^{}]+)\}/g, '∜($1)');
  s = s.replace(/\\sqrt\[([^{}]+)\]\s*\{([^{}]+)\}/g, '√[$1]($2)');
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, '√($1)');
  s = s.replace(/√\s*([a-zA-Z0-9]+)/g, '√($1)');

  // 12. Ký hiệu Hình học, Vectơ, Góc & Đoạn thẳng
  s = s.replace(/\\(?:overrightarrow|overleftarrow|vec|vect)\s*\{([^{}]+)\}/g, 'vectơ $1');
  s = s.replace(/\\(?:widehat|wideparen)\s*\{([^{}]+)\}/g, 'góc $1');
  s = s.replace(/\\(?:overline|bar)\s*\{([^{}]+)\}/g, '$1');
  s = s.replace(/\\(?:underline)\s*\{([^{}]+)\}/g, '$1');
  s = s.replace(/\\(?:hat)\s*\{([^{}]+)\}/g, '$1');
  s = s.replace(/\\(?:dot)\s*\{([^{}]+)\}/g, "$1'");
  s = s.replace(/\\(?:ddot)\s*\{([^{}]+)\}/g, "$1''");
  s = s.replace(/\\perp(?![a-zA-Z])/g, '⊥');
  s = s.replace(/\\parallel(?![a-zA-Z])|\u2225/g, '∥');
  s = s.replace(/\\(?:angle|measuredangle|sphericalangle)(?![a-zA-Z])|∡|∢/g, '∠');
  s = s.replace(/\\(?:triangle|bigtriangleup|vartriangle)(?![a-zA-Z])|∆(?=\s*[A-Z]{3})/g, '△');

  // 13. Trọn bộ Bảng chữ cái Hy Lạp (Toán, Vật lý, Hóa học, Thống kê, Kỹ thuật điện, Kinh tế)
  // Chữ hoa Hy Lạp
  s = s.replace(/\\Gamma(?![a-zA-Z])/g, 'Γ');
  s = s.replace(/\\Delta(?![a-zA-Z])|\u2206|𝛥/g, 'Δ');
  s = s.replace(/\\Theta(?![a-zA-Z])/g, 'Θ');
  s = s.replace(/\\Lambda(?![a-zA-Z])/g, 'Λ');
  s = s.replace(/\\Xi(?![a-zA-Z])/g, 'Ξ');
  s = s.replace(/\\Pi(?![a-zA-Z])/g, 'Π');
  s = s.replace(/\\Sigma(?![a-zA-Z])/g, 'Σ');
  s = s.replace(/\\Upsilon(?![a-zA-Z])/g, 'Υ');
  s = s.replace(/\\Phi(?![a-zA-Z])/g, 'Φ');
  s = s.replace(/\\Psi(?![a-zA-Z])/g, 'Ψ');
  s = s.replace(/\\Omega(?![a-zA-Z])|\u2126/g, 'Ω'); // Ohm

  // Chữ thường Hy Lạp
  s = s.replace(/\\alpha(?![a-zA-Z])/g, 'α');
  s = s.replace(/\\beta(?![a-zA-Z])/g, 'β');
  s = s.replace(/\\gamma(?![a-zA-Z])/g, 'γ');
  s = s.replace(/\\delta(?![a-zA-Z])/g, 'δ');
  s = s.replace(/\\(?:varepsilon|epsilon)(?![a-zA-Z])|ϵ/g, 'ε');
  s = s.replace(/\\zeta(?![a-zA-Z])/g, 'ζ');
  s = s.replace(/\\eta(?![a-zA-Z])/g, 'η');
  s = s.replace(/\\(?:vartheta|theta)(?![a-zA-Z])|ϑ/g, 'θ');
  s = s.replace(/\\iota(?![a-zA-Z])/g, 'ι');
  s = s.replace(/\\(?:varkappa|kappa)(?![a-zA-Z])/g, 'κ');
  s = s.replace(/\\lambda(?![a-zA-Z])/g, 'λ');
  s = s.replace(/\\(?:mu|micro)(?![a-zA-Z])|\u00B5/g, 'μ'); // Micro
  s = s.replace(/\\nu(?![a-zA-Z])/g, 'ν');
  s = s.replace(/\\xi(?![a-zA-Z])/g, 'ξ');
  s = s.replace(/\\(?:varpi|pi)(?![a-zA-Z])/g, 'π');
  s = s.replace(/\\(?:varrho|rho)(?![a-zA-Z])|ϱ/g, 'ρ');
  s = s.replace(/\\(?:varsigma|sigma)(?![a-zA-Z])|ς/g, 'σ');
  s = s.replace(/\\tau(?![a-zA-Z])/g, 'τ');
  s = s.replace(/\\upsilon(?![a-zA-Z])/g, 'υ');
  s = s.replace(/\\(?:varphi|phi)(?![a-zA-Z])|\u03D5/g, 'φ');
  s = s.replace(/\\chi(?![a-zA-Z])/g, 'χ');
  s = s.replace(/\\psi(?![a-zA-Z])/g, 'ψ');
  s = s.replace(/\\omega(?![a-zA-Z])/g, 'ω');

  // 14. Hằng số Vật lý Lượng tử & Đơn vị đặc biệt
  s = s.replace(/\\hbar(?![a-zA-Z])/g, 'ℏ');
  s = s.replace(/\\ell(?![a-zA-Z])/g, 'ℓ');
  s = s.replace(/\\AA(?![a-zA-Z])|\u212B/g, 'Å');

  // 15. Loại bỏ formatting rác LaTeX không làm đổi ngữ nghĩa
  s = s.replace(/\\(?:displaystyle|textstyle|scriptstyle|scriptscriptstyle|limits|nolimits|left|right|big|Big|bigg|Bigg|middle)(?![a-zA-Z])/g, '');
  for (let t = 0; t < 3; t++) {
    s = s.replace(/\\(?:mathrm|text|mbox|hbox|mathit|mathbf|mathsf|mathcal|mathscr|mathfrak|textbf|textit|textrm|operatorname)\s*\{([^{}]*)\}/g, '$1');
  }
  s = s.replace(/\\(?:quad|qquad|space|thinspace|enspace|;|!|,|:)(?![a-zA-Z])/g, ' ');
  s = s.replace(/\\\(\s*|\s*\\\)/g, ' ');
  s = s.replace(/\\\[\s*|\s*\\\]/g, ' ');
  s = s.replace(/\$+/g, ''); // Bỏ dấu $ bọc LaTeX
  s = s.replace(/[\uE000-\uF8FF]/g, ''); // Private Use Area

  // 16. Đồng bộ định dạng Số mũ ^{...} / ^(...) và Chỉ số dưới _{...} / _(...)
  // Đơn giản hóa ^(2) hoặc ^{2} -> ^2 khi bên trong chỉ là chữ hoặc số đơn giản
  s = s.replace(/\^\{\s*([^{}]+?)\s*\}/g, '^($1)');
  s = s.replace(/_\{\s*([^{}]+?)\s*\}/g, '_($1)');
  s = s.replace(/\^\(\s*([a-zA-Z]|[+-]?\d+)\s*\)/g, '^$1');
  s = s.replace(/_\(\s*([a-zA-Z]|[+-]?\d+)\s*\)/g, '_$1');

  // Bỏ ngoặc đơn bọc quanh 1 ký tự đơn lẻ trong phân số: (Q)/(mΔT) -> Q/(mΔT), (λ)/(m) -> λ/m
  s = s.replace(/\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)\s*\/\s*\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)/g, '$1/$2');
  s = s.replace(/\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)\s*\//g, '$1/');
  s = s.replace(/\/\s*\(\s*([a-zA-Z0-9α-ωΑ-Ωℏℓ])\s*\)/g, '/$1');

  // 17. Chuẩn hóa dấu câu trong toán & khoa học (GIỮ NGUYÊN dấu phẩy số thập phân tiếng Việt như 24,9 hoặc 13,6)
  s = s.replace(/\s*([,;])\s*/g, '$1 ');
  s = s.replace(/(\d)\s*,\s*(\d)/g, '$1,$2');
  s = s.replace(/\s*\(\s*/g, '(');
  s = s.replace(/\s*\)\s*/g, ')');
  s = s.replace(/\s*\[\s*/g, '[');
  s = s.replace(/\s*\]\s*/g, ']');
  s = s.replace(/[{}]/g, ''); // Loại bỏ dấu ngoặc nhọn nhóm còn sót trong công thức hóa học/toán học LaTeX
  s = s.replace(/\s+/g, ' ').trim();

  // 18. Nếu yêu cầu tạo khóa so khớp trơ (loose key) khi HTML bị mất thẻ sup/sub (m^2 vs m2, H_2O vs H2O)
  if (options.stripSubSupMarkers) {
    s = s.replace(/[\^_]\(?([a-zA-Z0-9+\-]+)\)?/g, '$1');
  }

  // 19. Nếu yêu cầu so khớp không phân biệt hoa thường (mặc định GIỮ CASE vì F(x) != f(x), CO != Co)
  if (options.ignoreCase) {
    s = s.toLowerCase();
  }

  return s;
}

/**
 * Trích xuất Text & Công thức chuẩn xác từ một Node DOM (KaTeX, MathML, MathJax, SVG, Image)
 */
function extractScienceTextFromDOM(el) {
  if (!el) return '';

  const clone = el.cloneNode(true);
  normalizeMathStructureInDOM(clone);

  // Xóa script, style, svg rác
  clone.querySelectorAll('script, style, svg').forEach((n) => n.remove());

  // Lấy text thuần đã qua bộ chuẩn hóa cấu trúc Toán học
  let rawText = (clone.innerText || clone.textContent || '').replace(/\s+/g, ' ').trim();

  // Bỏ tiền tố phương án A., B., C., D. hoặc (A), (B)...
  rawText = rawText.replace(/^(?:[A-D\d][\.\)\:\-]\s*|\([A-D\d]\)\s*|\[[A-D\d]\]\s*)/i, '').trim();

  // Nếu text rỗng nhưng có ảnh
  if (!rawText) {
    const img = clone.querySelector('img:not(.emoji):not(.icon)');
    if (img) {
      const src = img.getAttribute('src') || img.src || '';
      return `[Hình ảnh: ${src}]`;
    }
  }

  return rawText;
}

module.exports = {
  cleanScienceText,
  extractScienceTextFromDOM,
  normalizeMathStructureInDOM,
  normalizeMathStructureInCheerio,
};
