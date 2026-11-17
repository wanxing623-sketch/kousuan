(() => {
  const $ = (selector) => document.querySelector(selector);
  const setup = $('#setup');
  const practice = $('#practice');
  const results = $('#results');
  let mode = 'typing';
  let level = 'two';
  let targetCount = 10;
  let questionCount = 0;
  let answeredCount = 0;
  let correctCount = 0;
  let currentAnswer = 0;
  let locked = false;
  let recognition = null;
  let recognitionAvailable = false;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.interimResults = false;
    recognition.maxAlternatives = 3;
    recognitionAvailable = true;
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript.trim();
      $('#heard-text').textContent = `听到：${text}`;
      const value = parseSpokenNumber(text);
      if (value === null) {
        setFeedback('没听清数字，请再试一次。', 'bad');
        return;
      }
      $('#answer').value = value;
      checkAnswer();
    };
    recognition.onerror = (event) => {
      const message = event.error === 'not-allowed' ? '请在浏览器中允许使用麦克风。' : '语音识别暂不可用，请再试一次或改用打字作答。';
      setFeedback(message, 'bad');
      stopListening();
    };
    recognition.onend = stopListening;
  }
  $('#voice-support').hidden = recognitionAvailable;

  document.querySelectorAll('.mode-card').forEach((button) => button.addEventListener('click', () => {
    mode = button.dataset.mode;
    document.querySelectorAll('.mode-card').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  }));
  document.querySelectorAll('.difficulty-card').forEach((button) => button.addEventListener('click', () => {
    level = button.dataset.level;
    document.querySelectorAll('.difficulty-card').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  }));
  document.querySelectorAll('.quantity-option').forEach((button) => button.addEventListener('click', () => {
    targetCount = Number(button.dataset.count);
    document.querySelectorAll('.quantity-option').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
  }));

  $('#start-button').addEventListener('click', startSession);
  $('#again-button').addEventListener('click', startSession);
  $('#back-button').addEventListener('click', () => showView('setup'));
  $('#settings-button').addEventListener('click', () => showView('setup'));
  $('#quit-button').addEventListener('click', finishSession);
  $('#answer-form').addEventListener('submit', (event) => {
    event.preventDefault();
    checkAnswer();
  });
  $('#voice-button').addEventListener('click', toggleListening);

  function showView(view) {
    setup.hidden = view !== 'setup';
    practice.hidden = view !== 'practice';
    results.hidden = view !== 'results';
  }

  function startSession() {
    questionCount = 0;
    answeredCount = 0;
    correctCount = 0;
    locked = false;
    $('#score-label').textContent = '答对 0 题';
    $('#answer').value = '';
    $('#heard-text').textContent = '';
    showView('practice');
    $('#answer-form').hidden = mode !== 'typing';
    $('#voice-button').hidden = mode !== 'voice' || !recognitionAvailable;
    nextQuestion();
    if (mode === 'voice' && !recognitionAvailable) {
      setFeedback('当前浏览器不支持语音识别，请返回选择打字作答。', 'bad');
    }
    if (mode === 'typing') $('#answer').focus();
  }

  function makeQuestion() {
    let a, b;
    if (level === 'two') {
      a = randomInt(10, 99);
      b = randomInt(10, 99);
    } else if (level === 'mixed') {
      a = randomInt(100, 999);
      b = randomInt(10, 99);
    } else {
      a = randomInt(100, 999);
      b = randomInt(100, 999);
    }
    const subtract = Math.random() < .5;
    if (subtract) {
      if (b > a) [a, b] = [b, a];
      currentAnswer = a - b;
      return `${a} <span>−</span> ${b} <span>=</span> ?`;
    }
    currentAnswer = a + b;
    return `${a} <span>+</span> ${b} <span>=</span> ?`;
  }

  function nextQuestion() {
    if (targetCount > 0 && questionCount >= targetCount) {
      finishSession();
      return;
    }
    locked = false;
    questionCount += 1;
    $('#question').innerHTML = makeQuestion();
    $('#progress-label').textContent = targetCount > 0 ? `第 ${questionCount} / ${targetCount} 题` : `第 ${questionCount} 题`;
    $('#progress-fill').style.width = targetCount > 0 ? `${Math.min((questionCount - 1) / targetCount * 100, 100)}%` : `${Math.min((questionCount - 1) % 100, 99)}%`;
    $('#answer').value = '';
    $('#heard-text').textContent = '';
    setFeedback(mode === 'voice' ? '准备好后，按下按钮说出答案' : '仔细想一想，输入你的答案');
    if (mode === 'typing') $('#answer').focus();
  }

  function checkAnswer() {
    if (locked || practice.hidden) return;
    const raw = $('#answer').value.trim();
    if (!raw) {
      setFeedback('先输入答案，再确认哦。', 'bad');
      $('#answer').focus();
      return;
    }
    locked = true;
    answeredCount += 1;
    const correct = Number(raw) === currentAnswer;
    if (correct) {
      correctCount += 1;
      setFeedback('回答正确，真棒！', 'good');
    } else {
      setFeedback(`再接再厉，正确答案是 ${currentAnswer}`, 'bad');
    }
    $('#score-label').textContent = `答对 ${correctCount} 题`;
    window.setTimeout(nextQuestion, 900);
  }

  function finishSession() {
    if (recognition) {
      try { recognition.stop(); } catch (_) { /* Recognition may already be stopped. */ }
    }
    stopListening();
    if (questionCount === 0) {
      showView('setup');
      return;
    }
    const completed = answeredCount;
    const accuracy = completed ? Math.round(correctCount / completed * 100) : 0;
    $('#result-correct').textContent = String(correctCount);
    $('#result-total').textContent = String(completed);
    $('#result-accuracy').textContent = `${accuracy}%`;
    $('#result-message').textContent = accuracy === 100 ? '太棒了，全部答对！继续保持这份专注。' : accuracy >= 80 ? '表现很不错，继续保持这份好状态！' : '每一次练习都是进步，继续加油！';
    showView('results');
  }

  function setFeedback(message, kind = '') {
    const feedback = $('#feedback');
    feedback.textContent = message;
    feedback.className = `feedback ${kind}`.trim();
  }

  function toggleListening() {
    if (!recognitionAvailable || locked) return;
    if ($('#voice-button').classList.contains('listening')) {
      recognition.stop();
      return;
    }
    $('#heard-text').textContent = '';
    try {
      recognition.start();
      $('#voice-button').classList.add('listening');
      $('#voice-button').innerHTML = '<span aria-hidden="true">◉</span> 正在聆听… 点此停止';
      setFeedback('请清晰地说出答案');
    } catch (_) {
      setFeedback('语音识别正在启动，请稍候再试。', 'bad');
    }
  }

  function stopListening() {
    const button = $('#voice-button');
    if (!button) return;
    button.classList.remove('listening');
    button.innerHTML = '<span aria-hidden="true">🎙</span> 按下说出答案';
  }

  function parseSpokenNumber(text) {
    const normalized = text.replace(/[，。\s]/g, '');
    const arabic = normalized.match(/-?\d+/);
    if (arabic) return Number(arabic[0]);
    const digits = { '零': 0, '〇': 0, '一': 1, '幺': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };
    const units = { '十': 10, '百': 100, '千': 1000 };
    let total = 0;
    let section = 0;
    let number = 0;
    let found = false;
    for (const char of normalized) {
      if (Object.hasOwn(digits, char)) {
        number = digits[char];
        found = true;
      } else if (units[char]) {
        const unit = units[char];
        section += (number || (unit === 10 ? 1 : 0)) * unit;
        number = 0;
        found = true;
      } else if (char === '负') {
        continue;
      } else {
        return null;
      }
    }
    total += section + number;
    return found ? (normalized.startsWith('负') ? -total : total) : null;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
})();
