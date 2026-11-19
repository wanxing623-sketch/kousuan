/* 近讲门控单测：用合成响度序列模拟近处/远处说话，不需要麦克风或浏览器。
 * 运行：node tests/near-gate.cjs */
const assert = require('node:assert/strict');
const NearGate = require('../src/near-gate.js');

const BLOCK = 64; // 16 kHz 下 1024 采样约 64 ms

function feed(gate, rms, blocks) {
  let result;
  for (let i = 0; i < blocks; i += 1) result = gate.update(rms, BLOCK);
  return result;
}

function opensWithin(gate, rms, blocks) {
  for (let i = 0; i < blocks; i += 1) {
    if (gate.update(rms, BLOCK).justOpened) return true;
  }
  return false;
}

// 远处较小的人声（RMS 0.015）在只听近处档永远开不了门
{
  const gate = NearGate.create('near');
  assert.equal(opensWithin(gate, 0.015, 300), false, 'far quiet speech must stay gated out');
  console.log('✓ near mode: distant quiet speech never opens the gate');
}

// 近处响亮说话两块内开门，句末静音约 450 ms 后关门且只报一次
{
  const gate = NearGate.create('near');
  feed(gate, 0.001, 10);
  assert.equal(opensWithin(gate, 0.12, 2), true, 'loud close speech opens quickly');
  let closes = 0;
  for (let i = 0; i < 20; i += 1) if (gate.update(0.001, BLOCK).justClosed) closes += 1;
  assert.equal(closes, 1, 'gate closes once after the quiet tail');
  console.log('✓ near mode: close loud speech opens, quiet tail closes once');
}

// 单次短促响声（拍手/碰杯）在只听近处档开不了门，避免瞬时噪声触发识别
{
  const gate = NearGate.create('near');
  gate.update(0.2, BLOCK);
  assert.equal(opensWithin(gate, 0.001, 20), false);
  console.log('✓ near mode: a single transient click does not open the gate');
}

// 开门后音节尾巴（低于开门门槛、但明显高于底噪）不算静音，不能在句中收尾
{
  const gate = NearGate.create('near');
  feed(gate, 0.001, 10);
  assert.equal(opensWithin(gate, 0.12, 2), true);
  let closed = false;
  for (let i = 0; i < 30; i += 1) if (gate.update(0.015, BLOCK).justClosed) closed = true;
  assert.equal(closed, false, 'syllable tails above the noise floor must not end the utterance');
  for (let i = 0; i < 20; i += 1) if (gate.update(0.001, BLOCK).justClosed) closed = true;
  assert.equal(closed, true, 'real silence after the tail still closes the gate');
  console.log('✓ near mode: syllable tails do not trigger mid-utterance finalization');
}

// 解码器就绪时若正处在句中，残句整段忽略；等到句子边界后的下一句才收
{
  const gate = NearGate.create('near');
  gate.reset();
  assert.equal(opensWithin(gate, 0.12, 10), false, 'mid-utterance fragment must be ignored before arming');
  feed(gate, 0.001, 6); // 约 380 ms 安静，确认边界
  assert.equal(opensWithin(gate, 0.12, 2), true, 'next full utterance opens after a quiet boundary');
  console.log('✓ near mode: decoder starting mid-utterance ignores the fragment');
}

// 持续嘈杂底噪会抬高门槛：盖过底噪一点点的远处声音仍被挡，真正近讲才开门
{
  const gate = NearGate.create('near');
  feed(gate, 0.03, 300);
  assert(gate.threshold() > 0.09, `threshold adapts up in noise, got ${gate.threshold()}`);
  assert.equal(opensWithin(gate, 0.05, 100), false, 'speech just above the noise floor stays out');
  assert.equal(opensWithin(gate, 0.18, 3), true, 'clearly louder close speech still opens');
  console.log('✓ near mode: threshold rises with ambient noise, close speech still passes');
}

// 标准档灵敏得多：轻声即可开门（安静环境/手机放远时用）
{
  const gate = NearGate.create('standard');
  assert.equal(opensWithin(gate, 0.02, 2), true);
  const near = NearGate.create('near');
  assert.equal(opensWithin(near, 0.02, 50), false);
  console.log('✓ standard mode stays sensitive while near mode rejects the same level');
}

// 换题 reset 后关门但保留底噪：嘈杂环境里不会每题重新适应时误开门
{
  const gate = NearGate.create('near');
  feed(gate, 0.03, 300);
  const before = gate.threshold();
  gate.reset();
  assert.equal(gate.update(0.001, BLOCK).open, false);
  assert(Math.abs(gate.threshold() - before) < 0.01, 'noise floor survives reset');
  console.log('✓ reset closes the gate but keeps the learned noise floor');
}

console.log('near-gate: all tests passed');
