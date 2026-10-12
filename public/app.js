/**
 * PyPrep Coach - frontend logic
 * ---------------------------------------------------------------------------
 * Plain ES module, no build step. Responsibilities:
 *   - Load / render questions from the backend
 *   - Run the CodeMirror/Monaco editor (with a textarea fallback)
 *   - Optionally execute the answer against test cases with Pyodide
 *   - Send the answer to the backend for AI feedback and render it
 *   - Track XP / level / streak / dashboard and mock interviews
 */

// ---------------------------------------------------------------------------
// Constants & tiny helpers
// ---------------------------------------------------------------------------
const MONACO_VERSION = '0.52.2';
const PYODIDE_VERSION = '0.26.4';
const MOCK_TOTAL = 5;
const MOCK_SECONDS = 30 * 60; // 30 minute mock interview

const TOPIC_LABELS = {
  basics: 'Basics',
  strings: 'Strings',
  lists_dicts_sets: 'Lists / Dicts / Sets',
  comprehensions: 'Comprehensions',
  functions_closures: 'Functions & Closures',
  oop: 'OOP',
  decorators: 'Decorators',
  generators: 'Generators',
  exceptions: 'Exceptions',
  file_io: 'File I/O',
  recursion: 'Recursion',
  sorting_searching: 'Sorting & Searching',
  interview_patterns: 'Interview Patterns',
  python_gotchas: 'Python Gotchas'
};

const $ = (id) => document.getElementById(id);
const topicLabel = (t) => TOPIC_LABELS[t] || t || 'General';

/** Escape text before putting it inside innerHTML. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------
const state = {
  topics: [],
  progress: null,
  level: null,
  question: null,
  validating: false,
  combo: 0, // consecutive correct answers in this session
  pyodide: null, // resolved Pyodide instance
  pyodideFailed: false,
  editor: null, // Monaco instance (if loaded)
  editorReady: false,
  mock: {
    active: false,
    results: [],
    difficulty: 'Medium',
    remaining: MOCK_SECONDS,
    timer: null
  }
};

// ---------------------------------------------------------------------------
// Small API wrapper
// ---------------------------------------------------------------------------
async function api(pathname, options) {
  const res = await fetch(pathname, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch (_) {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ---------------------------------------------------------------------------
// Editor: Monaco with graceful textarea fallback
// ---------------------------------------------------------------------------
function initEditor() {
  return new Promise((resolve) => {
    const fallback = () => {
      // Monaco did not load (offline?). Use a plain textarea so the app works.
      $('editor').classList.add('hidden');
      const ta = $('editorFallback');
      ta.classList.remove('hidden');
      // Tab inserts four spaces instead of moving focus.
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = ta.value.slice(0, start) + '    ' + ta.value.slice(end);
          ta.selectionStart = ta.selectionEnd = start + 4;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          validate();
        }
      });
      state.editorReady = true;
      resolve();
    };

    if (!window.require) return fallback();

    try {
      window.require.config({ paths: { vs: `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs` } });
      window.require(
        ['vs/editor/editor.main'],
        () => {
          const monaco = window.monaco;
          defineMonacoThemes(monaco);
          state.editor = monaco.editor.create($('editor'), {
            value: '',
            language: 'python',
            theme: currentTheme() === 'light' ? 'pyprep-light' : 'pyprep-dark',
            automaticLayout: true,
            fontSize: 14,
            fontFamily: 'JetBrains Mono, Consolas, monospace',
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 4,
            insertSpaces: true,
            renderWhitespace: 'selection',
            padding: { top: 12, bottom: 12 },
            lineNumbersMinChars: 3
          });
          // Ctrl/Cmd + Enter validates.
          state.editor.addAction({
            id: 'validate-answer',
            label: 'Validate answer',
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
            run: () => validate()
          });
          state.editorReady = true;
          resolve();
        },
        fallback // error callback
      );
    } catch (err) {
      console.warn('Monaco init failed:', err);
      fallback();
    }
  });
}

/** Define editor themes that match our CSS palette. */
function defineMonacoThemes(monaco) {
  monaco.editor.defineTheme('pyprep-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#161b22' }
  });
  monaco.editor.defineTheme('pyprep-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' }
  });
}

function getCode() {
  if (state.editor) return state.editor.getValue();
  return $('editorFallback').value;
}

function setCode(code) {
  const value = code || '';
  if (state.editor) {
    state.editor.setValue(value);
  } else {
    $('editorFallback').value = value;
  }
}

// ---------------------------------------------------------------------------
// Pyodide: run the learner's code against the question's test cases
// ---------------------------------------------------------------------------
async function ensurePyodide() {
  if (state.pyodide) return state.pyodide;
  if (state.pyodideFailed) return null;
  try {
    await loadScript(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`);
    state.pyodide = await window.loadPyodide({
      indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
    });
    return state.pyodide;
  } catch (err) {
    console.warn('Pyodide failed to load:', err);
    state.pyodideFailed = true;
    return null;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// Python harness: loads the answer, calls the function with each test's args,
// and compares results (optionally order-insensitively).
const PY_HARNESS = `
import json as _json

def _norm(v, unordered):
    if isinstance(v, list):
        v = [_norm(x, unordered) for x in v]
        if unordered:
            try:
                v = sorted(v, key=lambda x: _json.dumps(x, sort_keys=True, default=str))
            except Exception:
                pass
    return v

def _run_tests(payload):
    ns = {}
    try:
        exec(payload['code'], ns)
    except Exception as e:
        err = f"{type(e).__name__}: {e}"
        results = [{'args': t['args'], 'expected': t['expected'], 'got': None,
                    'passed': False, 'error': 'your code raised an error while loading'} for t in payload['tests']]
        return _json.dumps({'ran': True, 'loadError': err, 'results': results}, default=str)

    fn = ns.get(payload['fname'])
    if not callable(fn):
        results = [{'args': t['args'], 'expected': t['expected'], 'got': None,
                    'passed': False, 'error': f"function '{payload['fname']}' was not defined"} for t in payload['tests']]
        return _json.dumps({'ran': True, 'loadError': f"function '{payload['fname']}' not found", 'results': results}, default=str)

    results = []
    for t in payload['tests']:
        got, err, passed = None, None, False
        try:
            got = fn(*t['args'])
            passed = _norm(got, t.get('unordered', False)) == _norm(t['expected'], t.get('unordered', False))
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
        results.append({'args': t['args'], 'expected': t['expected'], 'got': got, 'passed': passed, 'error': err})
    return _json.dumps({'ran': True, 'loadError': None, 'results': results}, default=str)
`;

/**
 * Execute the current code against the question's test cases.
 * Returns an execution object, or null if execution is unavailable.
 */
async function runTests(question, code) {
  if (!question.testCases || question.testCases.length === 0) return null;
  const py = await ensurePyodide();
  if (!py) return null;

  const payload = { code, fname: question.functionName || 'solution', tests: question.testCases };
  // Embed the payload as a JSON string literal (valid Python string literal too),
  // parse it into a dict inside Python, and return a JSON *string* which we parse
  // back in JS. (Returning a Python dict would give us a Map, not a plain object.)
  const asPyString = JSON.stringify(JSON.stringify(payload));
  const script = `${PY_HARNESS}\n_run_tests(_json.loads(${asPyString}))`;

  try {
    const raw = await py.runPythonAsync(script);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const details = parsed.results || [];
    const passed = details.filter((d) => d.passed).length;
    return {
      ran: true,
      total: details.length,
      passed,
      details,
      error: parsed.loadError || null
    };
  } catch (err) {
    return { ran: true, total: 0, passed: 0, details: [], error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Question rendering
// ---------------------------------------------------------------------------
function renderQuestion(q) {
  state.question = q;
  $('qTitle').textContent = q.title;
  const diff = $('qDifficulty');
  diff.textContent = q.difficulty;
  diff.dataset.diff = q.difficulty;
  $('qTopic').textContent = topicLabel(q.topic);
  $('qStatement').textContent = q.statement;

  // Examples
  const exBox = $('qExamples');
  exBox.innerHTML = '';
  (q.examples || []).forEach((ex, i) => {
    const div = document.createElement('div');
    div.className = 'example';
    div.innerHTML =
      `<div class="row"><span class="k">Example ${i + 1}</span></div>` +
      `<div class="row"><span class="k">Input:</span><span>${esc(ex.input)}</span></div>` +
      `<div class="row"><span class="k">Output:</span><span>${esc(ex.output)}</span></div>`;
    exBox.appendChild(div);
  });

  // Reset hint/solution panels
  $('hintBox').classList.add('hidden');
  $('solutionBox').classList.add('hidden');

  // Pre-fill the editor with the starter code.
  setCode(q.starterCode);

  // Reset feedback area
  resetFeedback();

  // Buttons fresh state
  $('nextBtn').textContent = 'Next ➜';
  updateMockBanner();
}

function resetFeedback() {
  $('feedbackEmpty').classList.remove('hidden');
  $('feedbackEmpty').innerHTML =
    '<div class="empty-emoji">🤖</div>' +
    '<div>Write your solution, then hit <strong>Validate</strong>.</div>' +
    '<div class="empty-sub">Your AI coach\'s feedback will land right here.</div>';
  const content = $('feedbackContent');
  content.classList.add('hidden');
  content.innerHTML = '';
  $('execStatus').textContent = '';
}

// ---------------------------------------------------------------------------
// Loading a new question
// ---------------------------------------------------------------------------
async function newQuestion() {
  const topic = $('topicSelect').value;
  const difficulty = $('difficultySelect').value;
  $('newQuestionBtn').disabled = true;
  $('nextBtn').disabled = true;

  try {
    const isMock = state.mock.active;
    const data = await api('/api/question', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        difficulty: isMock ? state.mock.difficulty : difficulty,
        mock: isMock
      })
    });
    renderQuestion(data.question);

    const src = $('qSource');
    if (data.source === 'seed') {
      src.classList.remove('hidden');
      src.textContent = data.reason === 'NO_API_KEY' ? 'bundled question' : 'bundled (AI offline)';
      src.title = data.reason || '';
    } else {
      src.classList.add('hidden');
    }
  } catch (err) {
    toast(`Could not load a question: ${err.message}`);
  } finally {
    $('newQuestionBtn').disabled = false;
    $('nextBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
async function validate() {
  if (state.validating || !state.question) return;
  const code = getCode();
  if (!code.trim()) {
    toast('Write some code first - even a rough attempt helps.');
    return;
  }
  if (/^def\s+\w+\([^)]*\):\s*(\n\s*#.*)*\n?\s*pass\s*$/m.test(code) && code.split('\n').length <= 4) {
    // Gentle nudge: the starter stub is still untouched.
    toast('Looks like you have not started yet - give it a try!');
  }

  state.validating = true;
  const btn = $('validateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Validating…';
  $('execStatus').innerHTML = '<span class="spinner"></span>Running your code against the test cases…';

  // Focus the feedback area so the learner sees it fill in.
  try {
    const execution = await runTests(state.question, code);
    if (execution) {
      $('execStatus').textContent = execution.error
        ? `Execution: ${execution.error}`
        : `Execution: ${execution.passed}/${execution.total} test cases passed.`;
    } else {
      $('execStatus').textContent = 'Execution unavailable (offline) - relying on the AI tutor.';
    }

    $('feedbackEmpty').innerHTML = '<span class="spinner"></span>Asking your AI coach…';
    const data = await api('/api/validate', {
      method: 'POST',
      body: JSON.stringify({ question: state.question, code, execution, mock: state.mock.active })
    });

    state.progress = data.progress;
    state.level = data.level;

    // Update the combo counter, then refresh the HUD.
    if (data.feedback.verdict === 'correct') {
      state.combo = (state.combo || 0) + 1;
    } else {
      state.combo = 0;
    }
    renderProgressHeader();
    if (data.xpAwarded > 0) pulseLevelChip();

    renderFeedback(data.feedback, data.xpAwarded, data.source);

    if (data.feedback.verdict === 'correct' && confettiEnabled()) {
      launchConfetti();
    }

    // Mock interview bookkeeping
    if (state.mock.active) {
      state.mock.results.push({
        topic: state.question.topic,
        difficulty: state.question.difficulty,
        verdict: data.feedback.verdict
      });
      if (state.mock.results.length >= MOCK_TOTAL) {
        $('nextBtn').textContent = '🏁 Finish & see report';
      }
      updateMockBanner();
    }
  } catch (err) {
    $('feedbackEmpty').classList.remove('hidden');
    $('feedbackEmpty').innerHTML = `⚠️ ${esc(err.message)}`;
    toast(`Validation failed: ${err.message}`);
    $('execStatus').textContent = '';
  } finally {
    state.validating = false;
    btn.disabled = false;
    btn.textContent = '▶ Validate';
  }
}

// ---------------------------------------------------------------------------
// Feedback rendering
// ---------------------------------------------------------------------------
const VERDICT_LABEL = {
  correct: 'Correct',
  partially_correct: 'Partially correct',
  incorrect: 'Not quite'
};

function renderFeedback(fb, xpAwarded, source) {
  $('feedbackEmpty').classList.add('hidden');
  const el = $('feedbackContent');
  el.classList.remove('hidden');

  const concepts = (fb.concepts_to_review || [])
    .map((c) => `<span class="chip"><b>${esc(c.concept)}</b> → search: ${esc(c.keyword)}</span>`)
    .join('');

  const improvements = (fb.improvements || []).length
    ? `<div class="fb-section"><h4>How to level up</h4><ul>${fb.improvements
        .map((i) => `<li>${esc(i)}</li>`)
        .join('')}</ul></div>`
    : '';
  const fix = (fb.how_to_fix || []).length
    ? `<div class="fb-section"><h4>How to fix it</h4><ul>${fb.how_to_fix
        .map((i) => `<li>${esc(i)}</li>`)
        .join('')}</ul></div>`
    : '';
  const wrong = fb.what_went_wrong
    ? `<div class="fb-section"><h4>What went wrong</h4><p>${esc(fb.what_went_wrong)}</p></div>`
    : '';
  const approach = fb.corrected_approach
    ? `<div class="fb-section"><h4>The right approach</h4><p>${esc(fb.corrected_approach)}</p></div>`
    : '';
  const conceptsBlock = concepts
    ? `<div class="fb-section"><h4>Concepts to review</h4><div class="chips">${concepts}</div></div>`
    : '';

  el.innerHTML = `
    <div class="feedback-card" data-verdict="${esc(fb.verdict)}">
      <div class="verdict-row">
        <span class="verdict-badge" data-verdict="${esc(fb.verdict)}">${esc(VERDICT_LABEL[fb.verdict] || fb.verdict)}</span>
        ${xpAwarded > 0 ? `<span class="xp-gain">+${xpAwarded} XP</span>` : ''}
        ${source === 'fallback' ? '<span class="pill">offline tutor</span>' : ''}
      </div>
      <p class="summary">${esc(fb.summary)}</p>
      ${improvements}
      ${wrong}
      ${fix}
      ${approach}
      ${conceptsBlock}
      <div class="complexity">
        <span>Time: ${esc(fb.complexity?.time || 'unknown')}</span>
        <span>Space: ${esc(fb.complexity?.space || 'unknown')}</span>
      </div>
      <div class="encouragement">${esc(fb.encouragement)}</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Header stats / dashboard
// ---------------------------------------------------------------------------
function solvedCount() {
  if (!state.progress) return 0;
  const ids = new Set();
  for (const a of state.progress.attempts || []) {
    if (a.verdict === 'correct') ids.add(a.questionId);
  }
  return ids.size;
}

function renderProgressHeader() {
  if (!state.level || !state.progress) return;
  $('levelNum').textContent = state.level.level;
  $('xpNum').textContent = state.progress.xp;
  const pct = Math.max(0, Math.min(100, state.level.progressPct || 0));
  $('xpFill').style.width = `${pct}%`;
  $('streakNum').textContent = state.progress.streak?.count || 0;
  $('solvedNum').textContent = solvedCount();

  // Animate the circular level ring (r = 20 -> circumference ~= 125.66).
  const ring = $('levelRing');
  if (ring) {
    const C = 2 * Math.PI * 20;
    ring.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
  }

  // Combo pill (shown once you have 2+ correct answers in a row).
  const combo = state.combo || 0;
  const pill = $('comboPill');
  if (combo >= 2) {
    pill.classList.remove('hidden');
    $('comboNum').textContent = combo;
  } else {
    pill.classList.add('hidden');
  }

  const confetti = state.progress.settings?.confetti !== false;
  $('confettiLabel').textContent = confetti ? 'On' : 'Off';
}

/** Briefly pulse the level chip to celebrate an XP gain. */
function pulseLevelChip() {
  const chip = $('levelChip');
  if (!chip) return;
  chip.classList.remove('pop');
  void chip.offsetWidth; // restart the animation
  chip.classList.add('pop');
}

function confettiEnabled() {
  return state.progress?.settings?.confetti !== false;
}

function renderDashboard() {
  const p = state.progress || { topicStats: {}, topicsToBrushUp: [], mockHistory: [], streak: {} };
  const stats = Object.entries(p.topicStats || {});
  const totalAttempts = stats.reduce((a, [, s]) => a + s.attempts, 0);
  const totalCorrect = stats.reduce((a, [, s]) => a + s.correct, 0);
  const accuracy = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : 0;

  const topicRows = stats
    .map(([topic, s]) => {
      const acc = Math.round(((s.correct + s.partial * 0.5) / s.attempts) * 100);
      const weak = acc < 70 ? ' <span class="badge-weak">weak</span>' : '';
      return `<div class="topic-row">
        <span>${esc(topicLabel(topic))}${weak}</span>
        <div class="topic-bar"><div style="width:${acc}%; background:${acc >= 70 ? 'var(--green)' : acc >= 45 ? 'var(--amber)' : 'var(--red)'}"></div></div>
        <span>${acc}%</span>
      </div>`;
    })
    .join('');

  const brush = (p.topicsToBrushUp || [])
    .map((t) => `<span class="chip"><b>${esc(t.concept)}</b>${t.keyword && t.keyword !== t.concept ? ' → ' + esc(t.keyword) : ''}</span>`)
    .join('');
  const brushBlock = brush
    ? `<h4 style="margin-top:20px">Topics to brush up</h4><div class="chips">${brush}</div>`
    : '<p style="color:var(--text-dim)">No concepts flagged yet - keep practising!</p>';

  const mockRows = (p.mockHistory || [])
    .slice(-5)
    .reverse()
    .map((m) => `<div class="topic-row" style="grid-template-columns:1fr 1fr 1fr">
      <span>${new Date(m.date).toLocaleDateString()}</span>
      <span>${m.score}/${m.total} (${m.pct}%)</span>
      <span><b>${esc(m.grade)}</b></span>
    </div>`)
    .join('');

  $('dashBody').innerHTML = `
    <div class="dash-grid">
      <div class="dash-tile"><div class="n">${p.xp || 0}</div><div class="l">Total XP</div></div>
      <div class="dash-tile"><div class="n">${state.level ? state.level.level : 1}</div><div class="l">Level</div></div>
      <div class="dash-tile"><div class="n">🔥 ${p.streak?.count || 0}</div><div class="l">Day streak</div></div>
      <div class="dash-tile"><div class="n">${accuracy}%</div><div class="l">Overall accuracy</div></div>
      <div class="dash-tile"><div class="n">${totalCorrect}</div><div class="l">Correct answers</div></div>
    </div>
    <h4>Accuracy by topic</h4>
    ${topicRows || '<p style="color:var(--text-dim)">Attempt a few questions to see your breakdown.</p>'}
    ${brushBlock}
    ${mockRows ? '<h4 style="margin-top:20px">Recent mock interviews</h4>' + mockRows : ''}
  `;
  $('dashModal').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Mock interview mode
// ---------------------------------------------------------------------------
function startMock() {
  state.mock.active = true;
  state.mock.results = [];
  state.mock.remaining = MOCK_SECONDS;
  const chosen = $('difficultySelect').value;
  state.mock.difficulty = chosen === 'adaptive' ? 'Medium' : chosen;

  $('mockBanner').classList.remove('hidden');
  $('hintBtn').disabled = true;
  $('solutionBtn').disabled = true;
  $('solutionBtn').classList.add('hidden');
  $('hintBtn').classList.add('hidden');
  updateMockBanner();
  tickMock();

  clearInterval(state.mock.timer);
  state.mock.timer = setInterval(tickMock, 1000);
  newQuestion();
}

function tickMock() {
  if (!state.mock.active) return;
  state.mock.remaining -= 1;
  if (state.mock.remaining <= 0) {
    state.mock.remaining = 0;
    $('mockTimer').textContent = '00:00';
    finishMock(true);
    return;
  }
  const m = String(Math.floor(state.mock.remaining / 60)).padStart(2, '0');
  const s = String(state.mock.remaining % 60).padStart(2, '0');
  $('mockTimer').textContent = `${m}:${s}`;
}

function updateMockBanner() {
  const done = state.mock.results.length;
  $('mockProgress').textContent = `Question ${Math.min(done + 1, MOCK_TOTAL)} of ${MOCK_TOTAL}`;
}

async function finishMock(timedOut) {
  clearInterval(state.mock.timer);
  state.mock.active = false;
  $('mockBanner').classList.add('hidden');
  $('hintBtn').disabled = false;
  $('solutionBtn').disabled = false;
  $('solutionBtn').classList.remove('hidden');
  $('hintBtn').classList.remove('hidden');
  $('nextBtn').textContent = 'Next ➜';

  const results = state.mock.results;
  let report = null;
  try {
    const data = await api('/api/mock/report', {
      method: 'POST',
      body: JSON.stringify({ results, difficulty: state.mock.difficulty })
    });
    report = data.report;
    state.progress = data.progress;
    renderProgressHeader();
  } catch (err) {
    toast(`Could not save the report: ${err.message}`);
  }

  const total = results.length;
  const score = results.reduce((a, r) => a + (r.verdict === 'correct' ? 1 : r.verdict === 'partially_correct' ? 0.5 : 0), 0);
  const pct = total ? Math.round((score / total) * 100) : 0;
  const rows = results
    .map(
      (r, i) => `<div class="topic-row" style="grid-template-columns:40px 1fr 120px">
        <span>${i + 1}.</span>
        <span>${esc(topicLabel(r.topic))} · ${esc(r.difficulty)}</span>
        <span class="verdict-badge" data-verdict="${esc(r.verdict)}" style="text-align:center">${esc(VERDICT_LABEL[r.verdict] || r.verdict)}</span>
      </div>`
    )
    .join('');

  $('feedbackEmpty').classList.add('hidden');
  const el = $('feedbackContent');
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="feedback-card" data-verdict="${pct >= 80 ? 'correct' : pct >= 55 ? 'partially_correct' : 'incorrect'}">
      <div class="verdict-row">
        <span class="verdict-badge" data-verdict="${pct >= 80 ? 'correct' : pct >= 55 ? 'partially_correct' : 'incorrect'}">
          Report card ${report ? '- Grade ' + esc(report.grade) : ''}
        </span>
        ${timedOut ? '<span class="pill">time ran out</span>' : ''}
      </div>
      <p class="summary">${report ? esc(report.headline) : ''} You scored <strong>${score}/${total}</strong> (${pct}%).</p>
      ${rows}
      ${report && report.weakest && report.weakest.length
        ? `<div class="fb-section"><h4>Focus next on</h4><div class="chips">${report.weakest
            .map((t) => `<span class="chip">${esc(topicLabel(t))}</span>`)
            .join('')}</div></div>`
        : ''}
      <div class="encouragement">${
        pct >= 80 ? 'You handled that like a pro - schedule one of these every few days.' : 'Mock interviews feel hard before they feel easy. Run another one soon.'
      }</div>
    </div>`;
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('themeToggle').textContent = theme === 'light' ? '☀️' : '🌙';
  if (state.editor && window.monaco) {
    window.monaco.editor.setTheme(theme === 'light' ? 'pyprep-light' : 'pyprep-dark');
  }
}

function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  applyTheme(next);
  // Persist (best effort).
  api('/api/progress/settings', { method: 'POST', body: JSON.stringify({ theme: next }) })
    .then((d) => {
      state.progress = d.progress;
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Confetti (tiny self-contained implementation, no external library)
// ---------------------------------------------------------------------------
function launchConfetti() {
  let canvas = document.getElementById('confetti-canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'confetti-canvas';
    document.body.appendChild(canvas);
  }
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#7c6cf6', '#4dd4ac', '#f2c14e', '#f85149', '#4dabf7', '#ff9f43'];
  const pieces = Array.from({ length: 130 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    r: 4 + Math.random() * 6,
    c: colors[Math.floor(Math.random() * colors.length)],
    vy: 2 + Math.random() * 3.5,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vr: -0.15 + Math.random() * 0.3
  }));

  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of pieces) {
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = Math.max(0, 1 - elapsed / 2800);
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 1.6);
      ctx.restore();
    }
    if (elapsed < 2800) {
      requestAnimationFrame(frame);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Bootstrapping & event wiring
// ---------------------------------------------------------------------------
async function loadProgress() {
  try {
    const data = await api('/api/progress');
    state.progress = data.progress;
    state.level = data.level;
    renderProgressHeader();
    applyTheme((data.progress.settings && data.progress.settings.theme) || 'dark');
  } catch (err) {
    console.warn('Could not load progress:', err);
  }
}

async function loadTopics() {
  try {
    const data = await api('/api/topics');
    state.topics = data.topics;
    const select = $('topicSelect');
    select.innerHTML =
      '<option value="adaptive">Adaptive (recommended)</option>' +
      data.topics.map((t) => `<option value="${t}">${esc(topicLabel(t))}</option>`).join('');
  } catch (err) {
    console.warn('Could not load topics:', err);
  }
}

function wireEvents() {
  $('newQuestionBtn').addEventListener('click', () => newQuestion());
  $('surpriseBtn').addEventListener('click', () => {
    $('topicSelect').value = 'adaptive';
    $('difficultySelect').value = 'adaptive';
    newQuestion();
  });
  $('validateBtn').addEventListener('click', validate);
  $('nextBtn').addEventListener('click', () => {
    if (state.mock.active && state.mock.results.length >= MOCK_TOTAL) {
      finishMock(false);
    } else {
      newQuestion();
    }
  });
  $('tryAgainBtn').addEventListener('click', () => {
    resetFeedback();
    if (state.editor) state.editor.focus();
  });
  $('hintBtn').addEventListener('click', () => {
    if (!state.question) return;
    $('hintText').textContent = state.question.hint;
    $('hintBox').classList.remove('hidden');
  });
  $('solutionBtn').addEventListener('click', () => {
    if (!state.question) return;
    if (state.mock.active) {
      toast('No solutions during a mock interview. Trust yourself!');
      return;
    }
    $('solutionText').textContent = state.question.solution;
    $('solutionBox').classList.remove('hidden');
  });

  $('themeToggle').addEventListener('click', toggleTheme);
  $('confettiToggle').addEventListener('click', () => {
    const next = !confettiEnabled();
    if (state.progress) state.progress.settings.confetti = next;
    renderProgressHeader();
    api('/api/progress/settings', { method: 'POST', body: JSON.stringify({ confetti: next }) }).catch(() => {});
  });

  $('dashBtn').addEventListener('click', renderDashboard);
  $('dashClose').addEventListener('click', () => $('dashModal').classList.add('hidden'));
  $('dashModal').addEventListener('click', (e) => {
    if (e.target === $('dashModal')) $('dashModal').classList.add('hidden');
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('Reset ALL progress (XP, streak, history)? This cannot be undone.')) return;
    try {
      const data = await api('/api/progress/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) });
      state.progress = data.progress;
      state.level = data.level;
      renderProgressHeader();
      renderDashboard();
      toast('Progress reset.');
    } catch (err) {
      toast(err.message);
    }
  });

  $('mockBtn').addEventListener('click', () => {
    if (state.mock.active) {
      if (confirm('End the mock interview now?')) finishMock(false);
      return;
    }
    startMock();
  });
  $('mockQuit').addEventListener('click', () => finishMock(false));

  // Keyboard shortcuts that work even without Monaco.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      validate();
    }
  });
}

async function init() {
  wireEvents();
  await loadProgress();
  await loadTopics();
  await initEditor();
  await newQuestion();
}

init().catch((err) => {
  console.error(err);
  toast(`Startup error: ${err.message}`);
});
