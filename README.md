# 速算练习

打开就能用的加减法口算练习页。两位数、三位数都能练，可以按数字答题，也可以看着题直接说出答案。
**语音识别可以完全在本机跑**：第一次打开时下载一次离线中文语音包，之后不联网、不上传录音，
手机浏览器（包括微信内置浏览器）也能说话答题。

线上主体只有 **一个文件**：`index.html`。样式和主脚本都在里面内联着，打开页面时没有任何外部请求。

这么做是刻意的。这个页面被反复报「打开后点不动」，而每次的原因都是同一类：浏览器拿到的新页面配了旧的
`app.js`／`styles.css`，或者那个 `.js` 请求被拦掉了。合成一个文件之后，这种新旧混搭在物理上不可能发生。

只有两个文件是按需加载的，而且都要等用户主动点「下载」：

| 文件 | 体积 | 作用 |
| --- | --- | --- |
| `vendor/vosk-browser.js` | 5.6 MB | 离线识别引擎（Vosk 的 WASM 版） |
| `models/vosk-model-small-cn.tar.gz` | 42 MB | 中文语音模型，装进浏览器的 IndexedDB 后就不再联网 |

## 功能

- **首次打开的引导页**：说明离线语音包是什么、多大、装在哪里，一个按钮下载，也可以跳过先用打字。
  装好之前不会往练习页里塞一个「点了没反应」的麦克风。
- **两种作答方式**
  - 打字作答：题目下方的输入框，手机自动弹出数字键盘，回车或「确认答案」提交。
  - 语音作答：题目出现后直接说答案，识别成功自动进入下一题，不用点屏幕。
- **两种识别引擎**（同时支持时可在设置里切换）
  - **离线识别（默认）**：`vosk-browser` + 中文小模型，声音在本机识别，断网可用。
  - **浏览器在线**：浏览器自带的 Web Speech API，无需下载，但每次识别都要联网。
- **三种难度**：两位数 ± 两位数、两位数 ± 三位数、三位数 ± 三位数（加减随机，减法保证结果不小于 0）。
- **题量选择**：10 题、20 题、30 题或不限；不限时随时点「结束练习」。
- **练习中**：进度、答对题数、对错反馈，答错会给出正确答案。
- **结束后**：正确率、总用时、平均每题用时、错题回顾，以及该难度的最好成绩。
- **本地保存**：设置和最好成绩存在浏览器的 localStorage，语音包装在 IndexedDB，都不联网、不需要账号。
- **移动端优先**：手机答题区贴在屏幕底部（单手可达、不被键盘挡住）、点击区域不小于 44px、
  适配刘海屏安全区、切到别的标签页自动放下麦克风、尊重「减少动态效果」系统设置。

## 离线语音包怎么工作

1. 首次打开停在引导页，点「下载离线语音包」。
2. 页面按顺序尝试三个地址，任一成功即可：
   `models/vosk-model-small-cn.tar.gz`（同源）→ jsDelivr 镜像 → raw.githubusercontent 镜像。
   这样即使某个域名被墙或部署漏了文件，也还有退路。
3. `vosk-browser` 在 Worker 里把 tar.gz 解压进浏览器的 IndexedDB（`/vosk/<文件名>/`），
   再加载成模型；`localStorage` 里只记一个「已装好」的标记和成功的地址。
4. 之后每次打开直接按标记去 IndexedDB 取模型，**不再发起任何网络请求**，断网也能识别。
5. 下载或解压被打断（切后台、锁屏）时，再点一次即可；进度条只显示已用时间，不编造百分比。

设置页底部一直有一行「离线语音包」状态，可以随时补下载；从设置里也可以切回浏览器在线识别。

## 语音作答说明

- 麦克风权限是必须的，页面要在 **HTTPS 或 localhost** 下打开（GitHub Pages 自带 HTTPS）。
- 识别结果支持中文数字和阿拉伯数字，例如「八十三」「一百零五」「83」「一零五」。
- 能容忍常见的识别偏差：
  - 同音字，例如「四」被听成「是」「寺」「事」；
  - 带口语或多余字，例如「答案是 47」「这个数是 47 吧」「嗯 47」；
  - 口语省字，例如「两百五」按 250、「一千二」按 1200。
- 没有听到数字时会提示再说一次；约 14 秒没有声音就暂停收音，点「继续收音」即可。
- 点麦克风可随时暂停收音；切到别的标签页时自动放下麦克风，这段时间也不计入用时，回来会自动重连。
- 麦克风被拒绝、被系统占用或者离线引擎没启动成功时，会给出「重新打开麦克风」按钮，
  也可以一键改用打字作答，不会卡在不能用的界面上。
- 离线包坏了或缓存被清掉、而浏览器自带识别可用时，会**当场**换成在线识别继续这一组，
  不会让练习中途作废；缓存里「已装好」的标记也会同时作废，设置页提示重新下载。
- 在微信 / QQ 内置浏览器、以及嵌入式预览窗口里，页面顶部会先提示「在浏览器打开更稳」。

## 操作快捷键

| 按键 | 作用 |
| --- | --- |
| Enter | 提交答案 / 跳过反馈直接下一题 |
| Esc | 结束本组，查看成绩 |

## 兼容性

- 建议 iOS / iPadOS 12 以上、Chrome / Edge / Safari 近几年的版本。
- 离线识别需要 WebAssembly、`AudioContext` 和 `getUserMedia`：iOS 14.5+ / Android Chrome 90+ 基本都满足。
- 缺什么能力就降级什么：没有离线能力（如很老的 WebView）就只能用浏览器在线识别；
  连在线识别也没有（如 Firefox）就自动退回打字作答，并在设置页写明原因。
- 布局关键间距不依赖 flex 的 `gap`（Safari 14.5 之前不支持），旧 iPad 上不会挤在一起；
  `min()` / `env()` 都有 px 回退；`matchMedia` 缺失也不会让脚本崩掉。
- **出问题会说话**：脚本没跑起来、或者运行中报错，页面顶部会直接显示原因和「重新加载」按钮。

## 本地运行

```sh
python3 build.py                 # 把 src/ 里的样式和脚本内联进 index.html
python3 -m http.server 8000      # 语音识别需要 localhost 或 HTTPS
```

然后访问 <http://localhost:8000>。

```sh
npm install                      # 只有 jsdom，用来跑回归
npm test                         # node tests/run.js
```

## 改代码

```
src/page.html       页面结构（含兜底提示、内嵌浏览器提示）
src/styles.css      样式
src/app.js          主逻辑：设置、出题、判题、成绩、语音控制
src/offline-asr.js  离线识别：引擎加载、模型下载/缓存、麦克风、Vosk 会话
build.py            生成单文件 index.html（产物要一起提交）
tools/fetch_model.py 重新生成 models/vosk-model-small-cn.tar.gz
tests/run.js        jsdom 回归测试（假 Vosk + 假麦克风走完控制流）
vendor/             vosk-browser.js 及其许可说明
models/             中文语音模型 tar.gz（Git LFS）
```

改完跑一下回归：

```sh
python3 build.py
npm test
```

覆盖：首屏引导页、语音包下载与失败重试、引擎切换、打字全流程与结果统计、离线语音的
「麦克风 → 16 kHz 重采样 → 判题」、麦克风被拒、没有离线能力时的降级、结构兜底提示、
以及移动端贴底答题区和安全区的 CSS 约束。

### 更新语音模型

```sh
python3 tools/fetch_model.py            # 下载官方 zip → 生成 tar.gz
python3 tools/fetch_model.py --verify    # 检查现有包结构
```

生成的 tar.gz 时间戳固定，同样的输入会得到同样的字节，方便用 sha256 校验镜像。

## 发布到 GitHub Pages

先 `python3 build.py` 生成 `index.html`，再提交。仓库里的 `.github/workflows/pages.yml`
在推送到 `main` 时自动部署，并且在部署前会检查两件事：`index.html` 和源码是否一致、
模型包结构是否完整（所以 `index.html` 忘了重新生成会导致部署失败，而不是悄悄上线旧页面）。

仓库 **Settings → Pages** 里把发布来源设为默认分支的 `/ (root)` 即可。

`models/vosk-model-small-cn.tar.gz` 是 42 MB 的二进制。建议用 Git LFS 托管一次：

```sh
git lfs install
git lfs track "models/*.tar.gz"
git lfs migrate import --include="models/*.tar.gz"
git push --force-with-lease
```

工作流里已经带了 `lfs: true`，只要模型文件进了 LFS，部署时就会正常拉下来；
没进 LFS 也能用，只是仓库会大一些。

## 第三方组件

- [vosk-browser](https://github.com/ccoreilly/vosk-browser) 0.0.8（Apache-2.0）
- [Vosk 中文小模型](https://alphacephei.com/vosk/models) `vosk-model-small-cn-0.22`（Apache-2.0）

详见 `vendor/LICENSE-NOTICE.md`。
