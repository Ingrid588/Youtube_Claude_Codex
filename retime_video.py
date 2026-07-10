"""
用插件导出的 <videoId>_ratelog.json 把"下载到的原速视频"按配音时的变速节奏拉伸，
拉伸后的视频时间轴会和单独录制的配音音频对齐，可以直接在剪辑软件里合并。

工作流：
  1. 插件配音时会自动记录每个时刻视频被调到了什么速率（开头变量名叫"档3慢放"那套逻辑）。
  2. 配音过程中用任意录音软件单独录下电脑播放的配音音频（不用录屏，可以同时开几个录音）。
  3. 点"停止配音"（或视频自然播完）时，插件自动下载一个 <videoId>_ratelog.json。
  4. 用 yt-dlp/其它工具下载这个视频的原始（未经变速）版本。
  5. 跑这个脚本：python retime_video.py 原始视频.mp4 videoId_ratelog.json 输出.mp4
  6. 把输出视频和第3步录的配音音频拖进剪辑软件对齐合并（时间轴应该已经一致，最多有
     零点几秒的累积误差，来自TTS边界判断的精度，可以微调对齐）。

原理：intervals 里每一项 {start,end,rate} 表示"原视频[start,end)这段，配音时播放速率是rate"。
用 ffmpeg 把原视频按这些区间切开，每段用 setpts=PTS/rate 重新计时（rate<1变慢→更长，
rate>1变快→更短），再首尾拼接，输出视频总时长 = 配音时浏览器里这段视频实际播放经过的
墙钟时长，跟同一段时间录的配音音频天然对齐。
"""
import json
import os
import subprocess
import sys
import tempfile


def run(cmd):
    print('  $', ' '.join(cmd))
    subprocess.run(cmd, check=True)


def main():
    if len(sys.argv) != 4:
        print(f"用法: python {os.path.basename(__file__)} 原始视频.mp4 ratelog.json 输出.mp4")
        sys.exit(1)

    src_video, ratelog_path, out_video = sys.argv[1:4]
    if not os.path.exists(src_video):
        print(f"找不到原始视频: {src_video}")
        sys.exit(1)

    with open(ratelog_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    intervals = data.get('intervals') or []
    if not intervals:
        print("ratelog.json 里没有 intervals，没法处理")
        sys.exit(1)

    print(f"共 {len(intervals)} 段变速区间，视频原长约 {data.get('videoDuration')} 秒")

    with tempfile.TemporaryDirectory() as tmpdir:
        part_files = []
        for i, itv in enumerate(intervals):
            start, end, rate = itv['start'], itv['end'], itv['rate']
            dur = end - start
            if dur <= 0:
                continue
            part_path = os.path.join(tmpdir, f"part_{i:05d}.mp4")
            # -ss/-t 切原视频这一段；setpts 按 1/rate 重新计时（rate<1→变慢→放大PTS）；
            # atempo 同步处理音轨语速（atempo 单次只支持 0.5~2.0，超出范围这里不细分，
            # 绝大多数配音慢放场景在这个区间内；真有极端值再叠加多级 atempo）。
            vf = f"setpts=PTS/{rate}"
            af = f"atempo={max(0.5, min(2.0, rate))}"
            cmd = [
                'ffmpeg', '-y', '-ss', str(start), '-t', str(dur), '-i', src_video,
                '-vf', vf, '-af', af,
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
                '-c:a', 'aac',
                part_path,
            ]
            run(cmd)
            part_files.append(part_path)
            print(f"  [{i+1}/{len(intervals)}] {start:.2f}s~{end:.2f}s rate={rate:.3f} → {dur/rate:.2f}s")

        concat_list = os.path.join(tmpdir, 'concat.txt')
        with open(concat_list, 'w', encoding='utf-8') as f:
            for p in part_files:
                f.write(f"file '{p}'\n")

        run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', concat_list,
             '-c', 'copy', out_video])

    print(f"完成：{out_video}")


if __name__ == '__main__':
    main()
