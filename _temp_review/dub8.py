import asyncio
import difflib
import glob
import datetime
import json
import random
import re
import shutil
import subprocess
import os
import sys
import time

# Windows默认控制台是GBK编码，print里的emoji（⚠✅❌等）会导致UnicodeEncodeError，
# 强制stdout/stderr用utf-8（遇到无法编码的字符替换而不是崩溃）
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')

import edge_tts
import yt_dlp
from tqdm import tqdm
from google import genai

try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    FASTER_WHISPER_AVAILABLE = False

# Windows下用 pythonw(无窗口) 启动时，子进程 ffmpeg/ffprobe 会各自弹出黑色控制台
# 窗口再消失，造成屏幕不停闪烁。加上 CREATE_NO_WINDOW 让这些子进程不创建窗口。
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

# ========== 配置区（只需改这里）==========
# API Key 从环境变量读取，请先设置：
#   PowerShell: $env:GEMINI_API_KEY = "你的key"
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
TARGET_LANG = '中文'
TTS_VOICE = 'zh-CN-XiaoxiaoNeural'

# ---------- 配音员（按性别选择） ----------
# 每种性别可配置多个候选配音员，第一个为默认使用的
MALE_VOICES = ['zh-CN-YunxiNeural', 'zh-CN-YunyangNeural']
FEMALE_VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural']

# 当前各性别使用的配音员（取自上面列表中的某一个）
VOICE_MAP = {
    '男': MALE_VOICES[0],
    '女': FEMALE_VOICES[0],
}
PROXY = 'http://127.0.0.1:17891'
# YouTube有时会要求登录验证（"Sign in to confirm you're not a bot"），
# 设置为浏览器名称（如 'chrome'/'edge'/'firefox'）后yt-dlp会从该浏览器读取登录态cookies。
# 设为None则不使用cookies。
COOKIES_FROM_BROWSER = None
# 也可以用cookies文件：在浏览器里用"Get cookies.txt LOCALLY"等扩展导出youtube.com的cookies，
# 导出后把文件放到下面这个固定路径即可（文件不存在时自动忽略），不用每次改设置。
COOKIES_FILE = os.path.join(os.path.dirname(__file__), 'Youtube_Claude_data', 'cookies.txt')

# ASR 模型（按需延迟加载，第一次用时初始化）
_WHISPER_MODEL = None
def get_whisper_model():
    global _WHISPER_MODEL
    if not FASTER_WHISPER_AVAILABLE:
        raise RuntimeError('faster_whisper 未安装，请运行: pip install faster-whisper')
    if _WHISPER_MODEL is None:
        print('[ASR] 初始化 Whisper 模型...')
        _WHISPER_MODEL = WhisperModel('base', device='auto', compute_type='auto')
        print('[ASR] 模型加载完成')
    return _WHISPER_MODEL


def refresh_cookies_from_browser():
    """
    从本机已登录的浏览器里读取youtube.com的cookies并写到COOKIES_FILE，
    供yt-dlp使用。静默执行：任何浏览器读取失败都直接忽略，不影响主流程。
    建议在程序启动时调用一次。
    """
    try:
        import browser_cookie3
    except ImportError:
        return False

    for loader in (browser_cookie3.chrome, browser_cookie3.edge, browser_cookie3.firefox):
        try:
            cj = loader(domain_name='youtube.com')
            if not cj:
                continue
            os.makedirs(os.path.dirname(COOKIES_FILE), exist_ok=True)
            with open(COOKIES_FILE, 'w', encoding='utf-8') as f:
                f.write("# Netscape HTTP Cookie File\n")
                for c in cj:
                    f.write('\t'.join([
                        c.domain,
                        'TRUE' if c.domain.startswith('.') else 'FALSE',
                        c.path,
                        'TRUE' if c.secure else 'FALSE',
                        str(int(c.expires or 0)),
                        c.name,
                        c.value,
                    ]) + '\n')
            return True
        except Exception:
            continue
    return False


def refresh_bilibili_cookies():
    """
    从本机已登录的浏览器里读取bilibili.com的SESSDATA/bili_jct/buvid3，
    写到bilibili_upload.BILIBILI_COOKIES_FILE。静默执行，失败则忽略。
    """
    try:
        import browser_cookie3
        import bilibili_upload
    except ImportError:
        return False

    for loader in (browser_cookie3.chrome, browser_cookie3.edge, browser_cookie3.firefox):
        try:
            cj = loader(domain_name='bilibili.com')
            if not cj:
                continue
            wanted = {'SESSDATA': None, 'bili_jct': None, 'buvid3': None}
            for c in cj:
                if c.name in wanted and c.value:
                    wanted[c.name] = c.value
            if not all(wanted.values()):
                continue
            os.makedirs(os.path.dirname(bilibili_upload.BILIBILI_COOKIES_FILE), exist_ok=True)
            with open(bilibili_upload.BILIBILI_COOKIES_FILE, 'w', encoding='utf-8') as f:
                json.dump(wanted, f, ensure_ascii=False, indent=2)
            return True
        except Exception:
            continue
    return False


def apply_cookies(ydl_opts):
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        ydl_opts['cookiefile'] = COOKIES_FILE
    elif COOKIES_FROM_BROWSER:
        ydl_opts['cookiesfrombrowser'] = (COOKIES_FROM_BROWSER,)
    # 用android客户端规避YouTube的n-challenge（避免"Requested format is not available"）
    ydl_opts.setdefault('extractor_args', {}).setdefault('youtube', {})['player_client'] = ['android']
LOGS_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\logs'
os.makedirs(LOGS_DIR, exist_ok=True)

GEMINI_MODEL = 'gemini-2.5-flash-lite'

# Gemini 2.5 Flash-Lite 价格（每百万token，美元），用于估算费用
GEMINI_INPUT_PRICE_PER_M = 0.10
GEMINI_OUTPUT_PRICE_PER_M = 0.40

BASE_TEMP_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\temp'
TEMP_DIR = BASE_TEMP_DIR  # 每个视频处理时会被改写为各自的子目录

def get_cache_dir(video_id):
    """获取指定视频的缓存目录"""
    return os.path.join(BASE_TEMP_DIR, video_id)

# 待处理的视频列表（YouTube链接或本地文件路径），逐个处理，互不影响
INPUT_LIST = [
    'https://youtu.be/0pMGS6bNcek',
]
OUTPUT_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\output'
os.makedirs(OUTPUT_DIR, exist_ok=True)

# 原视频文件夹：用户自行下载好的原始视频放在这里。
# 程序只负责翻译/配音/生成配音音频，不负责下载完整视频（避免YouTube反爬限制耽误正事）。
# 如果在这里找到时长/文件名匹配的原视频，会自动与配音合并并输出到该文件夹；
# 找不到则只生成配音音频，由用户自行与视频合并。
SOURCE_VIDEO_DIR = r'C:\video\Youtube_Claude\Youtube_Claude_data\source_videos'
os.makedirs(SOURCE_VIDEO_DIR, exist_ok=True)

# 原声音量：0~1之间，0表示完全静音原声（只保留中文配音）
ORIGINAL_AUDIO_VOLUME = 0.1
# 商业版人声分离后，混入的伴奏/环境音音量（仅在原声=0且启用分离时生效）
INSTRUMENTAL_BG_VOLUME = 0.35
# AI 人声分离：原声静音时分离出 BGM/环境音再混入（商业版；本地版勾选仅预留入口）
VOCAL_SEPARATION_ENABLED = False
# 无独显时商业版默认走云端（填 API 地址后接入）；留空则回退 CPU 本地分离
VOCAL_SEPARATION_CLOUD_URL = ''
# 当前任务混音用的背景音量（由 prepare_background_track 设置，None=跟随 ORIGINAL_AUDIO_VOLUME）
CURRENT_BG_MIX_VOLUME = None

# 合并完成后是否自动投稿到B站（需要先配置bilibili_upload.py里的cookies文件）。
# 默认按"转载"投稿，请确保内容来源合法、有相应授权。
AUTO_UPLOAD_BILIBILI = False

# 自动投稿到B站时不直接公开发布，设为"当前时间+该分钟数"定时发布，便于发布前人工检查
BILIBILI_UPLOAD_DELAY_MINUTES = 120

# 是否启用"定时发布自动排期"（之后仍可在B站草稿箱里手动调整每个视频的定时发布时间）。
# 关闭则每个视频都使用下面的固定 BILIBILI_UPLOAD_DELAY_MINUTES。
BILIBILI_SCHEDULE_ENABLED = True
# 第一个视频的起始延迟（分钟）
BILIBILI_SCHEDULE_START_DELAY_MINUTES = 120

# "情感"类：当天发布，同批多个之间间隔（分钟）
BILIBILI_SCHEDULE_EMOTION_INTERVAL_MINUTES = 120
# 一天最多排几个"情感"视频（超过则顺延到第二天同一时刻起继续按间隔排）
BILIBILI_SCHEDULE_EMOTION_PER_DAY = 12

# "知识"类：一天一个，最多排到未来这么多天内
BILIBILI_SCHEDULE_KNOWLEDGE_INTERVAL_MINUTES = 24 * 60
BILIBILI_SCHEDULE_MAX_DAYS = 15


def compute_publish_delay_minutes(category, index):
    """
    计算某个分类下第index个（0开始）视频的定时发布延迟分钟数。
    - "情感"：当天发布，每隔 BILIBILI_SCHEDULE_EMOTION_INTERVAL_MINUTES 分钟一个，
      一天排满 BILIBILI_SCHEDULE_EMOTION_PER_DAY 个后顺延到下一天同一起始时刻。
    - 其它（"知识"等）：一天一个，最多排到 BILIBILI_SCHEDULE_MAX_DAYS 天内（封顶）。
    """
    if not BILIBILI_SCHEDULE_ENABLED:
        return BILIBILI_UPLOAD_DELAY_MINUTES

    max_minutes = BILIBILI_SCHEDULE_MAX_DAYS * 24 * 60

    if category == '情感':
        per_day = max(BILIBILI_SCHEDULE_EMOTION_PER_DAY, 1)
        day, slot = divmod(index, per_day)
        delay = (BILIBILI_SCHEDULE_START_DELAY_MINUTES
                 + slot * BILIBILI_SCHEDULE_EMOTION_INTERVAL_MINUTES
                 + day * 24 * 60)
        return min(delay, max_minutes)

    max_days = max_minutes // (24 * 60)
    day = index % max_days
    return BILIBILI_SCHEDULE_START_DELAY_MINUTES + day * BILIBILI_SCHEDULE_KNOWLEDGE_INTERVAL_MINUTES

# ---------- 字幕选项 ----------
# 'none'  : 不加字幕
# 'soft'  : 软字幕（独立字幕轨道，几乎不增加处理时间；
#           但具体能否显示/开关取决于播放软件——多数本地播放器/手机播放器支持，
#           部分网站（如B站）上传后会丢弃此轨道，不会显示）
# 'hard'  : 硬字幕（烧录进画面，任何平台都能看到，但处理时间与视频长度成正比，
#           通常几分钟到十几分钟，且不可关闭）
SUBTITLE_MODE = 'none'

# 是否使用双语字幕（中文+原文）。仅在 SUBTITLE_MODE 不为 'none' 时生效。
BILINGUAL_SUBTITLE = False

# 烧录字幕时使用的字体（需系统已安装，中文需选支持中文的字体）
SUBTITLE_FONT = 'Microsoft YaHei'

# ---------- 用户等级 ----------
# 'free'    : 使用本软件自带的免费配置（基础语音、单语字幕等）
# 'premium' : 付费解锁高级功能（如双语字幕、更多音色等）
USER_TIER = 'free'

if USER_TIER != 'premium' and BILINGUAL_SUBTITLE:
    print("提示：双语字幕为付费功能，当前为免费版，已自动关闭双语字幕。")
    BILINGUAL_SUBTITLE = False

os.makedirs(TEMP_DIR, exist_ok=True)


# ========== 第一步：获取字幕 ==========
LANG_NAME_MAP = {
    'en': '英文', 'ja': '日语', 'ru': '俄语', 'ko': '韩语', 'es': '西班牙语',
    'fr': '法语', 'de': '德语', 'pt': '葡萄牙语', 'it': '意大利语',
    'ar': '阿拉伯语', 'hi': '印地语', 'th': '泰语', 'vi': '越南语',
    'id': '印尼语', 'tr': '土耳其语', 'pl': '波兰语', 'nl': '荷兰语',
    'uk': '乌克兰语', 'zh': '中文',
}


def get_subtitles(url_or_file):
    # 清理上次残留字幕文件
    for f in os.listdir(TEMP_DIR):
        if f.endswith('.vtt') or f.endswith('.srt'):
            os.remove(os.path.join(TEMP_DIR, f))

    # 探测视频原始语言及可用字幕语言，优先使用原生语言字幕，
    # 避免"原语言→YouTube自动翻译英文→中文"的二次转译损耗。
    subtitle_langs = ['en', 'en-US', 'en-GB']
    source_lang = '英文'
    try:
        probe_opts = {'skip_download': True, 'quiet': True}
        apply_cookies(probe_opts)
        with yt_dlp.YoutubeDL(probe_opts) as ydl:
            info = ydl.extract_info(url_or_file, download=False)
        orig_lang = info.get('language')
        available = set(info.get('subtitles', {}) or {}) | set(info.get('automatic_captions', {}) or {})
        if orig_lang and not orig_lang.startswith('en'):
            base = orig_lang.split('-')[0]
            matched = [c for c in (orig_lang, base) if c in available]
            if matched:
                subtitle_langs = matched + subtitle_langs
                source_lang = LANG_NAME_MAP.get(base, orig_lang)
    except Exception as e:
        log_event(f"探测原始语言失败，回退到英文字幕：{e}")

    ydl_opts = {
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': subtitle_langs,
        'subtitlesformat': 'vtt',
        'skip_download': True,
        'outtmpl': os.path.join(TEMP_DIR, 'subtitle'),
    }
    apply_cookies(ydl_opts)
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.extract_info(url_or_file, download=True)

    vtt_files = [f for f in os.listdir(TEMP_DIR) if f.endswith('.vtt')]
    if not vtt_files:
        raise FileNotFoundError("未找到字幕文件，该视频可能没有可用字幕")

    # 按优先级（原生语言优先，英文兜底）选择实际下载到的字幕文件
    chosen = vtt_files[0]
    for lang in subtitle_langs:
        matches = [f for f in vtt_files if f'.{lang}.' in f]
        if matches:
            chosen = matches[0]
            break
    else:
        source_lang = '英文'

    if f'.{subtitle_langs[0]}.' not in chosen:
        source_lang = '英文'

    vtt_path = os.path.join(TEMP_DIR, chosen)
    return parse_vtt(vtt_path), source_lang


def parse_vtt(vtt_path):
    """解析 YouTube 字幕 VTT。

    关键：YouTube 自动字幕（含自动翻译）是"滚动字幕"格式——每个带内联时间标签
    (<00:00:01.234>) 的 cue 里，上面几行是上一句的残留(carry-over)，
    只有【最后一行】才是这个时间段新出现的台词；两者之间还夹着 10ms 的"快照"cue。

    旧逻辑用"文本包含关系"去重，对英文有效（文字逐字累加），但对中文无效
    （相邻两句中文没有包含关系），导致每句话被保留两遍、配音重复。

    正确做法（与 TubeGet 一致）：只取每个带时间标签 cue 的最后一行，时间用 cue 起止，
    得到无重叠的标准字幕。
    """
    with open(vtt_path, 'r', encoding='utf-8') as f:
        content = f.read()

    pattern = r'(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\Z)'
    matches = re.findall(pattern, content)

    inline_ts = re.compile(r'<\d{2}:\d{2}:\d{2}\.\d{3}>')
    is_rolling = any(inline_ts.search(block) for _, _, block in matches)

    raw = []
    for start, end, block in matches:
        if is_rolling:
            # 滚动字幕：只处理带内联时间标签的 cue（跳过 10ms 快照 cue），
            # 去标签后只取最后一行（新台词），丢掉上面的残留行。
            if not inline_ts.search(block):
                continue
            clean = re.sub(r'<[^>]+>', '', block)
            lines = [ln.strip() for ln in clean.split('\n') if ln.strip()]
            if not lines:
                continue
            text = lines[-1]
        else:
            # 普通非滚动字幕（如人工上传的轨道）：整块作为一条
            text = re.sub(r'<[^>]+>', '', block).replace('\n', ' ')
        # 去掉[music]/[applause]等音效标注，它们不是台词
        text = re.sub(r'[\[(（【][^\])）】]*[\])）】]', '', text)
        text = re.sub(r'\s+', ' ', text).strip()
        if not text:
            continue
        raw.append({
            'start': timestamp_to_seconds(start),
            'end': timestamp_to_seconds(end),
            'text': text
        })

    # 合并相邻【完全相同】的文本（保险：偶有重复快照），延长结束时间而非重复说
    segments = []
    for seg in raw:
        if segments and segments[-1]['text'] == seg['text']:
            segments[-1]['end'] = seg['end']
            continue
        segments.append(seg)

    # YouTube自动字幕的第一条往往滞后于视频实际开始说话的时间（通常2~4秒），
    # 导致配音也跟着晚开始，造成"原音已经在说、配音还没出声"的体感。
    # 把所有时间戳整体前移第一条字幕的起始时间，让配音从视频开头就开始。
    if segments:
        offset = segments[0]['start']
        if 0 < offset <= 6:
            for seg in segments:
                seg['start'] = max(seg['start'] - offset, 0.0)
                seg['end'] = max(seg['end'] - offset, 0.0)

    return segments


def timestamp_to_seconds(ts):
    parts = ts.split(':')
    if len(parts) == 3:
        h, m, s = parts
        return int(h) * 3600 + int(m) * 60 + float(s)
    elif len(parts) == 2:
        m, s = parts
        return int(m) * 60 + float(s)
    return 0


def merge_rolling_subtitles(segments):
    """
    YouTube 自动字幕是'滚动'格式：相邻字幕的时间区间重叠。
    此函数通过'时间优先'原则合并，避免同一句话被说多遍。

    原理：如果当前段的时间起点在前一段之后才应该新增内容。
    时间重叠部分的文本，优先信任后面出现的字幕（因为它更新）。
    """
    if not segments or len(segments) <= 1:
        return segments

    merged = []
    for i, seg in enumerate(segments):
        if i == 0:
            merged.append(seg.copy())
            continue

        prev = merged[-1]
        curr = seg

        # 情况 1：无时间重叠，直接添加
        if curr['start'] >= prev['end']:
            merged.append(curr.copy())
            continue

        # 情况 2：有时间重叠，需要处理
        # 前一段覆盖 [prev['start'], prev['end']]
        # 当前段覆盖 [curr['start'], curr['end']]
        # 重叠部分是 [curr['start'], prev['end']]

        # 策略：重叠部分用当前段的文本替换，当前段的新增部分照常添加
        overlap_duration = prev['end'] - curr['start']  # 重叠时长
        prev_duration = prev['end'] - prev['start']     # 前一段总时长

        # 如果重叠时间很长（>80% 前一段），说明这是一个"滚动增量"
        # 应该合并，而不是分开说
        if prev_duration > 0:
            overlap_ratio = overlap_duration / prev_duration
            if overlap_ratio > 0.8:
                # 重叠很多，这是同一句话的逐字推进
                # 只保留当前段的新增内容
                # 计算当前段中哪部分是"新增"的（按字符比例推断）
                char_ratio = overlap_duration / (curr['end'] - curr['start']) if (curr['end'] - curr['start']) > 0 else 0

                # 简单策略：重叠部分的文本，用当前段完整文本（因为它更新）
                # 新增部分：从当前段末尾倒推
                prev['text'] = curr['text']  # 用更新的文本替换
                prev['end'] = curr['end']     # 延长结束时间
            else:
                # 重叠较少，有明显的新内容，按时间分割
                # 前一段保持不变，新增一段用于新的时间区间
                merged.append({
                    'start': prev['end'],
                    'end': curr['end'],
                    'text': curr['text']
                })
        else:
            # prev_duration 为 0，异常，直接添加
            merged.append(curr.copy())

    return merged


def dedupe_rolling_overlap(segments, max_overlap=12):
    """
    安全的相邻去重：只移除下一条【开头】与上一条【结尾】重复的若干词，
    不删除整段、不按相似度判断（避免误删"确实重复说的话"）。
    真正的滚动字幕去重已在 parse_vtt 完成，这里只是兜底处理词级边界重叠。
    """
    if not segments:
        return segments

    def remove_overlap(a_text, b_text):
        a_words = a_text.split()
        b_words = b_text.split()
        n_max = min(len(a_words), len(b_words), max_overlap)
        for n in range(n_max, 0, -1):
            if a_words[-n:] == b_words[:n]:
                return ' '.join(b_words[n:])
        return b_text

    for i in range(1, len(segments)):
        prev_text = segments[i - 1]['text']
        cur_text = segments[i]['text'].lstrip()
        deduped = remove_overlap(prev_text, cur_text)
        segments[i]['text'] = deduped if deduped else segments[i]['text']

    return segments


def estimate_speech_duration(text, words_per_sec=2.2, chars_per_sec=6.0):
    """按正常语速估算这段文字实际说话需要多久（秒）"""
    words = len(text.split())
    if words <= 1 and len(text) > 4:
        # 日语等不以空格分词的语言，按字符数估算
        return len(text) / chars_per_sec
    return words / words_per_sec


def estimate_durations(segments):
    """
    互相印证字幕时间窗与文字长度：
    YouTube自动字幕的时间戳常常偏大（停顿被算进时间窗），
    若估算的实际说话时长明显小于字幕窗口，按估算值为准，
    避免翻译/配音被分配到过长的时间窗而填不满。
    """
    for seg in segments:
        vtt_duration = seg['end'] - seg['start']
        est_duration = estimate_speech_duration(seg['text']) * 1.3  # 留余量
        seg['duration'] = max(min(vtt_duration, est_duration), 1.0)
    return segments


def group_into_sentences(segments, split_gap=1.0, max_duration=8.0):
    """
    把逐条字幕按"完整的一句话"分组：
    - 原文以句末标点(.!?)结尾、或与下一条间隔较大(自然停顿)、
      或累计已经够长，则在此断句。
    - 翻译时以"一整句"为单位送给Gemini，保证上下文连贯、语义完整，
      不会出现单条字幕被硬切导致意思不通的问题。
    - 同时保留每条原始字幕的时间窗(parts)，导出字幕时再按自然断点
      把整句译文分配回各个原始时间窗，让中文字幕的切换节奏贴近画面。
    """
    if not segments:
        return segments

    groups = []
    current = segments[0].copy()
    current['parts'] = [{'start': current['start'], 'end': current['end'], 'text': current['text']}]

    for nxt in segments[1:]:
        gap = nxt['start'] - current['end']
        cur_dur = current['end'] - current['start']
        ends_sentence = bool(re.search(r'[.!?]\s*$', current['text']))

        if gap >= split_gap or cur_dur >= max_duration or ends_sentence:
            groups.append(current)
            current = nxt.copy()
            current['parts'] = [{'start': nxt['start'], 'end': nxt['end'], 'text': nxt['text']}]
        else:
            current['end'] = nxt['end']
            current['text'] = current['text'].rstrip() + ' ' + nxt['text'].lstrip()
            current['duration'] = current.get('duration', 0) + nxt['duration']
            current['parts'].append({'start': nxt['start'], 'end': nxt['end'], 'text': nxt['text']})

    groups.append(current)
    return groups


def group_chinese_sentences(segments, split_gap=0.8, max_duration=8.0):
    """
    中文字幕专用分句合并：把"被拆成多行的同一句话"合并成一句，
    让 TTS 连读、行与行之间不停顿。
    - 上一行以句末标点(。！？；…!?)结尾、或与下一行间隔较大(自然停顿)、
      或累计时长过长，则断句。
    - 中文无空格，合并时直接拼接，不插空格。
    """
    if not segments:
        return segments

    end_punct = '。！？；…!?.;'
    groups = []
    current = segments[0].copy()
    current['parts'] = [{'start': current['start'], 'end': current['end'], 'text': current['text']}]

    for nxt in segments[1:]:
        gap = nxt['start'] - current['end']
        cur_dur = current['end'] - current['start']
        last_char = current['text'].rstrip()[-1:] if current['text'].rstrip() else ''
        ends_sentence = last_char in end_punct

        if gap >= split_gap or cur_dur >= max_duration or ends_sentence:
            groups.append(current)
            current = nxt.copy()
            current['parts'] = [{'start': nxt['start'], 'end': nxt['end'], 'text': nxt['text']}]
        else:
            current['end'] = nxt['end']
            current['text'] = current['text'].rstrip() + nxt['text'].lstrip()
            current['duration'] = current.get('duration', 0) + nxt.get('duration', 0)
            current['parts'].append({'start': nxt['start'], 'end': nxt['end'], 'text': nxt['text']})

    groups.append(current)
    return groups


def split_translation_by_parts(translation, parts):
    """
    把一整句的译文，按自然的中文短语断点(逗号/顿号等)分配回它跨越的
    各个原始字幕时间窗，使中文字幕的切换节奏贴近原片画面/语音的节奏，
    同时保持整句翻译时的语义连贯。
    """
    if len(parts) <= 1:
        return [translation]

    clauses = re.findall(r'[^，。！？；,.!?;、\n]+[，。！？；,.!?;、]?', translation)
    clauses = [c for c in clauses if c.strip()]
    if not clauses:
        return [translation] + [''] * (len(parts) - 1)

    total_chars = sum(len(c) for c in clauses)
    durations = [max(p['end'] - p['start'], 0.1) for p in parts]
    total_duration = sum(durations)
    targets = [total_chars * d / total_duration for d in durations]

    result = [''] * len(parts)
    pi = 0
    acc = 0
    for c in clauses:
        if pi < len(parts) - 1 and acc > 0 and acc >= targets[pi]:
            pi += 1
            acc = 0
        result[pi] += c
        acc += len(c)
    return result


def retranslate_overflow_line(seg, prev_translation, cap_chars, target_lang=TARGET_LANG, source_lang='英文'):
    """
    单行重译：当某行译文字数超过上限时调用。重申核心翻译规则并明确指出
    上一次的译文和超字数情况，强化模型对约束的记忆，要求重新给出更短的译文。
    """
    client = genai.Client(api_key=GEMINI_API_KEY)
    prompt = f"""爱占宝，你刚才把下面这句{source_lang}字幕翻译成{target_lang}，但译文超出了字数上限，
会导致配音和下一句语音重叠，这是必须避免的问题。爱占宝，这次没有按要求做，
这次要改正，下次也要记住这个要求，不要再犯。请重新翻译，严格遵守以下规则：

1. 译文字数必须 <= {cap_chars} 个汉字（这是硬上限，原文字符数的一半左右）。
2. 精简优先顺序：先删虚词/口水词（的、了、就是、那么、其实等）；
   再把双字词压缩成更短的同义表达，但核心描述对象/性质不能整体删掉
   （如"高质量"可压成"高质"，但不能删成只剩"高"）；
   不要删掉核心名词、动词，也不要把情绪/氛围词（震撼、温暖、治愈等）
   删成中性表达——译文要保留原文的情绪/氛围，不能干巴巴。
3. 语义仍要完整、自然，能让人看懂这句话在说什么。

原文：{seg['text']}
你上一次的译文（{len(prev_translation)}字，超出了{len(prev_translation) - cap_chars}字）：{prev_translation}

爱占宝，只输出新的译文，不要输出任何解释、前缀或标点之外的内容。"""

    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=GEMINI_MODEL,
                contents=prompt,
                config=genai.types.GenerateContentConfig(max_output_tokens=200)
            )
            text = (response.text or '').strip().splitlines()[0].strip()
            return text or None
        except Exception as e:
            if attempt == 2:
                print(f"\n  重译失败，跳过：{e}")
                return None
            time.sleep((attempt + 1) * 3)
    return None


def spot_check_line(seg, cache, cache_path, target_lang=TARGET_LANG):
    """
    抽查：让爱占宝复核某一行译文是否守住了字数上限和翻译规则。
    没问题就不动；有问题则按规则重译并强化记忆（与超字数检测走同一条重译逻辑）。
    """
    translation = seg.get('translation')
    cap_chars = seg.get('_cap_chars')
    if not translation or not cap_chars:
        return

    client = genai.Client(api_key=GEMINI_API_KEY)
    prompt = f"""爱占宝，这是一次抽查，复核一下你之前翻译的这一行是否合格：

原文：{seg['text']}
译文：{translation}（{len(translation)}字）
字数上限：{cap_chars}字

检查标准：
1. 译文字数是否 <= {cap_chars + 1}？（超出 1 字以内可接受，不必改）
2. 是否保留了核心名词、动词和情绪/氛围，没有变得干巴巴？
3. 是否语义完整、自然？

如果完全合格，只输出：OK
如果不合格，只输出更短/更好的新译文（不要解释，不要输出"OK"以外的其他说明）。"""

    try:
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=genai.types.GenerateContentConfig(max_output_tokens=200)
        )
        result = (response.text or '').strip().splitlines()[0].strip()
    except Exception:
        return

    if not result or result.upper() == 'OK':
        return

    print(f"\n  🔍 抽查发现问题，爱占宝修正该行：{seg['text'][:30]}...")
    seg['translation'] = result
    cache[seg['text']] = result
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def clean_translation(text):
    """译文后处理：把"他/她""她/他"这类不指明性别的写法统一替换为"某人"，
    因为原文常是 someone/they 等中性词，不该硬翻成具体性别。"""
    if not text:
        return text
    # "他/她"、"她/他"、"他/她们"、"她/他们" 等斜杠并列形式 -> 某人
    text = re.sub(r'(他|她)\s*/\s*(他|她)(们)?', '某人', text)
    return text


# ========== 第二步：翻译字幕 ==========
def translate_segments(segments, target_lang=TARGET_LANG, usage=None, title=None, source_lang='英文'):
    client = genai.Client(api_key=GEMINI_API_KEY)
    if usage is None:
        usage = {'input_tokens': 0, 'output_tokens': 0, 'input_chars': 0, 'output_chars': 0}

    # 根据整个视频的语速估算合理的中文字数/秒预算，而不是用一刀切的固定值。
    # 原文词数/总时长 ≈ 语速，再乘以"每个英文词大致对应的中文字数"经验系数。
    total_speech_sec = sum(estimate_speech_duration(s['text']) for s in segments)
    total_duration = sum(max(s['duration'], 0.1) for s in segments)
    speech_ratio = total_speech_sec / total_duration if total_duration else 1.0
    chars_per_sec = speech_ratio * 5.5
    chars_per_sec = max(3.0, min(chars_per_sec, 6.0))
    # 仅用于估算输出token上限，给足够宽裕的空间，绝不用于截断译文内容
    token_budget_chars_per_sec = chars_per_sec * 6
    log_event(f"本视频语速系数约{speech_ratio:.2f}，"
              f"译文预算约{chars_per_sec:.1f}字/秒", title)

    cache_path = os.path.join(TEMP_DIR, 'translations.json')
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        print(f"  读取缓存：已有 {len(cache)} 条翻译")

    for seg in segments:
        if seg['text'] in cache:
            translation = cache[seg['text']]
            if re.match(r'^\d+(\.\d+)?s\|', translation):
                # 缓存中混入了"时长|"前缀的脏数据，丢弃后重新翻译
                continue
            seg['translation'] = clean_translation(translation)

    todo = [s for s in segments if 'translation' not in s]
    hit = len(segments) - len(todo)
    if hit:
        log_event(f"翻译缓存命中 {hit}/{len(segments)} 条", title)
    if not todo:
        log_event("全部命中翻译缓存，跳过翻译", title)
        return segments

    def translate_batch(batch):
            lines = []
            for i, s in enumerate(batch):
                duration = s['duration']
                target_chars = max(round(duration * chars_per_sec), 1)
                # 提示词里给Gemini的"上限字数"仍按原文一半（更严格，争取一次到位）；
                # 实际超字数检测放宽到原文2/3，避免大量本来可以接受的译文被重译
                half_len = max(len(s['text']) // 2, 1)
                prompt_cap = min(target_chars, half_len)
                check_cap = min(target_chars, max(round(len(s['text']) * 2 / 3), 1))
                s['_cap_chars'] = check_cap
                lines.append(f"{i}|{duration:.1f}s|目标{target_chars}字|上限{prompt_cap}字|{s['text']}")
            batch_text = '\n'.join(lines)

            # 按每条字幕的时长估算本批次合理的最大输出token数（仅防止接口报错，不限制译文长度）
            batch_max_chars = sum(max(int(s['duration'] * token_budget_chars_per_sec), 30) for s in batch)
            max_output_tokens = batch_max_chars * 2 + len(batch) * 10

            prompt = f"""你是"爱占宝"，一个专业的{source_lang}→{target_lang}配音翻译。

【唯一硬约束】每行译文的字数必须严格 <= 该行的"上限字数"。这条规则凌驾于一切之上，包括"翻译完整"。超了宁可删，不能留。

【输入格式】序号|时长|上限字数|原文
【输出格式】序号|实际字数|译文
——必须输出实际字数，你要先数好再写，数错了重写。

【翻译要求】（在守住上限字数的前提下尽量做到）
- 先通读全部原文理解整体意思，再逐行翻译，保证上下文连贯
- 精炼优先：删虚词口水词（的了就是那么其实然后）、合并重复信息、用短词替长词
- 保留核心名词、动词和情绪词（震撼/温暖/惊艳等不能删成中性）
- 若某行字数富余，可把下一行的词提前说，本行末加"——"
- 区分相近词：complex/complicated、simple/easy等要译成两个不同的中文词
- 不指明性别的词（someone/somebody/they/this person等）不要译成"他"或"她"，
  更不能写成"他/她""她/他"这种形式，统一用"某人""有人""对方""这个人"等中性说法

{batch_text}

逐行输出，格式严格为：序号|实际字数|译文"""

            response = None
            for attempt in range(5):
                try:
                    response = client.models.generate_content(
                        model=GEMINI_MODEL,
                        contents=prompt,
                        config=genai.types.GenerateContentConfig(
                            max_output_tokens=max_output_tokens
                        )
                    )
                    break
                except Exception as e:
                    if attempt == 4:
                        print(f"\n  批次失败，跳过：{e}")
                        break
                    wait = (attempt + 1) * 3
                    print(f"\n  Gemini繁忙，{wait}秒后重试({attempt+1}/5)...")
                    time.sleep(wait)

            if response:
                usage['input_chars'] += len(prompt)
                usage['output_chars'] += len(response.text or '')
                if getattr(response, 'usage_metadata', None):
                    usage['input_tokens'] += response.usage_metadata.prompt_token_count or 0
                    usage['output_tokens'] += response.usage_metadata.candidates_token_count or 0

                # 按行的先后顺序与输入逐一对应，不依赖Gemini回传的序号
                # （序号偶尔会错位/跳号，用序号取batch[idx]会把译文错配到
                #  另一条时长完全不同的字幕上，造成"异常超长"的假象）
                resp_lines = [l for l in response.text.strip().split('\n') if '|' in l]
                if len(resp_lines) != len(batch):
                    print(f"\n  警告：本批次返回{len(resp_lines)}行，期望{len(batch)}行，"
                          f"可能有字幕未翻译。")

                for pos, line in enumerate(resp_lines):
                    if pos >= len(batch):
                        break
                    try:
                        parts = line.split('|')
                        # 新格式：序号|实际字数|译文（parts[1]是纯数字）
                        # 兼容旧格式：序号|译文（parts[1]不是纯数字）
                        if len(parts) >= 3 and re.fullmatch(r'\d+', parts[1].strip()):
                            translation = '|'.join(parts[2:]).strip()
                        else:
                            translation = parts[-1].strip()

                        seg = batch[pos]
                        seg['translation'] = clean_translation(translation)
                    except:
                        pass

                # 仅记录超字数情况，不再重译（节省token）
                had_overflow = False
                for seg in batch:
                    translation = seg.get('translation')
                    cap_chars = seg.get('_cap_chars')
                    if not translation or not cap_chars:
                        continue
                    # 容忍超 1 个字：超出 1 字不算问题、不触发返修/重译（语速上几乎无差别）
                    if len(translation) > cap_chars + 1:
                        had_overflow = True
                        print(f"\n  ⚠ 超字数（{len(translation)}>{cap_chars}）：{seg['text'][:30]}...")

                for seg in batch:
                    if 'translation' in seg:
                        cache[seg['text']] = seg['translation']
                with open(cache_path, 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False, indent=2)

            return had_overflow

    # 抽查机制：连续SPOT_CHECK_INTERVAL批没有发现超字数问题时，抽一行做一次复核，
    # 强化对规则的记忆；一旦发现问题就重置计数（说明还需要更频繁地提醒），
    # 完全没问题时按这个间隔慢慢抽查，减少整体耗时
    SPOT_CHECK_INTERVAL = 5
    clean_streak = 0

    batch_size = 50
    batches = [todo[i:i+batch_size] for i in range(0, len(todo), batch_size)]
    with tqdm(total=len(todo), desc="翻译字幕", unit="条") as pbar:
        for batch in batches:
            had_overflow = translate_batch(batch)
            if had_overflow:
                clean_streak = 0
            else:
                clean_streak += 1
                if clean_streak >= SPOT_CHECK_INTERVAL:
                    clean_streak = 0
                    candidates = [s for s in batch if s.get('translation') and s.get('_cap_chars')]
                    if candidates:
                        spot_check_line(random.choice(candidates), cache, cache_path)
            pbar.update(len(batch))

    # 有些批次Gemini返回的行数会少于输入行数（漏翻），用更小的批次重试补齐
    for retry_round in range(3):
        missing = [s for s in todo if 'translation' not in s]
        if not missing:
            break
        log_event(f"补翻第{retry_round+1}轮：{len(missing)}条字幕缺失译文，用小批次重试", title)
        for i in range(0, len(missing), 5):
            translate_batch(missing[i:i+5])

    still_missing = [s for s in todo if 'translation' not in s]
    done_count = len(todo) - len(still_missing)
    log_event(f"补翻完成：{done_count}/{len(todo)}条字幕已获得译文", title)
    if still_missing:
        log_event(f"警告：{len(still_missing)}条字幕始终未获得译文，将跳过", title)

    return segments


def seconds_to_srt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def format_subtitle_line(text):
    """
    字幕行收尾处理：去掉结尾的逗号/句号/分号/顿号等标点（保留问号、叹号，
    因为它们承载语气），让字幕尽量以"一句话/一行"的形式呈现，
    不需要每行都靠句末标点收尾。
    """
    text = text.strip()
    text = re.sub(r'[，,。.；;、]+$', '', text)
    return text


def export_srt(segments, srt_path, bilingual=False):
    """把翻译结果导出为SRT字幕文件：每句完整译文按自然断点拆回原始字幕时间窗"""
    lines = []
    idx = 1
    for seg in segments:
        if 'translation' not in seg:
            continue
        parts = seg.get('parts') or [{'start': seg['start'], 'end': seg['end'], 'text': seg['text']}]
        texts = split_translation_by_parts(seg['translation'], parts)

        # 如果这一段配音实际比原时间窗长，延长最后一部分字幕的结束时间，
        # 避免配音还没说完字幕就先消失了
        seg_end = seg['end']
        if seg.get('audio_path') and os.path.exists(seg['audio_path']):
            audio_dur = get_audio_duration(seg['audio_path'])
            seg_end = max(seg_end, seg['start'] + audio_dur)

        for i, (part, text) in enumerate(zip(parts, texts)):
            text = format_subtitle_line(text)
            if not text:
                continue
            start = seconds_to_srt_time(part['start'])
            part_end = seg_end if i == len(parts) - 1 else part['end']
            end = seconds_to_srt_time(part_end)
            if bilingual:
                content = f"{text}\n{part['text']}"
            else:
                content = text
            lines.append(f"{idx}\n{start} --> {end}\n{content}\n")
            idx += 1

    with open(srt_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))


def log_event(message, title=None):
    """打印并写入流程日志（logs/process_log.txt），方便事后追溯缓存命中等信息"""
    prefix = f"[{title}] " if title else ""
    print(f"  {prefix}{message}")
    log_path = os.path.join(LOGS_DIR, 'process_log.txt')
    with open(log_path, 'a', encoding='utf-8') as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {prefix}{message}\n")


def log_usage(title, usage):
    """记录本次视频的Gemini用量，并累加输出总计"""
    cost = (usage['input_tokens'] * GEMINI_INPUT_PRICE_PER_M
            + usage['output_tokens'] * GEMINI_OUTPUT_PRICE_PER_M) / 1_000_000

    log_path = os.path.join(LOGS_DIR, 'gemini_usage.json')
    records = []
    if os.path.exists(log_path):
        with open(log_path, 'r', encoding='utf-8') as f:
            records = json.load(f)

    record = {
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        'title': title,
        'input_tokens': usage['input_tokens'],
        'output_tokens': usage['output_tokens'],
        'input_chars': usage['input_chars'],
        'output_chars': usage['output_chars'],
        'cost_usd': round(cost, 6),
    }
    records.append(record)

    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, ensure_ascii=False, indent=2)

    total_tokens_in = sum(r['input_tokens'] for r in records)
    total_tokens_out = sum(r['output_tokens'] for r in records)
    total_cost = sum(r['cost_usd'] for r in records)

    print(f"  本视频 Gemini 用量：输入 {usage['input_tokens']} tokens / "
          f"输出 {usage['output_tokens']} tokens，约 ${cost:.4f}")
    print(f"  累计（共{len(records)}个视频）：输入 {total_tokens_in} tokens / "
          f"输出 {total_tokens_out} tokens，约 ${total_cost:.4f}")


# ========== 第三步：TTS合成 ==========
def get_audio_duration(path):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', path],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        creationflags=_NO_WINDOW
    )
    if not result.stdout:
        raise RuntimeError(f"ffprobe未返回结果（returncode={result.returncode}）：{result.stderr[-500:]}")
    info = json.loads(result.stdout)
    return float(info['format']['duration'])


def _add_rates(base_pct: int, delta_pct: int) -> str:
    """把基准速率和微调增量相加，返回 edge-tts rate 字符串，如 '+25%'。"""
    total = base_pct + delta_pct
    total = max(-50, min(100, total))
    return f"+{total}%" if total >= 0 else f"{total}%"


async def synthesize_segment(seg, voice=TTS_VOICE, tts_cache=None, title=None, base_rate_pct=0):
    """
    base_rate_pct: 整体基准语速偏移量（整数百分比，如 +20 或 -10），
                   由客户端根据原视频字数/秒算出，是全视频的"马拉松配速"。
                   每句在此基础上再微调（±30%以内）以贴合本句时间窗。
    """
    text = seg['translation']
    duration = seg['duration']
    if not text or not text.strip():
        return None
    audio_path = os.path.join(TEMP_DIR, f"seg_{int(seg['start']*1000)}.mp3")

    base_rate_str = _add_rates(base_rate_pct, 0)

    if tts_cache is not None and os.path.exists(audio_path):
        cached = tts_cache.get(audio_path)
        if (cached and cached.get('text') == text
                and cached.get('voice') == voice
                and cached.get('base_rate_pct') == base_rate_pct):
            seg['audio_path'] = audio_path
            seg['_tts_cache_hit'] = True
            return audio_path
        else:
            try:
                os.remove(audio_path)
            except Exception:
                pass

    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(text, voice, rate=base_rate_str, proxy=PROXY)
            await communicate.save(audio_path)
            break
        except Exception as e:
            if attempt == 2:
                print(f"\n  警告：片段合成失败，跳过。({e})")
                return None
            await asyncio.sleep(2)

    if not os.path.exists(audio_path):
        return None

    # 每句微调：若实际时长 > 时间窗，在基准速率上叠加加速
    actual_duration = get_audio_duration(audio_path)
    if actual_duration > duration * 0.95 and duration > 0:
        delta = min(int((actual_duration / duration - 1) * 100), 30)
        if delta > 3:
            adj_rate_str = _add_rates(base_rate_pct, delta)
            for attempt in range(3):
                try:
                    communicate = edge_tts.Communicate(
                        text, voice, rate=adj_rate_str, proxy=PROXY)
                    await communicate.save(audio_path)
                    break
                except:
                    await asyncio.sleep(2)

    seg['audio_path'] = audio_path
    # 记录最终实际 TTS 时长，供客户端计算视频减速比
    final_dur = get_audio_duration(audio_path)
    if final_dur:
        seg['tts_duration'] = final_dur
    if tts_cache is not None:
        tts_cache[audio_path] = {'text': text, 'voice': voice, 'base_rate_pct': base_rate_pct}
    return audio_path


async def synthesize_all(segments, voice=TTS_VOICE, title=None, base_rate_pct=0):
    semaphore = asyncio.Semaphore(3)
    valid_segments = [s for s in segments if 'translation' in s]

    tts_cache_path = os.path.join(TEMP_DIR, 'tts_cache.json')
    tts_cache = {}
    if os.path.exists(tts_cache_path):
        with open(tts_cache_path, 'r', encoding='utf-8') as f:
            tts_cache = json.load(f)

    total = len(valid_segments)
    done = 0
    last_pct = -1

    async def run_with_sem(seg, pbar):
        nonlocal done, last_pct
        async with semaphore:
            seg_voice = seg.get('voice') or voice
            await synthesize_segment(seg, seg_voice, tts_cache, title, base_rate_pct)
            pbar.update(1)
            done += 1
            pct = done * 100 // total if total else 100
            if pct >= last_pct + 10 or done == total:
                last_pct = pct
                log_event(f"合成配音进度：{done}/{total}（{pct}%）", title)

    with tqdm(total=total, desc="合成配音", unit="条") as pbar:
        await asyncio.gather(*[run_with_sem(seg, pbar) for seg in valid_segments])

    with open(tts_cache_path, 'w', encoding='utf-8') as f:
        json.dump(tts_cache, f, ensure_ascii=False, indent=2)

    cache_hits = sum(1 for s in valid_segments if s.get('_tts_cache_hit'))
    if cache_hits:
        log_event(f"配音缓存命中 {cache_hits}/{len(valid_segments)} 条", title)

    return segments


# ========== ASR（音频识别）：用于重新分割被合并的字幕行 ==========
def recognize_segment(audio_path, seg):
    """
    对配音 MP3 做 ASR 识别，返回字级时间戳。
    然后按原始字幕的字数（seg['parts']）拆割，恢复各行的准确起终点。

    返回：[{'start': ..., 'end': ..., 'text': ...}, ...]
         与 seg['parts'] 一一对应，用 ASR 时间戳重新定位。
    """
    if not FASTER_WHISPER_AVAILABLE or not seg.get('parts'):
        return None

    try:
        model = get_whisper_model()
        # Whisper 返回：[{'id': ..., 'start': ..., 'end': ..., 'text': ...}, ...]
        segments, info = model.transcribe(audio_path, language='zh', word_level=False)
        asr_segs = list(segments)

        if not asr_segs:
            return None

        # 拿到第一段和最后一段的时间范围
        asr_start = asr_segs[0]['start']
        asr_end = asr_segs[-1]['end']

        # 把 ASR 识别的字符串拼接，和原配音文本对比
        asr_text = ''.join(s['text'] for s in asr_segs)
        config_text = seg.get('text', '')

        # 根据原始行的字数来切割 ASR 时间戳
        # 假设每个字的朗读时间均匀分布在 [asr_start, asr_end]
        result = []
        total_chars = len(config_text)
        if total_chars > 0:
            time_per_char = (asr_end - asr_start) / total_chars
            char_pos = 0

            for part in seg.get('parts', []):
                part_len = len(part.get('text', ''))
                part_start = asr_start + char_pos * time_per_char
                part_end = asr_start + (char_pos + part_len) * time_per_char
                result.append({
                    'start': max(part_start, asr_start),
                    'end': min(part_end, asr_end),
                    'text': part['text']
                })
                char_pos += part_len

        return result if result else None
    except Exception as e:
        print(f'[ASR] 识别失败（{audio_path}）：{e}')
        return None


async def add_asr_segments(segments):
    """
    对所有配音段做 ASR 识别，添加 asr_segments 字段。
    在后台异步调用时，直接修改 segments 列表的元素（无需返回值）。
    """
    if not FASTER_WHISPER_AVAILABLE:
        return

    for seg in segments:
        if 'audio_path' not in seg or not os.path.exists(seg['audio_path']):
            continue
        asr_result = recognize_segment(seg['audio_path'], seg)
        if asr_result:
            seg['asr_segments'] = asr_result


# ========== 第四步：生成配音音频 ==========
def ffmpeg_filter_path(path):
    """转义路径供 ffmpeg filter 中的 amovie 使用（避免数百个 -i 撑爆命令行）。"""
    path = os.path.abspath(path).replace('\\', '/')
    if path.startswith('//?/'):
        path = path[4:]
    path = path.replace(':', '\\:').replace("'", "\\'")
    return f"'{path}'"


def build_delayed_tts_filters(segments):
    """用 amovie 在滤镜里读入各配音片段，命令行只需 0~1 个 -i。"""
    filter_parts = []
    labels = []
    n = 0
    for seg in segments:
        ap = seg.get('audio_path')
        if not ap or not path_exists(ap):
            continue
        delay_ms = int(seg['start'] * 1000)
        label = f'tts{n}'
        filter_parts.append(
            f'amovie={ffmpeg_filter_path(ap)},asetpts=PTS-STARTPTS,'
            f'adelay={delay_ms}|{delay_ms}[{label}]'
        )
        labels.append(f'[{label}]')
        n += 1
    return filter_parts, labels


def _run_ffmpeg(cmd, stderr_path, progress_label=None, total_duration=0):
    stderr_file = open(win_path(stderr_path), 'w', encoding='utf-8', errors='replace')
    try:
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=stderr_file, text=True,
            creationflags=_NO_WINDOW,
        )
    except OSError as e:
        stderr_file.close()
        raise RuntimeError(f"启动 ffmpeg 失败（{e}）") from e
    last_pct = -1
    current_time = 0
    if process.stdout and progress_label and total_duration:
        log_event(f"{progress_label}（共约{int(total_duration)}秒）...")
        for line in process.stdout:
            if line.startswith('out_time_ms='):
                try:
                    ms = int(line.split('=')[1])
                    new_time = min(ms // 1000000, int(total_duration))
                    if new_time > current_time:
                        current_time = new_time
                        pct = current_time * 100 // total_duration if total_duration else 100
                        if pct >= last_pct + 10:
                            last_pct = pct
                            log_event(f"{progress_label}进度：{pct}%")
                except Exception:
                    pass
    process.wait()
    stderr_file.close()
    if process.returncode != 0:
        with open(stderr_path, 'r', encoding='utf-8', errors='replace') as f:
            stderr = f.read()
        raise RuntimeError(f"ffmpeg 失败（返回码{process.returncode}）：\n{stderr[-2000:]}")


def export_audio(segments, audio_source, output_path):
    """
    生成配音音频：把所有配音片段按各自的时间戳混合，
    如果有原始音频(audio_source)则以小音量铺在底层作为背景。
  配音片段通过 amovie 写入滤镜脚本，避免大量 -i 导致 Windows 命令行过长。
    """
    has_orig = bool(audio_source and path_exists(audio_source) and _bg_mix_volume() > 0)
    filter_parts, labels = build_delayed_tts_filters(segments)
    if not labels:
        raise RuntimeError("没有可用的配音片段")

    tts_chain = ''.join(labels)
    if has_orig:
        mix_inputs = (
            f'[0:a]volume={_bg_mix_volume()}[orig];{tts_chain}'
            f'[orig]amix=inputs={len(labels) + 1}:normalize=1[aout]'
        )
    elif len(labels) == 1:
        mix_inputs = f'{labels[0]}anull[aout]'
    else:
        mix_inputs = f'{tts_chain}amix=inputs={len(labels)}:normalize=0[aout]'

    filter_complex = ';'.join(filter_parts) + ';' + mix_inputs
    filter_file = os.path.join(TEMP_DIR, 'filter_complex_audio.txt')
    with open(win_path(filter_file), 'w', encoding='utf-8') as f:
        f.write(filter_complex)

    total_duration = max(
        (seg['start'] + seg.get('duration', 0)) for seg in segments
        if seg.get('audio_path') and path_exists(seg['audio_path'])
    )

    input_args = ['-i', win_path(audio_source)] if has_orig else []
    cmd = ['ffmpeg', '-y'] + input_args + [
        '-filter_complex_script', win_path(filter_file),
        '-map', '[aout]',
        '-c:a', 'aac',
        '-progress', 'pipe:1',
        '-nostats',
        win_path(output_path),
    ]
    stderr_path = os.path.join(TEMP_DIR, 'ffmpeg_audio_stderr.log')
    log_event(f"混音 {len(labels)} 条配音片段" + (" + 背景原声" if has_orig else ""))
    _run_ffmpeg(cmd, stderr_path, '生成配音音频', total_duration)


# ========== 第五步：合并视频（如找到匹配的原视频）==========
def merge_audio_video(video_path, segments, output_path, srt_path=None, subtitle_mode='none'):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', win_path(video_path)],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        creationflags=_NO_WINDOW
    )
    if not result.stdout:
        raise RuntimeError(f"ffprobe未返回结果（returncode={result.returncode}）：{result.stderr[-500:]}")
    total_duration = float(json.loads(result.stdout)['format']['duration'])

    delay_filters, labels = build_delayed_tts_filters(segments)
    if not labels:
        raise RuntimeError("没有可用的配音片段")

    tts_chain = ''.join(labels)
    if _bg_mix_volume() > 0:
        mix_inputs = (
            f'[0:a]volume={_bg_mix_volume()}[orig];{tts_chain}'
            f'[orig]amix=inputs={len(labels) + 1}:normalize=1[aout]'
        )
    elif len(labels) == 1:
        mix_inputs = f'{labels[0]}anull[aout]'
    else:
        mix_inputs = f'{tts_chain}amix=inputs={len(labels)}:normalize=0[aout]'

    filter_complex = ';'.join(delay_filters) + ';' + mix_inputs
    filter_file = os.path.join(TEMP_DIR, 'filter_complex.txt')
    with open(win_path(filter_file), 'w', encoding='utf-8') as f:
        f.write(filter_complex)

    input_args = ['-i', win_path(video_path)]
    out_path = win_path(output_path)
    ff_script = win_path(filter_file)
    log_event(f"合并视频：混音 {len(labels)} 条配音片段")

    if subtitle_mode == 'soft' and srt_path:
        input_args += ['-i', win_path(srt_path)]
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-filter_complex_script', ff_script,
            '-map', '0:v',
            '-map', '[aout]',
            '-map', '1:s',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-c:s', 'mov_text',
            '-progress', 'pipe:1',
            '-nostats',
            out_path,
        ]
    elif subtitle_mode == 'hard' and srt_path:
        srt_escaped = ffmpeg_filter_path(srt_path)
        with open(ff_script, 'a', encoding='utf-8') as f:
            f.write(
                f";[0:v]subtitles={srt_escaped}:"
                f"force_style='FontName={SUBTITLE_FONT}'[vout]"
            )
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-filter_complex_script', ff_script,
            '-map', '[vout]',
            '-map', '[aout]',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-progress', 'pipe:1',
            '-nostats',
            out_path,
        ]
    else:
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-filter_complex_script', ff_script,
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-progress', 'pipe:1',
            '-nostats',
            out_path,
        ]

    stderr_path = os.path.join(TEMP_DIR, 'ffmpeg_stderr.log')
    _run_ffmpeg(cmd, stderr_path, '合并音视频', total_duration)
    if not path_exists(output_path):
        raise RuntimeError(f"ffmpeg未报错但输出文件未生成：{output_path}")


# ========== 单视频断点续做 ==========
_PIPELINE_STEPS = (
    'subtitles', 'translated', 'synthesized', 'srt',
    'matched', 'audio_ready', 'exported', 'meta', 'merged',
)
_STEP_NAMES = {
    'subtitles': '第1步-获取字幕',
    'translated': '第2步-翻译',
    'synthesized': '第3步-合成配音',
    'srt': '第3.5步-生成字幕文件',
    'matched': '第4步-匹配原视频',
    'audio_ready': '第5步-准备背景音',
    'exported': '第6步-生成配音音频',
    'meta': '第7步-投稿信息',
    'merged': '第8步-合并视频',
}


def _checkpoint_file():
    return os.path.join(TEMP_DIR, 'pipeline_checkpoint.json')


def _step_index(step):
    try:
        return _PIPELINE_STEPS.index(step)
    except ValueError:
        return -1


def is_step_completed(state, step):
    if not state or not state.get('step'):
        return False
    if step == 'srt' and SUBTITLE_MODE == 'none':
        return _step_index(state['step']) >= _step_index('synthesized')
    return _step_index(state['step']) >= _step_index(step)


def load_pipeline_checkpoint(output_path, input_src, voice, target_lang):
    path = _checkpoint_file()
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            cp = json.load(f)
    except Exception:
        return None
    keys = ('output_path', 'input_src', 'voice', 'target_lang',
            'subtitle_mode', 'bilingual', 'vocal_separation')
    current = {
        'output_path': output_path,
        'input_src': input_src,
        'voice': voice,
        'target_lang': target_lang,
        'subtitle_mode': SUBTITLE_MODE,
        'bilingual': BILINGUAL_SUBTITLE,
        'vocal_separation': VOCAL_SEPARATION_ENABLED,
    }
    if any(cp.get(k) != v for k, v in current.items()):
        return None
    if cp.get('step') not in _PIPELINE_STEPS:
        return None
    return cp


def save_pipeline_checkpoint(state):
    with open(_checkpoint_file(), 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def clear_pipeline_checkpoint():
    path = _checkpoint_file()
    if os.path.exists(path):
        try:
            os.remove(path)
        except Exception:
            pass


def mark_pipeline_step(state, step, **extra):
    state['step'] = step
    state.update(extra)
    save_pipeline_checkpoint(state)


# ========== 主流程 ==========
async def dub_video(input_src, output_path, target_lang=TARGET_LANG, title='untitled', voice=TTS_VOICE):
    merged_name = sanitize_filename(f"{title}_dubbed", max_len=50) + '.mp4'
    video_output_path = os.path.join(OUTPUT_DIR, merged_name)

    cp = load_pipeline_checkpoint(output_path, input_src, voice, target_lang)
    if cp and cp.get('step') == 'merged' and path_exists(video_output_path):
        print(f"\n⏭ 已完成合并视频，跳过：{video_output_path}")
        clear_pipeline_checkpoint()
        return
    if cp is None and path_exists(output_path + '.m4a') and path_exists(output_path + '.meta.json'):
        if not video_match_needed(output_path, title):
            print(f"\n⏭ 已存在配音音频 {output_path}.m4a，跳过该视频（如需重新生成请先删除该文件）")
            return

    state = cp or {
        'output_path': output_path,
        'input_src': input_src,
        'title': title,
        'voice': voice,
        'target_lang': target_lang,
        'subtitle_mode': SUBTITLE_MODE,
        'bilingual': BILINGUAL_SUBTITLE,
        'vocal_separation': VOCAL_SEPARATION_ENABLED,
    }
    if cp:
        done = _STEP_NAMES.get(cp['step'], cp['step'])
        print(f"\n⏩ 检测到未完成任务（已完成至【{done}】），从断点续做...")

    segments = state.get('segments') or []
    source_lang = state.get('source_lang', '英文')
    srt_path = state.get('srt_path')
    video_match = state.get('video_match')
    audio_source = state.get('audio_source')

    if not is_step_completed(state, 'subtitles'):
        print(f"\n▶ 第1步：获取字幕...")
        segments, source_lang = get_subtitles(input_src)
        print(f"  共获取 {len(segments)} 条字幕（原文语言：{source_lang}）")
        segments = dedupe_rolling_overlap(segments)
        segments = estimate_durations(segments)
        segments = group_into_sentences(segments, split_gap=1.0)
        print(f"  按句分组后 {len(segments)} 组")
        mark_pipeline_step(state, 'subtitles', segments=segments, source_lang=source_lang)
    else:
        print(f"\n⏩ 跳过第1步：字幕已缓存（{len(segments)} 组）")

    if not is_step_completed(state, 'translated'):
        print(f"\n▶ 第2步：翻译字幕...")
        usage = {'input_tokens': 0, 'output_tokens': 0, 'input_chars': 0, 'output_chars': 0}
        segments = translate_segments(segments, target_lang, usage, title, source_lang)
        log_usage(title, usage)
        mark_pipeline_step(state, 'translated', segments=segments, source_lang=source_lang)
    else:
        print(f"\n⏩ 跳过第2步：翻译已缓存")

    if not is_step_completed(state, 'synthesized'):
        print(f"\n▶ 第3步：合成配音...（音色：{voice}）")
        segments = await synthesize_all(segments, voice, title)
        mark_pipeline_step(state, 'synthesized', segments=segments)
    else:
        print(f"\n⏩ 跳过第3步：配音片段已缓存")

    if SUBTITLE_MODE != 'none':
        if not is_step_completed(state, 'srt'):
            print(f"\n▶ 第3.5步：生成字幕文件...")
            srt_path = os.path.join(TEMP_DIR, 'subtitles.srt')
            export_srt(segments, srt_path, bilingual=BILINGUAL_SUBTITLE)
            print(f"  字幕文件已生成：{srt_path}")
            if SUBTITLE_MODE == 'hard':
                print("  提示：硬字幕烧录耗时与视频长度成正比（通常几分钟到十几分钟）")
            elif SUBTITLE_MODE == 'soft':
                print("  提示：软字幕几乎不增加耗时，但能否显示/开关取决于播放软件，"
                      "部分网站（如B站）上传后不会显示该字幕轨道")
            mark_pipeline_step(state, 'srt', segments=segments, srt_path=srt_path)
        else:
            print(f"\n⏩ 跳过第3.5步：字幕文件已缓存")
    else:
        srt_path = None

    if not is_step_completed(state, 'matched'):
        print(f"\n▶ 第4步：在原视频文件夹中查找匹配视频...")
        video_duration = segments[-1]['end'] if segments else 0
        video_match = find_matching_video([SOURCE_VIDEO_DIR, OUTPUT_DIR], title, video_duration)
        if video_match:
            print(f"  找到匹配视频：{video_match}（自带音频，最终混音将直接使用该视频的原声，无需单独下载）")
        mark_pipeline_step(state, 'matched', segments=segments, video_match=video_match)
    else:
        print(f"\n⏩ 跳过第4步：原视频匹配已缓存")
        if video_match:
            print(f"  使用已匹配视频：{video_match}")

    if not is_step_completed(state, 'audio_ready'):
        need_raw_audio = ORIGINAL_AUDIO_VOLUME > 0 or VOCAL_SEPARATION_ENABLED
        raw_audio = None
        if video_match:
            log_event("已找到本地匹配视频，最终混音将使用其自带音轨，无需下载原始音频", title)
            if need_raw_audio:
                try:
                    raw_audio = extract_audio_to_temp(video_match)
                except Exception as e:
                    log_event(f"从匹配视频提取背景音轨失败，将不使用原声背景：{e}", title)
                    raw_audio = None
        elif input_src.startswith('http'):
            if need_raw_audio:
                print(f"\n▶ 第5步：下载原始音频（用于混音背景音，体量小、风险低）...")
                audio_pattern = os.path.join(TEMP_DIR, 'source_audio')
                existing = glob.glob(audio_pattern + '.*')
                if existing:
                    raw_audio = existing[0]
                    log_event("原始音频已存在，使用缓存，跳过下载", title)
                else:
                    try:
                        ydl_opts = {
                            'format': 'bestaudio/best',
                            'outtmpl': audio_pattern + '.%(ext)s',
                        }
                        apply_cookies(ydl_opts)
                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            ydl.download([input_src])
                        existing = glob.glob(audio_pattern + '.*')
                        raw_audio = existing[0] if existing else None
                    except Exception as e:
                        log_event(f"原始音频下载失败，配音音频将不含背景原声：{e}", title)
                        raw_audio = None
            else:
                print(f"\n▶ 第5步：跳过背景音（原声已静音且未启用人声分离）")
        else:
            raw_audio = input_src if need_raw_audio else None
        audio_source, bg_mix_vol = prepare_background_track(raw_audio, title)
        mark_pipeline_step(
            state, 'audio_ready',
            segments=segments,
            audio_source=audio_source,
            background_mix_volume=bg_mix_vol,
            raw_audio_source=raw_audio,
        )
    else:
        print(f"\n⏩ 跳过第5步：背景音已就绪")

    global CURRENT_BG_MIX_VOLUME
    CURRENT_BG_MIX_VOLUME = state.get(
        'background_mix_volume',
        ORIGINAL_AUDIO_VOLUME if audio_source else 0,
    )

    if not is_step_completed(state, 'exported'):
        print(f"\n▶ 第6步：生成配音音频...")
        audio_output_path = output_path + '.m4a'
        export_audio(segments, audio_source, audio_output_path)
        print(f"  配音音频已生成：{audio_output_path}")
        mark_pipeline_step(state, 'exported', segments=segments)
    else:
        print(f"\n⏩ 跳过第6步：配音音频已生成")

    if srt_path and not path_exists(output_path + '.srt'):
        srt_output_path = output_path + '.srt'
        shutil.copyfile(win_path(srt_path), win_path(srt_output_path))
        srt_path = srt_output_path

    if not is_step_completed(state, 'meta'):
        print(f"\n▶ 第7步：提取并翻译视频简介中的时间轴章节...")
        bilibili_desc = build_bilibili_description(input_src, title)
        if bilibili_desc:
            with open(win_path(output_path + '.desc.txt'), 'w', encoding='utf-8') as f:
                f.write(bilibili_desc)
            log_event(f"已提取并翻译{bilibili_desc.count(chr(10))}行简介/章节信息，供上传B站时使用", title)
        else:
            log_event("未在视频简介中找到时间轴章节，跳过", title)

        bilibili_meta = build_bilibili_meta(input_src, translate_title(title))
        with open(win_path(output_path + '.meta.json'), 'w', encoding='utf-8') as f:
            json.dump(bilibili_meta, f, ensure_ascii=False, indent=2)
        log_event(f"B站投稿信息：标题「{bilibili_meta['title']}」，分区「{bilibili_meta['category']}」", title)
        mark_pipeline_step(state, 'meta', segments=segments)
    else:
        print(f"\n⏩ 跳过第7步：投稿信息已生成")

    if video_match:
        if not is_step_completed(state, 'merged'):
            print(f"  找到匹配视频：{video_match}")
            merge_audio_video(video_match, segments, video_output_path, srt_path, SUBTITLE_MODE)
            print(f"\n✅ 完成！已与原视频合并：{video_output_path}")
            mark_pipeline_step(state, 'merged', segments=segments)
        else:
            print(f"\n⏩ 跳过第8步：合并视频已完成")
    else:
        video_duration = segments[-1]['end'] if segments else 0
        log_event(
            f"在 {SOURCE_VIDEO_DIR} 中未找到时长匹配的原视频"
            f"（约{video_duration:.0f}秒），仅生成配音音频，请自行与视频合并", title)
        print(f"\n🟧 部分完成！未找到匹配视频，配音音频：{output_path}.m4a")

    clear_pipeline_checkpoint()


def video_match_needed(output_path, title):
    """无断点且仅有 m4a/meta 时，判断是否还需合并视频。"""
    merged_name = sanitize_filename(f"{title}_dubbed", max_len=50) + '.mp4'
    return not path_exists(os.path.join(OUTPUT_DIR, merged_name))


_WIN_PATH_LIMIT = 240


def win_path(path):
    """Windows 下统一加长路径前缀，避免 emoji/超长路径触发 WinError 206。"""
    if not path or os.name != 'nt':
        return path
    path = os.path.normpath(path)
    abs_path = os.path.abspath(path)
    if abs_path.startswith('\\\\?\\'):
        return abs_path
    return '\\\\?\\' + abs_path


def path_exists(path):
    return os.path.exists(win_path(path))


def sanitize_filename(name, max_len=80):
    if not name:
        return 'untitled'
    if isinstance(name, bytes):
        name = name.decode('utf-8', errors='replace')
    name = name.encode('utf-8', errors='replace').decode('utf-8')
    name = re.sub(r'[\x00-\x1f]', '', name)
    # 文件名只保留安全字符，去掉 emoji 等易触发 Windows 路径问题的符号
    name = ''.join(
        c for c in name
        if c.isalnum() or c in ' -_+.,()' or '\u4e00' <= c <= '\u9fff'
    )
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    name = re.sub(r'_+', '_', name)
    name = re.sub(r'\s+', ' ', name).strip(' .')
    if not name:
        return 'untitled'
    return name[:max_len].rstrip(' .') or 'untitled'


def extract_audio_to_temp(media_path, dest_path=None):
    """把视频/音频文件提取到 temp 下的短路径，避免 ffmpeg 直接读取超长原视频路径。"""
    dest_path = dest_path or os.path.join(TEMP_DIR, 'source_audio.m4a')
    if path_exists(dest_path):
        return dest_path
    os.makedirs(os.path.dirname(dest_path) or '.', exist_ok=True)
    cmd = [
        'ffmpeg', '-y', '-i', win_path(media_path),
        '-vn', '-ac', '2', '-c:a', 'aac', win_path(dest_path),
    ]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
        creationflags=_NO_WINDOW,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr[-1500:] or 'ffmpeg 提取音轨失败')
    return dest_path


def _bg_mix_volume():
    if CURRENT_BG_MIX_VOLUME is not None:
        return CURRENT_BG_MIX_VOLUME
    return ORIGINAL_AUDIO_VOLUME


def _detect_nvidia_gpu():
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, encoding='utf-8', errors='replace',
            timeout=5, creationflags=_NO_WINDOW,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().splitlines()[0].strip()
    except Exception:
        pass
    return None


def _detect_directml_available():
    try:
        import onnxruntime as ort
        return 'DmlExecutionProvider' in ort.get_available_providers()
    except Exception:
        return False


def get_vocal_separation_plan():
    """
    商业版人声分离分流：
    - 有独显（NVIDIA CUDA 或 DirectML）→ 本地 GPU 加速
    - 无独显且配置了云端地址 → 云端 API
    - 无独显且无云端 → CPU 本地（慢，约 1～2× 实时）
    本地免费版勾选时返回 unavailable。
    """
    if not VOCAL_SEPARATION_ENABLED:
        return None
    if USER_TIER not in ('premium', 'commercial'):
        return {'mode': 'unavailable', 'reason': 'local_free'}
    gpu = _detect_nvidia_gpu()
    if gpu:
        return {'mode': 'gpu_local', 'provider': 'cuda', 'device': gpu}
    if _detect_directml_available():
        return {'mode': 'gpu_local', 'provider': 'directml', 'device': 'DirectML'}
    if VOCAL_SEPARATION_CLOUD_URL.strip():
        return {'mode': 'cloud', 'endpoint': VOCAL_SEPARATION_CLOUD_URL.strip()}
    return {'mode': 'cpu_local'}


def _instrumental_cache_path(raw_audio_path):
    base = os.path.splitext(os.path.basename(raw_audio_path))[0]
    return os.path.join(TEMP_DIR, f'{base}_instrumental.m4a')


def _run_vocal_separation_cpu(raw_audio_path):
    """商业版无独显回退：CPU + MDX（慢）。接入 venv_sep/_sep_worker。"""
    out_wav = os.path.join(TEMP_DIR, 'instrumental.wav')
    worker = os.path.join(os.path.dirname(__file__), '_sep_worker.py')
    venv_py = os.path.join(os.path.dirname(__file__), 'venv_sep', 'Scripts', 'python.exe')
    if not os.path.isfile(venv_py):
        venv_py = 'python'
    model_dir = os.path.join(os.environ.get('TEMP', '.'), 'audio-separator-models')
    cmd = [venv_py, worker, raw_audio_path, out_wav, model_dir]
    result = subprocess.run(
        cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
        creationflags=_NO_WINDOW,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or '人声分离失败')[-2000:])
    dest = _instrumental_cache_path(raw_audio_path)
    if out_wav.lower().endswith('.wav'):
        subprocess.run(
            ['ffmpeg', '-y', '-i', win_path(out_wav), '-c:a', 'aac', win_path(dest)],
            capture_output=True, creationflags=_NO_WINDOW, check=True,
        )
        return dest
    return out_wav


def _run_vocal_separation_gpu(raw_audio_path, plan):
    """商业版有独显：GPU 加速分离（待接入 CUDA/DirectML EP）。"""
    raise NotImplementedError(
        f"GPU 人声分离待接入（{plan.get('provider')} / {plan.get('device')}）"
    )


def _run_vocal_separation_cloud(raw_audio_path, plan):
    """商业版无独显：上传至云端分离服务（待接入）。"""
    raise NotImplementedError(
        f"云端人声分离待接入（{plan.get('endpoint')}）"
    )


def run_vocal_separation(raw_audio_path, plan, title=''):
    cached = _instrumental_cache_path(raw_audio_path)
    if path_exists(cached):
        log_event('使用已缓存的伴奏轨，跳过人声分离', title)
        return cached
    mode = plan['mode']
    if mode == 'gpu_local':
        log_event(
            f"商业版：检测到 {plan.get('device')}，使用 GPU（{plan.get('provider')}）做人声分离...",
            title,
        )
        out = _run_vocal_separation_gpu(raw_audio_path, plan)
    elif mode == 'cloud':
        log_event('商业版：无可用独显，使用云端人声分离...', title)
        out = _run_vocal_separation_cloud(raw_audio_path, plan)
    else:
        log_event(
            '商业版：无独显且未配置云端，使用 CPU 分离（预计约为音频时长的 1～2 倍）...',
            title,
        )
        out = _run_vocal_separation_cpu(raw_audio_path)
    return out


def prepare_background_track(raw_audio_path, title=''):
    """
    决定混音用的背景音轨与音量。
    返回 (path, volume)；path 为 None 或 volume 为 0 表示不铺背景。
    """
    if not raw_audio_path or not path_exists(raw_audio_path):
        return None, 0.0
    if ORIGINAL_AUDIO_VOLUME > 0:
        return raw_audio_path, ORIGINAL_AUDIO_VOLUME
    if not VOCAL_SEPARATION_ENABLED:
        return None, 0.0
    plan = get_vocal_separation_plan()
    if not plan or plan.get('mode') == 'unavailable':
        log_event(
            '已勾选「AI 人声分离」，当前为本地免费版，未执行分离。'
            '商业版方案：有独显→本地 GPU 加速；无独显→云端 API（或可选 CPU，较慢）。'
            '将仅输出中文配音。',
            title,
        )
        return None, 0.0
    try:
        inst = run_vocal_separation(raw_audio_path, plan, title)
        if inst and path_exists(inst):
            log_event('人声分离完成，将伴奏作为背景音混入', title)
            return inst, INSTRUMENTAL_BG_VOLUME
    except NotImplementedError as e:
        log_event(f'人声分离功能尚未接入：{e}', title)
    except Exception as e:
        log_event(f'人声分离失败，将仅输出配音：{e}', title)
    return None, 0.0


def max_basename_len(directory, extension='.desc.txt'):
    directory = os.path.abspath(directory)
    limit = _WIN_PATH_LIMIT if os.name == 'nt' else 200
    return max(30, limit - len(directory) - 1 - len(extension))


def build_output_stem(output_dir, index, title, suffix='_dubbed'):
    """生成适配 Windows 路径长度限制的输出文件主名，如 1-ShortTitle_dubbed。"""
    prefix = f'{index}-'
    max_stem = max_basename_len(output_dir, extension='.desc.txt')
    max_title = min(32, max(12, max_stem - len(prefix) - len(suffix)))
    safe = sanitize_filename(title, max_len=max_title)
    return f'{prefix}{safe}{suffix}'


def build_merge_output_path(audio_dir, title):
    """批量/预览合并时生成不超过路径上限的输出视频路径。"""
    max_out = max_basename_len(audio_dir, '_dubbed.mp4')
    safe_title = sanitize_filename(title, max_len=max(15, max_out - len('_dubbed.mp4')))
    return os.path.join(audio_dir, f"{safe_title}_dubbed.mp4")


def merged_title_key(name, num_words=5):
    """生成用于"是否已合并过"去重比对的标题键：去掉 _dubbed 后缀，
    丢弃数字/符号/emoji，取前 num_words 个"词"（小写）。
    "词"定义：所有 Unicode 字母语言（英/俄/阿拉伯/中日韩等）的连续字母串都算一个词，
    任何数字/标点/emoji 当分隔符丢弃。
    这样即便标题在两次下载间增删了 emoji/引号/空格/序号，前几词一致就视为同一个视频。"""
    base = os.path.splitext(name)[0]
    base = re.sub(r'_dubbed$', '', base, flags=re.IGNORECASE).lower()
    # \w 在 Python re 中默认匹配 Unicode 字母+数字+下划线；
    # 用 [^\W\d_]+ 去掉数字和下划线，只保留纯字母（各语种均支持）
    words = re.findall(r'[^\W\d_]+', base)
    return ' '.join(words[:num_words])


def _title_word_overlap(a, b):
    """计算两个标题去重后共有多少相同词（用于无法生成标题键时的兜底匹配）"""
    wa = set(re.findall(r'[^\W\d_]+', a.lower()))
    wb = set(re.findall(r'[^\W\d_]+', b.lower()))
    if not wa or not wb:
        return 0
    return len(wa & wb) / max(len(wa), len(wb))


def find_existing_merged(audio_dir, title, duration=None):
    """在 audio_dir（仅主目录，不含"已上传"子文件夹）里查找是否已存在
    与该 title 对应的成品 *_dubbed.mp4。
    主判据：前5词标题键相同；键为空时（如纯emoji标题）用词重叠率兜底。
    若提供 duration，再要求成品时长相符（差值 ≤ max(10s, 5%)）。
    命中返回成品路径，否则 None。"""
    if not os.path.isdir(audio_dir):
        return None
    key = merged_title_key(title)
    title_clean = re.sub(r'_dubbed$', '', os.path.splitext(title)[0], flags=re.IGNORECASE)
    for f in os.listdir(audio_dir):
        if not re.search(r'_dubbed\.mp4$', f, re.IGNORECASE):
            continue
        if key:
            if merged_title_key(f) != key:
                continue
        else:
            # key 取不到（纯emoji/纯符号标题）：用词重叠率+时长双重验证
            overlap = _title_word_overlap(title_clean, f)
            if overlap < 0.6:
                continue
            if not duration:
                continue  # 无时长无法兜底，跳过
        # 标题匹配；如需时长验证再读这一个成品的时长
        if duration:
            try:
                v_dur = get_media_duration(os.path.join(audio_dir, f))
            except Exception:
                return os.path.join(audio_dir, f)  # 读不到时长就只按标题判已合并
            if abs(v_dur - duration) > max(10.0, duration * 0.05):
                continue
        return os.path.join(audio_dir, f)
    return None


def parse_playlist_link(url):
    """
    判断一个链接是否带有播放列表(list=...)参数。
    返回 (单视频链接, 播放列表链接) 或 (url, None) 如果不是播放列表链接。
    """
    m_list = re.search(r'[?&]list=([\w-]+)', url)
    if not m_list:
        return url, None
    playlist_url = f"https://www.youtube.com/playlist?list={m_list.group(1)}"
    m_v = re.search(r'[?&]v=([\w-]+)', url)
    if m_v:
        single_url = f"https://www.youtube.com/watch?v={m_v.group(1)}"
    else:
        single_url = re.sub(r'[?&]list=[\w-]+(&[\w-]+=[\w-]*)*', '', url)
    return single_url, playlist_url


def get_playlist_video_urls(playlist_url):
    """获取播放列表中所有视频的链接（按顺序）"""
    opts = {
        'quiet': True,
        'skip_download': True,
        'extract_flat': True,
        'playlistend': None,  # 获取播放列表中的所有视频
        'extractor_args': {'youtube': {'skip': ['webpage']}}  # 跳过网页解析，只用API
    }
    apply_cookies(opts)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(playlist_url, download=False)
    urls = []
    for entry in info.get('entries') or []:
        vid = entry.get('id')
        if vid:
            urls.append(f"https://www.youtube.com/watch?v={vid}")
    return urls


def get_video_description(src):
    """获取YouTube视频简介全文（"显示更多"里的完整内容），非URL或失败时返回空字符串"""
    if not src.startswith('http'):
        return ''
    try:
        opts = {'quiet': True, 'skip_download': True}
        apply_cookies(opts)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(src, download=False)
        return info.get('description') or ''
    except Exception:
        return ''


CHAPTER_LINE_RE = re.compile(r'^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$')


def extract_chapters(description):
    """从视频简介中提取"时间码 章节标题"格式的行，返回[(时间码, 标题), ...]"""
    chapters = []
    for line in description.splitlines():
        m = CHAPTER_LINE_RE.match(line.strip())
        if m:
            chapters.append((m.group(1), m.group(2).strip()))
    return chapters


def translate_title(title, target_lang=TARGET_LANG):
    """把视频标题翻译成目标语言，用于B站投稿标题；失败时返回原标题"""
    if not GEMINI_API_KEY:
        return title
    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        prompt = f"将这个视频标题翻译成{target_lang}，简洁自然，保持原意，只输出译文，不要解释：{title}"
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        result = (response.text or '').strip().strip('"\'')
        return result.splitlines()[0].strip() if result else title
    except Exception:
        return title


def translate_chapters(chapters, target_lang=TARGET_LANG):
    """把章节标题列表整体翻译成目标语言，返回[(时间码, 译文标题), ...]；失败时返回原文标题"""
    if not chapters:
        return []
    if not GEMINI_API_KEY:
        return chapters

    titles_block = '\n'.join(f"{i+1}|{title}" for i, (_, title) in enumerate(chapters))
    prompt = f"""将以下视频章节标题翻译成{target_lang}，简洁自然，保持原意。
每行格式为：序号|标题

{titles_block}

只输出翻译结果，格式：序号|译文，每行一条，与输入逐行对应"""

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        translated = {}
        for line in (response.text or '').splitlines():
            m = re.match(r'^(\d+)\|(.+)$', line.strip())
            if m:
                translated[int(m.group(1))] = m.group(2).strip()
        return [
            (ts, translated.get(i + 1, title))
            for i, (ts, title) in enumerate(chapters)
        ]
    except Exception:
        return chapters


def build_bilibili_description(src, title):
    """
    获取YouTube视频简介，提取其中的章节时间轴并翻译成中文，
    生成可直接填入B站投稿"简介"的文本（时间轴+原视频标题），失败时返回空字符串。
    """
    description = get_video_description(src)
    chapters = extract_chapters(description)
    if not chapters:
        return ''
    chapters_zh = translate_chapters(chapters)
    lines = [f"《{title}》中文配音"]
    lines.append('')
    lines.append('时间轴：')
    for ts, ch_title in chapters_zh:
        lines.append(f"{ts} {ch_title}")
    return '\n'.join(lines)


# B站分区/标签配置
# 是否按"已开启充电设置"投稿（同时影响投稿时的充电设置和"情感"分区塔罗/占卜类视频
# 所归入的合集：开启则归入《充电塔罗占卜翻译&配音》，关闭则归入《免费塔罗占卜配音》）
BILIBILI_CHARGING_ENABLED = False


BILIBILI_CATEGORY_CONFIG = {
    '情感': {
        'tid': 21,
        'tags': ['塔罗', '占卜', '星座', '分手', '单身', '婚姻', '恋爱', '断联', '复合', '爱的100种表达方式'],
    },
    '知识': {
        'tid': 201,
        'tags': ['宇宙', '知识', '成长', '真相', '扬升', '地球', '研究', '生存', '人工智能', '万物研究所'],
    },
}


_SUBSCRIPTIONS_CACHE = None


def get_subscribed_channel_ids():
    """获取当前登录YouTube账号订阅的频道id集合（用cookies读取订阅页，失败返回空集合）"""
    global _SUBSCRIPTIONS_CACHE
    if _SUBSCRIPTIONS_CACHE is not None:
        return _SUBSCRIPTIONS_CACHE
    ids = set()
    try:
        opts = {'quiet': True, 'skip_download': True, 'extract_flat': True}
        apply_cookies(opts)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info('https://www.youtube.com/feed/subscriptions', download=False)
        for entry in info.get('entries') or []:
            cid = entry.get('channel_id') or entry.get('uploader_id')
            if cid:
                ids.add(cid)
        log_event(f"已读取订阅频道列表：{len(ids)}个")
    except Exception as e:
        log_event(f"读取订阅列表失败，跳过订阅判断：{e}")
    _SUBSCRIPTIONS_CACHE = ids
    return ids


def is_subscribed_channel(src):
    """判断src对应视频的频道是否在当前账号的订阅列表中"""
    if not src.startswith('http'):
        return False
    try:
        opts = {'quiet': True, 'skip_download': True, 'extract_flat': True}
        apply_cookies(opts)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(src, download=False)
        cid = info.get('channel_id') or info.get('uploader_id')
    except Exception:
        return False
    return bool(cid) and cid in get_subscribed_channel_ids()


def classify_bilibili_category(title_zh, src=''):
    """
    判断B站分区：
    - 情感：该视频所属频道是你已订阅的频道。
    - 知识：其它（未订阅频道）。
    """
    if src and is_subscribed_channel(src):
        return '情感'
    return '知识'


# 频道名缩略的特殊固定映射（"-"后的名词替换之前的整个频道名）
CHANNEL_TAG_OVERRIDES = {
    'c ниной': 'Nina',
    'white feather tarot': 'WF',
    'goddess energy': 'goddess',
    '222 tarot': '222',
    'red fairy tarot': 'RedFairy',
    '222 tarot readings': '222印',
    'anita sirene': '星女Anita',
}


def get_channel_short_tag(src):
    """
    获取YouTube频道名，按规则缩略成标题前缀【】里的内容：
    - 先查固定映射表（CHANNEL_TAG_OVERRIDES）
    - 否则用Gemini按规则提炼：去掉神秘/灵性/塔罗/占星/占卜/工作室等修饰词和先生/小姐等称呼，
      取其中最像"名字"的、较短的部分；非英文频道名先翻译成英文再按同样方式取。
    失败时返回空字符串。
    """
    if not src.startswith('http'):
        return ''
    try:
        opts = {'quiet': True, 'skip_download': True, 'extract_flat': True}
        apply_cookies(opts)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(src, download=False)
        channel = info.get('uploader') or info.get('channel') or ''
    except Exception:
        channel = ''
    if not channel:
        return ''

    override = CHANNEL_TAG_OVERRIDES.get(channel.strip().lower())
    if override:
        return override

    if not GEMINI_API_KEY:
        words = re.findall(r"[A-Za-z]+", channel)
        return min(words, key=len) if words else ''

    prompt = f"""把这个YouTube频道名缩略成一个简短的标签，用于B站标题前缀【】中。规则：
1. 如果频道名是英文且较长，去掉其中表示"神秘/灵性/塔罗/读牌/指导灵魂/精神/工作室/占星/星象/占卜/算命/神圣"等含义的词，
   保留剩下最像"名字"的那一部分（通常是专有名词），作为结果。
2. 如果频道名里有"先生/小姐/Mr/Miss/Ms"之类的称呼，去掉称呼，只保留名字本身。
3. 如果频道名不是英文，先翻译/转写成英文，再按上面规则取最像名字、较短的部分。
4. 结果应该简短（通常1个单词或一个简短的中英文组合）。

频道名：{channel}

只输出最终结果，不要解释、不要标点、不要引号。"""
    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
        result = (response.text or '').strip().strip('"\'').strip()
        result = result.splitlines()[0].strip() if result else ''
        # 去掉【】[]等可能混入的括号/标点，避免拼接成【xxx】时出现多余符号
        result = re.sub(r'[\[\]【】「」『』\(\)（）.。,，!！]', '', result).strip()
        return result
    except Exception:
        words = re.findall(r"[A-Za-z]+", channel)
        return min(words, key=len) if words else ''


def build_bilibili_meta(src, title_zh):
    """
    生成B站投稿用的元数据：标题前缀【频道英文短词】、分区tid、推荐标签。
    返回dict：{'title':..., 'tid':..., 'tags':[...], 'category':...}
    """
    channel_tag = get_channel_short_tag(src)
    category = classify_bilibili_category(title_zh, src)
    config = BILIBILI_CATEGORY_CONFIG[category]
    bilibili_title = f"【{channel_tag}】{title_zh}" if channel_tag else title_zh
    bilibili_title = bilibili_title[:80]
    return {
        'title': bilibili_title,
        'tid': config['tid'],
        'tags': config['tags'],
        'category': category,
        'channel_tag': channel_tag,
        'collection': suggest_bilibili_collection(category, channel_tag, bilibili_title),
        'source_url': src if isinstance(src, str) and src.startswith('http') else None,
    }


# 标题前缀【】内容 -> 合集名称的固定对应
CHANNEL_TAG_COLLECTIONS = {
    '星女Anita': '星女普通话合集',
    'Hawaii': '夏威夷小姐',
    'RedFairy': '【Redfairy】你注定遇到',
}

# 合集名称 -> (season_id, section_id)，从B站创作中心 /x2/creative/web/seasons 接口抓取
BILIBILI_COLLECTION_IDS = {
    '精神&身体健康': (8168390, 9077770),
    '【Redfairy】你注定遇到': (4001453, 4455649),
    '充电塔罗占卜翻译&配音': (4330928, 4819273),
    '免费励志&疗愈': (5029714, 5600670),
    '夏威夷小姐': (4722608, 5269714),
    '双生火焰': (4665217, 5208031),
    '免费塔罗占卜配音': (4331715, 4820111),
    '星女普通话合集': (4396344, 4889939),
}


def suggest_bilibili_collection(category, channel_tag, title_zh, charging_enabled=None):
    """
    根据分区/频道缩略名/标题/是否开启充电设置，给出投稿时"加入合集"的建议名称（仅作提示，
    B站合集需通过单独API在上传后添加，此处先生成建议供人工/后续自动化参考）。
    """
    if charging_enabled is None:
        charging_enabled = BILIBILI_CHARGING_ENABLED

    if category == '知识':
        return '精神&身体健康'

    if '双生火焰' in title_zh:
        return '双生火焰'

    if channel_tag in CHANNEL_TAG_COLLECTIONS:
        return CHANNEL_TAG_COLLECTIONS[channel_tag]

    if any(kw in title_zh for kw in ('塔罗', '占卜', '星座', '占星', '算命')):
        return '充电塔罗占卜翻译&配音' if charging_enabled else '免费塔罗占卜配音'

    return '免费励志&疗愈'


def get_video_id(src):
    """从YouTube链接提取视频ID，用于命名独立的临时文件夹（同一视频复用，不同视频不冲突）"""
    if src.startswith('http'):
        m = re.search(r'(?:youtu\.be/|shorts/|watch\?v=|/embed/)([\w-]{6,})', src)
        if m:
            return m.group(1)
        return sanitize_filename(src)[:40]
    return sanitize_filename(os.path.splitext(os.path.basename(src))[0])


def get_video_info(src):
    """返回 (标题, 时长秒)，用于命名输出文件和在原视频文件夹中匹配视频"""
    if src.startswith('http'):
        try:
            opts = {'quiet': True, 'skip_download': True}
            apply_cookies(opts)
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(src, download=False)
            return sanitize_filename(info.get('title', 'untitled')), info.get('duration') or 0
        except Exception:
            return 'untitled', 0
    title = sanitize_filename(os.path.splitext(os.path.basename(src))[0])
    try:
        return title, get_media_duration(src)
    except Exception:
        return title, 0


def get_media_duration(path):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', path],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        creationflags=_NO_WINDOW
    )
    if not result.stdout:
        raise RuntimeError(f"ffprobe未返回结果（returncode={result.returncode}）：{result.stderr[-500:]}")
    return float(json.loads(result.stdout)['format']['duration'])


VIDEO_EXTS = ('.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.ts', '.m4v')
AUDIO_EXTS = ('.m4a', '.mp3', '.aac', '.wav', '.opus', '.flac')


def _leading_number(name):
    """取文件名开头的序号（如 '14-...' -> '14'），没有则返回 None"""
    m = re.match(r'\s*(\d+)\s*[-_]', name)
    return m.group(1) if m else None


def find_matching_video(folders, title, duration):
    """在指定文件夹（一个或多个）里查找时长接近、文件名相似的原视频文件。

    匹配信号（任一足够强即接受，不再死卡文件名相似度）：
    - 时长接近（必要条件，差值 ≤ max(5s, 3%)）
    - 开头序号相同（如 14- 对 14-）——强信号，时长也对就直接采用
    - 文件名去emoji/序号后的相似度或词重叠度
    """
    if isinstance(folders, str):
        folders = [folders]
    if not duration:
        return None
    title_num = _leading_number(title)
    candidates = []
    for folder in folders:
        if not folder or not os.path.isdir(folder):
            continue
        for fname in os.listdir(folder):
            if not fname.lower().endswith(VIDEO_EXTS):
                continue
            if re.search(r'_dubbed\.\w+$', fname, re.IGNORECASE):
                continue  # 跳过之前批量合并产出的视频，避免自己匹配自己
            fpath = os.path.join(folder, fname)
            try:
                d = get_media_duration(fpath)
            except Exception:
                continue
            if abs(d - duration) > max(5.0, duration * 0.03):
                continue  # 时长不符，直接排除

            stem = os.path.splitext(fname)[0]
            file_num = _leading_number(stem)
            # 序号相同 + 时长相符：强匹配，给最高分
            num_match = title_num is not None and file_num == title_num

            fname_norm = re.sub(r'^\d+[-_]\s*', '', stem.lower())
            title_norm = re.sub(r'^\d+[-_]\s*', '', title.lower())
            seq_score = difflib.SequenceMatcher(None, fname_norm, title_norm).ratio()
            word_score = _title_word_overlap(fname_norm, title_norm)
            name_score = max(seq_score, word_score)

            if num_match:
                candidates.append((2.0 + name_score, fpath))  # 序号匹配优先级最高
            elif name_score >= 0.4:
                candidates.append((name_score, fpath))
            # 时长已对上但名字也对不上：留给上层"排除法兜底"处理

    if not candidates:
        return None
    candidates.sort(key=lambda x: -x[0])
    return candidates[0][1]


# ========== 批量合并：把output文件夹里的配音音频与原视频文件夹中的视频逐一匹配合并 ==========
def _stage_to_ascii_temp(src_path, suffix):
    """
    把带emoji/西里尔字母等特殊字符的文件，映射到 TEMP_DIR 下一个纯ASCII短名，
    供 ffmpeg 读取（ffmpeg 在 Windows 上无法可靠打开含emoji的路径）。
    优先用硬链接（同盘、零拷贝、瞬时），失败再退回复制。返回临时文件路径。
    """
    n = abs(hash(src_path)) % 1_000_000
    dest = os.path.join(TEMP_DIR, f'stage_{n}{suffix}')
    if path_exists(dest):
        try:
            os.remove(win_path(dest))
        except Exception:
            pass
    try:
        os.link(win_path(src_path), win_path(dest))  # 硬链接，瞬时
    except Exception:
        shutil.copyfile(win_path(src_path), win_path(dest))  # 跨盘等情况退回复制
    return dest


def mux_audio_into_video(video_path, audio_path, output_path, srt_path=None, subtitle_mode='none'):
    """把一个独立的配音音频文件直接混入视频（不依赖分段信息），可选附加字幕。

    关键：先把所有输入文件映射到纯ASCII短名的临时文件，ffmpeg只接触安全路径，
    输出也先写到ASCII临时文件，最后用Python（支持emoji路径）move到最终文件名。
    这样原视频文件名可以随便带emoji/俄文，不需要去掉表情。
    """
    v_ext = os.path.splitext(video_path)[1] or '.mp4'
    o_ext = os.path.splitext(output_path)[1] or '.mp4'
    stage_video = _stage_to_ascii_temp(video_path, v_ext)
    stage_audio = _stage_to_ascii_temp(audio_path, '.m4a')
    stage_out = os.path.join(TEMP_DIR, f'mux_out_{abs(hash(output_path)) % 1_000_000}{o_ext}')

    vpath, apath = win_path(stage_video), win_path(stage_audio)
    opath = win_path(stage_out)
    input_args = ['-i', vpath, '-i', apath]

    use_sub = srt_path and path_exists(srt_path)
    stage_srt = _stage_to_ascii_temp(srt_path, '.srt') if use_sub else None

    if subtitle_mode == 'soft' and use_sub:
        input_args += ['-i', win_path(stage_srt)]
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-map', '0:v', '-map', '1:a', '-map', '2',
            '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
            '-shortest', opath
        ]
    elif subtitle_mode == 'hard' and use_sub:
        srt_escaped = win_path(stage_srt).replace('\\', '/').replace(':', '\\:')
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-vf', f"subtitles='{srt_escaped}':force_style='FontName={SUBTITLE_FONT}'",
            '-map', '0:v', '-map', '1:a',
            '-c:v', 'libx264', '-c:a', 'copy',
            '-shortest', opath
        ]
    else:
        cmd = ['ffmpeg', '-y'] + input_args + [
            '-map', '0:v', '-map', '1:a',
            '-c:v', 'copy', '-c:a', 'copy',
            '-shortest', opath
        ]

    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace',
                            creationflags=_NO_WINDOW)
    # 清理临时输入
    for tmp in (stage_video, stage_audio, stage_srt):
        if tmp and path_exists(tmp):
            try:
                os.remove(win_path(tmp))
            except Exception:
                pass

    if result.returncode != 0:
        if path_exists(stage_out):
            try:
                os.remove(win_path(stage_out))
            except Exception:
                pass
        raise RuntimeError(f"合并失败：\n{result.stderr[-2000:]}")

    if not path_exists(stage_out):
        raise RuntimeError("合并失败：ffmpeg未报错但输出文件未生成")

    # 把ASCII临时输出move到最终（可能含emoji的）文件名
    if path_exists(output_path):
        try:
            os.remove(win_path(output_path))
        except Exception:
            pass
    shutil.move(win_path(stage_out), win_path(output_path))


def list_video_candidates(audio_dir=None, video_dir=None):
    """列出 source_videos 和 output 里可用的原视频文件名（排除 _dubbed 成品和子文件夹）"""
    audio_dir = audio_dir or OUTPUT_DIR
    video_dir = video_dir or SOURCE_VIDEO_DIR
    names = []
    for folder in (video_dir, audio_dir):
        if not folder or not os.path.isdir(folder):
            continue
        for fname in os.listdir(folder):
            fpath = os.path.join(folder, fname)
            if os.path.isdir(fpath):
                continue  # 跳过子文件夹（含"已上传"）
            if not fname.lower().endswith(VIDEO_EXTS):
                continue
            if re.search(r'_dubbed\.\w+$', fname, re.IGNORECASE):
                continue  # 跳过已合并成品
            if fname not in names:
                names.append(fname)
    return names


def log_match_correction(audio_fname, suggested, corrected, duration=None):
    """
    记录用户对自动匹配结果的人工修正（建议值 vs 实际选择）。

    当前先写到本地jsonl文件占位；将来部署到云端后，这里应改为把同样的记录
    上报到云端后台（而不是本地文件），用于持续分析"为什么自动匹配选错了"
    （时长/文件名相似度阈值是否需要调整等），改进匹配策略。
    """
    record = {
        'time': datetime.datetime.now().isoformat(timespec='seconds'),
        'audio_file': audio_fname,
        'suggested_video': suggested,
        'corrected_video': corrected,
        'duration': duration,
    }
    log_path = os.path.join(os.path.dirname(__file__), 'Youtube_Claude_data', 'match_corrections.jsonl')
    try:
        with open(log_path, 'a', encoding='utf-8') as f:
            f.write(json.dumps(record, ensure_ascii=False) + '\n')
    except Exception:
        pass


def preview_merge_matches(audio_dir=None, video_dir=None):
    """
    扫描audio_dir里所有配音音频文件，按时长+文件名相似度预先匹配原视频，
    返回 [[是否合并(bool), 音频文件名, 建议匹配的视频文件名], ...]，供界面确认/勾选/手动修改。

    第一列是勾选框：默认勾选"找到了匹配视频且尚未合并过"的行；
    已合并过的、或没找到匹配的，默认不勾选（用户可手动勾上）。
    """
    audio_dir = audio_dir or OUTPUT_DIR
    video_dir = video_dir or SOURCE_VIDEO_DIR
    rows = []

    if not os.path.isdir(audio_dir):
        return rows

    audio_files = [f for f in os.listdir(audio_dir) if f.lower().endswith(AUDIO_EXTS)]
    for fname in audio_files:
        audio_path = os.path.join(audio_dir, fname)
        base = os.path.splitext(fname)[0]
        title = re.sub(r'_dubbed$', '', base)

        try:
            duration = get_media_duration(audio_path)
        except Exception:
            duration = None

        existing = find_existing_merged(audio_dir, title, duration)
        if existing:
            # 已合并过：默认不勾选，但仍列出供用户决定是否重做
            rows.append([False, fname, f"（已合并：{os.path.basename(existing)}）", 0])
            continue

        if duration is None:
            rows.append([False, fname, '', 0])
            continue
        video_match = find_matching_video([video_dir, audio_dir], title, duration)
        # 找到匹配的默认勾选，没找到默认不勾选
        rows.append([bool(video_match), fname,
                     os.path.basename(video_match) if video_match else '', duration])

    # 排除法兜底：对于仍未匹配到的音频，如果剩下"未被任何行匹配的视频文件"恰好只有一个，
    # 且时长也对得上，就把它标为"待确认"建议（名称对不上但时长吻合，可能是命名差异较大）。
    used_videos = {row[2] for row in rows if row[2] and not row[2].startswith('（') and not row[2].startswith('⚠')}
    all_videos = []
    for folder in (video_dir, audio_dir):
        if folder and os.path.isdir(folder):
            for f in os.listdir(folder):
                if f.lower().endswith(VIDEO_EXTS) and not re.search(r'_dubbed\.\w+$', f, re.IGNORECASE):
                    all_videos.append((f, os.path.join(folder, f)))
    unused_videos = [(f, p) for f, p in all_videos if f not in used_videos]

    unmatched_rows = [row for row in rows if not row[2]]
    if len(unmatched_rows) == 1 and len(unused_videos) == 1:
        fname_only, fpath_only = unused_videos[0]
        try:
            v_dur = get_media_duration(fpath_only)
            row = unmatched_rows[0]
            if abs(v_dur - row[3]) <= max(10.0, row[3] * 0.05):
                row[2] = f"⚠待确认（名称不同但时长相符）：{fname_only}"
                row[0] = True  # 兜底匹配上了，默认勾选
        except Exception:
            pass

    return [[r[0], r[1], r[2]] for r in rows]


def _strip_non_alnum(s):
    """去掉所有非字母数字字符（含emoji），用于模糊文件名匹配"""
    return re.sub(r'[^\w]', '', s, flags=re.UNICODE).lower()


def _locate_video_in_folders(chosen_name, *folders):
    """
    按指定文件名在多个文件夹里找视频文件。
    先精确匹配；精确失败时（常见原因：emoji经Gradio传输后被替换成?），
    退而对比去掉emoji/符号后的纯字母数字部分，找最接近的视频文件。
    """
    norm_chosen = _strip_non_alnum(chosen_name)
    for folder in folders:
        if not folder or not os.path.isdir(folder):
            continue
        # 精确匹配
        candidate = os.path.join(folder, chosen_name)
        if path_exists(candidate):
            return candidate
        # 模糊匹配：去掉emoji/符号后纯字母数字相同
        if not norm_chosen:
            continue
        for fname in os.listdir(folder):
            if not fname.lower().endswith(VIDEO_EXTS):
                continue
            if _strip_non_alnum(fname) == norm_chosen:
                return os.path.join(folder, fname)
    return None


def batch_merge_videos(audio_dir=None, video_dir=None, subtitle_mode='none', pairs=None):
    """
    扫描audio_dir里所有配音音频文件(*_dubbed.m4a等)，
    在video_dir里按时长+文件名相似度找匹配的原视频，逐一合并输出。
    文件名开头/结尾不必完全一致，大体相似即可。

    pairs：可选，由界面"确认匹配"后传入，格式为 [[是否合并(bool), 音频文件名, 视频文件名], ...]。
    只处理勾选(第一列为真)的行；用指定的配对替代自动匹配（视频文件名为空则跳过）。
    （兼容旧的两列格式 [[音频, 视频], ...]，此时视为全部勾选。）

    返回处理结果列表，供界面展示。
    """
    audio_dir = audio_dir or OUTPUT_DIR
    video_dir = video_dir or SOURCE_VIDEO_DIR
    results = []

    if not os.path.isdir(audio_dir):
        return [f"音频文件夹不存在：{audio_dir}"]
    if not os.path.isdir(video_dir):
        return [f"原视频文件夹不存在：{video_dir}"]

    def _parse_pair(row):
        """归一化一行为 (selected, audio, video)，兼容2列/3列格式"""
        if not row:
            return None
        if len(row) >= 3:
            return bool(row[0]), row[1], row[2]
        if len(row) == 2:
            return True, row[0], row[1]
        return None

    if pairs is not None:
        pair_map = {}
        audio_files = []
        for row in pairs:
            parsed = _parse_pair(row)
            if not parsed:
                continue
            selected, audio_name, video_name = parsed
            if not audio_name or not selected:
                continue  # 未勾选的直接不处理（不再列入"已合并/跳过"刷屏）
            audio_files.append(audio_name)
            pair_map[audio_name] = video_name
    else:
        audio_files = [f for f in os.listdir(audio_dir) if f.lower().endswith(AUDIO_EXTS)]
        pair_map = None

    if not audio_files:
        if pairs is not None:
            return ["未勾选任何要合并的音频。"]
        return [f"{audio_dir} 中没有找到配音音频文件"]

    # 若开启了合并后自动投稿，先一次性预检B站登录态：失效则关闭本次自动投稿
    # （合并照常进行，只是不上传），并给出明确提示，避免每个视频都上传失败。
    global AUTO_UPLOAD_BILIBILI
    auto_upload_this_run = AUTO_UPLOAD_BILIBILI
    if auto_upload_this_run:
        try:
            import asyncio as _asyncio
            import bilibili_upload as _bu
            ok, msg = _asyncio.run(_bu.check_credential())
        except Exception as e:
            ok, msg = False, str(e)
        if not ok:
            auto_upload_this_run = False
            results.append(f"⚠ 已关闭本次自动投稿（仅合并，不上传）：{msg}")
            log_event(f"B站登录态预检未通过，本次仅合并不投稿：{msg}")

    total = len(audio_files)
    log_event(f"开始批量合并，共 {total} 个配音音频")
    for i, fname in enumerate(audio_files, 1):
        log_event(f"▶ 正在合并 ({i}/{total})：{fname}")
        audio_path = os.path.join(audio_dir, fname)
        if not path_exists(audio_path):
            results.append(f"❌ {fname}：文件不存在")
            continue
        base = os.path.splitext(fname)[0]
        title = re.sub(r'_dubbed$', '', base)

        try:
            duration = get_media_duration(audio_path)
        except Exception as e:
            results.append(f"❌ {fname}：读取音频时长失败（{e}）")
            continue

        if pair_map is not None:
            # 用户已明确指定配对，直接使用，不做已合并检测也不重新匹配标题
            chosen = (pair_map.get(fname) or '').strip()
            m = re.match(r'⚠待确认（名称不同但时长相符）：(.+)', chosen)
            if m:
                chosen = m.group(1).strip()
            if chosen.startswith('（'):
                chosen = ''
            if not chosen:
                results.append(f"⏭ {fname}：未指定匹配视频，已跳过")
                continue
            video_match = _locate_video_in_folders(chosen, video_dir, audio_dir)
            if not video_match:
                results.append(f"❌ {fname}：指定的视频文件未找到（{chosen}）")
                continue
            # 时长验证：用户已手动确认配对，差距大时只警告不拦截
            try:
                v_dur = get_media_duration(video_match)
                dur_diff = abs(v_dur - duration)
                if dur_diff > max(30.0, duration * 0.1):
                    results.append(
                        f"⚠ 时长差距较大（音频{duration:.0f}s / 视频{v_dur:.0f}s，差{dur_diff:.0f}s），"
                        f"仍按用户指定继续合并：{os.path.basename(video_match)}"
                    )
            except Exception:
                pass  # 读不到时长时忽略，直接合并
        else:
            # 自动模式：先检测是否已合并过，再按时长+文件名自动匹配
            existing = find_existing_merged(audio_dir, title, duration)
            if existing:
                results.append(f"⏭ {fname}：已合并过，跳过（{os.path.basename(existing)}）")
                continue
            video_match = find_matching_video([video_dir, audio_dir], title, duration)
            if not video_match:
                results.append(f"⚠ {fname}：在 {video_dir} 中未找到时长匹配的原视频（约{duration:.0f}秒）")
                continue

        srt_path = os.path.join(audio_dir, base + '.srt')
        srt_path = srt_path if os.path.exists(srt_path) else None

        output_path = build_merge_output_path(audio_dir, title)
        try:
            mux_audio_into_video(video_match, audio_path, output_path, srt_path, subtitle_mode)
            results.append(f"✅ {fname} + {os.path.basename(video_match)} -> {output_path}")
        except Exception as e:
            results.append(f"❌ {fname} 合并失败：{e}")
            continue

        if auto_upload_this_run:
            try:
                import asyncio
                import bilibili_upload
                desc = load_bilibili_desc(audio_dir, base, title)
                meta = load_bilibili_meta(audio_dir, base, title)
                season_id, section_id = BILIBILI_COLLECTION_IDS.get(meta['collection'], (None, None))
                result = asyncio.run(bilibili_upload.upload_video(
                    output_path, title=meta['title'], desc=desc, tid=meta['tid'], tags=meta['tags'],
                    source_url=meta.get('source_url'),
                    delay_minutes=compute_publish_delay_minutes(meta['category'], 0),
                    charging_enabled=BILIBILI_CHARGING_ENABLED,
                    season_id=season_id, section_id=section_id))
                results.append(f"  📤 已投稿B站：{result}")
                results.append(f"  📚 已加入合集「{meta['collection']}」" if season_id else
                                f"  ⚠ 未找到合集「{meta['collection']}」对应的id，未加入合集")
            except Exception as e:
                results.append(f"  ⚠ 投稿B站失败：{e}")

    ok = sum(1 for r in results if r.startswith('✅'))
    log_event(f"✅ 批量合并完成：成功 {ok}/{total}")
    return results


def load_bilibili_desc(folder, base, title):
    """读取dub_video生成的简介/章节时间轴文件（{base}.desc.txt），没有则用默认简介"""
    desc_path = os.path.join(folder, base + '.desc.txt')
    if os.path.exists(desc_path):
        with open(desc_path, 'r', encoding='utf-8') as f:
            return f.read()
    return f"中文配音：{title}"


def load_bilibili_meta(folder, base, title):
    """读取dub_video生成的B站投稿元数据（{base}.meta.json：标题/分区/标签），没有则用默认值"""
    meta_path = os.path.join(folder, base + '.meta.json')
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            if meta.get('title') and meta.get('tid') and meta.get('tags'):
                return meta
        except Exception:
            pass
    config = BILIBILI_CATEGORY_CONFIG['知识']
    return {'title': title, 'tid': config['tid'], 'tags': config['tags'], 'category': '知识',
            'channel_tag': '', 'collection': '精神&身体健康'}


UPLOADED_SUBDIR = '已上传'


def list_uploadable_videos(video_dir=None):
    """列出video_dir里所有"*_dubbed.mp4"（不包括"已上传"子文件夹里的），供界面勾选"""
    video_dir = video_dir or OUTPUT_DIR
    if not os.path.isdir(video_dir):
        return []
    return sorted(f for f in os.listdir(video_dir) if f.lower().endswith('_dubbed.mp4'))


def _move_video_and_sidecars(folder, fname, dest_dir):
    """把视频文件及其同名的字幕/简介/元数据/封面一起移动到dest_dir（已上传文件夹）"""
    import bilibili_upload
    base = os.path.splitext(fname)[0]
    src_path = os.path.join(folder, fname)

    cover_path = bilibili_upload.find_cover_for_video(src_path)
    cover_in_folder = cover_path and os.path.dirname(cover_path) == folder

    orig_base = re.sub(r'_dubbed$', '', base, flags=re.IGNORECASE)

    for name in [fname, base + '.srt', base + '.desc.txt', base + '.meta.json',
                  base + '.m4a', fname + '.uploaded',
                  orig_base + '.mp4', orig_base + '.m4a']:
        p = os.path.join(folder, name)
        if os.path.exists(p):
            shutil.move(p, os.path.join(dest_dir, name))

    if cover_in_folder:
        cover_name = os.path.basename(cover_path)
        p = os.path.join(folder, cover_name)
        if os.path.exists(p):
            shutil.move(p, os.path.join(dest_dir, cover_name))


def upload_selected_videos(video_dir=None, selected_files=None, extra_paths=None):
    """
    把选中的已合并视频逐个投稿到B站。
    selected_files：video_dir里的文件名列表（list_uploadable_videos返回的子集）。
    extra_paths：界面里另外手动选择的视频文件完整路径列表（可能没有同名的简介/元数据，留空即可）。
    上传成功后，把视频及其字幕/简介/元数据/封面一并移动到 video_dir/已上传/，
    以"在已上传文件夹中"作为已上传的标记，不再单独打标记文件。
    """
    import asyncio
    import bilibili_upload

    video_dir = video_dir or OUTPUT_DIR
    results = []

    tasks = []  # (folder, fname, path)
    for fname in (selected_files or []):
        tasks.append((video_dir, fname, os.path.join(video_dir, fname)))
    for path in (extra_paths or []):
        if path and os.path.exists(path):
            tasks.append((os.path.dirname(path), os.path.basename(path), path))

    if not tasks:
        return ["未选择任何视频。"]

    # 投稿前一次性预检登录态：失效时直接给出明确指引，不再逐个视频报难懂的错误
    ok, msg = asyncio.run(bilibili_upload.check_credential())
    if not ok:
        return [f"❌ 无法投稿：{msg}"]

    uploaded_dir = os.path.join(video_dir, UPLOADED_SUBDIR)
    os.makedirs(uploaded_dir, exist_ok=True)

    total = len(tasks)
    print(f"▶ 开始投稿，共 {total} 个视频", flush=True)
    category_counters = {}
    for idx, (folder, fname, path) in enumerate(tasks, 1):
        title = re.sub(r'_dubbed\.mp4$', '', fname, flags=re.IGNORECASE)
        base = os.path.splitext(fname)[0]
        print(f"\n▶ 投稿 ({idx}/{total})：{fname}", flush=True)
        try:
            desc = load_bilibili_desc(folder, base, title)
            meta = load_bilibili_meta(folder, base, title)
            season_id, section_id = BILIBILI_COLLECTION_IDS.get(meta['collection'], (None, None))
            cat_idx = category_counters.get(meta['category'], 0)
            category_counters[meta['category']] = cat_idx + 1
            result = asyncio.run(bilibili_upload.upload_video(
                path, title=meta['title'], desc=desc, tid=meta['tid'], tags=meta['tags'],
                source_url=meta.get('source_url'),
                delay_minutes=compute_publish_delay_minutes(meta['category'], cat_idx),
                charging_enabled=BILIBILI_CHARGING_ENABLED,
                season_id=season_id, section_id=section_id))
            results.append(f"✅ {fname} 投稿成功：{result}")
            results.append(f"  📚 已加入合集「{meta['collection']}」" if season_id else
                            f"  ⚠ 未找到合集「{meta['collection']}」对应的id，未加入合集")
            _move_video_and_sidecars(folder, fname, uploaded_dir)
            results.append(f"  📁 已移动到：{os.path.join(uploaded_dir, fname)}")
        except Exception as e:
            results.append(f"❌ {fname} 投稿失败：{e}")

    return results


# ========== 运行入口 ==========
async def run_all(input_list, genders=None):
    """genders: 与input_list等长的列表，每项为'男'或'女'，决定该视频使用的配音员"""
    results = []
    for i, src in enumerate(input_list, 1):
        print(f"\n========== 视频 {i}/{len(input_list)} ==========")
        print(f"输入：{src}")

        global TEMP_DIR
        video_id = get_video_id(src)
        TEMP_DIR = os.path.join(BASE_TEMP_DIR, video_id)
        os.makedirs(TEMP_DIR, exist_ok=True)

        title, _ = get_video_info(src)
        print(f"标题：{title}")
        stem = build_output_stem(OUTPUT_DIR, i, title)
        output_path = os.path.join(OUTPUT_DIR, stem)
        print(f"输出文件主名：{stem}")

        gender = genders[i-1] if genders and i-1 < len(genders) else '女'
        voice = VOICE_MAP.get(gender, TTS_VOICE)
        print(f"配音员：{gender}（{voice}）")

        try:
            await dub_video(src, output_path, title=title, voice=voice)
            results.append((src, output_path, 'success'))
        except Exception as e:
            print(f"\n❌ 视频 {i} 处理失败：{e}")
            results.append((src, output_path, f'failed: {e}'))

    print("\n========== 全部任务汇总 ==========")
    for src, output_path, status in results:
        print(f"- {src}\n  -> {output_path}  [{status}]")


if __name__ == '__main__':
    asyncio.run(run_all(INPUT_LIST))
    input("\n视频已完成，请按任意键退出...")