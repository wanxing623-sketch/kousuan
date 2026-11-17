(() => {
  'use strict';

  const STORE_KEY = 'kousuan:v1';
  const MINUS = '−';

  const el = (id) => document.getElementById(id);

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supportsSpeech = Boolean(Recognition);
  const inFrame = window.self !== window.top;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const LEVEL_LABELS = { two: '两位 ± 两位', mixed: '两位 ± 三位', three: '三位 ± 三位' };
  const defaults = { mode: 'type', level: 'two', count: 10 };
  let prefs = { ...defaults };
  let best = {};

  let view = 'setup';
  let session = null;
  let locked = false;
  let buffer = '';
  let advanceTimer = 0;

  /* ------------------------------------------------------------------ *
   * stored settings
   * ------------------------------------------------------------------ */

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.prefs) prefs = { ...defaults, ...data.prefs };
      if (data && data.best) best = data.best;
    }
  } catch (_) {
    /* private mode or corrupted data: fall back to defaults */
  }
  if (!['type', 'voice'].includes(prefs.mode)) prefs.mode = defaults.mode;
  if (!['two', 'mixed', 'three'].includes(prefs.level)) prefs.level = defaults.level;
  if (![0, 10, 20, 30].includes(prefs.count)) prefs.count = defaults.count;
  if (!supportsSpeech) prefs.mode = 'type';

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ prefs, best }));
    } catch (_) {
      /* storage is optional */
    }
  }

  /* ------------------------------------------------------------------ *
   * setup screen
   * ------------------------------------------------------------------ */

  function syncSetup() {
    document.querySelectorAll('[data-mode]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.mode === prefs.mode));
    });
    document.querySelectorAll('[data-level]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.level === prefs.level));
    });
    document.querySelectorAll('[data-count]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.count) === prefs.count));
    });
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      prefs.mode = button.dataset.mode;
      syncSetup();
      persist();
    });
  });

  document.querySelectorAll('[data-level]').forEach((button) => {
    button.addEventListener('click', () => {
      prefs.level = button.dataset.level;
      syncSetup();
      persist();
    });
  });

  document.querySelectorAll('[data-count]').forEach((button) => {
    button.addEventListener('click', () => {
      prefs.count = Number(button.dataset.count);
      syncSetup();
      persist();
    });
  });

  if (!supportsSpeech) {
    const voiceButton = document.querySelector('[data-mode="voice"]');
    if (voiceButton) {
      voiceButton.disabled = true;
      voiceButton.setAttribute('aria-describedby', 'voice-note');
      voiceButton.querySelector('.mode-desc').textContent = '此浏览器不支持';
    }
    el('voice-note').hidden = false;
  }

  el('setup-form').addEventListener('submit', (event) => {
    event.preventDefault();
    startSession();
  });

  /* ------------------------------------------------------------------ *
   * question generation
   * ------------------------------------------------------------------ */

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function buildQuestion() {
    const twoDigit = () => randomInt(10, 99);
    const threeDigit = () => randomInt(100, 999);
    let a;
    let b;

    if (prefs.level === 'three') {
      a = threeDigit();
      b = threeDigit();
    } else if (prefs.level === 'mixed') {
      if (Math.random() < 0.5) {
        a = threeDigit();
        b = twoDigit();
      } else {
        a = twoDigit();
        b = threeDigit();
      }
    } else {
      a = twoDigit();
      b = twoDigit();
    }

    const op = Math.random() < 0.5 ? '+' : MINUS;
    if (op === MINUS) {
      if (b > a) [a, b] = [b, a];
      if (a === b) return buildQuestion();
    }

    const answer = op === '+' ? a + b : a - b;
    return { a, b, op, answer };
  }

  function nextQuestionData() {
    const seen = session.seen;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const question = buildQuestion();
      const key = `${question.a}${question.op}${question.b}`;
      if (!seen.has(key)) {
        seen.add(key);
        return question;
      }
    }
    return buildQuestion();
  }

  /* ------------------------------------------------------------------ *
   * session flow
   * ------------------------------------------------------------------ */

  function startSession() {
    clearTimeout(advanceTimer);
    buffer = '';
    locked = false;
    session = {
      index: 0,
      answered: 0,
      correct: 0,
      mistakes: [],
      seen: new Set(),
      current: null,
      questionStartedAt: 0,
      startedAt: performance.now(),
    };

    showView('practice');
    el('practice').dataset.mode = prefs.mode;
    applyModeLayout();
    resetAnswerLine();
    nextQuestion();

    if (prefs.mode === 'voice' && supportsSpeech) {
      startVoice();
    } else {
      if (prefs.mode === 'voice') switchToTyping();
      if (finePointer) el('keyboard-hint').hidden = false;
    }
  }

  function applyModeLayout() {
    const isVoice = prefs.mode === 'voice';
    el('keypad').hidden = isVoice;
    el('voice-ui').hidden = !isVoice;
    el('keyboard-hint').hidden = isVoice || !finePointer;
    el('practice').dataset.mode = prefs.mode;
  }

  function nextQuestion() {
    if (!session) return;
    if (prefs.count > 0 && session.index >= prefs.count) {
      finishSession();
      return;
    }

    locked = false;
    buffer = '';
    session.index += 1;
    session.current = nextQuestionData();
    session.questionStartedAt = performance.now();

    resetAnswerLine();
    renderQuestion();
    setStatus('');
    updateMeta();

    if (prefs.mode === 'voice') resumeVoice();
  }

  function renderQuestion() {
    const question = session.current;
    el('eq-left').textContent = String(question.a);
    el('eq-op').textContent = question.op;
    el('eq-op').classList.toggle('is-minus', question.op === MINUS);
    el('eq-right').textContent = String(question.b);
  }

  function resetAnswerLine() {
    const slot = el('eq-answer');
    slot.dataset.state = 'empty';
    el('answer-text').textContent = '';
  }

  function updateMeta() {
    const total = prefs.count;
    el('q-index').textContent = String(session.index);
    el('q-total').textContent = total > 0 ? `/ ${total}` : '';
    el('score-label').textContent = String(session.correct);
    el('progress').hidden = total === 0;
    if (total > 0) {
      const done = Math.min(session.answered, total);
      el('progress').setAttribute('aria-valuemax', String(total));
      el('progress').setAttribute('aria-valuenow', String(done));
      el('progress-fill').style.width = `${(done / total) * 100}%`;
    }
  }

  function submit(value) {
    if (locked || view !== 'practice' || !session) return false;
    if (!Number.isFinite(value) || value < 0) {
      nudge('先输入答案');
      return false;
    }

    const question = session.current;
    const correct = value === question.answer;

    locked = true;
    session.answered += 1;
    if (correct) {
      session.correct += 1;
    } else {
      session.mistakes.push({ ...question, given: value });
    }

    if (prefs.mode === 'voice') pauseVoice();

    const slot = el('eq-answer');
    el('answer-text').textContent = prefs.mode === 'voice' ? String(value) : (buffer || String(value));
    slot.dataset.state = correct ? 'ok' : 'bad';

    if (correct) {
      setStatus('答对了', 'ok');
    } else {
      setStatus(`正确答案是 ${question.answer}`, 'bad');
    }

    updateMeta();
    advanceTimer = setTimeout(nextQuestion, correct ? 620 : 1800);
    return true;
  }

  function advanceNow() {
    if (!locked) return;
    clearTimeout(advanceTimer);
    nextQuestion();
  }

  function nudge(message) {
    setStatus(message || '先输入答案', 'bad');
    const stage = el('stage');
    stage.classList.remove('shake');
    void stage.offsetWidth;
    stage.classList.add('shake');
  }

  function setStatus(text, kind = '') {
    const node = el('status');
    node.textContent = text;
    node.className = `status ${kind}`.trim();
  }

  function finishSession() {
    clearTimeout(advanceTimer);
    stopVoice();
    if (!session) {
      showView('setup');
      return;
    }

    if (session.answered === 0) {
      session = null;
      showView('setup');
      return;
    }

    const accuracy = Math.round((session.correct / session.answered) * 100);
    const seconds = Math.max(1, Math.round((performance.now() - session.startedAt) / 1000));
    const previous = best[prefs.level];
    const isRecord = !previous || accuracy > previous.accuracy;

    if (isRecord) {
      best[prefs.level] = { accuracy, seconds };
      persist();
    }

    el('r-correct').textContent = String(session.correct);
    el('r-total').textContent = String(session.answered);
    el('r-accuracy').textContent = `${accuracy}%`;
    el('r-time').textContent = formatDuration(seconds);
    el('r-avg').textContent = `${(seconds / session.answered).toFixed(1)} 秒`;

    el('result-kicker').textContent = `${LEVEL_LABELS[prefs.level] || ''} · ${accuracy === 100 ? '全部正确' : '本组结束'}`;
    el('result-note').textContent = isRecord
      ? (previous ? `刷新最好成绩，之前是 ${previous.accuracy}%。` : '已记录最好成绩。')
      : `最好成绩 ${previous.accuracy}%。`;

    const list = el('mistakes');
    list.innerHTML = '';
    if (session.mistakes.length) {
      session.mistakes.forEach((item) => {
        const li = document.createElement('li');
        const equation = document.createElement('span');
        equation.textContent = `${item.a} ${item.op} ${item.b} = ${item.answer}`;
        const mine = document.createElement('span');
        mine.className = 'mine';
        mine.textContent = `你答 ${item.given}`;
        li.append(equation, mine);
        list.append(li);
      });
      list.hidden = false;
    } else {
      list.hidden = true;
    }

    session = null;
    showView('results');
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds} 秒`;
    return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
  }

  function showView(next) {
    view = next;
    document.body.dataset.view = next;
    el('setup').hidden = next !== 'setup';
    el('practice').hidden = next !== 'practice';
    el('results').hidden = next !== 'results';
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ *
   * typing input
   * ------------------------------------------------------------------ */

  el('keypad').addEventListener('click', (event) => {
    const key = event.target.closest('[data-key]');
    if (!key) return;
    pressKey(key.dataset.key);
  });

  function pressKey(key) {
    if (view !== 'practice') return;
    if (key === 'enter') {
      if (locked) advanceNow();
      else submitTyped();
      return;
    }
    if (locked) {
      if (key === 'back') return;
      advanceNow();
      return;
    }
    if (key === 'back') {
      buffer = buffer.slice(0, -1);
    } else if (buffer.length < 5) {
      buffer += key;
    }
    renderBuffer();
  }

  function renderBuffer() {
    el('answer-text').textContent = buffer;
    el('eq-answer').dataset.state = buffer ? 'filled' : 'empty';
  }

  function submitTyped() {
    if (!buffer) {
      nudge('先输入答案');
      return;
    }
    submit(Number(buffer));
  }

  document.addEventListener('keydown', (event) => {
    if (view !== 'practice') return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      if (prefs.mode === 'voice') switchToTyping();
      pressKey(event.key);
      return;
    }

    if (event.key === 'Backspace') {
      event.preventDefault();
      pressKey('back');
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      if (locked) advanceNow();
      else if (prefs.mode === 'voice') {
        /* nothing to confirm: voice answers are spoken */
      } else {
        submitTyped();
      }
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      finishSession();
    }
  });

  el('stage').addEventListener('click', () => {
    if (locked) advanceNow();
  });

  el('quit-button').addEventListener('click', finishSession);
  el('again-button').addEventListener('click', startSession);
  el('settings-button').addEventListener('click', () => {
    syncSetup();
    showView('setup');
  });

  /* ------------------------------------------------------------------ *
   * voice input
   * ------------------------------------------------------------------ */

  let recognition = null;
  let wantListen = false;
  let isListening = false;
  let paused = false;
  let restartTimer = 0;
  let micProblem = null;

  const CN_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '壹': 1, '幺': 1, '二': 2, '贰': 2, '两': 2, '俩': 2,
    '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6,
    '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9,
  };
  const CN_UNITS = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };

  const DIGIT_CHARS = Object.keys(CN_DIGITS).join('');
  const UNIT_CHARS = Object.keys(CN_UNITS).join('');
  const SPOKEN_RUN = new RegExp(
    `[${DIGIT_CHARS}]+[${UNIT_CHARS}][${DIGIT_CHARS}${UNIT_CHARS}]*`
    + `|[${UNIT_CHARS}][${DIGIT_CHARS}${UNIT_CHARS}]*`
    + `|[${DIGIT_CHARS}]+`,
    'g'
  );

  function normalizeSpeech(text) {
    return String(text || '')
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[，,。.、！!？?：:；;“”"'‘’（）()《》\s]/g, '')
      .replace(/[负]/g, '-');
  }

  function evaluateChineseNumber(run) {
    if (!run) return null;
    const hasUnit = /[十拾百佰千仟]/.test(run);
    if (!hasUnit) {
      if (run.length === 1) {
        const digit = CN_DIGITS[run];
        return digit === undefined ? null : digit;
      }
      /* spoken digit by digit: 八三 -> 83 */
      let value = 0;
      for (const ch of run) {
        const digit = CN_DIGITS[ch];
        if (digit === undefined) return null;
        value = value * 10 + digit;
      }
      return value;
    }

    let total = 0;
    let current = null;
    for (const ch of run) {
      const digit = CN_DIGITS[ch];
      if (digit !== undefined) {
        current = digit;
        continue;
      }
      const unit = CN_UNITS[ch];
      if (!unit) return null;
      if (current === null) current = 1; /* 十二 -> 12, 百二十三 -> 123 */
      total += current * unit;
      current = 0;
    }
    return total + (current || 0);
  }

  function parseSpokenNumber(text) {
    const normalized = normalizeSpeech(text);
    if (!normalized) return null;

    const arabic = normalized.match(/\d+/g);
    if (arabic) {
      const longest = arabic.reduce((a, b) => (b.length > a.length ? b : a));
      return Number(longest);
    }

    const runs = normalized.match(SPOKEN_RUN);
    if (!runs) return null;

    runs.sort((a, b) => {
      const unitA = /[十拾百佰千仟]/.test(a) ? 1 : 0;
      const unitB = /[十拾百佰千仟]/.test(b) ? 1 : 0;
      if (unitA !== unitB) return unitB - unitA;
      return b.length - a.length;
    });

    for (const run of runs) {
      const value = evaluateChineseNumber(run);
      if (value !== null) return value;
    }
    return null;
  }

  function createRecognition() {
    const instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 5;

    instance.onstart = () => {
      isListening = true;
      setOrb('listening');
      if (!locked) setVoiceState('正在听，请说出答案');
    };

    instance.onresult = (event) => {
      if (locked) return;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0].transcript || '').trim();
        if (!text) continue;
        el('heard').textContent = text;

        if (!result.isFinal) continue;
        const value = pickSpokenNumber(result);
        if (value === null) {
          setStatus('没听清，再说一次', 'bad');
          continue;
        }
        setStatus('');
        submit(value);
        break;
      }
    };

    instance.onerror = (event) => {
      const code = event && event.error;
      if (code === 'no-speech') {
        setStatus('没听到声音，再说一次', 'bad');
        return;
      }
      if (code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        failVoice('blocked', '麦克风没有打开。允许权限后重试，或改用键盘。');
        return;
      }
      if (code === 'audio-capture') {
        failVoice('blocked', '没有找到可用的麦克风。');
        return;
      }
      if (code === 'network') {
        failVoice('blocked', inFrame ? '预览窗口里语音服务连不上，可以点“在新窗口打开”再试。' : '语音服务暂时连不上，请稍后再试。');
        return;
      }
      failVoice('blocked', '语音识别出了点问题，可以重试或改用键盘。');
    };

    instance.onend = () => {
      isListening = false;
      if (wantListen && !paused && view === 'practice') {
        scheduleRestart(200);
      } else if (!micProblem) {
        setOrb(locked && wantListen ? 'thinking' : (wantListen ? 'paused' : 'idle'));
      }
    };

    return instance;
  }

  function pickSpokenNumber(result) {
    for (let i = 0; i < result.length; i += 1) {
      const value = parseSpokenNumber(result[i].transcript);
      if (value !== null) return value;
    }
    return null;
  }

  function startVoice() {
    if (!Recognition) return;
    wantListen = true;
    paused = false;
    micProblem = null;
    el('heard').textContent = '';
    el('voice-actions').hidden = true;
    el('new-tab').hidden = !inFrame;
    setVoiceState('正在打开麦克风…');
    listen();
  }

  function listen() {
    if (!wantListen || paused || locked || view !== 'practice') return;
    if (!recognition) recognition = createRecognition();
    clearTimeout(restartTimer);
    try {
      recognition.start();
    } catch (error) {
      /* start() throws while the previous run is still shutting down */
      if (error && error.name === 'InvalidStateError') {
        scheduleRestart(320);
        return;
      }
      failVoice('blocked', '麦克风没有打开。允许权限后重试，或改用键盘。');
    }
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (wantListen && !paused && !locked && view === 'practice') listen();
    }, delay);
  }

  function pauseVoice() {
    paused = true;
    clearTimeout(restartTimer);
    if (recognition && isListening) {
      try {
        recognition.stop();
      } catch (_) {
        /* already stopped */
      }
    }
    setOrb(wantListen ? 'thinking' : 'idle');
  }

  function resumeVoice() {
    if (!Recognition || !wantListen || micProblem) return;
    paused = false;
    el('heard').textContent = '';
    listen();
  }

  function stopVoice() {
    wantListen = false;
    paused = true;
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* nothing to stop */
      }
    }
    isListening = false;
    setOrb('idle');
  }

  function failVoice(kind, message) {
    wantListen = false;
    paused = true;
    micProblem = kind;
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* already stopped */
      }
    }
    isListening = false;
    setOrb('blocked');
    setVoiceState(message);
    el('voice-actions').hidden = false;
    el('new-tab').hidden = !inFrame;
  }

  function setOrb(state) {
    const orb = el('mic-toggle');
    orb.classList.toggle('is-listening', state === 'listening');
    orb.classList.toggle('is-thinking', state === 'thinking');
    orb.classList.toggle('is-paused', state === 'paused');
    orb.classList.toggle('is-blocked', state === 'blocked');
    orb.setAttribute('aria-pressed', String(state === 'listening'));
    orb.setAttribute('aria-label', wantListen ? '暂停收音' : '继续收音');
  }

  function setVoiceState(text) {
    el('voice-state').textContent = text;
  }

  el('mic-toggle').addEventListener('click', () => {
    if (view !== 'practice' || prefs.mode !== 'voice' || locked) return;
    if (micProblem) {
      micProblem = null;
      wantListen = true;
      paused = false;
      el('voice-actions').hidden = true;
      setVoiceState('正在打开麦克风…');
      listen();
      return;
    }
    if (wantListen) {
      wantListen = false;
      pauseVoice();
      setOrb('paused');
      setVoiceState('已暂停收音，点麦克风继续');
      el('heard').textContent = '';
    } else {
      startVoice();
    }
  });

  el('mic-retry').addEventListener('click', () => {
    micProblem = null;
    wantListen = true;
    paused = false;
    el('voice-actions').hidden = true;
    setVoiceState('正在打开麦克风…');
    listen();
  });

  el('new-tab').addEventListener('click', () => {
    const win = window.open(location.href, '_blank', 'noopener');
    if (!win) setVoiceState('浏览器拦住了新窗口，请手动在新标签页打开本页。');
  });

  el('switch-mode').addEventListener('click', switchToTyping);

  function switchToTyping() {
    if (prefs.mode !== 'voice') return;
    prefs.mode = 'type';
    persist();
    syncSetup();
    stopVoice();
    applyModeLayout();
    el('voice-actions').hidden = true;
    setStatus('已切换为键盘作答');
    if (!locked) {
      el('eq-answer').dataset.state = buffer ? 'filled' : 'empty';
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (isListening) {
        paused = true;
        try {
          recognition.stop();
        } catch (_) {
          /* already stopped */
        }
      }
    } else if (view === 'practice' && prefs.mode === 'voice' && wantListen && !locked && !micProblem) {
      paused = false;
      listen();
    }
  });

  window.addEventListener('beforeunload', () => {
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* nothing to do */
      }
    }
  });

  /* ------------------------------------------------------------------ */

  syncSetup();
})();
