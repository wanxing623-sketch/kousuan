(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const setupEl = $('#setup');
  const practiceEl = $('#practice');
  const resultsEl = $('#results');
  const answerForm = $('#answer-form');
  const answerInput = $('#answer');
  const voiceArea = $('#voice-area');
  const voiceButton = $('#voice-button');
  const voiceLabel = $('#voice-label');
  const heardEl = $('#heard-text');
  const feedbackEl = $('#feedback');
  const questionEl = $('#question');
  const progressLabel = $('#progress-label');
  const progressFill = $('#progress-fill');
  const timerEl = $('#timer-label');
  const nextButton = $('#next-button');
  const voiceNote = $('#voice-note');

  const SETTINGS_KEY = 'kousuan:settings:v1';
  const BEST_KEY = 'kousuan:best:v2';
  const BEST_LABELS = { two: '两位数', mixed: '两位×三位', three: '三位数', review: '错题重练' };

  // ---------- 设置（本机记忆） ----------
  let settings = { mode: 'typing', level: 'two', count: 10 };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') settings = { ...settings, ...saved };
  } catch (_) { /* 忽略损坏的存档 */ }
  let mode = settings.mode === 'voice' ? 'voice' : 'typing';
  let level = ['two', 'mixed', 'three'].includes(settings.level) ? settings.level : 'two';
  let targetCount = [0, 10, 20, 30].includes(settings.count) ? settings.count : 10;

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode, level, count: targetCount }));
    } catch (_) { /* 存储不可用时静默跳过 */ }
  }

  // ---------- 练习状态 ----------
  let questionCount = 0;
  let answeredCount = 0;
  let correctCount = 0;
  let streak = 0;
  let bestStreak = 0;
  let currentAnswer = 0;
  let currentHtml = '';
  let currentText = '';
  let locked = false;
  let awaitingNext = false;
  let seen = new Set();
  let wrongList = [];
  let durations = [];
  let sessionStart = 0;
  let questionStart = 0;
  let timerId = null;
  let pausedTotal = 0;
  let pauseStart = 0;
  let reviewMode = false;
  let reviewQueue = [];
  let wakeLock = null;

  // ---------- 语音识别 ----------
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognitionAvailable = typeof SpeechRecognition === 'function';
  let recognition = null;
  let listening = false;
  let wantListening = false;

  if (recognitionAvailable) {
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      listening = true;
      startFailures = 0;
      updateVoiceButton();
    };
    recognition.onresult = onSpeechResult;
    recognition.onerror = onSpeechError;
    recognition.onend = onSpeechEnd;
  }
  let startFailures = 0;

  function onSpeechResult(event) {
    const last = event.results[event.results.length - 1];
    const text = last[0].transcript.trim();
    if (!last.isFinal) {
      heardEl.textContent = text ? `听到：${text}…` : '';
      return;
    }
    heardEl.textContent = text ? `听到：${text}` : '';
    const value = parseSpokenNumber(text);
    if (value === null) {
      setFeedback('没听清数字，请再说一次。', 'bad');
      return; // onend 会自动继续聆听
    }
    answerInput.value = String(value);
    checkAnswer(value);
    stopListening(); // 判定后立即停止收音
  }

  function onSpeechError(event) {
    if (event.error === 'aborted') return;
    if (event.error === 'no-speech') {
      setFeedback('没听清，请再说一次。', 'bad');
      return; // onend 会自动继续聆听
    }
    wantListening = false;
    const messages = {
      'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许使用麦克风。',
      'service-not-allowed': '当前环境不允许使用语音识别。',
      'audio-capture': '没有检测到麦克风，请检查设备。',
      network: '语音识别需要联网，请检查网络后重试。',
    };
    setFeedback(messages[event.error] || '语音识别暂不可用，请点按按钮重试，或改用打字作答。', 'bad');
  }

  function onSpeechEnd() {
    listening = false;
    updateVoiceButton();
    if (wantListening && mode === 'voice' && !locked && !practiceEl.hidden) {
      window.setTimeout(() => {
        if (wantListening && mode === 'voice' && !locked && !practiceEl.hidden) startListening();
      }, 250);
    }
  }

  function startListening() {
    if (!recognitionAvailable || listening || locked || practiceEl.hidden) return;
    if (startFailures >= 5) {
      wantListening = false;
      setFeedback('语音识别多次启动失败，请点按按钮重试，或改用打字作答。', 'bad');
      return;
    }
    try {
      recognition.start();
      listening = true;
      updateVoiceButton();
    } catch (_) {
      // 上一轮识别可能还没完全结束，稍后重试
      listening = false;
      startFailures += 1;
      window.setTimeout(() => {
        if (wantListening && !listening && !locked && !practiceEl.hidden) startListening();
      }, 300);
    }
  }

  function stopListening() {
    wantListening = false;
    if (recognitionAvailable && listening) {
      try { recognition.stop(); } catch (_) { /* 可能已停止 */ }
    }
    listening = false;
    updateVoiceButton();
  }

  function updateVoiceButton() {
    voiceButton.classList.toggle('listening', listening);
    if (!recognitionAvailable) {
      voiceLabel.textContent = '当前浏览器不支持语音识别';
      voiceButton.disabled = true;
      return;
    }
    voiceButton.disabled = locked;
    if (locked) {
      voiceLabel.textContent = '本题已作答';
    } else {
      voiceLabel.textContent = listening ? '正在聆听，点按可暂停' : '点按开始聆听';
    }
  }

  // ---------- 设置界面 ----------
  function bindChoice(selector, apply) {
    $$(selector).forEach((button) => {
      button.addEventListener('click', () => {
        apply(button.dataset);
        syncChoiceUI();
        saveSettings();
        updateVoiceNote();
      });
    });
  }

  bindChoice('.mode-card', (d) => { mode = d.mode; });
  bindChoice('.difficulty-card', (d) => { level = d.level; });
  bindChoice('.quantity-option', (d) => { targetCount = Number(d.count); });

  function syncChoiceUI() {
    $$('.mode-card').forEach((b) => {
      const selected = b.dataset.mode === mode;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    $$('.difficulty-card').forEach((b) => {
      const selected = b.dataset.level === level;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
    $$('.quantity-option').forEach((b) => {
      const selected = Number(b.dataset.count) === targetCount;
      b.classList.toggle('selected', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
  }

  function updateVoiceNote() {
    if (mode !== 'voice') {
      voiceNote.hidden = true;
      return;
    }
    voiceNote.hidden = false;
    voiceNote.textContent = recognitionAvailable
      ? '语音作答：开始后会自动聆听，直接说出答案即可。需要允许麦克风权限。'
      : '当前浏览器不支持语音识别。请使用 Chrome 浏览器打开，并允许麦克风权限（需要 HTTPS 或 localhost）。也可以先用打字作答。';
  }

  // ---------- 视图切换 ----------
  function showView(view) {
    setupEl.hidden = view !== 'setup';
    practiceEl.hidden = view !== 'practice';
    resultsEl.hidden = view !== 'results';
    const target = view === 'setup' ? $('#setup-title') : view === 'practice' ? $('#practice-title') : $('#results-title');
    if (target) target.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  function updateModeUI() {
    answerForm.hidden = mode !== 'typing';
    voiceArea.hidden = mode !== 'voice';
    nextButton.hidden = !awaitingNext;
    updateVoiceButton();
  }

  // ---------- 练习流程 ----------
  function startSession(options = {}) {
    reviewMode = Boolean(options.review);
    reviewQueue = reviewMode ? wrongList.slice() : [];
    wrongList = [];
    questionCount = 0;
    answeredCount = 0;
    correctCount = 0;
    streak = 0;
    bestStreak = 0;
    durations = [];
    seen = new Set();
    locked = false;
    awaitingNext = false;
    sessionStart = Date.now();
    pausedTotal = 0;
    pauseStart = 0;
    showView('practice');
    updateModeUI();
    startTimer();
    requestWakeLock();
    nextQuestion();
  }

  function nextQuestion() {
    if (practiceEl.hidden) return;
    if (reviewMode) {
      if (reviewQueue.length === 0) { finishSession(); return; }
    } else if (targetCount > 0 && questionCount >= targetCount) {
      finishSession();
      return;
    }
    locked = false;
    awaitingNext = false;
    nextButton.hidden = true;
    resumeTimer();
    questionCount += 1;

    let q;
    if (reviewMode) {
      const item = reviewQueue.shift();
      q = { html: item.html, text: item.text, answer: item.answer };
    } else {
      q = makeQuestion();
    }
    currentAnswer = q.answer;
    currentHtml = q.html;
    currentText = q.text;
    questionEl.innerHTML = q.html;

    const total = reviewMode ? questionCount + reviewQueue.length : targetCount;
    progressLabel.textContent = total > 0 ? `第 ${questionCount} / ${total} 题` : `第 ${questionCount} 题`;
    progressFill.style.width = total > 0 ? `${Math.round(((questionCount - 1) / total) * 100)}%` : '0%';

    answerInput.value = '';
    voiceButton.disabled = false;
    $('#skip-button').hidden = false;
    heardEl.textContent = '';
    questionStart = Date.now();
    updateModeUI();

    if (mode === 'typing') {
      setFeedback('输入答案后按确认。');
      answerInput.focus({ preventScroll: true });
    } else if (recognitionAvailable) {
      setFeedback('请说出答案。');
      wantListening = true;
      startListening();
    } else {
      setFeedback('当前浏览器不支持语音识别，请改用打字作答。', 'bad');
    }
  }

  function checkAnswer(value) {
    if (locked || practiceEl.hidden) return;
    locked = true;
    updateVoiceButton();
    durations.push((Date.now() - questionStart) / 1000);
    answeredCount += 1;
    if (value === currentAnswer) {
      correctCount += 1;
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);
      setFeedback(streak >= 2 ? `答对了，连续答对 ${streak} 题！` : '答对了。', 'good');
      pauseTimer();
      vibrate(10);
      window.setTimeout(() => { if (!practiceEl.hidden) nextQuestion(); }, 800);
    } else {
      streak = 0;
      wrongList.push({ html: currentHtml, text: currentText, answer: currentAnswer, yours: value });
      setFeedback(`不对，正确答案是 ${currentAnswer}。`, 'bad');
      vibrate(60);
      enterAwaitingNext();
    }
  }

  function skipQuestion() {
    if (locked || practiceEl.hidden) return;
    locked = true;
    updateVoiceButton();
    durations.push((Date.now() - questionStart) / 1000);
    answeredCount += 1;
    streak = 0;
    wrongList.push({ html: currentHtml, text: currentText, answer: currentAnswer, yours: '跳过' });
    setFeedback(`已跳过，正确答案是 ${currentAnswer}。`, 'bad');
    enterAwaitingNext();
  }

  function enterAwaitingNext() {
    awaitingNext = true;
    pauseTimer();
    stopListening();
    voiceButton.disabled = true;
    nextButton.hidden = false;
    $('#skip-button').hidden = true;
    if (mode === 'typing') {
      // 键盘保持打开，再按一次回车即可进入下一题
      answerInput.focus({ preventScroll: true });
    } else {
      nextButton.focus({ preventScroll: true });
    }
  }

  function finishSession() {
    stopListening();
    stopTimer();
    releaseWakeLock();
    if (answeredCount === 0) {
      showView('setup');
      return;
    }
    const accuracy = Math.round((correctCount / answeredCount) * 100);
    const totalSeconds = Math.max(1, elapsedSeconds());
    const avg = durations.length ? durations.reduce((sum, d) => sum + d, 0) / durations.length : 0;

    $('#result-correct').textContent = String(correctCount);
    $('#result-total').textContent = String(answeredCount);
    $('#result-accuracy').textContent = `${accuracy}%`;
    $('#result-time').textContent = formatTime(totalSeconds);
    $('#result-avg').textContent = avg ? `${avg.toFixed(1)} 秒` : '—';
    $('#result-streak').textContent = String(bestStreak);
    $('#result-message').textContent =
      accuracy === 100 ? '全部答对，状态很好。' :
      accuracy >= 80 ? '表现不错，继续保持。' :
      '多练几组，速度和准确率都会上去。';

    // 历史最佳：按难度分别记录，至少答 5 题才计入
    let bestAll = {};
    try { bestAll = JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; } catch (_) { /* 忽略 */ }
    const key = reviewMode ? 'review' : level;
    const prev = bestAll[key];
    let isRecord = false;
    if (answeredCount >= 5) {
      if (!prev || accuracy > prev.accuracy || (accuracy === prev.accuracy && avg > 0 && avg < prev.avg)) {
        isRecord = Boolean(prev);
        bestAll[key] = { accuracy, avg: Math.round(avg * 10) / 10 };
        try { localStorage.setItem(BEST_KEY, JSON.stringify(bestAll)); } catch (_) { /* 忽略 */ }
      }
    }
    const best = bestAll[key] || null;
    const bestLine = $('#best-line');
    if (best) {
      bestLine.hidden = false;
      bestLine.textContent = `${BEST_LABELS[key]}最佳：正确率 ${best.accuracy}% · 平均 ${best.avg} 秒/题${isRecord ? ' · 刷新纪录' : ''}`;
    } else if (answeredCount >= 5) {
      bestLine.hidden = false;
      bestLine.textContent = isRecord ? '刷新本难度纪录。' : '本次已记为最佳成绩。';
    } else {
      bestLine.hidden = true;
    }

    // 错题列表
    const wrongSection = $('#wrong-section');
    const wrongListEl = $('#wrong-list');
    wrongListEl.innerHTML = '';
    if (wrongList.length) {
      wrongSection.hidden = false;
      $('#wrong-title').textContent = `答错的题（${wrongList.length}）`;
      wrongList.forEach((item) => {
        const li = document.createElement('li');
        const q = document.createElement('span');
        q.className = 'wrong-q';
        q.textContent = item.text;
        const a = document.createElement('span');
        a.className = 'wrong-a';
        a.textContent = `你答 ${item.yours} · 正确答案 ${item.answer}`;
        li.append(q, a);
        wrongListEl.appendChild(li);
      });
    } else {
      wrongSection.hidden = true;
    }
    $('#review-button').hidden = wrongList.length === 0;
    showView('results');
  }

  // ---------- 题目生成 ----------
  function makeQuestion() {
    for (let i = 0; i < 25; i += 1) {
      const q = genQuestion();
      if (!seen.has(q.text)) {
        seen.add(q.text);
        return q;
      }
    }
    return genQuestion();
  }

  function genQuestion() {
    for (;;) {
      let a;
      let b;
      if (level === 'two') {
        a = randInt(10, 99);
        b = randInt(10, 99);
      } else if (level === 'mixed') {
        a = randInt(100, 999);
        b = randInt(10, 99);
        if (Math.random() < 0.5) [a, b] = [b, a];
      } else {
        a = randInt(100, 999);
        b = randInt(100, 999);
      }
      const subtract = Math.random() < 0.5;
      if (subtract) {
        if (b > a) [a, b] = [b, a];
        if (a === b) continue;
        const answer = a - b;
        const text = `${a} − ${b}`;
        return { answer, text, html: `${a} <span>−</span> ${b} <span>=</span> ?` };
      }
      const answer = a + b;
      const text = `${a} + ${b}`;
      return { answer, text, html: `${a} <span>+</span> ${b} <span>=</span> ?` };
    }
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  // ---------- 计时 ----------
  function startTimer() {
    stopTimer();
    updateTimer();
    timerId = window.setInterval(updateTimer, 500);
  }

  function stopTimer() {
    if (timerId !== null) {
      window.clearInterval(timerId);
      timerId = null;
    }
  }

  function elapsedSeconds() {
    const paused = pausedTotal + (pauseStart ? Date.now() - pauseStart : 0);
    return Math.max(0, Math.floor((Date.now() - sessionStart - paused) / 1000));
  }

  function updateTimer() {
    timerEl.textContent = formatTime(elapsedSeconds());
  }

  function pauseTimer() {
    if (!pauseStart) pauseStart = Date.now();
    updateTimer();
  }

  function resumeTimer() {
    if (pauseStart) {
      pausedTotal += Date.now() - pauseStart;
      pauseStart = 0;
    }
    updateTimer();
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ---------- 屏幕常亮 / 震动 ----------
  async function requestWakeLock() {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      wakeLock = null;
    }
  }

  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (_) { /* 忽略 */ }
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (practiceEl.hidden) return;
    if (document.hidden) {
      pauseTimer(); // 切走时不计时
      // 先放下麦克风，回来再继续听
      if (recognitionAvailable && listening) {
        try { recognition.stop(); } catch (_) { /* 忽略 */ }
      }
    } else {
      if (!awaitingNext) resumeTimer();
      requestWakeLock();
      if (mode === 'voice' && wantListening && !locked) startListening();
    }
  });

  function vibrate(pattern) {
    try { navigator.vibrate?.(pattern); } catch (_) { /* 不支持则跳过 */ }
  }

  // ---------- 中文数字解析 ----------
  function parseSpokenNumber(text) {
    if (!text) return null;
    let s = text
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[，。、；：？！\s.,]/g, '');
    if (!s) return null;

    // 纯阿拉伯数字
    if (/^-?\d+$/.test(s)) return Number(s);
    // 含阿拉伯数字但无中文数字字，取数字部分
    if (/\d/.test(s) && !/[零一二三四五六七八九十百千两幺〇]/.test(s)) {
      return Number(s.replace(/[^\d]/g, ''));
    }

    const digits = {
      '零': 0, '〇': 0, '一': 1, '幺': 1, '二': 2, '两': 2,
      '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
    };
    const units = { '十': 10, '百': 100, '千': 1000 };
    let negative = false;
    let total = 0;
    let section = 0;
    let run = null; // 当前连续数字段（如逐位读的“一二三”）
    let found = false;

    for (const ch of s) {
      if (ch === '负') {
        negative = true;
      } else if (/[0-9]/.test(ch)) {
        run = run === null ? Number(ch) : run * 10 + Number(ch);
        found = true;
      } else if (has(digits, ch)) {
        run = run === null ? digits[ch] : run * 10 + digits[ch];
        found = true;
      } else if (has(units, ch)) {
        section += (run === null ? 1 : run) * units[ch];
        run = null;
        found = true;
      }
      // 其余字符（如“答案是”）直接跳过
    }
    if (!found) return null;
    const result = total + section + (run === null ? 0 : run);
    return negative ? -result : result;
  }

  function has(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key);
  }

  // ---------- 反馈 ----------
  function setFeedback(message, kind = '') {
    feedbackEl.textContent = message;
    feedbackEl.className = `feedback ${kind}`.trim();
  }

  // ---------- 事件绑定 ----------
  $('#start-button').addEventListener('click', () => startSession());
  $('#again-button').addEventListener('click', () => startSession());
  $('#review-button').addEventListener('click', () => startSession({ review: true }));
  $('#settings-button').addEventListener('click', () => showView('setup'));
  $('#quit-button').addEventListener('click', finishSession);
  nextButton.addEventListener('click', nextQuestion);
  $('#skip-button').addEventListener('click', skipQuestion);

  answerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (awaitingNext) {
      nextQuestion();
      return;
    }
    if (locked) return; // 上一题还在判分，忽略这次提交
    const raw = answerInput.value
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\s,，]/g, '');
    if (!raw) {
      setFeedback('先输入答案。', 'bad');
      return;
    }
    if (!/^-?\d+$/.test(raw)) {
      setFeedback('请输入数字。', 'bad');
      return;
    }
    checkAnswer(Number(raw));
  });

  voiceButton.addEventListener('click', () => {
    if (locked || practiceEl.hidden) return;
    if (!recognitionAvailable) {
      setFeedback('当前浏览器不支持语音识别，请改用打字作答。', 'bad');
      return;
    }
    if (listening) {
      stopListening();
    } else {
      wantListening = true;
      startListening();
    }
  });

  $('#voice-fallback').addEventListener('click', () => {
    stopListening();
    mode = 'typing';
    saveSettings();
    syncChoiceUI();
    updateModeUI();
    setFeedback('已切换为打字作答。');
    answerInput.focus({ preventScroll: true });
  });

  // ---------- 初始化 ----------
  syncChoiceUI();
  updateVoiceNote();
  updateModeUI();
})();
