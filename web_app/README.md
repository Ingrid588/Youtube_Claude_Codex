# YouTube 视频朗读 Web 应用

一个简单的 Web 应用，用来为 YouTube 视频自动生成多语言配音。

## 功能

- ✅ 自动从 YouTube 提取字幕（支持中文、英文、日文等）
- ✅ 70+ 种语言的配音员选择
- ✅ 自动计算最优语速（全程匀速配音）
- ✅ 双标签页同步播放（一个播放视频，一个播放配音）
- ✅ 下载配音音频

## 快速开始

### 前置要求

- 后端服务 `live_dub_server.py` 已运行（127.0.0.1:8765）
- Python 3.8+
- 已安装依赖（edge-tts, yt-dlp, torch 等）

### 1️⃣ 启动后端服务

```bash
cd C:\video\Youtube_Claude
python live_dub_server.py
```

等待看到：
```
INFO:     Uvicorn running on http://127.0.0.1:8765
```

### 2️⃣ 打开 Web 应用

方式 A：直接在浏览器打开 HTML 文件
```bash
# Windows
start web_app\index.html

# Mac
open web_app/index.html

# Linux
xdg-open web_app/index.html
```

方式 B：用 Python 简单 HTTP 服务器（推荐）
```bash
cd web_app
python -m http.server 8000
```
然后在浏览器打开：`http://localhost:8000`

### 3️⃣ 使用流程

1. **粘贴 YouTube 链接** → 点"获取字幕"
   - 等待 10-30 秒（取决于视频长度）
   - 会显示字幕预览

2. **选择语言和配音员**
   - 默认中文（晓晓女声）
   - 支持 8+ 种语言切换

3. **点"生成配音"**
   - 等待 1-3 分钟（取决于视频字数）
   - 完成后会显示音频播放器

4. **播放和下载**
   - 直接点播放按钮
   - 或下载音频文件保存到本地

### 4️⃣ 双页同步播放（可选）

如果想在一个标签页播放视频，另一个标签页播放配音：

1. 在 Web 应用的播放器点"🔗 启动同步"
2. 在 YouTube 页面安装并启用插件（如果已安装）
3. 两个标签页会自动同步播放/暂停

## 支持的语言和配音员

### 中文 (zh-CN)
- 晓晓（女） - 默认
- 晓伊（女）
- 云溪（男）
- 云阳（男）

### English (en-US)
- Aria（女） - 默认
- Guy（男）
- Amber（女）

### English (en-GB)
- Sonia（女）
- Ryan（男）

### 其他
- Deutsch, Français, Español, 日本語, 한국어 等

## API 端点（后端）

```
POST /prefetch_captions
  输入：{ video_id: "xxx" }
  输出：{ ok: true, segments: [...] }

POST /dub
  输入：{ 
    video_id: "xxx",
    title: "xxx",
    segments: [{start, end, text, voice}, ...],
    base_rate_pct: 0,
    read_mode: true,
    lang: "zh-CN"
  }
  输出：{ segments: [{start, duration, audio_url, text, ...}, ...] }

GET /audio/{video_id}/{filename}
  返回：MP3 音频文件
```

## 故障排除

### ❌ "无法连接到后端"
- 确保 `live_dub_server.py` 已运行在 127.0.0.1:8765
- 检查防火墙设置

### ❌ "无法获取字幕"
- 链接格式是否正确？
- YouTube 是否对该账号限流 (429)？
  - 解决：在插件中导出 cookies.txt，让后端使用登录状态

### ❌ "生成配音失败"
- 检查后端日志（console 输出）
- 字幕是否为空？
- 磁盘空间是否充足（音频临时文件）？

## 部署到服务器

### Hugging Face Spaces（免费）

1. 创建 Spaces（选择 Docker）
2. 上传以下文件：
   ```
   Dockerfile
   web_app/
   live_dub_server.py
   requirements.txt
   ```

3. 编写 Dockerfile：
   ```dockerfile
   FROM python:3.10
   WORKDIR /app
   COPY . .
   RUN pip install -r requirements.txt
   EXPOSE 7860
   CMD ["python", "live_dub_server.py", "--host", "0.0.0.0", "--port", "7860"]
   ```

### Railway / Render（付费但便宜）

参考各平台的 Python 应用部署文档

## 性能指标

| 操作 | 耗时 |
|-----|------|
| 获取字幕（10min 视频） | 10-30s |
| 生成配音（100 条字幕） | 1-2 min |
| 下载依赖（第一次） | 5-10 min |

## 注意事项

- ⚠️ 仅用于个人学习和测试
- ⚠️ 尊重 YouTube 服务条款
- ⚠️ 不支持付费内容或版权保护视频
- ⚠️ 建议使用自己账号的视频测试

## 下一步

- [ ] 支持 Bilibili 视频
- [ ] Web 前端部署到 Vercel / Netlify
- [ ] 用户登录和配额管理（付费功能）
- [ ] 支持音频混音（保留原音 + 配音）

---

**创建日期**：2026-06-22  
**最后更新**：2026-06-22
