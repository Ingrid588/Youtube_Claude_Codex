#!/usr/bin/env python3
"""测试播放列表解析是否能获取所有37个视频"""

import sys
sys.path.insert(0, r'C:\video\Youtube_Claude')

import dub8
import yt_dlp

playlist_url = "https://www.youtube.com/playlist?list=PLs9Pq7JEMwcugqnqpT_cLq2ipKkANPZd3"

print("正在获取播放列表中的所有视频...")
try:
    # 直接调用yt_dlp来看原始返回数据
    print("\n[DEBUG] 使用当前代码的get_playlist_video_urls()：")
    urls = dub8.get_playlist_video_urls(playlist_url)
    print(f"获取了 {len(urls)} 个视频链接")

    # 再用不同配置试试
    print("\n[DEBUG] 用默认yt_dlp设置试试：")
    opts = {'quiet': True, 'skip_download': True, 'extract_flat': True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)
    entries_default = info.get('entries') or []
    print(f"默认设置返回 {len(entries_default)} 个条目")

    # 最后检查完整结果
    print(f"\n✅ 最终确认：获取了 {len(urls)} 个视频")
    print(f"预期：37个视频")

    if len(urls) == 37:
        print("✅ 完美！已获取全部37个视频")
    else:
        print(f"❌ 不匹配：获取了 {len(urls)} 个，应该是 37 个")

except Exception as e:
    print(f"❌ 错误: {e}")
    import traceback
    traceback.print_exc()
