#!/usr/bin/env python3
"""把 src/ 里的样式和脚本内联进 index.html，生成单文件页面。

单文件是刻意的：这个页面被反复吐槽「链接点开没反应」，根因几乎都是
新 HTML 配了旧的 app.js / styles.css（或其中一个请求被拦）。合成一个
文件之后，这种新旧混搭在物理上就不可能发生。
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
    js = escape(read('app.js')).rstrip()

    html = page.replace('<!--@styles-->', '<style>\n' + css + '\n  </style>')
    html = html.replace('<!--@app-->', '<script>\n' + js + '\n  </script>')

    if '<!--@' in html:
        raise SystemExit('还有没替换的占位符')

    out = ROOT / 'index.html'
    out.write_text(html, encoding='utf-8')
    print(f'{out.name}  {len(html.encode()) / 1024:.1f} KB  '
          f'(css {len(css.encode()) / 1024:.1f} KB + js {len(js.encode()) / 1024:.1f} KB)')


if __name__ == '__main__':
    main()
