import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import dub8

VTT = r"C:\video\Youtube_Claude\Youtube_Claude_data\temp\-dCKFYCDsK4\subtitle.en.vtt"
AUDIO = r"C:\video\Youtube_Claude\_vadtest\audio.wav"

segments = dub8.parse_vtt(VTT)
segments = dub8.dedupe_rolling_overlap(segments)
segments = dub8.estimate_durations(segments)
segments = dub8.group_into_sentences(segments)

print(f"句子数: {len(segments)}")

# ---- Silero VAD ----
import torch
torch.set_num_threads(1)
model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', trust_repo=True)
get_speech_timestamps = utils[0]

import soundfile as sf
import numpy as np
data, sr = sf.read(AUDIO, dtype='float32')
assert sr == 16000
wav = torch.from_numpy(data)
speech_ts = get_speech_timestamps(wav, model, sampling_rate=16000, return_seconds=True)
print(f"VAD检测到 {len(speech_ts)} 段语音")

def vad_overlap(start, end):
    """计算[start,end]窗口内被VAD判定为'说话'的总时长"""
    total = 0.0
    for seg in speech_ts:
        s, e = max(start, seg['start']), min(end, seg['end'])
        if e > s:
            total += e - s
    return total

print("\n序号 | VTT时长 | 估算时长(现用) | VAD说话时长(窗口内) | 原文片段")
diffs = []
for i, s in enumerate(segments[:30]):
    vtt_dur = s['end'] - s['start']
    est_dur = s['duration']
    vad_dur = vad_overlap(s['start'], s['end'])
    diffs.append(abs(est_dur - vad_dur))
    print(f"{i:3d} | {vtt_dur:5.1f}s | {est_dur:5.1f}s | {vad_dur:5.1f}s | {s['text'][:50]}")

print(f"\n平均 |估算时长-VAD说话时长| 差异: {sum(diffs)/len(diffs):.2f}s")
