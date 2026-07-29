"""
本地"实时配音"后端：给Chrome插件用。
插件从YouTube页面直接拿到带时间戳的字幕，发到这里；
这里复用dub9.py的翻译(Gemini)+TTS(edge-tts)逻辑，逐句合成后
把"时间戳+译文+音频url"返回给插件，由插件按时间戳播放、原声调小。

启动：python live_dub_server.py
默认监听 http://127.0.0.1:8765

多人配音说话人分离：
  需要 pip install pyannote.audio
  需要 HuggingFace token（在 huggingface.co 注册后获取，并同意 pyannote/speaker-diarization-3.1 使用条款）
  token 存放方式（任选其一）：
    1. 环境变量：set HF_TOKEN=hf_xxx（在 .bat 启动脚本里加）
    2. 项目根目录 config.json: {"hf_token": "hf_xxx"}
"""
import os
import re
import time
import shutil
import sys
import json
import base64
import asyncio
import logging
import subprocess
import traceback
import tempfile
import io
import zipfile
from datetime import datetime, timezone
from urllib.parse import quote

# 用 pythonw(无窗口) 启动时，子进程 yt-dlp/ffmpeg 会各自弹出黑色控制台窗口再消失，
# 造成屏幕闪烁、甚至抢走键盘焦点。统一加这个标志让子进程不创建窗口。
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(HERE, 'live_dub.log')
DIAGNOSTIC_LOG_DIR = os.path.join(HERE, 'chrome_extension', 'diagnostic_logs')

# 关键：用 pythonw 无窗口启动时 sys.stdout / sys.stderr 是 None，
# 而 dub9.py 里大量 print() 会因此崩溃（导致每个请求500、插件显示"失败"）。
# 在 import dub9 之前先把 stdout/stderr 重定向到日志文件，让 print() 正常工作。
_logfile = open(LOG_PATH, 'a', encoding='utf-8', errors='replace', buffering=1)
if sys.stdout is None:
    sys.stdout = _logfile
if sys.stderr is None:
    sys.stderr = _logfile

sys.path.insert(0, HERE)
import dub9

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# ===== pyannote-audio 说话人分离（可选）=====
try:
    from pyannote.audio import Pipeline as PyannotePipeline
    import torch
    PYANNOTE_AVAILABLE = True
except ImportError:
    PYANNOTE_AVAILABLE = False

_pyannote_pipeline = None

def _load_hf_token():
    token = os.environ.get('HF_TOKEN', '').strip()
    if token:
        return token
    cfg_path = os.path.join(HERE, 'config.json')
    if os.path.exists(cfg_path):
        import json
        try:
            with open(cfg_path, encoding='utf-8') as f:
                return json.load(f).get('hf_token', '').strip()
        except Exception:
            pass
    return ''

# 抓字幕/下载音频用的代理（住宅代理，缓解 YouTube 429 限流）。跟 hf_token 同样的取值方式：
# 优先环境变量 YT_PROXY，其次项目根目录 config.json 里的 "proxy_url" 字段，两边都没配就不用代理。
# 不写进代码里、不提交进 git——config.json 已经在 .gitignore 里。
# 格式跟 yt-dlp --proxy 一样：'http://用户名:密码@gw.dataimpulse.com:823'
def _load_proxy_url():
    proxy = os.environ.get('YT_PROXY', '').strip()
    if proxy:
        return proxy
    cfg_path = os.path.join(HERE, 'config.json')
    if os.path.exists(cfg_path):
        import json
        try:
            with open(cfg_path, encoding='utf-8') as f:
                return json.load(f).get('proxy_url', '').strip()
        except Exception:
            pass
    return ''

def _proxy_components():
    """把 proxy_url 拆成 (login, password, hostport)，方便按次拼会话ID。没配代理返回 None。"""
    base = _load_proxy_url()
    if not base:
        return None
    try:
        from urllib.parse import urlsplit
        parts = urlsplit(base)
        if not parts.hostname:
            return None
        hostport = parts.hostname + (f':{parts.port}' if parts.port else '')
        return parts.username or '', parts.password or '', hostport
    except Exception:
        return None

def _proxy_cmd_args(session_id=None):
    """返回 yt-dlp 的 --proxy 参数列表（没配代理就返回空列表，cmd[2:2] = [] 是安全的no-op）。

    session_id：DataImpulse 等住宅代理支持在登录名后拼 ';sessid.<id>' 来"锁定"一个具体IP——
    同一个 id 在 Sticky 时长内固定同一个IP，换一个新 id 就立刻换一个新IP，不用等 Sticky 超时。
    用户反馈：固定不动的 Sticky 万一刚好分到一个已经被限流的IP，会在整个 Sticky 时长内一直
    卡在这个坏IP上——所以遇到 429 时上层重试逻辑换一个新会话ID 即可立刻换IP，不用死等。
    """
    comps = _proxy_components()
    if not comps:
        return []
    login, password, hostport = comps
    if session_id:
        login = f'{login};sessid.{session_id}'
    return ['--proxy', f'http://{login}:{password}@{hostport}']

def _find_ffmpeg():
    """定位 ffmpeg 可执行文件：优先 PATH，其次常见安装路径。"""
    import shutil
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    for p in (r'C:\ffmpeg\bin\ffmpeg.exe', r'C:\Program Files\ffmpeg\bin\ffmpeg.exe'):
        if os.path.exists(p):
            return p
    return None


def _decode_to_waveform(audio_bytes, suffix='.webm'):
    """
    用 ffmpeg 把任意容器音频(WebM/Opus等)转成 16kHz 单声道 PCM，
    再用 soundfile 读成 torch 波形张量，绕过 torchcodec/系统FFmpeg-DLL 问题。
    返回 {'waveform': Tensor(1, time), 'sample_rate': 16000}。
    """
    import subprocess
    import soundfile as sf
    import numpy as np
    import torch

    ffmpeg = _find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError('未找到 ffmpeg，无法解码音频。请安装 ffmpeg 并加入 PATH。')

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        src = f.name
    wav = src + '.wav'
    try:
        subprocess.run(
            [ffmpeg, '-y', '-i', src, '-ac', '1', '-ar', '16000', '-f', 'wav', wav],
            check=True, capture_output=True,
            creationflags=_NO_WINDOW,
        )
        data, sr = sf.read(wav, dtype='float32')
        if data.ndim > 1:
            data = data.mean(axis=1)
        waveform = torch.from_numpy(data).unsqueeze(0)  # (1, time)
        return {'waveform': waveform, 'sample_rate': sr}
    finally:
        for p in (src, wav):
            try:
                os.unlink(p)
            except Exception:
                pass


def get_pyannote_pipeline():
    global _pyannote_pipeline
    if _pyannote_pipeline is not None:
        return _pyannote_pipeline
    if not PYANNOTE_AVAILABLE:
        raise RuntimeError('pyannote.audio 未安装，请运行: pip install pyannote.audio')
    hf_token = _load_hf_token()
    if not hf_token:
        raise RuntimeError(
            '需要 HuggingFace token。\n'
            '1. 在 huggingface.co 注册账号\n'
            '2. 同意 pyannote/speaker-diarization-3.1 使用条款\n'
            '3. 在个人设置页生成 Access Token\n'
            '4. 设置环境变量 HF_TOKEN=hf_xxx  或  在项目根目录创建 config.json: {"hf_token":"hf_xxx"}'
        )
    log.info('加载 pyannote 说话人分离模型（首次需下载约1GB，请耐心等待）…')
    # pyannote.audio 4.x 用 token=，旧版用 use_auth_token=，做兼容
    try:
        pipeline = PyannotePipeline.from_pretrained(
            'pyannote/speaker-diarization-3.1', token=hf_token,
        )
    except TypeError:
        pipeline = PyannotePipeline.from_pretrained(
            'pyannote/speaker-diarization-3.1', use_auth_token=hf_token,
        )
    if PYANNOTE_AVAILABLE and torch.cuda.is_available():
        pipeline = pipeline.to(torch.device('cuda'))
        log.info('pyannote 模型已加载到 GPU')
    else:
        log.info('pyannote 模型已加载（CPU模式）')
    _pyannote_pipeline = pipeline
    return pipeline

# 与批量配音共用同一缓存根目录（BASE_TEMP_DIR/{video_id}/），
# 翻译缓存(translations.json)和TTS音频(seg_*.mp3)互相复用，避免重复翻译合成。
# 将来商业化只需把 BASE_TEMP_DIR 指向共享存储即可让所有用户共享缓存。
LIVE_TEMP_DIR = dub9.BASE_TEMP_DIR
os.makedirs(LIVE_TEMP_DIR, exist_ok=True)

CACHE_MAX_BYTES = int(os.getenv('DUB_CACHE_MAX_BYTES', str(6 * 1024 ** 3)))
_last_cache_cleanup = 0.0


def _maybe_cleanup_server_cache(force=False):
    global _last_cache_cleanup
    now = time.time()
    if not force and now - _last_cache_cleanup < 3600:
        return
    _last_cache_cleanup = now
    rows, total = [], 0
    for name in os.listdir(LIVE_TEMP_DIR):
        path = os.path.join(LIVE_TEMP_DIR, name)
        if not os.path.isdir(path): continue
        size = 0
        for root, _dirs, files in os.walk(path):
            for filename in files:
                try: size += os.path.getsize(os.path.join(root, filename))
                except OSError: pass
        total += size
        active = False
        try:
            with open(os.path.join(path, 'background_job.json'), encoding='utf-8') as handle:
                active = json.load(handle).get('status') in {'pending', 'processing'}
        except (OSError, ValueError, json.JSONDecodeError): pass
        rows.append((os.path.getmtime(path), size, path, active))
    if total <= CACHE_MAX_BYTES: return
    rows.sort()
    for keep_hours in (72, 48, 24, 6):
        cutoff = now - keep_hours * 3600
        for mtime, size, path, active in list(rows):
            if total <= CACHE_MAX_BYTES or active or mtime > cutoff: continue
            try:
                shutil.rmtree(path); total -= size; rows.remove((mtime, size, path, active))
                log.info(f'[缓存清理] 删除 {keep_hours} 小时前缓存 {path}')
            except OSError as exc: log.warning(f'[缓存清理] 删除失败 {path}: {exc}')


def _save_video_cache_meta(video_id, title):
    """Keep a small display-name record beside each video's server cache."""
    if not video_id:
        return
    video_dir = os.path.join(LIVE_TEMP_DIR, video_id)
    os.makedirs(video_dir, exist_ok=True)
    try:
        with open(os.path.join(video_dir, 'cache_meta.json'), 'w', encoding='utf-8') as f:
            json.dump({
                'video_id': video_id,
                'title': (title or video_id).strip(),
                'updated_at': datetime.now(timezone.utc).isoformat(),
            }, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning(f'[缓存列表] 保存标题失败 video_id={video_id}: {e}')


def _touch_video_cache_dir(video_id):
    """Refresh a video's cache folder mtime so cleanup won't mistake an active
    long-running job for an old cold cache."""
    if not video_id:
        return
    try:
        video_dir = os.path.join(LIVE_TEMP_DIR, str(video_id))
        os.makedirs(video_dir, exist_ok=True)
        os.utime(video_dir, None)
    except Exception:
        pass

# ===== Gemini翻译用量保护：服务器是所有装了这个插件的人共用的，没有账号体系，
# 不防着点的话，一两个重度用户或者刷量就能把账单和免费额度都耗光（参考今天聊的
# 同类插件"先不限制、用户多了才限制"的教训，咱们从一开始就上限额，不要等出事）。
# 三层防护：①单个客户端每日字符上限 ②全局每日字符上限（硬顶，不管多少用户）
# ③全局并发上限（防止今天遇到的"一个请求卡住、其它请求全部堵死"那种情况蔓延）。
# 没有登录账号，客户端身份靠插件自己生成、存在 chrome.storage.local 里的随机ID
# （client_id，类似很多插件做法），不是绝对防伪造，但能挡住绝大多数无意的滥用，
# 真要彻底防刷量得上账号体系，那是更大的工程，先用这个轻量方案。
# 2026-07 用户反馈：印度语/日语这些字幕，YouTube自动翻译质量太差听不懂，必须靠
# Gemini翻译才能用，配额限制反而把核心功能锁死了。现阶段（还没做商业版/付费分级）
# 先整体放开，不卡死用户——但配额统计的底层机制（check_and_reserve_gemini_quota、
# 按client_id和全局分别计数、日期自动重置）原样保留，不删代码。将来做商业版
# （分免费/付费额度）时，把 GEMINI_QUOTA_ENFORCED 改回 true（或设环境变量）就能
# 直接重新启用，不用重写这套逻辑。
# 当前版完全不限制Gemini翻译。保留统计/授权基础代码，商业版需要时再显式接回。
GEMINI_QUOTA_ENFORCED = False
GEMINI_PER_CLIENT_DAILY_CHARS = int(os.environ.get('GEMINI_PER_CLIENT_DAILY_CHARS', 60000))
GEMINI_GLOBAL_DAILY_CHARS = int(os.environ.get('GEMINI_GLOBAL_DAILY_CHARS', 2000000))
MAX_CONCURRENT_DUB_REQUESTS = int(os.environ.get('MAX_CONCURRENT_DUB_REQUESTS', 6))

_QUOTA_PATH = os.path.join(LIVE_TEMP_DIR, 'gemini_quota.json')
_quota_lock = asyncio.Lock()
_dub_concurrency_sem = asyncio.Semaphore(MAX_CONCURRENT_DUB_REQUESTS)

def _today_str():
    import datetime as _dt
    return _dt.date.today().isoformat()

def _load_quota():
    try:
        with open(_QUOTA_PATH, encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}
    today = _today_str()
    if data.get('date') != today:
        # 跨天了，清空昨天的用量重新计数（跟用户语言包里看到的"明天恢复"一个意思）
        data = {'date': today, 'global_chars': 0, 'clients': {}}
    data.setdefault('clients', {})
    return data

def _save_quota(data):
    try:
        with open(_QUOTA_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception as e:
        log.warning(f'[用量] 写入配额文件失败: {e}')

GEMINI_PAID_CLIENT_DAILY_CHARS = int(os.environ.get('GEMINI_PAID_CLIENT_DAILY_CHARS', 2000000))

# ===== 付费授权（Lemon Squeezy 授权码）=====
# 跟上面按天清零的用量统计是两套独立持久化文件：付费状态不应该随便清零，所以
# 单独存一份，没有"日期"概念，只有"这个client_id有没有绑定有效授权码"。
LEMONSQUEEZY_API_KEY = os.environ.get('LEMONSQUEEZY_API_KEY', '')
LEMONSQUEEZY_PRODUCT_ID = int(os.environ.get('LEMONSQUEEZY_PRODUCT_ID', 1177201))
_LICENSES_PATH = os.path.join(LIVE_TEMP_DIR, 'licenses.json')
_license_lock = asyncio.Lock()

def _load_licenses():
    try:
        with open(_LICENSES_PATH, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

def _save_licenses(data):
    try:
        with open(_LICENSES_PATH, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception as e:
        log.warning(f'[授权] 写入授权文件失败: {e}')

def is_client_paid(client_id):
    """检查这个client_id是不是已经绑定了有效授权码（不看Lemon Squeezy线上状态，
    只看本地记录——授权码失效/退款的情况靠后续重新校验或人工处理，这里图简单）。"""
    if not client_id:
        return False
    licenses = _load_licenses()
    entry = licenses.get(client_id)
    if not entry:
        return False
    expires_at = entry.get('expires_at')
    if expires_at:
        try:
            import datetime as _dt
            if _dt.datetime.fromisoformat(expires_at.replace('Z', '+00:00')) < _dt.datetime.now(_dt.timezone.utc):
                return False  # 订阅/授权已过期
        except Exception:
            pass
    return True

async def check_and_reserve_gemini_quota(client_id, estimated_chars):
    """在真正调用Gemini翻译前先"预占"额度，按这次原文字符数估算用量（不是精确的
    token数，足够用来做配额判断）。超额时返回 (False, 原因)，调用方应该跳过Gemini
    翻译、走免费的YouTube自动翻译兜底，不是直接报错卡死用户。"""
    per_client_limit = GEMINI_PAID_CLIENT_DAILY_CHARS if is_client_paid(client_id) else GEMINI_PER_CLIENT_DAILY_CHARS
    async with _quota_lock:
        data = _load_quota()
        # GEMINI_QUOTA_ENFORCED=false（现阶段默认）时不拦截——但用量仍然照常累加记录，
        # 保留真实使用数据，供以后设计商业版付费分级时参考，不是白白不计。
        if not GEMINI_QUOTA_ENFORCED:
            client_key = client_id or 'unknown'
            data['global_chars'] += estimated_chars
            data['clients'][client_key] = data['clients'].get(client_key, 0) + estimated_chars
            _save_quota(data)
            return True, ''
        if data['global_chars'] + estimated_chars > GEMINI_GLOBAL_DAILY_CHARS:
            return False, '今日全局Gemini翻译额度已用完，明天重置（请使用YouTube自动翻译）'
        client_key = client_id or 'unknown'
        client_used = data['clients'].get(client_key, 0)
        if client_used + estimated_chars > per_client_limit:
            return False, '你今日的Gemini翻译额度已用完，明天重置（请使用YouTube自动翻译，或购买高级版提升额度）'
        data['global_chars'] += estimated_chars
        data['clients'][client_key] = client_used + estimated_chars
        _save_quota(data)
        return True, ''

# ASR 结果缓存（后台任务完成后存这里，客户端轮询获取）
_asr_results_cache = {}  # {video_id: [(seg_idx, asr_segments), ...]}


def calculate_base_rate(segments, target_chars_per_sec=4.3):
    """
    计算全局基准语速（实时配音用）。

    原理：统计整个视频的中文字数和总"有字幕"时长，计算出"平均字/秒"，
    然后根据目标语速算出需要的 TTS 速率偏移。

    之前的两个问题（导致配音系统性偏快）：
    ① target_chars_per_sec 用的是 3.2——但 edge-tts 中文语音 +0%（不调速）时
       自然语速本身就接近 4.0 字/秒（跟 content.js:calcBaseRatePct 用的基准一致）。
       拿 3.2 当目标去算偏移，等于哪怕字幕密度刚好等于 TTS 自然语速，也会被
       错误地算出 +25% 左右的提速，每个视频都被系统性地配快了。
    ② total_time 用"最后一段结束-第一段开始"，会把中间的停顿/无对白时间也算进
       "说话时长"，拉低算出来的字/秒——这个方向上会偏慢，跟①方向相反、互相抵消，
       使问题更难发现。现在改成逐段累加各自的 (end-start)，不含段间空隙，更准。

    2026-06 用户反馈：改完①②后配音整体还是普遍偏"赶"——大部分真实视频的字幕密度
    本就经常略高于 4.0 字/秒（翻译后中文比原文啰嗦、又要塞进原时间窗），所以算出来的
    rate_pct 仍然频繁是正数。用户要的是"正常、略快"，不是"赶"，所以：
    ③ target 从 4.0 上调到 4.3——同样的字幕密度，算出的提速幅度会更小，
       只有明显偏密的视频才会被调快，一般视频更接近不调速的自然语速。
    ④ 上限从 +50% 收紧到 +25%——封住"赶"那种明显能听出来的极端提速，
       即使个别视频字幕特别密，最多也只是"略快"，不会到难受的程度。
       下限维持 -30%（字幕稀疏时放慢不算这次反馈的问题，不动）。

    Args:
        segments: 字幕段列表，每个段需有 'translation', 'start', 'end'
        target_chars_per_sec: 目标语速（比 edge-tts 自然语速略宽松，故意减少触发提速的频率）

    Returns:
        base_rate_pct: 整数百分比，如 +20（表示快 20%）
    """
    valid_segs = [s for s in segments if 'translation' in s and s.get('translation', '').strip()]
    if not valid_segs:
        return 0

    total_chars = 0
    total_time = 0.0
    for seg in valid_segs:
        dur = seg['end'] - seg['start']
        if dur <= 0:
            continue
        total_chars += len(seg['translation'])
        total_time += dur

    if total_time <= 0 or total_chars < 5:
        return 0

    actual_chars_per_sec = total_chars / total_time
    rate_pct = int((actual_chars_per_sec / target_chars_per_sec - 1) * 100)

    # 上限收紧到 +25%（避免"赶"），下限维持 -30%。
    rate_pct = max(-30, min(25, rate_pct))

    return rate_pct

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(message)s',
    handlers=[
        logging.FileHandler(LOG_PATH, encoding='utf-8'),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger('live_dub')

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Chrome Private Network Access：公共网站请求 127.0.0.1 时需要此头
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse

class PrivateNetworkMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        if request.method == "OPTIONS":
            resp = StarletteResponse(status_code=204)
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Methods"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "*"
            resp.headers["Access-Control-Allow-Private-Network"] = "true"
            return resp
        resp = await call_next(request)
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp

app.add_middleware(PrivateNetworkMiddleware)
app.mount("/audio", StaticFiles(directory=LIVE_TEMP_DIR), name="audio")


@app.post("/save_diagnostic_log")
async def save_diagnostic_log(request: Request):
    """接收插件当前播放轮次的诊断账本，固定写到插件目录，便于长视频复盘。"""
    try:
        data = await request.json()
        payload = data.get('payload')
        if not isinstance(payload, dict):
            return JSONResponse(status_code=400, content={'ok': False, 'error': 'payload 必须是对象'})

        requested = str(data.get('filename') or '').strip()
        safe_name = os.path.basename(requested)
        safe_name = re.sub(r'[\\/:*?"<>|]+', '_', safe_name).strip(' ._')
        if not safe_name:
            safe_name = f"{payload.get('videoId') or 'video'}_{int(time.time())}_diaglog.json"
        if not safe_name.lower().endswith('.json'):
            safe_name += '.json'
        safe_name = safe_name[:180]

        os.makedirs(DIAGNOSTIC_LOG_DIR, exist_ok=True)
        path = os.path.join(DIAGNOSTIC_LOG_DIR, safe_name)
        payload['savedAt'] = datetime.now(timezone.utc).isoformat()
        payload['savedReason'] = str(data.get('reason') or 'session')[:80]
        temp_path = path + '.tmp'
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)
        log.info('[诊断日志] 已保存 %s', path)
        return {'ok': True, 'filename': safe_name, 'path': path}
    except Exception as e:
        log.exception('[诊断日志] 保存失败')
        return JSONResponse(status_code=500, content={'ok': False, 'error': str(e)})


class RawSeg(BaseModel):
    start: float
    end: float
    text: str
    voice: str | None = None  # 前端说话人分析指定的 TTS 声音
    source_key: str | None = Field(default=None, alias='_sourceKey')
    source_start: float | None = Field(default=None, alias='_sourceStart')
    source_end: float | None = Field(default=None, alias='_sourceEnd')
    source_text: str | None = Field(default=None, alias='_sourceText')
    source_index: int | None = Field(default=None, alias='_sourceIndex')


class DubRequest(BaseModel):
    video_id: str
    title: str = 'untitled'
    segments: list[RawSeg]
    base_rate_pct: int = 0  # 全视频基准语速偏移（%），由客户端从字幕字数/秒算出
    read_mode: bool = False  # 朗读模式：原文照读，不翻译、不术语校正，语音按字幕语言自动选
    lang: str = 'zh-CN'  # 朗读语言：zh-CN/en-US/de/fr/es/ja/ko 等
    use_gemini_translate: bool = False  # 用户在弹窗勾选"Gemini翻译"：YouTube自动翻译质量太差时，
    # 改用原文（不是YouTube已经翻译过的二手中文）走Gemini重新翻译，更贴近原意，但有API成本。
    client_id: str = ''  # 插件生成的随机ID（存在chrome.storage.local），用于Gemini用量按客户端限额
    request_id: str = ''  # Gemini逐句进度通道ID，由插件每批生成


_gemini_progress_cache = {}


async def _expire_gemini_progress(request_id, state, ttl_seconds=600):
    await asyncio.sleep(ttl_seconds)
    if _gemini_progress_cache.get(request_id) is state:
        _gemini_progress_cache.pop(request_id, None)


@app.get("/gemini_progress/{request_id}")
async def gemini_progress(request_id: str):
    state = _gemini_progress_cache.get(request_id)
    if not state:
        return {'items': [], 'done': False, 'missing': True}
    # 客户端已收到的音频不再留在内存中、也不在每次500ms轮询时重复传输。
    items = list(state.get('items', {}).values())
    state['items'] = {}
    done = bool(state.get('done'))
    if done:
        _gemini_progress_cache.pop(request_id, None)
    return {
        'items': items,
        'failed_starts': state.get('failed_starts', []),
        'done': done,
    }


@app.get("/health")
async def health():
    return {"ok": True}


class RedeemKeyRequest(BaseModel):
    client_id: str
    license_key: str

def _lemonsqueezy_activate(license_key, instance_name):
    """同步阻塞调用，外面用 asyncio.to_thread 跑，不卡事件循环。
    用Lemon Squeezy的License API（/v1/licenses/activate）——这个接口设计上就是
    给客户端/脚本直接调的，靠license_key本身当凭证，不需要带账号级的API Key。
    activate 跟 validate 的区别：activate 会真正"占用"一个激活名额（受后台设的
    激活次数上限限制），同一个 client_id 重复调用幂等（Lemon Squeezy 自己处理），
    用 activate 而不是 validate 是为了防止一个授权码被无限多个 client_id 共享。"""
    import urllib.request
    import urllib.error
    body = json.dumps({'license_key': license_key, 'instance_name': instance_name}).encode('utf-8')
    req = urllib.request.Request(
        'https://api.lemonsqueezy.com/v1/licenses/activate',
        data=body, method='POST',
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode('utf-8')), resp.status
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode('utf-8')), e.code
        except Exception:
            return {'error': str(e)}, e.code

@app.post("/redeem_key")
async def redeem_key(req: RedeemKeyRequest):
    """用户在插件弹窗输入授权码后调这个接口：激活成功就把 client_id 标记为付费，
    解锁更高的每日Gemini翻译额度。"""
    if not req.client_id or not req.license_key.strip():
        return JSONResponse(status_code=400, content={'ok': False, 'error': '缺少client_id或授权码'})
    try:
        data, status = await asyncio.to_thread(_lemonsqueezy_activate, req.license_key.strip(), req.client_id)
    except Exception as e:
        log.error(f'[授权] 调用Lemon Squeezy失败: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=502, content={'ok': False, 'error': '授权服务器暂时无法访问，请稍后重试'})

    if status != 200 or not data.get('activated'):
        err = data.get('error') or (data.get('license_key') or {}).get('status') or '授权码无效或已失效'
        log.warning(f'[授权] 激活失败 client={req.client_id!r} status={status}: {err}')
        return JSONResponse(status_code=400, content={'ok': False, 'error': str(err)})

    lk = data.get('license_key') or {}
    meta = data.get('meta') or {}
    # 校验这个授权码确实是咱们自己这个产品的，不是随便哪个Lemon Squeezy授权码都收
    if LEMONSQUEEZY_PRODUCT_ID and meta.get('product_id') and meta.get('product_id') != LEMONSQUEEZY_PRODUCT_ID:
        log.warning(f'[授权] 授权码product_id不匹配 client={req.client_id!r} got={meta.get("product_id")}')
        return JSONResponse(status_code=400, content={'ok': False, 'error': '这个授权码不属于本产品'})

    async with _license_lock:
        licenses = _load_licenses()
        licenses[req.client_id] = {
            'license_key': req.license_key.strip(),
            'activated_at': lk.get('created_at'),
            'expires_at': lk.get('expires_at'),  # 订阅型授权码到期会有值，永久授权是null
            'instance_id': (data.get('instance') or {}).get('id'),
        }
        _save_licenses(licenses)
    log.info(f'[授权] 激活成功 client={req.client_id!r} expires_at={lk.get("expires_at")}')
    return {'ok': True, 'expires_at': lk.get('expires_at')}


@app.get("/license_status/{client_id}")
async def license_status(client_id: str):
    """弹窗打开时查一下当前是不是已经激活过，不用每次都要求重新输入授权码。"""
    return {'paid': is_client_paid(client_id)}


@app.post("/clear_cache")
async def clear_cache(req: Request):
    """清除指定视频的翻译缓存和TTS音频，下次配音时强制重新翻译合成。"""
    body = await req.json()
    video_id = body.get('video_id', '').strip()
    if not video_id:
        return JSONResponse(status_code=400, content={'error': 'video_id is required'})
    video_dir = os.path.join(LIVE_TEMP_DIR, video_id)
    if not os.path.isdir(video_dir):
        return {'cleared': 0, 'message': '无缓存可清除'}
    import glob, shutil
    cleared = 0
    for pattern in ('translations.json', 'tts_cache.json', 'seg_*.mp3', 'seg_*.mp4'):
        for f in glob.glob(os.path.join(video_dir, pattern)):
            try:
                os.remove(f)
                cleared += 1
            except Exception:
                pass
    log.info(f"已清除缓存 video_id={video_id}，删除 {cleared} 个文件")
    return {'cleared': cleared, 'message': f'已清除 {cleared} 个缓存文件'}


# ===== 术语表：把 YouTube 机翻常见误译校正为正确中文术语 =====
# 读取「术语表」文件夹的 CSV（列：中文 / 常见误译，|分隔），构建 {误译: 中文} 映射。
# 配音前对字幕中文做替换，零 API、实时可用；批量与实时都走 /dub，故统一在此处理。
_glossary_cache = {'keys': None, 'map': None, 'mtime': 0, 'file_of': None,
                   'zh_by_file': None, 'always_replace': None}

def load_glossary():
    import csv as _csv
    import glob as _glob
    gdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'glossary')
    if not os.path.isdir(gdir):
        return [], {}
    files = [f for f in _glob.glob(os.path.join(gdir, '*.csv'))
             if not os.path.basename(f).startswith('-')]  # 以 - 开头的为弃用文件
    latest = max((os.path.getmtime(f) for f in files), default=0)
    if _glossary_cache['map'] is not None and latest <= _glossary_cache['mtime']:
        return _glossary_cache['keys'], _glossary_cache['map']
    mapping = {}
    file_of = {}        # 误译词 -> 来源csv文件名，供 apply_glossary 做"同主题共现"判断
    zh_by_file = {}      # 文件名 -> 该文件里全部"中文"正确译名集合
    always_replace = set()  # CSV“强制替换=是”：明确牌名无需其它主题词共现
    for f in files:
        fname = os.path.basename(f)
        try:
            with open(f, encoding='utf-8-sig') as fp:
                for row in _csv.DictReader(fp):
                    correct = (row.get('中文') or '').strip()
                    if not correct:
                        continue
                    zh_by_file.setdefault(fname, set()).add(correct)
                    wrongs = (row.get('常见误译') or '').strip()
                    if not wrongs:
                        continue
                    for w in wrongs.split('|'):
                        w = w.strip()
                        if w and w != correct:
                            mapping[w] = correct
                            file_of[w] = fname
                            if (row.get('强制替换') or '').strip().lower() in ('是', 'true', '1', 'yes'):
                                always_replace.add(w)
        except Exception as e:
            log.warning(f'[术语表] 读取 {os.path.basename(f)} 失败: {e}')
    # 误译按长度从长到短替换，避免短词先替换破坏长词
    keys = sorted(mapping, key=len, reverse=True)
    _glossary_cache.update({'keys': keys, 'map': mapping, 'mtime': latest,
                             'file_of': file_of, 'zh_by_file': zh_by_file,
                             'always_replace': always_replace})
    log.info(f'[术语表] 加载 {len(mapping)} 条误译映射')
    return keys, mapping

def collapse_repeated_yes(text):
    """只压缩连续“是的”口头重复：是的，是的 / 是的。是的 / 是的是的 → 是的。"""
    if not text:
        return text
    text = re.sub(r'(^|[，。！？、,.!?；;\s]+)是的(?:[，。！？、,.!?；;\s]*是的){1,}(?=([，。！？、,.!?；;\s]|$))',
                  lambda m: f"{m.group(1)}是的", text)
    return re.sub(r'(^|[，。！？、,.!?；;\s]+)(?:是的){2,}(?=([，。！？、,.!?；;\s]|$))',
                  lambda m: f"{m.group(1)}是的", text)


def count_standalone_yes(text):
    return len(re.findall(r'(^|[，。！？、,.!?；;\s]+)是的(?=([，。！？、,.!?；;\s]|$))',
                          text or ''))


def strip_standalone_yes_filler(text):
    if not text:
        return text
    text = re.sub(r'(^|[，。！？、,.!?；;\s]+)是的(?=([，。！？、,.!?；;\s]|$))([，。！？、,.!?；;\s]*)',
                  lambda m: m.group(1) or '', text)
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'\s+([，。！？、,.!?；;])', r'\1', text)
    text = re.sub(r'([，。！？、,.!?；;])\1+', r'\1', text)
    return re.sub(r'^[，。！？、,.!?；;\s]+|[，。！？、,.!?；;\s]+$', '', text).strip()


def _cjk_len(text):
    return sum(1 for ch in (text or '') if '\u4e00' <= ch <= '\u9fff')


def is_yes_tight_window(seg, field='text'):
    text = seg.get(field) or ''
    if count_standalone_yes(text) <= 0:
        return False
    dur = float(seg.get('duration') or max((seg.get('end') or seg.get('start') or 0) - (seg.get('start') or 0), 0.2))
    dur = max(dur, 0.2)
    return (_cjk_len(text) / dur > 4.8) or (dur < 1.6 and _cjk_len(text) >= 5)


def prune_excess_yes_fillers(segments, field='text', label='字幕'):
    if not segments:
        return 0
    yes_count = sum(count_standalone_yes(s.get(field) or '') for s in segments)
    yes_seg_count = sum(1 for s in segments if count_standalone_yes(s.get(field) or '') > 0)
    context_heavy = yes_count >= 5 and yes_seg_count / max(len(segments), 1) >= 0.08
    changed = 0
    for seg in segments:
        text = collapse_repeated_yes(seg.get(field) or '')
        if count_standalone_yes(text) and (context_heavy or is_yes_tight_window({**seg, field: text}, field)):
            text2 = strip_standalone_yes_filler(text)
            if text2 != text:
                text = text2
                changed += 1
        seg[field] = text
    if changed:
        log.info(f"[配音] {label}清理“是的”填充词 {changed} 处"
                 + ("（上下文高频）" if context_heavy else "（时间窗紧张）"))
    return changed


def apply_glossary(text, context_text=None):
    """误译 → 正确术语 替换。

    context_text：更大范围的上下文文本（通常是这一批/这个视频全部字幕拼起来），
    用来判断"这次替换是不是真的对题"。像"Cancer"这种词本身就有完全不相关的
    两个含义（癌症 / 巨蟹座），星座术语表为了不把占星视频里的"Cancer"错配成
    "癌症"，登记了"常见误译：癌症"，但这条规则只该在真的是占星内容时生效——
    只看孤立一句话判断不出"这是不是占星视频"，必须看上下文里有没有同一张
    术语表里的【其它】正确译名也一起出现（比如"白羊座""本命盘"），有才说明
    真的是这个主题，否则就是这个词在别的语境（比如医疗）下的正常用法，
    不该被替换（今天踩的坑：普通视频说"患了癌症"被强行替换成"患了巨蟹座"）。
    只有"多条目主题包"（同一文件登记了不止一个词，比如整张星座表）才会做这个
    门槛；只登记一个孤立专有名词的文件没有"主题"可共现，维持原样直接替换。
    不传 context_text 时退化为只用 text 自身判断（单句通常凑不齐两个共现词，
    等于默认更保守，不会比传了 context_text 更激进）。
    """
    if not text:
        return text
    text = collapse_repeated_yes(text)
    keys, mapping = load_glossary()
    if not text:
        return text
    text = re.sub(r'(?:鸡巴|鸡吧|屌|吊|阴茎|老二|生殖器)', '下体', text, flags=re.I)
    if not keys:
        return text
    ctx = context_text or text
    file_of = _glossary_cache.get('file_of') or {}
    zh_by_file = _glossary_cache.get('zh_by_file') or {}
    always_replace = _glossary_cache.get('always_replace') or set()
    for w in keys:
        if w not in text:
            continue
        f = file_of.get(w)
        others = (zh_by_file.get(f) or set()) - {mapping[w]} if f else set()
        if w not in always_replace and others and not any(o in ctx for o in others):
            continue   # 同一主题包但没有其它词共现，大概率是别的语境，跳过这条有歧义的替换
        text = text.replace(w, mapping[w])
    return collapse_repeated_yes(text)


# ===== 语言 -> TTS 语音映射（供 /dub 与 /dub_start 共用）=====
_LANG_PREFIX_VOICE = {
    'zh': dub9.TTS_VOICE, 'en': 'en-US-AriaNeural', 'de': 'de-DE-FlorianMultilingualNeural',
    'fr': 'fr-FR-DeniseNeural', 'es': 'es-ES-AlvaroNeural', 'ja': 'ja-JP-NanamiNeural',
    'ko': 'ko-KR-HyunsuMultilingualNeural', 'pt': 'pt-BR-ThalitaMultilingualNeural',
    'it': 'it-IT-GiuseppeMultilingualNeural', 'ru': 'ru-RU-DmitryNeural', 'ar': 'ar-SA-HamedNeural',
    'hi': 'hi-IN-MadhurNeural', 'af': 'af-ZA-AdriNeural', 'am': 'am-ET-AmehaNeural',
    'az': 'az-AZ-BabekNeural', 'bg': 'bg-BG-BorislavNeural', 'bn': 'bn-BD-NabanitaNeural',
    'bs': 'bs-BA-VesnaNeural', 'ca': 'ca-ES-JoanaNeural', 'cs': 'cs-CZ-AntoninNeural',
    'cy': 'cy-GB-AledNeural', 'da': 'da-DK-JeppeNeural', 'el': 'el-GR-NestorasNeural',
    'et': 'et-EE-AnuNeural', 'fa': 'fa-IR-DilaraNeural', 'fi': 'fi-FI-HarriNeural',
    'fil': 'fil-PH-AngeloNeural', 'ga': 'ga-IE-ColmNeural', 'gl': 'gl-ES-RoiNeural',
    'gu': 'gu-IN-NiranjanNeural', 'he': 'he-IL-AvriNeural', 'hr': 'hr-HR-SreckoNeural',
    'hu': 'hu-HU-TamasNeural', 'id': 'id-ID-ArdiNeural', 'is': 'is-IS-GudrunNeural',
    'iu': 'iu-Latn-CA-SiqiniqNeural', 'jv': 'jv-ID-DimasNeural', 'ka': 'ka-GE-GiorgiNeural',
    'kk': 'kk-KZ-AigulNeural', 'km': 'km-KH-PisethNeural', 'kn': 'kn-IN-GaganNeural',
    'lo': 'lo-LA-ChanthavongNeural', 'lt': 'lt-LT-LeonasNeural', 'lv': 'lv-LV-EveritaNeural',
    'mk': 'mk-MK-AleksandarNeural', 'ml': 'ml-IN-MidhunNeural', 'mn': 'mn-MN-BataaNeural',
    'mr': 'mr-IN-AarohiNeural', 'ms': 'ms-MY-OsmanNeural', 'mt': 'mt-MT-GraceNeural',
    'my': 'my-MM-NilarNeural', 'nb': 'nb-NO-FinnNeural', 'ne': 'ne-NP-HemkalaNeural',
    'nl': 'nl-NL-MaartenNeural', 'pl': 'pl-PL-MarekNeural', 'ps': 'ps-AF-GulNawazNeural',
    'ro': 'ro-RO-AlinaNeural', 'si': 'si-LK-SameeraNeural', 'sk': 'sk-SK-LukasNeural',
    'sl': 'sl-SI-RokNeural', 'so': 'so-SO-MuuseNeural', 'sq': 'sq-AL-IlirNeural',
    'sr': 'sr-RS-NicholasNeural', 'su': 'su-ID-JajangNeural', 'sv': 'sv-SE-MattiasNeural',
    'sw': 'sw-KE-RafikiNeural', 'ta': 'ta-IN-ValluvarNeural', 'te': 'te-IN-MohanNeural',
    'th': 'th-TH-NiwatNeural', 'tr': 'tr-TR-AhmetNeural', 'uk': 'uk-UA-OstapNeural',
    'ur': 'ur-PK-AsadNeural', 'uz': 'uz-UZ-MadinaNeural', 'vi': 'vi-VN-NamMinhNeural',
    'zu': 'zu-ZA-ThandoNeural',
}
_FULL_VOICE_MAP = {
    'zh-tw': 'zh-TW-HsiaoChenNeural', 'zh-hk': 'zh-HK-HiuGaaiNeural',
    'zh-hant': 'zh-TW-HsiaoChenNeural', 'zh-hans': dub9.TTS_VOICE, 'zh-cn': dub9.TTS_VOICE,
    'en-us': 'en-US-AriaNeural', 'en-gb': 'en-GB-SoniaNeural', 'en-au': 'en-AU-NatashaNeural',
    'pt-br': 'pt-BR-ThalitaMultilingualNeural', 'pt-pt': 'pt-PT-RaquelNeural',
    'es-mx': 'es-MX-DaliaNeural', 'fr-ca': 'fr-CA-SylvieNeural',
}


def _prepare_dub_segments(req: 'DubRequest'):
    """共享预处理：去重、估算时长、选语音、术语校正、算基准语速。

    朗读项目不做翻译：字幕已经是 /prefetch_captions 按用户选的目标语言抓回来的，
    这里只是原文照读（中文目标时额外做一次术语校正）。翻译留给以后的"配音"项目。"""
    segments = [{
        'start': s.start, 'end': s.end, 'text': s.text,
        '_sourceKey': s.source_key,
        '_sourceStart': s.source_start if s.source_start is not None else s.start,
        '_sourceEnd': s.source_end if s.source_end is not None else s.end,
        '_sourceText': s.source_text or s.text,
        '_sourceIndex': s.source_index,
        **(({'voice': s.voice}) if s.voice else {}),
    } for s in req.segments]
    segments = dub9.dedupe_rolling_overlap(segments)
    segments = dub9.estimate_durations(segments)

    req_lang_full = (req.lang or 'en').lower()
    req_lang_prefix = req_lang_full.split('-')[0]
    tts_voice = (_FULL_VOICE_MAP.get(req_lang_full)
                 or _LANG_PREFIX_VOICE.get(req_lang_prefix)
                 or 'en-US-AriaNeural')

    # 同主题共现判断需要"这个视频全部字幕拼起来"的上下文，不能只看单句
    # （见 apply_glossary 文档字符串），这里在循环外拼一次，所有句子共用。
    _zh_context = ' '.join(s['text'] for s in segments) if req_lang_prefix == 'zh' else None
    for seg in segments:
        if req_lang_prefix == 'zh':
            seg['text'] = apply_glossary(seg['text'], _zh_context)
        seg['translation'] = seg['text']

    if req.base_rate_pct == 0:
        req.base_rate_pct = calculate_base_rate(segments)

    return segments, tts_voice, req.base_rate_pct


# ===== 增量配音（供 Web 应用轮询进度、提前拿到前几句用于同步播放）=====
_dub_progress_cache = {}  # {video_id: {'completed': [...], 'total': N, 'done': False, 'error': None}}


async def _run_dub_incremental(video_id, segments, tts_voice, title, base_rate_pct, video_dir):
    cache = _dub_progress_cache[video_id]
    valid_segments = [s for s in segments if (s.get('translation') or '').strip()]
    cache['total'] = len(valid_segments)
    semaphore = asyncio.Semaphore(3)

    tts_cache_path = os.path.join(video_dir, 'tts_cache.json')
    tts_cache = {}
    if os.path.exists(tts_cache_path):
        try:
            with open(tts_cache_path, 'r', encoding='utf-8') as f:
                tts_cache = json.load(f)
        except Exception:
            pass

    async def run_one(seg):
        async with semaphore:
            try:
                seg_voice = seg.get('voice') or tts_voice
                await dub9.synthesize_segment(seg, seg_voice, tts_cache, title, base_rate_pct, temp_dir=video_dir)
            except Exception as e:
                log.warning(f"[增量配音] 段落失败 start={seg.get('start')}: {e}")
                return
            if 'audio_path' in seg and os.path.exists(seg['audio_path']):
                fname = os.path.basename(seg['audio_path'])
                cache['completed'].append({
                    'start': seg['start'],
                    'duration': seg['duration'],
                    'tts_duration': seg.get('tts_duration', seg['duration']),
                    'text': seg['text'],
                    'translation': seg.get('translation', ''),
                    '_sourceKey': seg.get('_sourceKey'),
                    '_sourceStart': seg.get('_sourceStart', seg.get('start')),
                    '_sourceEnd': seg.get('_sourceEnd', seg.get('end')),
                    '_sourceText': seg.get('_sourceText', seg.get('text')),
                    '_sourceIndex': seg.get('_sourceIndex'),
                    'audio_url': f"/audio/{video_id}/{fname}",
                })
                cache['completed'].sort(key=lambda x: (x.get('_sourceIndex') is None, x.get('_sourceIndex') or 0, x['start']))

    try:
        await asyncio.gather(*[run_one(s) for s in valid_segments])
    except Exception as e:
        cache['error'] = str(e)
        log.error(f"[增量配音] 失败 video_id={video_id}: {e}\n{traceback.format_exc()}")
    finally:
        # 之前这个写盘操作在 try 块里、紧跟在 gather 成功之后——一旦这批请求中途失败
        # /超时/被取消（长视频经常发生），tts_cache.json 就永远不会更新，即使这次已经
        # 合成好了一部分片段（.mp3文件已经写在磁盘上）。下次重新配音时，synthesize_segment
        # 的缓存命中检查靠的是tts_cache.json里的记录，不是文件是否存在——查不到记录就会
        # 直接删掉这个明明是好的mp3、重新调TTS合成一遍。用户反馈：长视频反复配不完、
        # 每次重新配音都要把前面全部句子重新合成一遍，正是这个bug。
        # 挪到finally，保证不管这批是成功、部分失败还是异常，已经合成出来的片段的缓存
        # 记录都会被保存下来，下次重试只需要补合成真正缺失的那些。
        try:
            with open(tts_cache_path, 'w', encoding='utf-8') as f:
                json.dump(tts_cache, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log.warning(f"[增量配音] 保存 tts_cache.json 失败: {e}")
        cache['done'] = True


async def _prepare_and_run_dub(req: 'DubRequest', video_dir):
    cache = _dub_progress_cache[req.video_id]
    try:
        segments, tts_voice, base_rate_pct = _prepare_dub_segments(req)
        cache['total'] = len(segments)
        log.info(f"[增量配音] 预处理完成 video_id={req.video_id} 共 {len(segments)} 段，"
                 f"语音={tts_voice} 基准语速={base_rate_pct:+d}%")
        await _run_dub_incremental(req.video_id, segments, tts_voice, req.title, base_rate_pct, video_dir)
    except Exception as e:
        cache['error'] = str(e)
        cache['done'] = True
        log.error(f"[增量配音] 预处理失败 video_id={req.video_id}: {e}\n{traceback.format_exc()}")


@app.post("/dub_start")
async def dub_start(req: DubRequest):
    """启动增量配音：立即返回，后台（含可能的翻译）逐句合成，前端轮询 /dub_progress 获取进度。"""
    log.info(f"[增量配音] 收到请求 video_id={req.video_id} title={req.title!r} 字幕条数={len(req.segments)}")
    try:
        video_dir = os.path.join(LIVE_TEMP_DIR, req.video_id)
        os.makedirs(video_dir, exist_ok=True)
        _save_video_cache_meta(req.video_id, req.title)
        # 不再写 dub9.TEMP_DIR 这个全局变量——并发处理多个视频时会被互相覆盖，
        # 导致音频文件/缓存串到别的视频上（比如A视频男声、B视频女声变成混着播）。
        # 改成把 video_dir 一路当参数传下去，见 _prepare_and_run_dub/_run_dub_incremental。

        # total 先用原始字幕条数占位（去重翻译后台进行中会再刷新成真实段数）
        _dub_progress_cache[req.video_id] = {
            'completed': [], 'total': len(req.segments), 'done': False, 'error': None,
        }
        asyncio.create_task(_prepare_and_run_dub(req, video_dir))

        log.info(f"[增量配音] 已启动 video_id={req.video_id}")
        return {'ok': True, 'video_id': req.video_id, 'total': len(req.segments)}
    except Exception as e:
        log.error(f"[增量配音] 启动失败 video_id={req.video_id}: {e}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={'error': str(e)})


@app.get("/dub_progress/{video_id}")
async def dub_progress(video_id: str):
    """轮询接口：返回目前已完成的配音段落（按 start 排序）+ 总数 + 是否全部完成。"""
    cache = _dub_progress_cache.get(video_id)
    if not cache:
        return JSONResponse(status_code=404, content={'error': '未找到任务，请先调用 /dub_start'})
    return {
        'completed': cache['completed'],
        'total': cache['total'],
        'done': cache['done'],
        'error': cache['error'],
    }


@app.post("/dub")
async def dub(req: DubRequest):
    _maybe_cleanup_server_cache()
    log.info(f"收到配音请求 video_id={req.video_id} title={req.title!r} "
             f"字幕条数={len(req.segments)}")
    # 全局并发上限：超过就直接告诉客户端"服务器繁忙"，不让请求堆积排队——
    # 今天卡死的事故就是某个请求卡住后,其它请求(包括/health)全部被一起堵死，
    # 这里限制同时处理的/dub请求数量，宁可让用户晚点重试，不要让整个服务器陪着一起卡死。
    try:
        await asyncio.wait_for(_dub_concurrency_sem.acquire(), timeout=3.0)
    except asyncio.TimeoutError:
        log.warning(f"[配音] 服务器繁忙，拒绝请求 video_id={req.video_id}")
        return JSONResponse(status_code=429, content={'error': '服务器繁忙，请稍后重试'})
    try:
        video_dir = os.path.join(LIVE_TEMP_DIR, req.video_id)
        os.makedirs(video_dir, exist_ok=True)
        _save_video_cache_meta(req.video_id, req.title)
        _touch_video_cache_dir(req.video_id)
        # 不写全局 dub9.TEMP_DIR，video_dir 显式传给下面的 synthesize_all（temp_dir=）。

        segments = [{
            'start': s.start, 'end': s.end, 'text': s.text,
            '_sourceKey': s.source_key,
            '_sourceStart': s.source_start if s.source_start is not None else s.start,
            '_sourceEnd': s.source_end if s.source_end is not None else s.end,
            '_sourceText': s.source_text or s.text,
            '_sourceIndex': s.source_index,
            **(({'voice': s.voice}) if s.voice else {}),
        } for s in req.segments]
        voiced = [(s.start, s.voice) for s in req.segments if s.voice]
        if voiced:
            log.info(f"收到 per-segment voice 分配 {len(voiced)} 条: {voiced[:4]}...")
        segments = dub9.dedupe_rolling_overlap(segments)
        segments = dub9.estimate_durations(segments)

        # 检测语言（CJK字符占比>30% 视为中文）。勾了"Gemini翻译"时这个检测不作数——
        # 客户端这次发的是故意要的原文，日语/韩语本身大量用汉字，同样会让这个简单的
        # 字符范围判断误判成"已经是中文"，导致该走Gemini重翻译的反而被当中文照读。
        sample = ' '.join(s['text'] for s in segments[:8])
        cjk_ratio = sum(1 for c in sample if '一' <= c <= '鿿') / max(len(sample), 1)
        already_chinese = (not req.use_gemini_translate) and cjk_ratio > 0.3

        # 两个模式都不翻译，直接用平台字幕：根据字幕语言选对应的 TTS 语音
        # 完整覆盖 edge-tts 支持的 70 种语言（用 list_voices 枚举后取最优声音）
        lang_prefix_voice = {
            'zh': dub9.TTS_VOICE,
            'en': 'en-US-AriaNeural',
            'de': 'de-DE-FlorianMultilingualNeural',
            'fr': 'fr-FR-DeniseNeural',
            'es': 'es-ES-AlvaroNeural',
            'ja': 'ja-JP-NanamiNeural',
            'ko': 'ko-KR-HyunsuMultilingualNeural',
            'pt': 'pt-BR-ThalitaMultilingualNeural',
            'it': 'it-IT-GiuseppeMultilingualNeural',
            'ru': 'ru-RU-DmitryNeural',
            'ar': 'ar-SA-HamedNeural',
            'hi': 'hi-IN-MadhurNeural',
            'af': 'af-ZA-AdriNeural',
            'am': 'am-ET-AmehaNeural',
            'az': 'az-AZ-BabekNeural',
            'bg': 'bg-BG-BorislavNeural',
            'bn': 'bn-BD-NabanitaNeural',
            'bs': 'bs-BA-VesnaNeural',
            'ca': 'ca-ES-JoanaNeural',
            'cs': 'cs-CZ-AntoninNeural',
            'cy': 'cy-GB-AledNeural',
            'da': 'da-DK-JeppeNeural',
            'el': 'el-GR-NestorasNeural',
            'et': 'et-EE-AnuNeural',
            'fa': 'fa-IR-DilaraNeural',
            'fi': 'fi-FI-HarriNeural',
            'fil': 'fil-PH-AngeloNeural',
            'ga': 'ga-IE-ColmNeural',
            'gl': 'gl-ES-RoiNeural',
            'gu': 'gu-IN-NiranjanNeural',
            'he': 'he-IL-AvriNeural',
            'hr': 'hr-HR-SreckoNeural',
            'hu': 'hu-HU-TamasNeural',
            'id': 'id-ID-ArdiNeural',
            'is': 'is-IS-GudrunNeural',
            'iu': 'iu-Latn-CA-SiqiniqNeural',
            'jv': 'jv-ID-DimasNeural',
            'ka': 'ka-GE-GiorgiNeural',
            'kk': 'kk-KZ-AigulNeural',
            'km': 'km-KH-PisethNeural',
            'kn': 'kn-IN-GaganNeural',
            'lo': 'lo-LA-ChanthavongNeural',
            'lt': 'lt-LT-LeonasNeural',
            'lv': 'lv-LV-EveritaNeural',
            'mk': 'mk-MK-AleksandarNeural',
            'ml': 'ml-IN-MidhunNeural',
            'mn': 'mn-MN-BataaNeural',
            'mr': 'mr-IN-AarohiNeural',
            'ms': 'ms-MY-OsmanNeural',
            'mt': 'mt-MT-GraceNeural',
            'my': 'my-MM-NilarNeural',
            'nb': 'nb-NO-FinnNeural',
            'ne': 'ne-NP-HemkalaNeural',
            'nl': 'nl-NL-MaartenNeural',
            'pl': 'pl-PL-MarekNeural',
            'ps': 'ps-AF-GulNawazNeural',
            'ro': 'ro-RO-AlinaNeural',
            'si': 'si-LK-SameeraNeural',
            'sk': 'sk-SK-LukasNeural',
            'sl': 'sl-SI-RokNeural',
            'so': 'so-SO-MuuseNeural',
            'sq': 'sq-AL-IlirNeural',
            'sr': 'sr-RS-NicholasNeural',
            'su': 'su-ID-JajangNeural',
            'sv': 'sv-SE-MattiasNeural',
            'sw': 'sw-KE-RafikiNeural',
            'ta': 'ta-IN-ValluvarNeural',
            'te': 'te-IN-MohanNeural',
            'th': 'th-TH-NiwatNeural',
            'tr': 'tr-TR-AhmetNeural',
            'uk': 'uk-UA-OstapNeural',
            'ur': 'ur-PK-AsadNeural',
            'uz': 'uz-UZ-MadinaNeural',
            'vi': 'vi-VN-NamMinhNeural',
            'zu': 'zu-ZA-ThandoNeural',
        }
        # 完整语言码精确匹配（处理 zh-TW/zh-HK/zh-Hans 等变体）
        full_voice_map = {
            'zh-tw':   'zh-TW-HsiaoChenNeural',   # 繁体中文（台湾）
            'zh-hk':   'zh-HK-HiuGaaiNeural',     # 粤语（香港）
            'zh-hant': 'zh-TW-HsiaoChenNeural',   # 繁体中文（通用）
            'zh-hans': dub9.TTS_VOICE,             # 简体中文
            'zh-cn':   dub9.TTS_VOICE,             # 简体中文
            'en-us':   'en-US-AriaNeural',
            'en-gb':   'en-GB-SoniaNeural',
            'en-au':   'en-AU-NatashaNeural',
            'pt-br':   'pt-BR-ThalitaMultilingualNeural',
            'pt-pt':   'pt-PT-RaquelNeural',
            'es-mx':   'es-MX-DaliaNeural',
            'fr-ca':   'fr-CA-SylvieNeural',
        }
        req_lang_full = (req.lang or 'en').lower()
        req_lang_prefix = req_lang_full.split('-')[0]
        tts_voice = (full_voice_map.get(req_lang_full)
                     or lang_prefix_voice.get(req_lang_prefix)
                     or 'en-US-AriaNeural')
        log.info(f"字幕语言: {req.lang!r} → 完整匹配={full_voice_map.get(req_lang_full,'无')} 前缀匹配={lang_prefix_voice.get(req_lang_prefix,'无')} → TTS: {tts_voice}")
        already_synthesized = False  # Gemini流式分支会边译边合成，不再走下面统一的 synthesize_all
        gemini_quota_message = None  # 用量超额时的提示文案，告诉客户端"为什么没声音"
        if already_chinese:
            # 中文字幕：术语校正（把误译替换成正确术语，如"阅读"→"占卜"）
            # 同主题共现判断要看"这个视频全部字幕拼起来"的上下文，不能只看单句
            # （见 apply_glossary 文档字符串），循环外拼一次，所有句子共用。
            _zh_context = ' '.join(s['text'] for s in segments)
            for seg in segments:
                seg['text'] = apply_glossary(seg['text'], _zh_context)
                seg['translation'] = seg['text']
            prune_excess_yes_fillers(segments, 'text', '中文字幕')
            for seg in segments:
                seg['translation'] = seg['text']
            log.info(f"配音模式：中文字幕 {len(segments)} 段，术语校正已应用")
        elif req.use_gemini_translate and not req.read_mode:
            progress_state = None
            if req.request_id:
                progress_state = {'items': {}, 'failed_starts': [], 'done': False}
                _gemini_progress_cache[req.request_id] = progress_state
                asyncio.create_task(_expire_gemini_progress(req.request_id, progress_state))
            # 用户勾选了"Gemini翻译"：YouTube自动翻译（尤其日语→中文这类二手翻译）质量
            # 经常很差，这里改用原文（客户端这次发的就是原文，不是YT已经翻译过的版本）
            # 重新走Gemini翻译，更贴近原意。只在配音模式生效（朗读模式本来就是原文照读，
            # 不应该被悄悄改成翻译）。
            #
            # 先检查用量配额——服务器是所有装了插件的人共用的，没有账号体系，不限额
            # 的话一两个重度用户就能把Gemini账单和免费额度耗光。超额时不偷偷退回原文
            # 照读（拿原文喂中文TTS音色念出来会很怪、用户很难察觉），而是跟"翻译失败"
            # 共用同一套"不产出语音+暂停+明确提示"机制，只是提示文案换成额度说明。
            estimated_chars = sum(len(s['text']) for s in segments)
            quota_ok, quota_msg = await check_and_reserve_gemini_quota(req.client_id, estimated_chars)
            if not quota_ok:
                log.warning(f"[配音] Gemini翻译额度超限 client={req.client_id!r}: {quota_msg}")
                for seg in segments:
                    seg['_translate_failed'] = True
                gemini_quota_message = quota_msg
                if progress_state:
                    progress_state['failed_starts'] = [s['start'] for s in segments]
                    progress_state['done'] = True
                already_synthesized = True
            else:
                # 用流式翻译（dub9.translate_segments_streaming）：整批原文一次性发给Gemini
                # （带上按原文匹配命中的术语参考，只注入一次），但不等它全部翻完——每凑齐
                # 一行译文，立刻在 on_segment_ready 回调里把对应这一句的TTS合成任务排进去，
                # 跟"Gemini还在继续流式生成后面的句子"同时进行。这样省掉了旧版按2/6/10句
                # 切碎、每碎片单独发一次Gemini请求的开销（没有整段上下文、术语提示也要重复发），
                # 同时不必等整批翻完才开始合成语音——第一句译文出来就能立刻开始配音。
                #
                # 注意：基准语速(base_rate_pct)平时是翻译完成后根据全部译文字数算出来的全局
                # 匀速值，但这里TTS跟翻译是交叉进行的，算不出这个"全局"值，只能让每句各自用
                # 自然语速（0%），牺牲掉"全视频统一匀速"这个细节优化，换取尽快出声这个更重要
                # 的实时体验。
                log.info(f"配音模式：用户勾选Gemini翻译，对原文 {len(segments)} 段流式翻译+边译边合成…")
                tts_voice = dub9.TTS_VOICE  # Gemini翻译目标固定是中文，TTS也固定用中文音色
                tts_cache_path = os.path.join(video_dir, 'tts_cache.json')
                tts_cache = {}
                if os.path.exists(tts_cache_path):
                    try:
                        with open(tts_cache_path, 'r', encoding='utf-8') as f:
                            tts_cache = json.load(f)
                    except Exception:
                        pass
                synth_semaphore = asyncio.Semaphore(6)
                synth_tasks = []
                gemini_seen = 0
                gemini_yes = 0
                gemini_yes_segments = 0

                async def _synth_one(seg):
                    async with synth_semaphore:
                        try:
                            # 跟 synthesize_all 里的 run_with_sem 一样，要先看这一句有没有
                            # 客户端指定的专属音色（用户在弹窗"语言↔配音员"里选的、或多人
                            # 配音分配的），没有才退回默认tts_voice——漏了这一步会导致这条
                            # Gemini翻译路径强制用默认音色，跟普通路径的音色选择对不上，
                            # 表现就是"一会儿用户选的音色、一会儿又变成默认音色"。
                            seg_voice = seg.get('voice') or tts_voice
                            await dub9.synthesize_segment(seg, seg_voice, tts_cache, req.title, 0, temp_dir=video_dir)
                            if progress_state and seg.get('audio_path') and os.path.exists(seg['audio_path']):
                                fname = os.path.basename(seg['audio_path'])
                                with open(seg['audio_path'], 'rb') as af:
                                    audio_b64 = base64.b64encode(af.read()).decode('ascii')
                                progress_key = seg.get('_sourceKey') or f"{seg.get('_sourceIndex')}:{seg['start']}:{seg.get('text', '')[:24]}"
                                progress_state['items'][progress_key] = {
                                    'start': seg['start'],
                                    'duration': seg['duration'],
                                    'tts_duration': seg.get('tts_duration', seg['duration']),
                                    'text': seg['text'],
                                    'translation': seg.get('translation', ''),
                                    '_sourceKey': seg.get('_sourceKey'),
                                    '_sourceStart': seg.get('_sourceStart', seg.get('start')),
                                    '_sourceEnd': seg.get('_sourceEnd', seg.get('end')),
                                    '_sourceText': seg.get('_sourceText', seg.get('text')),
                                    '_sourceIndex': seg.get('_sourceIndex'),
                                    'audio_url': f"/audio/{req.video_id}/{fname}",
                                    'audio_b64': audio_b64,
                                }
                        except Exception as e:
                            log.warning(f"[Gemini流式配音] 段落合成失败 start={seg.get('start')}: {e}")
                            seg['_tts_failed'] = True
                            if progress_state:
                                progress_state['failed_starts'] = sorted(set(
                                    progress_state.get('failed_starts', []) + [seg['start']]))

                def _on_segment_ready(seg):
                    nonlocal gemini_seen, gemini_yes, gemini_yes_segments
                    seg['translation'] = apply_glossary(seg.get('translation', '') or seg['text'])
                    gemini_seen += 1
                    yc = count_standalone_yes(seg.get('translation') or '')
                    gemini_yes += yc
                    if yc:
                        gemini_yes_segments += 1
                    context_heavy_so_far = gemini_yes >= 5 and gemini_yes_segments / max(gemini_seen, 1) >= 0.08
                    if yc and (context_heavy_so_far or is_yes_tight_window(seg, 'translation')):
                        stripped = strip_standalone_yes_filler(seg['translation'])
                        if stripped != seg['translation']:
                            seg['translation'] = stripped
                            log.info(f"[配音] Gemini流式清理“是的”填充词 start={seg.get('start')}")
                    synth_tasks.append(asyncio.create_task(_synth_one(seg)))

                try:
                    await dub9.translate_segments_streaming(
                        segments, title=req.title, on_segment_ready=_on_segment_ready)
                    if synth_tasks:
                        await asyncio.gather(*synth_tasks)
                    log.info(f"Gemini流式翻译+合成完成，{len(segments)} 段")
                    already_synthesized = True
                except Exception as e:
                    log.error(f"Gemini流式翻译失败: {e}\n{traceback.format_exc()}")
                    # 不再退回"原文照读"——用户反馈过，拿英文喂中文TTS声音很怪但不报错，
                    # 录屏场景很难第一时间察觉，等录完逐句听才发现，代价太大。改成直接标记
                    # 失败、这批句子不产出语音，让插件那边发现"该有配音却没有"就暂停+明显
                    # 提示，而不是悄悄用坏内容混过去。already_synthesized 置 True 是为了
                    # 跳过下面统一的 synthesize_all——那条路径默认假设 seg['translation']
                    # 已存在，这里故意不设它，强行走那条路径会直接报 KeyError。
                    for seg in segments:
                        if 'translation' not in seg:
                            seg['_translate_failed'] = True
                    if progress_state:
                        progress_state['failed_starts'] = [
                            s['start'] for s in segments if s.get('_translate_failed')]
                    already_synthesized = True
                finally:
                    # 之前这个写盘操作只在 try 成功路径里——一旦翻译/合成中途失败或超时
                    # （长视频经常发生），这次已经合成好的一部分片段（.mp3已经落盘）就
                    # 永远不会被记进tts_cache.json。下次重新配音时，synthesize_segment
                    # 靠json里的记录判断"这个mp3能不能信"，查不到就会直接删掉重配——
                    # 这正是"长视频反复配不完、每次都要把前面全部重新合成一遍"的根因。
                    # 挪到finally，不管成功失败都把已合成片段的记录保存下来。
                    try:
                        with open(tts_cache_path, 'w', encoding='utf-8') as f:
                            json.dump(tts_cache, f, ensure_ascii=False, indent=2)
                    except Exception as e:
                        log.warning(f"[Gemini流式配音] 保存 tts_cache.json 失败: {e}")
                    if progress_state:
                        progress_state['failed_starts'] = [
                            s['start'] for s in segments if s.get('_translate_failed')]
                        progress_state['done'] = True
        else:
            for seg in segments:
                seg['translation'] = seg['text']  # 原文照读，无翻译
            log.info(f"朗读/配音模式：原文照读 {len(segments)} 段，语音={tts_voice}（不翻译）")
        if req.read_mode:
            log.info(f"  → 朗读模式，用户选中的字幕轨")
        # Gemini流式分支已经边译边合成过了，不要再走一遍——否则白白把刚做完的TTS
        # 用一个重新算出来的base_rate_pct全部重新合成一次，今天踩过这个坑。
        if not already_synthesized:
            # 实时配音客户端传0表示自然语速。不能再把0解释为“按当前小批次自动
            # 计算”：分批大小变化会让同一句每次得到不同base_rate，从而击穿已有
            # TTS缓存。具体时间窗由浏览器播放端按实际音频时长统一对齐。
            if req.base_rate_pct == 0:
                log.info("✓ 使用自然语速: +0%（保持跨批次缓存稳定）")
            else:
                log.info(f"✓ 使用客户端指定的基准语速: {req.base_rate_pct:+d}%")

            segments = await dub9.synthesize_all(segments, tts_voice, req.title,
                                                 base_rate_pct=req.base_rate_pct, temp_dir=video_dir)
        # ASR 识别暂时禁用，先确保字幕能显示
        # if dub9.FASTER_WHISPER_AVAILABLE:
        #     import asyncio
        #     async def run_asr_background():
        #         await dub9.add_asr_segments(segments)  # segments 是引用，后台修改会生效
        #         # 处理完后存到缓存供轮询接口返回
        #         asr_result = []
        #         for i, seg in enumerate(segments):
        #             if seg.get('asr_segments'):
        #                 asr_result.append({
        #                     'seg_idx': i,
        #                     'asr_segments': seg['asr_segments'],
        #                     'start': seg.get('start'),
        #                     'duration': seg.get('duration')
        #                 })
        #         if asr_result:
        #             _asr_results_cache[req.video_id] = asr_result
        #             log.info(f"ASR 识别完成 video_id={req.video_id} 共 {len(asr_result)} 段")
        #     asyncio.create_task(run_asr_background())
        #     log.info(f"ASR 识别已启动后台任务 video_id={req.video_id}")

        result = []
        for seg in segments:
            if 'audio_path' not in seg or not os.path.exists(seg['audio_path']):
                continue
            fname = os.path.basename(seg['audio_path'])
            item = {
                'start': seg['start'],
                'duration': seg['duration'],
                'tts_duration': seg.get('tts_duration', seg['duration']),
                'text': seg['text'],
                'translation': seg.get('translation', ''),
                '_sourceKey': seg.get('_sourceKey'),
                '_sourceStart': seg.get('_sourceStart', seg.get('start')),
                '_sourceEnd': seg.get('_sourceEnd', seg.get('end')),
                '_sourceText': seg.get('_sourceText', seg.get('text')),
                '_sourceIndex': seg.get('_sourceIndex'),
                'audio_url': f"/audio/{req.video_id}/{fname}",
            }
            # 直接把音频内容编码进返回结果，插件不用再额外发请求去取文件——避免"生成时
            # 存文件、播放时再用URL取"这两步之间服务器重启/进程被杀导致文件没了的情况
            # （云端免费档尤其容易遇到，本机长时间跑也有被手动重启撞上的风险）。
            try:
                with open(seg['audio_path'], 'rb') as f:
                    item['audio_b64'] = base64.b64encode(f.read()).decode('ascii')
            except Exception as e:
                log.warning(f"[配音] 读取音频文件失败 {seg['audio_path']}: {e}")
            # 若有 ASR 识别结果（被合并的字幕的原始行的精确时间戳），也返回
            if seg.get('asr_segments'):
                item['asr_segments'] = seg['asr_segments']
            result.append(item)
        # 输出详细的时间戳信息用于诊断
        for i, seg in enumerate(result):
            log.info(f"  段{i}: start={seg['start']:.2f}s end={seg['start']+seg['duration']:.2f}s text={seg['text'][:20]}")
        # 翻译失败的句子：不混进 result（没有audio_path，本来就不会被上面那段加进去），
        # 但要把"这批里有几句翻译失败"明确告诉客户端，让插件能暂停+提示，而不是
        # 用户什么反馈都看不到、只是莫名其妙少了几句配音。
        failed_starts = [s['start'] for s in segments
                         if s.get('_translate_failed') or s.get('_tts_failed')]
        if failed_starts:
            log.warning(f"配音完成但有翻译失败 video_id={req.video_id} 失败{len(failed_starts)}句: {failed_starts[:10]}")
        log.info(f"配音完成 video_id={req.video_id} 返回片段={len(result)}")
        return {'segments': result, 'translate_failed_starts': failed_starts,
                'gemini_quota_message': gemini_quota_message}
    except Exception as e:
        log.error(f"配音失败 video_id={req.video_id}: {e}\n{traceback.format_exc()}")
        return JSONResponse(status_code=500, content={'error': str(e)})
    finally:
        _dub_concurrency_sem.release()


@app.get("/asr_results/{video_id}")
async def get_asr_results(video_id: str):
    """轮询接口：获取指定视频的 ASR 识别结果（后台任务完成后可用）。"""
    if video_id not in _asr_results_cache:
        return {'asr_segments': {}, 'message': 'ASR 识别中或未启用'}

    result = _asr_results_cache[video_id]
    # 返回格式：{seg_key: asr_segments, ...}，方便客户端按 start 时间戳索引
    asr_map = {}
    for item in result:
        key = f"{item['start']:.2f}"  # 用 start 时间戳作 key（配合 dubSegments 匹配）
        asr_map[key] = item['asr_segments']

    log.info(f"返回 ASR 结果 video_id={video_id} 共 {len(asr_map)} 项")
    return {'asr_segments': asr_map}


@app.get("/diarize_status")
async def diarize_status():
    """检查 pyannote 是否可用及 token 是否配置。"""
    if not PYANNOTE_AVAILABLE:
        return {'available': False, 'reason': 'pyannote.audio 未安装'}
    token = _load_hf_token()
    if not token:
        return {'available': False, 'reason': '未配置 HF_TOKEN'}
    loaded = _pyannote_pipeline is not None
    return {'available': True, 'model_loaded': loaded}


@app.post("/diarize")
async def diarize_audio(request: Request):
    """接收浏览器录制的音频（WebM），用 pyannote 分离说话人，返回时间段列表。"""
    try:
        form = await request.form()
        audio_file = form.get('audio')
        num_speakers = int(form.get('num_speakers', 2))
        if not audio_file:
            return JSONResponse(status_code=400, content={'ok': False, 'error': '未收到音频数据'})

        audio_bytes = await audio_file.read()
        log.info(f'收到说话人分离请求：{len(audio_bytes)//1024}KB，预期{num_speakers}位说话人')

        # 先用 ffmpeg+soundfile 解码成内存波形，绕过 torchcodec（缺 FFmpeg DLL 会崩）
        audio_input = _decode_to_waveform(audio_bytes)
        log.info(f'音频解码完成：{audio_input["waveform"].shape[1]}采样点 @ {audio_input["sample_rate"]}Hz')

        pipeline = get_pyannote_pipeline()
        diarization = pipeline(audio_input, num_speakers=num_speakers)
        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                'start': round(turn.start, 2),
                'end': round(turn.end, 2),
                'speaker': speaker,
            })
        speakers = list({s['speaker'] for s in segments})
        log.info(f'说话人分离完成：{len(speakers)}位说话人，{len(segments)}段 → {speakers}')
        return {'ok': True, 'segments': segments}
    except Exception as e:
        log.error(f'说话人分离失败: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'ok': False, 'error': str(e)})


# cookie 文件缓存：避免每次抓字幕都扫描磁盘
_cookies_cache = {'path': None, 'checked_at': 0.0}


def get_cookies_file():
    """自动查找下载文件夹里最新的 youtube cookies.txt
    （由浏览器插件 'Get cookies.txt LOCALLY' 导出）。每 30 秒重扫一次，
    所以用户重新 Export 到下载夹后会自动用上新的，实现"自动更新"。找不到返回 None。

    云端部署（HF Space 等）没有"下载文件夹"这个概念，优先看环境变量/Secret
    YT_COOKIES_CONTENT 有没有整份 cookies.txt 的内容——有就写到临时文件用一次，
    免去云端没法"扫文件夹自动更新"的问题（云端要更新 cookies 得重新设置这个 Secret）。
    """
    env_cookies = os.environ.get('YT_COOKIES_CONTENT', '').strip()
    if env_cookies:
        env_path = os.path.join(tempfile.gettempdir(), 'yt_cookies_from_env.txt')
        if _cookies_cache.get('env_hash') != hash(env_cookies):
            with open(env_path, 'w', encoding='utf-8') as f:
                f.write(env_cookies)
            _cookies_cache['env_hash'] = hash(env_cookies)
        return env_path

    import time
    now = time.time()
    cached = _cookies_cache['path']
    if now - _cookies_cache['checked_at'] < 30:
        if cached and os.path.exists(cached):
            return cached
        if cached is None:
            return None
    _cookies_cache['checked_at'] = now

    downloads = os.path.join(os.path.expanduser('~'), 'Downloads')
    yt_files, any_cookie_files = [], []
    try:
        for f in os.listdir(downloads):
            low = f.lower()
            if low.endswith('.txt') and 'cookie' in low:
                full = os.path.join(downloads, f)
                any_cookie_files.append(full)
                if 'youtube' in low or 'youtu' in low:
                    yt_files.append(full)
    except OSError:
        _cookies_cache['path'] = None
        return None

    candidates = yt_files or any_cookie_files  # 优先 youtube 专属，否则任意 cookies.txt
    if not candidates:
        _cookies_cache['path'] = None
        return None
    newest = max(candidates, key=lambda p: os.path.getmtime(p))
    if newest != cached:
        log.info(f'[cookie] 使用 {os.path.basename(newest)}')
    _cookies_cache['path'] = newest
    return newest


@app.post("/transcribe_video")
async def transcribe_video(req: Request):
    """无字幕视频：下载音频 → faster_whisper 转录 → Gemini 翻译 → 返回 segments。"""
    try:
        data = await req.json()
        video_id = data.get('video_id')
        if not video_id:
            return JSONResponse(status_code=400, content={'error': '缺少 video_id'})

        if not dub9.FASTER_WHISPER_AVAILABLE:
            return JSONResponse(status_code=503, content={'error': 'faster_whisper 未安装'})

        log.info(f'[转录] 开始处理: {video_id}')

        # 1) 下载音频
        audio_path = os.path.join(tempfile.gettempdir(), f'{video_id}_asr.m4a')
        cmd = [
            'yt-dlp',
            f'https://www.youtube.com/watch?v={video_id}',
            '-f', 'bestaudio[ext=m4a]/bestaudio/best',
            '--no-playlist',
            '--impersonate', 'chrome',
            '-o', audio_path,
        ]
        _ck = get_cookies_file()
        if _ck:
            cmd[2:2] = ['--cookies', _ck]
        proxy_args = _proxy_cmd_args()
        cmd_with_proxy = cmd[:2] + proxy_args + cmd[2:]
        out = subprocess.run(cmd_with_proxy, capture_output=True, timeout=120, check=False,
                             creationflags=_NO_WINDOW)
        # 代理本身连接异常（跟429限流不同，换会话ID也没用）时退回直连重试一次——
        # 见 prefetch_captions 里的同款兜底，同一个代理故障会影响所有走代理的接口。
        _stderr = (out.stderr or b'').decode('utf-8', 'replace') if isinstance(out.stderr, bytes) else (out.stderr or '')
        if proxy_args and not os.path.exists(audio_path) and (
                'Recv failure' in _stderr or 'Connection was reset' in _stderr or 'TransportError' in _stderr):
            log.warning(f'[转录] {video_id}: 代理连接异常，改用直连重试一次')
            out = subprocess.run(cmd, capture_output=True, timeout=120, check=False,
                                 creationflags=_NO_WINDOW)
        if not os.path.exists(audio_path):
            log.warning(f'[转录] 音频下载失败: {video_id}')
            return JSONResponse(status_code=500, content={'error': '音频下载失败'})

        log.info(f'[转录] 音频已下载，开始 Whisper 转录…')

        # 2) faster_whisper 转录（在线程池跑，不阻塞事件循环）
        def _do_transcribe():
            model = dub9.get_whisper_model()
            segments, _ = model.transcribe(audio_path, language=None,
                                           word_timestamps=False, vad_filter=True)
            return [{'start': s.start, 'end': s.end, 'text': s.text.strip()} for s in segments]

        loop = asyncio.get_event_loop()
        raw_segs = await loop.run_in_executor(None, _do_transcribe)
        log.info(f'[转录] Whisper 完成，共 {len(raw_segs)} 段')

        # 清理音频文件
        try:
            os.remove(audio_path)
        except OSError:
            pass

        if not raw_segs:
            return JSONResponse(status_code=200, content={'ok': False, 'error': '未识别到语音'})

        # 3) Gemini 翻译（复用 dub9 的批量翻译逻辑）
        log.info(f'[转录] 开始翻译 {len(raw_segs)} 段…')
        await dub9.translate_segments(raw_segs)

        # 返回格式与 prefetch_captions 一致，text 字段用翻译结果
        result_segs = []
        for s in raw_segs:
            result_segs.append({
                'start': s['start'],
                'end': s['end'],
                'text': s.get('translation') or s['text'],
                'original': s['text'],
            })

        log.info(f'[转录] 完成: {video_id}，{len(result_segs)} 段')
        return JSONResponse(content={'ok': True, 'segments': result_segs})

    except Exception as e:
        log.exception(f'[转录] 异常: {e}')
        return JSONResponse(status_code=500, content={'error': str(e)})


def _sub_lang_variants(lang):
    """把用户选的目标语言（如 'en-US'/'ja'/'zh-CN'）展开成 yt-dlp --sub-langs 要试的一批候选码。

    YouTube 对很多语言都提供"自动翻译字幕"（免费，质量一般但够朗读用），
    --write-auto-subs + --sub-langs 直接指定目标语言码即可命中那条自动翻译轨道，
    不需要再调付费翻译 API。"""
    lang = (lang or 'zh-CN').lower()
    prefix = lang.split('-')[0]
    if prefix == 'zh':
        # YouTube 中文视频的原生自动字幕轨道名为 "zh-Hans-zh-Hans"（中文转录自中文），不是裸的 "zh-Hans"
        return 'zh-Hans-zh-Hans,zh-Hans,zh-CN,zh,zh-Hant-zh-Hans,zh-Hant'
    variants = []
    for v in (lang, prefix):
        if v not in variants:
            variants.append(v)
    return ','.join(variants)


@app.post("/prefetch_captions")
async def prefetch_captions(req: Request):
    """获取指定视频"用户选的目标语言"的字幕（通过 yt-dlp 的手动字幕 + 自动翻译字幕），
    不做任何翻译——朗读项目就是有什么语言字幕就读什么语言，没有就让用户自己去 YouTube 设置。

    lang 不传时退回旧默认值 zh-CN（兼容 Chrome 插件等没传这个参数的旧调用方）。"""
    try:
        data = await req.json()
        video_id = data.get('video_id')
        lang = data.get('lang') or 'zh-CN'
        if not video_id:
            return JSONResponse(status_code=400, content={'error': '缺少 video_id'})

        log.info(f'[后台预取] 开始获取字幕: {video_id} (lang={lang})')

        import subprocess
        import glob as _glob
        tmp_dir = tempfile.gettempdir()

        sub_langs = _sub_lang_variants(lang)

        def _build_cmd(proxy_args):
            c = [
                'yt-dlp',
                f'https://www.youtube.com/watch?v={video_id}',
                '--write-sub',
                '--write-auto-subs',   # 自动字幕（含 YouTube 自动翻译/转录），必须带
                '--sub-langs', sub_langs,
                '--sub-format', 'vtt',
                '--skip-download',
                '--impersonate', 'chrome',   # 模拟真实浏览器 TLS 指纹（curl_cffi），减少 429/反爬
                # 缓解 YouTube 429 限流：重试 + 退避 + 请求间隔
                '--retries', '5',
                '--extractor-retries', '3',
                '--retry-sleep', '5',
                '--sleep-requests', '1',
                '-o', os.path.join(tmp_dir, '%(id)s.%(ext)s'),
            ]
            # 带上浏览器登录 cookie（来自插件导出的 cookies.txt），登录态限流额度高得多，能避开 429
            _ck = get_cookies_file()
            if _ck:
                c[2:2] = ['--cookies', _ck]
            c[2:2] = proxy_args
            return c

        try:
            # 住宅代理的 IP 是很多人共用的，偶尔会分到一个本身已经被限流的"坏IP"——
            # 用户反馈：Sticky 固定半小时一个IP，万一分到坏的就要干等。这里改成：第一次用
            # 一个新生成的会话ID（绑定一个IP），如果撞上 429，立刻换一个新会话ID 重试，
            # 不必等 Sticky 超时；最多重试 2 次（3次尝试），每次都是全新随机会话ID。
            import random
            out = None
            proxy_broken = False
            for attempt in range(3):
                session_id = f'{video_id}-{random.randint(100000, 999999)}'
                cmd = _build_cmd(_proxy_cmd_args(session_id))
                out = subprocess.run(cmd, capture_output=True, timeout=90, check=False,
                                     encoding='utf-8', errors='replace',
                                     creationflags=_NO_WINDOW)
                hit_429 = bool(out.stderr and '429' in out.stderr)
                # 跟"429限流"是两种不同的失败：这是代理本身连不上/被重置（curl error 56
                # Recv failure等），换会话ID也没用——同一个坏代理节点/故障服务不会因为
                # 换个session id就变好。这里单独识别出来，跟429分开处理。
                hit_proxy_transport_err = bool(out.stderr and (
                    'Recv failure' in out.stderr or 'Connection was reset' in out.stderr
                    or 'TransportError' in out.stderr))
                if not hit_429 and not hit_proxy_transport_err:
                    break
                if hit_429:
                    log.warning(f'[后台预取] {video_id}: 遇到 429 限流（第 {attempt + 1}/3 次，换新会话IP重试）')
                elif hit_proxy_transport_err:
                    proxy_broken = True
                    log.warning(f'[后台预取] {video_id}: 代理连接异常（第 {attempt + 1}/3 次，换新会话IP重试）')

            # 换了3次会话ID（等于3个不同代理IP）还是连接层面失败（不是429），大概率是
            # 代理服务本身当前故障（比如账户欠费/服务中断/网关不可用），不是某个IP偶尔
            # 分到坏的这种随机性问题——继续死磕代理没有意义。直连没有429限流保护，
            # 但总比"代理全灭、每次必然失败"强，退回直连试最后一次，保证不会因为代理
            # 自己的故障而让本来能拿到的字幕也白白拿不到。
            if proxy_broken:
                log.warning(f'[后台预取] {video_id}: 代理连续3次连接异常，判定代理当前不可用，改用直连重试一次')
                cmd = _build_cmd([])
                out = subprocess.run(cmd, capture_output=True, timeout=90, check=False,
                                     encoding='utf-8', errors='replace',
                                     creationflags=_NO_WINDOW)

            # 扫描实际生成的字幕文件，按请求的语言变体顺序挑选（前面的变体更精确）
            candidates = _glob.glob(os.path.join(tmp_dir, f'{video_id}.*.vtt'))
            sub_path = None
            detected_lang = None
            if candidates:
                priority = sub_langs.split(',')

                def _lang_of(p):
                    parts = os.path.basename(p).split('.')
                    return parts[1] if len(parts) >= 3 else ''

                def _rank(p):
                    lang_of_p = _lang_of(p).lower()
                    for i, want in enumerate(priority):
                        if lang_of_p == want.lower():
                            return i
                    return len(priority)
                candidates.sort(key=_rank)
                sub_path = candidates[0]
                detected_lang = _lang_of(sub_path)

            if sub_path and os.path.exists(sub_path):
                segments = dub9.parse_vtt(sub_path) if hasattr(dub9, 'parse_vtt') else _parse_vtt_fallback(sub_path)
                # 按句合并：把上千条逐行字幕重组成完整句子（约 1/10 段数），
                # 避免每行一次 TTS 导致配音极慢、霸占本地代理（曾出现 1997 段的情况）。
                # group_cn_sentences 是按中文标点/连词设计的，非中文字幕不调用，原样按 cue 分段。
                _before = len(segments)
                is_chinese_sub = detected_lang and detected_lang.lower().startswith('zh')
                if is_chinese_sub and hasattr(dub9, 'group_cn_sentences'):
                    segments = dub9.group_cn_sentences(segments)
                log.info(f'[后台预取] ✓ {video_id}: {_before} 行 → {len(segments)} 句'
                         f'（来源 {os.path.basename(sub_path)}，语言={detected_lang}）')
                # 清理临时 vtt，避免堆积
                for p in candidates:
                    try:
                        os.remove(p)
                    except OSError:
                        pass
                return {'ok': True, 'segments': segments, 'matched_lang': detected_lang}

            log.warning(f'[后台预取] {video_id}: 未找到 {lang} 语言的字幕文件，yt-dlp stderr: '
                        f'{(out.stderr or "")[-1500:] if out else "(无 out)"}')
        except Exception as e:
            log.warning(f'[后台预取] yt-dlp 获取失败: {e}')

        # 没找到该语言的字幕：返回空，前端要提示用户去 YouTube 自己开启/设置该语言字幕
        return {'ok': True, 'segments': [], 'matched_lang': None}

    except Exception as e:
        log.error(f'[后台预取] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


def _parse_vtt_fallback(vtt_path):
    """简单的 VTT 解析降级方案"""
    import re
    segments = []
    try:
        with open(vtt_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        i = 0
        while i < len(lines):
            line = lines[i].strip()
            match = re.match(r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})', line)
            if match:
                start = int(match.group(1)) * 3600 + int(match.group(2)) * 60 + int(match.group(3)) + int(match.group(4)) / 1000
                end = int(match.group(5)) * 3600 + int(match.group(6)) * 60 + int(match.group(7)) + int(match.group(8)) / 1000
                # 下一行是文本
                i += 1
                if i < len(lines):
                    text = lines[i].strip()
                    if text:
                        segments.append({'start': start, 'end': end, 'text': text})
            i += 1
    except Exception as e:
        log.warning(f'VTT 解析失败: {e}')

    return segments


def _list_seg_files(video_id):
    """返回该视频已生成的配音分段文件 [(start_ms, path), ...]，按时间排序。无则空列表。"""
    cache_dir = dub9.get_cache_dir(video_id)
    if not os.path.exists(cache_dir):
        return []
    seg_files = []
    for fname in sorted(os.listdir(cache_dir)):
        if fname.startswith('seg_') and fname.endswith('.mp3'):
            try:
                # 实际文件名是 seg_<start_ms>_<voice>.mp3；旧逻辑只接受
                # seg_<start_ms>.mp3，会把绝大多数后台配音片段漏掉，导致缓存列表、
                # 进度校验和导出下载都不正确。
                m = re.match(r'^seg_(\d+)(?:_.+)?\.mp3$', fname)
                if not m:
                    continue
                seg_files.append((int(m.group(1)), os.path.join(cache_dir, fname)))
            except ValueError:
                pass
    seg_files.sort(key=lambda x: x[0])
    return seg_files


def _build_merged_audio(video_id):
    """把某视频的所有配音分段合并成一个 mp3，返回 bytes。无分段时返回 None。

    用单次 ffmpeg concat（-c copy，不重新编码）合并，比 pydub 逐段调 ffprobe 快很多，
    且只起一个带 CREATE_NO_WINDOW 的子进程，不会弹出大量黑窗。结果缓存到 merged.mp3，
    分段无更新时直接复用，重复下载秒回。"""
    seg_files = _list_seg_files(video_id)
    # 跳过 0 字节空分段（TTS 失败产生）。ffmpeg concat -c copy 碰到空/损坏文件会在此处
    # 截断，导致合并音频只剩前一小段（曾出现 385 段只合出 140KB 的问题）。过滤掉它们，
    # 保证整段音频完整。
    seg_files = [(k, p) for (k, p) in seg_files
                 if os.path.exists(p) and os.path.getsize(p) > 0]
    if not seg_files:
        return None
    cache_dir = dub9.get_cache_dir(video_id)
    output_path = os.path.join(cache_dir, 'merged.mp3')

    # 缓存命中：merged.mp3 比所有分段都新则直接复用
    try:
        if os.path.exists(output_path):
            merged_mtime = os.path.getmtime(output_path)
            if all(os.path.getmtime(p) <= merged_mtime for _, p in seg_files):
                with open(output_path, 'rb') as f:
                    return f.read()
    except OSError:
        pass

    ffmpeg = _find_ffmpeg()
    if ffmpeg:
        list_path = os.path.join(cache_dir, '_concat_list.txt')
        with open(list_path, 'w', encoding='utf-8') as f:
            for _, seg_path in seg_files:
                safe = seg_path.replace('\\', '/').replace("'", "'\\''")
                f.write(f"file '{safe}'\n")
        try:
            subprocess.run(
                [ffmpeg, '-y', '-f', 'concat', '-safe', '0', '-i', list_path,
                 '-c', 'copy', output_path],
                check=True, capture_output=True, creationflags=_NO_WINDOW,
            )
            with open(output_path, 'rb') as f:
                return f.read()
        except subprocess.CalledProcessError as e:
            log.warning(f'[合并音频] ffmpeg concat 失败，回退直接拼接: {e.stderr[-300:] if e.stderr else e}')

    # 回退：直接二进制拼接（无 ffmpeg 或 concat 失败时）
    data = b''
    for _, seg_path in seg_files:
        with open(seg_path, 'rb') as f:
            data += f.read()
    with open(output_path, 'wb') as f:
        f.write(data)
    return data


@app.post("/merge_audio")
async def merge_audio(req: Request):
    """合并指定视频的所有分段配音音频成一个完整的 MP3 文件（POST，返回二进制）。"""
    try:
        data = await req.json()
        video_id = data.get('video_id')
        if not video_id:
            return JSONResponse(status_code=400, content={'error': '缺少 video_id'})
        log.info(f'[合并音频] 开始合并: {video_id}')
        audio = _build_merged_audio(video_id)
        if audio is None:
            cache_dir = dub9.get_cache_dir(video_id)
            err = '缓存不存在' if not os.path.exists(cache_dir) else '未找到分段音频（尚未配音）'
            return JSONResponse(status_code=404, content={'error': err})
        log.info(f'[合并音频] ✓ {video_id}: {len(audio)//1024}KB')
        return Response(content=audio, media_type='audio/mpeg')
    except Exception as e:
        log.error(f'[合并音频] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


@app.get("/merged_audio/{video_id}")
async def merged_audio_get(video_id: str):
    """GET 版合并音频，供 chrome.downloads 直接下载（带文件名）。"""
    try:
        audio = _build_merged_audio(video_id)
        if audio is None:
            return JSONResponse(status_code=404, content={'error': '未找到分段音频（尚未配音）'})
        return Response(content=audio, media_type='audio/mpeg', headers={
            'Content-Disposition': f'attachment; filename="dubbing_{video_id}.mp3"'
        })
    except Exception as e:
        log.error(f'[合并音频GET] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


def _build_export_manifest(video_id, seg_files):
    """构建后台配音导出包 manifest。

    后台配音用于本地合成时，不能使用无间隙 merged.mp3；必须保留每个片段的
    start/start_ms/file/duration，让本地脚本按原视频时间轴铺回并补静音。
    """
    cache_dir = dub9.get_cache_dir(video_id)
    title = video_id
    try:
        with open(os.path.join(cache_dir, 'cache_meta.json'), encoding='utf-8') as f:
            title = json.load(f).get('title') or video_id
    except Exception:
        pass

    tts_cache = {}
    try:
        with open(os.path.join(cache_dir, 'tts_cache.json'), encoding='utf-8') as f:
            tts_cache = json.load(f)
    except Exception:
        tts_cache = {}

    segments = []
    voices = set()
    for idx, (start_ms, seg_path) in enumerate(seg_files, start=1):
        fname = os.path.basename(seg_path)
        m = re.match(r'^seg_(\d+)(?:_(.+))?\.mp3$', fname)
        voice = (m.group(2) if m and m.group(2) else 'default')
        voices.add(voice)
        cached = tts_cache.get(seg_path) or {}
        try:
            duration = round(float(dub9.get_audio_duration(seg_path)), 3)
        except Exception:
            duration = 0.0
        segments.append({
            'index': idx,
            'start': round(start_ms / 1000.0, 3),
            'start_ms': start_ms,
            'duration': duration,
            'voice': voice,
            'text': cached.get('text') or '',
            'file': f'{idx:04d}.mp3',
            'source_file': fname,
        })

    total_duration = 0.0
    if segments:
        last = segments[-1]
        total_duration = float(last.get('start') or 0) + float(last.get('duration') or 0)
    return {
        'format': 'youtube-dub-background-package-v1',
        'video_id': video_id,
        'title': title,
        'exported_at': datetime.now(timezone.utc).isoformat(),
        'segment_count': len(segments),
        'total_duration': round(total_duration, 3),
        'voices': sorted(voices),
        'merge_hint': (
            '本包用于本地合成：把 segments/*.mp3 按 manifest.json 里的 start_ms 铺回'
            '原视频时间轴，中间补静音；不要用无间隙 merged.mp3 直接替换音轨。'
        ),
        'segments': segments,
    }


def _manifest_to_srt(manifest):
    def fmt(t):
        ms = int(round(float(t or 0) * 1000))
        h, ms = divmod(ms, 3600000)
        m, ms = divmod(ms, 60000)
        s, ms = divmod(ms, 1000)
        return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'

    lines = []
    idx = 1
    for seg in manifest.get('segments') or []:
        text = (seg.get('text') or '').strip()
        if not text:
            continue
        start = float(seg.get('start') or 0)
        end = start + float(seg.get('duration') or 0)
        lines.extend([str(idx), f'{fmt(start)} --> {fmt(end)}', text, ''])
        idx += 1
    return '\n'.join(lines)


_EXPORT_PACKAGE_README = """\
后台配音包：{title}
视频ID：{video_id}
片段数：{segment_count}

本包用于和本地下载的原视频合成。

内容：
- manifest.json：每个配音片段的 start/start_ms/duration/voice/text/file。
- segments/*.mp3：逐句配音片段，文件名与 manifest.json 的 file 对应。
- subtitle.srt：按配音片段生成的中文字幕参考。

重要：
后台配音不是实时播放录屏。实时播放可能会改变视频速度并产生 ratelog；
后台包则按原视频时间轴合成：把每段 mp3 铺到 start_ms，中间补静音。
因此不能把所有 mp3 无间隙合成一个 merged.mp3 后直接替换音轨，那样时间轴会错。
"""


@app.get("/export_package/{video_id}")
async def export_package(video_id: str):
    """导出完整后台配音包：manifest.json + subtitle.srt + segments/*.mp3。"""
    try:
        safe_id = re.sub(r'[^A-Za-z0-9_-]', '', str(video_id or ''))[:100]
        if not safe_id:
            return JSONResponse(status_code=400, content={'error': '无效 video_id'})

        seg_files = [
            (start, path) for start, path in _list_seg_files(safe_id)
            if os.path.exists(path) and os.path.getsize(path) > 0
        ]
        if not seg_files:
            return JSONResponse(status_code=404, content={'error': '没有可导出的配音片段'})

        manifest = _build_export_manifest(safe_id, seg_files)
        safe_title = dub9.sanitize_filename(manifest.get('title') or safe_id, max_len=120) or safe_id

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
            zf.writestr('subtitle.srt', _manifest_to_srt(manifest))
            zf.writestr('README.txt', _EXPORT_PACKAGE_README.format(**manifest))
            for idx, (_, seg_path) in enumerate(seg_files, start=1):
                zf.write(seg_path, f'segments/{idx:04d}.mp3')

        filename = f'{safe_title}.zip'
        return Response(content=buf.getvalue(), media_type='application/zip', headers={
            'Content-Disposition': "attachment; filename*=UTF-8''" + quote(filename),
        })
    except Exception as e:
        log.error(f'[导出配音包] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


@app.get("/cache_list")
async def cache_list():
    """List downloadable dubbing caches, newest first."""
    items = []
    reserved = {'recordings', '__pycache__'}
    try:
        for video_id in os.listdir(LIVE_TEMP_DIR):
            if video_id in reserved:
                continue
            video_dir = os.path.join(LIVE_TEMP_DIR, video_id)
            if not os.path.isdir(video_dir):
                continue
            segment_files = [
                name for name in os.listdir(video_dir)
                if name.startswith('seg_') and name.endswith('.mp3')
            ]
            merged_path = os.path.join(video_dir, 'merged.mp3')
            if not segment_files and not os.path.isfile(merged_path):
                continue
            title = video_id
            meta_path = os.path.join(video_dir, 'cache_meta.json')
            try:
                with open(meta_path, encoding='utf-8') as f:
                    title = json.load(f).get('title') or video_id
            except Exception:
                pass
            newest = max(
                [os.path.getmtime(os.path.join(video_dir, name)) for name in segment_files]
                + ([os.path.getmtime(merged_path)] if os.path.isfile(merged_path) else [0])
            )
            size = sum(
                os.path.getsize(os.path.join(video_dir, name))
                for name in segment_files
            )
            if os.path.isfile(merged_path):
                size = os.path.getsize(merged_path)
            items.append({
                'video_id': video_id,
                'title': title,
                'segments': len(segment_files),
                'size': size,
                'updated_at': datetime.fromtimestamp(
                    newest, tz=timezone.utc).isoformat() if newest else None,
                'download_url': f'/merged_audio/{video_id}',
            })
        items.sort(key=lambda item: item.get('updated_at') or '', reverse=True)
        return {'ok': True, 'items': items}
    except Exception as e:
        log.error(f'[缓存列表] 读取失败: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'ok': False, 'error': str(e)})


@app.put("/recording_cache/{video_id}")
async def save_recording_cache(video_id: str, req: Request):
    """先持久化浏览器录制文件，再用 ffprobe 验证音视频轨、时长和大小。"""
    try:
        safe_id = ''.join(c for c in video_id if c.isalnum() or c in '_-')[:100]
        if not safe_id:
            return JSONResponse(status_code=400, content={'error': '无效video_id'})
        data = await req.body()
        if not data:
            return JSONResponse(status_code=400, content={'error': '录制文件为空'})
        cache_dir = os.path.join(dub9.get_cache_dir(safe_id), 'recording')
        os.makedirs(cache_dir, exist_ok=True)
        path = os.path.join(cache_dir, 'capture.webm')
        with open(path, 'wb') as f:
            f.write(data)

        probe_cmd = [
            'ffprobe', '-v', 'error', '-show_entries',
            'format=duration,size:stream=codec_type,codec_name,duration',
            '-of', 'json', path,
        ]
        probe = subprocess.run(probe_cmd, capture_output=True, text=True, timeout=30,
                               creationflags=_NO_WINDOW)
        probe_data = json.loads(probe.stdout or '{}') if probe.returncode == 0 else {}
        streams = probe_data.get('streams') or []
        has_audio = any(s.get('codec_type') == 'audio' for s in streams)
        has_video = any(s.get('codec_type') == 'video' for s in streams)
        probed_duration = float((probe_data.get('format') or {}).get('duration') or 0)
        client_duration = float(req.headers.get('x-client-duration') or 0)
        duration = probed_duration or client_duration
        size = os.path.getsize(path)
        expected_video = req.headers.get('x-with-video', '').lower() == 'true'
        partial = req.headers.get('x-partial', '').lower() == 'true'
        verified = size > 0 and duration > 0 and has_audio and (has_video if expected_video else True)
        saved_at = datetime.now(timezone.utc).isoformat()
        meta = {
            'ok': True, 'verified': verified, 'video_id': safe_id,
            'path': path, 'size': size, 'duration': round(duration, 3),
            'probed_duration': round(probed_duration, 3),
            'duration_source': 'ffprobe' if probed_duration > 0 else 'browser_wall_clock',
            'has_audio': has_audio, 'has_video': has_video,
            'saved_at': saved_at, 'streams': streams,
            'partial': partial,
            'client_duration': round(client_duration, 3),
            'download_url': f'/recording_cache/{safe_id}',
        }
        with open(os.path.join(cache_dir, 'metadata.json'), 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        log.info(f"[录制缓存] {safe_id}: partial={partial} verified={verified} size={size} "
                 f"duration={duration:.2f}s audio={has_audio} video={has_video}")
        return JSONResponse(content=meta)
    except Exception as e:
        log.error(f'[录制缓存] 保存/检测失败: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


@app.get("/recording_cache/{video_id}")
async def get_recording_cache(video_id: str):
    safe_id = ''.join(c for c in video_id if c.isalnum() or c in '_-')[:100]
    path = os.path.join(dub9.get_cache_dir(safe_id), 'recording', 'capture.webm')
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={'error': '录制缓存不存在'})
    with open(path, 'rb') as f:
        return Response(content=f.read(), media_type='video/webm')


@app.get("/recording_cache_meta/{video_id}")
async def get_recording_cache_meta(video_id: str):
    safe_id = ''.join(c for c in video_id if c.isalnum() or c in '_-')[:100]
    path = os.path.join(dub9.get_cache_dir(safe_id), 'recording', 'metadata.json')
    if not os.path.exists(path):
        return JSONResponse(status_code=404, content={'error': '录制缓存检测报告不存在'})
    with open(path, encoding='utf-8') as f:
        return JSONResponse(content=json.load(f))


@app.post("/dub_status")
async def dub_status(req: Request):
    """查询一批视频的配音状态：返回 {video_id: 已生成的分段数}。分段数>0 即已配音。"""
    try:
        data = await req.json()
        ids = data.get('video_ids') or []
        status = {vid: len(_list_seg_files(vid)) for vid in ids}
        return {'ok': True, 'status': status}
    except Exception as e:
        log.error(f'[配音状态] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


def _background_job_path(video_id):
    safe_id = re.sub(r'[^A-Za-z0-9_-]', '', str(video_id or ''))[:80]
    if not safe_id:
        raise ValueError('无效视频ID')
    folder = os.path.join(LIVE_TEMP_DIR, safe_id)
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, 'background_job.json')


@app.post("/background_job_update")
async def background_job_update(req: Request):
    try:
        _maybe_cleanup_server_cache()
        data = await req.json()
        video_id = data.get('video_id')
        path = _background_job_path(video_id)
        total = max(0, int(data.get('total') or 0))
        done = max(0, min(total or int(data.get('done') or 0), int(data.get('done') or 0)))
        row = {
            'video_id': video_id, 'title': str(data.get('title') or video_id),
            'status': str(data.get('status') or 'processing'),
            'done': done, 'total': total,
            'percent': round(done * 100 / total, 1) if total else 0,
            'error': str(data.get('error') or ''), 'updated_at': time.time(),
            'voices': [str(v) for v in (data.get('voices') or []) if v],
            'verified': data.get('verified') is True,
        }
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as handle:
            json.dump(row, handle, ensure_ascii=False)
        os.replace(tmp, path)
        _touch_video_cache_dir(video_id)
        return {'ok': True, 'job': row}
    except Exception as e:
        return JSONResponse(status_code=400, content={'ok': False, 'error': str(e)})


@app.post("/background_job_status")
async def background_job_status(req: Request):
    try:
        data = await req.json()
        ids = data.get('video_ids') or ([data.get('video_id')] if data.get('video_id') else [])
        jobs = {}
        for video_id in ids:
            try:
                with open(_background_job_path(video_id), encoding='utf-8') as handle:
                    jobs[video_id] = json.load(handle)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
        return {'ok': True, 'jobs': jobs}
    except Exception as e:
        return JSONResponse(status_code=400, content={'ok': False, 'error': str(e)})


@app.post("/parse_playlist")
async def parse_playlist(req: Request):
    """用 yt-dlp 解析播放列表，返回所有视频 ID"""
    try:
        data = await req.json()
        playlist_id = data.get('playlist_id', '')
        if not playlist_id:
            return JSONResponse(status_code=400, content={'error': '缺少 playlist_id'})

        playlist_url = f'https://www.youtube.com/playlist?list={playlist_id}'
        log.info(f'[解析播放列表] {playlist_url}')

        cmd_base = [
            'yt-dlp',
            '--flat-playlist',
            '--dump-json',
            '--no-warnings',
            '-q',
            playlist_url,
        ]
        proxy_args = _proxy_cmd_args()
        cmd = cmd_base[:1] + proxy_args + cmd_base[1:]

        def _run(c):
            return subprocess.run(
                c, capture_output=True, text=True, timeout=60,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            )
        output = await asyncio.get_event_loop().run_in_executor(None, lambda: _run(cmd))
        # 代理本身连接异常（跟429限流不同，换会话ID也没用）时退回直连重试一次——
        # 见 prefetch_captions 里的同款兜底，同一个代理故障会影响所有走代理的接口。
        if proxy_args and not output.stdout.strip() and (
                'Recv failure' in (output.stderr or '') or 'Connection was reset' in (output.stderr or '')
                or 'TransportError' in (output.stderr or '')):
            log.warning('[解析播放列表] 代理连接异常，改用直连重试一次')
            output = await asyncio.get_event_loop().run_in_executor(None, lambda: _run(cmd_base))

        videos = []
        playlist_title = None
        for line in output.stdout.strip().split('\n'):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
                if not playlist_title:
                    playlist_title = entry.get('playlist_title') or entry.get('playlist')
                vid = entry.get('id') or entry.get('url', '').split('v=')[-1]
                if vid and len(vid) == 11:
                    title = entry.get('title', vid)  # 标题缺失时fallback用id
                    videos.append({'id': vid, 'title': title})
            except Exception:
                continue

        log.info(f'[解析播放列表] ✓ 找到 {len(videos)} 个视频，标题：{playlist_title}')
        return {'ok': True, 'videos': videos, 'playlist_title': playlist_title}

    except Exception as e:
        log.error(f'[解析播放列表] 异常: {e}')
        return JSONResponse(status_code=500, content={'error': str(e)})


@app.post("/search_videos")
async def search_videos(req: Request):
    """按关键词搜索 YouTube 视频（3天内、指定播放数以上）"""
    try:
        data = await req.json()
        keywords = data.get('keywords', [])
        days = data.get('days', 3)
        min_views = data.get('min_views', 10000)

        if not keywords:
            return JSONResponse(status_code=400, content={'error': '缺少关键词'})

        log.info(f'[搜索视频] 关键词: {keywords}, 时间范围: {days}天, 最低播放: {min_views}')

        import subprocess
        from datetime import datetime, timedelta

        results = []
        cutoff_date = (datetime.now() - timedelta(days=days)).isoformat()

        # 对每个关键词进行搜索
        for keyword in keywords[:6]:  # 最多6个关键词（flat模式较快，约每个3-5秒）
            try:
                # 使用 yt-dlp 的搜索功能（--flat-playlist 只取列表元数据，
                # 比 --dump-json 抓全量信息快 10 倍，避免 30 秒超时拿不到结果）。
                # flat 模式有 view_count，但 upload_date 通常为 null（YouTube 快速索引不返回日期），
                # 因此日期过滤为「尽力而为」：拿不到日期的视频默认保留，仅靠播放数过滤。
                cmd = [
                    'yt-dlp',
                    f'ytsearch40:{keyword}',
                    '--flat-playlist',
                    '--dump-json',
                    # approximate_date 让快速模式也能返回大致发布日期（基于"X天前"文本，
                    # 略有取整但足够用），这样发布时间过滤才能真正生效、前端也能显示日期。
                    '--extractor-args', 'youtubetab:approximate_date',
                    '--impersonate', 'chrome',   # 模拟浏览器指纹，减少 429
                    '--no-warnings',
                    '-q',
                ]
                _ck = get_cookies_file()
                if _ck:
                    cmd[2:2] = ['--cookies', _ck]
                proxy_args = _proxy_cmd_args()
                cmd_with_proxy = cmd[:2] + proxy_args + cmd[2:]

                def _run_search(c):
                    return subprocess.run(
                        c,
                        capture_output=True,
                        text=True,
                        encoding='utf-8',      # 强制 UTF-8，避免 Windows GBK 解码崩溃（中文关键词/标题）
                        errors='replace',
                        timeout=45,
                        creationflags=_NO_WINDOW if os.name == 'nt' else 0
                    )
                output = _run_search(cmd_with_proxy)
                # 代理本身连接异常（跟429限流不同，换会话ID也没用）时退回直连重试一次——
                # 见 prefetch_captions 里的同款兜底，同一个代理故障会影响所有走代理的接口。
                if proxy_args and not output.stdout.strip() and (
                        'Recv failure' in (output.stderr or '') or 'Connection was reset' in (output.stderr or '')
                        or 'TransportError' in (output.stderr or '')):
                    log.warning(f'[搜索视频] "{keyword}": 代理连接异常，改用直连重试一次')
                    output = _run_search(cmd)

                if output.returncode != 0:
                    log.warning(f'[搜索视频] yt-dlp 搜索 "{keyword}" 失败: {(output.stderr or "")[:200]}')
                    # returncode 非 0 时 stdout 可能仍有部分结果，继续解析

                # 解析 yt-dlp 的输出
                import json
                entries = (output.stdout or '').strip().split('\n')
                for line in entries:
                    if not line.strip():
                        continue
                    try:
                        entry = json.loads(line)
                        video_id = entry.get('id')
                        title = entry.get('title', '')
                        channel = entry.get('channel') or entry.get('uploader') or 'Unknown'
                        views = entry.get('view_count') or 0
                        # flat 模式可能用 timestamp(秒) 或 upload_date(YYYYMMDD)，都尽力取
                        published = entry.get('upload_date')
                        ts = entry.get('timestamp')

                        # 计算发布日期；拿不到则视为「未知」，不参与日期过滤
                        pub_date = None
                        if published:
                            try:
                                pub_date = datetime.strptime(published, '%Y%m%d').isoformat()
                            except ValueError:
                                pub_date = None
                        elif ts:
                            try:
                                pub_date = datetime.fromtimestamp(ts).isoformat()
                            except (ValueError, OSError):
                                pub_date = None

                        # 过滤：播放数必须达标；日期已知时才按 cutoff 过滤，未知则放行
                        if views >= min_views and (pub_date is None or pub_date > cutoff_date):
                            results.append({
                                'id': video_id,
                                'title': title,
                                'channelTitle': channel,
                                'views': views,
                                'publishedAt': pub_date or '',
                            })
                    except json.JSONDecodeError:
                        continue

            except Exception as e:
                log.warning(f'[搜索视频] 搜索 "{keyword}" 异常: {e}')
                continue

        # 去重并按播放数排序
        seen = set()
        unique_results = []
        for r in results:
            if r['id'] not in seen:
                seen.add(r['id'])
                unique_results.append(r)

        unique_results.sort(key=lambda x: x['views'], reverse=True)

        log.info(f'[搜索视频] ✓ 共找到 {len(unique_results)} 个视频')
        return {'ok': True, 'results': unique_results[:50]}  # 限制返回50个

    except Exception as e:
        log.error(f'[搜索视频] 异常: {e}\n{traceback.format_exc()}')
        return JSONResponse(status_code=500, content={'error': str(e)})


if __name__ == '__main__':
    import uvicorn
    # 绑定 0.0.0.0 而不是 127.0.0.1——后者只接受"这台机器自己"发来的请求，局域网里
    # 别的电脑（比如不能跑本地服务的旧电脑，插件里把 serverUrl 设成这台机器的局域网IP）
    # 连不进来。0.0.0.0 表示监听这台机器所有网卡，同一局域网内的其它设备才能连上。
    # 端口默认 8765（本机/局域网用），HF Space 等云端部署用 PORT 环境变量覆盖成 7860。
    port = int(os.environ.get('PORT', '8765'))
    log.info(f"live_dub_server 启动，监听 0.0.0.0:{port}")
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='info')
