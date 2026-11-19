/* 近讲收音：只把手机面前的说话声送进离线识别器。
 *
 * 声压随距离衰减（距离每远一倍约小 6 dB）：嘴离手机 20 cm 左右时，一两米外的人声
 * 加上房间回声通常也要小 10–20 dB。这里按 10 ms 一帧估计音量，同时满足三条才「开门」：
 *   1. 高于绝对下限（极小的声音一律不送）；
 *   2. 比环境底噪高出一截（底噪取最近 3 秒的最低音量，嘈杂处会自动抬高，
 *      而你自己一两秒的回答不会把它抬上去）；
 *   3. 校准后，不比你最近几次答对时的音量小太多（远处的人声再清楚也进不来）。
 * 开门前保留约 400 ms 预录，避免切掉「三」「十」「七」开头的轻辅音；说完后再等
 * 约 400 ms 才关门并请求最终结果。门关着时什么都不送，Vosk 不会把远处的谈话
 * 「凑」成数字，也更省电。
 *
 * 纯函数，不依赖 DOM / Web Audio，页面和 Node 测试共用同一份代码。 */
const NEAR_VOICE_MODES = {
  // minLevel：帧电平下限（dBFS）；overFloor：高于底噪；belowVoice：允许比校准音量小多少。
  standard: { minLevel: -50, overFloor: 15, belowVoice: 14 },
  strong: { minLevel: -44, overFloor: 19, belowVoice: 9 },
};

// 最近几次答对时的音量 → 校准值。取第二大的那个：偶尔一次特别大声，
// 或者一次混进来的远处声音，都不会把门限带偏。
function nearVoiceLevel(history) {
  const levels = (Array.isArray(history) ? history : [])
    .filter(level => typeof level === 'number' && isFinite(level) && level > -100 && level < 0)
    .slice(-5)
    .sort((a, b) => b - a);
  if (!levels.length) return null;
  return levels[Math.min(1, levels.length - 1)];
}

// 一条最终结果能否当作回答。太短的响动不算。一个字大约 0.2–0.3 秒：如果这段声音里
// 响亮的部分远远长过认出的字数应有的长度（1 个字超过 0.8 秒，每多一个字再放宽 0.5 秒），
// 多半是别人一长段话被只认数字的识别器硬套成了「五」「一百」，也不算——除非（校准后）
// 其中最响的部分和你平时说话一样响，那就是你自己在嘈杂处说的。
function nearVoiceAccepts(text, info) {
  if (!info || typeof info.voicedMs !== 'number') return true;
  if (info.speech === false) return false;
  const syllables = (String(text || '').match(/[零〇一二三四五六七八九十百千两幺]/g) || []).length;
  if (!syllables || !(info.loudMs > 800 + 500 * (syllables - 1))) return true;
  return typeof info.voice === 'number' && typeof info.peak === 'number' && info.peak >= info.voice - 6;
}

function createNearVoiceGate(sampleRate, options) {
  'use strict';
  options = options || {};
  const frame = Math.max(1, Math.round(sampleRate / 100)); // 10 ms
  const ONSET = 3; // 连续 30 ms 够响才开门，杯碟碰撞这类瞬态很难满足
  const HANG = 40; // 400 ms 尾音：数位之间的停顿不会把一个答案切成两半
  const PREROLL = 40; // 400 ms 预录：给识别器留足字头和一点前文，开门稍晚也不切字
  const FADE = 10; // 预录前 100 ms 渐入，减少串进上一段背景声
  const HYSTERESIS = 6; // 统计音量时：低于门限 6 dB 以内仍算在说话
  // 开门后，比门限低 KEEP 以内、同时又比底噪高出 KEEP_FLOOR 的声音（如句尾较轻的
  // 「十四」）仍然延长这一段；周围的嘈杂声通常够不上第二条，背景吵时也能及时收尾。
  const KEEP = 4;
  const KEEP_FLOOR = 13;
  const PEAK = 0.9; // 一段的代表音量取 90% 分位
  const MAX_OPEN = 400; // 一次最多 4 秒，背景一直很响时也会按时出结果
  const MIN_VOICED = 10; // 少于 100 ms 的有效语音不算回答
  const BLOCK = 50; // 底噪：每 0.5 秒记一次最低音量……
  const BLOCKS = 6; // ……取最近 3 秒中的最低值
  const TAIL = new Float32Array(Math.round(sampleRate * 0.12)); // 送 120 ms 静音，帮解码器收尾

  // 只用于估计音量的一阶高通（约 150 Hz），去掉手持摩擦、交通隆隆声；送识别的仍是原声。
  const hpA = Math.exp(-2 * Math.PI * 150 / sampleRate);
  let hpIn = 0;
  let hpOut = 0;

  let mode = 'standard';
  let settings = NEAR_VOICE_MODES.standard;
  let voice = null;
  let level = -100;
  let smooth = null;
  let blockMin = Infinity;
  let blockCount = 0;
  let minima = [];
  let floor = -100;
  let threshold = -50;
  let open = false;
  let above = 0;
  let onsetLevels = [];
  let hang = 0;
  let openFrames = 0;
  let voicedFrames = 0;
  let levels = [];
  let last = null; // 最近一段（进行中或刚结束）的统计
  // 「已过滤」：门没开，但出现了一段明显高于底噪、持续 0.2 秒以上的声音（多半是别人在说话）。
  let activity = 0; // 这段声音从第一帧到最近一帧的长度（帧），中间短暂的停顿也算在内
  let activityGap = 0; // 之后已经安静了多少帧
  let ignored = 0;

  const ring = new Float32Array(PREROLL * frame);
  let ringStart = 0;
  let ringFrames = 0;
  const current = new Float32Array(frame);
  let fill = 0;
  let energy = 0;
  let pending = [];
  let pendingLength = 0;

  // 关闭近讲收音时沿用旧版行为：所有声音都送识别器，按整体音量判断停顿。
  let legacyStart = 0;
  let legacyLast = 0;
  let legacyRequested = false;
  let clock = 0;

  function currentThreshold() {
    let value = Math.max(settings.minLevel, floor + settings.overFloor);
    if (voice !== null) {
      // 校准后：远处的声音要比你的音量小 belowVoice 以上才挡；但再吵也不要求
      // 比你平时更大声，避免嘈杂处把你自己也挡在门外。
      value = Math.max(Math.min(value, voice - 4), voice - settings.belowVoice, settings.minLevel);
    }
    return value;
  }

  function queue(samples) {
    pending.push(samples);
    pendingLength += samples.length;
  }

  function flush(feed) {
    if (!pendingLength) return;
    const data = new Float32Array(pendingLength);
    let offset = 0;
    pending.forEach(part => { data.set(part, offset); offset += part.length; });
    pending = [];
    pendingLength = 0;
    feed(data);
  }

  function remember(samples) {
    const slot = (ringStart + ringFrames) % PREROLL;
    ring.set(samples, slot * frame);
    if (ringFrames < PREROLL) ringFrames += 1;
    else ringStart = (ringStart + 1) % PREROLL;
  }

  function releasePreroll() {
    const data = new Float32Array(ringFrames * frame);
    for (let i = 0; i < ringFrames; i += 1) {
      const slot = (ringStart + i) % PREROLL;
      data.set(ring.subarray(slot * frame, (slot + 1) * frame), i * frame);
    }
    const fadeLength = Math.max(0, Math.min(FADE, ringFrames - ONSET)) * frame;
    for (let i = 0; i < fadeLength; i += 1) data[i] *= i / fadeLength;
    ringStart = 0;
    ringFrames = 0;
    queue(data);
  }

  // 一段声音的统计：voicedMs 有效语音时长；level 代表音量（90% 分位，用于校准）；
  // peak 最响的部分（97% 分位）；loudMs 与代表音量相差 6 dB 以内的时长；voice 当前校准值。
  function summary() {
    const sorted = levels.slice().sort((a, b) => a - b);
    // 取高分位：一段里混进了较轻的背景声，也主要反映你自己说话最响的部分。
    const top = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(PEAK * sorted.length))] : level;
    const peak = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.97 * sorted.length))] : level;
    let loud = 0;
    for (let i = 0; i < sorted.length; i += 1) if (sorted[i] >= top - 6) loud += 1;
    return {
      voicedMs: voicedFrames * 10,
      loudMs: loud * 10,
      peak: Math.round(peak * 10) / 10,
      level: Math.round(top * 10) / 10,
      speech: voicedFrames >= MIN_VOICED,
      threshold: Math.round(threshold * 10) / 10,
      voice,
    };
  }

  function trackFloor() {
    smooth = smooth === null ? level : smooth + 0.35 * (level - smooth);
    if (smooth < blockMin) blockMin = smooth;
    blockCount += 1;
    if (blockCount === BLOCK) {
      minima.push(blockMin);
      if (minima.length > BLOCKS) minima.shift();
      blockMin = Infinity;
      blockCount = 0;
    }
    floor = Math.min(blockMin, Math.min.apply(null, minima.length ? minima : [Infinity]));
    if (!isFinite(floor)) floor = level;
    floor = Math.max(-100, Math.min(-20, floor));
  }

  function finishActivity() {
    if (activity >= 20) ignored += 1; // 持续 200 ms 以上才算一段
    activity = 0;
    activityGap = 0;
  }

  function onFrame(feed, end) {
    level = Math.max(-100, 10 * Math.log10(energy / frame + 1e-10));
    fill = 0;
    energy = 0;
    trackFloor();
    threshold = currentThreshold();
    if (!open) {
      if (level >= threshold) {
        above += 1;
        onsetLevels.push(level);
      } else {
        above = 0;
        onsetLevels = [];
      }
      if (level >= floor + 9) {
        activity = activity ? activity + activityGap + 1 : 1;
        activityGap = 0;
      } else if (activity && ++activityGap > 15) {
        finishActivity();
      }
      remember(current);
      if (above >= ONSET) {
        open = true;
        hang = 0;
        openFrames = above;
        voicedFrames = above;
        levels = onsetLevels;
        onsetLevels = [];
        activity = 0;
        activityGap = 0;
        releasePreroll();
        last = summary();
      }
      return;
    }
    if (level >= threshold - HYSTERESIS) {
      voicedFrames += 1;
      levels.push(level);
    }
    if (level >= Math.max(threshold - KEEP, floor + KEEP_FLOOR)) hang = 0;
    else hang += 1;
    openFrames += 1;
    queue(current.slice());
    if (hang >= HANG || openFrames >= MAX_OPEN) {
      open = false;
      above = 0;
      last = summary();
      levels = [];
      queue(TAIL);
      flush(feed);
      end(last);
    }
  }

  function legacy(input, feed, end) {
    feed(input.slice());
    let sum = 0;
    let count = 0;
    for (let i = 0; i < input.length; i += 4) { sum += input[i] * input[i]; count += 1; }
    const rms = Math.sqrt(sum / Math.max(1, count));
    level = Math.max(-100, 20 * Math.log10(rms + 1e-10));
    clock += input.length / sampleRate * 1000;
    if (rms >= 0.008) {
      if (!legacyStart || legacyRequested) legacyStart = clock;
      legacyRequested = false;
      legacyLast = clock;
      open = true;
    } else if (legacyStart && !legacyRequested && clock - legacyStart >= 120 && clock - legacyLast >= 420) {
      legacyRequested = true;
      open = false;
      last = { voicedMs: null, level: null, speech: true, threshold: null };
      end(last);
    }
  }

  // 送入一段麦克风采样。feed(Float32Array) 收到要识别的声音；end(info) 表示一句话说完，
  // 应请求最终结果。info.speech 为 false 时只是很短的响动，结果不应当作回答。
  function process(input, feed, end) {
    if (mode === 'off') { legacy(input, feed, end); return; }
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i];
      hpOut = hpA * (hpOut + sample - hpIn);
      hpIn = sample;
      energy += hpOut * hpOut;
      current[fill] = sample;
      fill += 1;
      if (fill === frame) onFrame(feed, end);
    }
    flush(feed);
  }

  // 换题或暂停时丢掉半句话，但保留底噪和校准。
  function reset() {
    open = false;
    above = 0;
    onsetLevels = [];
    hang = 0;
    levels = [];
    last = null;
    ringStart = 0;
    ringFrames = 0;
    pending = [];
    pendingLength = 0;
    fill = 0;
    energy = 0;
    activity = 0;
    activityGap = 0;
    legacyStart = 0;
    legacyLast = 0;
    legacyRequested = false;
  }

  function setMode(next) {
    const value = next === 'off' || NEAR_VOICE_MODES[next] ? next : 'standard';
    if (value === mode) return;
    mode = value;
    settings = NEAR_VOICE_MODES[value] || NEAR_VOICE_MODES.standard;
    reset();
  }

  function setVoiceLevel(value) {
    voice = typeof value === 'number' && isFinite(value) ? value : null;
  }

  // 最近一段的统计：门开着时是进行中的这段，否则是刚结束的那段。
  function segment() {
    if (open && mode !== 'off') return summary();
    return last;
  }

  function meter() {
    return { level, threshold, floor, open, ignored, calibrated: voice !== null, mode };
  }

  setMode(options.mode);
  setVoiceLevel(options.voiceLevel);
  return { process, reset, setMode, setVoiceLevel, segment, meter };
}
