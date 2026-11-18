#!/usr/bin/env node
/*
 * 引擎冒烟测试：确认 vendor 里的识别引擎真的能加载，模型包结构对得上。
 *
 * 真机上「跑 WASM + 麦克风」这件事 jsdom 做不到，但下面这些是能在 CI 里断言的：
 *   1. vendor/vosk-browser.js 能解析、执行，并暴露 window.Vosk（含 Model / createModel）
 *   2. 引擎内部的 Worker 是 base64 内联的，不依赖额外请求的 worker 文件
 *   3. models/*.tar.gz 是合法 gzip，顶层只有一个目录，且 Vosk 需要的文件齐全
 *   4. index.html 里没有引用 CDN 的硬编码（外链只在离线模块的备用线路里）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const vm = require('vm');
const assert = require('assert');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'vendor', 'vosk-browser.js');
const MODEL = path.join(ROOT, 'models', 'vosk-model-small-cn.tar.gz');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n    ${error.message}`);
  }
}

console.log('引擎冒烟测试');

check('vendor/vosk-browser.js 语法可解析', () => {
  new vm.Script(fs.readFileSync(ENGINE, 'utf8'), { filename: 'vosk-browser.js' });
});

check('引擎在浏览器环境里暴露出 Vosk.Model / Vosk.createModel', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1:8000/',
    virtualConsole: new VirtualConsole(),
  });
  /* 用带 src 的外部脚本方式引入，跟线上一致（内联会被某些沙箱拦掉） */
  const script = dom.window.document.createElement('script');
  script.src = 'file://' + ENGINE;
  dom.window.document.head.appendChild(script);
  vm.runInContext(
    fs.readFileSync(ENGINE, 'utf8'),
    dom.getInternalVMContext(),
    { filename: 'vosk-browser.js' },
  );
  const { Vosk } = dom.window;
  assert.ok(Vosk, 'window.Vosk 没出现');
  assert.strictEqual(typeof Vosk.createModel, 'function');
  assert.strictEqual(typeof Vosk.Model, 'function');
  dom.window.close();
});

check('引擎自带内联 Worker 和 WASM（不额外请求 worker / wasm 文件）', () => {
  const source = fs.readFileSync(ENGINE, 'utf8');
  assert.ok(source.indexOf("createBase64WorkerFactory('Lyogcm9sbHVw") !== -1, '没有内联 Worker');
  assert.ok(!/new Worker\((['"])[^'"]*\.js\1/.test(source), 'Worker 指向了外部文件');

  /* Worker 代码是 base64 打包的，解出来确认里面有内联的 WASM 和 ArchiveHelper。
     注意 String.match 在超长 base64 上会爆栈，这里手动切片 */
  const start = source.indexOf("createBase64WorkerFactory('") + "createBase64WorkerFactory('".length;
  const end = source.indexOf("'", start);
  const payload = source.slice(start, end);
  assert.ok(payload.length > 1000000, `Worker 载荷太小: ${payload.length}`);
  const worker = Buffer.from(payload, 'base64').toString('utf8');
  assert.ok(worker.indexOf('data:application/octet-stream;base64,AGFzbQ') !== -1, 'WASM 没有内联');
  assert.ok(worker.indexOf('downloadAndExtract') !== -1, 'Worker 里没有模型下载/解压逻辑');
  assert.ok(worker.indexOf('ArchiveHelper') !== -1, 'Worker 里没有 tar.gz 解压实现');
});

check('模型包是合法 gzip + tar，顶层只有一个目录', () => {
  const raw = zlib.gunzipSync(fs.readFileSync(MODEL));
  const names = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField || '0', 8);
    const type = String.fromCharCode(header[156]);
    names.push({ name: name.replace(/\/$/, ''), type, size });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const tops = new Set(names.map((item) => item.name.split('/')[0]));
  assert.strictEqual(tops.size, 1, `顶层目录不止一个: ${[...tops]}`);
  const top = [...tops][0];
  assert.ok(/^vosk-model-small-cn/.test(top), `顶层目录名不对: ${top}`);

  const flat = names.map((item) => item.name);
  [
    'am/final.mdl',
    'graph/Gr.fst',
    'graph/HCLr.fst',
    'graph/phones/word_boundary.int',
    'conf/mfcc.conf',
    'conf/model.conf',
    'ivector/final.ie',
  ].forEach((needle) => {
    assert.ok(flat.indexOf(`${top}/${needle}`) !== -1, `缺少 ${needle}`);
  });

  /* 文件体积要对得上，避免 LFS 指针或截断文件混进来 */
  const mdl = names.find((item) => item.name.endsWith('am/final.mdl'));
  assert.ok(mdl.size > 10 * 1024 * 1024, `final.mdl 只有 ${mdl.size} 字节，像是坏包`);
});

check('index.html 打开时不请求任何外部资源', () => {
  const tags = HTML.match(/<(?:script|link|img|source)[^>]*(?:src|href)="([^"]+)"/g) || [];
  const external = tags.filter((tag) => /(?:src|href)="https?:/.test(tag));
  assert.deepStrictEqual(external, []);
});

check('离线引擎只在用户点下载后加载（不在首屏请求里）', () => {
  assert.ok(!/<script[^>]+src="vendor\/vosk-browser\.js"/.test(HTML), '引擎被写进了首屏');
  assert.ok(HTML.indexOf("'vendor/vosk-browser.js'") !== -1 || HTML.indexOf('vendor/vosk-browser.js') !== -1);
});

console.log('');
if (failed) {
  console.log(`✗ ${failed} 项失败`);
  process.exit(1);
}
console.log('✓ 全部通过');
