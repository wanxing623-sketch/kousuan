# 速算练习

一个移动端优先的中文口算练习网页：**可以直接说出答案**，也可以打字作答。两位数 / 三位数加减法，10、20、30 或不限题量，练完看正确率与用时。纯静态站点，无构建、无后端、无 API Key，直接部署到 GitHub Pages。

线上地址：https://wanxing623-sketch.github.io/kousuan/

## 功能

- **两种作答方式**：打字输入，或语音作答（说完自动判分、自动切下一题）
- **三档难度**：两位数 ± 两位数（47 + 36）、两位数 ± 三位数（385 − 27）、三位数 ± 三位数（648 + 293）
- **题量**：10 / 20 / 30 / 不限
- **计时**：每题用时、整组总用时；答对立刻进下一题，答错显示正确答案
- **结果页**：正确率、用时、错题前 3 题
- 设置记忆（本机 localStorage）、深色模式、320px 窄屏可用

## 语音识别是怎么做的

语音使用 [Vosk](https://github.com/alphacep/vosk-api)（Apache-2.0）**离线**中文模型，跑在浏览器里：

- `vendor/vosk.js`：Vosk 的浏览器版（含 WebAssembly 与 Worker），随仓库一起部署
- `model/vosk-model-small-cn-0.22.tar.gz`：约 42MB 的中文小模型，首次使用下载一次，之后存入 **Cache Storage**，再打开直接可用
- 音频不入网：麦克风采集 → 识别全部在本机完成，不上传任何声音

### 为什么不是 Web Speech API

`SpeechRecognition` 在安卓 Chrome 里依赖 Google 的联网服务，国内网络下经常直接不可用；而且它在移动端会抢占音频焦点、说完一句就结束，做不到「连续整组聆听」。改成离线 Vosk 后，语音在断网、翻墙与否的环境里都能用。

### 说话就能判分的三个必要细节

1. **采样率必须 16kHz**：离线模型只认 16kHz。安卓 Chrome 的 `AudioContext` 默认 48kHz，直接把麦克风数据喂进去会识别成乱码，所以创建上下文时显式指定 `sampleRate: 16000`。
2. **音频上下文要在点击手势里创建**：安卓 Chrome 禁止在用户手势之外启动音频。`AudioContext` 在点「开始练习」时就同步创建并 `resume()`，而不是等 42MB 模型下载完再建——否则会永远停在 `suspended`，界面显示「正在聆听」但一个回调都不会来。
3. **麦克风整组只申请一次**：换题时只重建识别器，不断开音轨、不重新弹权限，因而题与题之间没有停顿。

识别到中文数字后会转成数值判分，支持「八十三」「一百零五」「一百一十」「五百四十六」以及逐位读法「八三」这类说法；「一百亿」这种明显超出四位数范围的误识别会被丢弃，让用户重说。

## 本地运行

语音需要安全上下文（HTTPS 或 localhost）与麦克风权限：

```sh
python3 -m http.server 8000
# 打开 http://localhost:8000
```

直接双击 `index.html`（`file://`）只能用打字模式。

## 目录

```
index.html              页面结构
styles.css              样式（Inter + 思源黑体子集，本地自托管）
app.js                  全部逻辑：出题、判分、计时、语音
vendor/vosk.js          Vosk 浏览器运行时
model/*.tar.gz          中文离线模型
fonts/                  字体子集与许可证
.github/workflows/      GitHub Pages 部署
```

## 致谢与许可

- 语音识别：[Vosk](https://github.com/alphacep/vosk-api)（Apache-2.0）与 [vosk-browser](https://github.com/ccoreilly/vosk-browser)，中文模型 `vosk-model-small-cn-0.22`
- 字体：Inter（OFL-1.1）、Noto Sans SC 子集（OFL-1.1），许可证见 `fonts/`
