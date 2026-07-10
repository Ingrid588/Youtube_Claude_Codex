"""
B站自动投稿模块。

使用前：
1. 在浏览器登录B站。
2. 把登录后的 SESSDATA / bili_jct / buvid3 三个cookie值
   存成 Youtube_Claude_data/bilibili_cookies.json，格式：
   {"SESSDATA": "...", "bili_jct": "...", "buvid3": "..."}

默认按"转载"(copyright=2)投稿并填写source（原视频链接），
这是对二次创作内容比较规范的做法，但具体分区/标签/简介建议人工核对，
首次使用建议先小范围测试账号的投稿权限和审核情况。
"""
import difflib
import asyncio
import json
import os
import re
import subprocess
import tempfile

from PIL import Image, ImageDraw, ImageFont
from bilibili_api import Credential, video_uploader, request_settings
from bilibili_api.utils.picture import Picture

# B站是国内站点：本机为了访问YouTube设置了 HTTP_PROXY/HTTPS_PROXY 环境变量（境外代理），
# bilibili_api 底层 httpx 默认会读取这些环境变量，导致B站上传被境外代理转发 →
# 触发 403（风控拒绝）和大文件上传超时（WinError 121 信号灯超时）。
# 这里强制让 bilibili_api 忽略环境代理、直连B站，并显式清空代理。
request_settings.set_trust_env(False)
request_settings.set_proxy('')
# 大文件分片上传，单次请求超时适当放宽，避免网络抖动时直接判失败
request_settings.set_timeout(120.0)

UPLOAD_MAX_ATTEMPTS = 5


def _is_transient_upload_error(error):
    text = str(error).lower()
    return any(marker in text for marker in (
        'curl: (16)', 'curl: (55)', 'curl (16)', 'curl (55)',
        'connection reset', 'recv failure', 'send failure',
        'timed out', 'timeout', 'temporarily unavailable',
        'remote protocol error', 'server disconnected',
    ))

COVER_EXTS = ('.jpg', '.jpeg', '.png', '.webp')

# 是否在封面图上叠加标题文字（在原图中央加大号描边文字，
# 而不是用B站网页"封面设置"里的模板编辑器——那个没有API，无法自动化）。
ADD_TITLE_TO_COVER = True

# Windows自带的中文字体，找不到则跳过文字叠加
COVER_FONT_PATHS = [
    r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
]


def _extract_hook_text(title, max_chars=16):
    """
    从（中文）标题里提取适合放封面的"勾人"片段：
    去掉开头的【频道名】标签，再按常见标点切出第一段，超长则截断。
    """
    text = re.sub(r'^【[^】]*】\s*', '', title).strip()
    # 去掉emoji等封面字体不支持的字符，避免渲染成方块"口口"
    text = re.sub(r'[\U0001F000-\U0001FFFF☀-➿️]', '', text).strip()
    parts = re.split(r'[，,。！？!?：:、~～\s]+', text)
    hook = next((p for p in parts if p), text)
    return hook[:max_chars]


def add_title_to_cover(cover_path, title, output_path, max_chars=16):
    """
    在封面图中央叠加从标题提取的"勾人"文字（大号黄字+黑色描边，超过约8字自动分两行）。
    生成新图片到output_path并返回该路径；找不到字体或出错则返回原cover_path。
    """
    font_path = next((p for p in COVER_FONT_PATHS if os.path.exists(p)), None)
    if not font_path:
        return cover_path

    text = _extract_hook_text(title, max_chars)
    if not text:
        return cover_path

    try:
        img = Image.open(cover_path).convert('RGB')
        w, h = img.size
        font_size = max(int(h * 0.16), 24)
        font = ImageFont.truetype(font_path, font_size)
        draw = ImageDraw.Draw(img)

        # 太长就从中间标点/字符处分两行
        if len(text) > 8:
            mid = len(text) // 2
            line1, line2 = text[:mid], text[mid:]
            lines = [line1, line2]
        else:
            lines = [text]

        stroke_w = max(int(font_size * 0.08), 2)
        line_heights = []
        for line in lines:
            bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
            line_heights.append(bbox[3] - bbox[1])
        gap = int(font_size * 0.2)
        total_h = sum(line_heights) + gap * (len(lines) - 1)

        y = (h - total_h) // 2
        for line, lh in zip(lines, line_heights):
            bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
            text_w = bbox[2] - bbox[0]
            x = (w - text_w) // 2
            draw.text((x, y), line, font=font, fill=(255, 221, 0),
                      stroke_width=stroke_w, stroke_fill=(0, 0, 0))
            y += lh + gap

        img.save(output_path, quality=90)
        return output_path
    except Exception:
        return cover_path


def _normalize_name(name):
    name = re.sub(r'_dubbed$', '', name, flags=re.IGNORECASE)
    name = re.sub(r'^\d+[-_]\s*', '', name)
    return name.lower()


def find_cover_for_video(video_path):
    """
    在视频文件同目录下查找封面图：先尝试完全同名，再按"去掉编号前缀和_dubbed后缀"
    的标题相似度匹配（编号分隔符可能是-也可能是_，文件名结尾也可能不同）。
    都找不到则用ffmpeg截取一帧生成临时封面。
    """
    folder = os.path.dirname(video_path)
    base = os.path.splitext(video_path)[0]

    for ext in COVER_EXTS:
        candidate = base + ext
        if os.path.exists(candidate):
            return candidate

    target_norm = _normalize_name(os.path.basename(base))
    best_score, best_path = 0, None
    for fname in os.listdir(folder):
        if not fname.lower().endswith(COVER_EXTS):
            continue
        score = difflib.SequenceMatcher(
            None, _normalize_name(os.path.splitext(fname)[0]), target_norm
        ).ratio()
        if score > best_score:
            best_score, best_path = score, os.path.join(folder, fname)

    if best_path and best_score >= 0.6:
        return best_path

    tmp_path = os.path.join(tempfile.gettempdir(), os.path.basename(base) + '_cover.jpg')
    try:
        subprocess.run(
            ['ffmpeg', '-y', '-i', video_path, '-ss', '00:00:01', '-vframes', '1', tmp_path],
            capture_output=True, check=True,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        )
        if os.path.exists(tmp_path):
            return tmp_path
    except Exception:
        pass
    return None

BILIBILI_COOKIES_FILE = os.path.join(os.path.dirname(__file__), 'Youtube_Claude_data', 'bilibili_cookies.json')

# 默认分区：情感(21)。按需修改，分区id可在B站创作中心查到。
DEFAULT_TID = 21
DEFAULT_TAGS = ['翻译', '配音', '中文配音']


def load_credential():
    if not os.path.exists(BILIBILI_COOKIES_FILE):
        return None
    with open(BILIBILI_COOKIES_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    sessdata = data.get('SESSDATA')
    bili_jct = data.get('bili_jct')
    buvid3 = data.get('buvid3')
    if not (sessdata and bili_jct and buvid3):
        return None
    return Credential(sessdata=sessdata, bili_jct=bili_jct, buvid3=buvid3)


async def check_credential():
    """
    投稿前的一次性预检，返回 (是否可用, 提示信息)。
    依次检查：cookies文件是否存在/字段是否齐全、登录态是否仍有效。
    失效时给出明确的修复指引，避免逐个视频上传都报难懂的错误。
    """
    if not os.path.exists(BILIBILI_COOKIES_FILE):
        return False, (
            f"未找到B站登录信息文件：{BILIBILI_COOKIES_FILE}\n"
            "请先在浏览器登录bilibili.com，用「Get cookies.txt LOCALLY」扩展导出cookies，"
            "保存到 Youtube_Claude_data\\cookies_bilibili.txt，再运行 "
            "python extract_bilibili_cookies.py 生成登录信息。"
        )
    cred = load_credential()
    if not cred:
        return False, (
            f"B站登录信息不完整（缺少 SESSDATA/bili_jct/buvid3 之一）：{BILIBILI_COOKIES_FILE}\n"
            "请重新导出cookies并运行 python extract_bilibili_cookies.py。"
        )
    try:
        valid = await cred.check_valid()
    except Exception as e:
        return False, f"校验B站登录态时出错：{e}"
    if not valid:
        return False, (
            "B站登录信息已过期（cookies失效）。请重新登录bilibili.com，\n"
            "用「Get cookies.txt LOCALLY」扩展导出cookies到 Youtube_Claude_data\\cookies_bilibili.txt，\n"
            "再运行 python extract_bilibili_cookies.py 更新登录信息后重试投稿。"
        )
    return True, "B站登录信息有效。"


# B站"创作声明"里"内容无需标注"对应的creation_statement_id（从实际投稿页面抓包确认）
CREATION_STATEMENT_NONE = 1

DRAFT_ADD_API = {
    'url': 'https://member.bilibili.com/x/vupre/web/draft/add',
    'method': 'POST',
}


async def upload_video(video_path, title, desc='', tags=None, source_url=None,
                        tid=DEFAULT_TID, cover_path=None, delay_minutes=5, charging_enabled=False,
                        season_id=None, section_id=None):
    """
    上传视频文件到B站，并以"草稿"形式保存（不会公开发布、不会进入审核），
    需要去B站创作中心的"草稿箱"里手动检查后再点击发布。
    source_url：原视频链接，填写后会按"转载"标注来源；不填则按"自制"。
    delay_minutes：定时发布的延迟分钟数（写入draft的dtime字段，"当前时间+该分钟数"后定时发布），
    传None则不设置定时。
    返回B站接口的响应数据。
    """
    import time
    from bilibili_api.utils.network import Api

    credential = load_credential()
    if not credential:
        raise RuntimeError(
            f"未找到有效的B站登录信息，请先在 {BILIBILI_COOKIES_FILE} "
            f"写入 SESSDATA/bili_jct/buvid3"
        )

    page = video_uploader.VideoUploaderPage(path=video_path, title=title[:80], description=desc)

    cover_path = cover_path or find_cover_for_video(video_path)
    if not cover_path:
        raise RuntimeError(f"未找到封面图，且无法用ffmpeg从视频截取封面：{video_path}")

    if ADD_TITLE_TO_COVER:
        tmp_cover = os.path.join(tempfile.gettempdir(), os.path.basename(video_path) + '_cover_titled.jpg')
        cover_path = add_title_to_cover(cover_path, title, tmp_cover)

    meta = video_uploader.VideoMeta(
        tid=tid,
        title=title[:80],
        desc=desc,
        cover=Picture.from_file(cover_path),
        tags=(tags or DEFAULT_TAGS)[:10],
        original=not bool(source_url),
        source=source_url,
    )

    uploader = video_uploader.VideoUploader([page], meta, credential)
    uploader.line = await video_uploader._choose_line(uploader.line)
    # B站预上传接口通常允许多分片并发，但部分网络/旧版curl在HTTP/2复用连接时
    # 容易出现curl(16)/(55)。改成单路分片，速度略慢但大幅降低整页失败概率。
    original_preupload = uploader._preupload

    async def _stable_preupload(upload_page):
        data = await original_preupload(upload_page)
        data['threads'] = 1
        return data

    uploader._preupload = _stable_preupload

    # 注册分片上传进度监听：实时打印百分比、已传/总大小、速度与预计剩余时间(ETA)。
    # 这些 print 会被上层 stream_call 捕获并实时显示到界面日志。
    Ev = video_uploader.VideoUploaderEvents
    total_size = page.get_size()
    prog = {'start': None, 'last_pct': -1}

    def _fmt_size(b):
        for unit in ('B', 'KB', 'MB', 'GB'):
            if b < 1024 or unit == 'GB':
                return f"{b:.1f}{unit}"
            b /= 1024

    def _on_pre_page(_data):
        prog['start'] = time.time()
        print(f"  ⬆ 开始上传视频（共 {_fmt_size(total_size)}）...", flush=True)

    def _on_after_chunk(data):
        done = data['chunk_number'] + 1
        total = max(data['total_chunk_count'], 1)
        pct = done * 100 // total
        if pct <= prog['last_pct'] and done != total:
            return
        prog['last_pct'] = pct
        elapsed = time.time() - (prog['start'] or time.time())
        uploaded = total_size * done / total
        speed = uploaded / elapsed if elapsed > 0 else 0
        eta = (total_size - uploaded) / speed if speed > 0 else 0
        eta_str = f"{int(eta // 60)}分{int(eta % 60)}秒" if eta else "—"
        print(f"  ⬆ 上传中 {pct}%（{_fmt_size(uploaded)}/{_fmt_size(total_size)}，"
              f"{_fmt_size(speed)}/s，预计剩余 {eta_str}）", flush=True)

    def _on_after_page(_data):
        elapsed = time.time() - (prog['start'] or time.time())
        print(f"  ✅ 视频上传完成（耗时 {int(elapsed // 60)}分{int(elapsed % 60)}秒）", flush=True)

    def _on_pre_cover(_data):
        print("  🖼 上传封面...", flush=True)

    uploader.add_event_listener(Ev.PRE_PAGE.value, _on_pre_page)
    uploader.add_event_listener(Ev.AFTER_CHUNK.value, _on_after_chunk)
    uploader.add_event_listener(Ev.AFTER_PAGE.value, _on_after_page)
    uploader.add_event_listener(Ev.PRE_COVER.value, _on_pre_cover)

    print(f"  📤 准备投稿：{title[:40]}", flush=True)
    page_data = None
    for attempt in range(UPLOAD_MAX_ATTEMPTS):
        prog['start'] = None
        prog['last_pct'] = -1
        try:
            page_data = await uploader._upload_page(page)
            break
        except Exception as e:
            if not _is_transient_upload_error(e) or attempt >= UPLOAD_MAX_ATTEMPTS - 1:
                raise
            wait_seconds = (5, 15, 30, 60)[attempt]
            print(
                f"  ⚠ 上传连接中断（第{attempt + 1}/{UPLOAD_MAX_ATTEMPTS}次）：{e}\n"
                f"  ↻ {wait_seconds}秒后建立新上传会话，从该视频重新上传…",
                flush=True,
            )
            await asyncio.sleep(wait_seconds)
    if not page_data:
        raise RuntimeError('视频上传多次重试后仍未返回结果')
    cover_url = await uploader._upload_cover()
    print("  📝 提交稿件草稿...", flush=True)

    tags_list = (tags or DEFAULT_TAGS)[:10]
    draft = {
        'videos': [{
            'title': page.title,
            'desc': page.description,
            'filename': page_data['filename'],
            'cid': page_data['cid'],
            'is_4k': False,
            'is_8k': False,
            'is_hdr': False,
        }],
        'cover': cover_url,
        'title': title[:80],
        'copyright': 2 if source_url else 1,
        'source': source_url or '',
        'creation_statement_id': CREATION_STATEMENT_NONE,
        'tid': tid,
        'tag': ','.join(tags_list),
        'desc': desc,
        'recreate': 0,
        'dynamic': '',
        'season_id': season_id,
        'section_id': section_id,
        'dtime': int(time.time()) + delay_minutes * 60 if delay_minutes else None,
        'no_disturbance': 0,
        'is_only_self': 0,
        'space_hidden': 0,
        'watermark': {'state': 1},
        'subtitle': {'open': 0, 'lan': ''},
        'charging_pay': 1 if charging_enabled else 0,
        'no_reprint': 0,
        'dolby': 0,
        'lossless_music': 0,
        'up_selection_reply': False,
        'up_close_reply': False,
        'up_close_danmu': False,
        'csrf': credential.bili_jct,
    }

    return await (
        Api(**DRAFT_ADD_API, credential=credential, no_csrf=True, json_body=True)
        .update_params(csrf=credential.bili_jct, t=int(time.time() * 1000))
        .update_data(**draft)
        .result
    )
