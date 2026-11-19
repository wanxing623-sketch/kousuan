/* Browser-free checks for the near-field gate (src/near-voice.js) and the number parser
 * (src/spoken-number.js). Uses the same synthetic “八，十，三” WAV as the browser tests:
 * the speaker in front of the phone must pass, the same voice from across the room must not. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');

const ctx = vm.createContext({ Math, Float32Array, Array, Map, Number, String, isFinite, JSON });
for (const file of ['near-voice.js', 'spoken-number.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), ctx, { filename: file });
}
const { createNearVoiceGate, nearVoiceLevel, nearVoiceAccepts, SpokenNumber } =
  vm.runInContext('({ createNearVoiceGate, nearVoiceLevel, nearVoiceAccepts, SpokenNumber })', ctx);

/* ---------------- spoken numbers ---------------- */

const accepts = {
  '八十三': 83, '八 十 三': 83, '八三': 83, '83': 83, '８３': 83, '八十三。': 83,
  '一百零五': 105, '幺零五': 105, '一 零 五': 105, '两百五': 250, '二百五十': 250, '一千二': 1200,
  '一千零一十': 1010, '一千零十': 1010, '十五': 15, '一十五': 15, '一百一': 110, '一百十': 110,
  '一千九百九十八': 1998, '1998': 1998, '零': 0, '九': 9, '两千': null,
};
for (const [text, value] of Object.entries(accepts)) assert.equal(SpokenNumber.parse(text), value, text);
// Background chatter forced into number words by the grammar is not a well-formed number.
for (const text of ['千一七百三', '五 七 七 三 八 九 四', '一百二十三七', '八十三三', '百', '十十', '答案是八十三', '<unk> 八十三', '1999', '0083', ''])
  assert.equal(SpokenNumber.parse(text), null, text);
for (let n = 0; n <= SpokenNumber.MAX; n += 1) {
  assert.equal(SpokenNumber.parse(SpokenNumber.standard(n)), n, SpokenNumber.standard(n));
  assert.equal(SpokenNumber.parse(String(n).split('').map(d => '零一二三四五六七八九'[d]).join(' ')), n, `digits ${n}`);
}
assert.equal(SpokenNumber.isNumeric('一百零'), true); // unfinished partial results still show up
assert.equal(SpokenNumber.isNumeric('答案八十'), false);
console.log('✓ spoken numbers: 0–1998 in standard and digit-by-digit form; chatter-like digit strings rejected');

/* ---------------- near-field gate ---------------- */

function readWav(buffer) {
  let p = 12, fmt, data;
  while (p < buffer.length) {
    const id = buffer.toString('ascii', p, p + 4), size = buffer.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: buffer.readUInt16LE(p + 10), rate: buffer.readUInt32LE(p + 12), bits: buffer.readUInt16LE(p + 22) };
    if (id === 'data') data = buffer.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  assert(fmt && data && fmt.bits === 16 && fmt.channels === 1, 'fixture must be 16-bit mono');
  const samples = new Float32Array(data.length / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { rate: fmt.rate, samples };
}
const { rate, samples: voice } = readWav(gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/mandarin-83.wav.gz'))));

let seed = 7;
const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 1073741824 - 1; };
const db = value => 10 ** (value / 20);

// A distant talker: quieter by `gain` dB, smeared by a simple room tail, over room noise.
function scene({ gain = 0, room = false, floor = -66, lead = 1.5 }) {
  const out = new Float32Array(Math.round(rate * lead) + voice.length + rate);
  const offset = Math.round(rate * lead);
  for (let i = 0; i < voice.length; i += 1) out[offset + i] += voice[i] * db(gain);
  if (room) {
    const tail = Math.round(rate * 0.5);
    const wet = new Float32Array(out.length);
    for (let k = 1; k < tail; k += 37) {
      const weight = 0.09 * noise() * Math.exp(-6.9 * k / tail);
      for (let i = offset; i < offset + voice.length && i + k < out.length; i += 1) wet[i + k] += voice[i - offset] * db(gain) * weight;
    }
    for (let i = 0; i < out.length; i += 1) out[i] += wet[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] += noise() * db(floor);
  return out;
}

function run(signal, options, gate = createNearVoiceGate(rate, options)) {
  let fed = 0;
  const ends = [];
  for (let i = 0; i + 1024 <= signal.length; i += 1024) {
    gate.process(signal.subarray(i, i + 1024), data => { fed += data.length; }, info => ends.push(info));
  }
  return { fed: fed / rate, ends, speech: ends.filter(info => info.speech), gate };
}

const near = run(scene({}), { mode: 'strong' });
assert.equal(near.speech.length, 1, 'one answer from the speaker in front: ' + JSON.stringify(near.ends));
assert(near.fed > 1.4 && near.fed < 2.6, `only the answer reaches the decoder (${near.fed.toFixed(2)} s)`);
assert(near.speech[0].level > -30 && near.speech[0].level < -5, 'voice level is measured: ' + near.speech[0].level);
assert(nearVoiceAccepts('八 十 三', near.speech[0]));
const level = nearVoiceLevel([near.speech[0].level]);

for (const mode of ['strong', 'standard']) {
  assert.equal(run(scene({ gain: -6 }), { mode, voiceLevel: level }).speech.length, 1, `${mode}: a slightly quieter answer still counts`);
  const far = run(scene({ gain: -24, room: true, floor: -60 }), { mode, voiceLevel: level });
  assert.equal(far.fed, 0, `${mode}: the same voice from across the room never reaches the decoder`);
  assert(far.gate.meter().ignored >= 1, `${mode}: the filtered speech is counted`);
}
assert.equal(run(scene({ gain: -12, room: true }), { mode: 'standard', voiceLevel: level }).speech.length, 1, 'standard: an arm’s length away still counts');
assert.equal(run(scene({ gain: -14, room: true, floor: -60 }), { mode: 'strong', voiceLevel: level }).fed, 0, 'strong: an arm’s length away is filtered');
// Without calibration the floor rule alone keeps a quiet far talker out in a noisy room.
assert.equal(run(scene({ gain: -24, room: true, floor: -50 }), { mode: 'strong' }).fed, 0, 'uncalibrated: far voice below the room noise margin');
// Turning the filter off restores the previous behaviour: everything is decoded, a quiet tail ends the answer.
const off = run(scene({ gain: -24, room: true }), { mode: 'off' });
assert(off.fed > 4, 'off: all audio is decoded');
console.log('✓ near-field gate: speaker in front passes (calibrated and not); same voice at −14…−24 dB with room echo is filtered');

// Switching questions drops a half-finished segment; switching modes works without a new gate.
const gate = createNearVoiceGate(rate, { mode: 'strong' });
const first = scene({});
let fed = 0;
const half = Math.round(rate * 1.5) + Math.round(voice.length * 0.6);
for (let i = 0; i + 1024 <= half; i += 1024) gate.process(first.subarray(i, i + 1024), d => { fed += d.length; }, () => assert.fail('no end yet'));
assert(fed > 0 && gate.meter().open);
gate.reset();
assert.equal(gate.meter().open, false);
gate.setMode('off');
assert.equal(gate.meter().mode, 'off');

assert.equal(nearVoiceLevel([]), null);
assert.equal(nearVoiceLevel([-30]), -30);
assert.equal(nearVoiceLevel([-30, -20, -25, -40, -22, -60]), -22, 'second loudest of the last five');
// A single digit squeezed out of seconds of someone else's talk is not an answer…
const chatter = { speech: true, voicedMs: 2600, loudMs: 1900, peak: -38, voice: null };
assert.equal(nearVoiceAccepts('五', chatter), false, 'one digit out of a long stretch of talk');
assert.equal(nearVoiceAccepts('五', Object.assign({}, chatter, { voice: -22 })), false, 'far quieter than your voice');
// …but “八” said in a noisy room is, as is any short single digit and every longer number.
assert.equal(nearVoiceAccepts('八', Object.assign({}, chatter, { peak: -24, voice: -22 })), true, 'as loud as your voice');
assert.equal(nearVoiceAccepts('八', { speech: true, voicedMs: 2200, loudMs: 260, peak: -25, voice: null }), true, 'short loud syllable');
assert.equal(nearVoiceAccepts('一 百', chatter), false, 'two digits out of seconds of talk');
assert.equal(nearVoiceAccepts('一 百', Object.assign({}, chatter, { loudMs: 600 })), true);
assert.equal(nearVoiceAccepts('五 百 二 十 九', Object.assign({}, chatter, { loudMs: 1100 })), true, 'a long answer');
assert.equal(nearVoiceAccepts('八 十 三', { speech: false, voicedMs: 60 }), false);
assert.equal(nearVoiceAccepts('八 十 三', null), true);
console.log('✓ calibration keeps the second loudest of five correct answers; fragments and clicks are not answers');
