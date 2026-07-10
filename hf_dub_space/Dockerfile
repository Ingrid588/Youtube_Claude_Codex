# 单人中文配音云端服务（HF Space）。只保留"抓字幕 + edge-tts 合成"这条主路径，
# 不装 torch/pyannote.audio/faster-whisper——多人说话人分离、无字幕语音转录这些
# 重依赖功能本来就不在这次云端部署的范围内（dub9.py/live_dub_server.py 里这些功能
# 用 try/except ImportError 包着，没装对应包就自动跳过，不影响主路径）。
FROM python:3.11-slim

# ffmpeg：edge-tts 输出转码、get_audio_duration(ffprobe) 都要用
# nodejs：yt-dlp 现在解 YouTube 的签名/n-challenge 需要一个 JS 运行环境
# （没装的话 yt-dlp 报"Signature solving failed"，直接导致抓不到字幕/格式信息，
# 见 https://github.com/yt-dlp/yt-dlp/wiki/EJS）。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg nodejs ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY dub9.py live_dub_server.py ./
# 术语表：apply_glossary（事后纠错，如"癌症"→"巨蟹座"）和翻译前的术语提示注入都靠
# 这个文件夹，之前这里漏拷了，容器里压根没有这个目录，导致术语替换一直是空跑。
COPY glossary ./glossary

# HF Space 标准约定：监听 7860（live_dub_server.py 已支持用 PORT 环境变量覆盖端口）
ENV PORT=7860
# 云端没有本地代理，明确清空（dub9.py 的 PROXY 默认值是本机专用代理，必须显式覆盖）
ENV EDGE_TTS_PROXY=""
# 缓存/临时文件目录，容器内可写位置
ENV DUB_TEMP_DIR=/tmp/dub_temp

EXPOSE 7860

CMD ["python", "live_dub_server.py"]
