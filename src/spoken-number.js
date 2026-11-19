/* 把识别出的文字严格转成答案数字。
 *
 * 只认合乎说法的数：「八十三」「一百零五」「两百五」「一千二」「八三」「一零五」「83」。
 * 背景谈话被识别器硬凑成的「千一七百三」「五七七三八九四」这类串不合语法，直接拒绝，
 * 不会被宽松地算成某个答案。合法写法由程序枚举（0–1998，最多 4 位），查表即可。 */
const SpokenNumber = (() => {
  'use strict';
  const MAX = 1998; // 三位数 ± 三位数的最大答案
  const DIGITS = '零一二三四五六七八九';
  const VARIANTS = {
    '〇': '零', '壹': '一', '幺': '一', '贰': '二', '两': '二', '俩': '二', '叁': '三', '肆': '四',
    '伍': '五', '陆': '六', '柒': '七', '捌': '八', '玖': '九', '拾': '十', '佰': '百', '仟': '千',
  };
  const NUMERIC = /^(?:[0-9]+|[零〇一壹幺二两俩贰三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟]+)$/;
  let table = null;

  function normalize(text) {
    return String(text || '')
      .replace(/\[[^\]]*\]/g, '') // Vosk 的填充词，如 [FIL]、[SPK]
      .replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[，,。.、！!？?：:；;“”"'‘’（）()《》\s]/g, '');
  }

  // 标准读法：83 → 八十三，105 → 一百零五，1010 → 一千零一十，10 → 十。
  function standard(n) {
    const q = Math.floor(n / 1000);
    const h = Math.floor(n / 100) % 10;
    const t = Math.floor(n / 10) % 10;
    const o = n % 10;
    let s = '';
    if (q) s += DIGITS[q] + '千';
    if (h) s += DIGITS[h] + '百';
    else if (q && (t || o)) s += '零';
    if (t) s += (t === 1 && !q && !h ? '' : DIGITS[t]) + '十';
    else if (h && o) s += '零';
    if (o) s += DIGITS[o];
    return s || '零';
  }

  function forms(n) {
    const q = Math.floor(n / 1000);
    const h = Math.floor(n / 100) % 10;
    const t = Math.floor(n / 10) % 10;
    const o = n % 10;
    const base = standard(n);
    const out = [base, String(n).split('').map(d => DIGITS[d]).join('')];
    if (t === 1 && !q && !h) out.push('一' + base); // 一十五
    if (t === 1 && (q || h)) out.push(base.replace('一十', '十')); // 一百十五
    // 口语省略末尾单位：两百五 = 250，一千二 = 1200，一百一 = 110（中间有「零」时不能省）。
    if (!o && t && h) out.push(base.slice(0, -1));
    if (!o && !t && h && q) out.push(base.slice(0, -1));
    return out;
  }

  function build() {
    table = new Map();
    for (let n = 0; n <= MAX; n += 1) {
      forms(n).forEach(form => { if (!table.has(form)) table.set(form, n); });
    }
  }

  function canonical(text) {
    return normalize(text).replace(/[〇壹幺贰两俩叁肆伍陆柒捌玖拾佰仟]/g, ch => VARIANTS[ch]);
  }

  // 显示用：整段都是数字字符（临时结果可能还没说完，比如「一百零」）。
  function isNumeric(text) {
    if (/<unk>/i.test(String(text || ''))) return false;
    return NUMERIC.test(normalize(text));
  }

  // 判分用：合法的完整数字才返回数值，否则 null。
  function parse(text) {
    if (!isNumeric(text)) return null;
    const value = canonical(text);
    if (/^[0-9]+$/.test(value)) {
      if (!/^(?:0|[1-9][0-9]{0,3})$/.test(value)) return null;
      const number = Number(value);
      return number <= MAX ? number : null;
    }
    if (!table) build();
    return table.has(value) ? table.get(value) : null;
  }

  return { normalize, isNumeric, parse, standard, forms, MAX };
})();
