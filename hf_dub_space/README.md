---
title: Dub Server
emoji: 🎧
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# 单人中文配音云端服务

给 Chrome 插件用的"抓字幕 + edge-tts 中文配音"后端，迁移自本地 `live_dub_server.py`。
只保留单人配音这条主路径，不含多人说话人分离（pyannote）、无字幕语音转录（faster-whisper）。

## 需要配置的 Secrets（Space Settings → Variables and secrets）

- `YT_COOKIES_CONTENT`：完整的 `cookies.txt` 内容（Netscape 格式），登录态能大幅降低被 YouTube 429 限流的概率。
- `YT_PROXY`：住宅代理地址，格式 `http://用户名:密码@host:port`，配合 cookies 进一步降低限流概率。两者都是可选的，没有也能跑，只是更容易被限流。

## 接口

跟本地版完全一致：`/prefetch_captions`、`/dub`、`/dub_status`、`/clear_cache`、`/health`。
