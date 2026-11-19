/* 近讲门控（near-field gate）：只把「离麦克风近、明显比环境底噪响」的声音送给识别器。
 *
 * 原理：单麦克风分不清方向，但近处说话比远处说话响得多（距离每远一倍约弱 6 dB）。
 * 浏览器自动增益（AGC）会把远处人声放大到和近处一样响，所以近讲档要关掉 AGC，
 * 再用这里的门控按响度筛选：持续估计环境底噪，只有响度超过 max(绝对下限, 底噪×倍数)
 * 并维持一小段时间的声音才开门，开门前的预录音频会一并补送，避免吞掉第一个字。
 * 这借鉴了开源 VAD（如 Silero VAD / WebRTC VAD）「先判活再识别」的思路，但判的不是
 * 「是不是人声」，而是「够不够近」——远处的人声同样是人声，普通 VAD/降噪挡不住。
 *
 * 纯函数式实现，不依赖 DOM，可在 Node 里直接单测（tests/near-gate.cjs）。 */
const NearGate = (() => {
  'use strict';

  const PROFILES = {
    /* 标准收音：灵敏度优先，适合安静环境、手机放得稍远 */
    standard: { minOn: 0.012, maxOn: 0.07, ratio: 2.2, onsetMs: 50, floorCap: 0.05 },
    /* 只听近处：响度门槛高且随底噪抬升，适合周围有人说话时手持近讲 */
    near: { minOn: 0.045, maxOn: 0.16, ratio: 4, onsetMs: 96, floorCap: 0.08 },
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function create(profileName) {
    const profile = PROFILES[profileName] || PROFILES.standard;
    let floor = 0.008;      // 环境底噪 RMS 估计，随安静/嘈杂缓慢自适应
    let open = false;
    let armed = true;       // 是否已确认处在句子边界；每次 reset（换解码器）后需重新确认
    let armMs = 0;
    let loudMs = 0;         // 已持续超过开门门槛的时间
    let quietMs = 0;        // 开门后持续低于关门门槛的时间

    const threshold = () => clamp(floor * profile.ratio, profile.minOn, profile.maxOn);

    function reset() {
      // 每道题换解码器时调用：关门并清计时，但保留已学到的底噪，避免重新适应时误收。
      // 同时要求先听到约 300 ms 安静才开始收第一句：若解码器就绪时用户/录音已在
      // 句中，前半截残句（如只剩「十三」）会被当成完整答案，必须整段忽略。
      open = false;
      armed = false;
      armMs = 0;
      loudMs = 0;
      quietMs = 0;
    }

    /* rms: 本块（约几十毫秒）的均方根响度；blockMs: 本块时长。
     * 返回 { open, justOpened, justClosed, threshold, floor, audible }
     * audible 表示「有明显高于底噪的声音，但还没响到能开门」——多半是被挡住的远处声音。 */
    function update(rms, blockMs) {
      const on = threshold();
      // 关门门槛要远低于开门门槛：汉字音节的尾巴和字间停顿响度会掉到开门值的一半以下，
      // 若按开门值判静音，会在句中误收尾、只提交第一个字。用接近环境底噪的低门槛判「还在说」。
      const off = Math.max(0.009, Math.min(on * 0.55, floor * 2.5));
      let justOpened = false;
      let justClosed = false;

      if (!open && !armed) {
        // 还没确认句子边界：句中残音一律不收，等响度回落并维持约 300 ms 才待命。
        loudMs = 0;
        if (rms <= Math.max(0.009, floor * 1.6)) {
          armMs += blockMs;
          if (armMs >= 300) armed = true;
        } else {
          armMs = 0;
        }
        if (rms < on) {
          if (rms < floor) floor = floor * 0.94 + rms * 0.06;
          else floor = floor * 0.985 + rms * 0.015;
          floor = clamp(floor, 0.0015, profile.floorCap);
        }
      } else if (!open) {
        if (rms >= on) {
          // 不要求严格连续：语音块响度起伏时允许衰减累计，避免永远差一点开不了门。
          loudMs += blockMs;
          if (loudMs >= profile.onsetMs) {
            open = true;
            justOpened = true;
            loudMs = 0;
            quietMs = 0;
          }
        } else {
          loudMs = Math.max(0, loudMs - blockMs);
          // 只在门外且声音低于门槛时学底噪：安静时学得快，嘈杂时学得慢，
          // 远处持续说话会把门槛越抬越高，而不是被当成要识别的内容。
          if (rms < floor) floor = floor * 0.94 + rms * 0.06;
          else floor = floor * 0.985 + rms * 0.015;
          floor = clamp(floor, 0.0015, profile.floorCap);
        }
      } else if (rms >= off) {
        quietMs = 0;
      } else {
        quietMs += blockMs;
        // 关门等待要明显长于字间停顿：逐字慢说「八…十…三」时字间可停半秒多，
        // 太早关门会只提交第一个字。约 850 ms 真静音才算说完，尾巴的远处声音不再送入。
        if (quietMs >= 850) {
          open = false;
          justClosed = true;
          quietMs = 0;
          loudMs = 0;
        }
      }

      return {
        open,
        armed,
        justOpened,
        justClosed,
        threshold: threshold(),
        offThreshold: off,
        floor,
        audible: rms >= Math.max(0.012, floor * 1.6),
      };
    }

    return { update, reset, threshold, profile: profileName in PROFILES ? profileName : 'standard' };
  }

  return { create, PROFILES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NearGate;
