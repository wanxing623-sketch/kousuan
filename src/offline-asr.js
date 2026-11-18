/* ------------------------------------------------------------------ *
 * 离线语音识别（本机运行，不联网、不上传声音）
 *
 * 引擎：[vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8，
 *       Vosk 的 WebAssembly 版本（Apache-2.0），脚本放在 vendor/ 里本地化，
 *       不走 CDN —— 内地网络访问 CDN 经常失败，本机文件最稳。
 * 模型：vosk-model-small-cn-0.22（Alpha Cephei，Apache-2.0），
 *       打包成 models/vosk-model-small-cn.tar.gz，第一次使用时下载，
 *       之后由引擎解压进浏览器的 IndexedDB，没网也能用。
 *
 * 这个文件只负责「引擎 / 模型 / 麦克风 / 识别」，不认识题目、不碰界面；
 * 解析数字和判断答案仍然由 app.js 负责。
 * ------------------------------------------------------------------ */

(() => {
  'use strict';

  const ENGINE_URL = 'vendor/vosk-browser.js';
  const STORE_KEY = 'kousuan:voicepack:v1';
  const MODEL_FILE = 'models/vosk-model-small-cn.tar.gz';
  const REPO = 'wanxing623-sketch/kousuan';

  /* 同源优先；jsDelivr 与 raw 只是备用线路，三条都带 CORS，fetch 能直接读 */
  const MODEL_URLS = [
    MODEL_FILE,
    `https://cdn.jsdelivr.net/gh/${REPO}@main/${MODEL_FILE}`,
    `https://raw.githubusercontent.com/${REPO}/main/${MODEL_FILE}`,
  ];

  const SAMPLE_RATE = 16000;
  const SILENCE_MS = 14000;

  let enginePromise = null;
  let model = null;
  let modelPromise = null;
  let pendingModel = null;
  let activeUrl = '';
  let cancelled = false;
  let status = 'idle'; /* idle | engine | download | ready | error */
  let lastError = '';
  let sizeBytes = 0;

  /* ------------------------------------------------------------------ *
   * 能力检测 / 本地记录
   * ------------------------------------------------------------------ */

  function supported() {
    return (
      typeof WebAssembly === 'object'
      && typeof Promise !== 'undefined'
      && !!(window.AudioContext || window.webkitAudioContext)
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    );
  }

  function readSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { ready: false, url: '' };
      const data = JSON.parse(raw);
      return {
        ready: Boolean(data && data.ready),
        url: data && typeof data.url === 'string' ? data.url : '',
      };
    } catch (_) {
      return { ready: false, url: '' };
    }
  }

  function writeSaved(ready, url) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ready, url: url || '', at: Date.now() }));
    } catch (_) {
      /* 存不下也不影响这次使用 */
    }
  }

  function urlList() {
    const saved = readSaved();
    const list = saved.url ? [saved.url].concat(MODEL_URLS) : MODEL_URLS.slice();
    const seen = {};
    return list.filter((item) => {
      if (!item || seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  /* ------------------------------------------------------------------ *
   * 引擎脚本（5.6 MB，只在需要时加载一次）
   * ------------------------------------------------------------------ */

  function loadEngine() {
    if (window.Vosk && window.Vosk.createModel) return Promise.resolve(window.Vosk);
    if (enginePromise) return enginePromise;

    enginePromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = ENGINE_URL;
      script.async = true;
      script.onload = () => {
        if (window.Vosk && window.Vosk.createModel) resolve(window.Vosk);
        else reject(new Error('engine-broken'));
      };
      script.onerror = () => {
        enginePromise = null;
        reject(new Error('engine-load-failed'));
      };
      document.head.appendChild(script);
    });

    return enginePromise;
  }

  /* ------------------------------------------------------------------ *
   * 模型
   * ------------------------------------------------------------------ */

  /* 只用来把真实体积显示给用户，失败就退回保守估计 */
  function probeSize(url) {
    if (sizeBytes) return Promise.resolve(sizeBytes);
    if (typeof fetch !== 'function') return Promise.resolve(0);
    return fetch(url, { method: 'HEAD' })
      .then((response) => {
        const length = Number(response.headers.get('content-length'));
        if (response.ok && length > 0) sizeBytes = length;
        return sizeBytes;
      })
      .catch(() => 0);
  }

  function createModelHandle(Vosk, url) {
    return new Promise((resolve, reject) => {
      let handle;
      try {
        handle = new Vosk.Model(url);
      } catch (error) {
        reject(error);
        return;
      }
      pendingModel = handle;
      let settled = false;
      handle.on('load', (message) => {
        if (settled) return;
        settled = true;
        pendingModel = null;
        if (message && message.result) resolve(handle);
        else reject(new Error('model-load-failed'));
      });
      handle.on('error', (message) => {
        if (settled) return;
        settled = true;
        pendingModel = null;
        reject(new Error((message && message.error) || 'model-load-failed'));
      });
    });
  }

  function download(onProgress) {
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    cancelled = false;
    lastError = '';
    status = 'engine';
    report({ phase: 'engine' });

    return loadEngine()
      .then((Vosk) => {
        const urls = urlList();
        status = 'download';
        report({ phase: 'download', index: 0, total: urls.length });

        const attempt = (index) => {
          if (cancelled) return Promise.reject(new Error('cancelled'));
          if (index >= urls.length) return Promise.reject(new Error(lastError || 'download-failed'));
          const url = urls[index];
          report({ phase: 'download', index, total: urls.length, url });
          return createModelHandle(Vosk, url)
            .then((handle) => {
              if (cancelled) {
                try {
                  handle.terminate();
                } catch (_) {
                  /* 已经结束 */
                }
                throw new Error('cancelled');
              }
              model = handle;
              activeUrl = url;
              status = 'ready';
              writeSaved(true, url);
              report({ phase: 'ready', url });
              return model;
            })
            .catch((error) => {
              if (cancelled) throw error;
              lastError = (error && error.message) || String(error);
              report({ phase: 'retry', index, total: urls.length, message: lastError });
              return attempt(index + 1);
            });
        };

        return attempt(0);
      })
      .catch((error) => {
        status = 'error';
        lastError = (error && error.message) || String(error);
        report({ phase: 'error', message: lastError });
        throw error;
      });
  }

  function cancel() {
    cancelled = true;
    const handle = pendingModel;
    pendingModel = null;
    if (handle) {
      try {
        handle.terminate();
      } catch (_) {
        /* 已经结束 */
      }
    }
    if (status !== 'ready') status = 'idle';
  }

  /* 已经是「下载过」状态时，第二次进页面只从 IndexedDB 里装载，不再联网 */
  function ensureModel() {
    if (model) return Promise.resolve(model);
    if (modelPromise) return modelPromise;

    status = 'engine';
    modelPromise = loadEngine()
      .then((Vosk) => {
        const saved = readSaved();
        const list = saved.url ? [saved.url] : MODEL_URLS;
        status = 'download';
        return new Promise((resolve, reject) => {
          const attempt = (index) => {
            if (index >= list.length) {
              reject(new Error(lastError || 'model-load-failed'));
              return;
            }
            createModelHandle(Vosk, list[index])
              .then((handle) => {
                model = handle;
                activeUrl = list[index];
                status = 'ready';
                writeSaved(true, activeUrl);
                resolve(handle);
              })
              .catch((error) => {
                lastError = (error && error.message) || String(error);
                attempt(index + 1);
              });
          };
          attempt(0);
        });
      })
      .catch((error) => {
        status = 'error';
        modelPromise = null;
        throw error;
      });

    return modelPromise;
  }

  function forget() {
    if (model) {
      try {
        model.terminate();
      } catch (_) {
        /* 已经结束 */
      }
    }
    model = null;
    modelPromise = null;
    status = 'idle';
    writeSaved(false, '');
  }

  /* ------------------------------------------------------------------ *
   * 识别会话：麦克风 → 16 kHz 单声道 → Vosk
   * ------------------------------------------------------------------ */

  function resampleTo16k(input, inputRate) {
    if (!inputRate || inputRate === SAMPLE_RATE) return input;
    const ratio = inputRate / SAMPLE_RATE;
    const length = Math.max(1, Math.floor(input.length / ratio));
    const output = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const from = Math.floor(i * ratio);
      const to = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let count = 0;
      for (let j = from; j < to; j += 1) {
        sum += input[j];
        count += 1;
      }
      output[i] = count ? sum / count : 0;
    }
    return output;
  }

  /* iOS 上 AudioContext 需要在点击事件里解锁，否则一直是 suspended，
     麦克风采集不到任何数据。开始按钮点下去时先建好、resume 一次，会话直接复用。 */
  let sharedCtx = null;

  function unlock() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      if (!sharedCtx) sharedCtx = new AudioCtx();
      if (sharedCtx.state === 'suspended' && sharedCtx.resume) {
        sharedCtx.resume().catch(() => {});
      }
    } catch (_) {
      sharedCtx = null;
    }
  }

  function createSession(options) {
    const opts = options || {};
    const on = (name) => (typeof opts[name] === 'function' ? opts[name] : () => {});

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let ctx = null;
    let ownsCtx = false;
    let stream = null;
    let source = null;
    let node = null;
    let recognizer = null;
    let running = false;
    let starting = false;
    let paused = false;
    let closed = false;
    let silenceTimer = 0;
    let lastVoiceAt = 0;
    let lastPartial = '';

    function label(state) {
      on('onState')(state);
    }

    function attach(instance) {
      instance.on('result', (message) => {
        if (instance !== recognizer || !running || closed) return;
        const text = message && message.result && message.result.text ? message.result.text : '';
        lastVoiceAt = performance.now();
        if (paused) return;
        if (text) on('onText')(text, true);
      });

      instance.on('partialresult', (message) => {
        if (instance !== recognizer || !running || closed || paused) return;
        const text = message && message.result && message.result.partial ? message.result.partial : '';
        if (text) {
          lastVoiceAt = performance.now();
          if (text !== lastPartial) {
            lastPartial = text;
            on('onText')(text, false);
          }
        }
      });
    }

    function freshRecognizer() {
      const previous = recognizer;
      recognizer = null;
      if (previous) {
        try {
          previous.remove();
        } catch (_) {
          /* 已经移除 */
        }
      }
      if (!model) return;
      recognizer = new model.KaldiRecognizer(SAMPLE_RATE);
      lastPartial = '';
      attach(recognizer);
      lastVoiceAt = performance.now();
    }

    function feed(channel) {
      if (!recognizer || paused || closed) return;
      try {
        recognizer.acceptWaveformFloat(resampleTo16k(channel, ctx ? ctx.sampleRate : SAMPLE_RATE), SAMPLE_RATE);
      } catch (error) {
        on('onError')('offline-feed', error);
      }
    }

    function teardownAudio() {
      if (silenceTimer) {
        clearInterval(silenceTimer);
        silenceTimer = 0;
      }
      if (node) {
        node.onaudioprocess = null;
        try {
          node.disconnect();
        } catch (_) {
          /* 已经断开 */
        }
        node = null;
      }
      if (source) {
        try {
          source.disconnect();
        } catch (_) {
          /* 已经断开 */
        }
        source = null;
      }
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (_) {
            /* 已经停止 */
          }
        });
        stream = null;
      }
      if (ctx && ownsCtx) {
        try {
          ctx.close();
        } catch (_) {
          /* 已经关闭 */
        }
        if (ctx === sharedCtx) {
          sharedCtx.__closed = true;
          sharedCtx = null;
        }
      }
      ctx = null;
    }

    function start() {
      if (running || starting) return Promise.resolve();
      starting = true;
      closed = false;
      paused = false;
      label('loading');
      on('onHint')('正在准备离线语音，第一次会慢一点…');

      return ensureModel()
        .then(() => {
          if (closed) return null;
          if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            throw new Error('mic-unsupported');
          }
          return navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              channelCount: 1,
            },
            video: false,
          });
        })
        .then((mediaStream) => {
          if (!mediaStream) return;
          stream = mediaStream;
          if (sharedCtx && !sharedCtx.__closed) {
            ctx = sharedCtx;
            ownsCtx = false;
          } else {
            ctx = new AudioCtx();
            ownsCtx = true;
          }
          if (ctx.state === 'suspended' && ctx.resume) {
            return ctx.resume().then(() => mediaStream, () => mediaStream);
          }
          return mediaStream;
        })
        .then((mediaStream) => {
          if (!mediaStream || closed) {
            starting = false;
            return;
          }
          source = ctx.createMediaStreamSource(stream);
          node = ctx.createScriptProcessor(4096, 1, 1);
          node.onaudioprocess = (event) => {
            feed(event.inputBuffer.getChannelData(0));
          };
          source.connect(node);
          node.connect(ctx.destination);

          running = true;
          freshRecognizer();
          lastVoiceAt = performance.now();
          silenceTimer = setInterval(() => {
            if (!running || paused || closed) return;
            if (performance.now() - lastVoiceAt > SILENCE_MS) {
              lastVoiceAt = performance.now();
              on('onSilence')();
            }
          }, 1500);
          starting = false;
          label('listening');
          on('onHint')(offlineHint());
          on('onReady')();
        })
        .catch((error) => {
          starting = false;
          teardownAudio();
          running = false;
          const code = error && error.name ? error.name : '';
          if (code === 'NotAllowedError' || code === 'SecurityError') on('onError')('mic-denied', error);
          else if (code === 'NotFoundError' || code === 'DevicesNotFoundError') on('onError')('mic-missing', error);
          else on('onError')('offline-start', error);
        });
    }

    function pause() {
      paused = true;
      if (recognizer) {
        try {
          recognizer.retrieveFinalResult();
        } catch (_) {
          /* 已经结束 */
        }
      }
      label('paused');
    }

    function resume() {
      if (!running || closed) return;
      paused = false;
      lastVoiceAt = performance.now();
      label('listening');
    }

    function stop() {
      running = false;
      starting = false;
      paused = false;
      closed = true;
      teardownAudio();
      if (recognizer) {
        try {
          recognizer.remove();
        } catch (_) {
          /* 已经移除 */
        }
        recognizer = null;
      }
      label('idle');
    }

    function reset() {
      if (!running || closed) return;
      freshRecognizer();
    }

    return {
      start,
      pause,
      resume,
      stop,
      reset,
      get running() {
        return running;
      },
      get starting() {
        return starting;
      },
      get paused() {
        return paused;
      },
    };
  }

  function offlineHint() {
    return '离线识别中，说完答案会自动进入下一题';
  }

  window.KousuanOffline = {
    supported,
    state() {
      if (!supported()) return 'unsupported';
      return readSaved().ready ? 'ready' : 'idle';
    },
    status() {
      return status;
    },
    sizeHint() {
      return sizeBytes;
    },
    probeSize,
    preload: ensureModel,
    download,
    cancel,
    forget,
    createSession,
    unlock,
    modelUrls: MODEL_URLS.slice(),
  };
})();
