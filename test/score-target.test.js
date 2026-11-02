'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/humanize');

test('planWrongAnswers generates exact wrong count for target score 10', () => {
  const q60 = Array.from({ length: 60 }, (_, i) => ({
    index: i,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 1,
  }));
  const plan10 = H.planWrongAnswers(q60, '10');
  assert.equal(plan10.wrongIndices.size, 0);
  assert.equal(plan10.plannedWrongs.size, 0);
  const correct = 60 - plan10.wrongIndices.size;
  const score = (correct / 60) * 10;
  assert.equal(score, 10);
});

test('planWrongAnswers generates exact wrong count for target score 8', () => {
  const q60 = Array.from({ length: 60 }, (_, i) => ({
    index: i,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
  }));
  const plan8 = H.planWrongAnswers(q60, '8');
  assert.equal(plan8.wrongIndices.size, 12);
  assert.equal(plan8.plannedWrongs.size, 12);
  const correct = 60 - plan8.wrongIndices.size;
  const score = (correct / 60) * 10;
  assert.equal(score, 8.0);

  // Verify that all planned wrong answers choose an index != correctIndex
  for (const [idx, wrong] of plan8.plannedWrongs) {
    assert.notEqual(wrong.correctIndex, q60[idx].correctIndex);
  }
});

test('planWrongAnswers generates exact wrong count for target score 9', () => {
  const q60 = Array.from({ length: 60 }, (_, i) => ({
    index: i,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 2,
  }));
  const plan9 = H.planWrongAnswers(q60, '9');
  assert.equal(plan9.wrongIndices.size, 6);
  const correct = 60 - plan9.wrongIndices.size;
  const score = (correct / 60) * 10;
  assert.equal(score, 9.0);
});

test('planWrongAnswers works with mixed question types (choices + essay)', () => {
  const qMixed = Array.from({ length: 60 }, (_, i) => {
    if (i >= 58) {
      return { index: i, type: 'short_answer', options: [] };
    }
    return { index: i, type: 'choice', options: ['A', 'B', 'C', 'D'], correctIndex: 1 };
  });

  const plan8 = H.planWrongAnswers(qMixed, '8');
  assert.equal(plan8.wrongIndices.size, 12);
  const correct = 60 - plan8.wrongIndices.size;
  const score = (correct / 60) * 10;
  assert.equal(score, 8.0);
});
