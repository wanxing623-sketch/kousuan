/* Run against the published layout, under a Pages-style subpath. No speech service or real mic. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { chromium } = require('playwright');
const files = require('../src/voice-pack.json');
const dist = path.resolve(__dirname, '../dist');
const [engine, model] = files.map(f => 'voice-assets/' + f.file);
const downloads = { [engine]: 0, [model]: 0 };
let modelResponse = 'ok';
let disconnected = false;

const server = http.createServer((req, res) => {
  if (disconnected) { res.destroy(); return; }
  const url = new URL(req.url, 'http://test.invalid');
  const file = url.pathname.slice('/kousuan/'.length) || 'index.html';
  if (!url.pathname.startsWith('/kousuan/') || !['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png', engine, model].includes(file)) {
    res.writeHead(404).end(); return;
  }
  if (file === engine || file === model) {
    downloads[file]++;
    if (file === model && modelResponse === 'broken') {
      const corrupt = fs.readFileSync(path.join(dist, file));
      corrupt[0] ^= 255; // HTTP 200 with the correct length but the wrong SHA-256
      res.end(corrupt); return;
    }
    if (file === model && modelResponse === 'stall') { res.write('partial'); return; }
  }
  const types = { '.html': 'text/html', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(dist, file)).pipe(res);
});

async function fixQuestion(page) {
  await page.evaluate(() => {
    const original = Math.random;
    const choices = [37.5 / 90, 26.5 / 90, 0.1]; // 47 + 36
    Math.random = () => choices.length ? choices.shift() : original();
  });
}
async function noLiveMic(page) {
  await page.waitForFunction(() => window.tracks.every(t => t.readyState === 'ended'));
}

async function testOffline(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 320, height: 667 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  await ctx.addInitScript(() => {
    window.SpeechRecognition = window.webkitSpeechRecognition = undefined;
    const mic = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.tracks = [];
    window.micCalls = 0;
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.micCalls++;
      if (window.refuseMic) throw new DOMException('denied', 'NotAllowedError');
      if (window.delayMic) await new Promise(resolve => { window.grantMic = resolve; });
      const stream = await mic(constraints);
      window.tracks.push(...stream.getTracks());
      return stream;
    };
  });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const state = name => page.waitForSelector(`#pack-card[data-state="${name}"]`);
  await page.goto(base);
  await state('idle');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.click('#skip-pack');
  await fixQuestion(page);
  await page.click('#start-button');
  await page.fill('#answer', '83');
  await page.press('#answer', 'Enter');
  await page.click('#quit-button');
  assert.equal(await page.textContent('#result-accuracy'), '100%');
  assert.equal(await page.evaluate(() => window.micCalls), 0);
  assert.deepEqual(downloads, { [engine]: 0, [model]: 0 });
  console.log('✓ first-run skip, mobile layout and typing without a voice download');

  await page.click('#settings-button');
  await page.click('[data-mode="voice"]'); // no native API: offers install instead of disabling voice
  modelResponse = 'broken';
  await page.click('#pack-button');
  await state('error');
  assert.match(await page.textContent('#pack-message'), /校验|不完整/);
  modelResponse = 'stall';
  const partial = page.waitForResponse(r => r.url().includes(files[1].file + '?install'));
  await page.click('#pack-button');
  await partial;
  await page.click('#skip-pack');
  await page.click('#manage-pack');
  await state('idle');
  modelResponse = 'ok';
  await page.click('#pack-button');
  await state('ready');
  assert.deepEqual(downloads, { [engine]: 1, [model]: 3 });
  assert.equal(await page.evaluate(() => window.micCalls), 0);
  console.log('✓ integrity failure, cancellation, retry, reuse of verified files; no mic on install');

  // Cold reload offline BEFORE the model has ever been opened / extracted by Vosk.
  disconnected = true;
  await ctx.setOffline(true);
  await page.goto(base + '?cold');
  await page.waitForSelector('#setup');
  await page.click('#manage-pack');
  await state('ready');
  await page.click('#pack-button');
  await fixQuestion(page);
  await page.evaluate(() => { window.refuseMic = true; });
  await page.click('#start-button');
  await page.waitForSelector('#voice-actions');
  assert.match(await page.textContent('#voice-hint'), /权限/);
  await page.evaluate(() => { window.refuseMic = false; });
  await page.click('#voice-retry');
  await page.waitForFunction(() => document.querySelector('#score-label').textContent === '答对 1 题', null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('#progress-label').textContent === '第 2 / 10 题');
  console.log('✓ offline cold start and permission retry; real Chinese WAV → Vosk WASM → 83 → next question');

  await page.click('#voice-button');
  await noLiveMic(page);
  await page.click('#voice-button');
  await page.waitForSelector('.voice-button.is-listening');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    window.delayMic = true;
  });
  await noLiveMic(page);
  await page.click('#voice-retry');
  const trackCount = await page.evaluate(() => window.tracks.length);
  await page.click('#switch-mode'); // leave while the permission request is pending
  await page.evaluate(() => window.grantMic());
  await page.waitForFunction(n => window.tracks.length > n, trackCount);
  await noLiveMic(page);
  await page.click('#quit-button');
  assert.equal(await page.textContent('#result-correct'), '1');
  assert.equal(await page.textContent('#result-total'), '1');
  assert.deepEqual(pageErrors, []);
  console.log('✓ pause, background, delayed permission after switching to typing and result statistics');
  disconnected = false;
  await ctx.setOffline(false);
  await page.evaluate(async () => {
    const cacheName = (await caches.keys()).find(n => n.startsWith('kousuan-voice:'));
    const cache = await caches.open(cacheName);
    await cache.delete((await cache.keys()).find(k => k.url.endsWith('.gz')));
  });
  await page.reload();
  await page.click('#manage-pack');
  await state('idle');
  await ctx.close();
  console.log('✓ evicted model is not reported as installed');
}

async function testStorage(browser, base) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.SpeechRecognition = window.webkitSpeechRecognition = undefined;
    const put = Cache.prototype.put;
    Cache.prototype.put = function (key, response) {
      if (String(key).includes('voice-assets/')) return Promise.reject(new DOMException('full', 'QuotaExceededError'));
      return put.call(this, key, response);
    };
  });
  await page.goto(base);
  await page.click('#pack-button');
  await page.waitForSelector('#pack-card[data-state="error"]');
  assert.match(await page.textContent('#pack-message'), /空间不足/);
  await page.click('#skip-pack');
  await page.addInitScript(() => { window.WebAssembly = undefined; });
  await page.reload();
  await page.waitForSelector('#setup');
  assert(await page.isDisabled('[data-mode="voice"]'));
  await page.click('#start-button');
  assert(await page.isVisible('#answer-form'));
  await page.close();
  console.log('✓ full storage / no supported speech engine still allows typing');
}

async function testNative(browser, base) {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.WebAssembly = undefined;
    window.SpeechRecognition = class {
      start() { window.nativeMic = this; this.onstart(); }
      stop() { this.onend(); }
      abort() { this.onend(); }
    };
  });
  await page.goto(base);
  await page.waitForSelector('#pack-card[data-state="unsupported"]');
  await page.click('#skip-pack');
  await page.click('[data-mode="voice"]');
  assert.match(await page.textContent('#voice-tip'), /联网/);
  await fixQuestion(page);
  await page.click('#start-button');
  await page.evaluate(() => {
    const result = Object.assign([{ transcript: '八十三' }], { isFinal: true });
    window.nativeMic.onresult({ resultIndex: 0, results: [result] });
  });
  await page.click('#quit-button');
  assert.equal(await page.textContent('#result-accuracy'), '100%');
  await page.close();
  console.log('✓ unsupported local engine does not block the original browser-speech path');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kousuan-'));
  const wav = path.join(tmp, '83.wav');
  // Synthetic “八十三”, generated with text2wav/eSpeak NG (zh, speed 135); no personal recording.
  fs.writeFileSync(wav, gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/mandarin-83.wav.gz'))));
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://localhost:${server.address().port}/kousuan/`;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav] });
    await testOffline(browser, base);
    await testNative(browser, base);
    await testStorage(browser, base);
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
