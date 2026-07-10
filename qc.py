# -*- coding: utf-8 -*-
"""
配音质检（QC）—— 独立脚本，不依赖主程序，只检查产物，把已知的坑都查一遍。

用法：
    python qc.py                  # 扫描所有视频的 temp 产物 + output 成品
    python qc.py <video_id>       # 只查某个视频
    python qc.py --watch 30       # 每 30 秒重扫一遍（将来在 .bat 里跟主程序并行监督）
    python qc.py --deep           # 深度模式：逐段 ffprobe 检查"配音是否超出时间窗"（较慢）

检查项（对应我们踩过的坑）：
  1. 空配音段(0字节)        —— TTS 失败导致丢句 / 合并被截断
  2. 合并音频被截断          —— merged.mp3 时长 远小于 各段总时长
  3. 配音音量过小            —— merged / 成品 的 max_volume 太低（amix normalize 之类）
  4. 配音超出时间窗(重叠)    —— 某段配音时长 > 到下一段的间隔（会和下一句叠在一起）[--deep]
  5. 译文相邻重复            —— translations.json 里相邻两句译文完全相同（滚动字幕残留）
  6. 任务未完成              —— 存在 pipeline_checkpoint.json（中途断过）
  7. 无配音片段              —— 该视频根本没产出 seg
"""
import glob
import json
import os
import re
import subprocess
import sys
import time

# 控制台编码：转 UTF-8 并对无法编码的字符替换，避免在 GBK 控制台打印中文/符号时崩溃。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

BASE_TEMP_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\temp'
OUTPUT_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\output'
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

# 阈值
QUIET_MAX_DB = -12.0     # max_volume 低于此 → 音量过小(FAIL)
QUIET_MEAN_DB = -28.0    # mean_volume 低于此 → 偏小(WARN)
OVERLAP_TOLERANCE = 0.5  # 配音比时间窗长出这么多秒以内可接受
TRUNCATE_RATIO = 0.8     # merged 时长 < 各段总时长 * 此比例 → 判截断
DEEP_SAMPLE = 80         # 非 --deep 时，重叠检查最多抽查这么多段


def _find(tool):
    for p in (rf'C:\ffmpeg\bin\{tool}.exe', tool):
        try:
            subprocess.run([p, '-version'], capture_output=True, creationflags=_NO_WINDOW)
            return p
        except Exception:
            continue
    return tool


FFPROBE = _find('ffprobe')
FFMPEG = _find('ffmpeg')


def audio_duration(path):
    """返回音频时长(秒)，失败返回 None。"""
    try:
        out = subprocess.run(
            [FFPROBE, '-v', 'quiet', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=20, creationflags=_NO_WINDOW)
        return float(out.stdout.strip())
    except Exception:
        return None


def loudness(path):
    """返回 (mean_db, max_db)，失败返回 (None, None)。"""
    try:
        out = subprocess.run(
            [FFMPEG, '-hide_banner', '-i', path, '-af', 'volumedetect',
             '-f', 'null', '-'],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=60, creationflags=_NO_WINDOW)
        err = out.stderr or ''
        mean = re.search(r'mean_volume:\s*(-?[\d.]+) dB', err)
        mx = re.search(r'max_volume:\s*(-?[\d.]+) dB', err)
        return (float(mean.group(1)) if mean else None,
                float(mx.group(1)) if mx else None)
    except Exception:
        return (None, None)


class Report:
    """收集一个视频的检查结果。"""
    def __init__(self, name):
        self.name = name
        self.items = []   # (level, msg)  level: OK/WARN/FAIL

    def ok(self, m):   self.items.append(('OK', m))
    def warn(self, m): self.items.append(('WARN', m))
    def fail(self, m): self.items.append(('FAIL', m))

    @property
    def worst(self):
        levels = [lv for lv, _ in self.items]
        if 'FAIL' in levels: return 'FAIL'
        if 'WARN' in levels: return 'WARN'
        return 'OK'

    def render(self):
        icon = {'OK': '[v]', 'WARN': '[!]', 'FAIL': '[X]'}
        head = {'OK': '[ OK ]', 'WARN': '[WARN]', 'FAIL': '[FAIL]'}[self.worst]
        lines = [f"{head} {self.name}"]
        for lv, m in self.items:
            if lv == 'OK':
                continue   # 通过项不刷屏，只列出问题
            lines.append(f"    {icon[lv]} {m}")
        if self.worst == 'OK':
            lines.append("    [v] 全部通过")
        return '\n'.join(lines)


def check_segments(temp_dir, rep, deep):
    segs = glob.glob(os.path.join(temp_dir, 'seg_*.mp3'))
    if not segs:
        rep.fail("没有任何配音片段(seg_*.mp3)，该视频未产出配音")
        return None
    empty = [s for s in segs if os.path.getsize(s) == 0]
    if empty:
        rep.fail(f"有 {len(empty)} 个空配音段(0字节，TTS失败)，会丢句/截断合并")
    rep.ok(f"配音片段 {len(segs)} 个（空段 {len(empty)}）")

    # 解析每段起始时间（文件名 seg_<毫秒>.mp3）
    timed = []
    for s in segs:
        m = re.search(r'seg_(\d+)\.mp3$', os.path.basename(s))
        if m:
            timed.append((int(m.group(1)) / 1000.0, s))
    timed.sort()
    return timed


def check_overlap(timed, rep, deep):
    """配音是否超出各自时间窗(会和下一句重叠)。逐段 ffprobe，较慢。"""
    if not timed or len(timed) < 2:
        return
    pairs = list(zip(timed, timed[1:]))
    if not deep and len(pairs) > DEEP_SAMPLE:
        step = len(pairs) // DEEP_SAMPLE
        pairs = pairs[::step]
        note = f"(抽查 {len(pairs)} 段，全量请加 --deep)"
    else:
        note = f"({len(pairs)} 段)"
    overruns = []
    for (start, path), (next_start, _) in pairs:
        if os.path.getsize(path) == 0:
            continue
        slot = next_start - start
        dur = audio_duration(path)
        if dur is None:
            continue
        if dur > slot + OVERLAP_TOLERANCE:
            overruns.append((start, dur, slot))
    if overruns:
        ratio = len(overruns) / max(len(pairs), 1)
        worst = max(overruns, key=lambda x: x[1] - x[2])
        msg = (f"{len(overruns)}/{len(pairs)} 段配音超出时间窗会重叠 {note}；"
               f"最严重 @{worst[0]:.0f}s：配音{worst[1]:.1f}s > 窗口{worst[2]:.1f}s")
        (rep.fail if ratio > 0.15 else rep.warn)(msg)
    else:
        rep.ok(f"配音时长都在时间窗内，无重叠 {note}")


def check_merged(temp_dir, timed, rep):
    merged = os.path.join(temp_dir, 'merged.mp3')
    if not os.path.exists(merged):
        return   # 只有扩展下载时才生成，批量成品在 output/
    mdur = audio_duration(merged)
    # 各段总时长（merged 是各段拼接，时长应≈各段之和）
    seg_sum = 0.0
    for _, path in (timed or []):
        if os.path.getsize(path) > 0:
            d = audio_duration(path)
            if d:
                seg_sum += d
    if mdur is not None and seg_sum > 0 and mdur < seg_sum * TRUNCATE_RATIO:
        rep.fail(f"合并音频被截断：merged {mdur:.0f}s 远小于各段总和 {seg_sum:.0f}s")
    mean, mx = loudness(merged)
    _judge_loudness(rep, 'merged.mp3', mean, mx)


def _judge_loudness(rep, label, mean, mx):
    if mx is None:
        return
    if mx < QUIET_MAX_DB:
        rep.fail(f"{label} 音量过小(max {mx:.1f}dB)，几乎听不见")
    elif mean is not None and mean < QUIET_MEAN_DB:
        rep.warn(f"{label} 音量偏小(mean {mean:.1f}dB)")
    else:
        rep.ok(f"{label} 音量正常(max {mx:.1f}dB)")


def check_repetition(temp_dir, rep):
    tj = os.path.join(temp_dir, 'translations.json')
    if not os.path.exists(tj):
        return
    try:
        with open(tj, encoding='utf-8') as f:
            d = json.load(f)
    except Exception:
        return
    vals = [v.strip() for v in d.values() if isinstance(v, str) and v.strip()]
    dups = 0
    example = None
    for a, b in zip(vals, vals[1:]):
        if a == b and len(a) >= 4:
            dups += 1
            if not example:
                example = a
    if dups:
        rep.warn(f"译文相邻重复 {dups} 处（疑似滚动字幕残留），例：「{example[:20]}」")


def check_checkpoint(temp_dir, rep):
    if os.path.exists(os.path.join(temp_dir, 'pipeline_checkpoint.json')):
        rep.warn("存在断点文件(pipeline_checkpoint.json)，任务可能中途断过/未完成")


def check_one_video(video_id, deep):
    temp_dir = os.path.join(BASE_TEMP_DIR, video_id)
    rep = Report(video_id)
    if not os.path.isdir(temp_dir):
        rep.fail("temp 目录不存在")
        return rep
    timed = check_segments(temp_dir, rep, deep)
    if timed:
        check_overlap(timed, rep, deep)
        check_merged(temp_dir, timed, rep)
    check_repetition(temp_dir, rep)
    check_checkpoint(temp_dir, rep)
    return rep


def check_outputs():
    """检查 output/ 里的成品（批量配音的最终 m4a/mp4）音量与时长。"""
    reps = []
    if not os.path.isdir(OUTPUT_DIR):
        return reps
    media = [f for f in os.listdir(OUTPUT_DIR)
             if f.lower().endswith(('.m4a', '.mp4'))]
    for f in sorted(media):
        path = os.path.join(OUTPUT_DIR, f)
        rep = Report('output/' + f)
        dur = audio_duration(path)
        if dur is None or dur < 1:
            rep.fail("无法读取时长或时长异常(可能损坏/未写完)")
        else:
            rep.ok(f"时长 {dur:.0f}s")
            mean, mx = loudness(path)
            _judge_loudness(rep, '成品', mean, mx)
        reps.append(rep)
    return reps


def scan(video_id=None, deep=False):
    print("=" * 56)
    print(f"  配音质检  {time.strftime('%H:%M:%S')}  {'(深度)' if deep else ''}")
    print("=" * 56)
    reps = []
    if video_id:
        reps.append(check_one_video(video_id, deep))
    else:
        if os.path.isdir(BASE_TEMP_DIR):
            for vid in sorted(os.listdir(BASE_TEMP_DIR)):
                if os.path.isdir(os.path.join(BASE_TEMP_DIR, vid)):
                    reps.append(check_one_video(vid, deep))
        reps.extend(check_outputs())

    fails = sum(1 for r in reps if r.worst == 'FAIL')
    warns = sum(1 for r in reps if r.worst == 'WARN')
    # 只打印有问题的；全通过的汇总成一行
    problem = [r for r in reps if r.worst != 'OK']
    for r in problem:
        print(r.render())
    okc = len(reps) - len(problem)
    print("-" * 56)
    print(f"  共 {len(reps)} 项：{okc} 通过 / {warns} 警告 / {fails} 失败")
    print("=" * 56)
    return fails


def main():
    args = sys.argv[1:]
    deep = '--deep' in args
    args = [a for a in args if a != '--deep']
    watch = None
    if '--watch' in args:
        i = args.index('--watch')
        watch = int(args[i + 1]) if i + 1 < len(args) else 30
        args = args[:i] + args[i + 2:]
    video_id = args[0] if args else None

    if watch:
        print(f"监督模式：每 {watch}s 扫描一次，Ctrl+C 退出")
        try:
            while True:
                scan(video_id, deep)
                time.sleep(watch)
        except KeyboardInterrupt:
            print("\n已退出监督。")
    else:
        sys.exit(1 if scan(video_id, deep) else 0)


if __name__ == '__main__':
    main()
