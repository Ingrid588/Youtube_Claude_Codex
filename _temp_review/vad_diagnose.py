"""
配音后诊断脚本（不接入生产流程，仅用于分析归因）。

用法：
    python vad_diagnose.py <temp目录，含subtitle.en.vtt和translations.json> <配音音频路径(_dubbed.m4a)>
"""
import sys
import os
import json
import torch
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dub8


_MODEL = None
_GET_TS = None


def load_vad():
    global _MODEL, _GET_TS
    if _MODEL is None:
        torch.set_num_threads(1)
        model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True)
        _MODEL, _GET_TS = model, utils[0]
    return _MODEL, _GET_TS


def get_speech_segments(audio_path, model, get_speech_timestamps):
    wav_path = audio_path
    tmp_wav = None
    if not audio_path.lower().endswith('.wav'):
        import subprocess
        tmp_wav = audio_path + '.vad_tmp.wav'
        subprocess.run(['ffmpeg', '-y', '-i', audio_path, '-ar', '16000', '-ac', '1', tmp_wav],
                       capture_output=True, check=True)
        wav_path = tmp_wav

    data, sr = sf.read(wav_path, dtype='float32')
    assert sr == 16000
    wav = torch.from_numpy(data)
    ts = get_speech_timestamps(wav, model, sampling_rate=16000, return_seconds=True)

    if tmp_wav:
        os.remove(tmp_wav)
    return ts


def diagnose(temp_dir, audio_path, verbose=True):
    vtt_path = os.path.join(temp_dir, 'subtitle.en.vtt')
    cache_path = os.path.join(temp_dir, 'translations.json')

    segments = dub8.parse_vtt(vtt_path)
    segments = dub8.dedupe_rolling_overlap(segments)
    segments = dub8.estimate_durations(segments)
    segments = dub8.group_into_sentences(segments)

    with open(cache_path, 'r', encoding='utf-8') as f:
        cache = json.load(f)
    for s in segments:
        s['translation'] = cache.get(s['text'], '')

    model, get_speech_timestamps = load_vad()
    speech_ts = get_speech_segments(audio_path, model, get_speech_timestamps)

    def speech_in_window(start, end):
        total = 0.0
        for seg in speech_ts:
            a, b = max(start, seg['start']), min(end, seg['end'])
            if b > a:
                total += b - a
        return total

    chars_per_sec = sum(len(s.get('translation', '')) for s in segments) / max(
        sum(max(s['duration'], 0.1) for s in segments), 0.1)

    overlap_rows = []
    underfill_rows = []
    overflow_rows = []  # 译字数超过上限的（不管VAD有没有检测到重叠）

    for i, s in enumerate(segments):
        start, end = s['start'], s['start'] + s['duration']
        next_start = segments[i + 1]['start'] if i + 1 < len(segments) else None

        translation = s.get('translation', '')
        target_chars = round(s['duration'] * chars_per_sec)
        cap_chars = min(target_chars, max(len(s['text']) // 2, 1))

        overlap = 0.0
        if next_start is not None:
            overlap = speech_in_window(end, next_start)

        spoken_in_window = speech_in_window(start, end)
        underfill = max(s['duration'] - spoken_in_window, 0.0)

        row = {
            'i': i, 'duration': s['duration'], 'target': target_chars,
            'cap': cap_chars, 'translated': len(translation),
            'overlap': overlap, 'underfill': underfill,
            'text': s['text'], 'translation': translation,
        }
        if overlap > 0.3:
            overlap_rows.append(row)
        elif underfill > s['duration'] * 0.4 and s['duration'] > 1.5:
            underfill_rows.append(row)
        if len(translation) > cap_chars:
            overflow_rows.append(row)

    result = {
        'total': len(segments),
        'overlap_rows': overlap_rows,
        'underfill_rows': underfill_rows,
        'overflow_rows': overflow_rows,
        'chars_per_sec': chars_per_sec,
    }

    if verbose:
        print(f"共 {len(segments)} 句，VAD检测到 {len(speech_ts)} 段语音, chars_per_sec={chars_per_sec:.2f}")
        print(f"重叠 {len(overlap_rows)} 句，留白 {len(underfill_rows)} 句，超字数上限 {len(overflow_rows)} 句")
        for row in overlap_rows:
            print(f"  [OVERLAP] #{row['i']:3d} dur={row['duration']:5.1f}s "
                  f"target/cap/译={row['target']}/{row['cap']}/{row['translated']} "
                  f"overlap={row['overlap']:.1f}s | {row['text'][:40]}")
        for row in underfill_rows:
            print(f"  [GAP]     #{row['i']:3d} dur={row['duration']:5.1f}s "
                  f"target/cap/译={row['target']}/{row['cap']}/{row['translated']} "
                  f"gap={row['underfill']:.1f}s | {row['text'][:40]}")
        for row in overflow_rows:
            if row not in overlap_rows:
                print(f"  [OVERFLOW-CACHED] #{row['i']:3d} target/cap/译="
                      f"{row['target']}/{row['cap']}/{row['translated']} | {row['text'][:40]}")

    return result


def main():
    if len(sys.argv) < 3:
        print("用法：python vad_diagnose.py <temp目录> <配音音频路径>")
        sys.exit(1)
    diagnose(sys.argv[1], sys.argv[2])


if __name__ == '__main__':
    main()
