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
    // A rolling "latest" alias so the default never points at a retired model.
    model: 'gemini-flash-latest',
    // If a model is overloaded (503) or retired/blocked (404), try these next.
    fallbackModels: ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
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
    fallbackModels: preset.fallbackModels || [],
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const models = [cfg.model, ...(cfg.fallbackModels || [])];
  let lastError = null;

  // Try each model in the chain. Transient overloads (429/503) get one brief
  // retry; retired models (404) move straight to the next fallback.
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Ollama needs no key; the others use a bearer token.
            ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {})
          },
          body: JSON.stringify({
            model,
            temperature: 0.7,
            max_tokens: maxTokens,
            messages: [{ role: 'system', content: system }, ...messages]
          })
        });
      } catch (netErr) {
        // Network-level failure (offline, DNS, proxy). Surface it immediately.
        throw netErr;
      }

      if (res.ok) {
        const data = await res.json().catch(() => null);
        const text = data && data.choices && data.choices[0] && data.choices[0].message
          ? data.choices[0].message.content
          : '';
        if (!text) throw new Error(`${cfg.label} returned an empty response`);
        return text;
      }

      const detail = await res.text().catch(() => '');
      lastError = new Error(`${cfg.label} ${res.status}: ${detail.slice(0, 400)}`);

      if (res.status === 429 || res.status === 503) {
        // Temporary overload / rate limit - pause, retry once, else next model.
        await sleep(1200);
        continue;
      }
      if (res.status === 404) {
        // Model unknown or retired - try the next fallback model.
        break;
      }
      // Any other error (400, 401, 403, 500...) is not worth looping over.
      throw lastError;
    }
  }

  throw lastError || new Error(`${cfg.label} request failed after trying all model fallbacks`);
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
// Free-form tutor chat (POST /api/chat)
// ---------------------------------------------------------------------------

const CHAT_SYSTEM =
  'You are a warm, patient senior Python engineer coaching a friend for ' +
  'interviews. Keep answers focused and practical: prefer short paragraphs and ' +
  'tight bullet lists over walls of text, and use fenced code blocks for code. ' +
  'When the learner is stuck on the question they are currently working on, ' +
  'nudge them toward the idea instead of dumping the full answer. Assume no ' +
  'question is too basic and never make them feel silly for asking. Explain concepts ' +
  'step by step in plain English, with small examples if helpful.';

/**
 * A built-in cheat sheet so the chat is still genuinely useful with no API key
 * (which is exactly when "I forgot everything" happens). Keyed by topic.
 */
const OFFLINE_CHAT_NOTES = {
  basics: [
    '**Basics refresher**',
    '- Core types: `int`, `float`, `str`, `bool`, `None`, `list`, `tuple`, `dict`, `set`.',
    '- Falsy values: `0`, `0.0`, `""`, `[]`, `{}`, `set()`, `None`.',
    '- `==` compares values; `is` compares identity (`x is None`).',
    '- Operators: `//` floor divide, `/` true divide, `%` modulo, `**` power.',
    "- F-strings: `f'{name}: {price:.2f}'`.",
    '- Swap without a temp: `a, b = b, a`.'
  ].join('\n'),

  strings: [
    '**Strings refresher**',
    '- Strings are immutable: every change returns a NEW string.',
    '- Slicing: `s[::-1]` reverses; `s[start:stop:step]`.',
    "- Handy: `s.lower()`, `s.strip()`, `s.split(',')`, `','.join(parts)`, `s.replace(a, b)`, `s.startswith(x)`.",
    '- Checks: `s.isdigit()`, `s.isalpha()`.',
    '- Counting with a dict: `counts[c] = counts.get(c, 0) + 1` (or `collections.Counter`).'
  ].join('\n'),

  lists_dicts_sets: [
    '**Lists / dicts / sets refresher**',
    '- `list`: ordered, mutable, duplicates allowed. `append`, `extend`, `insert`, `pop`; `l.sort()` (in place) vs `sorted(l)` (new list).',
    '- `tuple`: ordered and immutable, so it is hashable and usable as a dict key.',
    '- `dict`: key -> value; keys must be hashable. `d.get(k, default)`, `d.items()`, `d.keys()`, `d.values()`.',
    '- `set`: unique items with O(1) membership - great for de-duping and "seen before?" checks.',
    '- Big-O to know: list index `O(1)`, `x in list` `O(n)`, `x in set/dict` `O(1)`, `append` amortized `O(1)`.'
  ].join('\n'),

  comprehensions: [
    '**Comprehensions refresher**',
    '- List: `[x * 2 for x in nums]`',
    '- Filter: `[x for x in nums if x % 2 == 0]`',
    '- Filter + transform: `[x * x for x in nums if x > 0]`',
    '- Dict: `{k: v for k, v in pairs}`; Set: `{x for x in nums}`',
    '- Nested: `[n for row in matrix for n in row]` (outer loop comes first).',
    '- Generator form (lazy, builds nothing): `sum(x * x for x in nums)`. Use it for large data.'
  ].join('\n'),

  functions_closures: [
    '**Functions & closures refresher**',
    '- Default args: `def f(x, y=0)`. Never use a mutable default (see gotchas).',
    '- `*args` = extra positional args, `**kwargs` = extra keyword args.',
    '- A closure is a function that remembers variables from where it was defined.',
    '- Late-binding trap: lambdas created in a loop all capture the LAST value. Fix with `lambda x=x: x`.',
    '- `functools.lru_cache` memoizes a function in one line.'
  ].join('\n'),

  oop: [
    '**OOP refresher**',
    '- `class Dog:` with `def __init__(self, name): self.name = name`.',
    "- `super().__init__(...)` runs the parent's initializer.",
    '- Dunders to know: `__init__`, `__repr__` (debug view), `__eq__`, `__len__`, `__iter__`.',
    '- `@staticmethod` needs no `self`; `@classmethod` receives `cls`.',
    '- Interview favourite: `__repr__` vs `__str__`, and composition over inheritance.'
  ].join('\n'),

  decorators: [
    '**Decorators refresher**',
    '- A decorator is a function that takes a function and returns a (usually wrapped) function.',
    '- Minimal version:',
    '```python',
    'def logged(fn):',
    '    def wrapper(*args, **kwargs):',
    "        print('calling', fn.__name__)",
    '        return fn(*args, **kwargs)',
    '    return wrapper',
    '```',
    '- Always add `@functools.wraps(fn)` so the name and docstring survive.',
    '- Use it as `@logged` right above `def add(...)`.',
    '- Decorators that take arguments need one extra layer of nesting.',
    '- Real uses: timing, caching, logging, auth checks.'
  ].join('\n'),

  generators: [
    '**Generators refresher**',
    '- A function that contains `yield` returns a generator: values are produced one at a time (lazy).',
    '```python',
    'def countdown(n):',
    '    while n > 0:',
    '        yield n',
    '        n -= 1',
    '```',
    '- `next(gen)` pulls the next value; `StopIteration` ends it.',
    '- Memory win: `sum(i * i for i in range(10**7))` never builds a huge list.',
    '- An iterable has `__iter__`; an iterator has `__next__`.',
    '- Use them for streaming, infinite sequences, and large files.'
  ].join('\n'),

  exceptions: [
    '**Exceptions refresher**',
    '- `try: ... except ValueError as e: ... else: ... finally: ...`',
    '- `else` runs only if no exception; `finally` always runs (cleanup).',
    "- Raise with `raise ValueError('bad input')`.",
    '- Catch specific exceptions - a bare `except:` hides real bugs.',
    '- Custom error: `class TooBig(Exception): pass`.',
    '- Prefer EAFP (try it, catch the error) over LBYL (check first).'
  ].join('\n'),

  file_io: [
    '**File I/O refresher**',
    '- Always use `with` so the file closes even on an error:',
    '```python',
    "with open('data.txt', 'r', encoding='utf-8') as f:",
    '    for line in f:',
    '        print(line.rstrip())',
    '```',
    "- Modes: `'r'` read, `'w'` overwrite, `'a'` append, plus `'b'` for binary.",
    '- `f.read()` all, `f.readline()` one line, `f.readlines()` a list of lines.',
    '- `import csv` for CSV and `import json` with `json.load` / `json.dump` for JSON.'
  ].join('\n'),

  recursion: [
    '**Recursion refresher**',
    '- Two parts: a base case that stops, and a smaller recursive call.',
    '```python',
    'def fact(n):',
    '    if n <= 1:',
    '        return 1',
    '    return n * fact(n - 1)',
    '```',
    '- Anything recursive can be a loop; recursion shines on trees, graphs, divide & conquer.',
    '- Watch the depth limit (~1000) - deep recursion raises `RecursionError`.',
    '- Naive Fibonacci is `O(2^n)`; memoize with `functools.lru_cache` or a dict for `O(n)`.'
  ].join('\n'),

  sorting_searching: [
    '**Sorting & searching refresher**',
    '- `sorted(items, key=..., reverse=True)` returns a new list; `items.sort()` sorts in place.',
    "- Multi-key sort: `sorted(people, key=lambda p: (-p['age'], p['name']))`.",
    '- Binary search needs a SORTED list: `bisect.bisect_left` / `bisect_right`.',
    '- Complexity cheat sheet: list index `O(1)`, linear search `O(n)`, sort `O(n log n)`, dict/set lookup `O(1)` average.',
    '- "Can we beat O(n^2)?" usually means sort first or trade memory for time with a dict or set.'
  ].join('\n'),

  interview_patterns: [
    '**Interview patterns refresher**',
    '- Two pointers: sort, then walk `left` and `right` inward (pair sums, palindromes).',
    '- Sliding window: grow `right`, shrink `left` - longest/shortest substring problems.',
    '- Hash map for counting and "seen it before": two-sum, anagrams, duplicates.',
    '- Prefix sums: fast range-sum queries.',
    '- Fast/slow pointers: cycle detection in linked lists.',
    '- Say the brute force first, then name the optimisation and its Big-O out loud.'
  ].join('\n'),

  python_gotchas: [
    '**Python gotchas refresher**',
    '- Mutable default arguments are shared across calls:',
    '```python',
    'def add(item, bucket=[]):  # BUG',
    '    bucket.append(item)',
    '    return bucket',
    '```',
    '- Fix with `bucket=None` and `if bucket is None: bucket = []`.',
    '- `is` vs `==` (identity vs equality).',
    '- Shallow copy: `list(b)` copies the outer list only - use `copy.deepcopy` for nested data.',
    '- Late binding in loops (see closures).',
    '- Float math: `0.1 + 0.2 != 0.3` - use `math.isclose` or `Decimal`.',
    '- Integer division with `/` always returns a float.'
  ].join('\n')
};

/** Phrases that mean "I have forgotten basically everything - help me start". */
const CRASH_COURSE_TRIGGERS = [
  'forgot', 'forget', 'crash course', 'from scratch', 'where do i start',
  'where to start', 'study plan', 'roadmap', 'everything', 'all topics',
  'all the topics', 'beginner', 'lost', 'know nothing', 'nothing at all',
  'start over', 'relearn', 'refresh everything', 'dont remember', "don't remember"
];

const CRASH_COURSE_REPLY = [
  '**The six-week "I forgot everything" plan** 🐍',
  '',
  'Good news: you have not really forgotten it - it is just buried. Here is the fastest path back.',
  '',
  '**Week 1 - Fluency**',
  '- basics: types, truthiness, `==` vs `is`',
  '- strings: slicing, `split` / `join`, f-strings',
  '- lists, dicts, sets: when to use which',
  '',
  '**Week 2 - Everyday Python**',
  '- comprehensions (list / dict / set)',
  '- functions, `*args` / `**kwargs`, closures',
  '- exceptions: `try` / `except` / `else` / `finally`',
  '',
  '**Week 3 - The interview favourites**',
  '- OOP: classes, `__init__`, `__repr__`, `super()`',
  '- decorators: the wrapper pattern',
  '- generators: `yield` and laziness',
  '',
  '**Week 4 - Algorithms**',
  '- recursion + memoization',
  '- sorting, searching and Big-O',
  '- two pointers and sliding window',
  '',
  '**Week 5 - Polish**',
  '- file I/O with `with open(...)`',
  '- Python gotchas (mutable defaults, shallow copies)',
  '',
  '**Week 6 - Mock interviews**',
  '- Use the Mock button: 5 questions, timed, no hints.',
  '',
  '**How to use this app with that plan**',
  '- Pick one topic in the Topic dropdown, set difficulty to Easy, and solve 3 questions.',
  '- Then switch the difficulty to Adaptive and let it choose for you.',
  '- Stuck on a concept? Just ask me about it and I will give you a short refresher.',
  '',
  '---',
  '_Offline cheat sheet. Add a free API key in `.env` for a tailored, conversational answer._'
].join('\n');

const OFFLINE_CHAT_FALLBACK = [
  'I am in **offline mode** right now (no LLM API key), so I answer from a built-in cheat sheet. Ask me about any of these:',
  '',
  '- basics - strings - lists, dicts and sets',
  '- comprehensions - functions and closures',
  '- OOP - decorators - generators',
  '- exceptions - file I/O - recursion',
  '- sorting and searching - interview patterns - Python gotchas',
  '',
  'Try "explain decorators", or "I forgot all topics - where do I start?".',
  '',
  '---',
  '_For full conversational answers, open `.env` and set `LLM_API_KEY` (free key at https://aistudio.google.com/apikey), then restart the server._'
].join('\n');

/** Keyword -> topic map used by the offline cheat sheet. */
const OFFLINE_CHAT_KEYWORDS = {
  basics: ['basics', 'types', 'truthy', 'falsy', 'mutable', 'immutable', 'operators', 'variable'],
  strings: ['string', 'strings', 'slice', 'slicing', 'substring', 'palindrome', 'anagram', 'f-string', 'format'],
  lists_dicts_sets: ['list', 'lists', 'tuple', 'tuples', 'dict', 'dicts', 'dictionary', 'set', 'sets', 'hashmap', 'hash map', 'counter', 'collections'],
  comprehensions: ['comprehension', 'comprehensions', 'one-liner', 'one liner'],
  functions_closures: ['function', 'functions', 'closure', 'closures', 'lambda', 'args', 'kwargs', 'scope', 'default argument', 'lru_cache', 'memoize', 'memoization'],
  oop: ['oop', 'class', 'classes', 'object', 'objects', 'inheritance', 'inherit', 'dunder', 'init', 'self', 'method', 'methods', 'polymorphism'],
  decorators: ['decorator', 'decorators', 'wrapper', 'wraps', 'functools'],
  generators: ['generator', 'generators', 'yield', 'iterator', 'iterable', 'lazy', 'laziness'],
  exceptions: ['exception', 'exceptions', 'error', 'errors', 'try', 'except', 'finally', 'raise', 'traceback'],
  file_io: ['file', 'files', 'file io', 'open', 'read', 'write', 'csv', 'json file', 'with statement'],
  recursion: ['recursion', 'recursive', 'base case', 'factorial', 'fibonacci', 'recursionerror'],
  sorting_searching: ['sort', 'sorting', 'sorted', 'search', 'searching', 'binary search', 'bisect', 'complexity', 'big o', 'big-o', 'time complexity', 'space complexity'],
  interview_patterns: ['two pointer', 'two pointers', 'two-pointer', 'sliding window', 'prefix sum', 'prefix sums', 'frequency', 'cycle detection', 'interview pattern', 'interview patterns'],
  python_gotchas: ['gotcha', 'gotchas', 'mutable default', 'shallow copy', 'deepcopy', 'deep copy', 'late binding', 'floating point', 'rounding', 'is vs ==']
};

/**
 * High-signal words route straight to a topic, so "how do I sort a list of
 * dicts?" returns the sorting note instead of the lists note.
 */
const OFFLINE_CHAT_PRIORITY = [
  { topic: 'sorting_searching', words: ['sort', 'sorted', 'sorting', 'binary search', 'bisect', 'big o', 'big-o', 'complexity'] },
  { topic: 'python_gotchas', words: ['gotcha', 'gotchas', 'mutable default', 'shallow copy'] },
  { topic: 'decorators', words: ['decorator', 'decorators', 'wrapper', 'wraps'] },
  { topic: 'generators', words: ['generator', 'generators', 'yield'] },
  { topic: 'recursion', words: ['recursion', 'recursive', 'base case'] },
  { topic: 'comprehensions', words: ['comprehension', 'comprehensions'] }
];

/** Word-ish match so "str" does not fire inside "instruction". */
function mentionsWord(text, word) {
  if (word.includes(' ') || word.includes('-')) return text.includes(word);
  const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${safe}\\b`).test(text);
}

/** Score every topic and return the best-matching one (or null). */
function matchOfflineTopic(text) {
  // Highest-confidence phrases win outright.
  for (const { topic, words } of OFFLINE_CHAT_PRIORITY) {
    if (words.some((w) => mentionsWord(text, w))) return topic;
  }

  let best = null;
  let bestScore = 0;
  for (const topic of Object.keys(OFFLINE_CHAT_KEYWORDS)) {
    let score = 0;
    for (const word of OFFLINE_CHAT_KEYWORDS[topic]) {
      if (mentionsWord(text, word)) score += word.includes(' ') ? 2 : 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = topic;
    }
  }
  return best;
}

/** Build a rule-based reply from the built-in cheat sheet. */
function offlineChatReply(messages) {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const text = (lastUser && lastUser.content ? lastUser.content : '').toLowerCase();

  if (CRASH_COURSE_TRIGGERS.some((t) => text.includes(t))) {
    return CRASH_COURSE_REPLY;
  }
  const topic = matchOfflineTopic(text);
  if (topic && OFFLINE_CHAT_NOTES[topic]) {
    return `${OFFLINE_CHAT_NOTES[topic]}\n\n---\n_Offline cheat sheet. Add a free API key in \`.env\` for a tailored answer._`;
  }
  return OFFLINE_CHAT_FALLBACK;
}

/** Send the conversation to the configured LLM, with light learner context. */
async function chatWithLLM({ history, question, progress }) {
  const weak = weakTopics(progress);
  const context = [
    question && question.statement
      ? `The learner is currently working on this question:\n${describeQuestion(question)}`
      : '',
    weak.length ? `Their weakest topics so far: ${weak.join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  const system = context ? `${CHAT_SYSTEM}\n\nContext:\n${context}` : CHAT_SYSTEM;

  const text = await callLLM({
    system,
    messages: history,
    maxTokens: 900
  });
  return text.trim();
}

// ---------------------------------------------------------------------------
// Concept explanations (POST /api/explain)
// ---------------------------------------------------------------------------

const EXPLAIN_SYSTEM =
  'You are a warm, patient senior Python instructor coaching someone who is ' +
  'relearning Python for interviews after a long break. You explain concepts ' +
  'clearly and briefly, with tiny concrete examples. You always reply with ' +
  'valid JSON and nothing else.';

const EXPLAIN_SCHEMA_HINT = `Return ONLY a JSON object (no markdown fences, no commentary):
{
  "concepts": [
    {
      "title": "short concept name",
      "explanation": "2-5 sentences in plain English explaining the concept as it applies to THIS question. You may use markdown: **bold**, inline \`code\`, and fenced \`\`\`python code blocks for a tiny example."
    }
  ]
}
Identify the 3 to 6 core Python concepts the learner needs to solve this exact question, ordered from most to least central. Do NOT reveal the full solution.`;

/** Ask the LLM to explain the concepts behind a question. */
async function explainWithLLM({ question }) {
  const user =
    `Here is a Python interview question:\n\n${describeQuestion(question)}\n\n` +
    `List the core concepts needed and explain each briefly.\n\n${EXPLAIN_SCHEMA_HINT}`;

  const text = await callLLM({
    system: EXPLAIN_SYSTEM,
    messages: [{ role: 'user', content: user }],
    maxTokens: 1200
  });

  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.concepts) || !parsed.concepts.length) {
    throw new Error('Could not parse concept explanations from the model response');
  }
  const concepts = parsed.concepts
    .filter((c) => c && c.title && c.explanation)
    .map((c) => ({ title: String(c.title), explanation: String(c.explanation) }));
  if (!concepts.length) throw new Error('No concepts returned by the model');
  return concepts;
}

/** Tidy a topic id into a readable label (offline fallback). */
function topicLabel(t) {
  return String(t || 'General')
    .split('_')
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Offline fallback: serve the built-in topic cheat-sheet as one explanation. */
function offlineExplain({ question }) {
  const note = OFFLINE_CHAT_NOTES[question.topic] || OFFLINE_CHAT_FALLBACK;
  return [{ title: `${topicLabel(question.topic)} refresher`, explanation: note }];
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
 * POST /api/chat
 * body: { messages: [{role, content}], question? }
 * Free-form tutoring. Falls back to a built-in cheat sheet when no key is set.
 * Returns: { reply, source }
 */
app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  if (!history.length) {
    return res.status(400).json({ error: 'A message is required.' });
  }

  // Only pass the parts of the question the tutor needs (never the solution).
  const q = body.question && typeof body.question === 'object'
    ? {
        title: body.question.title,
        topic: body.question.topic,
        difficulty: body.question.difficulty,
        statement: body.question.statement,
        functionName: body.question.functionName
      }
    : null;

  if (!llmConfig().enabled) {
    return res.json({ reply: offlineChatReply(history), source: 'offline', reason: 'NO_API_KEY' });
  }

  try {
    const progress = loadProgress();
    const reply = await chatWithLLM({ history, question: q, progress });
    res.json({ reply, source: 'ai' });
  } catch (err) {
    console.warn('[chat] AI chat failed, using the offline cheat sheet:', err.message);
    res.json({ reply: offlineChatReply(history), source: 'offline', reason: err.message });
  }
});

/**
 * POST /api/explain
 * body: { question }
 * Returns a short explanation of each concept the question needs.
 * Falls back to the built-in topic cheat sheet when no key is set.
 */
app.post('/api/explain', async (req, res) => {
  const question = req.body && req.body.question;
  if (!question || typeof question !== 'object' || !question.topic) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  if (!llmConfig().enabled) {
    return res.json({ concepts: offlineExplain({ question }), source: 'offline', reason: 'NO_API_KEY' });
  }

  try {
    const concepts = await explainWithLLM({ question });
    res.json({ concepts, source: 'ai' });
  } catch (err) {
    console.warn('[explain] AI explanation failed, using offline cheat sheet:', err.message);
    res.json({ concepts: offlineExplain({ question }), source: 'offline', reason: err.message });
  }
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
