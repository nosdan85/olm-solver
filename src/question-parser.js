'use strict';

const cheerio = require('cheerio');
const { normalizeMathStructureInCheerio } = require('./science-normalizer');

// Parse a homework page into a list of questions with their options.
// The markup changes over time, so we try several known shapes and fall back
// to a generic "find radio/checkbox groups" scan.
function parseQuestions(html, { url = '' } = {}) {
  const $ = cheerio.load(html);
  normalizeMathStructureInCheerio($);
  const questions = [];
  const selector = '.question-item, .question, .quiz-question, .exercise-question, .item-question, [data-question-id], fieldset, .cau-hoi, .question-wrapper';
  for (const node of $(selector).toArray()) {
    if ($(node).find(selector).length) continue;
    questions.push(...extractQuestion($, node, url));
  }
  if (!questions.length) {
    const forms = new Set();
    $(CHOICE_INPUTS).each((_, input) => {
      if (!$(input).attr('name')) return;
      forms.add($(input).closest('form')[0] || $('body')[0]);
    });
    for (const form of forms) questions.push(...extractQuestion($, form, url));
  }

  return questions;
}

const CHOICE_INPUTS = 'input[type=radio][name]:enabled, input[type=checkbox][name]:enabled';

function extractQuestion($, node, url) {
  const $node = $(node);
  const imageSources = $node.find('img:not(.icon):not(.emoji)').map((_, image) =>
    $(image).attr('data-src') || $(image).attr('src')).get().filter(Boolean);
  const needsBrowser = $node.find('canvas, svg').length > 0;
  const text = extractText($, $node) || (imageSources.length || needsBrowser ? '[Đề bài có hình]' : '');
  const options = [];
  const groups = new Map();
  $node.find(CHOICE_INPUTS).each((_, node) => {
    const name = $(node).attr('name');
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(node);
  });
  if (groups.size) {
    return Array.from(groups, ([name, inputs]) => {
      const groupStem = $(inputs[0]).closest('fieldset, .question, .cau-hoi, [data-question-id]');
      return {
        id: groups.size === 1 ? ($node.attr('data-question-id') || $node.attr('id') || name) : name,
        text: (groupStem.length ? extractText($, groupStem) : '') || text,
        options: inputs.map((input, index) => extractLabelFor($, $(input)) || '[Phương án ' + (index + 1) + ']'),
        imageSources, needsBrowser,
        optionValues: inputs.map(input => $(input).attr('value') ?? 'on'),
        type: $(inputs[0]).attr('type') === 'checkbox' ? 'multi_choice' : 'radio',
        name, url,
      };
    });
  }
  if (!text) return [];

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

  const textFields = $node.find('textarea[name], input[name]:not([type]), input[type=text][name], input[type=number][name]').filter(':enabled');
  return [{
    id: $node.attr('data-question-id') || $node.attr('id') || `q${Math.random().toString(36).slice(2, 8)}`,
    text,
    options,
    imageSources,
    needsBrowser,
    type: textFields.length ? 'short_answer' : 'radio',
    name: textFields.first().attr('name') || null,
    fieldNames: textFields.map((_, field) => $(field).attr('name')).get(),
    blankCount: textFields.length,
    url,
  }];
}

function extractText($, $node) {
  const $copy = $node.clone();
  $copy.find('.answer, .answer-item, .option, .option-item, .choice, .dap-an, img, svg, .explain').remove();
  $copy.find('label').filter((_, label) => $(label).find(CHOICE_INPUTS).length ||
    $(label).attr('for') && $node.find(CHOICE_INPUTS).toArray().some(input => $(input).attr('id') === $(label).attr('for'))).remove();
  return $copy.text().replace(/\s+/g, ' ').trim();
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
  const wrap = $input.parent();
  if (wrap.is('.answer, .answer-item, .option, .option-item, .choice, .dap-an, li') &&
      wrap.find(CHOICE_INPUTS).length === 1) {
    const text = wrap.text().trim();
    if (text) return text;
  }
  return $input.attr('aria-label') || $input.attr('value') || '';
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
    const fields = Object.create(null);
    form.find('input[type=hidden][name]').each((_, el) => {
      const input = $(el);
      if (input.is(':disabled')) return;
      const name = input.attr('name');
      const value = input.attr('value') || '';
      fields[name] = name in fields ? [].concat(fields[name], value) : value;
    });
    const action = form.attr('action');
    return {
      action: action ? new URL(action, baseUrl).toString() : baseUrl,
      method: (form.attr('method') || 'post').toLowerCase(),
      formId: form.attr('id') || null,
      fields,
    };
  }

  return { action: null, method: 'post', formId: null, fields: {} };
}

module.exports = { parseQuestions, findSubmitInfo, cssEscape };
