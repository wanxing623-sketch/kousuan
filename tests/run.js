#!/usr/bin/env node
/*
 * 回归测试：把 index.html 放进 jsdom 里跑，验证离线语音包的下载流程、
 * 识别引擎切换、练习流程和移动端结构。
 *
 * 真机上 WASM 识别没法在这里跑（需要 Worker + AudioContext），所以用一个
 * 「假的 Vosk」和「假的麦克风」把 src/offline-asr.js 的控制流走通：
 * 下载 → 缓存标记 → 建模型 → 起会话 → 拿到文本 → 判题。
 *
 *   node tests/run.js            # 全部
 *   node tests/run.js --verbose  # 打印每一步
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const verbose = process.argv.includes('--verbose');

let passed = 0;
const failures = [];

function ok(name) {
  passed += 1;
  if (verbose) console.log(`  ✓ ${name}`);
}

function test(name, fn) {
  try {
    fn();
    ok(name);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error && error.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  ✗ ${name}\n    ${error && error.message}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 浏览器自带识别的最小替身：只记录 start/abort 调用，用来判断有没有换引擎 */
function makeSpeechRecognition(calls) {
  return class FakeSpeechRecognition {
    constructor() {
      this.lang = '';
      this.continuous = false;
      this.interimResults = false;
      this.maxAlternatives = 1;
      this.calls = calls;
    }

    start() {
      calls.starts += 1;
      if (this.onstart) this.onstart();
    }

    abort() {
      calls.aborts += 1;
      if (this.onend) this.onend();
    }

    stop() {
      calls.stops += 1;
      if (this.onend) this.onend();
    }
  };
}

/* ------------------------------------------------------------------ *
 * 测试环境：假麦克风 + 假 Vosk
 * ------------------------------------------------------------------ */

function fakeStream() {
  const track = { stop() {}, kind: 'audio' };
  return { getTracks: () => [track] };
}

function installEnvironment(window, options = {}) {
  const state = {
    modelUrls: [],
    recognizers: [],
    sessions: 0,
    text: options.text || '四十七',
    terminateCount: 0,
  };

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = {};
    }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createScriptProcessor() {
      if (options.brokenProcessor) throw new Error('processor unavailable');
      const node = {
        onaudioprocess: null,
        connect() {
          state.processor = node;
        },
        disconnect() {},
      };
      state.processor = node;
      return node;
    }

    resume() {
      return Promise.resolve();
    }

    close() {
      return Promise.resolve();
    }
  }

  class FakeRecognizer {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.handlers = {};
      this.removed = false;
      state.recognizers.push(this);
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    acceptWaveformFloat(buffer) {
      state.lastChunk = buffer;
      if (buffer.length && buffer.some((value) => value > 0.02)) {
        this.emitResult();
      }
    }

    emitResult() {
      if (this.removed) return;
      if (this.handlers.partialresult) {
        this.handlers.partialresult({ result: { partial: state.text } });
      }
      if (this.handlers.result) {
        this.handlers.result({ result: { text: state.text } });
      }
    }

    retrieveFinalResult() {}

    remove() {
      this.removed = true;
    }
  }

  class FakeModel {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      state.modelUrls.push(url);
      const shouldFail = options.failFirst
        ? state.modelUrls.length === 1
        : (options.failUrls && options.failUrls.some((part) => url.indexOf(part) !== -1));
      if (shouldFail) {
        setTimeout(() => {
          if (this.handlers.error) this.handlers.error({ error: 'HTTP error! status: 404' });
        }, 5);
      } else {
        setTimeout(() => {
          if (this.handlers.load) this.handlers.load({ result: true });
        }, 5);
      }
    }

    on(event, handler) {
      this.handlers[event] = handler;
    }

    get KaldiRecognizer() {
      return FakeRecognizer;
    }

    terminate() {
      state.terminateCount += 1;
    }
  }

  window.Vosk = {
    Model: FakeModel,
    createModel: () => Promise.resolve(new FakeModel('x')),
  };
  window.AudioContext = FakeAudioContext;
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: () => {
        state.sessions += 1;
        if (options.denyMic) {
          const error = new Error('denied');
          error.name = 'NotAllowedError';
          return Promise.reject(error);
        }
        return Promise.resolve(fakeStream());
      },
    },
  });
  window.fetch = () => Promise.resolve({
    ok: true,
    headers: { get: () => String(43 * 1024 * 1024) },
  });

  if (options.noSpeechRecognition) {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
  } else {
    window.SpeechRecognition = options.speechRecognition;
  }

  return state;
}

function loadPage(options = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  virtualConsole.on('error', (...args) => errors.push(new Error(args.join(' '))));

  const dom = new JSDOM(HTML, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://example.test/kousuan/',
    virtualConsole,
    beforeParse(window) {
      if (options.savedPack) {
        window.localStorage.setItem('kousuan:voicepack:v1', JSON.stringify({
          ready: true,
          url: 'models/vosk-model-small-cn.tar.gz',
        }));
      }
      window.__state = installEnvironment(window, options);
      window.matchMedia = window.matchMedia || (() => ({
        matches: false,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
      }));
      window.scrollTo = () => {};
    },
  });

  return { dom, window: dom.window, errors };
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

(async function run() {
  console.log('回归测试（jsdom）');

  /* 1. 首屏结构 ---------------------------------------------------- */
  const { window, errors } = loadPage();
  const doc = window.document;
  const $ = (id) => doc.getElementById(id);

  await wait(30);

  test('脚本跑起来了（window.kousuanReady）', () => {
    assert.strictEqual(window.kousuanReady, true);
  });

  test('首次打开停在离线语音包页面', () => {
    assert.strictEqual($('welcome').hidden, false);
    assert.strictEqual($('setup').hidden, true);
  });

  test('页面里带上了离线识别模块', () => {
    assert.ok(window.KousuanOffline, 'KousuanOffline 未定义');
    assert.strictEqual(typeof window.KousuanOffline.createSession, 'function');
  });

  test('离线能力检测走通（有 WebAssembly + AudioContext + 麦克风）', () => {
    assert.strictEqual(window.KousuanOffline.supported(), true);
    assert.strictEqual(window.KousuanOffline.state(), 'idle');
  });

  test('「稍后再下载」进入设置页，并且记住不再打扰', () => {
    $('welcome-skip').click();
    assert.strictEqual($('setup').hidden, false);
    const saved = JSON.parse(window.localStorage.getItem('kousuan:v1'));
    assert.strictEqual(saved.prefs.packPrompt, false);
  });

  test('设置页出现「识别方式」和语音包状态', () => {
    /* 只有同时支持「浏览器在线」和「离线」两种时才显示对比选择 */
    assert.strictEqual($('engine-choice').hidden, !(window.SpeechRecognition && window.KousuanOffline.supported()));
    assert.strictEqual($('pack-row').hidden, false);
    assert.strictEqual($('pack-status').textContent.indexOf('还没下载'), 0);
  });

  await testAsync('同源模型地址 HEAD 探测到真实体积', async () => {
    await wait(20);
    assert.ok(window.KousuanOffline.sizeHint() > 0, '没有拿到文件体积');
  });

  /* 2. 下载离线语音包 ---------------------------------------------- */
  await testAsync('点「下载」→ 建模型 → 标成已下载', async () => {
    $('pack-action').click();
    await wait(80);
    assert.ok(window.__state.modelUrls.length >= 1, '没有请求模型');
    assert.strictEqual(window.KousuanOffline.state(), 'ready');
    assert.strictEqual($('pack-action').textContent, '已装好');
    const saved = JSON.parse(window.localStorage.getItem('kousuan:voicepack:v1'));
    assert.strictEqual(saved.ready, true);
  });

  test('切到离线识别并记住', () => {
    doc.querySelector('[data-engine="offline"]').click();
    const saved = JSON.parse(window.localStorage.getItem('kousuan:v1'));
    assert.strictEqual(saved.prefs.engine, 'offline');
  });

  /* 3. 打字练习全流程 ---------------------------------------------- */
  test('打字作答：答对进下一题', async () => {
    doc.querySelector('[data-mode="type"]').click();
    $('start-button').click();
    assert.strictEqual($('practice').hidden, false);
    const question = $('question').textContent;
    const numbers = question.match(/\d+/g).map(Number);
    const answer = question.indexOf('+') !== -1 ? numbers[0] + numbers[1] : numbers[0] - numbers[1];
    $('answer').value = String(answer);
    $('answer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.strictEqual($('feedback').textContent, '答对了');
    assert.strictEqual($('answer-dock').hidden, false);
  });

  await testAsync('打字作答：答错给出正确答案', async () => {
    await wait(700); /* 上一题的「答对了」反馈结束后才能再答 */
    const question = $('question').textContent;
    const numbers = question.match(/\d+/g).map(Number);
    const truth = question.indexOf('+') !== -1 ? numbers[0] + numbers[1] : numbers[0] - numbers[1];
    $('answer').value = String(truth + 7);
    doc.getElementById('answer-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    assert.strictEqual($('feedback').textContent, `正确答案是 ${truth}`);
  });

  await testAsync('结束练习能看到成绩', async () => {
    await wait(1800); /* 答错后的反馈停留 1.7 秒 */
    $('quit-button').click();
    assert.strictEqual($('results').hidden, false);
    assert.ok(Number($('result-total').textContent) >= 2);
  });

  /* 4. 语音练习：离线引擎 ------------------------------------------ */
  await testAsync('离线语音：麦克风 → 16 kHz → 判题', async () => {
    $('settings-button').click();
    doc.querySelector('[data-mode="voice"]').click();
    $('start-button').click();
    await wait(60);
    assert.strictEqual($('practice').hidden, false);
    assert.strictEqual($('answer-dock').hidden, true, '语音模式不应显示输入框');
    assert.ok(window.__state.processor, '没有接到麦克风');
    assert.strictEqual($('offline-badge').hidden, false);

    /* 说出正确答案（用阿拉伯数字模拟识别结果） */
    const question = $('question').textContent;
    const numbers = question.match(/\d+/g).map(Number);
    window.__state.text = String(question.indexOf('+') !== -1 ? numbers[0] + numbers[1] : numbers[0] - numbers[1]);

    /* 模拟一段有声音的 48 kHz 音频：应被降到 16 kHz 再送进识别器 */
    const samples = new Float32Array(48000);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin(i / 10) * 0.5;
    window.__state.processor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
    await wait(40);

    const recognizer = window.__state.recognizers[window.__state.recognizers.length - 1];
    assert.strictEqual(recognizer.sampleRate, 16000);
    assert.strictEqual(window.__state.lastChunk.length, 16000, '重采样长度不对');
    assert.strictEqual($('heard-text').textContent, window.__state.text);
    assert.strictEqual($('feedback').textContent, '答对了');
  });

  await testAsync('离线语音：答对后自动进下一题', async () => {
    await wait(800);
    assert.ok($('progress-label').textContent.indexOf('第 2') === 0, $('progress-label').textContent);
    assert.ok(Number($('score-label').textContent.replace(/\D/g, '')) >= 1);
  });

  await testAsync('离线语音：麦克风被拒绝时给出重试按钮', async () => {
    const denied = loadPage({ denyMic: true });
    await wait(30);
    const d = denied.window.document;
    /* 先装好语音包（这个用例只关心麦克风被拒时的界面） */
    d.getElementById('welcome-download').click();
    await wait(300);
    d.querySelector('[data-mode="voice"]').click();
    d.getElementById('start-button').click();
    await wait(600);
    assert.strictEqual(d.getElementById('voice-label').textContent, '麦克风未开启');
    assert.strictEqual(d.getElementById('voice-actions').hidden, false);
    assert.strictEqual(d.getElementById('voice-retry').textContent, '重新打开麦克风');
    denied.window.close();
  });

  test('切回打字模式正常', () => {
    $('switch-mode').click();
    assert.strictEqual($('answer-dock').hidden, false);
  });

  test('页面没有脚本错误', () => {
    assert.deepStrictEqual(errors.map((error) => String(error.message || error)), []);
  });

  await testAsync('没装语音包就点了「开始练习」→ 先去下载页', async () => {
    const lazy = loadPage();
    await wait(30);
    const d = lazy.window.document;
    d.getElementById('welcome-skip').click();
    d.querySelector('[data-mode="voice"]').click();
    d.getElementById('start-button').click();
    assert.strictEqual(d.getElementById('welcome').hidden, false);
    assert.strictEqual(d.getElementById('practice').hidden, true);
    assert.ok(d.getElementById('welcome-stage').textContent.indexOf('先装一次') !== -1);
    assert.strictEqual(d.getElementById('welcome-skip').textContent, '先不下载，改用打字作答');
    lazy.window.close();
  });

  /* 5. 下载失败与回退 ---------------------------------------------- */
  await testAsync('下载失败时给出三条地址依次重试', async () => {
    const second = loadPage({ failFirst: true });
    await wait(30);
    second.window.document.getElementById('welcome-download').click();
    await wait(500);
    assert.ok(second.window.__state.modelUrls.length >= 2, '没有换地址重试');
    assert.strictEqual(second.window.KousuanOffline.state(), 'ready');
  });

  await testAsync('全部地址都失败时提示，并且能退回打字', async () => {
    const third = loadPage({ failUrls: ['models/', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'] });
    await wait(30);
    third.window.document.getElementById('welcome-download').click();
    await wait(700);
    assert.strictEqual(third.window.KousuanOffline.state(), 'idle');
    const stage = third.window.document.getElementById('welcome-stage').textContent;
    assert.ok(stage.indexOf('下载没成功') === 0, stage);
    assert.strictEqual(third.window.document.getElementById('welcome-download').disabled, false);
  });

  /* 6. 没有离线能力的浏览器 ---------------------------------------- */
  await testAsync('没有离线能力的浏览器直接进设置页，并如实提示', async () => {
    const { JSDOM: JSDOMClass, VirtualConsole: VC } = require('jsdom');
    const dom = new JSDOMClass(HTML, {
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      url: 'https://example.test/kousuan/',
      virtualConsole: new VC(),
      beforeParse(target) {
        target.AudioContext = undefined;
        target.webkitAudioContext = undefined;
        target.SpeechRecognition = undefined;
        target.scrollTo = () => {};
        Object.defineProperty(target.navigator, 'mediaDevices', {
          configurable: true,
          value: undefined,
        });
      },
    });
    await wait(40);
    const target = dom.window;
    assert.strictEqual(target.KousuanOffline.supported(), false);
    assert.strictEqual(target.document.getElementById('welcome').hidden, true);
    assert.strictEqual(target.document.getElementById('setup').hidden, false);
    assert.strictEqual(target.document.getElementById('voice-note').hidden, false);
    assert.strictEqual(target.document.querySelector('[data-mode="voice"]').disabled, true);
    dom.window.close();
  });

  /* 6b. 设置页里取消下载 -------------------------------------------- */
  await testAsync('设置页下载中，按钮变成「取消」，点了能停下来', async () => {
    const page = loadPage();
    await wait(30);
    const d = page.window.document;
    d.getElementById('welcome-skip').click();
    d.getElementById('pack-action').click();
    assert.strictEqual(d.getElementById('pack-action').textContent, '取消下载');
    assert.strictEqual(d.getElementById('pack-action').disabled, false);
    assert.strictEqual(d.getElementById('pack-status').textContent, '准备中…');

    d.getElementById('pack-action').click();
    await wait(100);
    assert.strictEqual(page.window.KousuanOffline.state(), 'idle');
    assert.strictEqual(d.getElementById('pack-action').textContent, '下载');
    assert.ok(d.getElementById('pack-status').textContent.indexOf('还没下载') === 0);
    page.window.close();
  });

  /* 6c. 离线引擎起不来时自动改用浏览器在线识别 ---------------------- */
  await testAsync('离线引擎起不来 → 当场换成浏览器在线识别，练习不中断', async () => {
    const calls = { starts: 0, aborts: 0, stops: 0 };
    const page = loadPage({
      savedPack: true,
      brokenProcessor: true,
      speechRecognition: makeSpeechRecognition(calls),
    });
    await wait(40);
    const d = page.window.document;
    assert.strictEqual(page.window.KousuanOffline.state(), 'ready');
    /* 有在线识别 + 离线包时才会显示引擎切换 */
    assert.strictEqual(d.getElementById('engine-choice').hidden, false);

    d.querySelector('[data-mode="voice"]').click();
    d.getElementById('start-button').click();
    await wait(400);

    assert.strictEqual(d.getElementById('practice').hidden, false, '练习页被关掉了');
    assert.strictEqual(d.getElementById('feedback').textContent, '离线语音没启动起来，已改用浏览器识别');
    assert.ok(calls.starts >= 1, '没有启动浏览器识别');
    const saved = JSON.parse(page.window.localStorage.getItem('kousuan:v1'));
    assert.strictEqual(saved.prefs.engine, 'online');
    assert.strictEqual(d.querySelector('[data-engine="online"]').getAttribute('aria-pressed'), 'true');
    page.window.close();
  });

  await testAsync('缓存里的语音包装不起来 → 作废「已装好」标记，提示重新下载', async () => {
    const page = loadPage({
      savedPack: true,
      failUrls: ['models/', 'cdn.jsdelivr.net', 'raw.githubusercontent.com'],
    });
    await wait(40);
    let failed = false;
    try {
      await page.window.KousuanOffline.preload();
    } catch (_) {
      failed = true;
    }
    assert.strictEqual(failed, true, '装不起来却没有报错');
    assert.strictEqual(page.window.KousuanOffline.state(), 'idle');
    const saved = JSON.parse(page.window.localStorage.getItem('kousuan:voicepack:v1'));
    assert.strictEqual(saved.ready, false);
    page.window.close();
  });

  /* 7. 默认设置与结构 ---------------------------------------------- */
  test('初始设置：打字作答 + 两位数 + 10 题', () => {
    const fresh = loadPage();
    const freshDoc = fresh.window.document;
    freshDoc.getElementById('welcome-skip').click();
    assert.strictEqual(freshDoc.querySelector('[data-mode="type"]').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(freshDoc.querySelector('[data-level="two"]').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(freshDoc.querySelector('[data-count="10"]').getAttribute('aria-pressed'), 'true');
  });

  test('单文件页面里没有外部资源依赖（除按需加载的语音包）', () => {
    const links = HTML.match(/<(?:script|link)[^>]*(?:src|href)="(?!data:)[^"]+"/g) || [];
    const external = links.filter((tag) => !/manifest\.webmanifest|icon\.svg|icon-180\.png/.test(tag));
    assert.deepStrictEqual(external, []);
  });

  test('页面底部能查到第三方组件与协议（关于面板）', () => {
    assert.ok(HTML.indexOf('vosk-browser') !== -1);
    assert.ok(HTML.indexOf('Apache-2.0') !== -1);
    assert.ok(/<details class="about-panel">/.test(HTML));
  });

  test('手机端答题区贴底（CSS 里有 sticky + 安全区）', () => {
    const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
    assert.ok(/\.answer-dock\s*\{[^}]*position:\s*sticky/s.test(css), '答题区没有贴底');
    assert.ok(/\.answer-dock\s*\{[^}]*env\(safe-area-inset-bottom\)/s.test(css), '答题区没适配安全区');
    assert.ok(/@media \(pointer: coarse\)/.test(css), '粗指针下没有放大点击区');
  });

  /* 收尾 ------------------------------------------------------------ */
  console.log('');
  if (failures.length) {
    console.log(`✗ ${failures.length} 项失败，${passed} 项通过`);
    failures.forEach((item) => {
      console.log(`\n【${item.name}】`);
      console.log(item.error && item.error.stack ? item.error.stack.split('\n').slice(0, 4).join('\n') : item.error);
    });
    process.exit(1);
  }
  console.log(`✓ 全部通过（${passed} 项）`);
  window.close();
}());
