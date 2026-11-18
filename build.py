#!/usr/bin/env python3
"""把 src/ 里的样式和脚本内联进 index.html，生成单文件页面。

单文件是刻意的：这个页面被反复吐槽「链接点开没反应」，根因几乎都是
新 HTML 配了旧的 app.js / styles.css（或其中一个请求被拦）。合成一个
文件之后，这种新旧混搭在物理上就不可能发生。

例外只有两个，都跟离线语音有关，而且都只在用户点下载后才请求：
vendor/vosk-browser.js（识别引擎，5.6 MB）
models/vosk-model-small-cn.tar.gz（中文模型，42 MB，塞进单文件不现实）
"""
import pathlib

ROOT = pathlib.Path(__file__).parent


def read(name):
    return (ROOT / 'src' / name).read_text(encoding='utf-8')


def escape(code):
    """避免源码里的闭合标签提前结束 <script>/<style>。"""
    return code.replace('</script', '<\\/script').replace('</style', '<\\/style')


def main():
    page = read('page.html')
    css = escape(read('styles.css')).rstrip()
    offline = escape(read('offline-asr.js')).rstrip()
    js = escape(read('app.js')).rstrip()

    html = page.replace('<!--@styles-->', '<style>\n' + css + '\n  </style>')
    # 离线识别单独一段：它不依赖主逻辑，主逻辑挂了也还能解释清楚
    html = html.replace('<!--@app-->', '<script>\n' + offline + '\n  </script>\n  <script>\n' + js + '\n  </script>')


    if '<!--@' in html:
        raise SystemExit('还有没替换的占位符')

    out = ROOT / 'index.html'
    out.write_text(html, encoding='utf-8')
    print(f'{out.name}  {len(html.encode()) / 1024:.1f} KB  '
          f'(css {len(css.encode()) / 1024:.1f} KB + js {len(js.encode()) / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
