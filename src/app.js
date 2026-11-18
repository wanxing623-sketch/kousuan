(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 版本自检
   * 发布刚完成时，浏览器可能拿到「新页面 + 旧脚本」的组合：旧脚本按旧结构
   * 取元素会直接报错，表现为所有按钮都点不动。这里先确认结构对得上，
   * 对不上就带参数重新取一次页面。
   * ------------------------------------------------------------------ */

  const REQUIRED_IDS = ['welcome', 'pack-button', 'setup', 'practice', 'results', 'answer-form', 'question', 'voice-button'];
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
  const supportsSpeech = Boolean(Recognition) && window.isSecureContext !== false;
  const inFrame = window.self !== window.top;
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  const defaults = { mode: 'type', level: 'two', count: 10, welcomed: false, voiceEngine: 'browser' };
  let prefs = Object.assign({}, defaults);
  let best = {};

  let view = 'welcome';
  let packState = 'checking';
  let download = null;
  let offlineReady = false;
  let packRestriction;
  try { packRestriction = OfflineVoice.unsupported(); } catch (_) { packRestriction = '浏览器不允许保存离线资源，请在普通窗口打开。'; }
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

  const PACK_LABELS = {
    checking: ['检查中', '正在检查'], idle: ['未下载', '下载语音包'], downloading: ['安装中', '正在下载…'],
    ready: ['已下载', '使用离线语音 →'], error: ['未完成', '重试下载'], unsupported: ['不可用', '暂不支持'],
  };
  function setPackState(state, message) {
    packState = state;
    offlineReady = state === 'ready';
    el('pack-card').dataset.state = state;
    el('pack-state').textContent = PACK_LABELS[state][0];
    el('pack-button-label').textContent = PACK_LABELS[state][1];
    el('pack-button').disabled = ['checking', 'unsupported', 'downloading'].indexOf(state) !== -1;
    el('skip-label').textContent = state === 'downloading' ? '取消下载，先用打字' : '跳过，先用打字';
    el('pack-progress').hidden = state !== 'downloading';
    el('pack-message').textContent = message;
    el('pack-new-tab').hidden = !inFrame || (state !== 'error' && state !== 'unsupported');
    syncSetup();
  }
  async function checkPack(firstVisit) {
    setPackState('checking', '正在检查此设备上的语音包…');
    try {
      const ready = !packRestriction && await OfflineVoice.installed();
      if (download) return;
      if (packRestriction) setPackState('unsupported', packRestriction);
      else if (ready) setPackState('ready', '语音包已保存在此设备。进入练习设置，选好题目后即可开口作答。');
      else setPackState('idle', '建议使用 Wi-Fi，并预留 120 MB 空间。开始语音练习时再授权麦克风。');
    } catch (_) {
      setPackState('error', '无法读取本机缓存，请检查剩余空间，或在非无痕窗口重试。');
    }
    // 已选择本地识别的用户丢失缓存后，不能默默改用可能上传音频的原生服务。
    if (!offlineReady && (!supportsSpeech || prefs.voiceEngine === 'offline')) prefs.mode = 'type';
    syncSetup();
    if (firstVisit && prefs.welcomed && view === 'welcome') showView('setup');
  }
  function enterSetup(mode) {
    prefs.welcomed = true;
    prefs.mode = mode;
    if (mode === 'voice') prefs.voiceEngine = 'offline';
    persist();
    syncSetup();
    showView('setup');
  }
  el('pack-button').addEventListener('click', async () => {
    if (offlineReady) { enterSetup('voice'); return; }
    if (download || packRestriction || packState === 'checking') return;
    const job = download = new AbortController();
    const bar = el('pack-progress');
    bar.value = 0;
    setPackState('downloading', '正在准备离线页面…');
    try {
      let lastMessage = '';
      await OfflineVoice.install(job.signal, (bytes, verifying) => {
        if (job !== download) return;
        const percent = Math.floor(bytes / OfflineVoice.size * 100);
        const message = verifying ? '正在校验并保存到本机…' : `正在下载语音包 · ${percent}%`;
        if (message !== lastMessage) {
          bar.value = percent;
          el('pack-message').textContent = message;
          lastMessage = message;
        }
      });
      if (job === download) setPackState('ready', '已经准备好！进入练习设置，选择题目后再允许麦克风。');
    } catch (error) {
      if (job !== download) return;
      if (job.signal.aborted) { setPackState('idle', '下载已取消，可以重新下载。'); return; }
      const networkMessage = navigator.onLine === false ? '首次下载需要联网，请连接 Wi-Fi 后重试。' : '下载中断，请检查网络或换用 Wi-Fi 后重试。';
      const message = error.name === 'QuotaExceededError' ? '存储空间不足，请清理一些空间后重试。'
        : error instanceof TypeError ? networkMessage : error.message || '下载失败，请检查网络和剩余空间后重试。';
      setPackState('error', message);
    } finally {
      if (job === download) download = null;
    }
  });
  el('skip-pack').addEventListener('click', () => {
    if (download) {
      download.abort();
      download = null;
      setPackState('idle', '下载已取消，稍后可在这里继续。');
    }
    enterSetup('type');
  });
  el('manage-pack').addEventListener('click', () => { showView('welcome'); checkPack(false); });

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
    const voiceCard = document.querySelector('[data-mode="voice"]');
    voiceCard.disabled = !offlineReady && !supportsSpeech && Boolean(packRestriction);
    voiceCard.querySelector('small').textContent = offlineReady ? '离线识别 · 普通话'
      : supportsSpeech ? '浏览器识别 · 可能需要联网' : packRestriction ? '此浏览器不支持' : '先下载普通话语音包';
    el('voice-note').hidden = !voiceCard.disabled;
    el('voice-tip').hidden = prefs.mode !== 'voice';
    el('voice-tip').textContent = offlineReady ? '将使用本机语音包。开始后请允许麦克风。' : '将使用浏览器语音服务，可能会联网。需要离线识别可先安装语音包。';
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.disabled) return;
      if (button.dataset.mode === 'voice' && !offlineReady && !supportsSpeech) {
        showView('welcome');
        return;
      }
      prefs.mode = button.dataset.mode;
      if (prefs.mode === 'voice') prefs.voiceEngine = offlineReady ? 'offline' : 'browser';
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

  el('start-button').addEventListener('click', startSession);
  el('again-button').addEventListener('click', startSession);

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
    if (prefs.mode === 'voice' && !offlineReady && (prefs.voiceEngine === 'offline' || !supportsSpeech)) {
      showView('welcome');
      return;
    }
    clearTimeout(advanceTimer);
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

    if (prefs.mode === 'voice') startVoice();
    else if (finePointer) el('answer').focus(); // 手机使用页面内数字键盘，避免系统键盘遮挡题目
  }

  function applyModeLayout() {
    const isVoice = prefs.mode === 'voice';
    el('answer-form').hidden = isVoice;
    el('voice-area').hidden = !isVoice;
    el('practice').dataset.mode = prefs.mode;
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

  el('number-pad').addEventListener('click', (event) => {
    const button = event.target.closest('[data-key]');
    if (!button) return;
    if (locked) {
      advanceNow();
      return;
    }
    const input = el('answer');
    const key = button.dataset.key;
    if (key === 'clear') input.value = '';
    else if (key === 'backspace') input.value = input.value.slice(0, -1);
    else if (/^\d$/.test(key) && input.value.length < 4) input.value += key;
    if (key !== 'clear' && key !== 'backspace') setFeedback('');
    input.dispatchEvent(new Event('input', { bubbles: true }));
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
    el('view-label').textContent = { welcome: '练习准备', setup: '练习设置', practice: '练习中', results: '练习结果' }[next];
    el('setup').hidden = next !== 'setup';
    el('practice').hidden = next !== 'practice';
    el('results').hidden = next !== 'results';
    if (next === 'welcome' || next === 'setup') el(next + '-title').focus();
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

  function createRecognition() {
    let instance;
    const active = () => recognition === instance && wantListen && !paused && !locked && !document.hidden && view === 'practice';
    function started() {
      if (!active()) return;
      isListening = true;
      hasStarted = true;
      micProblem = null;
      setVoiceState('listening');
    }
    function transcript(alternatives, final) {
      if (!active() || !alternatives.length || !alternatives[0].trim()) return;
      silenceCount = 0;
      const heard = alternatives[0].trim().replace(/<unk>/ig, '…');
      if (el('heard-text').textContent !== heard) el('heard-text').textContent = heard;
      if (!final) return;
      for (const text of alternatives) {
        if (/<unk>/i.test(text)) continue; // 有未听清的音节时不拿残缺的数字判分
        const value = parseSpokenNumber(text);
        if (value !== null) { submit(value); return; }
      }
      setFeedback('没听清，再说一次', 'bad');
    }
    function failed(code) {
      if (!active() || code === 'aborted') return;
      if (code === 'no-speech') {
        silenceCount += 1;
        if (silenceCount >= 3) pausePrompt('没听到声音，点麦克风继续', '继续收音');
        else setFeedback('没听到声音，再说一次', 'bad');
      } else if (code === 'not-allowed' || code === 'service-not-allowed') {
        failVoice('麦克风没有打开。允许权限后重试，或改用打字作答。');
      } else if (code === 'audio-capture') {
        failVoice('没有找到可用的麦克风。');
      } else if (code === 'offline-engine') {
        failVoice('离线识别未能启动，请检查存储空间，或返回设置检查语音包。也可以改用打字。', true);
      } else if (code === 'network') {
        failVoice(inFrame ? '预览窗口里语音服务连不上，可以点「在新窗口打开」再试。' : '浏览器语音服务连不上，可返回设置下载离线语音包。');
      } else {
        failVoice('语音识别出了点问题，可以重试或改用打字作答。');
      }
    }
    if (offlineReady) {
      instance = OfflineVoice.listener({ start: started, text: transcript, error: failed });
      return instance;
    }
    instance = new Recognition();
    instance.lang = 'zh-CN';
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 5;
    instance.onstart = started;
    instance.onerror = event => failed(event.error);
    instance.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length && !locked; i += 1) {
        const result = event.results[i];
        transcript(Array.from(result, item => item.transcript || ''), result.isFinal);
      }
    };
    instance.onend = () => {
      if (recognition !== instance) return;
      isListening = false;
      if (active() && !micProblem) scheduleRestart(200);
      else if (wantListen && !micProblem && !locked) setVoiceState('paused');
    };
    return instance;
  }

  function listen() {
    if (!wantListen || paused || locked || document.hidden || view !== 'practice') return;
    clearTimeout(restartTimer);
    try {
      if (!recognition) recognition = createRecognition();
      if (offlineReady) setVoiceState('preparing');
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

  function startVoice() {
    el('voice-engine').textContent = offlineReady ? '离线语音 · 普通话' : '浏览器语音服务';
    wantListen = true;
    paused = false;
    micProblem = null;
    silenceCount = 0;
    hasStarted = false;
    el('heard-text').textContent = '';
    el('voice-actions').hidden = true;
    el('new-tab').hidden = !inFrame;
    el('voice-hint').textContent = '说完答案会自动进入下一题，点麦克风可暂停';
    el('feedback').className = 'feedback';
    setFeedback('看着题目，直接说出答案');
    setVoiceState('listening');
    listen();
  }

  function abortMic() {
    clearTimeout(restartTimer);
    if (recognition) {
      try { recognition.abort(); } catch (_) { /* 已经停止 */ }
    }
    isListening = false;
  }

  function pauseVoice(release) {
    paused = true;
    clearTimeout(restartTimer);
    if (release) abortMic();
    else if (recognition && recognition.hold) recognition.hold();
    else if (recognition && isListening) {
      try { recognition.stop(); } catch (_) { /* 已经停止 */ }
    }
    setVoiceState(wantListen ? 'thinking' : 'idle');
  }

  function resumeVoice() {
    if (!wantListen || micProblem || document.hidden) return;
    paused = false;
    el('heard-text').textContent = '';
    listen();
  }

  function stopVoice() {
    wantListen = false;
    paused = true;
    micProblem = null;
    clearTimeout(restartTimer);
    const previous = recognition;
    recognition = null;
    if (previous) {
      try {
        if (previous.dispose) previous.dispose(); else previous.abort();
      } catch (_) { /* 已经停止 */ }
    }
    isListening = false;
    setVoiceState('idle');
  }

  function pausePrompt(message, label) {
    wantListen = true;
    paused = true;
    micProblem = 'prompt';
    abortMic();
    setVoiceState('paused');
    setVoiceLabel('点一下继续');
    el('voice-hint').textContent = message;
    el('voice-retry').textContent = label;
    el('voice-actions').hidden = false;
    el('new-tab').hidden = !inFrame;
  }

  function failVoice(message, engineFailed) {
    wantListen = false;
    paused = true;
    micProblem = 'failed';
    abortMic();
    setVoiceState('blocked');
    setVoiceLabel(engineFailed ? '离线识别未启动' : '麦克风未开启');
    el('voice-hint').textContent = message;
    el('voice-retry').textContent = engineFailed ? '重试离线识别' : '重新打开麦克风';
    el('voice-actions').hidden = false;
    el('new-tab').hidden = !inFrame;
  }

  const VOICE_LABELS = {
    preparing: '正在准备本机识别…',
    listening: '正在聆听…',
    thinking: '已听到',
    paused: '点一下继续',
    idle: '开始聆听',
    blocked: '麦克风未开启',
  };

  function setVoiceState(state) {
    const button = el('voice-button');
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
      listen();
      return;
    }

    if (wantListen) {
      wantListen = false;
      pauseVoice(true);
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
    listen();
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
      if (recognition && offlineReady && wantListen && !micProblem) {
        // iOS 从后台回来时通常需要新的用户手势才能解锁 AudioContext。
        pausePrompt('切到后台时已关闭麦克风，点一下继续本题', '继续收音');
      } else if (recognition) {
        paused = true;
        abortMic();
      }
      return;
    }

    if (awaySince) {
      awayMs += performance.now() - awaySince;
      awaySince = 0;
    }
    if (view === 'practice' && prefs.mode === 'voice' && wantListen && !locked && !micProblem) {
      paused = false;
      listen();
    }
  });

  window.addEventListener('pagehide', () => {
    if (download) download.abort();
    stopVoice();
  });

  syncSetup();
  checkPack(true);
  window.kousuanReady = true;
})();
