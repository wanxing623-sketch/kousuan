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
        const source = audio.createBufferSource();
        source.buffer = await audio.decodeAudioData(Uint8Array.from(atob(encoded), c => c.charCodeAt(0)).buffer);
        source.connect(output);
        window.fixtureTrack = output.stream.getAudioTracks()[0];
        window.say83 = () => source.start();
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
    await page.evaluate(() => window.say83());
    await page.waitForFunction(() => document.querySelector('#progress-label').textContent === '第 2 / 10 题' || !document.querySelector('#voice-actions').hidden);
    assert(await page.isHidden('#voice-actions'), await page.textContent('#voice-hint'));
    await page.click('#quit-button');
    assert.equal(await page.textContent('#result-correct'), '1', await page.textContent('#mistakes'));
    assert.equal(await page.evaluate(() => window.fixtureTrack.readyState), 'ended');
    console.log(`✓ ${browserType.name()} persistent profile: install → close browser → reopen offline → real WAV → 83 → score`);
  } catch (err) {
    const reason = await explain('offline reopen', err);
    reason.message += '\nStored after restart: ' + await storeReport(ctx, base).catch(e => e.message);
    throw reason;
  } finally {
    await ctx.close();
    disconnect(false);
  }
};
