(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 版本自检
   * 发布刚完成时，浏览器可能拿到「新页面 + 旧脚本」的组合：旧脚本按旧结构
   * 取元素会直接报错，表现为所有按钮都点不动。这里先确认结构对得上，
   * 对不上就带参数重新取一次页面。
   * ------------------------------------------------------------------ */

  const REQUIRED_IDS = ['welcome', 'setup', 'practice', 'results', 'answer-form', 'question', 'voice-button'];
  const domMatches = REQUIRED_IDS.every((id) => document.getElementById(id));
  if (!domMatches) {
    if (location.search.indexOf('fresh=') === -1) {
      const base = location.href.split('#')[0];
      const joiner = base.indexOf('?') === -1 ? '?' : '&';
      location.replace(`${base}${joiner}fresh=${Date.now().toString(36)}`);
      return;
    }
    document.body.insertAdjacentHTML(
      'afterbegin',
      '<div style="margin:0;padding:14px 18px;background:#fff0e9;color:#a03c1c;font:14px/1.6 -apple-system,sans-serif">'
      + '页面缓存还是旧版本。<a href="' + location.pathname + '?reload=' + Date.now() + '" '
      + 'style="color:#a03c1c;font-weight:700">点这里重新加载</a> 即可。'
      + '</div>'
    );
    return;
  }

  const STORE_KEY = 'kousuan:v1';
  const MINUS = '−';
  const LEVEL_LABELS = { two: '两位数 ± 两位数', mixed: '两位数 ± 三位数', three: '三位数 ± 三位数' };

  const el = (id) => document.getElementById(id);

  /* 旧版 Safari 的 classList.toggle 不支持第二个参数，这里显式区分 */
  function setClass(node, name, on) {
    if (on) node.classList.add(name);
    else node.classList.remove(name);
  }

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supportsSpeech = Boolean(Recognition);

  /* 离线识别：vendor/vosk-browser.js + models/ 里的中文小模型（见 src/offline-asr.js） */
  const Offline = window.KousuanOffline;
  const supportsOffline = Boolean(Offline && Offline.supported());
  const supportsVoice = supportsSpeech || supportsOffline;

  const inFrame = window.self !== window.top;

  /* 个别旧 WebView 没有 matchMedia，取不到就当没有精确指针（不自动聚焦） */
  function mediaMatches(query) {
    try {
      return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch (_) {
      return false;
    }
  }

  const finePointer = mediaMatches('(hover: hover) and (pointer: fine)');

  const defaults = { mode: 'type', level: 'two', count: 10, engine: '', packPrompt: true };
  let prefs = { ...defaults };
  let best = {};

  let view = 'setup';
  let session = null;
  let locked = false;
  let advanceTimer = 0;
  let awayMs = 0;
  let awaySince = 0;

  /* ------------------------------------------------------------------ *
   * 本地设置
   * ------------------------------------------------------------------ */

  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && data.prefs) prefs = Object.assign({}, defaults, data.prefs);
      if (data && data.best) best = data.best;
    }
  } catch (_) {
    /* 无痕模式或数据损坏：用默认值 */
  }

  if (['type', 'voice'].indexOf(prefs.mode) === -1) prefs.mode = defaults.mode;
  if (['two', 'mixed', 'three'].indexOf(prefs.level) === -1) prefs.level = defaults.level;
  if ([0, 10, 20, 30].indexOf(prefs.count) === -1) prefs.count = defaults.count;
  if (['offline', 'online'].indexOf(prefs.engine) === -1) prefs.engine = defaults.engine;
  if (typeof prefs.packPrompt !== 'boolean') prefs.packPrompt = defaults.packPrompt;
  if (!supportsVoice) prefs.mode = 'type';

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ prefs, best }));
    } catch (_) {
      /* 存不下也不影响练习 */
    }
  }

  /* ------------------------------------------------------------------ *
   * 设置页
   * ------------------------------------------------------------------ */

  function syncSetup() {
    document.querySelectorAll('[data-mode]').forEach((button) => {
      const on = button.dataset.mode === prefs.mode;
      setClass(button, 'selected', on);
      button.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-level]').forEach((button) => {
      const on = button.dataset.level === prefs.level;
      setClass(button, 'selected', on);
      button.setAttribute('aria-pressed', String(on));
    });
    document.querySelectorAll('[data-count]').forEach((button) => {
      const on = Number(button.dataset.count) === prefs.count;
      setClass(button, 'selected', on);
      button.setAttribute('aria-pressed', String(on));
    });
    el('voice-tip').hidden = !(prefs.mode === 'voice' && supportsVoice);
    syncVoiceUI();
  }

  /* ------------------------------------------------------------------ *
   * 离线语音包 / 识别引擎
   * ------------------------------------------------------------------ */

  let downloading = false;
  let downloadTimer = 0;
  let downloadStartedAt = 0;
  let downloadProgressText = '';

  function formatMB(bytes) {
    if (!bytes) return '';
    return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
  }

  /* 没有明确选择时：装过离线包就用离线（手机最稳），否则用浏览器自带 */
  function autoEngine() {
    if (supportsOffline && Offline.state() === 'ready') return 'offline';
    if (supportsSpeech) return 'online';
    return supportsOffline ? 'offline' : 'online';
  }

  function engineNow() {
    if (!supportsVoice) return 'none';
    const wanted = prefs.engine || autoEngine();
    if (wanted === 'offline' && supportsOffline) return 'offline';
    if (wanted === 'online' && supportsSpeech) return 'online';
    return supportsSpeech ? 'online' : (supportsOffline ? 'offline' : 'none');
  }

  function offlineReady() {
    return supportsOffline && Offline.state() === 'ready';
  }

  function syncVoiceUI() {
    const engine = engineNow();

    const choice = el('engine-choice');
    const showChoice = supportsOffline && supportsSpeech;
    choice.hidden = !showChoice;
    el('engine-offline-note').textContent = offlineReady()
      ? (formatMB(Offline.sizeHint()) || '已下载')
      : '未下载';
    el('engine-online-note').textContent = '无需下载';

    document.querySelectorAll('[data-engine]').forEach((button) => {
      const value = button.dataset.engine;
      const on = value === engine;
      setClass(button, 'selected', on);
      button.setAttribute('aria-pressed', String(on));
      button.disabled = (value === 'offline' && !supportsOffline)
        || (value === 'online' && !supportsSpeech);
    });

    const card = document.querySelector('[data-mode="voice"]');
    if (card) {
      const copy = card.querySelector('.mode-copy small');
      if (!supportsVoice) copy.textContent = '此浏览器不支持';
      else if (engine === 'offline') copy.textContent = offlineReady() ? '本机识别，断网可用' : '需先下载语音包';
      else copy.textContent = '看题后直接说出答案';
    }

    const note = el('voice-note');
    if (!supportsVoice) {
      note.textContent = '这个浏览器既没有网页语音识别，也不支持离线语音包，先用打字作答吧。';
      note.hidden = false;
    } else if (!supportsSpeech) {
      note.textContent = offlineReady()
        ? '这个浏览器不支持网页语音识别，已改用本机离线识别。'
        : '这个浏览器不支持网页语音识别。下载离线语音包后，手机也能说话答题。';
      note.hidden = false;
    } else if (!supportsOffline) {
      note.textContent = '这个浏览器不支持离线语音包，只能用浏览器自带的在线识别。';
      note.hidden = false;
    } else {
      note.hidden = true;
    }

    const row = el('pack-row');
    row.hidden = !supportsOffline;
    const size = Offline && Offline.sizeHint ? Offline.sizeHint() : 0;
    if (downloadProgressText) {
      el('pack-status').textContent = downloadProgressText;
      el('pack-action').textContent = '取消下载';
      el('pack-action').disabled = false;
    } else if (offlineReady()) {
      el('pack-status').textContent = formatMB(size) ? `已下载（${formatMB(size)}）` : '已下载';
      el('pack-action').textContent = '已装好';
      el('pack-action').disabled = true;
    } else {
      el('pack-status').textContent = '还没下载，下载后断网也能说话答题';
      el('pack-action').textContent = '下载';
      el('pack-action').disabled = false;
    }

    el('voice-tip').hidden = !(prefs.mode === 'voice' && supportsVoice);
    if (prefs.mode === 'voice' && supportsVoice) {
      el('voice-tip').textContent = engine === 'offline'
        ? (offlineReady()
          ? '开始后请允许麦克风，声音在本机识别，不联网也能用。'
          : '开始后会先下载离线语音包（约 42 MB），之后就能断网使用。')
        : '开始后请允许麦克风，说完答案会自动进入下一题。';
    }

    el('offline-badge').hidden = engine !== 'offline' || view !== 'practice';
  }

  document.querySelectorAll('[data-engine]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      offlineFallbackTried = false;
      prefs.engine = button.dataset.engine;
      persist();
      syncVoiceUI();
    });
  });

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

  if (!supportsVoice) {
    const voiceCard = document.querySelector('[data-mode="voice"]');
    if (voiceCard) {
      voiceCard.disabled = true;
      voiceCard.setAttribute('aria-describedby', 'voice-note');
    }
  }

  /* 下载离线语音包：欢迎页和设置页共用一套进度显示 */
  function setPackStage(text, hidden) {
    el('welcome-progress').hidden = Boolean(hidden);
    el('welcome-stage').textContent = text || '';
  }

  /* 下载和解压都在识别引擎的 Worker 里跑，拿不到真实百分比，
     就别编数字：显示已用时间 + 不确定进度条 */
  function setPackBusy(busy) {
    const track = el('welcome-fill').parentElement;
    setClass(track, 'is-indeterminate', busy);
  }

  function packSizeText() {
    const size = Offline && Offline.sizeHint ? Offline.sizeHint() : 0;
    return size ? `约 ${formatMB(size)}` : '约 42 MB';
  }

  function startPackDownload(fromWelcome) {
    if (!supportsOffline || downloading) return;
    if (fromWelcome) prefs.packPrompt = false;
    downloading = true;
    downloadStartedAt = performance.now();
    el('welcome-download').disabled = true;
    el('welcome-skip').hidden = true;
    el('welcome-cancel').hidden = false;
    downloadProgressText = '准备中…';
    setPackStage(`正在加载识别引擎，接着下载语音包（${packSizeText()}）…`, false);
    setPackBusy(true);
    syncVoiceUI();
    persist();

    let lastPhase = '';
    clearInterval(downloadTimer);
    downloadTimer = setInterval(() => {
      const seconds = Math.round((performance.now() - downloadStartedAt) / 1000);
      const nextPhase = Offline.status();
      if (nextPhase !== lastPhase) lastPhase = nextPhase;
      setPackStage(
        `${nextPhase === 'engine' ? '正在加载识别引擎' : '正在下载语音包'}（${packSizeText()}）… `
        + `已用 ${seconds} 秒，下载和准备期间请让页面留在前台`,
        false
      );
      downloadProgressText = `下载中 · ${seconds}s`;
      syncVoiceUI();
    }, 1000);

    Offline.download()
      .then(() => {
        clearInterval(downloadTimer);
        downloading = false;
        downloadProgressText = '';
        setPackBusy(false);
        el('welcome-fill').style.width = '100%';
        setPackStage('离线语音包已装好，现在断网也能说话答题。', false);
        prefs.engine = 'offline';
        persist();
        syncVoiceUI();
        el('pack-action').textContent = '已装好';
        setTimeout(() => {
          el('welcome-cancel').hidden = true;
          if (view === 'welcome') showView('setup');
        }, 1200);
      })
      .catch((error) => {
        clearInterval(downloadTimer);
        downloading = false;
        downloadProgressText = '';
        setPackBusy(false);
        const cancelled = error && error.message === 'cancelled';
        setPackStage(
          cancelled
            ? '已取消下载，需要时可以再点一次。'
            : '下载没成功。可能是网络被拦住了，换个网络再试，或者先用打字作答。',
          false
        );
        el('welcome-cancel').hidden = true;
        el('welcome-skip').hidden = false;
        el('welcome-download').disabled = false;
        el('welcome-download').querySelector('span').textContent = '重新下载离线语音包';
        syncVoiceUI();
        /* 中途取消不算失败：设置页还是那句「下载」 */
        if (cancelled) el('pack-action').textContent = '下载';
        else el('pack-action').textContent = '重试';
      });
  }

  el('welcome-download').addEventListener('click', () => startPackDownload(true));
  el('welcome-cancel').addEventListener('click', () => {
    if (Offline) Offline.cancel();
  });
  el('welcome-skip').addEventListener('click', () => {
    prefs.packPrompt = false;
    if (prefs.mode === 'voice' && engineNow() === 'offline' && !offlineReady()) {
      /* 用户不想下载：退回浏览器自带识别（如果支持），否则用打字 */
      prefs.mode = supportsSpeech ? 'voice' : 'type';
      if (supportsSpeech) prefs.engine = 'online';
    }
    persist();
    syncSetup();
    el('welcome-skip').textContent = '先用打字作答，稍后再下载';
    showView('setup');
  });
  el('pack-action').addEventListener('click', () => {
    if (downloading) {
      if (Offline) Offline.cancel();
      return;
    }
    if (offlineReady()) return;
    startPackDownload(false);
  });

  if (supportsOffline) {
    Offline.probeSize(Offline.modelUrls[0]).then(() => syncVoiceUI()).catch(() => {});
  }

  function beginOrAsk() {
    /* 选了离线识别但语音包还没装：先去装，装完再开始，别让练习页空等 */
    if (prefs.mode === 'voice' && engineNow() === 'offline' && !offlineReady()) {
      el('welcome-stage').textContent = '说话答题要先装一次离线语音包，装好后就能断网使用。';
      el('welcome-progress').hidden = false;
      el('welcome-fill').style.width = '0%';
      el('welcome-skip').textContent = '先不下载，改用打字作答';
      showView('welcome');
      return;
    }
    startSession();
  }

  el('start-button').addEventListener('click', () => {
    /* 在点击里解锁音频，手机上离线识别才采得到声音 */
    if (supportsOffline) Offline.unlock();
    beginOrAsk();
  });
  el('again-button').addEventListener('click', beginOrAsk);

  el('settings-button').addEventListener('click', () => {
    syncSetup();
    showView('setup');
  });

  el('back-button').addEventListener('click', () => {
    stopVoice();
    clearTimeout(advanceTimer);
    session = null;
    locked = false;
    showView('setup');
  });

  el('quit-button').addEventListener('click', finishSession);

  /* ------------------------------------------------------------------ *
   * 出题
   * ------------------------------------------------------------------ */

  const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  function draftQuestion() {
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
    if (op === MINUS && b > a) [a, b] = [b, a];

    return { a, b, op, answer: op === '+' ? a + b : a - b };
  }

  /* 40 + 60、300 - 300 这类题目没有练习价值 */
  function isBoring({ a, b, op, answer }) {
    if (a % 10 === 0 && b % 10 === 0) return true;
    return op === MINUS && answer === 0;
  }

  function buildQuestion() {
    for (let i = 0; i < 8; i += 1) {
      const question = draftQuestion();
      if (!isBoring(question)) return question;
    }
    return draftQuestion();
  }

  function freshQuestion() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const question = buildQuestion();
      const key = `${question.a}${question.op}${question.b}`;
      if (!session.seen.has(key)) {
        session.seen.add(key);
        return question;
      }
    }
    return buildQuestion();
  }

  /* ------------------------------------------------------------------ *
   * 练习流程
   * ------------------------------------------------------------------ */

  function startSession() {
    clearTimeout(advanceTimer);
    offlineFallbackTried = false;
    locked = false;
    awayMs = 0;
    awaySince = document.hidden ? performance.now() : 0;
    session = {
      index: 0,
      answered: 0,
      correct: 0,
      mistakes: [],
      seen: new Set(),
      current: null,
      startedAt: performance.now(),
    };

    showView('practice');
    applyModeLayout();
    nextQuestion();

    if (prefs.mode === 'voice' && supportsVoice) startVoice();
  }

  function applyModeLayout() {
    const isVoice = prefs.mode === 'voice';
    el('answer-form').hidden = isVoice;
    el('voice-area').hidden = !isVoice;
    el('answer-dock').hidden = isVoice;
    el('practice').dataset.mode = prefs.mode;
    el('offline-badge').hidden = !(isVoice && engineNow() === 'offline' && view === 'practice');
  }

  function nextQuestion() {
    if (!session) return;
    if (prefs.count > 0 && session.index >= prefs.count) {
      finishSession();
      return;
    }

    locked = false;
    session.index += 1;
    session.current = freshQuestion();

    renderQuestion();
    el('answer').value = '';
    setFeedback(prefs.mode === 'voice' ? '看着题目，直接说出答案' : '仔细想一想，输入你的答案');
    el('question').classList.remove('shake');
    updateMeta();

    if (prefs.mode === 'voice') {
      resumeVoice();
    } else if (finePointer) {
      el('answer').focus();
    }
  }

  function renderQuestion() {
    const question = session.current;
    el(
      'question'
    ).innerHTML = `${question.a} <span>${question.op}</span> ${question.b} <span>=</span> ?`;
  }

  function updateMeta() {
    const total = prefs.count;
    const done = session.answered;
    el('progress-label').textContent = total > 0
      ? `第 ${session.index} / ${total} 题`
      : `第 ${session.index} 题`;
    el('score-label').textContent = `答对 ${session.correct} 题`;
    el('progress-fill').style.width = total > 0 ? `${Math.min(done / total, 1) * 100}%` : '0%';
    el('progress-fill').parentElement.hidden = total === 0;
  }

  function submit(value) {
    if (locked || view !== 'practice' || !session) return false;
    if (!Number.isFinite(value)) {
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
      session.mistakes.push(Object.assign({}, question, { given: value }));
    }

    if (prefs.mode === 'voice') pauseVoice();

    setFeedback(correct ? '答对了' : `正确答案是 ${question.answer}`, correct ? 'good' : 'bad');
    el('answer').value = '';
    updateMeta();

    advanceTimer = setTimeout(nextQuestion, correct ? 650 : 1700);
    return true;
  }

  function submitTyped() {
    if (view !== 'practice') return;
    if (locked) {
      /* 反馈还没结束就再点确认：当作「下一题」 */
      advanceNow();
      return;
    }
    const raw = el('answer').value.trim();
    if (!raw) {
      nudge('先输入答案');
      return;
    }
    const digits = raw.replace(/[^\d-]/g, '');
    if (!digits || !/\d/.test(digits)) {
      nudge('请输入数字');
      return;
    }
    const value = Number(digits);
    if (!Number.isFinite(value)) {
      nudge('请输入数字');
      return;
    }
    submit(value);
  }

  function nudge(message) {
    setFeedback(message, 'bad');
    const question = el('question');
    question.classList.remove('shake');
    void question.offsetWidth;
    question.classList.add('shake');
    if (prefs.mode === 'type' && finePointer) el('answer').focus();
  }

  function setFeedback(text, kind = '') {
    const node = el('feedback');
    node.textContent = text;
    node.className = `feedback ${kind}`.trim();
  }

  el('answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submitTyped();
  });

  document.addEventListener('keydown', (event) => {
    if (view !== 'practice') return;
    if (event.key === 'Enter' && locked) {
      event.preventDefault();
      advanceNow();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishSession();
    }
  });

  function advanceNow() {
    if (!locked) return;
    clearTimeout(advanceTimer);
    nextQuestion();
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
    const now = performance.now();
    const away = awayMs + (awaySince ? now - awaySince : 0);
    const seconds = Math.max(1, Math.round((now - session.startedAt - away) / 1000));

    const previous = best[prefs.level];
    const isRecord = !previous || accuracy > previous.accuracy;
    if (isRecord) {
      best[prefs.level] = { accuracy, seconds };
      persist();
    }

    el('result-correct').textContent = String(session.correct);
    el('result-total').textContent = String(session.answered);
    el('result-accuracy').textContent = `${accuracy}%`;
    el('result-time').textContent = formatDuration(seconds);
    el('result-avg').textContent = `${(seconds / session.answered).toFixed(1)} 秒`;
    el('result-message').textContent = messageFor(accuracy, isRecord, previous);

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
        li.appendChild(equation);
        li.appendChild(mine);
        list.appendChild(li);
      });
      list.hidden = false;
    } else {
      list.hidden = true;
    }

    session = null;
    showView('results');
  }

  function messageFor(accuracy, isRecord, previous) {
    if (accuracy === 100) return '全部正确，这一组非常稳。';
    if (isRecord) {
      return previous
        ? `刷新最好成绩，之前是 ${previous.accuracy}%。`
        : '已记下这组成绩，下次可以对比。';
    }
    return `最好成绩 ${previous.accuracy}%，再来一组试试。`;
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds} 秒`;
    return `${minutes} 分 ${(seconds < 10 ? '0' : '') + seconds} 秒`;
  }

  function showView(next) {
    view = next;
    el('welcome').hidden = next !== 'welcome';
    el('setup').hidden = next !== 'setup';
    el('practice').hidden = next !== 'practice';
    el('results').hidden = next !== 'results';
    el('offline-badge').hidden = next !== 'practice' || engineNow() !== 'offline';
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------------------ *
   * 语音识别
   * ------------------------------------------------------------------ */

  const CN_DIGITS = {
    '零': 0, '〇': 0, '一': 1, '壹': 1, '幺': 1, '二': 2, '贰': 2, '两': 2, '俩': 2,
    '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6,
    '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9,
  };
  const CN_UNITS = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 };

  /* 识别引擎常把数字听成同音字，例如「四」->「是」「寺」 */
  const HOMOPHONES = {
    '是': 4, '事': 4, '市': 4, '式': 4, '试': 4, '氏': 4, '似': 4, '寺': 4, '视': 4,
    '示': 4, '世': 4, '室': 4, '适': 4, '释': 4, '势': 4, '伺': 4, '嗣': 4,
    '依': 1, '衣': 1, '医': 1, '仪': 1, '移': 1, '伊': 1, '以': 1, '已': 1,
    '而': 2, '儿': 2, '耳': 2, '尔': 2,
    '山': 3, '伞': 3, '衫': 3, '善': 3, '散': 3,
    '无': 5, '午': 5, '舞': 5, '武': 5, '物': 5, '务': 5, '误': 5, '雾': 5,
    '溜': 6, '流': 6, '留': 6, '柳': 6, '绿': 6, '录': 6,
    '齐': 7, '奇': 7, '妻': 7, '期': 7, '欺': 7,
    '巴': 8, '拔': 8, '爸': 8, '罢': 8, '疤': 8,
    '酒': 9, '久': 9, '旧': 9, '救': 9, '揪': 9,
    '灵': 0, '铃': 0, '龄': 0, '另': 0, '领': 0,
    '时': 10, '实': 10, '识': 10, '食': 10, '石': 10,
    '白': 100, '摆': 100, '败': 100,
    '千': 1000, '签': 1000, '前': 1000, '钱': 1000,
  };

  const NOISE = /[嗯啊哦呃喔诶欸唔呀哈唉哎噢哟哪]/g;
  const FILLER_PHRASES = [
    '答案是', '答案', '等于', '应该是', '大概是', '我觉得', '我认为', '我算',
    '结果', '就是', '那个', '这个', '大概', '可能', '我猜', '数字',
  ];

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
      if (current === null) current = 1;
      total += current * unit;
      current = 0;
    }

    /* 口语省字：「两百五」是 250、「一千二」是 1200；带「零」或「十」时按字面算 */
    const trailingDigit = current !== null && current > 0;
    if (trailingDigit && !/[零〇十拾]/.test(run)) {
      if (/[百佰]/.test(run)) return total + current * 10;
      if (/[千仟]/.test(run)) return total + current * 100;
    }

    return total + (current || 0);
  }

  function parseStrict(text) {
    if (!text) return null;

    const arabic = text.match(/\d+/g);
    if (arabic) {
      const longest = arabic.reduce((a, b) => (b.length > a.length ? b : a));
      const value = Number(longest);
      return Number.isFinite(value) ? value : null;
    }

    const runs = text.match(SPOKEN_RUN);
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

  function stripFillers(text) {
    let out = text.replace(NOISE, '');
    FILLER_PHRASES.forEach((phrase) => {
      out = out.split(phrase).join('');
    });
    return out;
  }

  /* 只在整个短句都能映射成数字时才使用同音字，避免把正常词句误判成数字 */
  function mapHomophones(text) {
    let out = '';
    for (const ch of text) {
      if (CN_DIGITS[ch] !== undefined || CN_UNITS[ch] !== undefined) {
        out += ch;
        continue;
      }
      const homophone = HOMOPHONES[ch];
      if (homophone === undefined) return null;
      out += homophone;
    }
    return out;
  }

  function parseSpokenNumber(text) {
    const normalized = normalizeSpeech(text);
    if (!normalized) return null;

    const strict = parseStrict(normalized);
    if (strict !== null) return strict;

    const trimmed = stripFillers(normalized);
    if (trimmed && trimmed !== normalized) {
      const cleaned = parseStrict(trimmed);
      if (cleaned !== null) return cleaned;
    }

    const mapped = mapHomophones(trimmed || '');
    if (mapped) {
      const value = parseStrict(mapped);
      if (value !== null && value <= 9999) return value;
    }
    return null;
  }

  let recognition = null;
  let wantListen = false;
  let isListening = false;
  let paused = false;
  let restartTimer = 0;
  let micProblem = null;
  let hasStarted = false;
  let silenceCount = 0;

  /* 两个引擎拿到最终文本后都走这里：解析数字 → 判题 */
  function handleHeard(text) {
    if (locked || view !== 'practice' || !session) return;
    silenceCount = 0;
    const value = parseSpokenNumber(text);
    if (value === null) {
      setFeedback('没听清，再说一次', 'bad');
      return;
    }
    setFeedback('');
    submit(value);
  }

  function createRecognition() {
    const instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 5;

    instance.onstart = () => {
      isListening = true;
      hasStarted = true;
      micProblem = null;
      setVoiceState('listening');
      if (!locked) setVoiceLabel('正在聆听…');
    };

    instance.onresult = (event) => {
      if (locked) return;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = (result[0].transcript || '').trim();
        if (!text) continue;
        silenceCount = 0;
        el('heard-text').textContent = text;
        if (!result.isFinal) continue;

        let value = null;
        for (let k = 0; k < result.length; k += 1) {
          const candidate = parseSpokenNumber(result[k].transcript);
          if (candidate !== null) {
            value = candidate;
            break;
          }
        }
        if (value === null) value = parseSpokenNumber(text);

        if (value === null) {
          setFeedback('没听清，再说一次', 'bad');
          continue;
        }
        setFeedback('');
        submit(value);
        break;
      }
    };

    instance.onerror = (event) => {
      const code = event && event.error;
      if (code === 'no-speech') {
        silenceCount += 1;
        if (silenceCount >= 3) {
          pausePrompt('没听到声音，点麦克风继续', '继续收音');
        } else {
          setFeedback('没听到声音，再说一次', 'bad');
        }
        return;
      }
      if (code === 'aborted') return;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        failVoice('麦克风没有打开。允许权限后重试，或改用打字作答。');
        return;
      }
      if (code === 'audio-capture') {
        failVoice('没有找到可用的麦克风。');
        return;
      }
      if (code === 'network') {
        failVoice(inFrame ? '预览窗口里语音服务连不上，可以点「在新窗口打开」再试。' : '语音服务暂时连不上，请稍后再试。');
        return;
      }
      failVoice('语音识别出了点问题，可以重试或改用打字作答。');
    };

    instance.onend = () => {
      isListening = false;
      if (wantListen && !paused && view === 'practice' && !micProblem) {
        scheduleRestart(200);
      } else if (!micProblem) {
        setVoiceState(wantListen ? 'paused' : 'idle');
      }
    };

    return instance;
  }

  function listen() {
    if (!wantListen || paused || locked || view !== 'practice') return;
    if (!recognition) recognition = createRecognition();
    clearTimeout(restartTimer);
    try {
      recognition.start();
    } catch (error) {
      if (error && error.name === 'InvalidStateError') {
        scheduleRestart(320);
        return;
      }
      if (error && (error.name === 'NotAllowedError' || error.name === 'SecurityError') && hasStarted) {
        pausePrompt('浏览器需要你点一下才能继续收音', '继续收音');
        return;
      }
      failVoice('麦克风没有打开。允许权限后重试，或改用打字作答。');
    }
  }

  function scheduleRestart(delay) {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (wantListen && !paused && !locked && view === 'practice' && !micProblem) listen();
    }, delay);
  }

  /* ------------------------------------------------------------------ *
   * 离线识别（Vosk，在本机跑）
   * ------------------------------------------------------------------ */

  let offlineSession = null;
  let offlineFallbackTried = false;

  function startOfflineVoice() {
    /* 只在这次练习还没启动过会话时重建，切标签页回来要走 rescue 路径 */
    showView('practice');
    wantListen = true;
    paused = false;
    micProblem = null;
    silenceCount = 0;
    el('heard-text').textContent = '';
    el('voice-actions').hidden = true;
    el('new-tab').hidden = !inFrame;
    el('voice-hint').textContent = '正在准备离线语音…';
    el('offline-badge').hidden = false;
    setFeedback('看着题目，直接说出答案');
    setVoiceState('loading');

    if (offlineSession && (offlineSession.running || offlineSession.starting)) {
      setVoiceState('listening');
      return;
    }

    if (!offlineSession) {
      offlineSession = Offline.createSession({
        onState(state) {
          if (state === 'listening') {
            setVoiceState('listening');
            el('offline-badge').hidden = false;
          } else if (state === 'loading') {
            setVoiceState('loading');
          } else if (state === 'paused') {
            setVoiceState(wantListen ? 'thinking' : 'idle');
          } else {
            setVoiceState('idle');
          }
        },
        onHint(text) {
          el('voice-hint').textContent = text;
        },
        onText(text, isFinal) {
          el('heard-text').textContent = text;
          if (!isFinal) return;
          handleHeard(text);
        },
        onSilence() {
          silenceCount += 1;
          if (silenceCount >= 3) pausePrompt('没听到声音，点麦克风继续', '继续收音');
          else setFeedback('没听到声音，再说一次', 'bad');
        },
        onReady() {
          silenceCount = 0;
        },
        onError(kind, error) {
          if (kind === 'mic-denied') {
            failVoice('麦克风没有打开。允许权限后重试，或改用打字作答。');
          } else if (kind === 'mic-missing') {
            failVoice('没有找到可用的麦克风。');
          } else if (kind === 'offline-start') {
            /* 离线包坏了/缓存被清了，但浏览器自带识别可用：当场换过去，别让这组练习废掉 */
            if (supportsSpeech && !offlineFallbackTried) {
              offlineFallbackTried = true;
              stopOfflineVoice();
              prefs.engine = 'online';
              persist();
              syncVoiceUI();
              startVoice();
              setFeedback('离线语音没启动起来，已改用浏览器识别', '');
              return;
            }
            failVoice('离线语音没能启动。可以点「重新打开麦克风」，或者改用打字作答。');
            el('voice-hint').textContent = `离线语音没能启动（${(error && error.message) || '未知原因'}）。`;
            if (offlineReady() === false) {
              el('voice-hint').textContent += '离线语音包可能没装好，回设置页可以重新下载。';
            }
          } else {
            setFeedback('识别出了点问题，再说一次', 'bad');
          }
        },
      });
    }

    offlineSession.start();
  }

  function stopOfflineVoice() {
    if (offlineSession) {
      offlineSession.stop();
      offlineSession = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * 语音控制：两个引擎共用一套状态
   * ------------------------------------------------------------------ */

  function startVoice() {
    if (engineNow() === 'offline') {
      startOfflineVoice();
      return;
    }
    if (!Recognition) return;
    wantListen = true;
    paused = false;
    micProblem = null;
    silenceCount = 0;
    hasStarted = false;
    el('heard-text').textContent = '';
    el('voice-actions').hidden = true;
    el('new-tab').hidden = !inFrame;
    el('offline-badge').hidden = true;
    el('voice-hint').textContent = '说完答案会自动进入下一题，点麦克风可暂停';
    el('feedback').className = 'feedback';
    setFeedback('看着题目，直接说出答案');
    setVoiceState('listening');
    listen();
  }

  function pauseVoice() {
    paused = true;
    clearTimeout(restartTimer);
    if (engineNow() === 'offline') {
      if (offlineSession) offlineSession.pause();
      setVoiceState(wantListen ? 'thinking' : 'idle');
      return;
    }
    if (recognition && isListening) {
      try {
        recognition.stop();
      } catch (_) {
        /* 已经停止 */
      }
    }
    setVoiceState(wantListen ? 'thinking' : 'idle');
  }

  function resumeVoice() {
    if (!wantListen || micProblem) return;
    paused = false;
    el('heard-text').textContent = '';
    if (engineNow() === 'offline') {
      if (offlineSession) {
        offlineSession.resume();
        offlineSession.reset();
      } else {
        startOfflineVoice();
      }
      return;
    }
    if (!Recognition) return;
    listen();
  }

  function stopVoice() {
    wantListen = false;
    paused = true;
    micProblem = null;
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* 已经停止 */
      }
    }
    stopOfflineVoice();
    isListening = false;
    el('offline-badge').hidden = true;
    setVoiceState('idle');
  }

  function pausePrompt(message, label) {
    wantListen = true;
    paused = true;
    micProblem = 'prompt';
    clearTimeout(restartTimer);
    if (recognition && isListening) {
      try {
        recognition.abort();
      } catch (_) {
        /* 已经停止 */
      }
    }
    if (offlineSession) offlineSession.pause();
    isListening = false;
    setVoiceState('paused');
    setVoiceLabel('点一下继续');
    el('voice-hint').textContent = message;
    el('voice-retry').textContent = label;
    el('voice-actions').hidden = false;
    el('new-tab').hidden = !inFrame;
  }

  function failVoice(message) {
    wantListen = false;
    paused = true;
    micProblem = 'failed';
    clearTimeout(restartTimer);
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* 已经停止 */
      }
    }
    isListening = false;
    setVoiceState('blocked');
    setVoiceLabel('麦克风未开启');
    el('voice-hint').textContent = message;
    el('voice-retry').textContent = '重新打开麦克风';
    el('voice-actions').hidden = false;
    el('new-tab').hidden = !inFrame;
  }

  const VOICE_LABELS = {
    loading: '正在准备…',
    listening: '正在聆听…',
    thinking: '已听到',
    paused: '点一下继续',
    idle: '开始聆听',
    blocked: '麦克风未开启',
  };

  function setVoiceState(state) {
    const button = el('voice-button');
    setClass(button, 'is-loading', state === 'loading');
    setClass(button, 'is-listening', state === 'listening');
    setClass(button, 'is-thinking', state === 'thinking');
    setClass(button, 'is-paused', state === 'paused');
    setClass(button, 'is-blocked', state === 'blocked');
    button.setAttribute('aria-pressed', String(state === 'listening'));
    setVoiceLabel(VOICE_LABELS[state] || VOICE_LABELS.idle);
  }

  function setVoiceLabel(text) {
    el('voice-label').textContent = text;
  }

  el('voice-button').addEventListener('click', () => {
    if (view !== 'practice' || prefs.mode !== 'voice' || locked) return;

    if (micProblem) {
      micProblem = null;
      silenceCount = 0;
      wantListen = true;
      paused = false;
      el('voice-actions').hidden = true;
      el('voice-hint').textContent = '说完答案会自动进入下一题，点麦克风可暂停';
      setVoiceState('listening');
      if (engineNow() === 'offline') startOfflineVoice();
      else listen();
      return;
    }

    if (wantListen) {
      wantListen = false;
      pauseVoice();
      setVoiceState('paused');
      setVoiceLabel('已暂停');
      setFeedback('已暂停收音，点麦克风继续');
      el('voice-hint').textContent = '点麦克风继续收音';
    } else {
      startVoice();
      setFeedback('看着题目，直接说出答案');
    }
  });

  el('voice-retry').addEventListener('click', () => {
    micProblem = null;
    silenceCount = 0;
    wantListen = true;
    paused = false;
    el('voice-actions').hidden = true;
    el('voice-hint').textContent = '说完答案会自动进入下一题，点麦克风可暂停';
    setVoiceState('listening');
    if (engineNow() === 'offline') {
      stopOfflineVoice();
      startOfflineVoice();
    } else {
      listen();
    }
  });

  el('new-tab').addEventListener('click', () => {
    const win = window.open(location.href, '_blank', 'noopener');
    if (!win) setFeedback('浏览器拦住了新窗口，请手动在新标签页打开本页。', 'bad');
  });

  el('switch-mode').addEventListener('click', () => {
    prefs.mode = 'type';
    persist();
    syncSetup();
    stopVoice();
    applyModeLayout();
    el('feedback').className = 'feedback';
    setFeedback('已改用打字作答', '');
    el('answer').focus();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (view === 'practice') awaySince = performance.now();
      if (offlineSession) {
        /* 手机切走时先放掉麦克风（状态栏那个录音点会消失），回来再重开 */
        paused = true;
        stopOfflineVoice();
      }
      if (isListening) {
        paused = true;
        try {
          recognition.stop();
        } catch (_) {
          /* 已经停止 */
        }
      }
      return;
    }

    if (awaySince) {
      awayMs += performance.now() - awaySince;
      awaySince = 0;
    }
    if (view === 'practice' && prefs.mode === 'voice' && wantListen && !locked && !micProblem) {
      paused = false;
      if (engineNow() === 'offline') rescueOfflineVoice();
      else listen();
    }
  });

  /* 手机切回来（或用户点了继续）时，离线会话可能已经被系统收掉了，重建一次 */
  function rescueOfflineVoice() {
    if (offlineSession && offlineSession.running) {
      offlineSession.resume();
      return;
    }
    stopOfflineVoice();
    startOfflineVoice();
  }

  window.addEventListener('beforeunload', () => {
    stopOfflineVoice();
    if (recognition) {
      try {
        recognition.abort();
      } catch (_) {
        /* 已经停止 */
      }
    }
  });

  /* ------------------------------------------------------------------ */

  syncSetup();

  /* 第一次打开（或语音包还没装）先停在语音包这一步 */
  if (supportsOffline && !offlineReady() && prefs.packPrompt) {
    showView('welcome');
    Offline.probeSize(Offline.modelUrls[0]).then(() => syncVoiceUI()).catch(() => {});
  } else {
    showView('setup');
  }

  window.kousuanReady = true;
})();
