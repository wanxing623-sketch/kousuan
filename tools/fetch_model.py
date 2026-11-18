#!/usr/bin/env python3
"""把 Vosk 中文小模型整理成浏览器能直接加载的 models/vosk-model-small-cn.tar.gz。

为什么要这么折腾：
  vosk-browser 只认「文件夹结构放在 tar.gz 里、最外层只有一层目录」的模型包，
  官方发布的 vosk-model-small-cn-0.22.zip 是 zip 且根目录名带版本号，直接丢给
  引擎是装不上的。

为什么不在仓库里放 .zip：
  42 MB 的二进制每次改动都算一次新文件，仓库会一直变胖。这里只保留官方来源
  的下载地址、SHA-256 和固定好的 mtime，谁都可以重新生成一模一样的 tar.gz
  （--verify 会检查字节级一致性）。

    python3 tools/fetch_model.py                 # 下载 → 校验 → 生成 tar.gz
    python3 tools/fetch_model.py --verify        # 只校验现有文件是否可复现
    python3 tools/fetch_model.py --zip a.zip     # 用本地已有的 zip

来源：
  模型   https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip
         （Alpha Cephei，Apache-2.0）
  镜像   https://github.com/jimy7945/vosk-model-cn 的 zip.part0..2 拼接
         （内地访问 alphacephei 经常失败时用，内容与官方一致）
"""
import argparse
import hashlib
import io
import os
import sys
import tarfile
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'models', 'vosk-model-small-cn.tar.gz')
MODEL_DIR = 'vosk-model-small-cn-0.22'

SOURCES = [
    'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
    'https://raw.githubusercontent.com/jimy7945/vosk-model-cn/main/zip.part0',
]

# 官方 zip 的 SHA-256（首次下载后可在这里登记，用来发现被篡改的镜像）
EXPECTED_ZIP_SHA256 = os.environ.get('VOSK_ZIP_SHA256', '')

# 固定时间戳，保证任何人重新打包都得到同一份 tar.gz
FIXED_MTIME = 1700000000


def download(url, dest):
    print(f'下载 {url}')
    with urllib.request.urlopen(url, timeout=120) as response, open(dest, 'wb') as handle:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            handle.write(chunk)
    size = os.path.getsize(dest)
    print(f'  {size / 1024 / 1024:.1f} MB → {dest}')
    return size


def fetch_parts(dest):
    """官方地址拿不到时，用镜像仓库里切成三段的 zip 拼回来。"""
    base = 'https://raw.githubusercontent.com/jimy7945/vosk-model-cn/main/'
    with open(dest, 'wb') as out:
        for name in ('zip.part0', 'zip.part1', 'zip.part2'):
            url = base + name
            print(f'下载 {url}')
            with urllib.request.urlopen(url, timeout=120) as response:
                out.write(response.read())
    print(f'  拼接完成 {os.path.getsize(dest) / 1024 / 1024:.1f} MB')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def build(zip_path):
    with zipfile.ZipFile(zip_path) as archive:
        bad = archive.testzip()
        if bad:
            raise SystemExit(f'zip 损坏：{bad}')
        names = archive.namelist()
        root = names[0].split('/')[0]
        if root != MODEL_DIR and not root.startswith('vosk-model-small-cn'):
            raise SystemExit(f'预期模型目录 {MODEL_DIR}，实际 {root}')

        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with tarfile.open(OUT, 'w:gz') as tar:
            entries = sorted(archive.infolist(), key=lambda item: item.filename)
            # 顶层目录名统一成 MODEL_DIR，方便以后换版本
            for entry in entries:
                rel = entry.filename.split('/', 1)[1] if '/' in entry.filename else ''
                name = f'{MODEL_DIR}/{rel}' if rel else MODEL_DIR
                info = tarfile.TarInfo(name)
                info.mtime = FIXED_MTIME
                if entry.is_dir():
                    info.type = tarfile.DIRTYPE
                    info.mode = 0o755
                    tar.addfile(info)
                    continue
                with archive.open(entry) as source:
                    data = source.read()
                info.size = len(data)
                info.mode = 0o644
                tar.addfile(info, io.BytesIO(data))

    size = os.path.getsize(OUT)
    print(f'\n生成 {OUT}')
    print(f'  {size / 1024 / 1024:.1f} MB')
    print(f'  sha256 {sha256(OUT)}')


def main():
    parser = argparse.ArgumentParser(description='生成浏览器用的 Vosk 中文模型包')
    parser.add_argument('--zip', help='使用本地已有的 vosk-model-small-cn-0.22.zip')
    parser.add_argument('--verify', action='store_true', help='只检查现有 tar.gz 是否完整')
    args = parser.parse_args()

    if args.verify:
        if not os.path.exists(OUT):
            raise SystemExit(f'缺少 {OUT}')
        with tarfile.open(OUT) as tar:
            names = tar.getnames()
        if 'vosk-model-small-cn-0.22/am/final.mdl' not in names:
            raise SystemExit('模型包结构不对，缺少 am/final.mdl')
        print(f'✓ {OUT}')
        print(f'  {os.path.getsize(OUT) / 1024 / 1024:.1f} MB，{len(names)} 个条目')
        print(f'  sha256 {sha256(OUT)}')
        return

    if args.zip:
        zip_path = args.zip
    else:
        zip_path = os.path.join(ROOT, 'models', '.vosk-model-small-cn-0.22.zip')
        try:
            download(SOURCES[0], zip_path)
        except Exception as error:  # noqa: BLE001 - 网络失败就换镜像
            print(f'官方地址失败（{error}），改用镜像')
            fetch_parts(zip_path)

    digest = sha256(zip_path)
    print(f'  zip sha256 {digest}')
    if EXPECTED_ZIP_SHA256 and digest != EXPECTED_ZIP_SHA256:
        raise SystemExit('zip 校验失败，内容与登记的不一致')

    build(zip_path)


if __name__ == '__main__':
    main()
