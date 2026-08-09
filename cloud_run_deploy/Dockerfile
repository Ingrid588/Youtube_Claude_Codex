# 单人中文配音云端服务（Google Cloud Run，主力服务器；HF Space 作为备份）。
# 跟 hf_dub_space/Dockerfile 是同一套思路：只保留"抓字幕 + edge-tts 合成"这条
# 主路径，不装 torch/pyannote.audio/faster-whisper——多人说话人分离、无字幕语音
# 转录这些重依赖功能本来就不在这次部署范围内（dub9.py/live_dub_server.py 里这些
# 功能用 try/except ImportError 包着，没装对应包就自动跳过，不影响主路径）。
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

COPY dub9.py live_dub_server.py canonical_captions.py ./
# 术语表：apply_glossary（事后纠错，如"癌症"→"巨蟹座"）和翻译前的术语提示注入都靠
# 这个文件夹，漏拷的话容器里压根没有这个目录，术语替换/共现判断会一直是空跑。
COPY glossary ./glossary

# Cloud Run 会在运行时自动注入 PORT（默认8080），这里给个兜底默认值，不影响
# 实际部署（live_dub_server.py 用 os.environ.get('PORT', '8765') 读取）。
ENV PORT=8080
# 云端没有本地代理，明确清空（dub9.py 的 PROXY 默认值是本机专用代理，必须显式覆盖，
# 否则 edge-tts 会尝试连一个容器里根本不存在的本机代理，导致每一句配音都失败）。
ENV EDGE_TTS_PROXY=""
# 持久缓存目录：翻译 translations.json + TTS mp3。
# Cloud Run / HF 请把卷挂载到此路径（不要用 /tmp，容器重启会丢）。
# 例：gcloud run services update ... --add-volume=name=dub-cache,type=cloud-storage,bucket=你的桶 \
#     --add-volume-mount=volume=dub-cache,mount-path=/data/dub_cache
ENV DUB_TEMP_DIR=/data/dub_cache
# 缓存总容量上限（默认 6GB）；超限先删较旧视频目录，仍超则按最旧继续删。
ENV DUB_CACHE_MAX_BYTES=6442450944

EXPOSE 8080

CMD ["python", "live_dub_server.py"]
