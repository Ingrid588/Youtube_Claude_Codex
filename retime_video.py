"""
配音视频合成脚本（路线 C：下载配音包 → 本地工作区集中合成）。

代码仅在主目录存一份。工作区（dub_workspace/）由 init 命令创建，里面放各视频的
配音包解压内容和原视频，合成产物也在这里。merge_all.bat 是工作区的入口，双击即用。

────────────────────────────────────────────────────────────────
init
  初始化工作区：创建 dub_workspace/ 并生成 merge_all.bat。
  用法：python retime_video.py init
  之后把每个视频的配音包 zip 解压到 dub_workspace/<原视频名>/，原视频也放进去。

────────────────────────────────────────────────────────────────
merge-all
  扫描 dub_workspace 下所有含 manifest.json 的子目录，逐个合成。
  每个子目录里需要有原视频（任意视频文件，优先 original.* 或唯一视频）。
  输出 = 原视频名 + _C + 扩展名，放在同一子目录。
  用法：python retime_video.py merge-all   （merge_all.bat 调的就是这个）

────────────────────────────────────────────────────────────────
batch（单视频合成，被 merge-all 内部调用）
  用法：python retime_video.py batch 原视频.mp4 配音包目录 输出.mp4

────────────────────────────────────────────────────────────────
realtime（实时配音 / 原有功能，拉伸原视频对齐配音）
  用法：python retime_video.py realtime 原始视频.mp4 ratelog.json 输出.mp4
  或旧式三参数：python retime_video.py 原视频.mp4 ratelog.json 输出.mp4

────────────────────────────────────────────────────────────────
依赖：ffmpeg / ffprobe（在 PATH 里）。
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import shutil

# 工作区根目录：在【浏览器默认下载目录】下的 dub_workspace/。
# 这样插件下载的配音包 zip 直接落进工作区（Chrome 只能下载到"默认下载目录"的相对路径，
# 无法写任意绝对路径），下载和合成全程在一个文件夹，用户无需手动搬运。
# Windows 默认下载目录 = %USERPROFILE%\Downloads。用户可在插件设置里改下载目录，
# 那时用环境变量 DUB_WORKSPACE 指向真实工作区即可。
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DEFAULT_DOWNLOADS = os.path.join(os.path.expanduser('~'), 'Downloads')
WORKSPACE_DIR = os.environ.get('DUB_WORKSPACE') or os.path.join(_DEFAULT_DOWNLOADS, 'dub_workspace')

# 工作区内的固定子目录（按类型分离，便于批量操作）
SOURCE_VIDEOS_DIR = os.path.join(WORKSPACE_DIR, 'source_videos')   # 所有原视频
SEGMENTS_DIR = os.path.join(WORKSPACE_DIR, 'segments')             # 配音片段，按视频名分子目录
OUTPUT_DIR = os.path.join(WORKSPACE_DIR, 'output')                 # 所有合成成品

VIDEO_EXTS = ('.mp4', '.mkv', '.webm', '.mov', '.avi')


def run(cmd, check=True):
    print('  $', ' '.join(str(c) for c in cmd))
    return subprocess.run([str(c) for c in cmd], check=check)


def find_ffmpeg():
    for name in ('ffmpeg', 'ffmpeg.exe'):
        p = shutil.which(name)
        if p:
            return p
    return None


def find_ffprobe():
    for name in ('ffprobe', 'ffprobe.exe'):
        p = shutil.which(name)
        if p:
            return p
    return None


def get_duration(path):
    ffprobe = find_ffprobe()
    if not ffprobe:
        raise RuntimeError('找不到 ffprobe，请把它加进 PATH')
    result = subprocess.run(
        [ffprobe, '-v', 'quiet', '-print_format', 'json', '-show_format', path],
        capture_output=True, text=True)
    return float(json.loads(result.stdout)['format']['duration'])


# ============================================================
# 名称匹配：原视频（source_videos/）→ 配音包（segments/<名>/）
# ============================================================
def normalize_name(name):
    """规范化文件名：去扩展名、去开头 数字- 前缀、去 emoji/符号、小写、拆词。

    yt-dlp 下载的视频常带 "数字-视频名" 前缀和 emoji，如 "3-How to Build😀.mp4"。
    返回词列表（英文按词、中文按字），用于后续连续4词匹配。
    """
    base = re.sub(r'\.(mp4|mkv|webm|mov|avi|m4a)$', '', name, flags=re.I)
    # 去开头 "数字-" / "数字." / "数字_" 前缀
    base = re.sub(r'^\d+[-._]\s*', '', base)
    # 去所有非字母数字中文空格的字符（emoji、标点、括号等）
    base = re.sub(r'[^\w\s\u4e00-\u9fff]', ' ', base, flags=re.UNICODE)
    base = base.lower().strip()
    tokens = []
    for tok in re.split(r'[\s_]+', base):
        if not tok:
            continue
        buf = ''
        for ch in tok:
            if '\u4e00' <= ch <= '\u9fff':
                if buf:
                    tokens.append(buf); buf = ''
                tokens.append(ch)  # 中文按单字切
            else:
                buf += ch
        if buf:
            tokens.append(buf)
    return tokens


def _has_consecutive_window(ta, tb, size):
    """ta/tb 词列表里是否存在连续 size 个词相同的窗口。"""
    if len(ta) < size or len(tb) < size:
        # 词不够长，退化为：较短者是否作为较长者的连续子串出现
        shorter, longer = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if not shorter:
            return False
        for i in range(len(longer) - len(shorter) + 1):
            if longer[i:i+len(shorter)] == shorter:
                return True
        return False
    for i in range(len(ta) - size + 1):
        window = ta[i:i+size]
        for j in range(len(tb) - size + 1):
            if tb[j:j+size] == window:
                return True
    return False


def _name_similarity(name_a, name_b):
    """粗略的名称相似度（0~1），用于兜底。基于词集合 Jaccard。"""
    sa, sb = set(normalize_name(name_a)), set(normalize_name(name_b))
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _duration_matches(video_path, target_dur, tol=0.15):
    """视频时长是否在 target_dur 的 tol（默认15%）范围内。"""
    if not target_dur:
        return None  # 没有目标时长，无法判断
    try:
        vd = get_duration(video_path)
    except Exception:
        return None
    return abs(vd - target_dur) / max(target_dur, 1) < tol


def find_source_for_package(pkg_title, source_dir, manifest=None):
    """在 source_dir 里找与配音包标题匹配的原视频。

    匹配策略（名称优先，时长辅助消歧）：
      1. 连续 4 词窗口筛候选。0 命中 → 走相似度兜底（见第4步）。
      2. 多个命中（4词雷同）→ 扩大窗口 8、12… 直到只剩 1 个，或无法再区分。
      3. 名称命中后，用视频时长验证：有 total_duration 时，时长不符的候选剔除。
         时长验证只在【已名称命中的候选】里做，不会凭时长创造匹配。
      4. 4 词 0 命中：按名称相似度打分，需过阈值(0.4)；时长吻合可加分但不单独决定。
    返回 (文件名, 置信说明) 或 (None, 原因)。
    """
    if not os.path.isdir(source_dir):
        return None, '原视频目录不存在'
    candidates = [f for f in os.listdir(source_dir)
                  if os.path.splitext(f)[1].lower() in VIDEO_EXTS]
    if not candidates:
        return None, '原视频目录为空'

    target_dur = None
    if manifest:
        td = manifest.get('total_duration')
        if td:
            try:
                target_dur = float(td)
            except (TypeError, ValueError):
                target_dur = None

    cand_tokens = {f: normalize_name(f) for f in candidates}
    pkg_tokens = normalize_name(pkg_title)

    # 第一阶段：连续 N 词窗口逐步消歧（4 → 8 → 12 ...）
    size = 4
    hits = [f for f in candidates if _has_consecutive_window(cand_tokens[f], pkg_tokens, size)]
    if not hits:
        # 4 词 0 命中：走相似度兜底（时长不能单独创造匹配）
        scored = []
        for f in candidates:
            sim = _name_similarity(f, pkg_title)
            if sim < 0.4:
                continue
            scored.append((f, sim))
        if not scored:
            return None, '4词无命中且相似度不足'
        scored.sort(key=lambda x: x[1], reverse=True)
        if len(scored) == 1:
            return scored[0][0], f'相似度兜底({scored[0][1]:.2f})'
        # 多个过阈值，用时长效验消歧
        if target_dur:
            dur_ok = [f for f, _ in scored
                      if _duration_matches(os.path.join(source_dir, f), target_dur)]
            if len(dur_ok) == 1:
                return dur_ok[0], f'相似度+时长消歧'
        return scored[0][0], f'相似度最高({scored[0][1]:.2f})，有多个候选'

    # 第二阶段：扩大窗口消歧
    note = ''
    while len(hits) > 1:
        next_size = size + 4
        refined = [f for f in hits
                   if _has_consecutive_window(cand_tokens[f], pkg_tokens, next_size)]
        if len(refined) == len(hits) or not refined:
            # 扩大窗口没能减少候选 → 停止扩大
            note = f'{len(hits)}个候选{size}词仍雷同'
            break
        hits = refined
        size = next_size

    # 第三阶段：名称命中的候选里，用时长效验消歧
    if target_dur and len(hits) > 1:
        dur_ok = [f for f in hits
                  if _duration_matches(os.path.join(source_dir, f), target_dur)]
        if len(dur_ok) == 1:
            return dur_ok[0], f'名称{size}词+时长验证确认'
        if len(dur_ok) >= 2:
            hits = dur_ok
            note = (note + '；') if note else ''
            note += '时长验证后仍多个'
        # 时长全不符 → 保留原 hits，不凭时长拒绝

    if len(hits) == 1:
        return hits[0], f'名称{size}词匹配' + (f'（{note}）' if note else '')
    # 仍多个 → 相似度打分
    scored = [(f, _name_similarity(f, pkg_title)) for f in hits]
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[0][0], f'名称{size}词+相似度({scored[0][1]:.2f})' + (f'（{note}）' if note else '')


# ============================================================
# init：初始化工作区
# ============================================================
# merge_all.bat 用 retime_video.py 的绝对路径调用（脚本不拷贝，仅主目录一份）。
_MERGE_ALL_BAT_TEMPLATE = r"""@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ============================================
echo   Dub Workspace - Merge All
echo ============================================
echo.
python "{retime_path}" merge-all
echo.
echo ============================================
pause
"""


def mode_init():
    """在工作区创建固定子目录结构 + merge_all.bat。

    结构（按类型分离，便于批量）：
      dub_workspace/source_videos/   所有原视频统一放这
      dub_workspace/segments/<名>/   各视频配音片段
      dub_workspace/output/          所有合成成品
      dub_workspace/merge_all.bat    双击批量合成
    """
    for d in (SOURCE_VIDEOS_DIR, SEGMENTS_DIR, OUTPUT_DIR):
        os.makedirs(d, exist_ok=True)
    bat_path = os.path.join(WORKSPACE_DIR, 'merge_all.bat')
    retime_abs = os.path.join(SCRIPT_DIR, 'retime_video.py')
    with open(bat_path, 'w', encoding='utf-8') as f:
        f.write(_MERGE_ALL_BAT_TEMPLATE.format(retime_path=retime_abs))
    print(f'工作区已就绪: {WORKSPACE_DIR}')
    print(f'  原视频目录: {SOURCE_VIDEOS_DIR}  ← 把所有原视频放这（yt-dlp 下载的"数字-名称.mp4"直接放）')
    print(f'  配音片段目录: {SEGMENTS_DIR}\\<视频名>\\')
    print(f'  成品输出目录: {OUTPUT_DIR}  ← 合成的 _C 视频都在这')
    print(f'  入口脚本: {bat_path}')
    print()
    print('使用方法:')
    print('  1. 插件「缓存管理」点「导出配音包」→ zip 自动下载到 segments\\<视频名>\\')
    print('  2. 把原视频放进 source_videos\\（保持下载的原名，如 "3-How to Build😀.mp4"）')
    print('  3. 双击 merge_all.bat → 自动解压 zip + 匹配原视频 + 批量合成')
    print('     无需手动解压。成品统一输出到 output\\，文件名 = 原视频名 + _C')
    print()
    print('匹配规则：去掉"数字-"前缀和emoji后，连续4个单词相同即配对；')
    print('         匹配不到则按名称相似度+视频时长兜底。')
    print()
    print('如下载目录非默认，设环境变量 DUB_WORKSPACE 指向真实工作区后重跑 init。')


# ============================================================
# merge-all：扫描工作区，逐个合成
# ============================================================
def _auto_extract_zips():
    """自动解压 segments/ 下所有未解压的 zip 到同名目录。

    插件下载 zip 到 segments/<视频名>/<视频名>.zip。本函数在合成前把它解压到
    segments/<视频名>/（zip 内容是 segments/xxx.mp3 + manifest.json + ...，
    直接解压到该目录即可）。已解压（目录里已有 manifest.json）的跳过。
    """
    if not os.path.isdir(SEGMENTS_DIR):
        return
    extracted = 0
    for name in sorted(os.listdir(SEGMENTS_DIR)):
        sub = os.path.join(SEGMENTS_DIR, name)
        # 找该目录（或其父层）里的 zip
        if os.path.isdir(sub):
            # 已解压（有 manifest.json）→ 跳过
            if os.path.exists(os.path.join(sub, 'manifest.json')):
                continue
            # 找目录里的 zip
            zips = [f for f in os.listdir(sub) if f.lower().endswith('.zip')]
            for zf_name in zips:
                zpath = os.path.join(sub, zf_name)
                try:
                    import zipfile as zf_mod
                    with zf_mod.ZipFile(zpath) as zf:
                        zf.extractall(sub)
                    extracted += 1
                    print(f'  解压: {zf_name} -> {name}/')
                except Exception as e:
                    print(f'  [警告] 解压失败 {zf_name}: {e}')
    if extracted:
        print(f'共解压 {extracted} 个配音包\n')


def mode_merge_all(orig_volume=0.1):
    """扫描 segments/ 下所有配音包，匹配 source_videos/ 里的原视频，逐个合成到 output/。

    流程：先自动解压未解压的 zip，再扫描合成。用户只需把 zip 下到 segments/、
    原视频放 source_videos/，双击 merge_all.bat 即可，无需手动解压。
    """
    for d in (SEGMENTS_DIR, SOURCE_VIDEOS_DIR, OUTPUT_DIR):
        if not os.path.isdir(d):
            print(f'工作区不完整，缺少: {d}')
            print('请先运行: python retime_video.py init')
            sys.exit(1)

    # 第 0 步：自动解压未解压的 zip
    print('=== 检查并解压配音包 ===')
    _auto_extract_zips()

    # 找所有配音包：segments/<名>/manifest.json
    jobs = []
    for name in sorted(os.listdir(SEGMENTS_DIR)):
        sub = os.path.join(SEGMENTS_DIR, name)
        if os.path.isdir(sub) and os.path.exists(os.path.join(sub, 'manifest.json')):
            jobs.append((name, sub))

    if not jobs:
        print(f'没有找到配音包（{SEGMENTS_DIR} 下需有 <视频名>\\manifest.json 或对应的 zip）。')
        print('请先从插件导出配音包（zip 下到 segments\\<视频名>\\）。')
        return

    print(f'找到 {len(jobs)} 个配音包:')
    for name, _ in jobs:
        print(f'  - {name}')
    print()

    ok, fail, skip = 0, 0, 0
    for name, pkg_dir in jobs:
        print('=' * 50)
        with open(os.path.join(pkg_dir, 'manifest.json'), encoding='utf-8') as f:
            manifest = json.load(f)
        title = manifest.get('title') or name
        print(f'合成: {title}')
        # 在 source_videos/ 里找匹配的原视频（返回 文件名 + 置信说明）
        src, why = find_source_for_package(title, SOURCE_VIDEOS_DIR, manifest)
        if not src:
            print(f'  [跳过] 未匹配到原视频（{why}）')
            print(f'         请把原视频放进 {SOURCE_VIDEOS_DIR}')
            skip += 1
            print()
            continue
        src_path = os.path.join(SOURCE_VIDEOS_DIR, src)
        print(f'  匹配到原视频: {src}  ({why})')
        base, ext = os.path.splitext(src)
        out = os.path.join(OUTPUT_DIR, f"{base}_C{ext}")
        try:
            mode_batch(src_path, pkg_dir, out, orig_volume=orig_volume)
            ok += 1
        except Exception as e:
            print(f'  [失败] {e}')
            fail += 1
        print()

    print('=' * 50)
    print(f'完成: 成功 {ok} 个, 跳过 {skip} 个(未找到原视频), 失败 {fail} 个')
    print(f'成品在: {OUTPUT_DIR}')
    if skip:
        print(f'跳过的请把对应原视频放进 {SOURCE_VIDEOS_DIR}')


# ============================================================
# batch：单视频合成（核心逻辑）
# ============================================================
def build_aligned_track(manifest, seg_dir, tmpdir):
    """把 segments 按 start 秒铺回：每段后补静音到下一段起点，输出整条配音轨 wav。

    配音时每段 TTS 都被压在原段时长内，所以这种"按起点铺回 + 静音填充"得到的音轨
    和原视频时间轴一致，可直接和原视频叠。返回整轨 wav 路径。
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError('找不到 ffmpeg，请把它加进 PATH')

    segs = sorted(manifest.get('segments', []),
                  key=lambda s: s.get('start_ms', s.get('start', 0) * 1000))
    if not segs:
        raise RuntimeError('manifest 里没有 segments')

    # 逐段用 apad 补静音到"下一段起点"，再 concat 拼成完整对齐音轨。
    padded = []
    for i, seg in enumerate(segs):
        seg_path = os.path.join(seg_dir, seg['file'])
        if not os.path.exists(seg_path):
            print(f"  跳过缺失分段: {seg['file']}")
            continue
        start_ms = seg.get('start_ms') or int(seg.get('start', 0) * 1000)
        # 这段铺到的"目标长度" = 下一段起点 - 本段起点
        if i + 1 < len(segs):
            next_start = segs[i + 1].get('start_ms') or int(segs[i + 1].get('start', 0) * 1000)
            target_ms = max(1, next_start - start_ms)
        else:
            # 最后一段：用它的 duration 兜底（不再补静音）
            target_ms = None

        out_wav = os.path.join(tmpdir, f"seg_{i:05d}.wav")
        if target_ms is None:
            # 最后一段直接转 wav
            run([ffmpeg, '-y', '-i', seg_path, '-ac', '2', '-ar', '44100', out_wav])
        else:
            # 转 wav 后用 apad 补静音，再 atrim 到 target_ms 长度
            target_sec = target_ms / 1000.0
            af = f'apad=whole_dur={target_sec:.3f},atrim=0:{target_sec:.3f},asetpts=PTS-STARTPTS'
            run([ffmpeg, '-y', '-i', seg_path, '-af', af,
                 '-ac', '2', '-ar', '44100', out_wav])
        padded.append(out_wav)

    if not padded:
        raise RuntimeError('没有可用的分段音频')

    # concat 所有 padded 段 = 完整对齐音轨
    concat_list = os.path.join(tmpdir, 'track_concat.txt')
    with open(concat_list, 'w', encoding='utf-8') as f:
        for p in padded:
            f.write(f"file '{p}'\n")
    track_wav = os.path.join(tmpdir, 'aligned_track.wav')
    run([ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', concat_list,
         '-c', 'copy', track_wav])
    print(f"  对齐音轨生成完成  ({len(padded)} 段)")
    return track_wav


def mode_batch(src_video, pkg_dir, out_video, orig_volume=0.1):
    """合并：原视频 + 对齐配音轨。原声降到 orig_volume 当背景音（默认 10%）。

    src_video: 原视频路径（原速版，yt-dlp 等下载）
    pkg_dir:   配音包解压目录（含 manifest.json + segments/）
    out_video: 输出成片路径（命名 = 原视频名 + _C）
    orig_volume: 原音量保留比例（0=完全静音，0.1=保留10%当背景，1.0=原样保留）
    """
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError('找不到 ffmpeg，请把它加进 PATH')
    if not os.path.exists(src_video):
        raise FileNotFoundError(f'找不到原始视频: {src_video}')

    manifest_path = os.path.join(pkg_dir, 'manifest.json')
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f'找不到 manifest.json: {manifest_path}')
    with open(manifest_path, encoding='utf-8') as f:
        manifest = json.load(f)

    seg_dir = os.path.join(pkg_dir, 'segments')
    if not os.path.isdir(seg_dir):
        raise FileNotFoundError(f'找不到 segments 目录: {seg_dir}')

    title = manifest.get('title', manifest.get('video_id'))
    print(f"视频: {title}")
    print(f"原视频: {os.path.basename(src_video)}")
    print(f"分段: {manifest.get('segment_count')} 段, 配音时长约 {manifest.get('total_duration', 0):.1f}s")

    # 先看视频里有没有音轨（有的纪录片/lecture 没音轨）
    has_audio = True
    try:
        probe = subprocess.run(
            [find_ffprobe(), '-v', 'quiet', '-select_streams', 'a',
             '-show_entries', 'stream=index', '-of', 'csv=p=0', src_video],
            capture_output=True, text=True)
        has_audio = bool(probe.stdout.strip())
    except Exception:
        has_audio = True
    print(f"  原视频{'有' if has_audio else '无'}音轨")

    with tempfile.TemporaryDirectory() as tmpdir:
        track_wav = build_aligned_track(manifest, seg_dir, tmpdir)

        cmd = ['ffmpeg', '-y',
               '-i', src_video,
               '-i', track_wav]
        # 映射：原视频(0:v) + 原音轨(0:a,降音量) + 配音轨(1:a)
        if has_audio:
            vf = '[0:a]volume={}[orig];[orig][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]'.format(orig_volume)
            cmd += ['-filter_complex', vf,
                    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k']
        else:
            # 原视频没音轨，直接用配音轨
            cmd += ['-map', '0:v', '-map', '1:a',
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest']
        cmd += ['-shortest', out_video]
        run(cmd)

    print(f"完成：{os.path.basename(out_video)}")
    print(f"（原声保留 {int(orig_volume*100)}%，配音为新增音轨）")


# ============================================================
# realtime（拉伸原视频对齐配音，原有逻辑）
# ============================================================
def mode_realtime(src_video, ratelog_path, out_video):
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


# ============================================================
# 命令入口
# ============================================================
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    mode = sys.argv[1]
    if mode in ('-h', '--help', 'help'):
        print(__doc__)
        return

    if mode == 'init':
        mode_init()
        return

    if mode == 'merge-all':
        mode_merge_all()
        return

    if mode == 'realtime':
        if len(sys.argv) != 5:
            print(f"用法: python {os.path.basename(__file__)} realtime 原始视频.mp4 ratelog.json 输出.mp4")
            sys.exit(1)
        mode_realtime(sys.argv[2], sys.argv[3], sys.argv[4])
        return

    if mode == 'batch':
        if len(sys.argv) not in (4, 5):
            print(f"用法: python {os.path.basename(__file__)} batch 原始视频.mp4 配音包目录 [输出.mp4]")
            sys.exit(1)
        src, pkg = sys.argv[2], sys.argv[3]
        if len(sys.argv) == 5:
            out = sys.argv[4]
        else:
            base, ext = os.path.splitext(src)
            out = f"{base}_C{ext}"
        mode_batch(src, pkg, out)
        return

    # 兼容最旧的旧调用：python retime_video.py src.mp4 log.json out.mp4
    if len(sys.argv) == 4 and os.path.exists(sys.argv[1]):
        print('检测到旧式 3 参数调用，按 realtime 模式处理...')
        mode_realtime(sys.argv[1], sys.argv[2], sys.argv[3])
        return

    print(f"未知模式: {mode}")
    print(__doc__)
    sys.exit(1)


if __name__ == '__main__':
    main()
