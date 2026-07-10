"""
对10个视频做：
1. 清理translations.json缓存中"译文字数>上限字数"的条目（连同前后一句，保证重译时
   上下文连贯），让这些句子在重新翻译时走新规则(强上限+精简+情绪保留+自检+
   超字数自动重译+抽查)。
2. 重新翻译(只翻译被清理的句子，其余命中缓存)。
3. 重新合成配音(TTS按文本缓存，只有译文变了的句子会重新合成)。
4. 重新生成 _dubbed.m4a 和 _dubbed.mp4。
"""
import sys, os, json, asyncio
sys.path.insert(0, r'C:\video\Youtube_Claude')
import dub8

OUTDIR = dub8.OUTPUT_DIR
TEMPDIR = dub8.BASE_TEMP_DIR

JOBS = [
    ("1-Every Argument is With a GHOST", "abhmtkqnW7s"),
    ("2-How To Think SO CLEARLY People Assume You're A Genius", "mjTgkm-h__M"),
    ("3-Sand Reading⏳\U0001f60dDivine Guidance ♥️", "BGoPKA-8n2Q"),
    ("4-you broke someone wide open", "-dCKFYCDsK4"),
    ("5-15 июня_ Новолуние открывающее новую реальность. СМЕНА ПАРАДИГМы СОЗНАНИЯ. Прогн", "XFpWvmKtZZQ"),
    ("6-FATED Changes SHAKE the Timeline! Uranus square Nodes+Gemini New Moon! June 15th", "qfcL-JxOkdM"),
    ("7-God & Your Higher Self Needs You To Hear This...\U0001f9ff\U0001fabd", "UpCgewoofV0"),
    ("8-you're moving through DIVINE REARRANGEMENT", "LrgVvdCGr2U"),
    ("9-Your recalibration is complete, expect restoration in your finances", "JNYp3ynwMYE"),
    ("10-STOP. You Need To Watch This Before The Day Ends! ❤︎", "x04lp6s6Pco"),
]


def prune_overflow_cache(temp_dir, segments):
    cache_path = os.path.join(temp_dir, 'translations.json')
    with open(cache_path, 'r', encoding='utf-8') as f:
        cache = json.load(f)

    total_words = sum(len(s['text'].split()) for s in segments)
    total_duration = sum(max(s['duration'], 0.1) for s in segments)
    words_per_sec = total_words / total_duration if total_duration else 2.0
    chars_per_sec = max(3.0, min(words_per_sec * 2.5, 10.0))

    to_remove = set()
    for i, s in enumerate(segments):
        translation = cache.get(s['text'])
        if not translation:
            continue
        target_chars = max(round(s['duration'] * chars_per_sec), 1)
        cap_chars = min(target_chars, max(len(s['text']) // 2, 1))
        if len(translation) > cap_chars:
            to_remove.add(i)
            if i - 1 >= 0:
                to_remove.add(i - 1)
            if i + 1 < len(segments):
                to_remove.add(i + 1)

    removed = 0
    for i in to_remove:
        text = segments[i]['text']
        if text in cache:
            del cache[text]
            removed += 1

    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)

    return removed, len(to_remove)


async def redo_one(title, vid):
    temp_dir = os.path.join(TEMPDIR, vid)
    dub8.TEMP_DIR = temp_dir

    vtt_path = os.path.join(temp_dir, 'subtitle.en.vtt')
    segments = dub8.parse_vtt(vtt_path)
    segments = dub8.dedupe_rolling_overlap(segments)
    segments = dub8.estimate_durations(segments)
    segments = dub8.group_into_sentences(segments, split_gap=1.0, max_duration=12.0)

    removed, marked = prune_overflow_cache(temp_dir, segments)
    print(f"\n===== {title} =====")
    print(f"  共{len(segments)}句，标记{marked}句需重译(含上下文)，实际清除缓存{removed}条")

    usage = {'input_tokens': 0, 'output_tokens': 0, 'input_chars': 0, 'output_chars': 0}
    segments = dub8.translate_segments(segments, '中文', usage, title)
    dub8.log_usage(title, usage)

    print(f"  合成配音...")
    segments = await dub8.synthesize_all(segments, dub8.TTS_VOICE, title)

    video_duration = segments[-1]['end'] if segments else 0
    video_match = dub8.find_matching_video([dub8.SOURCE_VIDEO_DIR, OUTDIR], title, video_duration)

    output_path = os.path.join(OUTDIR, title)
    audio_output_path = output_path + '_dubbed.m4a'
    dub8.export_audio(segments, None, audio_output_path)
    print(f"  已生成: {audio_output_path}")

    if video_match:
        mp4_output_path = output_path + '_dubbed.mp4'
        dub8.merge_audio_video(video_match, segments, mp4_output_path, None, 'none')
        print(f"  已生成: {mp4_output_path}")
    else:
        print(f"  未找到匹配原视频，跳过mp4合并")


async def main():
    for title, vid in JOBS:
        try:
            await redo_one(title, vid)
        except Exception as e:
            print(f"\n!!!! {title} 失败: {e}")


if __name__ == '__main__':
    asyncio.run(main())
