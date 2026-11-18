/* 按需安装的 Vosk 离线识别。打字和浏览器原生语音都不加载第三方脚本。 */
const OfflineVoice = (() => {
  'use strict';
  const files = /*@files*/[];
  const base = /^https?:/.test(document.baseURI) ? new URL('.', document.baseURI).href : '';
  const store = createVoiceStore(base);
  const shell = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];
  const Audio = window.AudioContext || window.webkitAudioContext;
  const size = files.reduce((sum, file) => sum + file.size, 0);

  function unsupported() {
    if (!window.isSecureContext || !/^https?:$/.test(location.protocol)) return '请在 HTTPS 页面打开，才能保存语音包并使用麦克风。';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !Audio || !window.WebAssembly || !window.Worker) {
      return '当前浏览器不支持本机语音识别。可以用新版 Safari 或 Chrome 打开，也可以直接打字。';
    }
    if (!navigator.serviceWorker || !window.indexedDB || !window.fetch || !window.AbortController || !window.crypto || !window.crypto.subtle || !window.ReadableStream) {
      return '当前浏览器不能保存离线语音包，请用普通浏览器窗口打开，或跳过下载。';
    }
    return '';
  }

  async function installed() {
    if (unsupported() || !(await store.has(shell[0]))) return false;
    const hits = await Promise.all(files.map(file => store.has(file.path, file.sha256)));
    return hits.every(Boolean);
  }

  function ensureWorker() {
    const sw = navigator.serviceWorker;
    const url = new URL('sw.js', base).href;
    const controls = () => sw.controller && sw.controller.scriptURL === url;
    if (controls()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        sw.removeEventListener('controllerchange', check);
        if (err) reject(err); else resolve();
      };
      const check = () => { if (controls()) done(); };
      const timer = setTimeout(() => done(new Error('离线页面未能启用，请在独立浏览器窗口重试。')), 20000);
      sw.addEventListener('controllerchange', check);
      sw.register(url, { scope: base }).then(check, () => done(new Error('不能保存离线页面，请检查浏览器的存储权限。')));
    });
  }

  async function install(signal, progress) {
    const check = () => { if (signal.aborted) throw new Error('已取消下载'); };
    await ensureWorker();
    check();
    await Promise.all(shell.map(async name => {
      const url = new URL(name, base).href;
      const response = await fetch(url + '?install', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`离线页面下载失败（HTTP ${response.status}），请重试。`);
      await store.putResponse(url, response);
    }));
    let done = 0;
    for (const file of files) {
      check();
      if (!(await store.has(file.path, file.sha256))) {
        const opts = { signal, credentials: 'same-origin', cache: 'no-store' };
        if (file.source.indexOf('https://api.github.com/') === 0) opts.headers = { Accept: 'application/vnd.github.raw+json' };
        const res = await fetch(file.source, opts);
        if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}），请检查网络后重试。`);
        // 使用固定长度（而非可能是压缩传输长度的 Content-Length）。一次只保留一个文件。
        const bytes = new Uint8Array(file.size);
        const reader = res.body.getReader();
        let offset = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (offset + chunk.value.length > file.size) {
            await reader.cancel();
            throw new Error('下载内容有误，请重试。');
          }
          bytes.set(chunk.value, offset);
          offset += chunk.value.length;
          progress(done + offset, false);
        }
        check();
        if (offset !== file.size) throw new Error('语音包不完整，请重新下载。');
        progress(done + offset, true);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const hex = Array.from(digest, n => ('0' + n.toString(16)).slice(-2)).join('');
        if (hex !== file.sha256) throw new Error('语音包校验失败，请重新下载。');
        check();
        await store.put(file.path, new Blob([bytes], { type: file.type }), { 'Content-Type': file.type }, hex);
      }
      done += file.size;
      progress(done, false);
    }
    check();
    if (!(await installed())) throw new Error('未能完整保存离线页面和语音包，请检查浏览器存储后重试。');
  }

  let engineScript;
  function loadEngine() {
    if (!engineScript) {
      engineScript = ensureWorker().then(() => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = files[0].path;
        script.onload = () => window.Vosk ? resolve() : reject(new Error('engine'));
        script.onerror = () => { script.remove(); reject(new Error('engine')); };
        document.head.appendChild(script);
      })).catch(error => { engineScript = null; throw error; });
    }
    return engineScript;
  }

  // 中文小模型支持动态词表。给二元语言模型提供数字/数位之间的转移，
  // 既能说「八 十 三」也能逐位说「八 三」；不向解码器透露题目或正确答案。
  function numberGrammar() {
    const digits = '零一二三四五六七八九两幺'.split('');
    // Keep the decoder vocabulary numeric-only: do not add <UNK> or phrases such as
    // "答案是" that let ordinary speech enter the number grammar.
    const phrases = ['一 千', '十'].concat(digits);
    digits.forEach(d => {
      phrases.push(`十 ${d}`, `${d} 十 ${d}`, `${d} 百 ${d}`, `百 零 ${d}`, `千 ${d}`);
      digits.forEach(next => phrases.push(`${d} ${next}`));
    });
    return JSON.stringify(phrases);
  }

  // 一个练习会话只建一个模型；每道题一个解码器，前一题排队的结果不能串到下一题。
  function listener(events) {
    const grammar = numberGrammar();
    let model, loading, cancelLoad, capture, decoder, silenceTimer;
    let disposed = false;
    function freeModel() {
      if (!model) return;
      // 0.0.8 的 terminate() 向 worker 发消息删除已构造的模型。加载失败时模型尚不存在。
      if (!model.ready && model.worker) model.worker.terminate(); else model.terminate();
      model = null;
    }
    function getModel() {
      if (!loading) loading = loadEngine().then(() => new Promise((resolve, reject) => {
        if (disposed) { reject(new Error('closed')); return; }
        // 稳定的完整 URL 同时也是 Vosk 解压后的 IndexedDB 缓存键（不能用随机 blob URL）。
        model = new window.Vosk.Model(new URL(files[1].path, base).href, -1);
        const finish = (ok, reason) => {
          clearTimeout(timer);
          cancelLoad = null;
          if (ok) resolve(model); else reject(new Error(reason || '模型未能载入'));
        };
        const timer = setTimeout(() => finish(false, '模型载入超时'), 60000);
        cancelLoad = () => finish(false);
        model.on('load', message => finish(message.result));
        model.on('error', message => finish(false, message.error));
      })).catch(error => { freeModel(); loading = null; throw error; });
      return loading;
    }
    function hold() {
      clearTimeout(silenceTimer);
      if (decoder) { decoder.remove(); decoder = null; }
    }
    function abort() {
      const c = capture;
      capture = null;
      hold();
      if (!c) return;
      if (c.node) { c.node.onaudioprocess = null; c.node.disconnect(); }
      if (c.source) c.source.disconnect();
      if (c.stream) c.stream.getTracks().forEach(track => track.stop());
      if (c.ctx) c.ctx.close().catch(() => {});
    }
    function armSilence() {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        events.error('no-speech');
        if (decoder) armSilence();
      }, 10000);
    }
    function decode() {
      const d = decoder = new model.KaldiRecognizer(capture.ctx.sampleRate, grammar);
      function heard(text, final) {
        if (d !== decoder || !text) return;
        armSilence();
        events.text([text], final);
      }
      d.on('partialresult', msg => heard(msg.result.partial, false));
      d.on('result', msg => heard(msg.result.text, true));
      d.on('error', () => { if (d === decoder) events.error('offline-engine'); });
      armSilence();
      events.start();
    }
    async function start() {
      if (capture) {
        if (capture.node && !decoder) {
          try { decode(); } catch (_) { events.error('offline-engine'); }
        }
        return;
      }
      const c = capture = {};
      try {
        // iOS：在「开始/继续」的用户手势内解锁音频并请求权限，不等模型加载完成。
        c.ctx = new Audio();
        const unlock = c.ctx.resume();
        const permission = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false })
          .then(stream => {
            if (c !== capture) { stream.getTracks().forEach(track => track.stop()); return; }
            c.stream = stream;
            stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
              if (capture !== c) return;
              abort();
              events.error('audio-capture');
            }));
          });
        await Promise.all([unlock, permission, getModel()]);
        if (c !== capture) return;
        c.source = c.ctx.createMediaStreamSource(c.stream);
        // ScriptProcessor 同时覆盖没有 AudioWorklet 的移动 Safari；输出缓冲区保持静音。
        // Smaller audio blocks reduce input latency on phones without creating the
        // very high callback overhead of 512-sample blocks.
        c.node = c.ctx.createScriptProcessor(2048, 1, 1);
        c.node.onaudioprocess = event => {
          if (c !== capture || !decoder) return;
          try { decoder.acceptWaveform(event.inputBuffer); } catch (_) { events.error('offline-engine'); }
        };
        c.source.connect(c.node);
        c.node.connect(c.ctx.destination);
        decode();
      } catch (error) {
        if (c !== capture) return;
        abort();
        if (error.name === 'NotAllowedError' || error.name === 'SecurityError') events.error('not-allowed');
        else if (error.name === 'NotFoundError' || error.name === 'NotReadableError') events.error('audio-capture');
        else {
          // 只记录技术原因，方便定位设备兼容问题，不记录音频或识别到的内容。
          console.warn('离线语音未能启动：', error.message || error.name);
          events.error('offline-engine');
        }
      }
    }
    function dispose() {
      disposed = true;
      abort();
      if (cancelLoad) cancelLoad();
      freeModel();
    }
    return { start, hold, abort, dispose };
  }
  return { unsupported, installed, install, listener, size };
})();
