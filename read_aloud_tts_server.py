"""
"朗读"插件专用的云端 TTS 后端：独立新文件，不依赖 dub9/live_dub_server 那一整套
（说话人分离、批量任务、本地缓存等都不需要）。

只做一件事：收到一句文本 + 语音名，调 edge-tts 合成音频，直接把 mp3 字节返回。
无状态、不落盘、不缓存——朗读是实时按句合成，没有"重新生成同一个视频"的复用场景，
缓存复杂度省了更划算。

部署：本地测试用 run_read_aloud_tts.bat；云端部署用同目录的
Dockerfile.read_aloud_tts（配 Hugging Face Spaces，见文件里的说明）。

TTS 引擎：目前用 edge-tts（免费、无需 API key）。以后用户量大了要换成商用 TTS，
直接改 synthesize() 这一个函数就行，不用动其它代码。
"""
import asyncio
import logging

import edge_tts
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)-7s %(message)s')
log = logging.getLogger('read_aloud_tts')

app = FastAPI(title='read-aloud-tts')

# 朗读插件跑在 youtube.com 页面里发请求，必须允许跨域
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_methods=['*'],
    allow_headers=['*'],
)

# 防止某一时刻并发请求太多把出口 IP 打到 edge-tts 的限流
_SEMAPHORE = asyncio.Semaphore(8)


class TTSRequest(BaseModel):
    text: str
    voice: str = 'zh-CN-XiaoxiaoNeural'  # edge-tts 语音名，由调用方按字幕语言选好传过来
    rate_pct: int = 0  # 语速偏移百分比，如 +20 表示快 20%，-10 表示慢 10%


@app.get('/health')
async def health():
    return {'ok': True}


async def synthesize(text: str, voice: str, rate_pct: int) -> bytes:
    """换商用 TTS 时只需要改这个函数的实现，签名（文本/语音名/语速）不用变。"""
    rate_str = f'{rate_pct:+d}%'
    communicate = edge_tts.Communicate(text, voice, rate=rate_str)
    chunks = bytearray()
    async for chunk in communicate.stream():
        if chunk['type'] == 'audio':
            chunks.extend(chunk['data'])
    return bytes(chunks)


@app.post('/tts')
async def tts(req: TTSRequest):
    text = (req.text or '').strip()
    if not text:
        return JSONResponse(status_code=400, content={'error': '缺少 text'})

    async with _SEMAPHORE:
        last_error = None
        for attempt in range(3):
            try:
                audio = await synthesize(text, req.voice, req.rate_pct)
                if audio:
                    return Response(content=audio, media_type='audio/mpeg')
                last_error = '合成结果为空'
            except Exception as e:
                last_error = str(e)
                log.warning(f'[TTS] 第{attempt + 1}次合成失败: {e}')
                await asyncio.sleep(0.5 * (attempt + 1))

        log.error(f'[TTS] 合成失败 voice={req.voice} text={text[:30]!r}: {last_error}')
        return JSONResponse(status_code=500, content={'error': last_error})


if __name__ == '__main__':
    import os
    import uvicorn
    port = int(os.environ.get('PORT', 7860))
    log.info(f'read_aloud_tts_server 启动，监听 0.0.0.0:{port}')
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='info')
