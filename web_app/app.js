// ============ 配置 ============
const API_BASE = 'http://127.0.0.1:8765'; // 后端地址

// 支持的语言列表（语言代码 -> 显示名称 + 默认配音员）
const LANGUAGES = {
    'zh-CN': { name: '中文', default_voice: 'zh-CN-XiaoxiaoNeural', voices: [
        { name: '晓晓 (女)', voice: 'zh-CN-XiaoxiaoNeural' },
        { name: '晓伊 (女)', voice: 'zh-CN-XiaoyiNeural' },
        { name: '云溪 (男)', voice: 'zh-CN-YunxiNeural' },
        { name: '云阳 (男)', voice: 'zh-CN-YunyangNeural' },
    ]},
    'en-US': { name: 'English (US)', default_voice: 'en-US-AriaNeural', voices: [
        { name: 'Aria (女)', voice: 'en-US-AriaNeural' },
        { name: 'Guy (男)', voice: 'en-US-GuyNeural' },
        { name: 'Amber (女)', voice: 'en-US-AmberNeural' },
    ]},
    'en-GB': { name: 'English (UK)', default_voice: 'en-GB-SoniaNeural', voices: [
        { name: 'Sonia (女)', voice: 'en-GB-SoniaNeural' },
        { name: 'Ryan (男)', voice: 'en-GB-RyanNeural' },
    ]},
    'de': { name: 'Deutsch', default_voice: 'de-DE-FlorianMultilingualNeural', voices: [
        { name: 'Florian (男)', voice: 'de-DE-FlorianMultilingualNeural' },
    ]},
    'fr': { name: 'Français', default_voice: 'fr-FR-DeniseNeural', voices: [
        { name: 'Denise (女)', voice: 'fr-FR-DeniseNeural' },
    ]},
    'es': { name: 'Español', default_voice: 'es-ES-AlvaroNeural', voices: [
        { name: 'Alvaro (男)', voice: 'es-ES-AlvaroNeural' },
    ]},
    'ja': { name: '日本語', default_voice: 'ja-JP-NanamiNeural', voices: [
        { name: 'Nanami (女)', voice: 'ja-JP-NanamiNeural' },
    ]},
    'ko': { name: '한국어', default_voice: 'ko-KR-HyunsuMultilingualNeural', voices: [
        { name: 'Hyunsu (남)', voice: 'ko-KR-HyunsuMultilingualNeural' },
    ]},
};

// ============ 全局状态 ============
let state = {
    videoId: null,
    title: 'untitled',
    segments: [],
    selectedLang: 'zh-CN',
    selectedVoice: 'zh-CN-XiaoxiaoNeural',
    audioUrl: null,
    audioFileName: null,
    ytPlayer: null,       // YT.Player 实例（页内嵌入，不再用跨标签 BroadcastChannel）
    ytApiReady: false,
};

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
    initializeLanguageSelector();
    updateVoiceSelector('zh-CN');  // 初始化默认语言的配音员
    setupEventListeners();
    loadYouTubeIframeApi();
});

// ============ YouTube IFrame 播放器（页内嵌入，解决跨标签页 BroadcastChannel 无法跨域的问题） ============
function loadYouTubeIframeApi() {
    if (window.YT && window.YT.Player) {
        state.ytApiReady = true;
        return;
    }
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
}

// YouTube IFrame API 加载完成后会自动调用这个全局回调
window.onYouTubeIframeAPIReady = function () {
    state.ytApiReady = true;
    if (state.videoId) {
        initYtPlayer(state.videoId);
    }
};

function initYtPlayer(videoId) {
    document.getElementById('ytPlayerWrap').style.display = 'block';

    if (state.ytPlayer && typeof state.ytPlayer.loadVideoById === 'function') {
        state.ytPlayer.loadVideoById(videoId);
        return;
    }

    if (!state.ytApiReady || !window.YT || !window.YT.Player) {
        return; // API 还没加载完，onYouTubeIframeAPIReady 会在加载完后自动创建
    }

    state.ytPlayer = new YT.Player('ytPlayer', {
        width: '100%',
        height: '100%',
        videoId: videoId,
        playerVars: { rel: 0 },
    });
}

function initializeLanguageSelector() {
    const selector = document.getElementById('langSelector');
    Object.entries(LANGUAGES).forEach(([code, lang]) => {
        const btn = document.createElement('button');
        btn.className = 'lang-btn';
        btn.textContent = lang.name;
        btn.dataset.lang = code;
        if (code === 'zh-CN') btn.classList.add('active');
        selector.appendChild(btn);
    });

    // 使用事件委托
    selector.addEventListener('click', (e) => {
        if (e.target.classList.contains('lang-btn')) {
            selectLanguage(e.target.dataset.lang);
        }
    });
}

function selectLanguage(langCode) {
    console.log('选择语言:', langCode);
    state.selectedLang = langCode;

    // 更新语言按钮样式
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === langCode);
    });

    // 更新配音员列表
    updateVoiceSelector(langCode);
}

function updateVoiceSelector(langCode) {
    const selector = document.getElementById('voiceSelector');
    selector.innerHTML = '';

    const lang = LANGUAGES[langCode];
    if (!lang) return;

    lang.voices.forEach(voice => {
        const btn = document.createElement('div');
        btn.className = 'voice-option';
        btn.textContent = voice.name;
        btn.dataset.voice = voice.voice;

        if (voice.voice === lang.default_voice) {
            btn.classList.add('selected');
            state.selectedVoice = voice.voice;
        }

        selector.appendChild(btn);
    });

    // 移除旧的事件监听器后重新添加
    selector.removeEventListener('click', voiceSelectorClickHandler);
    selector.addEventListener('click', voiceSelectorClickHandler);
}

function voiceSelectorClickHandler(e) {
    if (e.target.classList.contains('voice-option')) {
        document.querySelectorAll('.voice-option').forEach(b => b.classList.remove('selected'));
        e.target.classList.add('selected');
        state.selectedVoice = e.target.dataset.voice;
        console.log('选择配音员:', e.target.dataset.voice);
    }
}

function setupEventListeners() {
    document.getElementById('fetchBtn').addEventListener('click', fetchSubtitles);
    document.getElementById('generateBtn').addEventListener('click', generateAudio);
    document.getElementById('syncBtn').addEventListener('click', () => syncPlayback());
    document.getElementById('downloadBtn').addEventListener('click', downloadAudio);

    document.getElementById('audioPlayer').addEventListener('timeupdate', updateProgress);
    document.getElementById('audioPlayer').addEventListener('loadedmetadata', updateTimeDisplay);
    document.getElementById('audioPlayer').addEventListener('play', syncVideoToAudio);
    document.getElementById('audioPlayer').addEventListener('pause', syncVideoPause);
    document.getElementById('audioPlayer').addEventListener('seeked', syncVideoSeek);
}

// ============ 提取 YouTube 视频 ID ============
function extractVideoId(url) {
    try {
        const urlObj = new URL(url);

        if (urlObj.hostname.includes('youtube.com')) {
            return urlObj.searchParams.get('v');
        } else if (urlObj.hostname.includes('youtu.be')) {
            return urlObj.pathname.slice(1).split('?')[0];
        }
    } catch (e) {}

    return null;
}

// ============ 获取字幕 ============
async function fetchSubtitles() {
    const url = document.getElementById('urlInput').value.trim();

    if (!url) {
        showStatus('请输入 YouTube 视频链接', 'error');
        return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        showStatus('无效的 YouTube 链接', 'error');
        return;
    }

    state.videoId = videoId;
    state.title = videoId;
    initYtPlayer(videoId);

    showStatus('正在获取字幕...', 'loading');
    document.getElementById('fetchBtn').disabled = true;

    try {
        const response = await fetch(`${API_BASE}/prefetch_captions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // lang：按用户选的朗读语言去抓对应的字幕/自动翻译字幕，不做任何机器翻译。
            body: JSON.stringify({ video_id: videoId, lang: state.selectedLang }),
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!data.ok) {
            throw new Error(data.error || '无法获取字幕');
        }

        if (!data.segments || data.segments.length === 0) {
            showStatus(`❌ 没找到「${LANGUAGES[state.selectedLang]?.name || state.selectedLang}」语言的字幕，`
                + `请先在 YouTube 播放器的字幕设置里手动开启/切换到该语言字幕，再回来重试`, 'error');
            document.getElementById('generateBtn').disabled = true;
            return;
        }

        state.segments = data.segments;

        showStatus(`✓ 成功获取 ${state.segments.length} 条字幕（匹配语言：${data.matched_lang || state.selectedLang}）`, 'success');
        displaySubtitles();
        document.getElementById('generateBtn').disabled = false;
        document.getElementById('syncHint').classList.add('show');

    } catch (error) {
        showStatus(`❌ ${error.message}`, 'error');
        console.error(error);
    } finally {
        document.getElementById('fetchBtn').disabled = false;
    }
}

function displaySubtitles() {
    const listEl = document.getElementById('subtitleList');
    const countEl = document.getElementById('subtitleCount');

    listEl.innerHTML = '';

    state.segments.slice(0, 20).forEach(seg => {
        const item = document.createElement('div');
        item.className = 'subtitle-item';

        const timeEl = document.createElement('div');
        timeEl.className = 'subtitle-time';
        timeEl.textContent = `[${formatTime(seg.start)} - ${formatTime(seg.end)}]`;

        const textEl = document.createElement('div');
        textEl.className = 'subtitle-text';
        textEl.textContent = seg.text;

        item.appendChild(timeEl);
        item.appendChild(textEl);
        listEl.appendChild(item);
    });

    countEl.textContent = `共 ${state.segments.length} 条字幕（显示前 20 条）`;
    listEl.style.display = 'block';
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// ============ 生成朗读（增量：边生成边出，前3句完成即可同步） ============
async function generateAudio() {
    if (!state.segments || state.segments.length === 0) {
        showStatus('没有字幕可朗读', 'error');
        return;
    }

    showStatus('正在启动朗读任务...', 'loading');
    document.getElementById('generateBtn').disabled = true;
    document.getElementById('syncBtn').style.display = 'none';
    document.getElementById('downloadBtn').style.display = 'none';
    document.getElementById('playerInfo').style.display = 'none';

    const genProgress = document.getElementById('genProgress');
    const genProgressFill = document.getElementById('genProgressFill');
    const genProgressText = document.getElementById('genProgressText');
    genProgress.style.display = 'block';
    genProgressFill.style.width = '0%';
    genProgressText.textContent = '正在启动朗读任务...';

    try {
        const segments = state.segments.map(s => ({
            start: s.start,
            end: s.end,
            text: s.text,
            voice: state.selectedVoice,
        }));

        const startResp = await fetch(`${API_BASE}/dub_start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                video_id: state.videoId,
                title: state.title,
                segments: segments,
                base_rate_pct: 0, // 让后端自动计算
                read_mode: true, // 朗读模式
                lang: state.selectedLang,
            }),
        });

        if (!startResp.ok) {
            throw new Error(`HTTP ${startResp.status}`);
        }

        const startData = await startResp.json();
        if (!startData.ok) {
            throw new Error(startData.error || '启动朗读失败');
        }

        await pollDubProgress(startData.total || state.segments.length);

    } catch (error) {
        showStatus(`❌ ${error.message}`, 'error');
        console.error(error);
        document.getElementById('generateBtn').disabled = false;
    }
}

// 轮询 /dub_progress，更新进度条；完成 >=3 句后提前显示"启动同步"
function pollDubProgress(total) {
    const genProgressFill = document.getElementById('genProgressFill');
    const genProgressText = document.getElementById('genProgressText');
    let syncRevealed = false;

    return new Promise((resolve) => {
        const tick = async () => {
            try {
                const resp = await fetch(`${API_BASE}/dub_progress/${state.videoId}`);
                const data = await resp.json();

                if (data.error) {
                    throw new Error(data.error);
                }

                const completedCount = data.completed.length;
                const percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;
                genProgressFill.style.width = percent + '%';
                genProgressText.textContent = `已生成 ${completedCount} / ${total} 句`;

                if (!syncRevealed && completedCount >= 3) {
                    syncRevealed = true;
                    state.audioUrl = `${API_BASE}/merged_audio/${state.videoId}`;
                    state.audioFileName = `dubbing_${state.videoId}.mp3`;
                    document.getElementById('audioPlayer').src = state.audioUrl;
                    document.getElementById('playerInfo').textContent = `⏳ 朗读生成中（${completedCount}/${total}），可先试听已完成部分`;
                    document.getElementById('playerInfo').style.display = 'block';
                    document.getElementById('syncBtn').style.display = 'inline-block';
                    showStatus('✓ 前几句已完成，可以提前试听/同步播放', 'success');
                }

                if (data.done) {
                    document.getElementById('generateBtn').disabled = false;
                    if (data.error) {
                        showStatus(`❌ 朗读失败: ${data.error}`, 'error');
                    } else {
                        // 全部完成，刷新为最终合并音频（加时间戳避免浏览器缓存旧的局部版本）
                        state.audioUrl = `${API_BASE}/merged_audio/${state.videoId}?t=${Date.now()}`;
                        document.getElementById('audioPlayer').src = state.audioUrl;
                        document.getElementById('playerInfo').textContent = `✓ 朗读生成完成（${completedCount} 段）`;
                        document.getElementById('playerInfo').style.display = 'block';
                        document.getElementById('syncBtn').style.display = 'inline-block';
                        document.getElementById('downloadBtn').style.display = 'inline-block';
                        showStatus('✓ 朗读生成成功！', 'success');
                    }
                    resolve();
                    return;
                }

                setTimeout(tick, 1200);
            } catch (error) {
                console.error('轮询朗读进度失败:', error);
                document.getElementById('generateBtn').disabled = false;
                showStatus(`❌ ${error.message}`, 'error');
                resolve();
            }
        };

        tick();
    });
}

// ============ 播放进度 ============
function updateProgress() {
    const audio = document.getElementById('audioPlayer');
    if (audio.duration) {
        const percent = (audio.currentTime / audio.duration) * 100;
        document.getElementById('progressFill').style.width = percent + '%';
        updateTimeDisplay();
    }
}

function updateTimeDisplay() {
    const audio = document.getElementById('audioPlayer');
    const current = formatTime(audio.currentTime);
    const total = formatTime(audio.duration || 0);
    document.getElementById('timeDisplay').textContent = `${current} / ${total}`;
}

// ============ 同步播放（页内嵌入视频，由朗读音轨单向驱动视频播放/暂停/跳转） ============
function syncPlayback() {
    if (!state.ytPlayer || typeof state.ytPlayer.seekTo !== 'function') {
        alert('视频还没加载好，请稍候再试。');
        return;
    }

    const audio = document.getElementById('audioPlayer');
    state.ytPlayer.seekTo(audio.currentTime, true);
    state.ytPlayer.playVideo();
    audio.play().catch(e => console.log('播放失败:', e));
}

function syncVideoToAudio() {
    if (state.ytPlayer && typeof state.ytPlayer.playVideo === 'function') {
        state.ytPlayer.playVideo();
    }
}

function syncVideoPause() {
    if (state.ytPlayer && typeof state.ytPlayer.pauseVideo === 'function') {
        state.ytPlayer.pauseVideo();
    }
}

function syncVideoSeek() {
    if (state.ytPlayer && typeof state.ytPlayer.seekTo === 'function') {
        const audio = document.getElementById('audioPlayer');
        state.ytPlayer.seekTo(audio.currentTime, true);
    }
}

// ============ 下载朗读音频 ============
function downloadAudio() {
    if (!state.audioUrl || !state.audioFileName) {
        alert('没有可下载的朗读音频');
        return;
    }

    const a = document.createElement('a');
    a.href = state.audioUrl;
    a.download = state.audioFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ============ 状态提示 ============
function showStatus(message, type) {
    const statusEl = document.getElementById('status');
    statusEl.textContent = message;
    statusEl.className = `status show ${type}`;

    if (type !== 'loading') {
        setTimeout(() => {
            statusEl.classList.remove('show');
        }, 3000);
    }
}
