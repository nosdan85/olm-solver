'use strict';

const cheerio = require('cheerio');

// Parse a homework page into a list of questions with their options.
// The markup changes over time, so we try several known shapes and fall back
// to a generic "find radio/checkbox groups" scan.
function parseQuestions(html, { url = '' } = {}) {
  const $ = cheerio.load(html);
  const questions = [];
  const seen = new Set();

  const QUESTION_SELECTORS = [
    '.question-item',
    '.question',
    '.quiz-question',
    '.exercise-question',
    '.item-question',
    '[data-question-id]',
    'fieldset',
    '.cau-hoi',
    '.question-wrapper',
  ];

  for (const sel of QUESTION_SELECTORS) {
    const nodes = $(sel);
    if (nodes.length === 0) continue;
    nodes.each((_, node) => {
      const q = extractQuestion($, node, url);
      if (!q) return;
      const key = `${q.text}::${q.options.join('|')}`;
      if (seen.has(key)) return;
      seen.add(key);
      questions.push(q);
    });
    if (questions.length > 0) break;
  }

  if (questions.length === 0) {
    // Generic: group radios/checkboxes by their closest container.
    $('input[type=radio], input[type=checkbox]').each((_, input) => {
      const $input = $(input);
      const name = $input.attr('name');
      if (!name) return;
      const $container = $input.closest('.question, .question-item, li, form, div').first();
      const text = extractText($, $container);
      if (!text) return;
      const key = `radio:${name}`;
      if (seen.has(key)) return;
      seen.add(key);
      const options = [];
      $(`input[name="${cssEscape(name)}"]`).each((__, o) => {
        const label = extractLabelFor($, $(o));
        if (label) options.push(label);
      });
      questions.push({
        id: name,
        text,
        options,
        type: $input.attr('type') || 'radio',
        name,
        url,
      });
    });
  }

  return questions;
}

function extractQuestion($, node, url) {
  const $node = $(node);
  const text = extractText($, $node);
  if (!text) return null;

  const options = [];
  const type = 'radio';

  // Options can be radios/checkboxes or plain clickable divs.
  const $inputs = $node.find('input[type=radio], input[type=checkbox]');
  if ($inputs.length > 0) {
    const name = $inputs.first().attr('name');
    $inputs.each((_, input) => {
      const label = extractLabelFor($, $(input));
      if (label) options.push(label);
    });
    return {
      id: $node.attr('data-question-id') || $node.attr('id') || name || `q${Math.random().toString(36).slice(2, 8)}`,
      text,
      options,
      type: $inputs.first().attr('type') || type,
      name: name || null,
      url,
    };
  }

  const OPTION_SELECTORS = [
    '.answer',
    '.answer-item',
    '.option',
    '.option-item',
    '.choice',
    '.dap-an',
    'li.answer',
  ];
  for (const sel of OPTION_SELECTORS) {
    const $opts = $node.find(sel);
    if ($opts.length > 0) {
      $opts.each((_, o) => {
        const t = ($(o).text() || '').trim();
        if (t) options.push(t);
      });
      break;
    }
  }

  return {
    id: $node.attr('data-question-id') || $node.attr('id') || `q${Math.random().toString(36).slice(2, 8)}`,
    text,
    options,
    type,
    name: null,
    url,
  };
}

function extractText($, $node) {
  const $copy = $node.clone();
  $copy.find('.answer, .answer-item, .option, .option-item, .choice, .dap-an, img, svg, .explain').remove();
  const raw = ($copy.text() || '').replace(/\s+/g, ' ').trim();
  return raw.length > 2 ? raw : '';
}

function extractLabelFor($, $input) {
  const id = $input.attr('id');
  if (id) {
    const $label = $(`label[for="${cssEscape(id)}"]`);
    if ($label.length) {
      const t = ($label.text() || '').trim();
      if (t) return t;
    }
  }
  const $label = $input.closest('label');
  if ($label.length) {
    const t = ($label.text() || '').trim();
    if (t) return t;
  }
  const $wrap = $input.parent();
  if ($wrap.length) {
    const t = ($wrap.text() || '').trim();
    if (t) return t;
  }
  return $input.attr('value') || '';
}

// Minimal CSS attribute-selector escaping for ids containing quotes/specials.
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

// Find the submit button / endpoint on a homework page.
function findSubmitInfo(html, baseUrl) {
  const $ = cheerio.load(html);
  const $btn = $('button[type=submit], input[type=submit], .submit, .btn-submit, .nop-bai, button')
    .filter((_, el) => /nộp|nop|submit|gửi/i.test($(el).text() || $(el).attr('value') || ''))
    .first();

  const form = $btn.closest('form');
  if (form.length) {
    const action = form.attr('action');
    return {
      action: action ? new URL(action, baseUrl).toString() : baseUrl,
      method: (form.attr('method') || 'post').toLowerCase(),
      formId: form.attr('id') || null,
    };
  }

  return { action: baseUrl, method: 'post', formId: null };
}

module.exports = { parseQuestions, findSubmitInfo, cssEscape };