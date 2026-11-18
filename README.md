# 速算练习

手机上的加减法口算练习。看题后可以输入数字，也可以用普通话说出答案。**离线语音不依赖手机自带的语音识别服务。**

## 第一次在手机上使用

1. 用浏览器打开 **HTTPS** 页面。首次进入会看到「准备语音包」。点 **下载语音包**（引擎和模型合计约 **39 MB**），建议用 Wi-Fi，预留约 120 MB 存储空间。下载时能看进度，可以取消；中断后重试会复用已完整校验的文件。
2. 状态变为「已下载」后，点 **使用离线语音**，选择难度和题量，点 **开始练习**。到这一步才需要授权麦克风。说「八十三」或逐位说「八三」都可以，最终结果用于判分，临时转写不会提交。
3. 下载到同一浏览器后，可**断网重开同一网址**继续练习。第一次开始语音练习需要稍候片刻，让设备解压和载入模型。声音在本机处理，不上传、不保存录音。

不想下载？点 **跳过，先用打字**，立即进入设置，无需麦克风。下次直接进入练习设置，可随时点 **离线语音包** 回到准备页。打字不依赖模型、第三方脚本或 Service Worker。

### 语音方式与设备要求

- **离线识别（有包时优先）**：用 WebAssembly / Web Worker 解码麦克风音频。不要求 `SpeechRecognition`；需要现代浏览器的 Web Audio、`getUserMedia`、Service Worker 和 IndexedDB。推荐用近期版本的 Safari、Chrome 或 Firefox，在普通窗口打开。
- **浏览器识别（没装包时的可选方式）**：保留原来的 Web Speech API；仅在浏览器提供它时可用。设置页会明确标注「可能需要联网」。离线引擎出错不会偷偷切到这条路径。
- 点麦克风可以暂停；切到后台、结束练习、改用打字都会释放麦克风。离线模式从后台回来后点「继续收音」，便于 iOS 重新解锁音频。没有听清可以重说，连续几轮无声会暂停收音。
- 麦克风被拒时可在站点设置允许后重试，或直接改用打字。内嵌预览、应用内浏览器可能拦截存储或麦克风，建议在系统浏览器中打开。
- 语音包属于**当前设备、浏览器和站点**。换浏览器、清理站点数据或系统回收缓存后，可能需要重新下载。清理整个站点的数据也会删除练习设置和最好成绩。

## 练习功能

- 两位数 ± 两位数、两位数 ± 三位数、三位数 ± 三位数；加减随机，减法结果不为负。
- 10、20、30 题或不限量；显示进度、答对数和反馈。结束时可看正确率、用时、平均用时、错题回顾和各难度最好成绩。
- 新增「气泡寻数」游戏模式：题目在上方，9 个不同数字气泡在场地内轻轻漂浮、碰撞；可拖动、甩动气泡，点中正确数字才进入下一题。支持触屏拖拽、键盘聚焦及减少动态效果设置。物理模拟使用离线内嵌的 [Matter.js 0.20.0](https://github.com/liabru/matter-js)，MIT 许可，源码与许可证在 `third_party/matter-js/`。
- 语音输入只接受完整的数字表达（如「八十三」「一百零五」「105」「两百五」），「答案是八十三」等带其他文字的转写不会显示或判分；超出本项目最大答案范围的数字也会被拒绝。离线解码词表不包含开放词或答题提示词。两种语音引擎共用严格数字校验、判分和换题流程。
- 手机练习页提供可点按数字键盘（含清空、退格），同时保留实体键盘输入；不会自动弹出系统键盘遮挡题目。按钮尺寸、间距和安全区针对触屏优化。Enter 提交或跳过反馈，Esc 结束本组。设置与最好成绩保存在 localStorage，不需要账号。
- 离线识别沿用 GitHub 上游 Vosk Browser / Vosk 开源组件，优先请求 16 kHz 音频上下文，并用 1024 采样块解码；设备不支持时回退到默认采样率。检测到说话后，静音约 420 ms 就请求最终结果，减少等候 Vosk 默认端点的时间。实际速度仍取决于手机性能、麦克风和首次模型载入。

## 开源组件和离线机制

| 资源 | 固定来源 | 下载大小 |
| --- | --- | ---: |
| 识别引擎（JS、Worker、WASM） | [ccoreilly/vosk-browser v0.0.8](https://github.com/ccoreilly/vosk-browser/tree/v0.0.8)，基于 [Vosk API](https://github.com/alphacep/vosk-api) | 5.8 MB |
| 普通话小模型 | Alpha Cephei 的 [`vosk-model-small-cn-0.3.tar.gz`](https://github.com/ccoreilly/vosk-browser/tree/a4b0d0fe60359e5ea9800f810f6b6f6c1d2b03c6/models)，使用上游浏览器示例的 tar.gz 格式 | 33.2 MB |

引擎和上述模型随附的 Apache-2.0 许可证、版权声明在 [`third_party/vosk/`](third_party/vosk/)。固定的 Git blob、长度和 SHA-256 在 [`src/voice-pack.json`](src/voice-pack.json)。音频只送入本地 Vosk worker；数字词表不会使用本题的正确答案。

核心 HTML、样式和交互仍内联在 `index.html`，避免新旧页面和脚本混搭。**不在首屏预取模型**：只有点下载才安装同目录的 `sw.js`、缓存页面、获取并校验引擎和模型。页面与 Service Worker 从同一个 IndexedDB 读取离线首页和语音包；每个文件的内容与校验信息在同一事务内写入。显示「已下载」前检查首页和两个语音文件是否都在，不靠 localStorage 标记。Vosk 解压后的模型也可在下次启动时复用。联网访问优先取新页面，断网从缓存打开。

## 本地运行与发布

```sh
python3 build.py --site                 # 第一次需要联网，从固定的 GitHub blob 获取并校验资源
python3 -m http.server 8000 --directory dist
```

访问 <http://localhost:8000>。`dist/` 是完整的静态站点，语音资源与页面**同源**，终端用户不必能访问第三方 CDN 或 GitHub API。可以部署在子目录下；大文件不提交到 Git。**手机访问电脑的局域网 HTTP 地址不是 localhost**，实机语音请使用 HTTPS 部署。

不准备发布目录也可以 `python3 build.py && python3 -m http.server 8000`。默认构建不联网，更新仓库里的 `index.html` 和 `sw.js`；此模式在用户选择安装时从 GitHub 的公共 blob API 获取相同资源，需要网络能访问该 API。请保留 `sw.js`、manifest 和图标，不要只复制 HTML 来提供离线语音。

GitHub Pages 推荐将 **Settings → Pages → Source** 设为 **GitHub Actions**。`.github/workflows/pages.yml` 在推送到 `main` 时构建并发布 `dist/`。改动 `src/` 后请运行 `python3 build.py` 并一起提交生成的 `index.html` 和 `sw.js`。

## 回归测试

```sh
cd tests
npm ci
npx playwright install chromium webkit  # Linux 缺系统库时可加 --with-deps
npm test                                # Chromium 全流程
npm test -- webkit                      # WebKit 浏览器进程重启后的第一次离线作答
```

需要 Python 3.8+、Node 18+；也可用 `CHROMIUM_PATH` 指定现有 Chromium。测试在临时的 Pages 风格子路径运行，覆盖跳过下载打字、坏包校验、取消和重试、缓存缺失、拒绝麦克风及释放、原生语音降级。实测链路用合成的「八十三」WAV 作为浏览器测试麦克风：**禁用原生语音 → 下载 → 断网重新打开 → 首次载入真实 WASM/模型 → 识别并判分 → 下一题**。没有向线上语音服务发请求。

PR 的 `Offline voice checks` 只运行构建与测试，不部署网站。Chromium 和 WebKit 都会用持久化浏览器配置安装语音包，然后关闭浏览器进程、停掉测试站点的 HTTP 响应、用同一配置重开，验证第一次启动模型即可把 WAV 输入判为 83。此项验证的是浏览器引擎和离线路径，不代替 iPhone / Android 真机的系统授权与收音测试。
