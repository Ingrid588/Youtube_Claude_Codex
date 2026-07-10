"""
把浏览器扩展导出的 cookies.txt（包含bilibili.com的cookie）转换成
bilibili_upload.py 需要的 bilibili_cookies.json。

用法：
1. 登录 bilibili.com
2. 用"Get cookies.txt LOCALLY"等扩展导出当前页面的cookies，保存为任意路径的cookies.txt
3. 运行：python extract_bilibili_cookies.py 你的cookies.txt路径
   （不填路径时默认读取 Youtube_Claude_data/cookies_bilibili.txt）
"""
import json
import os
import sys

import bilibili_upload

DEFAULT_INPUT = os.path.join(os.path.dirname(__file__), 'Youtube_Claude_data', 'cookies_bilibili.txt')

WANTED = ('SESSDATA', 'bili_jct', 'buvid3')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT
    if not os.path.exists(src):
        print(f"找不到文件：{src}")
        print("请先在浏览器登录bilibili.com，用'Get cookies.txt LOCALLY'扩展导出，"
              f"保存为该路径，或运行时指定路径：python extract_bilibili_cookies.py 路径")
        return

    found = {}
    with open(src, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            parts = line.split('\t')
            if len(parts) < 7:
                continue
            name, value = parts[5], parts[6]
            if name in WANTED:
                found[name] = value

    missing = [k for k in WANTED if k not in found]
    if missing:
        print(f"缺少以下cookie：{missing}，请确认导出时已登录bilibili.com")
        return

    os.makedirs(os.path.dirname(bilibili_upload.BILIBILI_COOKIES_FILE), exist_ok=True)
    with open(bilibili_upload.BILIBILI_COOKIES_FILE, 'w', encoding='utf-8') as f:
        json.dump(found, f, ensure_ascii=False, indent=2)

    print(f"已写入：{bilibili_upload.BILIBILI_COOKIES_FILE}")


if __name__ == '__main__':
    main()
