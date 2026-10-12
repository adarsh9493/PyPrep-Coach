/**
 * PyPrep Coach - backend server
 * ---------------------------------------------------------------------------
 * A small Express server that:
 *   1. Serves the static frontend from /public
 *   2. Generates Python interview questions with a free LLM  (POST /api/question)
 *   3. Validates your answer with a free LLM                  (POST /api/validate)
 *   4. Persists your progress to a local progress.json
 *
 * The LLM API key is read here on the server and is NEVER sent to the browser.
 * It talks to any OpenAI-compatible provider (Google Gemini, Groq, OpenRouter,
 * or a local Ollama). If no provider is configured, the app still works using
 * the bundled seed questions and a rule-based fallback tutor.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
require('dotenv').config({ quiet: true }); // loads variables from .env into process.env

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;

/**
 * Free, OpenAI-compatible providers. Every one of these exposes the same
 * "/chat/completions" API, so a single client can talk to all of them.
 * Pick one with LLM_PROVIDER in .env (defaults to Gemini's generous free tier).
 */
const PROVIDERS = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.0-flash',
    requiresKey: true,
    label: 'Google Gemini (free tier)'
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    requiresKey: true,
    label: 'Groq (free tier)'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    requiresKey: true,
    label: 'OpenRouter (free models)'
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    requiresKey: false, // Ollama runs locally and needs no key
    label: 'Ollama (local, no key)'
  }
};

/** Resolve the active provider config from environment variables. */
function llmConfig() {
  const name = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();
  const preset = PROVIDERS[name] || PROVIDERS.gemini;
  const apiKey = process.env.LLM_API_KEY || '';
  return {
    name,
    baseUrl: (process.env.LLM_BASE_URL || preset.baseUrl).replace(/\/$/, ''),
    model: process.env.LLM_MODEL || preset.model,
    apiKey,
    label: preset.label,
    enabled: preset.requiresKey ? Boolean(apiKey) : true
  };
}

const ROOT = __dirname;
const PROGRESS_FILE = path.join(ROOT, 'progress.json');
const SEED_FILE = path.join(ROOT, 'data', 'seed-questions.json');

// The full set of topics the trainer can serve.
const TOPICS = [
  'basics',
  'strings',
  'lists_dicts_sets',
  'comprehensions',
  'functions_closures',
  'oop',
  'decorators',
  'generators',
  'exceptions',
  'file_io',
  'recursion',
  'sorting_searching',
  'interview_patterns',
  'python_gotchas'
];

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Local date string like 2026-10-12 (used for streak tracking). */
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Yesterday's local date string. */
function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Safely extract a JSON object from a model response that may contain
 * markdown code fences or extra prose. Returns null if nothing parses.
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim();
  // Strip ```json ... ``` fences
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const candidate = t.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    // Second attempt: remove trailing commas which models sometimes emit.
    try {
      return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch (_2) {
      return null;
    }
  }
}

/** Random id for generated questions. */
function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Progress storage (progress.json)
// ---------------------------------------------------------------------------

/** The default shape of a fresh progress file. */
function defaultProgress() {
  return {
    xp: 0,
    streak: { count: 0, best: 0, lastDate: null },
    seenQuestionIds: [],
    attempts: [], // { questionId, topic, difficulty, verdict, timestamp }
    topicStats: {}, // topic -> { attempts, correct, partial, incorrect }
    topicsToBrushUp: [], // accumulating list of { topic, keyword }
    settings: { theme: 'dark', confetti: true },
    mockHistory: [] // { date, score, total, difficulty }
  };
}

/** Read progress.json (creating it with defaults if missing/corrupt). */
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const raw = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge onto defaults so older files gain any new fields.
      return Object.assign(defaultProgress(), parsed, {
        streak: Object.assign(defaultProgress().streak, parsed.streak),
        settings: Object.assign(defaultProgress().settings, parsed.settings)
      });
    }
  } catch (err) {
    console.warn('[progress] could not read progress.json, starting fresh:', err.message);
  }
  return defaultProgress();
}

/** Persist progress.json atomically-ish (write then rename not needed locally). */
function saveProgress(progress) {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
  } catch (err) {
    console.error('[progress] failed to write progress.json:', err.message);
  }
}

/** Level curve: every 100 XP is a level, starting at level 1. */
function computeLevel(xp) {
  const level = Math.floor(xp / 100) + 1;
  const xpIntoLevel = xp % 100;
  return { level, xpIntoLevel, xpForNext: 100, progressPct: xpIntoLevel };
}

/** XP awarded per verdict. */
const XP_FOR_VERDICT = { correct: 100, partially_correct: 40, incorrect: 10 };

/**
 * Update streak + stats + xp from a single attempt.
 * Returns the mutated progress object.
 */
function applyAttempt(progress, { question, verdict, isMock }) {
  const topic = question.topic || 'unknown';
  const difficulty = question.difficulty || 'Easy';
  const today = todayStr();

  // --- XP ---
  progress.xp += XP_FOR_VERDICT[verdict] || 0;

  // --- Streak ---
  const s = progress.streak;
  if (s.lastDate !== today) {
    if (s.lastDate === yesterdayStr()) {
      s.count += 1; // consecutive day
    } else {
      s.count = 1; // streak (re)starts today
    }
    s.lastDate = today;
    if (s.count > s.best) s.best = s.count;
  }

  // --- Topic stats ---
  if (!progress.topicStats[topic]) {
    progress.topicStats[topic] = { attempts: 0, correct: 0, partial: 0, incorrect: 0 };
  }
  const ts = progress.topicStats[topic];
  ts.attempts += 1;
  if (verdict === 'correct') ts.correct += 1;
  else if (verdict === 'partially_correct') ts.partial += 1;
  else ts.incorrect += 1;

  // --- Record the attempt ---
  progress.attempts.push({
    questionId: question.id,
    topic,
    difficulty,
    verdict,
    isMock: !!isMock,
    timestamp: new Date().toISOString()
  });
  // Keep the log from growing without bound.
  if (progress.attempts.length > 500) progress.attempts = progress.attempts.slice(-500);

  // --- Track this question as "seen" so it is not repeated ---
  if (question.id && !progress.seenQuestionIds.includes(question.id)) {
    progress.seenQuestionIds.push(question.id);
    if (progress.seenQuestionIds.length > 1000) {
      progress.seenQuestionIds = progress.seenQuestionIds.slice(-1000);
    }
  }

  return progress;
}

// ---------------------------------------------------------------------------
// Adaptivity helpers
// ---------------------------------------------------------------------------

/** Accuracy (0..1) for a topic, or null if never attempted. */
function topicAccuracy(stat) {
  if (!stat || stat.attempts === 0) return null;
  // A correct counts fully, a partial counts half.
  return (stat.correct + stat.partial * 0.5) / stat.attempts;
}

/** Topics the learner is weakest at, weakest first. */
function weakTopics(progress) {
  return Object.entries(progress.topicStats)
    .map(([topic, stat]) => ({ topic, accuracy: topicAccuracy(stat), attempts: stat.attempts }))
    .filter((x) => x.accuracy !== null)
    .sort((a, b) => a.accuracy - b.accuracy)
    .filter((x) => x.accuracy < 0.75)
    .map((x) => x.topic);
}

/**
 * Suggest a difficulty based on the last few attempts.
 * Acelera when doing well, eases off when struggling.
 */
function suggestDifficulty(progress) {
  const recent = progress.attempts.slice(-5);
  if (recent.length < 3) return 'Easy';
  const score = recent.reduce((acc, a) => {
    if (a.verdict === 'correct') return acc + 1;
    if (a.verdict === 'partially_correct') return acc + 0.5;
    return acc;
  }, 0) / recent.length;
  if (score >= 0.8) return 'Hard';
  if (score >= 0.5) return 'Medium';
  return 'Easy';
}

/** Pick a topic - leaning toward the learner's weak spots. */
function pickAdaptiveTopic(progress) {
  const weak = weakTopics(progress);
  if (weak.length > 0 && Math.random() < 0.65) {
    // Prefer a weak topic, weighted toward the weakest.
    return weak[Math.floor(Math.random() * Math.min(3, weak.length))];
  }
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

// ---------------------------------------------------------------------------
// Seed questions
// ---------------------------------------------------------------------------
let SEED_QUESTIONS = [];
try {
  SEED_QUESTIONS = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
} catch (err) {
  console.error('[seed] could not load data/seed-questions.json:', err.message);
}

// ---------------------------------------------------------------------------
// LLM API wrapper (OpenAI-compatible: Gemini / Groq / OpenRouter / Ollama)
// ---------------------------------------------------------------------------

/**
 * Call the configured OpenAI-compatible chat completions endpoint.
 * @returns {Promise<string>} the assistant's text response
 * @throws if the provider is not configured or the request fails
 */
async function callLLM({ system, messages, maxTokens = 1500 }) {
  const cfg = llmConfig();
  if (!cfg.enabled) throw new Error('NO_API_KEY');

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Ollama needs no key; the others use a bearer token.
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.7,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${cfg.label} ${res.status}: ${detail.slice(0, 400)}`);
  }

  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  if (!text) throw new Error(`${cfg.label} returned an empty response`);
  return text;
}

// ---------------------------------------------------------------------------
// Question generation
// ---------------------------------------------------------------------------

const QUESTION_SCHEMA_HINT = `Return ONLY a JSON object (no markdown, no commentary) with exactly these fields:
{
  "id": "a short unique slug",
  "title": "short title",
  "topic": "one of the allowed topics",
  "difficulty": "Easy" | "Medium" | "Hard",
  "statement": "the full problem statement",
  "examples": [ { "input": "example input", "output": "example output" } ],
  "functionName": "the python function name the learner must implement",
  "starterCode": "def function_name(...):\\n    # TODO\\n    pass\\n",
  "hint": "one guiding hint that does NOT give away the full solution",
  "solution": "a complete, correct, Pythonic reference solution",
  "testCases": [ { "args": [ ... ], "expected": ... , "unordered": false } ]
}`;

/**
 * Ask the LLM for a new question, avoiding ones already seen.
 * Falls back to a seed question if the AI call fails.
 */
async function generateQuestion({ topic, difficulty, progress }) {
  const seen = progress.seenQuestionIds || [];
  const weak = weakTopics(progress);
  const system =
    'You are a Python interview question author. You write crisp, ' +
    'interview-realistic problems with unambiguous test cases. You always ' +
    'respond with valid JSON and nothing else.';

  const user =
    `Write ONE Python interview question.\n` +
    `Topic: ${topic}\n` +
    `Difficulty: ${difficulty}\n` +
    `Allowed topics: ${TOPICS.join(', ')}\n` +
    `The learner is weakest at: ${weak.length ? weak.join(', ') : 'unknown (new learner)'}.\n` +
    `Do not reuse these already-seen ids: ${seen.slice(-25).join(', ') || 'none'}.\n` +
    `The function must be pure, take plain JSON-serializable arguments, and ` +
    `return JSON-serializable values. Provide 3-5 test cases covering normal ` +
    `and edge inputs. Set "unordered": true only when list output order does ` +
    `not matter.\n\n` +
    QUESTION_SCHEMA_HINT;

  const text = await callLLM({
    system,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1800
  });

  const parsed = extractJson(text);
  if (!parsed || !parsed.starterCode || !parsed.statement) {
    throw new Error('Could not parse a question from the model response');
  }
  return normalizeQuestion(parsed, { topic, difficulty });
}

/** Ensure a question object has every field the frontend expects. */
function normalizeQuestion(q, fallback) {
  fallback = fallback || {};
  return {
    id: q.id || newId('gen'),
    title: q.title || 'Untitled question',
    topic: TOPICS.includes(q.topic) ? q.topic : fallback.topic || 'basics',
    difficulty: DIFFICULTIES.includes(q.difficulty) ? q.difficulty : fallback.difficulty || 'Easy',
    statement: q.statement || '',
    examples: Array.isArray(q.examples) ? q.examples : [],
    functionName: q.functionName || 'solution',
    starterCode: q.starterCode || 'def solution():\n    # TODO\n    pass\n',
    hint: q.hint || 'Break the problem into smaller steps and think about the right data structure.',
    solution: q.solution || '',
    testCases: Array.isArray(q.testCases) ? q.testCases : []
  };
}

/** Pick a seed question matching the request, avoiding seen ones. */
function pickSeedQuestion({ topic, difficulty, progress }) {
  const seen = new Set(progress.seenQuestionIds || []);
  const matches = (q, strict) => {
    if (strict) return q.topic === topic && q.difficulty === difficulty;
    return q.topic === topic || q.difficulty === difficulty;
  };
  // Prefer exact topic+difficulty, then topic, then difficulty, then anything unseen.
  const tiers = [
    SEED_QUESTIONS.filter((q) => matches(q, true) && !seen.has(q.id)),
    SEED_QUESTIONS.filter((q) => matches(q, false) && !seen.has(q.id)),
    SEED_QUESTIONS.filter((q) => !seen.has(q.id)),
    SEED_QUESTIONS
  ];
  for (const tier of tiers) {
    if (tier.length) return tier[Math.floor(Math.random() * tier.length)];
  }
  return SEED_QUESTIONS[0];
}

// ---------------------------------------------------------------------------
// Answer validation
// ---------------------------------------------------------------------------

const VALIDATOR_SYSTEM =
  'You are a warm, encouraging senior Python engineer coaching a friend for ' +
  'interviews. You are concise and specific. You GUIDE before you give ' +
  'answers: when a learner is stuck, nudge them toward the idea rather than ' +
  'dumping the full solution. You always reply with valid JSON and nothing else.';

const FEEDBACK_SCHEMA_HINT = `Return ONLY a JSON object (no markdown, no commentary) with these fields:
{
  "verdict": "correct" | "partially_correct" | "incorrect",
  "summary": "1-2 sentence plain-English verdict",
  "improvements": ["only when verdict is correct: more Pythonic code, better complexity, edge cases, what an interviewer wants to hear"],
  "what_went_wrong": "only when not fully correct: brief and specific",
  "how_to_fix": ["only when not fully correct: concrete steps, NOT the full solution"],
  "corrected_approach": "only when not fully correct: a short summary of the right approach",
  "concepts_to_review": [ { "concept": "name", "keyword": "a search keyword or resource type" } ],
  "complexity": { "time": "e.g. O(n)", "space": "e.g. O(1)" },
  "encouragement": "one short, genuine motivating line"
}`;

/** Build a compact textual description of a question for the validator. */
function describeQuestion(q) {
  const examples = (q.examples || [])
    .map((ex, i) => `  Example ${i + 1}: input ${ex.input} -> output ${ex.output}`)
    .join('\n');
  const tests = (q.testCases || [])
    .map((tc, i) => `  Test ${i + 1}: args=${JSON.stringify(tc.args)} expected=${JSON.stringify(tc.expected)}`)
    .join('\n');
  return (
    `Title: ${q.title}\n` +
    `Topic: ${q.topic}\n` +
    `Difficulty: ${q.difficulty}\n` +
    `Statement: ${q.statement}\n` +
    (examples ? `Examples:\n${examples}\n` : '') +
    (tests ? `Hidden test cases:\n${tests}\n` : '') +
    `Expected function name: ${q.functionName}`
  );
}

/** Describe the browser execution results (Pyodide) for the validator. */
function describeExecution(execution) {
  if (!execution || !execution.ran) {
    return 'Execution: the code was NOT executed against test cases in the browser.';
  }
  const lines = (execution.details || []).map((d, i) => {
    const status = d.passed ? 'PASS' : 'FAIL';
    return `  Test ${i + 1}: ${status} | args=${JSON.stringify(d.args)} | expected=${JSON.stringify(d.expected)} | got=${JSON.stringify(d.got)}${d.error ? ' | error=' + d.error : ''}`;
  });
  return (
    `Execution: ran against ${execution.total} test cases, ` +
    `${execution.passed} passed, ${execution.total - execution.passed} failed.` +
    (execution.error ? `\nRuntime error: ${execution.error}` : '') +
    (lines.length ? `\n${lines.join('\n')}` : '')
  );
}

/** Ask the LLM to evaluate the learner's code. */
async function validateWithLLM({ question, code, execution }) {
  const executionIsTrustworthy = execution && execution.ran;
  const user =
    `Here is a Python interview question:\n\n${describeQuestion(question)}\n\n` +
    `The learner submitted this code:\n\`\`\`python\n${code}\n\`\`\`\n\n` +
    `${describeExecution(execution)}\n\n` +
    (executionIsTrustworthy
      ? 'Trust the test execution results over your own reading when they conflict, ' +
        'and explain any mismatch briefly.\n\n'
      : '') +
    'Evaluate the code against the question. Be specific and kind.\n\n' +
    FEEDBACK_SCHEMA_HINT;

  const text = await callLLM({
    system: VALIDATOR_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1500
  });

  const parsed = extractJson(text);
  if (!parsed || !parsed.verdict) {
    throw new Error('Could not parse feedback JSON from the model response');
  }
  return normalizeFeedback(parsed, { question, code, execution });
}

/** Ensure a feedback object has every field the frontend expects. */
function normalizeFeedback(f, ctx) {
  const valid = ['correct', 'partially_correct', 'incorrect'];
  let verdict = valid.includes(f.verdict) ? f.verdict : 'incorrect';

  // If we have trustworthy execution results and the model said "correct"
  // but tests actually failed, downgrade to keep the verdict honest.
  if (ctx && ctx.execution && ctx.execution.ran) {
    const allPassed = ctx.execution.passed === ctx.execution.total;
    if (!allPassed && verdict === 'correct') verdict = 'partially_correct';
  }

  const concepts = Array.isArray(f.concepts_to_review)
    ? f.concepts_to_review.map((c) =>
        typeof c === 'string' ? { concept: c, keyword: c } : { concept: c.concept || '', keyword: c.keyword || '' }
      )
    : [];

  return {
    verdict,
    summary: f.summary || 'Here is some feedback on your solution.',
    improvements: Array.isArray(f.improvements) ? f.improvements : [],
    what_went_wrong: f.what_went_wrong || '',
    how_to_fix: Array.isArray(f.how_to_fix) ? f.how_to_fix : [],
    corrected_approach: f.corrected_approach || '',
    concepts_to_review: concepts,
    complexity: {
      time: (f.complexity && f.complexity.time) || 'unknown',
      space: (f.complexity && f.complexity.space) || 'unknown'
    },
    encouragement: f.encouragement || 'Keep going - every attempt makes you sharper.'
  };
}

/**
 * Rule-based tutor used when there is no API key (or the AI call fails).
 * Keeps the app fully usable offline, driven by real test execution.
 */
function fallbackFeedback({ question, code, execution, reason }) {
  const ran = execution && execution.ran;
  const total = ran ? execution.total : 0;
  const passed = ran ? execution.passed : 0;
  const allPassed = ran && total > 0 && passed === total;

  let verdict = 'incorrect';
  if (allPassed) verdict = 'correct';
  else if (ran && passed > 0) verdict = 'partially_correct';

  const failed = ran ? (execution.details || []).filter((d) => !d.passed) : [];
  const note = reason === 'NO_API_KEY'
    ? 'The AI tutor is offline (no LLM API key configured), so this verdict comes from running your code against the test cases.'
    : `The AI tutor could not be reached (${reason}). This verdict comes from running your code against the test cases.`;

  return {
    verdict,
    summary: allPassed
      ? `Nice - all ${total} test cases passed! ${note}`
      : ran
        ? `${passed}/${total} test cases passed. ${note}`
        : note,
    improvements: allPassed
      ? [
          'Re-read your solution and rename variables for clarity.',
          'Consider whether an edge case (empty input, duplicates, large n) still works.',
          'Think about time/space complexity and say it out loud - interviewers love that.'
        ]
      : [],
    what_went_wrong: allPassed
      ? ''
      : failed.length
        ? `Failing case: called with ${JSON.stringify(failed[0].args)} expected ${JSON.stringify(failed[0].expected)} but got ${JSON.stringify(failed[0].got)}${failed[0].error ? ' (' + failed[0].error + ')' : ''}.`
        : 'We could not run your code against the test cases.',
    how_to_fix: allPassed
      ? []
      : [
          'Trace the failing case by hand and print intermediate values.',
          'Check your function takes the exact arguments shown in the test case.',
          'Make sure you return a value (a stray `pass` or missing `return` is a common culprit).'
        ],
    corrected_approach: allPassed
      ? ''
      : 'Compare your output to the expected value on the first failing case, then adjust one small step at a time.',
    concepts_to_review: [{ concept: question.topic, keyword: `${question.topic} python practice` }],
    complexity: { time: 'unknown', space: 'unknown' },
    encouragement: allPassed ? 'That is interview-ready - keep the streak alive!' : 'Every failing test is a hint from the future you. Keep going!'
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(ROOT, 'public')));

/** Health check - handy for verifying the server is up. */
app.get('/api/health', (_req, res) => {
  const cfg = llmConfig();
  res.json({
    ok: true,
    aiEnabled: cfg.enabled,
    provider: cfg.name,
    model: cfg.model,
    seedQuestions: SEED_QUESTIONS.length
  });
});

/** The list of topics + difficulties, for populating the UI. */
app.get('/api/topics', (_req, res) => {
  res.json({ topics: TOPICS, difficulties: DIFFICULTIES });
});

/** Current saved progress + derived level info. */
app.get('/api/progress', (_req, res) => {
  const progress = loadProgress();
  res.json({ progress, level: computeLevel(progress.xp) });
});

/** Update settings (theme, confetti) and return the new progress. */
app.post('/api/progress/settings', (req, res) => {
  const progress = loadProgress();
  if (req.body && typeof req.body === 'object') {
    progress.settings = Object.assign(progress.settings, req.body);
  }
  saveProgress(progress);
  res.json({ progress, level: computeLevel(progress.xp) });
});

/** Wipe progress (with a guard so it can't happen by accident). */
app.post('/api/progress/reset', (req, res) => {
  if (!req.body || req.body.confirm !== true) {
    return res.status(400).json({ error: 'Send { "confirm": true } to reset progress.' });
  }
  const progress = defaultProgress();
  saveProgress(progress);
  res.json({ progress, level: computeLevel(progress.xp) });
});

/**
 * POST /api/question
 * body: { topic, difficulty, mock }
 *   topic/difficulty may be "adaptive" to let the trainer choose.
 * Returns: { question, source, reason }
 */
app.post('/api/question', async (req, res) => {
  const progress = loadProgress();
  const body = req.body || {};

  // Resolve "adaptive"/"surprise" selections.
  let topic = body.topic && body.topic !== 'adaptive' && body.topic !== 'surprise'
    ? body.topic
    : pickAdaptiveTopic(progress);
  let difficulty = body.difficulty && body.difficulty !== 'adaptive'
    ? body.difficulty
    : suggestDifficulty(progress);
  if (!TOPICS.includes(topic)) topic = 'basics';
  if (!DIFFICULTIES.includes(difficulty)) difficulty = 'Easy';

  // In mock mode the client passes an explicit difficulty to keep the set consistent.
  if (body.mock && body.difficulty && DIFFICULTIES.includes(body.difficulty)) {
    difficulty = body.difficulty;
  }

  // Try the AI first, fall back to seeds.
  if (llmConfig().enabled) {
    try {
      const question = await generateQuestion({ topic, difficulty, progress });
      return res.json({ question, source: 'ai' });
    } catch (err) {
      console.warn('[question] AI generation failed, using a seed question:', err.message);
      const question = pickSeedQuestion({ topic, difficulty, progress });
      return res.json({ question, source: 'seed', reason: err.message });
    }
  }

  const question = pickSeedQuestion({ topic, difficulty, progress });
  res.json({ question, source: 'seed', reason: 'NO_API_KEY' });
});

/**
 * POST /api/validate
 * body: { question, code, execution, mock }
 * Returns: { feedback, xpAwarded, progress, level }
 */
app.post('/api/validate', async (req, res) => {
  const { question, code, execution, mock } = req.body || {};
  if (!question || typeof code !== 'string') {
    return res.status(400).json({ error: 'A question and code are required.' });
  }

  let feedback;
  let source = 'ai';
  if (llmConfig().enabled) {
    try {
      feedback = await validateWithLLM({ question, code, execution });
    } catch (err) {
      console.warn('[validate] AI validation failed, using fallback tutor:', err.message);
      feedback = fallbackFeedback({ question, code, execution, reason: err.message });
      source = 'fallback';
    }
  } else {
    feedback = fallbackFeedback({ question, code, execution, reason: 'NO_API_KEY' });
    source = 'fallback';
  }

  // Record the attempt and update XP / streak / stats.
  const progress = loadProgress();
  const before = progress.xp;
  applyAttempt(progress, { question, verdict: feedback.verdict, isMock: !!mock });

  // Accumulate a "topics to brush up" list from concepts the tutor flagged.
  for (const c of feedback.concepts_to_review || []) {
    if (!c.concept) continue;
    const exists = progress.topicsToBrushUp.some((t) => t.concept === c.concept);
    if (!exists) progress.topicsToBrushUp.push({ concept: c.concept, keyword: c.keyword });
  }

  saveProgress(progress);

  res.json({
    feedback,
    source,
    xpAwarded: progress.xp - before,
    progress,
    level: computeLevel(progress.xp)
  });
});

/**
 * POST /api/mock/report
 * body: { results: [{topic, difficulty, verdict}], difficulty }
 * Saves a mock-interview summary and returns a report card.
 */
app.post('/api/mock/report', (req, res) => {
  const { results = [], difficulty = 'Mixed' } = req.body || {};
  const total = results.length;
  const score = results.reduce((acc, r) => {
    if (r.verdict === 'correct') return acc + 1;
    if (r.verdict === 'partially_correct') return acc + 0.5;
    return acc;
  }, 0);
  const pct = total ? Math.round((score / total) * 100) : 0;
  const byTopic = {};
  for (const r of results) {
    if (!byTopic[r.topic]) byTopic[r.topic] = { attempts: 0, correct: 0 };
    byTopic[r.topic].attempts += 1;
    if (r.verdict === 'correct') byTopic[r.topic].correct += 1;
  }
  const weakest = Object.entries(byTopic)
    .sort((a, b) => a[1].correct / a[1].attempts - b[1].correct / b[1].attempts)
    .map(([t]) => t);

  const grade = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 55 ? 'D' : 'F';
  const report = {
    date: new Date().toISOString(),
    difficulty,
    total,
    score,
    pct,
    grade,
    weakest,
    headline:
      pct >= 80 ? 'Strong showing - you interview well under time pressure.'
      : pct >= 55 ? 'Solid foundation. Tighten up your weak topics and you are there.'
      : 'Good effort. Let us drill the weak areas together.'
  };

  const progress = loadProgress();
  progress.mockHistory.push(report);
  if (progress.mockHistory.length > 50) progress.mockHistory = progress.mockHistory.slice(-50);
  saveProgress(progress);

  res.json({ report, progress });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  const cfg = llmConfig();
  console.log('');
  console.log('  PyPrep Coach is running');
  console.log(`  ->  http://localhost:${PORT}`);
  console.log(
    `  AI tutor: ${cfg.enabled ? `enabled - ${cfg.label} (${cfg.model})` : 'OFFLINE - using seed questions + rule-based tutor'}`
  );
  console.log('  (Set LLM_PROVIDER and LLM_API_KEY in .env to enable the AI tutor.)');
  console.log('');
});

// Export for potential testing; harmless when run directly.
module.exports = { app, server };
