"""
把原视频、插件导出的 ratelog，以及完整配音 MP3 合成为最终成片。

用法：
  python merge_dubbed_video.py 原视频.mp4 变速日志.json 配音.mp3 输出.mp4

可选参数：
  --orig-volume 0.05   保留 5% 原声（默认 0.05）
  --dub-volume 1.0     配音音量（默认 1.0）
  --replace-original   完全替换原声，不混原声

说明：
  1) 若 ratelog 所有速率都接近 1.0，则直接复用原视频画面，不做变速。
  2) 若存在变速，则先调用同目录 retime_video.py 生成临时“变速后视频”。
  3) 最后把完整配音 MP3 与视频合成输出 mp4。
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def run(cmd):
    print('  $', ' '.join(cmd))
    subprocess.run(cmd, check=True)


def load_intervals(ratelog_path):
    with open(ratelog_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    return data.get('intervals') or [], data


def all_near_one(intervals, eps=0.01):
    if not intervals:
        return True
    return all(abs(float(it.get('rate', 1.0)) - 1.0) <= eps for it in intervals)


def ensure_exists(path, label):
    if not os.path.exists(path):
        print(f'{label} 不存在: {path}')
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('src_video')
    parser.add_argument('ratelog')
    parser.add_argument('dub_audio')
    parser.add_argument('out_video')
    parser.add_argument('--orig-volume', type=float, default=0.05)
    parser.add_argument('--dub-volume', type=float, default=1.0)
    parser.add_argument('--replace-original', action='store_true')
    args = parser.parse_args()

    ensure_exists(args.src_video, '原视频')
    ensure_exists(args.ratelog, '变速日志')
    ensure_exists(args.dub_audio, '配音音频')

    intervals, data = load_intervals(args.ratelog)
    print(f'读取到 {len(intervals)} 个变速区间；videoId={data.get("videoId") or ""}')

    base_video = args.src_video
    with tempfile.TemporaryDirectory() as tmpdir:
        if not all_near_one(intervals):
            retimed = os.path.join(tmpdir, 'retimed.mp4')
            print('检测到变速记录，先重建视频时间轴…')
            run([sys.executable, os.path.join(os.path.dirname(__file__), 'retime_video.py'),
                 args.src_video, args.ratelog, retimed])
            base_video = retimed
        else:
            print('所有区间均接近 1.0x，跳过视频变速重建。')

        if args.replace_original:
            cmd = [
                'ffmpeg', '-y',
                '-i', base_video,
                '-i', args.dub_audio,
                '-map', '0:v:0',
                '-map', '1:a:0',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-shortest',
                args.out_video,
            ]
        else:
            orig_volume = max(0.0, args.orig_volume)
            dub_volume = max(0.0, args.dub_volume)
            filter_complex = (
                f'[0:a]volume={orig_volume}[orig];'
                f'[1:a]volume={dub_volume}[dub];'
                f'[orig][dub]amix=inputs=2:duration=first:dropout_transition=0[aout]'
            )
            cmd = [
                'ffmpeg', '-y',
                '-i', base_video,
                '-i', args.dub_audio,
                '-filter_complex', filter_complex,
                '-map', '0:v:0',
                '-map', '[aout]',
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-shortest',
                args.out_video,
            ]
        print('开始合成最终视频…')
        run(cmd)

    print(f'完成：{args.out_video}')


if __name__ == '__main__':
    main()
