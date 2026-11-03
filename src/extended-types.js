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
function collectShadowRoots(el, out = []) {
  if (!el || !el.querySelectorAll) return out;
  for (const node of el.querySelectorAll('*')) {
    if (node.shadowRoot) {
      out.push(node.shadowRoot);
      collectShadowRoots(node.shadowRoot, out);
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
  return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// NHẬN DIỆN DẠNG CÂU HỎI
// ---------------------------------------------------------------------------

// Chạy trong trang. Trả về descriptor dạng câu hỏi, hoặc null nếu không khớp
// dạng nào trong nhóm mở rộng.
function detectInPage() {
  const defRoot = document.querySelector('default-root');
  const root = defRoot?.shadowRoot || defRoot || document;

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

  // --- 3. Ghép đôi / nối cột: hai cột + các chấm tròn nhỏ ---
  const pairDots = deepQueryAll(root, '[class*=pair-dot], [class*=match-dot], [class*=connect-dot], [class*=line-dot], [data-pair], [data-match]').filter(isVisible);
  if (pairDots.length >= 2) {
    const left = deepQueryAll(root, '[class*=col-a], [class*=column-a], [class*=left-col], [data-col="A"]').filter(isVisible);
    const right = deepQueryAll(root, '[class*=col-b], [class*=column-b], [class*=right-col], [data-col="B"]').filter(isVisible);
    const leftItems = (left.length ? left : deepQueryAll(root, '[class*=match-item], [class*=pair-item]')).filter(isVisible);
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

  return null;
}

// ---------------------------------------------------------------------------
// ĐIỀN ĐÁP ÁN CHO CÁC DẠNG MỞ RỘNG
// ---------------------------------------------------------------------------

// Click phần tử + phát thêm sự kiện để các framework (Lit/React) nhận biết.
async function clickEl(page, handle) {
  try {
    await handle.click({ delay: 30 });
  } catch {
    try {
      await page.evaluate((el) => {
        el.click();
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }));
      }, handle);
    } catch {}
  }
}

// --- Dropdown ---
async function fillDropdown(page, question, answer) {
  const targetText = String(answer.answer ?? '').trim();
  const targetIdx = Number.isInteger(answer.correctIndex) && answer.correctIndex >= 0 ? answer.correctIndex : -1;

  // Ưu tiên <select> native: set value + fire change.
  const native = await page.evaluate(({ text, idx }) => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
    if (idx >= 0 && idx < opts.length) target = idx;
    if (target < 0) {
      target = opts.findIndex((o) => (o.textContent || '').trim().toLowerCase() === text.toLowerCase());
    }
    if (target < 0 && text) {
      target = opts.findIndex((o) => {
        const ot = (o.textContent || '').trim().toLowerCase();
        return ot.includes(text.toLowerCase()) || text.toLowerCase().includes(ot);
      });
    }
    if (target < 0) return { ok: false, reason: 'option-not-found' };

    sel.value = opts[target].value;
    sel.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, selectedIndex: target, value: sel.value };
  }, { text: targetText, idx: targetIdx });

  if (native.ok) return native;

  // Dropdown tuần dựng: click để mở, rồi click option.
  const custom = await page.evaluate(({ text, idx }) => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return { ok: true, opened: true };
  }, { text: targetText, idx: targetIdx });

  if (!custom.ok) return custom;

  await new Promise((r) => setTimeout(r, 400));

  const picked = await page.evaluate(({ text, idx }) => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
      target = opts.findIndex((o) => (o.innerText || '').trim().toLowerCase() === text.toLowerCase());
    }
    if (target < 0 && text) {
      target = opts.findIndex((o) => {
        const ot = (o.innerText || '').trim().toLowerCase();
        return ot.includes(text.toLowerCase()) || text.toLowerCase().includes(ot);
      });
    }
    if (target < 0) return { ok: false, reason: 'option-not-found' };

    const opt = opts[target];
    opt.click();
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    return { ok: true, selectedIndex: target };
  }, { text: targetText, idx: targetIdx });

  return picked;
}

// --- Kéo thả / Gom nhóm ---
async function fillDragDrop(page, question, answer) {
  const mapping = Array.isArray(answer.mapping) ? answer.mapping : [];
  if (!mapping.length) return { ok: false, reason: 'no-mapping' };

  // Lấy danh sách thẻ nguồn và các ô đích từ DOM (theo thứ tự hiển thị).
  const boxes = await page.evaluate(() => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
    return visible.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        isZone: el.matches('[data-dropzone], .dropzone, .drop-zone, .group-box, .category-box, .tw-drop-item, .qgroup'),
      };
    });
  });

  if (!boxes.length) return { ok: false, reason: 'no-drag-elements' };

  const sources = boxes.filter((b) => !b.isZone);
  const zones = boxes.filter((b) => b.isZone);

  let placed = 0;
  for (const m of mapping) {
    const itemIdx = Number(m.item);
    const targetIdx = Number(m.target);
    if (!Number.isInteger(itemIdx) || !Number.isInteger(targetIdx)) continue;

    const src = sources[itemIdx];
    // targetIdx trong danh sách "targets" mà AI nhận -> map sang vị trí zone thực tế.
    const zone = zones[targetIdx] || boxes.find((b) => b.text === (question.targets || [])[targetIdx]);
    if (!src || !zone) continue;

    // Kéo bằng chuột (hỗ trợ cả thư viện dùng pointer events)
    try {
      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      // Di chuyển theo nhiều bước để thư viện kéo-thả nhận biết đường đi
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(
          src.x + ((zone.x - src.x) * i) / steps,
          src.y + ((zone.y - src.y) * i) / steps
        );
      }
      await page.mouse.move(zone.x, zone.y);
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 250));
      placed++;
      continue;
    } catch {}

    // Dự phòng: phát sự kiện HTML5 drag & drop với DataTransfer dùng chung
    try {
      await page.evaluate(({ si, ti }) => {
        const defRoot = document.querySelector('default-root');
        const root = defRoot?.shadowRoot || defRoot || document;
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
      }, { si: itemIdx, ti: targetIdx });
      placed++;
    } catch {}
  }

  if (!placed) return { ok: false, reason: 'drag-failed' };
  return { ok: true, placed };
}

// --- Ghép đôi ---
async function fillMatching(page, question, answer) {
  const pairs = Array.isArray(answer.pairs) ? answer.pairs : [];
  if (!pairs.length) return { ok: false, reason: 'no-pairs' };

  // Chấm nối: click chấm cột A rồi click chấm cột B tương ứng.
  const dots = await page.evaluate(() => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
      // Xác định cột A/B dựa trên vị trí x tương đối
      const half = window.innerWidth / 2;
      return {
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        side: r.left < half ? 'A' : 'B',
      };
    });
  });

  if (dots.length < 2) return { ok: false, reason: 'no-pair-dots' };

  const sideA = dots.filter((d) => d.side === 'A');
  const sideB = dots.filter((d) => d.side === 'B');

  let paired = 0;
  for (const p of pairs) {
    const li = Number(p.left);
    const ri = Number(p.right);
    if (!Number.isInteger(li) || !Number.isInteger(ri)) continue;
    const a = sideA[li] || dots[li];
    const b = sideB[ri] || dots[sideA.length + ri];
    if (!a || !b) continue;
    try {
      await page.mouse.click(a.x, a.y);
      await new Promise((r) => setTimeout(r, 150));
      await page.mouse.click(b.x, b.y);
      await new Promise((r) => setTimeout(r, 200));
      paired++;
    } catch {}
  }

  if (!paired) return { ok: false, reason: 'pair-failed' };
  return { ok: true, paired };
}

// --- Hotspot ---
async function fillHotspot(page, question, answer) {
  const zones = await page.evaluate(() => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
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
  });

  if (!zones.length) return { ok: false, reason: 'no-hotspot-zones' };

  // Ưu tiên khớp theo mô tả vị trí mà AI trả về
  const desc = String(answer.answer || '').trim().toLowerCase();
  let target = -1;
  if (desc) {
    target = zones.findIndex((z) => z.text && desc.includes(z.text.toLowerCase()));
    if (target < 0) {
      target = zones.findIndex((z) => z.text && z.text.toLowerCase().includes(desc));
    }
  }
  // Dùng box tương đối nếu AI trả về toạ độ
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

// --- Gạch chân / chọn từ ---
async function fillWordSelect(page, question, answer) {
  const idxs = Array.isArray(answer.correctIndices)
    ? answer.correctIndices.map(Number).filter((n) => Number.isInteger(n) && n >= 0)
    : [];
  if (!idxs.length) return { ok: false, reason: 'no-word-indices' };

  const words = await page.evaluate(() => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[class*=underline], [class*=word-select], [class*=highlight-word], [data-word], [class*=token]')));
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
  });

  if (!words.length) return { ok: false, reason: 'no-word-elements' };

  let clicked = 0;
  for (const i of idxs) {
    const w = words[i];
    if (!w) continue;
    try {
      await page.mouse.click(w.x, w.y);
      await new Promise((r) => setTimeout(r, 150));
      clicked++;
    } catch {}
  }
  if (!clicked) return { ok: false, reason: 'word-click-failed' };
  return { ok: true, clicked };
}

// --- Tự luận ---
async function fillEssay(page, question, answer) {
  const text = String(answer.answer || '').trim();
  if (!text) return { ok: false, reason: 'no-essay-text' };

  const res = await page.evaluate((val) => {
    const defRoot = document.querySelector('default-root');
    const root = defRoot?.shadowRoot || defRoot || document;
    const all = [];
    const walk = (r) => {
      try {
        all.push(...Array.from(r.querySelectorAll('[contenteditable="true"], textarea, .ProseMirror, .ql-editor, [class*=rich-text], [class*=editor]')));
      } catch {}
      try {
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      } catch {}
    };
    walk(root);
    const ed = all.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    });
    if (!ed) return { ok: false, reason: 'no-editor' };

    ed.scrollIntoView({ behavior: 'instant', block: 'center' });
    ed.focus();

    const isTextarea = ed.tagName === 'TEXTAREA';
    if (isTextarea) {
      ed.value = val;
      ed.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      ed.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } else {
      // contenteditable: xoá nội dung cũ rồi chèn text
      try {
        ed.innerHTML = '';
      } catch {}
      const lines = val.split('\n');
      lines.forEach((line, i) => {
        if (i > 0) ed.appendChild(document.createElement('br'));
        ed.appendChild(document.createTextNode(line));
      });
      ed.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: val }));
      ed.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }
    return { ok: true, tag: ed.tagName };
  }, text);

  if (!res.ok) return res;

  // Gõ thêm bằng bàn phím để chắc chắn framework bắt được input event
  try {
    await page.keyboard.press('Backspace');
    await page.keyboard.type(text.slice(0, 2000), { delay: 8 });
  } catch {}

  return res;
}

// ---------------------------------------------------------------------------
// API công khai
// ---------------------------------------------------------------------------

// Dò dạng câu hỏi mở rộng. Trả về null nếu câu hỏi thuộc dạng cơ bản
// (trắc nghiệm / điền khuyết / đúng-sai) vốn đã được xử lý ở browser-engine.
async function detect(page) {
  try {
    const res = await page.evaluate(detectInPage);
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
    default:
      return { ok: false, reason: `unsupported-extended-type:${question.type}` };
  }
}

// Có phải dạng mở rộng không (dùng để quyết định đường đi trong browser-engine)
function isExtended(type) {
  return ['dropdown', 'drag_drop', 'grouping', 'matching', 'hotspot', 'word_select', 'underline', 'essay']
    .includes(type);
}

module.exports = { detect, fill, isExtended };
