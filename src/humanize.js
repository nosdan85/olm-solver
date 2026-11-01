'use strict';

// Human-like pacing. Every wait is randomised inside a band so the request
// pattern never has the flat, metronomic rhythm of a script.

const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Overall speed multiplier set by the user in the PWA.
const SPEEDS = {
  slow: { scale: 2.0, label: 'Chậm' },
  normal: { scale: 1.0, label: 'Vừa' },
  fast: { scale: 0.55, label: 'Nhanh' },
};

function setSpeed(scale) {
  currentScale = scale;
}
let currentScale = 1.0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scaledSleep(ms) {
  await sleep(Math.round(ms * currentScale));
}

// Delay between individual actions: choosing an option, moving to next question.
async function actionDelay() {
  await scaledSleep(rand(2000, 8000));
}

// Longer pause between questions so the session does not look like a tight loop.
async function questionDelay() {
  await scaledSleep(rand(5000, 15000));
}

// Pause before submitting a whole homework.
async function submitDelay() {
  await scaledSleep(rand(8000, 20000));
}

// Long rest between two separate homeworks.
async function homeworkRest() {
  await scaledSleep(rand(5 * 60 * 1000, 20 * 60 * 1000));
}

// Typing a string one character at a time, with the occasional typo that
// gets corrected. Matches a real person's cadence more closely than
// pasting the whole value.
async function typeText(sendChar, text, { minDelay = 80, maxDelay = 250, typoRate = 0.05 } = {}) {
  const keys = 'qwertyuiopasdfghjklzxcvbnm';
  for (const ch of String(text)) {
    if (Math.random() < typoRate) {
      const wrong = pick(keys.split(''));
      await sendChar(wrong);
      await sleep(randInt(120, 320));
      // Backspace to remove the wrong character.
      await sendChar('\b');
      await sleep(randInt(60, 180));
    }
    await sendChar(ch);
    await sleep(randInt(minDelay, maxDelay));
  }
}

// Random scroll up and down before committing, the way a person re-reads
// the page before pressing the button.
async function scrollPattern(scrollTo, { rounds = 3 } = {}) {
  for (let i = 0; i < rounds; i++) {
    await scrollTo(randInt(120, 500));
    await sleep(randInt(400, 1200));
    await scrollTo(-randInt(100, 400));
    await sleep(randInt(300, 900));
  }
  await scrollTo(0);
  await sleep(randInt(200, 600));
}

// Quadratic Bezier point, used to move the mouse along a curve instead of
// teleporting in a straight line.
function bezierPoint(p0, p1, p2, t) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

// Move the pointer from `from` to `to` along an arc in `steps` increments.
async function moveMouseSmooth(page, from, to, steps = 24) {
  const control = {
    x: (from.x + to.x) / 2 + rand(-120, 120),
    y: (from.y + to.y) / 2 + rand(-120, 120),
  };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const point = bezierPoint(from, control, to, t);
    await page.mouse.move(point.x, point.y);
    await sleep(randInt(6, 24));
  }
}

// Read a "Nộp bài trong 19:00 - 21:00" style window into an absolute submit
// moment. Returns { start, end, submitAt } with submitAt picked uniformly
// inside the window.
function resolveSubmitWindow(windowSpec, now = new Date()) {
  const today = new Date(now);
  const parse = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    const d = new Date(today);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  };

  if (windowSpec && windowSpec.start && windowSpec.end) {
    const start = parse(windowSpec.start);
    const end = parse(windowSpec.end);
    if (start && end && end > start) {
      const span = end.getTime() - start.getTime();
      return { start, end, submitAt: new Date(start.getTime() + rand(0, span)) };
    }
  }

  // No window given: submit naturally and promptly (1-3 seconds).
  const start = new Date(now.getTime() + 1000);
  const end = new Date(now.getTime() + 3000);
  return { start, end, submitAt: new Date(now.getTime() + rand(1200, 2500)) };
}

// Decide how many questions to answer wrong for the target score band.
// max  -> 0 wrong
// high -> ~20% wrong
// mid  -> ~35% wrong
// low  -> ~55% wrong
// random -> anywhere in 0..60%
function wrongRatioForScore(scoreTarget) {
  const targetStr = String(scoreTarget || '10').trim().toLowerCase();
  switch (targetStr) {
    case '10':
    case 'max':
      return 0; // 10 điểm = giải đúng tuyệt đối 100%
    case '9':
    case 'high':
      return 0.10;
    case '8':
    case 'mid':
      return 0.20;
    case '7':
      return 0.30;
    case 'low':
      return 0.50;
    case 'random':
      return Math.random() * 0.4;
    default:
      if (/^\d+(\.\d+)?$/.test(targetStr)) {
        const num = Number(targetStr);
        if (num >= 10) return 0;
        return Math.max(0, (10 - num) / 10);
      }
      return 0;
  }
}

// Pick which questions to answer incorrectly and how.
function planWrongAnswers(questions, scoreTarget) {
  const ratio = wrongRatioForScore(scoreTarget);
  const total = questions.length;
  let wrongCount = Math.round(total * ratio);
  if (wrongCount <= 0) return { wrongIndices: new Set(), ratio };

  // Do not fail the whole homework — cap at 60% of the questions.
  wrongCount = Math.min(wrongCount, Math.max(0, Math.floor(total * 0.6)));
  if (wrongCount === 0) return { wrongIndices: new Set(), ratio };

  const indices = questions.map((_, i) => i);
  // Fisher-Yates so the wrong questions are scattered, not a block.
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const wrongIndices = new Set();
  for (let i = 0; i < wrongCount; i++) {
    const idx = indices[i];
    const q = questions[idx];
    const options = q.options || [];
    const correctIdx = typeof q.correctIndex === 'number' ? q.correctIndex : -1;
    // For multiple choice we must deviate from the known-correct option.
    // For open questions we just write a weaker answer.
    let chosen = correctIdx;
    if (options.length > 1 && correctIdx >= 0) {
      const others = options.map((_, i) => i).filter((i) => i !== correctIdx);
      chosen = pick(others);
    }
    wrongIndices.add(idx);
    questions[idx].plannedWrong = chosen;
  }

  return { wrongIndices, ratio };
}

// Rate guard: at most one homework submission every 10 minutes.
class RateGuard {
  constructor({ minGapMs = 3000 } = {}) {
    this.minGapMs = minGapMs;
    this.lastSubmission = 0;
  }

  async waitForSlot(now = Date.now()) {
    const elapsed = now - this.lastSubmission;
    if (elapsed < this.minGapMs) {
      const wait = this.minGapMs - elapsed;
      await sleep(wait);
    }
    this.lastSubmission = Date.now();
  }
}

module.exports = {
  rand,
  randInt,
  pick,
  sleep,
  scaledSleep,
  actionDelay,
  questionDelay,
  submitDelay,
  homeworkRest,
  typeText,
  scrollPattern,
  bezierPoint,
  moveMouseSmooth,
  resolveSubmitWindow,
  wrongRatioForScore,
  planWrongAnswers,
  RateGuard,
  SPEEDS,
  setSpeed,
  getSpeed: () => currentScale,
};