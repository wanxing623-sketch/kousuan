# 第三方组件说明

## vendor/vosk-browser.js

- 项目：[ccoreilly/vosk-browser](https://github.com/ccoreilly/vosk-browser) v0.0.8
- 协议：Apache-2.0
- 说明：Vosk（[alphacep/vosk-api](https://github.com/alphacep/vosk-api)）的 WebAssembly 构建，
  自带 clapack / kaldi 的 WASM 产物，在浏览器里离线跑声学模型。
- 本地化的原因：内地访问 jsDelivr / CDN 经常失败，且不希望页面在用户按下「下载」之前
  就发出任何外部请求。文件按 npm 包原样放入 `vendor/`，未做修改。
- 校验：`sha256 29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c`
  （等于 npm `vosk-browser@0.0.8` 的 `dist/vosk.js`）

## models/vosk-model-small-cn.tar.gz

- 模型：`vosk-model-small-cn-0.22`，来自 [Vosk 模型库](https://alphacephei.com/vosk/models)
- 协议：Apache-2.0
- 说明：中文小模型（约 42 MB），供 `vosk-browser` 在浏览器里离线识别。
- 打包方式见 `tools/fetch_model.py`：把官方 zip 里的 `vosk-model-small-cn-0.22/`
  原样放进 tar.gz 顶层，固定 mtime 以保证可复现。
- 校验：`sha256 43dd93d10bfc9dcce622eff1b613bf7d90be888cb1f028c2c337a0bcccae1813`

## 语音作答的两种引擎

| 引擎 | 依赖 | 联网 | 适用 |
| --- | --- | --- | --- |
| 离线识别（默认） | `vendor/vosk-browser.js` + `models/vosk-model-small-cn.tar.gz` | 只在首次下载语音包时联网 | 手机浏览器、微信内置浏览器、断网状态 |
| 浏览器在线 | 浏览器自带 `SpeechRecognition` | 每次识别都把声音发到浏览器厂商的服务器 | 桌面 Chrome / Edge / Safari |
