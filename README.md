# YouTube / Bilibili Live Dubbing

Dub YouTube or Bilibili videos that already have captions. Choose from **70+ languages**, each with male and female voices.

给 YouTube / Bilibili **有字幕**的视频配音。可选 **70 多种语言**，每种语言各有男女配音员。

## Ways to watch / 使用方式

- **Real-time**：边看边配音
- **Library / 库存**：先生成配音，再观看
- **Download**：下载配音文件

## What’s in this repo

- `chrome_extension/` — Chrome extension (popup + page player)
- `live_dub_server.py` / `dub9.py` — translate + TTS backend
- `cloud_run_deploy/` — production Cloud Run image
- `hf_dub_space/` — Hugging Face Space backup

API keys stay in server environment variables, not in this repository.

密钥放在服务器环境变量里，不要提交到仓库。

## License

MIT
