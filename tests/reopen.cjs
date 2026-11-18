/* A real browser restart is different from reloading a tab: the SW registration,
 * page, engine and model must all survive on disk. Chromium and WebKit run this. */
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function waitForPack(page, expected) {
  await page.waitForFunction(state => [state, 'error', 'unsupported'].includes(document.querySelector('#pack-card').dataset.state), expected);
  assert.equal(await page.getAttribute('#pack-card', 'data-state'), expected, await page.textContent('#pack-message'));
}

module.exports = async function testReopen({ browserType, profile, base, wav, fixQuestion, disconnect }) {
  const options = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
  if (browserType.name() === 'chromium') options.executablePath = process.env.CHROMIUM_PATH;
  const open = () => browserType.launchPersistentContext(profile, options);
  let ctx = await open();
  try {
    const page = await ctx.newPage();
    await page.goto(base);
    await waitForPack(page, 'idle');
    await page.click('#pack-button');
    await waitForPack(page, 'ready');
    assert(await page.evaluate(() => !window.Vosk), 'The decoder must not be preloaded during installation');
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
    const page = await ctx.newPage();
    page.on('pageerror', error => console.error('Browser error:', error.message));
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
  } finally {
    await ctx.close();
    disconnect(false);
  }
};
