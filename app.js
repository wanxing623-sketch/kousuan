(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const setupEl = $('#setup');
  const practiceEl = $('#practice');
  const resultsEl = $('#results');
  const dock = $('#dock');
  const startBtn = $('#start-button');
  const dockTyping = $('#dock-typing');
  const answerInput = $('#answer');
  const submitBtn = $('#submit-button');
  const micBtn = $('#mic-button');
  const micLabel = $('#mic-label');
  const againBtn = $('#again-button');
  const backBtn = $('#settings-button');
  const questionEl = $('#question');
  const feedbackEl = $('#feedback');
  const heardEl = $('#heard');
  const progressLabel = $('#progress-label');
  const progressBar = $('#progress-bar');
  const timerLabel = $('#timer-label');
  const voiceNote = $('#voice-note');
  const voiceLoading = $('#voice-loading');
  const voiceLoadingText = $('#voice-loading-text');
  const voiceLoadingBar = $('#voice-loading .loading-bar span');
  const skipBtn = $('#skip-button');
  const quitBtn = $('#quit-button');
  const switchTypingBtn = $('#switch-typing');

  const SETTINGS_KEY = 'kousuan.settings.v2';
  const MODEL_URL = 'model/vosk-model-small-cn-0.22.tar.gz';

  // ---------- 设置 ----------
  const defaults = { mode: 'typing', level: 'two', count: 10 };
  let settings = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (saved && typeof saved === 'object') settings = { ...defaults, ...saved };
  } catch (_) { /* 存档损坏就用默认值 */ }
  let mode = settings.mode === 'voice' ? 'voice' : 'typing';
  let level = ['two', 'mixed', 'three'].includes(settings.level) ? settings.level : 'two';
  let count = [0, 10, 20, 30].includes(settings.count) ? settings.count : 10;

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode, level, count }));
    } catch (_) { /* 隐私模式下存不了，忽略 */ }
  }

  // ---------- 练习状态 ----------
  let total = 0;
  let index = 0;
  let answered = 0;
  let answer = 0;
  let questionText = '';
  let correct = 0;
  let wrong = [];
  let locked = true;
  let seen = new Set();
  let startedAt = 0;
  let questionAt = 0;
  let pausedMs = 0;
  let pauseAt = 0;
  let ticker = 0;
  let advancing = 0;

  // ---------- 语音（本地 Vosk） ----------
  const voiceSupported = typeof window.Vosk !== 'undefined' && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && Boolean(window.AudioContext || window.webkitAudioContext);
  let model = null;
  let modelLoading = null;
  let recognizer = null;
  let micStream = null;
  let audioCtx = null;
  let drain = null;
  let processor = null;
  let listening = false;
  let wantListen = false;
  let partialSeen = '';
  let silenceCounter = 0;
  let finishTimer = 0;
  let lastSpoken = 0;
  let retries = 0;

  // ---------- 视图 ----------
  function showView(name) {
    setupEl.hidden = name !== 'setup';
    practiceEl.hidden = name !== 'practice';
    resultsEl.hidden = name !== 'results';
    dock.hidden = false;
    startBtn.hidden = name !== 'setup';
    againBtn.hidden = name !== 'results';
    backBtn.hidden = name !== 'results';
    dockTyping.hidden = true;
    micBtn.hidden = true;
    window.scrollTo({ top: 0 });
  }

  function showTypingDock() {
    dockTyping.hidden = false;
    micBtn.hidden = true;
    switchTypingBtn.hidden = true;
    submitBtn.disabled = locked;
    answerInput.disabled = locked;
    if (!locked) answerInput.focus({ preventScroll: true });
  }

  function showMicDock() {
    dockTyping.hidden = true;
    micBtn.hidden = false;
    switchTypingBtn.hidden = false;
    micBtn.disabled = locked || !model;
    if (!model) micLabel.textContent = '正在准备语音…';
    else if (!listening && !locked) micLabel.textContent = '点一下开始说话';
    micBtn.classList.toggle('is-listening', listening);
  }

  function setFeedback(text, kind = '') {
    feedbackEl.textContent = text;
    feedbackEl.className = `feedback ${kind}`.trim();
  }

  // ---------- 设置交互 ----------
  function bindGroup(selector, apply) {
    document.querySelectorAll(selector).forEach((btn) => {
      btn.addEventListener('click', () => {
        apply(btn.dataset);
        syncSetup();
        saveSettings();
        updateVoiceNote();
      });
    });
  }

  function syncSetup() {
    document.querySelectorAll('.mode-card').forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('.list-row').forEach((b) => {
      const on = b.dataset.level === level;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
    document.querySelectorAll('.segment').forEach((b) => {
      const on = Number(b.dataset.count) === count;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function updateVoiceNote() {
    if (mode !== 'voice') {
      voiceNote.hidden = true;
      return;
    }
    voiceNote.hidden = false;
    voiceNote.textContent = voiceSupported
      ? '语音在本机离线识别，不联网、不上传。首次使用需下载约 42MB 模型。'
      : '这个浏览器不支持本地语音识别，请改用打字作答，或换 Chrome / Safari 打开。';
  }

  bindGroup('.mode-card', (d) => { mode = d.mode; });
  bindGroup('.list-row', (d) => { level = d.level; });
  bindGroup('.segment', (d) => { count = Number(d.count); });

  // ---------- 题目 ----------
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function makeQuestion() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      let a;
      let b;
      if (level === 'two') {
        a = randInt(11, 99);
        b = randInt(11, 99);
      } else if (level === 'mixed') {
        a = randInt(101, 999);
        b = randInt(11, 99);
        if (Math.random() < 0.5) [a, b] = [b, a];
      } else {
        a = randInt(101, 999);
        b = randInt(101, 999);
      }
      const minus = Math.random() < 0.5;
      if (minus) {
        if (a === b) continue;
        if (b > a) [a, b] = [b, a];
      } else if (a + b > 1998) {
        continue;
      }
      const text = `${a} ${minus ? '−' : '+'} ${b}`;
      if (seen.has(text)) continue;
      seen.add(text);
      return { text, value: minus ? a - b : a + b };
    }
    // 极端情况（题池被用尽）退回一对不重复的组合
    const a = randInt(101, 999);
    const b = randInt(101, 998);
    const big = Math.max(a, b + 1);
    const small = Math.min(a, b + 1);
    return { text: `${big} − ${small}`, value: big - small };
  }

  // ---------- 计时 ----------
  function elapsed() {
    const paused = pausedMs + (pauseAt ? Date.now() - pauseAt : 0);
    return Math.max(0, Math.floor((Date.now() - startedAt - paused) / 1000));
  }

  function fmt(seconds) {
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function paintTimer() {
    timerLabel.textContent = fmt(elapsed());
  }

  function pauseTimer() {
    if (!pauseAt) pauseAt = Date.now();
    paintTimer();
  }

  function resumeTimer() {
    if (mode === 'voice' && !voiceLoading.hidden) { paintTimer(); return; }
    if (pauseAt) {
      pausedMs += Date.now() - pauseAt;
      pauseAt = 0;
    }
    paintTimer();
  }

  // ---------- 开始一组 ----------
  function startSession() {
    total = count > 0 ? count : 0;
    index = 0;
    answered = 0;
    correct = 0;
    wrong = [];
    seen = new Set();
    locked = true;
    startedAt = Date.now();
    pausedMs = 0;
    pauseAt = 0;
    window.clearInterval(ticker);
    ticker = window.setInterval(paintTimer, 500);
    paintTimer();
    showView('practice');
    nextQuestion();
    if (mode === 'voice') {
      if (!voiceSupported) {
        mode = 'typing';
        syncSetup();
        saveSettings();
      } else {
        prepareVoice();
      }
    }
  }

  function nextQuestion() {
    window.clearTimeout(advancing);
    stopListening();
    if (mode === 'voice') freshRecognizer();
    if (total > 0 && answered >= total) {
      finish();
      return;
    }
    index += 1;
    const q = makeQuestion();
    answer = q.value;
    questionText = q.text;
    questionEl.textContent = `${q.text} = ?`;
    setFeedback('');
    heardEl.textContent = '';
    progressLabel.textContent = total > 0 ? `第 ${index} / ${total} 题` : `第 ${index} 题`;
    progressBar.style.width = total > 0 ? `${Math.round(((index - 1) / total) * 100)}%` : '0%';
    answerInput.value = '';
    locked = false;
    retries = 0;
    resumeTimer();
    questionAt = Date.now();
    if (mode === 'typing') {
      showTypingDock();
    } else {
      showMicDock();
      voiceReady().then(() => {
        if (!locked && mode === 'voice') startListening();
      });
    }
  }

  function grade(value) {
    if (locked) return;
    locked = true;
    answered += 1;
    const spent = Math.max(0.2, (Date.now() - questionAt) / 1000);
    if (value === answer) {
      correct += 1;
      setFeedback(`答对了 · ${spent.toFixed(1)} 秒`, 'good');
      pauseTimer();
      if (mode === 'typing') {
        submitBtn.disabled = true;
        answerInput.disabled = true;
      }
      advancing = window.setTimeout(nextQuestion, 700);
    } else {
      wrong.push({ text: questionText, answer, given: value });
      setFeedback(`答案是 ${answer}，下一题继续`, 'bad');
      pauseTimer();
      if (mode === 'typing') {
        submitBtn.disabled = true;
        answerInput.disabled = true;
      } else {
        stopListening();
        micBtn.disabled = true;
      }
      advancing = window.setTimeout(nextQuestion, 1600);
    }
  }

  function finish() {
    window.clearInterval(ticker);
    releaseMic();
    const seconds = Math.max(1, elapsed());
    const accuracy = Math.round((correct / Math.max(1, answered)) * 100);
    $('#stat-accuracy').textContent = `${accuracy}%`;
    $('#stat-time').textContent = fmt(seconds);
    const done = Math.max(1, answered);
    const parts = [`答对 ${correct} / ${done} 题`];
    parts.push(`平均 ${(seconds / done).toFixed(1)} 秒/题`);
    if (wrong.length) parts.push(`错题：${wrong.slice(0, 3).map((w) => `${w.text} = ${w.answer}`).join('，')}${wrong.length > 3 ? ' 等' : ''}`);
    $('#result-sub').textContent = parts.join(' · ');
    locked = true;
    showView('results');
  }

  // ---------- 语音：加载模型 ----------
  function setLoadingVisible(visible) {
    voiceLoading.hidden = !visible;
    practiceEl.classList.toggle('is-loading', visible);
  }

  function setLoading(percent, text) {
    setLoadingVisible(true);
    voiceLoadingText.textContent = text;
    voiceLoadingBar.style.width = `${percent}%`;
  }

  const MODEL_CACHE = 'kousuan-voice-v1';

  function cachedModel() {
    if (!window.caches) return Promise.resolve(null);
    return caches.open(MODEL_CACHE)
      .then((cache) => cache.match(MODEL_URL))
      .then((hit) => (hit ? hit.arrayBuffer() : null))
      .catch(() => null);
  }

  function storeModel(buffer) {
    if (!window.caches) return;
    caches.open(MODEL_CACHE)
      .then((cache) => cache.put(MODEL_URL, new Response(buffer, {
        headers: { 'content-type': 'application/gzip', 'content-length': String(buffer.byteLength) },
      })))
      .catch(() => { /* 空间不足就下次再下 */ });
  }

  function fetchModel(url, onProgress) {
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(`模型下载失败（${res.status}）`);
      const length = Number(res.headers.get('content-length')) || 43899961;
      if (!res.body || !res.body.getReader) return res.arrayBuffer();
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          const out = new Uint8Array(received);
          let offset = 0;
          chunks.forEach((c) => { out.set(c, offset); offset += c.length; });
          return out.buffer;
        }
        chunks.push(value);
        received += value.length;
        onProgress(Math.min(0.99, received / length));
        return pump();
      });
      return pump();
    });
  }

  function voiceReady() {
    if (model) return Promise.resolve(model);
    if (modelLoading) return modelLoading;
    modelLoading = cachedModel()
      .then((cached) => {
        if (cached) {
          setLoading(100, '正在载入模型…');
          return cached;
        }
        return fetchModel(MODEL_URL, (ratio) => {
          setLoading(Math.round(ratio * 100), `正在下载语音模型 ${Math.round(ratio * 100)}%`);
        }).then((buffer) => {
          storeModel(buffer.slice(0));
          return buffer;
        });
      })
      .then((buffer) => {
        const blobUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/gzip' }));
        setLoading(100, '正在载入模型…');
        return window.Vosk.createModel(blobUrl);
      })
      .then((loaded) => {
        model = loaded;
        setLoading(100, '语音已就绪');
        setLoadingVisible(false);
        if (pauseAt && answered === 0) resumeTimer();
        if (!locked && mode === 'voice') {
          micBtn.disabled = false;
          micLabel.textContent = '点一下开始说话';
        }
        return model;
      })
      .catch((err) => {
        modelLoading = null;
        setLoadingVisible(false);
        micBtn.classList.add('is-error');
        micLabel.textContent = '语音初始化失败，可改用打字';
        setFeedback(err && err.message ? err.message : '语音初始化失败', 'bad');
        throw err;
      });
    return modelLoading;
  }

  function prepareVoice() {
    if (!voiceSupported) return;
    setLoading(1, '正在准备语音…');
    if (answered === 0) pauseTimer();
    micBtn.disabled = true;
    micLabel.textContent = '正在准备语音…';
    voiceReady().catch(() => {
      micBtn.disabled = false;
      if (mode === 'voice') micLabel.textContent = '语音没能启动，可改用打字';
    });
  }

  // ---------- 语音：录音与识别 ----------
  function freshRecognizer() {
    if (!model) return null;
    if (recognizer) {
      try { recognizer.remove(); } catch (_) { /* 已释放 */ }
      recognizer = null;
    }
    try {
      recognizer = new model.KaldiRecognizer(16000);
      recognizer.on('result', onSpeechResult);
      recognizer.on('partialresult', onSpeechPartial);
      return recognizer;
    } catch (_) {
      recognizer = null;
      return null;
    }
  }

  // 整组练习只申请一次麦克风，换题只重建识别器，不用反复授权、也更快
  function ensureMic() {
    if (micStream && audioCtx && audioCtx.state !== 'closed') return Promise.resolve();
    if (!audioCtx) unlockAudio();
    if (!audioCtx) return Promise.reject(new Error('no audio context'));
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }).then((stream) => {
      micStream = stream;
      const source = audioCtx.createMediaStreamSource(stream);
      processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!listening || locked || !recognizer) return;
        try {
          recognizer.acceptWaveformFloat(event.inputBuffer.getChannelData(0), audioCtx.sampleRate);
        } catch (_) { /* 单帧失败不影响后续 */ }
      };
      source.connect(processor);
      // 接到 0 增益节点：只驱动音频时钟，不把麦克风回放成喇叭声
      drain = audioCtx.createGain();
      drain.gain.value = 0;
      processor.connect(drain);
      drain.connect(audioCtx.destination);
      return audioCtx.state === 'suspended' ? audioCtx.resume() : undefined;
    });
  }

  function startListening() {
    if (!model || locked || listening) return;
    wantListen = true;
    if (!freshRecognizer()) return;
    partialSeen = '';
    silenceCounter = 0;
    retries = 0;
    lastSpoken = 0;
    micBtn.disabled = locked;
    ensureMic().then(() => {
      if (!wantListen || locked) return;
      listening = true;
      micBtn.classList.add('is-listening');
      micBtn.classList.remove('is-error');
      micLabel.textContent = '正在聆听，请说答案';
      window.clearInterval(finishTimer);
      finishTimer = window.setInterval(checkQuiet, 350);
    }).catch((err) => {
      wantListen = false;
      micBtn.classList.add('is-error');
      micLabel.textContent = err && err.name === 'NotAllowedError' ? '麦克风权限被拒绝' : '打不开麦克风，可改用打字';
      setFeedback(err && err.name === 'NotAllowedError' ? '请允许使用麦克风后再试' : '打不开麦克风', 'bad');
    });
  }

  function checkQuiet() {
    if (!listening || locked) return;
    // 说话停下来后主动收尾，让识别尽快出结果
    if (lastSpoken && Date.now() - lastSpoken > 900) {
      lastSpoken = 0;
      try { recognizer.retrieveFinalResult(); } catch (_) { /* 忽略 */ }
    }
  }

  function onSpeechPartial(message) {
    if (locked) return;
    const text = (message && message.result && message.result.partial) || '';
    if (!text) return;
    partialSeen = text;
    lastSpoken = Date.now();
    heardEl.textContent = `听到：${text}`;
  }

  function onSpeechResult(message) {
    if (locked) return;
    const text = (message && message.result && message.result.text) || '';
    if (!text) {
      silenceCounter += 1;
      if (silenceCounter >= 3) {
        micLabel.textContent = '没听到声音，点一下继续说';
        stopListening();
      }
      return;
    }
    silenceCounter = 0;
    const value = parseSpokenNumber(text);
    heardEl.textContent = `听到：${text}`;
    if (value === null || value > 1998) {
      setFeedback('没听清数字，再说一次', 'bad');
      return;
    }
    if (value === answer) {
      grade(value);
      return;
    }
    // 可能是没听准，给两次重说的机会，避免把听错算成答错
    retries += 1;
    if (retries < 3) {
      setFeedback(`听到 ${value}，如果不是这个数就再说一次`, 'bad');
      return;
    }
    grade(value);
  }

  function stopListening() {
    wantListen = false;
    window.clearInterval(finishTimer);
    finishTimer = 0;
    listening = false;
    micBtn.classList.remove('is-listening');
    if (!locked && mode === 'voice') micLabel.textContent = '点一下继续说';
  }

  function releaseMic() {
    stopListening();
    if (processor) {
      processor.onaudioprocess = null;
      try { processor.disconnect(); } catch (_) { /* 已断开 */ }
      processor = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (recognizer) {
      try { recognizer.remove(); } catch (_) { /* 已释放 */ }
      recognizer = null;
    }
  }

  // ---------- 中文数字解析 ----------
  const DIGITS = { 零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const UNITS = { 十: 10, 百: 100, 千: 1000 };

  function parseSpokenNumber(raw) {
    if (!raw) return null;
    let text = String(raw)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/[\s，。、；：？！,.]/g, '');
    if (!text) return null;
    // 口算答案不超过四位数，出现「万/亿」几乎都是误识别，直接作废
    if (text.includes('万') || text.includes('亿')) return null;
    if (/^\d+$/.test(text)) return Number(text);

    let section = 0;
    let run = null;
    let found = false;
    let total = 0;
    for (const ch of text) {
      if (Object.prototype.hasOwnProperty.call(DIGITS, ch)) {
        run = run === null ? DIGITS[ch] : run * 10 + DIGITS[ch];
        found = true;
      } else if (Object.prototype.hasOwnProperty.call(UNITS, ch)) {
        section += (run === null ? 1 : run) * UNITS[ch];
        run = null;
        found = true;
      }
    }
    if (!found) return null;
    // 「一百亿」这类误识别会算出天文数字，超出答案范围一律作废
    return total + section + (run === null ? 0 : run);
  }

  // ---------- 事件 ----------
  // 安卓 Chrome 只允许在用户手势里启动音频；这里同步解锁，后面接麦克风才不会挂起
  const MIC_RATE = 16000;

  function unlockAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) {
      // 安卓 Chrome 默认 48kHz，而离线模型只认 16kHz，必须在这里指定，否则识别全是乱码
      try { audioCtx = new Ctx({ sampleRate: MIC_RATE }); } catch (_) {
        try { audioCtx = new Ctx(); } catch (_) { audioCtx = null; }
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }

  startBtn.addEventListener('click', () => {
    unlockAudio();
    startSession();
  });

  againBtn.addEventListener('click', () => {
    unlockAudio();
    startSession();
  });

  backBtn.addEventListener('click', () => {
    releaseMic();
    showView('setup');
  });

  dockTyping.addEventListener('submit', (event) => {
    event.preventDefault();
    if (locked) return;
    const raw = answerInput.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[\s,，]/g, '');
    if (!/^\d+$/.test(raw)) {
      setFeedback('输入数字再确认', 'bad');
      return;
    }
    grade(Number(raw));
  });

  micBtn.addEventListener('click', () => {
    unlockAudio();
    if (locked) return;
    if (listening) {
      stopListening();
    } else {
      voiceReady().then(() => { if (!locked) startListening(); }).catch(() => {});
    }
  });

  switchTypingBtn.addEventListener('click', () => {
    releaseMic();
    mode = 'typing';
    syncSetup();
    saveSettings();
    if (!locked) showTypingDock();
  });

  skipBtn.addEventListener('click', () => {
    if (locked) return;
    answered += 1;
    wrong.push({ text: questionText, answer, given: '跳过' });
    setFeedback(`答案是 ${answer}`, 'bad');
    locked = true;
    pauseTimer();
    nextQuestion();
  });

  quitBtn.addEventListener('click', () => {
    if (locked && !listening) {
      finish();
      return;
    }
    finish();
  });

  $('#voice-cancel').addEventListener('click', () => {
    releaseMic();
    mode = 'typing';
    syncSetup();
    saveSettings();
    showTypingDock();
  });

  document.addEventListener('visibilitychange', () => {
    if (practiceEl.hidden) return;
    if (document.hidden) {
      pauseTimer();
      stopListening();
    } else if (!locked) {
      resumeTimer();
      if (mode === 'voice' && model) startListening();
    }
  });

  // ---------- 初始化 ----------
  syncSetup();
  updateVoiceNote();
  if (!voiceSupported && mode === 'voice') {
    mode = 'typing';
    syncSetup();
  }
})();
