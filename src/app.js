(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 版本自检
   * 发布刚完成时，浏览器可能拿到「新页面 + 旧脚本」的组合：旧脚本按旧结构
   * 取元素会直接报错，表现为所有按钮都点不动。这里先确认结构对得上，
   * 对不上就带参数重新取一次页面。
   * ------------------------------------------------------------------ */

  const REQUIRED_IDS = ['welcome', 'pack-button', 'setup', 'practice', 'results', 'answer-form', 'question', 'voice-button', 'near-toggle', 'bubble-area', 'bubble-field'];
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

  // nearMode：离线语音的收音范围（strong 只听面前 / standard 近处说话 / off 不过滤）；
  // nearLevels：最近几次答对时的说话音量（dBFS），用来校准门限，只存在本机。
  const defaults = { mode: 'type', level: 'two', count: 10, welcomed: false, voiceEngine: 'browser', nearMode: 'strong' };
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
  let bubbleGame = null;
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

  if (['type', 'voice', 'bubble'].indexOf(prefs.mode) === -1) prefs.mode = defaults.mode;
  if (['two', 'mixed', 'three'].indexOf(prefs.level) === -1) prefs.level = defaults.level;
  if ([0, 10, 20, 30].indexOf(prefs.count) === -1) prefs.count = defaults.count;
  if (['strong', 'standard', 'off'].indexOf(prefs.nearMode) === -1) prefs.nearMode = defaults.nearMode;
  prefs.nearLevels = (Array.isArray(prefs.nearLevels) ? prefs.nearLevels : [])
    .filter((level) => typeof level === 'number' && level > -100 && level < 0).slice(-5);

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
    el('voice-tip').textContent = offlineReady ? '将使用本机语音包，默认只听面前的说话声。开始后允许麦克风，只说数字即可。' : '将使用浏览器语音服务，可能会联网。只说数字；安装离线语音包后可离线识别，并过滤远处的人声。';
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
    stopBubbles();
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
    const isBubble = prefs.mode === 'bubble';
    el('answer-form').hidden = isVoice || isBubble;
    el('keypad-hint').hidden = isVoice || isBubble;
    el('number-pad').hidden = isVoice || isBubble;
    el('voice-area').hidden = !isVoice;
    el('bubble-area').hidden = !isBubble;
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
    setFeedback(prefs.mode === 'voice' ? '看着题目，只说数字'
      : prefs.mode === 'bubble' ? '点击正确的数字球通过这一题' : '仔细想一想，输入你的答案');
    el('question').classList.remove('shake');
    updateMeta();

    if (prefs.mode === 'voice') {
      resumeVoice();
    } else if (prefs.mode === 'bubble') {
      renderBubbles();
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

  const BUBBLE_PALETTE = ['sage', 'blue', 'sand', 'rose', 'moss', 'plum'];
  const BUBBLE_STEP = 1000 / 60;

  function bubbleVelocity() {
    const angle = Math.random() * Math.PI * 2;
    const speed = .58 + Math.random() * .48;
    return { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
  }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function setBubblePosition(ball) {
    if (ball.body) {
      ball.x = ball.body.position.x - ball.radius;
      ball.y = ball.body.position.y - ball.radius;
    }
    const x = Math.round(ball.x), y = Math.round(ball.y);
    if (x === ball.renderX && y === ball.renderY) return;
    ball.renderX = x;
    ball.renderY = y;
    ball.node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  function stopBubbles() {
    if (bubbleGame && bubbleGame.frame) cancelAnimationFrame(bubbleGame.frame);
    if (bubbleGame && bubbleGame.resizeObserver) bubbleGame.resizeObserver.disconnect();
    if (bubbleGame && bubbleGame.onResize) window.removeEventListener('resize', bubbleGame.onResize);
    if (bubbleGame) bubbleGame.bubbles.forEach(ball => { if (ball.removeTimer) clearTimeout(ball.removeTimer); });
    if (bubbleGame && bubbleGame.engine) window.Matter.Engine.clear(bubbleGame.engine);
    bubbleGame = null;
    const field = el('bubble-field');
    if (field) while (field.firstChild) field.removeChild(field.firstChild);
  }

  function bubbleAnswerOptions(answer) {
    const maximum = prefs.level === 'two' ? 198 : prefs.level === 'mixed' ? 1098 : 1998;
    const values = new Set([answer]);
    const spread = prefs.level === 'two' ? 42 : 88;
    for (let tries = 0; values.size < 9 && tries < 200; tries += 1) {
      const candidate = clamp(answer + randomInt(-spread, spread), 0, maximum);
      if (candidate !== answer) values.add(candidate);
    }
    while (values.size < 9) values.add(randomInt(0, maximum));
    const options = Array.from(values);
    for (let i = options.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i);
      [options[i], options[j]] = [options[j], options[i]];
    }
    return options;
  }

  function chooseBubble(value, node) {
    if (locked || view !== 'practice' || prefs.mode !== 'bubble' || !session || node.classList.contains('is-disappearing')) return;
    if (value === session.current.answer) {
      node.classList.add('is-correct');
      submit(value);
      return;
    }
    setFeedback('不是这个数字，再找找看', 'bad');
    node.classList.add('is-wrong', 'is-disappearing');
    const game = bubbleGame;
    const ball = game && game.bubbles.find(item => item.node === node);
    if (!ball) { setTimeout(() => node.remove(), 320); return; }
    ball.removeTimer = setTimeout(() => {
      if (bubbleGame !== game) return;
      window.Matter.Composite.remove(game.engine.world, ball.body);
      const index = game.bubbles.indexOf(ball);
      if (index !== -1) game.bubbles.splice(index, 1);
      node.remove();
    }, 320);
  }

  function resetBubbleWalls(game, width, height) {
    const Matter = window.Matter;
    game.walls.forEach(wall => Matter.Composite.remove(game.engine.world, wall));
    const thickness = 100;
    game.walls = [
      Matter.Bodies.rectangle(width / 2, -thickness / 2, width + thickness * 2, thickness, { isStatic: true, restitution: .9 }),
      Matter.Bodies.rectangle(width / 2, height + thickness / 2, width + thickness * 2, thickness, { isStatic: true, restitution: .9 }),
      Matter.Bodies.rectangle(-thickness / 2, height / 2, thickness, height + thickness * 2, { isStatic: true, restitution: .9 }),
      Matter.Bodies.rectangle(width + thickness / 2, height / 2, thickness, height + thickness * 2, { isStatic: true, restitution: .9 }),
    ];
    Matter.Composite.add(game.engine.world, game.walls);
    game.width = width;
    game.height = height;
  }

  function resizeBubbleGame(game, width, height) {
    if (!width || !height || bubbleGame !== game
      || (Math.abs(width - game.width) <= 1 && Math.abs(height - game.height) <= 1)) return;
    resetBubbleWalls(game, width, height);
    game.bubbles.forEach(ball => {
      const x = clamp(ball.body.position.x, ball.radius, width - ball.radius);
      const y = clamp(ball.body.position.y, ball.radius, height - ball.radius);
      window.Matter.Body.setPosition(ball.body, { x, y });
    });
  }

  function watchBubbleSize(game) {
    if (window.ResizeObserver) {
      game.resizeObserver = new ResizeObserver(() => {
        resizeBubbleGame(game, game.field.clientWidth, game.field.clientHeight);
      });
      game.resizeObserver.observe(game.field);
    } else {
      game.onResize = () => resizeBubbleGame(game, game.field.clientWidth, game.field.clientHeight);
      window.addEventListener('resize', game.onResize);
    }
  }

  function renderBubbles() {
    stopBubbles();
    const field = el('bubble-field');
    const width = field.clientWidth;
    const height = field.clientHeight;
    if (!width || !height || !session) return;

    const options = bubbleAnswerOptions(session.current.answer);
    const columns = 3;
    const rows = Math.ceil(options.length / columns);
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const slots = options.map((_, i) => i);
    for (let i = slots.length - 1; i > 0; i -= 1) {
      const j = randomInt(0, i);
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    const Matter = window.Matter;
    const engine = Matter.Engine.create({ enableSleeping: false });
    engine.gravity.x = 0;
    engine.gravity.y = 0;
    engine.positionIterations = 4;
    engine.velocityIterations = 3;
    const game = bubbleGame = { field, bubbles: [], width, height, frame: 0, lastFrame: 0, accumulator: 0, engine, walls: [] };
    resetBubbleWalls(game, width, height);
    options.forEach((value, i) => {
      const slot = slots[i];
      const col = slot % columns;
      const row = Math.floor(slot / columns);
      const size = Math.max(58, Math.min(randomInt(70, 86), cellWidth - 8, cellHeight - 8));
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'number-bubble';
      node.dataset.value = String(value);
      node.dataset.tone = BUBBLE_PALETTE[randomInt(0, BUBBLE_PALETTE.length - 1)];
      node.setAttribute('aria-label', `数字 ${value}`);
      node.textContent = String(value);
      node.style.width = `${size}px`;
      node.style.height = `${size}px`;
      node.style.fontSize = size < 68 ? '18px' : size < 78 ? '20px' : '22px';
      field.appendChild(node);

      const ball = {
        node,
        value,
        size,
        radius: size / 2,
        x: clamp(col * cellWidth + (cellWidth - size) / 2 + randomInt(-7, 7), 0, width - size),
        y: clamp(row * cellHeight + (cellHeight - size) / 2 + randomInt(-7, 7), 0, height - size),
        nextSteerAt: performance.now() + randomInt(900, 1700),
      };
      ball.body = Matter.Bodies.circle(ball.x + ball.radius, ball.y + ball.radius, ball.radius, {
        restitution: .84,
        friction: .006,
        frictionAir: .0015,
        density: .001,
        slop: .02,
      });
      Matter.Composite.add(engine.world, ball.body);
      if (!reducedMotion) Matter.Body.setVelocity(ball.body, bubbleVelocity());
      game.bubbles.push(ball);
      setBubblePosition(ball);

      node.addEventListener('click', () => chooseBubble(ball.value, node));
    });

    watchBubbleSize(game);
    if (!reducedMotion) startBubbleAnimation();
  }

  function startBubbleAnimation() {
    if (!bubbleGame || bubbleGame.frame || reducedMotion || document.hidden) return;
    const tick = now => {
      const game = bubbleGame;
      if (!game || document.hidden || view !== 'practice' || prefs.mode !== 'bubble') {
        if (game) game.frame = 0;
        return;
      }
      const delta = game.lastFrame ? Math.min(now - game.lastFrame, 50) : BUBBLE_STEP;
      game.lastFrame = now;
      game.accumulator += delta;
      while (game.accumulator >= BUBBLE_STEP) {
        window.Matter.Engine.update(game.engine, BUBBLE_STEP);
        game.accumulator -= BUBBLE_STEP;
      }
      game.bubbles.forEach(ball => {
        if (now >= ball.nextSteerAt) {
          const velocity = ball.body.velocity;
          const angle = Math.atan2(velocity.y, velocity.x) + (Math.random() - .5) * .6;
          const speed = clamp(Math.hypot(velocity.x, velocity.y) + (Math.random() - .5) * .12, .58, 1.06);
          window.Matter.Body.setVelocity(ball.body, { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed });
          ball.nextSteerAt = now + randomInt(1100, 2200);
        }
        setBubblePosition(ball);
      });
      game.frame = requestAnimationFrame(tick);
    };
    bubbleGame.frame = requestAnimationFrame(tick);
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
    if (next !== 'practice') stopBubbles();
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

  // 数字解析见 spoken-number.js：只接受合乎说法的完整数字（八十三、一百零五、两百五、八三、83）。

  /* 近讲收音（仅离线语音）：只把面前的说话声送去识别，见 near-voice.js。 */
  const NEAR_MODES = {
    strong: ['只听面前', '只听贴近手机说的话，稍远的人声会被过滤'],
    standard: ['近处说话', '一臂之内说话都能识别，更远的人声会被过滤'],
    off: ['不过滤', '所有声音都送去识别，周围有人说话时易误识别'],
  };
  const NEAR_ORDER = ['strong', 'standard', 'off'];
  let nearIgnored = 0;
  let nearIgnoredMark = 0;

  function renderNearToggle() {
    const label = NEAR_MODES[prefs.nearMode][0];
    const button = el('near-toggle');
    button.dataset.near = prefs.nearMode; // 不能用 data-mode：设置页的练习方式按钮靠它识别
    button.setAttribute('aria-label', `收音范围：${label}，点按切换`);
    el('near-toggle-label').textContent = `收音：${label}`;
    el('near-count').textContent = prefs.nearMode !== 'off' && nearIgnored > 0 ? `已过滤 ${nearIgnored} 段` : '';
  }

  function resetNearMeter() {
    el('near-level').style.transform = 'scaleX(0)';
    el('near-mark').hidden = true;
    setClass(el('near-meter'), 'is-open', false);
  }

  // 音量条：-70 dBFS 到 -10 dBFS。竖线是门限，条变绿表示这段声音正送去识别。
  function showNearMeter(meter) {
    if (view !== 'practice' || prefs.mode !== 'voice' || !meter) return;
    const ratio = (value) => Math.max(0, Math.min(1, (value + 70) / 60));
    el('near-level').style.transform = `scaleX(${ratio(meter.level).toFixed(3)})`;
    el('near-mark').hidden = meter.mode === 'off';
    if (meter.mode !== 'off') el('near-mark').style.left = `${(ratio(meter.threshold) * 100).toFixed(1)}%`;
    setClass(el('near-meter'), 'is-open', meter.open);
    if (meter.ignored !== nearIgnored) {
      nearIgnored = meter.ignored;
      renderNearToggle();
    }
  }

  // 答对时记下这次的说话音量。只在答对时记：远处的闲聊几乎不可能恰好说中答案，
  // 门限因此跟着你自己的声音走，而不会被周围的人带偏。
  function rememberVoiceLevel(level) {
    if (typeof level !== 'number' || !isFinite(level)) return;
    prefs.nearLevels = prefs.nearLevels.concat(level).slice(-5);
    persist();
    if (recognition && recognition.setNearVoice) recognition.setNearVoice({ voiceLevel: nearVoiceLevel(prefs.nearLevels) });
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
    function transcript(alternatives, final, meta) {
      if (!active() || !alternatives.length || !alternatives[0].trim()) return;
      silenceCount = 0;
      nearIgnoredMark = nearIgnored;
      const heard = alternatives[0].trim().replace(/<unk>/ig, '');
      const numericHeard = SpokenNumber.isNumeric(heard) ? SpokenNumber.normalize(heard) : '';
      if (el('heard-text').textContent !== numericHeard) el('heard-text').textContent = numericHeard;
      if (!final) return;
      for (const text of alternatives) {
        const value = SpokenNumber.parse(text);
        if (value === null) continue;
        const question = session && session.current;
        if (submit(value) && meta && question && value === question.answer) rememberVoiceLevel(meta.level);
        return;
      }
      setFeedback(numericHeard ? '没听清，请再说一次' : '只识别数字，请再说一次', 'bad');
    }
    function failed(code) {
      if (!active() || code === 'aborted') return;
      if (code === 'no-speech') {
        silenceCount += 1;
        // 这段时间里过滤掉了较远处的声音：提示靠近手机，而不是说「没听到」。
        const filtered = nearIgnored > nearIgnoredMark;
        nearIgnoredMark = nearIgnored;
        if (silenceCount >= 3) {
          pausePrompt(filtered ? '只听到较远处的声音，已过滤。若是你在说，请靠近手机，或点「收音」放宽范围' : '没听到声音，点麦克风继续', '继续收音');
        } else {
          setFeedback(filtered ? '只听到远处的声音，请靠近手机再说' : '没听到声音，再说一次', 'bad');
        }
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
      nearIgnored = 0;
      nearIgnoredMark = 0;
      instance = OfflineVoice.listener({ start: started, text: transcript, error: failed, meter: showNearMeter },
        { nearVoice: { mode: prefs.nearMode, voiceLevel: nearVoiceLevel(prefs.nearLevels) } });
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
    el('voice-hint').textContent = '只说数字，识别后自动进入下一题；点麦克风可暂停';
    // 近讲收音需要直接处理麦克风声音，只有离线语音可用。
    el('near-meter').hidden = !offlineReady;
    el('near-toggle').hidden = !offlineReady;
    resetNearMeter();
    renderNearToggle();
    el('feedback').className = 'feedback';
    setFeedback('看着题目，只说数字');
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
      el('voice-hint').textContent = '只说数字，识别后自动进入下一题；点麦克风可暂停';
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
      setFeedback('看着题目，只说数字');
    }
  });

  // 收音范围：只听面前 → 近处说话 → 不过滤。和麦克风按钮一样，反馈显示期间不响应。
  el('near-toggle').addEventListener('click', () => {
    if (view !== 'practice' || prefs.mode !== 'voice' || locked) return;
    const next = NEAR_ORDER[(NEAR_ORDER.indexOf(prefs.nearMode) + 1) % NEAR_ORDER.length];
    prefs.nearMode = next;
    prefs.nearLevels = []; // 换了收音方式就重新校准：下一次答对时记下你的音量
    persist();
    renderNearToggle();
    if (!micProblem) el('voice-hint').textContent = NEAR_MODES[next][1];
    if (!recognition || !recognition.setNearVoice) return;
    // 开 / 关过滤会改变麦克风的自动增益，要重新打开麦克风；趁这次点按做（iOS 要求用户手势）。
    // 暂停时麦克风已经关闭，下次打开就会用新设置。
    if (recognition.setNearVoice({ mode: next, voiceLevel: null }) && wantListen && !paused && !micProblem) {
      abortMic();
      listen();
    }
  });

  el('voice-retry').addEventListener('click', () => {
    micProblem = null;
    silenceCount = 0;
    wantListen = true;
    paused = false;
    el('voice-actions').hidden = true;
    el('voice-hint').textContent = '只说数字，识别后自动进入下一题；点麦克风可暂停';
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
      if (bubbleGame && bubbleGame.frame) {
        cancelAnimationFrame(bubbleGame.frame);
        bubbleGame.frame = 0;
      }
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
    if (view === 'practice' && prefs.mode === 'bubble') startBubbleAnimation();
  });

  window.addEventListener('pagehide', () => {
    if (download) download.abort();
    stopVoice();
    stopBubbles();
  });

  syncSetup();
  checkPack(true);
  window.kousuanReady = true;
})();
