'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBatchPrompt, validateBatchAnswers } = require('../src/answer-engine');

const questions = [
  { id: 'q_1', type: 'choice', text: '2+2?', options: ['3', '4'] },
  { id: 'q_2', type: 'true_false', text: 'Earth', statements: ['is round'] },
  { id: 'q_3', type: 'short_answer', text: 'Name the number' },
];

test('batch prompt carries stable IDs and question details', () => {
  const prompt = buildBatchPrompt(questions);
  assert.match(prompt, /ID: q_1/);
  assert.match(prompt, /\[1\] 4/);
  assert.match(prompt, /ID: q_2/);
  assert.match(prompt, /is round/);
  assert.match(prompt, /ID: q_3/);
});

test('answers are mapped by ID regardless of response ordering', () => {
  const result = validateBatchAnswers({ answers: [
    { id: 'q_3', answer: '7' },
    { id: 'q_1', correctIndex: 1 },
    { id: 'q_2', statements: ['Đúng'] },
  ] }, questions);
  assert.deepEqual(result.map((answer) => answer.id), ['q_3', 'q_1', 'q_2']);
  assert.equal(result[1].correctIndex, 1);
  assert.deepEqual(result[2].statements, [true]);
});

test('batch validator rejects missing, duplicate, unknown, and invalid answers', () => {
  assert.throws(() => validateBatchAnswers({ answers: [{ id: 'q_1', correctIndex: 1 }] }, questions), /missing/);
  assert.throws(() => validateBatchAnswers({ answers: [
    { id: 'q_1', correctIndex: 0 }, { id: 'q_1', correctIndex: 1 },
    { id: 'q_2', statements: [true] }, { id: 'q_3', answer: '7' },
  ] }, questions), /duplicate/);
  assert.throws(() => validateBatchAnswers({ answers: [
    { id: 'q_1', correctIndex: 0 }, { id: 'q_2', statements: [true] },
    { id: 'q_3', answer: '7' }, { id: 'q_4', answer: 'x' },
  ] }, questions), /unknown/);
  assert.throws(() => validateBatchAnswers({ answers: [
    { id: 'q_1', correctIndex: 9 }, { id: 'q_2', statements: [true] }, { id: 'q_3', answer: '7' },
  ] }, questions), /Invalid answer index/);
  assert.throws(() => validateBatchAnswers({ answers: [
    { id: 'q_1', correctIndex: 1 }, { id: 'q_2', statements: [] }, { id: 'q_3', answer: '7' },
  ] }, questions), /Missing true\/false/);
});
