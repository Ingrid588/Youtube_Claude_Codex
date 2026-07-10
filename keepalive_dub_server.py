"""
定时给配音服务器（HF Space）发健康检查，及时发现"假死"（HF runtime显示RUNNING但
/health 实际没响应——之前真实出现过的情况），发现就自动重启，避免关键录制时刻掉链子。

不打算把这个塞进Chrome插件本身：重启Space需要write权限的HF token，不能放进插件代码
（插件代码会随插件分发给所有用户，等于把write token公开出去）。这个脚本只在本机跑。

用法：
  1. 把 HF token（write权限）存进项目根目录的 config.json：{"hf_token": "hf_xxx"}
     （这个文件已经在 .gitignore 里，不会被提交）
     或者用环境变量：set HF_TOKEN=hf_xxx  （Windows cmd）/ $env:HF_TOKEN='hf_xxx' （PowerShell）
  2. 跑：python keepalive_dub_server.py
     默认每60秒检查一次，连续2次失败（或单次超过15秒没响应）就触发重启，
     重启后持续探测直到恢复，再回到正常巡检间隔。
  3. 想在重要录制前先手动预热一下，也可以单次跑：python keepalive_dub_server.py --once

跑的时候这个终端窗口不能关，建议配音/录制前开着它，结束了可以 Ctrl+C 退出。
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SPACE_REPO_ID = 'Ingrid919/dub-server'
HEALTH_URL = 'https://ingrid919-dub-server.hf.space/health'

CHECK_INTERVAL_SEC = 60        # 正常巡检间隔
HANG_TIMEOUT_SEC = 15          # 单次请求超过这么久没响应，当一次失败算
FAIL_THRESHOLD = 2             # 连续失败几次才触发重启（避免偶尔一次网络抖动就误重启）
RECOVER_POLL_SEC = 15          # 重启后多久探测一次，直到恢复


def _load_token():
    token = os.environ.get('HF_WRITE_TOKEN', '').strip() or os.environ.get('HF_TOKEN', '').strip()
    if token:
        return token
    cfg_path = os.path.join(HERE, 'config.json')
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
                # hf_write_token 是专门给重启用的write权限token，跟 hf_token（给pyannote下载模型用，
                # 权限可能不一样）分开存，避免搞混用错token导致重启失败。
                return (cfg.get('hf_write_token') or cfg.get('hf_token') or '').strip()
        except Exception:
            pass
    return ''


def check_health():
    """返回 (ok, detail字符串)"""
    t0 = time.time()
    try:
        req = urllib.request.Request(HEALTH_URL, headers={'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=HANG_TIMEOUT_SEC) as resp:
            elapsed = time.time() - t0
            body = resp.read(200)
            return True, f"OK ({elapsed:.1f}s) {body[:80]}"
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        return False, f"HTTP {e.code} ({elapsed:.1f}s)"
    except Exception as e:
        elapsed = time.time() - t0
        return False, f"超时/无响应 ({elapsed:.1f}s) {e}"


def restart_space(token):
    from huggingface_hub import HfApi
    api = HfApi(token=token)
    api.restart_space(repo_id=SPACE_REPO_ID)


def ts():
    return time.strftime('%Y-%m-%d %H:%M:%S')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true', help='只检查一次（不重启、不循环），用于配音前手动预热确认')
    args = parser.parse_args()

    token = _load_token()
    if not token and not args.once:
        print("没找到HF token：设环境变量 HF_TOKEN，或在 config.json 里加 hf_token 字段。"
              "（--once 模式不需要token，只查不重启）")

    if args.once:
        ok, detail = check_health()
        print(f"[{ts()}] {'✓' if ok else '✗'} {detail}")
        sys.exit(0 if ok else 1)

    print(f"[{ts()}] 开始巡检 {HEALTH_URL}，每{CHECK_INTERVAL_SEC}秒一次，Ctrl+C 退出")
    fail_count = 0
    while True:
        ok, detail = check_health()
        print(f"[{ts()}] {'✓' if ok else '✗'} {detail}")
        if ok:
            fail_count = 0
        else:
            fail_count += 1
            if fail_count >= FAIL_THRESHOLD:
                if not token:
                    print(f"[{ts()}] 连续{fail_count}次失败，但没有token无法自动重启，请手动处理")
                else:
                    print(f"[{ts()}] 连续{fail_count}次失败，触发自动重启…")
                    try:
                        restart_space(token)
                        print(f"[{ts()}] 重启已触发，开始等待恢复…")
                    except Exception as e:
                        print(f"[{ts()}] 重启请求失败：{e}")
                    # 重启后用更短的间隔持续探测，直到恢复
                    while True:
                        time.sleep(RECOVER_POLL_SEC)
                        ok2, detail2 = check_health()
                        print(f"[{ts()}] {'✓' if ok2 else '✗'} (恢复探测) {detail2}")
                        if ok2:
                            break
                fail_count = 0
        time.sleep(CHECK_INTERVAL_SEC)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n已停止巡检")
