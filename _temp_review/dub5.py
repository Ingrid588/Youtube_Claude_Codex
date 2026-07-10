import asyncio
import json
import re
import subprocess
import os
import time

import edge_tts
import yt_dlp
from tqdm import tqdm
from google import genai

# ========== 配置区（只需改这里）==========
GEMINI_API_KEY = 'AIzaSyCvg8n9PbJKoTjz0_c52ESuVPWJR9lvj0o'          # 填你的Gemini API Key
TARGET_LANG = '中文'                          # 目标语言
TTS_VOICE = 'zh-CN-XiaoxiaoNeural'           # TTS声音
OUTPUT_PATH = 'output_dubbed.mp4'            # 输出文件名
INPUT = 'https://youtu.be/0pMGS6bNcek'  # YouTube链接或本地文件路径
PROXY = 'http://127.0.0.1:17891'             # 代理地址
TEMP_DIR = r'C:\video\Youtube_Claude\temp'   # 临时文件目录

os.makedirs(TEMP_DIR, exist_ok=True)


# ========== 第一步：获取字幕 ==========
def get_subtitles(url_or_file):
    ydl_opts = {
        'writesubtitles': True,
        'writeautomaticsub': True,
        'subtitleslangs': ['en', 'en-US', 'en-GB'],
        'subtitlesformat': 'vtt',
        'skip_download': True,
        'outtmpl': os.path.join(TEMP_DIR, 'subtitle'),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url_or_file, download=True)

    vtt_files = [f for f in os.listdir(TEMP_DIR) if f.endswith('.vtt')]
    if not vtt_files:
        raise FileNotFoundError(f"未找到字幕文件，该视频可用字幕：{list(info.get('subtitles',{}).keys())}")

    vtt_path = os.path.join(TEMP_DIR, vtt_files[0])
    return parse_vtt(vtt_path)


def parse_vtt(vtt_path):
    segments = []
    with open(vtt_path, 'r', encoding='utf-8') as f:
        content = f.read()

    pattern = r'(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\Z)'
    matches = re.findall(pattern, content)

    seen_texts = set()
    for start, end, text in matches:
        text = re.sub(r'<[^>]+>', '', text).strip().replace('\n', ' ')
        text = re.sub(r'\s+', ' ', text).strip()
        if not text or text in seen_texts:
            continue
        seen_texts.add(text)
        segments.append({
            'start': timestamp_to_seconds(start),
            'end': timestamp_to_seconds(end),
            'text': text
        })

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


def merge_short_segments(segments, gap_threshold=0.5, min_duration=1.5):
    """合并碎片字幕，避免一句话被拆成多行造成配音隔断"""
    if not segments:
        return segments

    merged = []
    current = segments[0].copy()

    for next_seg in segments[1:]:
        gap = next_seg['start'] - current['end']
        is_incomplete = (
            gap < gap_threshold or
            (current['end'] - current['start'] < min_duration and
             not current['text'].rstrip().endswith(('.', '!', '?')))
        )

        if is_incomplete:
            current['end'] = next_seg['end']
            current['text'] = current['text'].rstrip() + ' ' + next_seg['text'].lstrip()
        else:
            merged.append(current)
            current = next_seg.copy()

    merged.append(current)
    return merged


# ========== 第二步：翻译字幕 ==========
def translate_segments(segments, target_lang=TARGET_LANG):
    client = genai.Client(api_key=GEMINI_API_KEY)

    cache_path = os.path.join(TEMP_DIR, 'translations.json')
    cache = {}
    if os.path.exists(cache_path):
        with open(cache_path, 'r', encoding='utf-8') as f:
            cache = json.load(f)
        print(f"  读取缓存：已有 {len(cache)} 条翻译")

    for seg in segments:
        if seg['text'] in cache:
            seg['translation'] = cache[seg['text']]

    todo = [s for s in segments if 'translation' not in s]
    if not todo:
        print("  全部命中缓存，跳过翻译")
        return segments

    batch_size = 50
    batches = [todo[i:i+batch_size] for i in range(0, len(todo), batch_size)]

    with tqdm(total=len(todo), desc="翻译字幕", unit="条") as pbar:
        for batch in batches:
            lines = []
            for i, s in enumerate(batch):
                duration = s['end'] - s['start']
                lines.append(f"{i}|{duration:.1f}s|{s['text']}")
            batch_text = '\n'.join(lines)

            prompt = f"""将以下英文字幕翻译成{target_lang}。

每行格式为：序号|时长|原文
时长是该字幕在视频中的播放时间窗口。

翻译要求：
1. 中文配音语速约4-5字/秒，请根据时长控制译文字数
   - 例如2秒窗口最多8-10个汉字
   - 例如4秒窗口最多16-20个汉字
2. 在字数限制内尽量保留原意，必要时可以意译或省略次要信息
3. 绝对不能为了完整而超字数，宁可意思不完整也不能溢出

{batch_text}

只输出翻译结果，格式：序号|翻译内容"""

            response = None
            for attempt in range(5):
                try:
                    response = client.models.generate_content(
                        model='gemini-2.5-flash',
                        contents=prompt
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
                for line in response.text.strip().split('\n'):
                    if '|' in line:
                        try:
                            idx, translation = line.split('|', 1)
                            batch[int(idx.strip())]['translation'] = translation.strip()
                        except:
                            pass

                for seg in batch:
                    if 'translation' in seg:
                        cache[seg['text']] = seg['translation']
                with open(cache_path, 'w', encoding='utf-8') as f:
                    json.dump(cache, f, ensure_ascii=False, indent=2)

            pbar.update(len(batch))

    return segments


# ========== 第三步：TTS合成 ==========
def get_audio_duration(path):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', path],
        capture_output=True, text=True
    )
    info = json.loads(result.stdout)
    return float(info['format']['duration'])


async def synthesize_segment(seg, voice=TTS_VOICE):
    text = seg['translation']
    duration = seg['end'] - seg['start']
    audio_path = os.path.join(TEMP_DIR, f"seg_{int(seg['start']*1000)}.mp3")

    # 合成配音，最多重试3次
    for attempt in range(3):
        try:
            communicate = edge_tts.Communicate(text, voice, proxy=PROXY)
            await communicate.save(audio_path)
            break
        except Exception as e:
            if attempt == 2:
                print(f"\n  警告：片段合成失败，跳过。({e})")
                return None
            await asyncio.sleep(2)

    if not os.path.exists(audio_path):
        return None

    # 检查是否需要微调语速（翻译阶段已控制字数，这里只做小幅修正）
    actual_duration = get_audio_duration(audio_path)
    if actual_duration > duration * 0.95 and duration > 0:
        rate_pct = min(int((actual_duration / duration - 1) * 100), 30)
        if rate_pct > 3:
            for attempt in range(3):
                try:
                    communicate = edge_tts.Communicate(
                        text, voice, rate=f"+{rate_pct}%", proxy=PROXY
                    )
                    await communicate.save(audio_path)
                    break
                except:
                    await asyncio.sleep(2)

    seg['audio_path'] = audio_path
    return audio_path


async def synthesize_all(segments, voice=TTS_VOICE):
    semaphore = asyncio.Semaphore(3)
    valid_segments = [s for s in segments if 'translation' in s]

    async def run_with_sem(seg, pbar):
        async with semaphore:
            await synthesize_segment(seg, voice)
            pbar.update(1)

    with tqdm(total=len(valid_segments), desc="合成配音", unit="条") as pbar:
        await asyncio.gather(*[run_with_sem(seg, pbar) for seg in valid_segments])

    return segments


# ========== 第四步：合并视频 ==========
def merge_audio_video(video_path, segments, output_path):
    result = subprocess.run(
        ['ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', video_path],
        capture_output=True, text=True
    )
    total_duration = float(json.loads(result.stdout)['format']['duration'])

    input_args = ['-i', video_path]
    filter_parts = []
    idx = 1

    for seg in segments:
        if 'audio_path' in seg and os.path.exists(seg['audio_path']):
            input_args += ['-i', seg['audio_path']]
            delay_ms = int(seg['start'] * 1000)
            filter_parts.append(
                f'[{idx}:a]adelay={delay_ms}|{delay_ms}[a{idx}]'
            )
            idx += 1

    if not filter_parts:
        raise RuntimeError("没有可用的配音片段")

    mix_inputs = (
        '[0:a]volume=0.3[orig];' +
        ''.join([f'[a{i+1}]' for i in range(len(filter_parts))]) +
        f'[orig]amix=inputs={len(filter_parts)+1}:normalize=0[aout]'
    )

    filter_complex = ';'.join(filter_parts) + ';' + mix_inputs

    # 写入临时文件，避免Windows命令行长度限制
    filter_file = os.path.join(TEMP_DIR, 'filter_complex.txt')
    with open(filter_file, 'w', encoding='utf-8') as f:
        f.write(filter_complex)

    cmd = ['ffmpeg', '-y'] + input_args + [
        '-filter_complex_script', filter_file,
        '-map', '0:v',
        '-map', '[aout]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-progress', 'pipe:1',
        '-nostats',
        output_path
    ]

    process = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    )

    with tqdm(total=int(total_duration), desc="合并视频", unit="秒") as pbar:
        current_time = 0
        for line in process.stdout:
            if line.startswith('out_time_ms='):
                try:
                    ms = int(line.split('=')[1])
                    new_time = min(ms // 1000000, int(total_duration))
                    if new_time > current_time:
                        pbar.update(new_time - current_time)
                        current_time = new_time
                except:
                    pass
        process.wait()


# ========== 主流程 ==========
async def dub_video(input_src, output_path, target_lang=TARGET_LANG):
    print(f"\n▶ 第1步：获取字幕...")
    segments = get_subtitles(input_src)
    print(f"  共获取 {len(segments)} 条字幕")
    segments = merge_short_segments(segments)
    print(f"  合并后 {len(segments)} 条字幕")

    print(f"\n▶ 第2步：翻译字幕...")
    segments = translate_segments(segments, target_lang)

    print(f"\n▶ 第3步：合成配音...")
    segments = await synthesize_all(segments)

    print(f"\n▶ 第4步：合并视频...")
    if input_src.startswith('http'):
        print("  下载视频文件...")
        video_file = os.path.join(TEMP_DIR, 'source_video.mp4')
        ydl_opts = {
            'format': 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4',
            'outtmpl': video_file,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([input_src])
        merge_audio_video(video_file, segments, output_path)
    else:
        merge_audio_video(input_src, segments, output_path)

    print(f"\n✅ 完成！输出文件：{output_path}")


# ========== 运行入口 ==========
if __name__ == '__main__':
    asyncio.run(dub_video(INPUT, OUTPUT_PATH))