/* A real browser restart is different from reloading a tab: the SW registration,
 * page, engine and model must all survive on disk. Chromium and WebKit run this. */
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function waitForPack(page, expected) {
  await page.waitForFunction(state => [state, 'error', 'unsupported'].includes(document.querySelector('#pack-card').dataset.state), expected);
  assert.equal(await page.getAttribute('#pack-card', 'data-state'), expected, await page.textContent('#pack-message'));
}

// Diagnostics only, after an assertion failed. The neutral in-memory page is outside
// the app scope; it can inspect this profile even if the app document failed to load.
async function storeReport(ctx, base) {
  const p = await ctx.newPage();
  try {
    const url = new URL('/__test_cache_state', base).href;
    await p.route(url, route => route.fulfill({ contentType: 'text/html', body: '<title>cache diagnostics</title>' }));
    await p.goto(url, { timeout: 5000 });
    return await p.evaluate(base => new Promise((resolve, reject) => {
      const request = indexedDB.open('kousuan-offline:' + encodeURIComponent(new URL(base).pathname));
      request.onupgradeneeded = () => request.transaction.abort(); // don't create a DB just for diagnostics
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['headers', 'bodies']);
        const headers = tx.objectStore('headers').getAllKeys(), bodies = tx.objectStore('bodies').getAllKeys();
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify({ headers: headers.result, bodies: bodies.result })); };
        tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), base);
  } finally { await p.close(); }
}

module.exports = async function testReopen({ browserType, profile, base, wav, fixQuestion, disconnect }) {
  const options = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  if (browserType.name() === 'chromium') options.executablePath = process.env.CHROMIUM_PATH;
  const open = () => browserType.launchPersistentContext(profile, options);
  const messages = [];
  let page;
  function observe(p) {
    p.on('console', msg => { if (['warning', 'error'].includes(msg.type())) messages.push(msg.text().slice(0, 240)); });
    p.on('pageerror', err => messages.push(err.message.slice(0, 240)));
    p.on('requestfailed', req => messages.push(`${req.method()} ${req.url().slice(0, 150)}: ${req.failure().errorText}`));
    return p;
  }
  async function explain(stage, error) {
    const state = page && await page.evaluate(() => ['pack-state', 'pack-message', 'voice-label', 'voice-hint', 'heard-text', 'feedback']
      .map(id => document.getElementById(id)?.textContent).filter(Boolean).join(' | ')).catch(() => 'page unavailable');
    return new Error(`${stage}: ${error.message}\nUI: ${state || 'no page'}\nBrowser: ${messages.slice(-6).join('; ')}`);
  }
  let ctx = await open();
  try {
    page = observe(await ctx.newPage());
    await page.goto(base);
    await waitForPack(page, 'idle');
    await page.click('#pack-button');
    await waitForPack(page, 'ready');
    assert(await page.evaluate(async () => {
      const html = await createVoiceStore(document.baseURI).match('index.html');
      return html && (await html.text()).includes('kousuanReady');
    }), 'The offline HTML must be readable before closing');
    assert(await page.evaluate(() => !window.Vosk), 'The decoder must not be preloaded during installation');
  } catch (err) {
    const reason = await explain('install', err);
    reason.message += '\nStored after install: ' + await storeReport(ctx, base).catch(e => e.message);
    throw reason;
  } finally {
    await ctx.close();
  }

  disconnect(true); // refuse every HTTP request, including worker requests outside page interception
  ctx = await open();
  try {
    await ctx.addInitScript(encoded => {
      window.SpeechRecognition = window.webkitSpeechRecognition = undefined;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
      // Only substitute the input device. Use a real MediaStream / Web Audio graph,
      // Vosk WASM, transcript parser and scoring, without needing a physical microphone.
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        await audio.resume();
        const output = audio.createMediaStreamDestination();
        const fixture = await audio.decodeAudioData(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)).buffer);
        // A quiet room: about −60 dBFS of steady noise, so the near-voice gate has a real floor.
        const noise = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
        const samples = noise.getChannelData(0);
        let seed = 1;
        for (let i = 0; i < samples.length; i += 1) {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          samples[i] = (seed / 1073741824 - 1) * 0.0017;
        }
        const room = audio.createBufferSource();
        room.buffer = noise;
        room.loop = true;
        room.connect(output);
        room.start();
        // The same “八，十，三” spoken right in front of the phone, or 18 dB quieter from across the room.
        const speak = gain => () => new Promise(resolve => {
          const source = audio.createBufferSource();
          const level = audio.createGain();
          source.buffer = fixture;
          level.gain.value = gain;
          source.connect(level);
          level.connect(output);
          source.onended = resolve;
          source.start();
        });
        window.fixtureTrack = output.stream.getAudioTracks()[0];
        window.say83 = speak(1);
        window.sayFar83 = speak(10 ** (-18 / 20));
        return output.stream;
      };
    }, fs.readFileSync(wav).toString('base64'));
    page = observe(await ctx.newPage());
    await page.goto(base + '?reopened');
    await waitForPack(page, 'ready');
    await page.click('#pack-button');
    await fixQuestion(page);
    await page.click('#start-button');
    await page.waitForFunction(() => document.querySelector('#voice-button').classList.contains('is-listening') || !document.querySelector('#voice-actions').hidden, null, { timeout: 65000 });
    assert(await page.isHidden('#voice-actions'), await page.textContent('#voice-hint'));
    assert(await page.isVisible('#near-toggle'), 'offline voice shows the near-voice switch');
    await page.evaluate(() => { window.say83(); });
    await page.waitForFunction(() => document.querySelector('#progress-label').textContent === '第 2 / 10 题' || !document.querySelector('#voice-actions').hidden);
    assert(await page.isHidden('#voice-actions'), await page.textContent('#voice-hint'));
    console.log(`✓ ${browserType.name()} persistent profile: install → close browser → reopen offline → real WAV → 83 → score`);

    // The correct answer calibrated the gate to this voice. Someone across the room saying a
    // number must not answer the next question (any submission would show up in the totals).
    await page.waitForSelector('.voice-button.is-listening');
    await page.evaluate(() => window.sayFar83());
    await page.waitForTimeout(1500); // the decoder would have answered by now
    assert.equal(await page.textContent('#progress-label'), '第 2 / 10 题', 'a voice from across the room answered');
    assert.equal(await page.textContent('#heard-text'), '', 'a voice from across the room reached the decoder');
    assert.match(await page.textContent('#near-count'), /已过滤 [1-9]\d* 段/);
    const stored = async () => JSON.parse(await page.evaluate(() => localStorage.getItem('kousuan:v1'))).prefs;
    assert.equal((await stored()).nearLevels.length, 1, 'the voice level of the correct answer is remembered');

    // The range switch cycles 只听面前 → 近处说话 → 不过滤 → 只听面前 and starts a fresh calibration.
    // It must not touch the practice mode: it once shared the setup page's data-mode hook.
    await page.click('#near-toggle');
    assert.equal(await page.textContent('#near-toggle-label'), '收音：近处说话');
    assert.match(await page.textContent('#voice-hint'), /一臂之内/);
    const prefs = await stored();
    assert.deepEqual([prefs.mode, prefs.nearMode, prefs.nearLevels], ['voice', 'standard', []]);
    await page.click('#near-toggle'); // 不过滤 turns automatic gain back on, so the mic reopens
    assert.equal(await page.textContent('#near-toggle-label'), '收音：不过滤');
    await page.click('#near-toggle');
    assert.equal(await page.textContent('#near-toggle-label'), '收音：只听面前');
    await page.waitForSelector('.voice-button.is-listening');
    assert(await page.isHidden('#voice-actions'), await page.textContent('#voice-hint'));
    assert.equal((await stored()).mode, 'voice');

    await page.click('#quit-button');
    assert.equal(await page.textContent('#result-total'), '1', await page.textContent('#mistakes'));
    assert.equal(await page.textContent('#result-correct'), '1', await page.textContent('#mistakes'));
    assert.equal(await page.evaluate(() => window.fixtureTrack.readyState), 'ended');
    console.log(`✓ ${browserType.name()} near-voice gate: the same “83” from across the room is filtered, not answered; range switch`);
  } catch (err) {
    const reason = await explain('offline reopen', err);
    reason.message += '\nStored after restart: ' + await storeReport(ctx, base).catch(e => e.message);
    throw reason;
  } finally {
    await ctx.close();
    disconnect(false);
  }
};
