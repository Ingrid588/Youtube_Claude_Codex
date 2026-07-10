#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Silero VAD + WeSpeaker 说话人分离测试脚本
用法：python dub11_silero_test.py [video_url]
"""

import os
import sys
import time
import io

# 修复 Windows 控制台编码
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
import torch
import numpy as np
import soundfile as sf
from pathlib import Path
from datetime import datetime
from scipy.cluster.hierarchy import fclusterdata
from sklearn.preprocessing import StandardScaler

# Silero VAD
from silero_vad import load_silero_vad, get_speech_timestamps, read_audio

# WeSpeaker
import wespeakerruntime

# 其他工具
import yt_dlp
import subprocess

# ==================== 配置 ====================
ENABLE_TIMING = True
MAX_DURATION_SEC = 600  # 测试限制 10 分钟
OUTPUT_DIR = Path("Youtube_Claude_data/output")
CACHE_DIR = Path("Youtube_Claude_data/cache")

# 配音员映射
ACTOR_MAP = {
    0: {"name": "女1", "voice": "zh-CN-XiaoxiaoNeural", "gender": "female"},
    1: {"name": "男1", "voice": "zh-CN-YunyangNeural", "gender": "male"},
    2: {"name": "女2", "voice": "zh-CN-YunxiNeural", "gender": "male"},
    3: {"name": "男2", "voice": "zh-CN-liaoning", "gender": "male"},
}

# ==================== 工具函数 ====================

def log_time(msg: str, start_time: float = None) -> float:
    """记录时间"""
    if start_time is not None:
        elapsed = time.time() - start_time
        print(f"⏱️  {msg} ({elapsed:.1f}s)")
        return time.time()
    else:
        print(f"▶ {msg}...")
        return time.time()

def download_audio(video_url: str, output_path: Path) -> Path:
    """下载视频音频"""
    if output_path.exists():
        print(f"✓ 音频已缓存: {output_path}")
        return output_path

    print(f"  下载音频: {video_url}")
    ydl_opts = {
        'format': 'bestaudio/best',
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'wav',
            'preferredquality': '192',
        }],
        'outtmpl': str(output_path.with_suffix('')),
        'quiet': True,
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([video_url])

    return output_path

def load_model_silero():
    """加载 Silero VAD 模型"""
    print("  加载 Silero VAD 模型...")
    model = load_silero_vad(onnx=True)  # 用 ONNX 版本更快
    return model

def load_model_wespeaker():
    """加载 WeSpeaker 模型"""
    print("  加载 WeSpeaker 模型...")
    # 使用官方预训练模型（中文）
    speaker = wespeakerruntime.Speaker(lang='chs')  # 中文模型
    return speaker

def detect_speech_segments(audio_path: str, model) -> list:
    """用 Silero VAD 检测说话段"""
    print(f"  检测说话段...")
    start = time.time()

    # 用 soundfile 读取音频（避免 torchcodec 依赖）
    wav, sr = sf.read(audio_path)

    # 转换为 mono 16kHz
    if len(wav.shape) > 1:  # stereo
        wav = np.mean(wav, axis=1)

    if sr != 16000:
        # 重采样
        num_samples = int(len(wav) * 16000 / sr)
        wav = np.interp(np.linspace(0, len(wav), num_samples), np.arange(len(wav)), wav)

    # 转换为 float32 [-1, 1]
    if wav.dtype != np.float32:
        if wav.max() > 1:
            wav = wav / 32768.0
        wav = wav.astype(np.float32)

    wav = torch.from_numpy(wav)

    # 限制处理长度
    if len(wav) > 16000 * MAX_DURATION_SEC:
        wav = wav[:16000 * MAX_DURATION_SEC]
        print(f"  (处理限制在 {MAX_DURATION_SEC}s)")

    # 检测说话段
    timestamps = get_speech_timestamps(wav, model, return_seconds=True)

    elapsed = time.time() - start
    print(f"  成功检测到 {len(timestamps)} 个说话段 ({elapsed:.1f}s)")

    return timestamps, wav.numpy()

def extract_speaker_embeddings(audio_path: str, timestamps: list, wav: np.ndarray, model) -> list:
    """提取每个说话段的说话人特征向量"""
    print(f"  提取说话人嵌入...")
    start = time.time()

    embeddings = []
    sample_rate = 16000
    temp_dir = CACHE_DIR / "segments"
    temp_dir.mkdir(exist_ok=True)

    for i, ts in enumerate(timestamps):
        try:
            start_sample = int(ts['start'] * sample_rate)
            end_sample = int(ts['end'] * sample_rate)
            segment_wav = wav[start_sample:end_sample]

            # 保存临时分段
            segment_path = temp_dir / f"segment_{i:04d}.wav"
            sf.write(segment_path, segment_wav, sample_rate)

            # 用 WeSpeaker 提取嵌入
            embedding = model.extract_embedding(str(segment_path))
            embeddings.append({
                'timestamp': ts,
                'embedding': np.array(embedding) if not isinstance(embedding, np.ndarray) else embedding,
                'duration': ts['end'] - ts['start']
            })

            # 清理临时文件
            segment_path.unlink()
        except Exception as e:
            print(f"    警告: 段 {i} 提取失败: {e}")
            continue

    elapsed = time.time() - start
    print(f"  成功提取 {len(embeddings)} 个嵌入 ({elapsed:.1f}s)")

    return embeddings

def cluster_speakers(embeddings: list, n_clusters: int = None) -> list:
    """通过聚类识别不同的说话人"""
    print(f"  聚类识别说话人...")
    start = time.time()

    if not embeddings:
        return []

    # 提取特征向量
    features = np.array([e['embedding'] for e in embeddings])

    # 归一化
    scaler = StandardScaler()
    features_normalized = scaler.fit_transform(features)

    # 计算欧几里得距离矩阵并聚类
    # 使用层次聚类，距离阈值为 0.5
    labels = fclusterdata(features_normalized, t=0.5, criterion='distance', method='complete')

    # 将标签分配给嵌入
    for i, emb in enumerate(embeddings):
        emb['speaker_id'] = labels[i] - 1  # 转换为 0-based

    n_speakers = len(np.unique(labels))
    elapsed = time.time() - start
    print(f"  ✓ 识别到 {n_speakers} 个说话人 ({elapsed:.1f}s)")

    return embeddings

def generate_report(embeddings: list, video_url: str) -> str:
    """生成报告"""
    report = []
    report.append("\n" + "="*60)
    report.append("📊 Silero VAD + WeSpeaker 说话人分离测试结果")
    report.append("="*60)
    report.append(f"视频: {video_url}")
    report.append(f"处理时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

    if not embeddings:
        report.append("❌ 未检测到说话段")
        return "\n".join(report)

    # 统计
    n_speakers = len(set(e.get('speaker_id', 0) for e in embeddings))
    total_duration = sum(e['duration'] for e in embeddings)

    report.append(f"\n✓ 检测到 {len(embeddings)} 个说话段")
    report.append(f"✓ 识别到 {n_speakers} 个说话人")
    report.append(f"✓ 总说话时长: {total_duration:.1f}s")

    # 说话人详情
    report.append("\n📋 说话人分布:")
    for speaker_id in sorted(set(e.get('speaker_id', 0) for e in embeddings)):
        segs = [e for e in embeddings if e.get('speaker_id') == speaker_id]
        duration = sum(s['duration'] for s in segs)
        actor = ACTOR_MAP.get(speaker_id, {"name": f"说话人{speaker_id}", "voice": "unknown"})
        report.append(f"  - {actor['name']:8s}: {len(segs):3d} 段, {duration:6.1f}s")

    report.append("\n📝 前 10 个说话段:")
    for i, emb in enumerate(embeddings[:10]):
        speaker_id = emb.get('speaker_id', 0)
        ts = emb['timestamp']
        actor = ACTOR_MAP.get(speaker_id, {"name": f"说话人{speaker_id}"})
        report.append(f"  {i+1:2d}. [{ts['start']:.1f}s - {ts['end']:.1f}s] ({emb['duration']:.1f}s) -> {actor['name']}")

    report.append("="*60)
    return "\n".join(report)

# ==================== 主程序 ====================

def main():
    # 准备环境
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # 获取视频 URL
    if len(sys.argv) > 1:
        video_url = sys.argv[1]
    else:
        video_url = "https://youtu.be/TWnAu_84NK0"  # 测试视频

    print(f"\n🎬 开始测试 Silero VAD + WeSpeaker")
    print(f"视频: {video_url}\n")

    overall_start = log_time("总耗时")

    # 第 1 步：下载音频
    step1_start = log_time("第 1 步：下载音频")
    audio_cache = CACHE_DIR / "test_audio.wav"
    audio_path = download_audio(video_url, audio_cache)
    log_time("第 1 步完成", step1_start)

    # 第 2 步：加载模型
    step2_start = log_time("第 2 步：加载模型")
    try:
        model_vad = load_model_silero()
        model_wespeaker = load_model_wespeaker()
        log_time("第 2 步完成", step2_start)
    except Exception as e:
        print(f"错误: 模型加载失败: {e}")
        import traceback
        traceback.print_exc()
        return

    # 第 3 步：检测说话段
    step3_start = log_time("第 3 步：检测说话段（Silero VAD）")
    try:
        timestamps, wav = detect_speech_segments(str(audio_path), model_vad)
        log_time("第 3 步完成", step3_start)
    except Exception as e:
        print(f"❌ 检测失败: {e}")
        return

    # 第 4 步：提取嵌入
    step4_start = log_time("第 4 步：提取说话人嵌入（WeSpeaker）")
    try:
        embeddings = extract_speaker_embeddings(str(audio_path), timestamps, wav, model_wespeaker)
        log_time("第 4 步完成", step4_start)
    except Exception as e:
        print(f"错误: 嵌入提取失败: {e}")
        import traceback
        traceback.print_exc()
        embeddings = []

    # 第 5 步：聚类
    if embeddings:
        step5_start = log_time("第 5 步：聚类识别说话人")
        embeddings = cluster_speakers(embeddings)
        log_time("第 5 步完成", step5_start)

    # 总耗时
    log_time("总体完成", overall_start)

    # 生成报告
    report = generate_report(embeddings, video_url)
    print(report)

    # 保存报告
    report_path = OUTPUT_DIR / f"silero_test_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    report_path.write_text(report, encoding='utf-8')
    print(f"\n✓ 报告已保存: {report_path}")

if __name__ == "__main__":
    main()
