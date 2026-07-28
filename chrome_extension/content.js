// YouTube / 通用视频 实时中文配音 - content script
// 流程：拿字幕 -> 发给本地后端翻译+TTS -> 按时间戳播放配音

// 配音服务器地址：默认指向我们运营的云端服务（Cloud Run），可在 popup 设置里改成
// 本机/局域网地址（比如旧电脑自己跑不了 Python 服务，让它连局域网里能跑服务的那台
// 主机），也可以填别的云端地址（比如备用的 HF Space）。
// 用 let 而不是 const——下面会从 chrome.storage 读用户设置覆盖默认值。
const DEFAULT_SERVER = 'https://dub-server-921963653375.us-central1.run.app';
const TEST_SERVER = 'https://ingrid919-dub-server.hf.space';
let SERVER = DEFAULT_SERVER;
const IS_YOUTUBE = location.hostname.includes('youtube.com');

// 配音服务连不上时的报错文案——之前写死成"请确认 live_dub.bat 已运行"，但用户可能
// 填的是局域网另一台主机、或云端HF Space地址，这种情况下提示"启动本地bat"完全是
// 误导。根据当前实际填的 SERVER 地址判断是本机/局域网还是远程云端，给对应的提示。
function isLocalOrLanServer() {
  try {
    const host = new URL(SERVER).hostname;
    return host === '127.0.0.1' || host === 'localhost' || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(host);
  } catch (_) { return true; }
}
function serverDownMessage() {
  if (isLocalOrLanServer()) {
    return `连不上配音服务（${SERVER}），请确认 live_dub.bat 已运行（或局域网那台主机的服务没掉）`;
  }
  return `连不上配音服务器（${SERVER}），请检查该服务是否在线（云端服务偶尔会重启/休眠），或检查网络连接`;
}

// 客户端身份ID保留给未来商业版授权使用；当前Gemini翻译不设额度限制。
let _clientId = '';
chrome.storage.local.get({ ytdClientId: '' }, (cfg) => {
  if (cfg.ytdClientId) { _clientId = cfg.ytdClientId; return; }
  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  _clientId = id;
  chrome.storage.local.set({ ytdClientId: id });
});

// ===== 朗读模式专用：云端 TTS =====
// 默认生产服务器（Cloud Run）也提供 /tts；HF 是备用 TTS。两个端点互相补位：
// 当前首选端点拿不到有效音频时，立即切到另一个端点，避免退到浏览器机械音。
const HF_READ_ALOUD_TTS_SERVER = 'https://ingrid919-read-video-tts.hf.space';
function normalizeServerUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}
function pushUniqueServer(list, url) {
  const normalized = normalizeServerUrl(url);
  if (normalized && !list.includes(normalized)) list.push(normalized);
  return list;
}
function getDubServerCandidates() {
  const list = [];
  pushUniqueServer(list, SERVER || DEFAULT_SERVER);
  pushUniqueServer(list, DEFAULT_SERVER);
  pushUniqueServer(list, TEST_SERVER);
  return list;
}
function getCloudTtsServers() {
  const list = [];
  if (normalizeServerUrl(SERVER) === normalizeServerUrl(TEST_SERVER)) {
    pushUniqueServer(list, HF_READ_ALOUD_TTS_SERVER);
    pushUniqueServer(list, DEFAULT_SERVER);
  } else {
    pushUniqueServer(list, SERVER || DEFAULT_SERVER);
    pushUniqueServer(list, DEFAULT_SERVER);
    pushUniqueServer(list, HF_READ_ALOUD_TTS_SERVER);
  }
  return list;
}

// 朗读语言码 -> edge-tts 语音名。覆盖 edge-tts 当前全部 75 种语言（不再是挑常见的二十来种），
// 跟 live_dub_server.py 的 lang_prefix_voice/full_voice_map 保持同一套默认音色，避免
// 同一语言在配音/朗读两条路径上用了不同声音。没命中任何语言才退到英文女声。
// 这是"默认单声"映射；男女双声选项见 _READ_VOICE_GENDERS（供未来 popup 里挑性别用）。
const _READ_VOICE_MAP = {
  // 完整语言码优先匹配（比前缀更精确，如 zh-TW/zh-HK/en-GB/pt-PT 等地区变体）
  'zh-tw': 'zh-TW-HsiaoChenNeural', 'zh-hk': 'zh-HK-HiuGaaiNeural', 'zh-hant': 'zh-TW-HsiaoChenNeural',
  'zh-cn': 'zh-CN-XiaoxiaoNeural', 'zh-hans': 'zh-CN-XiaoxiaoNeural', 'en-us': 'en-US-AriaNeural',
  'en-gb': 'en-GB-SoniaNeural', 'en-au': 'en-AU-NatashaNeural', 'pt-br': 'pt-BR-ThalitaMultilingualNeural',
  'pt-pt': 'pt-PT-RaquelNeural', 'es-mx': 'es-MX-DaliaNeural', 'fr-ca': 'fr-CA-SylvieNeural',

  // 语言前缀兜底（75 种）
  af: 'af-ZA-AdriNeural', am: 'am-ET-AmehaNeural', ar: 'ar-SA-HamedNeural',
  az: 'az-AZ-BabekNeural', bg: 'bg-BG-BorislavNeural', bn: 'bn-BD-NabanitaNeural',
  bs: 'bs-BA-VesnaNeural', ca: 'ca-ES-JoanaNeural', cs: 'cs-CZ-AntoninNeural',
  cy: 'cy-GB-AledNeural', da: 'da-DK-JeppeNeural', de: 'de-DE-FlorianMultilingualNeural',
  el: 'el-GR-NestorasNeural', en: 'en-US-AriaNeural', es: 'es-ES-AlvaroNeural',
  et: 'et-EE-AnuNeural', fa: 'fa-IR-DilaraNeural', fi: 'fi-FI-HarriNeural',
  fil: 'fil-PH-AngeloNeural', fr: 'fr-FR-DeniseNeural', ga: 'ga-IE-ColmNeural',
  gl: 'gl-ES-RoiNeural', gu: 'gu-IN-NiranjanNeural', he: 'he-IL-AvriNeural',
  hi: 'hi-IN-MadhurNeural', hr: 'hr-HR-SreckoNeural', hu: 'hu-HU-TamasNeural',
  id: 'id-ID-ArdiNeural', is: 'is-IS-GudrunNeural', it: 'it-IT-GiuseppeMultilingualNeural',
  iu: 'iu-Latn-CA-SiqiniqNeural', ja: 'ja-JP-NanamiNeural', jv: 'jv-ID-DimasNeural',
  ka: 'ka-GE-GiorgiNeural', kk: 'kk-KZ-AigulNeural', km: 'km-KH-PisethNeural',
  kn: 'kn-IN-GaganNeural', ko: 'ko-KR-HyunsuMultilingualNeural', lo: 'lo-LA-ChanthavongNeural',
  lt: 'lt-LT-LeonasNeural', lv: 'lv-LV-EveritaNeural', mk: 'mk-MK-AleksandarNeural',
  ml: 'ml-IN-MidhunNeural', mn: 'mn-MN-BataaNeural', mr: 'mr-IN-AarohiNeural',
  ms: 'ms-MY-OsmanNeural', mt: 'mt-MT-GraceNeural', my: 'my-MM-NilarNeural',
  nb: 'nb-NO-FinnNeural', ne: 'ne-NP-HemkalaNeural', nl: 'nl-NL-MaartenNeural',
  pl: 'pl-PL-MarekNeural', ps: 'ps-AF-GulNawazNeural', pt: 'pt-BR-ThalitaMultilingualNeural',
  ro: 'ro-RO-AlinaNeural', ru: 'ru-RU-DmitryNeural', si: 'si-LK-SameeraNeural',
  sk: 'sk-SK-LukasNeural', sl: 'sl-SI-RokNeural', so: 'so-SO-MuuseNeural',
  sq: 'sq-AL-IlirNeural', sr: 'sr-RS-NicholasNeural', su: 'su-ID-JajangNeural',
  sv: 'sv-SE-MattiasNeural', sw: 'sw-KE-RafikiNeural', ta: 'ta-IN-ValluvarNeural',
  te: 'te-IN-MohanNeural', th: 'th-TH-NiwatNeural', tr: 'tr-TR-AhmetNeural',
  uk: 'uk-UA-OstapNeural', ur: 'ur-PK-AsadNeural', uz: 'uz-UZ-MadinaNeural',
  vi: 'vi-VN-NamMinhNeural', zh: 'zh-CN-XiaoxiaoNeural', zu: 'zu-ZA-ThandoNeural',
};

function pickVoiceForLang(lang) {
  const full = (lang || 'en').toLowerCase();
  const prefix = full.split('-')[0];
  // 用户在 popup"语言↔配音员对照表"里手动选过这门语言的音色 → 优先用，没选过才用默认表。
  return langVoiceOverrides[full] || langVoiceOverrides[prefix]
    || _READ_VOICE_MAP[full] || _READ_VOICE_MAP[prefix] || 'en-US-AriaNeural';
}

// 调云端 TTS，成功返回一个 blob: URL（可直接当 Audio.src 用，同源、不用走 background 中转）。
async function _fetchCloudTTSOnce(server, text, voice, ratePct) {
  const res = await fetch(`${server}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, rate_pct: ratePct || 0 }),
  });
  if (!res.ok) throw new Error(`${server} 云端TTS HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error(`${server} 云端TTS返回空音频`);
  return URL.createObjectURL(blob);
}

// 用户反馈见过别的配音软件"前两小时正常，之后就没声音或者干脆读成英语"——大概率是
// 云端 TTS 偶发抽风/冷重启导致单次请求失败，没重试就直接判死、退到兜底语音。这里给
// 云端 TTS 调用加几次重试，挡掉这种瞬时失败，避免一次抽风就把后面一长段都搭进浏览器
// 自带语音的兜底（兜底语音音色差、还可能选错语言，见 speakWithWebSpeech 的说明）。
async function fetchCloudTTS(text, voice, ratePct) {
  const delays = [0, 350];
  let lastErr = null;
  for (const server of getCloudTtsServers()) {
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
      try {
        const audioUrl = await _fetchCloudTTSOnce(server, text, voice, ratePct);
        if (server !== getCloudTtsServers()[0]) console.warn('[朗读] 主TTS失败后已切换备用服务器', server);
        return audioUrl;
      } catch (e) {
        lastErr = e;
        if (i === delays.length - 1) console.warn('[朗读] TTS服务器未返回有效音频，尝试下一个', server, e?.message || e);
      }
    }
  }
  throw lastErr;
}

// 云端失败时的兜底：直接用浏览器自带语音朗读（无法精确对齐时间轴，但好过没声音）。
// 关键修复：之前直接把 lang 字符串塞进 utter.lang，但如果这台电脑/浏览器没装对应
// 语言的语音包，Chrome 不会报错，会**静默换成系统默认语音**（多数是英语）——这正是
// "云端失败后突然读起英语"的真因。现在主动从 speechSynthesis.getVoices() 里找一个
// 语言匹配的语音，找不到才退到默认（并明确打印警告，这样问题能被发现，不是"突然就这样了"）。
function speakWithWebSpeech(text, lang) {
  try {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    const targetLang = (lang || 'en-US').toLowerCase();
    const prefix = targetLang.split('-')[0];
    const voices = window.speechSynthesis.getVoices() || [];
    const match = voices.find((v) => v.lang?.toLowerCase().startsWith(prefix));
    if (match) {
      utter.voice = match;
      utter.lang = match.lang;
    } else {
      utter.lang = targetLang;
      console.warn(`[朗读] 本机没有装"${targetLang}"对应的语音包，兜底语音可能会用系统默认语言朗读`);
    }
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn('[朗读] 浏览器自带语音也失败了', e);
  }
}

// 朗读模式专用：逐句调云端 TTS，整理成跟 sendChunk() 返回值同形状的数组，
// 这样下游的 playNextDue/getAudio/prefetchAhead 完全不用改，照常吃 audio_url 这个字段。
async function sendChunkReadAloudCloud(segments, lang) {
  const voice = pickVoiceForLang(lang);
  return Promise.all(segments.map(async (seg) => {
    const text = (seg.text || '').trim();
    const duration = seg.end - seg.start;
    let audio_url = null;
    if (text) {
      try {
        audio_url = await fetchCloudTTS(text, voice, 0);
      } catch (e) {
        console.warn('[朗读] 云端TTS重试多次后仍失败，回退浏览器自带语音', seg.start, e.message);
        speakWithWebSpeech(text, lang);
      }
    }
    return { start: seg.start, end: seg.end, text: seg.text, translation: text,
             duration, tts_duration: duration, audio_url,
             _sourceKey: makeSourceSegKey(seg),
             _sourceStart: seg.start, _sourceEnd: seg.end, _sourceText: seg.text };
  }));
}

// ===== 全局设置（从 popup 同步）=====
let origVolume = 0.3;
let showSubs = true;
let multiSpeakerEnabled = false;
let autoDub = false;
// 不管单个视频还是播放列表连续配音，只要勾了这个，视频结束/停止配音时都自动下载
// 变速日志+字幕+配音录音这一整套文件——跟 autoDub 是两个独立开关，不绑在一起。
let autoExportFiles = false;
// 同样独立的开关：勾了就连画面（视频画面+我们叠的字幕层）一起录，不只是录音频——
// 录出来是一份"画面+字幕+配音"三合一的成片，不用再额外拼变速日志/字幕文件。
// 没勾这个、但勾了 autoExportFiles 时，还是只录纯音频（webm音频文件）。
let autoRecordVideo = false;
let useGeminiTranslate = false;  // 配音模式：勾选后原文走Gemini重新翻译，不依赖YT自动翻译质量
let dubMode = 'dub';   // 功能模式：'dub' 配音 / 'read' 朗读（在 popup 设置里选）
let subFontScale = 1.0;   // 字幕大小倍数（在自适应基础上再乘这个），popup 里滑块调
let subBgOpacity = 0.8;   // 字幕背景透明度 0~1，popup 里滑块调
let speakerCfg = {
  maleCount: 0, femaleCount: 2,
  maleVoices: ['zh-CN-YunxiNeural', 'zh-CN-YunyangNeural'],
  femaleVoices: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaohanNeural'],
};
// 用户在 popup"语言↔配音员对照表"里手动选的音色覆盖：{ [langCode]: voiceId }。
// 朗读（pickVoiceForLang）和配音（sendChunk 给每段附带 voice 字段）都读这份表，
// 同一种语言在两个功能里用同一个用户选的音色，没设置就都退回默认。
let langVoiceOverrides = {};
let dubCacheVoiceAutoPick = false;
let defaultMaleVoice = 'zh-CN-YunxiNeural';
let defaultFemaleVoice = 'zh-CN-XiaoxiaoNeural';

// chrome.storage.local.get 是异步的：如果用户点"开始配音"很快（或开了自动配音），
// 第一批字幕段可能在这个回调跑完之前就已经在拼 voice 字段了，那时 langVoiceOverrides
// 还是上面的空对象 {}，导致 voice 传 null、服务器退回默认女声 Xiaoxiao——
// 表现就是"设置了男配音，开头还是女配音，过一会儿才变成男声"。
// 用这个 Promise 让 startDubbing 在真正发第一批请求前等设置加载完。
let _settingsLoadedResolve;
const _settingsLoaded = new Promise((r) => { _settingsLoadedResolve = r; });

chrome.storage.local.get(
  { origVolume: 0.3, showSubs: true, multiSpeaker: false, autoDub: false, autoExportFiles: false, autoRecordVideo: false, dubMode: 'dub',
    useGeminiTranslate: false,
    subFontScale: 1.0, subBgOpacity: 0.8, serverUrl: '',
    maleCount: 0, femaleCount: 2,
    maleVoices: ['zh-CN-YunxiNeural','zh-CN-YunyangNeural'],
    femaleVoices: ['zh-CN-XiaoxiaoNeural','zh-CN-XiaohanNeural'],
    langVoiceOverrides: {},
    dubCacheVoiceAutoPick: false,
    defaultMaleVoice: 'zh-CN-YunxiNeural',
    defaultFemaleVoice: 'zh-CN-XiaoxiaoNeural' },
  (cfg) => {
    origVolume = cfg.origVolume;
    showSubs = cfg.showSubs;
    multiSpeakerEnabled = cfg.multiSpeaker;
    autoDub = cfg.autoDub;
    // "三合一"（连画面录）是 autoExportFiles 的子选项，勾了子选项却没勾主开关就什么都
    // 不会导出/录制（用户反馈过"勾了三合一但什么都没下载"）。popup.js 那边已经在用户
    // 重新勾选时做了联动修正，但如果 storage 里已经是修复前就存下的不一致状态（三合一=true、
    // 主开关=false），不重新点一次复选框是不会被纠正的。这里直接在消费端做"或"处理，
    // 不管 storage 里两个值具体是什么组合，只要三合一开着就一定会触发导出，不依赖
    // 用户记得手动去 popup 里再点一下。
    // 2026-07-26：录音/录像/自动下载链路暂时从实时配音主流程移除。
    // storage 里可能残留旧的 true；这里强制关闭，避免它抢 tabCapture、刷下载失败、
    // 或在首批配音就绪时插入额外异步步骤，导致“有缓存也迟迟不开声”。
    autoExportFiles = false;
    autoRecordVideo = false;
    useGeminiTranslate = cfg.useGeminiTranslate;
    dubMode = cfg.dubMode || 'dub';
    subFontScale = cfg.subFontScale || 1.0;
    subBgOpacity = (cfg.subBgOpacity != null) ? cfg.subBgOpacity : 0.8;
    if (cfg.serverUrl) SERVER = cfg.serverUrl.replace(/\/+$/, '');
    speakerCfg = { maleCount: cfg.maleCount, femaleCount: cfg.femaleCount,
                   maleVoices: cfg.maleVoices, femaleVoices: cfg.femaleVoices };
    langVoiceOverrides = cfg.langVoiceOverrides || {};
    dubCacheVoiceAutoPick = !!cfg.dubCacheVoiceAutoPick;
    defaultMaleVoice = isChineseDubVoice(cfg.defaultMaleVoice) ? cfg.defaultMaleVoice : 'zh-CN-YunxiNeural';
    defaultFemaleVoice = isChineseDubVoice(cfg.defaultFemaleVoice) ? cfg.defaultFemaleVoice : 'zh-CN-XiaoxiaoNeural';
    _settingsLoadedResolve();
  }
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.origVolume) origVolume = changes.origVolume.newValue;
  if (changes.showSubs) showSubs = changes.showSubs.newValue;
  if (changes.multiSpeaker) multiSpeakerEnabled = changes.multiSpeaker.newValue;
  if (changes.autoDub) autoDub = changes.autoDub.newValue;
  if (changes.autoExportFiles) autoExportFiles = false;
  if (changes.autoRecordVideo) {
    autoRecordVideo = false;
    autoExportFiles = false;
  }
  if (changes.useGeminiTranslate) useGeminiTranslate = changes.useGeminiTranslate.newValue;
  if (changes.dubCacheVoiceAutoPick) dubCacheVoiceAutoPick = !!changes.dubCacheVoiceAutoPick.newValue;
  if (changes.defaultMaleVoice) {
    defaultMaleVoice = isChineseDubVoice(changes.defaultMaleVoice.newValue)
      ? changes.defaultMaleVoice.newValue : 'zh-CN-YunxiNeural';
  }
  if (changes.defaultFemaleVoice) {
    defaultFemaleVoice = isChineseDubVoice(changes.defaultFemaleVoice.newValue)
      ? changes.defaultFemaleVoice.newValue : 'zh-CN-XiaoxiaoNeural';
  }
  if (changes.langVoiceOverrides) {
    langVoiceOverrides = changes.langVoiceOverrides.newValue || {};
    if (IS_YOUTUBE) {
      try {
        const url = new URL(location.href);
        const id = url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1]
          || url.searchParams.get('v');
        if (id) startBackgroundDubStatusPolling(id);
      } catch (_) {}
    }
  }
  if (changes.subFontScale) subFontScale = changes.subFontScale.newValue || 1.0;
  if (changes.subBgOpacity != null && changes.subBgOpacity.newValue != null) subBgOpacity = changes.subBgOpacity.newValue;
  if (changes.serverUrl) SERVER = (changes.serverUrl.newValue || DEFAULT_SERVER).replace(/\/+$/, '');
  if (changes.dubMode) {
    dubMode = changes.dubMode.newValue || 'dub';
    // 切换模式：停掉所有正在运行的会话（选一个，另一个自动停），并重建按钮
    for (const sess of activeSessions()) {
      if (sess.started) { try { stopDubbing(sess, null); } catch (_) {} }
    }
    try {
      document.getElementById('dub-ext-btn')?.remove();
      document.getElementById('read-ext-btn')?.remove();
    } catch (_) {}
  }
  for (const k of ['maleCount','femaleCount','maleVoices','femaleVoices'])
    if (changes[k]) speakerCfg[k] = changes[k].newValue;
  // 同步所有活跃 session
  for (const sess of activeSessions()) {
    if (sess.started) {
      sess.video.volume = origVolume;
      if (!showSubs && sess.subtitleEl) sess.subtitleEl.textContent = '';
    }
  }
});

// ===== Session 对象（每个视频一个）=====
function makeSession(video) {
  return {
    video,
    started: false,
    dubSegments: null,
    curAudio: null,
    audioCache: {},
    weArePausing: false,
    bufferMissCount: 0,
    subtitleEl: null,
    lastSubText: null,
    videoId: null,
    title: null,
    _lastMatchedProfile: null,  // 最近一次成功匹配的说话人，用于无数据时延续
    _onTimeUpdate: null,
    _onSeeking: null,
    _onPause: null,
    _onEnded: null,
    _endFinalizeTimer: null,
    _rateLog: null,
    _diagnosticLog: [],
    _diagnosticCounts: {},
    _tabRecording: false,   // 是否已经通过 tabCapture 在录这个标签页的音频（见 startTabAudioRecording）
  };
}

const videoSessionMap = new WeakMap(); // video element -> session

// 播放列表/自动播放连续切视频时，YouTube 经常直接换成一个全新的 <video> 元素
// （不是复用旧元素改src），旧元素被丢弃后就再也没有任何DOM引用能找到它——这时如果
// 还想找"上一个视频的session"来停止配音/触发录制下载，靠"document.querySelector
// ('video')拿到当前视频元素，再去videoSessionMap里查它的session"这个套路必然落空
// （拿到的已经是新视频的全新元素，videoSessionMap里根本没有它的记录），表现就是
// "自动连续配音时，上一个视频的录制永远不会停止/下载，一直空转到累积了好几个视频
// 的录音数据都没有触发过一次下载"。用这个不依赖DOM查找的强引用记录"最近一次
// 活跃的session"，在getOrCreateSession里更新，videoSessionMap切视频失效时它依然有效。
let _lastActiveSess = null;
// 同一标签页的连续播放只申请一次 tabCapture。视频边界只切分文件，不关闭捕获流；
// 否则第二个视频由脚本自动启动，没有用户手势，Chrome 会拒绝重新申请捕获权限。
let _continuousTabRecording = false;

function getOrCreateSession(video) {
  if (!videoSessionMap.has(video)) videoSessionMap.set(video, makeSession(video));
  const sess = videoSessionMap.get(video);
  _lastActiveSess = sess;
  return sess;
}

function activeSessions() {
  // WeakMap 无法枚举，用已知按钮元素反查
  const sessions = [];
  document.querySelectorAll('[data-dub-video-idx]').forEach((btn) => {
    const video = btn._dubVideo;
    if (video && videoSessionMap.has(video)) sessions.push(videoSessionMap.get(video));
  });
  return sessions;
}

// 是否处于全屏：全屏时视频铺满整个屏幕，"外侧"没有任何空间，只能退回贴在视频内部。
function _isVideoFullscreen(video) {
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (!fsEl || !video) return false;
  return fsEl === video || (fsEl.contains && fsEl.contains(video));
}

// ===== 缓冲提示（纯状态信息，不是内容，录屏不需要）=====
// 所有状态提示固定放在视频下方、靠右对齐。绝不尝试视频右侧，也绝不覆盖画面。
let bufferIndicatorEl = null;
let _bufferIndicatorVideo = null;
function _positionBufferIndicator() {
  if (!bufferIndicatorEl || !_bufferIndicatorVideo) return;
  const r = _bufferIndicatorVideo.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) { bufferIndicatorEl.style.display = 'none'; return; }
  if (_isVideoFullscreen(_bufferIndicatorVideo)) {
    // 全屏时没有"视频外"的空间——录屏（画面+字幕+配音三合一）通常就在全屏状态下进行，
    // 之前退到视频内部右下角显示，会把提示条一起烧进录制的画面里。宁可不提示，也不能
    // 让这种临时状态提示混进最终成片，所以全屏时直接隐藏，不叠加在视频画面上。
    bufferIndicatorEl.style.display = 'none';
    return;
  }
  bufferIndicatorEl.style.display = 'block';
  bufferIndicatorEl.style.position = 'absolute';
  bufferIndicatorEl.style.left = (window.scrollX + r.left + r.width / 2) + 'px';
  bufferIndicatorEl.style.top = (window.scrollY + r.bottom + 8) + 'px';
  bufferIndicatorEl.style.transform = 'translateX(-50%)';
  bufferIndicatorEl.style.maxWidth = Math.min(420, Math.max(240, r.width)) + 'px';
}
function _onBufferIndicatorReposition() { _positionBufferIndicator(); }
function showBufferIndicator(msg, video) {
  if (!bufferIndicatorEl) {
    bufferIndicatorEl = document.createElement('div');
    bufferIndicatorEl.style.cssText =
      'position:absolute;z-index:2147483647;' +
      'background:rgba(0,0,0,0.82);color:#fff;font-size:14px;padding:10px 18px;' +
      "border-radius:8px;pointer-events:auto;font-family:'Microsoft YaHei',sans-serif;" +
      'text-align:center;max-width:320px;box-shadow:0 2px 12px rgba(0,0,0,0.4);';
    document.body.appendChild(bufferIndicatorEl);
    window.addEventListener('resize', _onBufferIndicatorReposition);
    window.addEventListener('scroll', _onBufferIndicatorReposition, { passive: true });
    document.addEventListener('fullscreenchange', _onBufferIndicatorReposition);
  }
  bufferIndicatorEl.replaceChildren();
  const text = document.createElement('span');
  text.textContent = msg || '🎧 配音缓冲中…';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = '关闭提示';
  close.style.cssText =
    'position:absolute;right:3px;top:1px;border:0;background:transparent;' +
    'color:#fff;font-size:18px;line-height:20px;cursor:pointer;padding:0 4px;';
  close.addEventListener('click', hideBufferIndicator);
  bufferIndicatorEl.append(text, close);
  _bufferIndicatorVideo = video || _bufferIndicatorVideo || document.querySelector('video');
  _positionBufferIndicator();
}

function recordDiagnostic(sess, type, detail = {}) {
  if (!sess) return;
  if (!sess._diagnosticLog) sess._diagnosticLog = [];
  if (!sess._diagnosticCounts) sess._diagnosticCounts = {};
  sess._diagnosticCounts[type] = (sess._diagnosticCounts[type] || 0) + 1;
  const entry = {
    at: new Date().toISOString(),
    videoTime: +(sess.video?.currentTime || 0).toFixed(3),
    type,
    count: sess._diagnosticCounts[type],
    ...detail,
  };
  sess._diagnosticLog.push(entry);
  if (sess._diagnosticLog.length > 500) sess._diagnosticLog.shift();
  console.log('[配音插件][诊断]', entry);
}

function getDubRiskState(sess) {
  const video = sess?.video;
  const now = video?.currentTime || 0;
  const duration = video?.duration || 0;
  const remaining = duration > 0 ? Math.max(0, duration - now) : Infinity;
  const priorityRetry = sess?._priorityRetryCount || 0;
  const loadSkips = sess?._diagnosticCounts?.audio_segment_forced_regeneration || 0;
  const loadRetries = (sess?._diagnosticCounts?.audio_segment_load_retry || 0)
    + (sess?._diagnosticCounts?.audio_playback_failure_retry || 0);
  const bufferingMs = sess?._bufferingSince ? (Date.now() - sess._bufferingSince) : 0;
  const tailRisk = Number.isFinite(remaining) && remaining <= 20 * 60;
  const troubleSignals = (
    priorityRetry >= 2
    || bufferingMs >= 12000
    || loadSkips >= 1
    || loadRetries >= 3
    || !!sess?._forceConservativeDubbing
  );
  // 结尾二十分钟不是“应该减速”的风险，而是最需要尽快补齐库存的阶段。
  // 之前把 tailRisk 并入 conservative，会把每批从 10 段降到 3 段；长视频
  // 因而总是在最后二十分钟掉到播放进度之后。保守策略只用于真实故障信号。
  const conservative = troubleSignals;
  return {
    conservative,
    tailRisk,
    troubleSignals,
    remaining,
    bufferingMs,
    priorityRetry,
    loadSkips,
    loadRetries,
  };
}

function getAdaptiveChunkSize(sess, chunkNo) {
  const risk = getDubRiskState(sess);
  const current = Number(sess?.video?.currentTime || 0);
  if (current < REALTIME_START_CRITICAL_SECONDS && !risk.troubleSignals) {
    return chunkNo <= 1 ? 12 : 18;
  }
  if (risk.tailRisk && !risk.troubleSignals) {
    if (!sess._tailInventoryAccelerationLogged) {
      sess._tailInventoryAccelerationLogged = true;
      recordDiagnostic(sess, 'tail_inventory_acceleration', {
        remaining: Number.isFinite(risk.remaining) ? +risk.remaining.toFixed(1) : null,
        reason: 'tail_must_finish_before_playhead',
      });
      console.log('[配音插件] 进入结尾库存加速：提高批量，不再缩小到3句');
    }
    // 服务端每个 /dub 请求内部有 6 路 TTS 并发；12 段既能压低 HTTP 往返开销，
    // 又不会把单次响应推到客户端 45 秒超时之外。
    return 12;
  }
  sess._tailInventoryAccelerationLogged = false;
  if (risk.conservative) {
    if (!sess._conservativeModeLogged) {
      sess._conservativeModeLogged = true;
      recordDiagnostic(sess, 'entered_conservative_chunk_mode', {
        remaining: Number.isFinite(risk.remaining) ? +risk.remaining.toFixed(1) : null,
        bufferingMs: risk.bufferingMs,
        priorityRetry: risk.priorityRetry,
        loadSkips: risk.loadSkips,
        loadRetries: risk.loadRetries,
        reason: risk.tailRisk ? 'tail_window' : 'runtime_trouble',
      });
    }
    // 真有错误时才收小批次；仍保留 6 段并发，不能让“自我保护”反过来饿死库存。
    return chunkNo === 0 ? 3 : 6;
  }
  sess._conservativeModeLogged = false;
  const CHUNK_SIZES = [2, 6, 10];
  return CHUNK_SIZES[Math.min(chunkNo, CHUNK_SIZES.length - 1)];
}

let _backgroundDubPollTimer = null;
let _backgroundDubPollVideoId = '';
function getPreferredChineseVoice() {
  return langVoiceOverrides['zh-tw']
    || langVoiceOverrides['zh-hant']
    || langVoiceOverrides['zh-hk']
    || langVoiceOverrides['zh']
    || langVoiceOverrides['zh-cn']
    || null;
}

function getDefaultChineseDubVoice() {
  const preferred = getPreferredChineseVoice();
  if (isChineseDubVoice(preferred)) return preferred;
  if (isChineseDubVoice(defaultFemaleVoice)) return defaultFemaleVoice;
  const enabledVoices = [
    ...(speakerCfg.femaleVoices || []).slice(0, speakerCfg.femaleCount || 0),
    ...(speakerCfg.maleVoices || []).slice(0, speakerCfg.maleCount || 0),
    ...(speakerCfg.femaleVoices || []),
    ...(speakerCfg.maleVoices || []),
  ].filter(isChineseDubVoice);
  return enabledVoices[0] || 'zh-CN-XiaoxiaoNeural';
}

function getDefaultChineseDubVoiceByGender(gender) {
  const normalized = String(gender || '').toLowerCase();
  if (normalized.startsWith('m') || /男/.test(normalized)) {
    return isChineseDubVoice(defaultMaleVoice) ? defaultMaleVoice : 'zh-CN-YunxiNeural';
  }
  if (normalized.startsWith('f') || /女/.test(normalized)) {
    return isChineseDubVoice(defaultFemaleVoice) ? defaultFemaleVoice : 'zh-CN-XiaoxiaoNeural';
  }
  return getDefaultChineseDubVoice();
}

function getDubVoiceGender(voice) {
  const g = dubVoiceMeta(voice).gender;
  if (/男/.test(g)) return 'male';
  if (/女/.test(g)) return 'female';
  return '';
}

function getOppositeDefaultDubVoice(currentVoice) {
  const currentGender = getDubVoiceGender(currentVoice);
  if (currentGender === 'female') return getDefaultChineseDubVoiceByGender('male');
  if (currentGender === 'male') return getDefaultChineseDubVoiceByGender('female');
  const fallback = getDefaultChineseDubVoice();
  return getDubVoiceGender(fallback) === 'female'
    ? getDefaultChineseDubVoiceByGender('male')
    : getDefaultChineseDubVoiceByGender('female');
}

function setDubButtonBackgroundState(state, videoId = '', percent = null) {
  if (videoId) {
    const url = new URL(location.href);
    const current = url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1]
      || url.searchParams.get('v') || '';
    if (current !== videoId) return;
  }
  const btn = document.getElementById('dub-ext-btn');
  if (!btn) return;
  if (state === 'background') {
    btn.style.setProperty('background', '#d81b60', 'important');
    btn.style.setProperty('border-radius', '16px', 'important');
    btn.title = '后台配音生成中；完成后按钮会变为绿色';
    btn.dataset.backgroundDubState = 'processing';
    const value = Number(percent);
    btn.textContent = Number.isFinite(value)
      ? `🎧后台 ${Math.min(99, Math.max(0, Math.floor(value)))}%`
      : '🎧后台 0%';
  } else if (state === 'ready') {
    btn.style.setProperty('background', '#16803a', 'important');
    btn.style.setProperty('border-radius', '16px', 'important');
    btn.title = '完整配音缓存已就绪；点击即可从头播放缓存配音';
    btn.dataset.backgroundDubState = 'ready';
    btn.textContent = '🎧配音 ✓';
  } else if (state === 'voice-mismatch') {
    btn.style.removeProperty('background');
    btn.style.removeProperty('border-radius');
    delete btn.dataset.backgroundDubState;
    btn.textContent = '🎧配音';
    btn.title = '后台缓存已完成，但音色与当前配音员不同；切回原配音员即可复用';
  } else {
    btn.style.removeProperty('background');
    btn.style.removeProperty('border-radius');
    delete btn.dataset.backgroundDubState;
    btn.textContent = '🎧配音';
  }
}

function backgroundVoiceMatchesCurrent(job) {
  const current = getDefaultChineseDubVoice();
  const cachedVoices = Array.isArray(job?.voices) && job.voices.length
    ? job.voices : [getDefaultChineseDubVoice()];
  return cachedVoices.includes(current);
}

function currentBackgroundVideoId() {
  try {
    const url = new URL(location.href);
    return url.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1]
      || url.searchParams.get('v') || '';
  } catch (_) {
    return '';
  }
}

function startBackgroundDubStatusPolling(videoId) {
  if (_backgroundDubPollTimer) clearInterval(_backgroundDubPollTimer);
  _backgroundDubPollTimer = null;
  _backgroundDubPollVideoId = videoId || '';
  let failureShown = false;
  let missCount = 0;
  const refresh = async () => {
    try {
      const local = await chrome.runtime.sendMessage({ action: 'getPrefetchStatus' });
      const localState = local?.videoStates?.[videoId];
      let localPercent = null;
      const loopDebug = local?.loopDebug || null;
      if (localState) {
        const localProgress = local?.videoProgress?.[videoId] || {};
        const localJob = {
          voices: local?.videoVoices?.[videoId] || [],
          percent: localProgress.total
            ? localProgress.done * 100 / localProgress.total : 0,
        };
        localPercent = localJob.percent;
        if (localState === 'done' && local?.cacheVerified?.[videoId] === true) {
          missCount = 0;
          setDubButtonBackgroundState(
            backgroundVoiceMatchesCurrent(localJob) ? 'ready' : 'voice-mismatch',
            videoId, 100);
            return 'done';
        }
        if (localState === 'failed') {
          missCount = 0;
          setDubButtonBackgroundState('idle', videoId);
          return 'failed';
        }
        if (localState === 'cancelled') {
          missCount = 0;
          setDubButtonBackgroundState('idle', videoId);
          return 'cancelled';
        }
      }
      const response = await chrome.runtime.sendMessage({
        action: 'getSharedDubStatus', videoIds: [videoId],
      });
      const job = response?.jobs?.[videoId];
      if (job?.status === 'done') {
        missCount = 0;
        if (job.verified !== true) {
          setDubButtonBackgroundState('idle', videoId);
          return 'unverified';
        }
        setDubButtonBackgroundState(
          backgroundVoiceMatchesCurrent(job) ? 'ready' : 'voice-mismatch',
          videoId, 100);
        clearInterval(_backgroundDubPollTimer);
        _backgroundDubPollTimer = null;
        return 'done';
      } else if (job?.status === 'pending' || job?.status === 'processing') {
        missCount = 0;
        setDubButtonBackgroundState('background', videoId, job.percent || 0);
        return job.status;
      } else if (job?.status === 'failed') {
        missCount = 0;
        setDubButtonBackgroundState('idle', videoId);
        if (!failureShown) {
          failureShown = true;
          showBufferIndicator(
            `❌ 后台配音已暂停：${job.error || '无法自动恢复的错误'}`,
            document.querySelector('video'));
        }
        clearInterval(_backgroundDubPollTimer);
        _backgroundDubPollTimer = null;
        return 'failed';
      } else if (job?.status === 'cancelled') {
        missCount = 0;
        setDubButtonBackgroundState('idle', videoId);
        return 'cancelled';
      }
      if (localState === 'pending' || localState === 'processing') {
        missCount = 0;
        if (loopDebug && loopDebug.active === false && Date.now() - (loopDebug.ts || 0) > 8000) {
          showBufferIndicator('⚠ 后台队列待恢复，正在自动重连…', document.querySelector('video'));
        }
        setDubButtonBackgroundState('background', videoId, localPercent);
        return localState;
      }
      missCount++;
      if (missCount <= 24) return 'unknown';
      setDubButtonBackgroundState('idle', videoId);
      return job?.status || '';
    } catch (_) { return ''; }
  };
  refresh().then((status) => {
    if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'unverified') return;
    _backgroundDubPollTimer = setInterval(async () => {
      if (_backgroundDubPollVideoId !== videoId) return;
      const nextStatus = await refresh();
      if (nextStatus === 'done' || nextStatus === 'failed'
        || nextStatus === 'cancelled' || nextStatus === 'unverified' || missCount > 24) {
        clearInterval(_backgroundDubPollTimer);
        _backgroundDubPollTimer = null;
      }
    }, 5000);
  });
}

function restoreBackgroundDubIndicatorForCurrentVideo() {
  const videoId = currentBackgroundVideoId();
  if (!videoId) return;
  startBackgroundDubStatusPolling(videoId);
}
function hideBufferIndicator() {
  if (bufferIndicatorEl && bufferIndicatorEl.parentNode)
    bufferIndicatorEl.parentNode.removeChild(bufferIndicatorEl);
  bufferIndicatorEl = null;
  _bufferIndicatorVideo = null;
  window.removeEventListener('resize', _onBufferIndicatorReposition);
  window.removeEventListener('scroll', _onBufferIndicatorReposition);
  document.removeEventListener('fullscreenchange', _onBufferIndicatorReposition);
}

// 把一个悬浮提示元素定位到视频画面【外】——用户明确要求所有提示都不许叠在视频画面上
// （录屏场景会把提示一起烧进成片）。固定放在视频正下方、靠右；全屏时
// 没有"画面外"可用，直接隐藏不显示（跟 _positionBufferIndicator 同款取舍：宁可这次
// 看不到提示，也不能污染录制的画面）。调用方只管创建元素+设置样式，定位交给这里。
function placeElOutsideVideo(el) {
  const video = document.querySelector('video');
  if (!video) {
    el.style.position = 'fixed';
    el.style.left = '50%';
    el.style.transform = 'translateX(-50%)';
    el.style.bottom = '16px';
    return;
  }
  if (_isVideoFullscreen(video)) { el.style.display = 'none'; return; }
  const r = video.getBoundingClientRect();
  el.style.display = '';
  el.style.position = 'absolute';
  el.style.right = '';
  el.style.bottom = '';
  el.style.transform = 'translateX(-50%)';
  el.style.top = (window.scrollY + r.bottom + 8) + 'px';
  el.style.left = (window.scrollX + r.left + r.width / 2) + 'px';
  el.style.maxWidth = Math.min(420, Math.max(240, r.width)) + 'px';
}

// 插件被重新加载/更新后，旧页面里的 content script 实例连不上新的 service worker，
// 后续所有 chrome.runtime.sendMessage 都会报 "Extension context invalidated"。
// 这种情况唯一的解法是刷新页面（重新注入最新的 content script），这里弹一次明显提示、
// 停掉当前会话，避免每段音频都失败、用户却一头雾水。
let _contextInvalidatedNotified = false;
function notifyExtensionContextInvalidated(sess) {
  if (_contextInvalidatedNotified) return;
  _contextInvalidatedNotified = true;
  if (sess?.started) { try { stopDubbing(sess, null); } catch (_) {} }
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:2147483647;' +
    'background:rgba(180,0,0,0.92);color:#fff;padding:12px 20px;border-radius:8px;' +
    "font-family:'Microsoft YaHei',sans-serif;font-size:14px;text-align:center;" +
    'box-shadow:0 2px 12px rgba(0,0,0,0.4);';
  box.textContent = '⚠️ 插件已更新/重新加载，本页面需要刷新才能继续配音/朗读，请刷新页面后重试';
  placeElOutsideVideo(box);   // 提示一律放视频画面外，不叠在画面上
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 10000);
}

// 判断这个页面里保存的 chrome.runtime 引用是否还有效。YouTube 是单页应用(SPA)，
// 切视频只走 History API 更新 URL/内容，不会整页刷新——如果用户在同一个标签页开着
// 的时候插件被重新加载/更新过，这个页面里 content script 最初注入时拿到的
// chrome.runtime 对象就会失效，之后任何 chrome.runtime.xxx() 调用都可能抛出
// "Cannot read properties of undefined"（不是"invalidated"这个专门的错误消息，
// 是 chrome.runtime 整个变成 undefined），必须在调用前主动检测，不能只在 catch
// 里等着被动接错误——像 injectPlayerResponseScript 这种每次切视频都会重新调用、
// 之前完全没做防护的地方，一旦命中就是未捕获异常，整个字幕拦截机制从此失效。
function isExtensionContextValid() {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id;
  } catch (_) {
    return false;
  }
}

// ===== 字幕解析 =====
// 非台词的音效/状态标注（YouTube字幕常见）。现在只删除带 []/()/【】/（） 的
// 明确标记；裸词“音乐/掌声”等可能是正文名词，不能再直接删除，避免只剩动词。
const NON_SPEECH_MARKERS = new Set([
  'music', 'applause', 'laughter', 'laughing', 'silence', 'inaudible',
  'background music', 'upbeat music', 'cheering', 'clapping', 'singing',
  '音乐', '掌声', '笑声', '鼓掌', '欢呼', '静音', '無音', '無声', '歓声', '拍手',
  '음악', '박수', '웃음', '환호',
  '♪', '♫', '♬',
]);

function stripNonSpeechMarker(text) {
  if (!text) return text;
  const raw = String(text);
  const markerOnly = raw.match(/^\s*[\[(（【]\s*([^\])）】]*)\s*[\])）】]\s*$/);
  if (markerOnly) {
    const bare = markerOnly[1]
      .replace(/^[，。！？、,.!?~～\-—…·*\s]+|[，。！？、,.!?~～\-—…·*\s]+$/g, '')
      .toLowerCase();
    if (!bare || NON_SPEECH_MARKERS.has(bare)) return '';
  }
  return raw.replace(/[\[(（【][^\])）】]*[\])）】]/g, '').replace(/\s+/g, ' ').trim();
}

function collapseRepeatedYes(text) {
  let t = String(text || '');
  // YouTube/Gemini 偶尔会把连续口头确认翻成“是的，是的，是的”。
  // 只压缩这一种明确重复，避免把“对/好/嗯”等真实短句误删。
  t = t.replace(/(?:^|([，。！？、,.!?；;\s]+))是的(?:[，。！？、,.!?；;\s]*是的){1,}(?=([，。！？、,.!?；;\s]|$))/g,
    (_m, prefix = '') => `${prefix}是的`);
  t = t.replace(/(?:^|([，。！？、,.!?；;\s]+))(?:是的){2,}(?=([，。！？、,.!?；;\s]|$))/g,
    (_m, prefix = '') => `${prefix}是的`);
  return t;
}

function countStandaloneYes(text) {
  return (String(text || '').match(/(?:^|[，。！？、,.!?；;\s]+)是的(?=([，。！？、,.!?；;\s]|$))/g) || []).length;
}

function stripStandaloneYesFiller(text) {
  let t = String(text || '');
  t = t.replace(/(?:^|([，。！？、,.!?；;\s]+))是的(?=([，。！？、,.!?；;\s]|$))([，。！？、,.!?；;\s]*)/g,
    (_m, prefix = '') => prefix || '');
  return t
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、,.!?；;])/g, '$1')
    .replace(/([，。！？、,.!?；;])\1+/g, '$1')
    .replace(/^[，。！？、,.!?；;\s]+|[，。！？、,.!?；;\s]+$/g, '')
    .trim();
}

function estimateCjkChars(text) {
  return [...String(text || '')].filter((ch) => ch >= '一' && ch <= '鿿').length;
}

function pruneExcessYesFillers(segments, label = '字幕') {
  if (!Array.isArray(segments) || !segments.length) return segments || [];
  const yesCount = segments.reduce((sum, s) => sum + countStandaloneYes(s.text), 0);
  const yesSegCount = segments.filter((s) => countStandaloneYes(s.text) > 0).length;
  // 日语自动翻译常把语气/应答词翻成大量“是的”。出现密度明显偏高时，
  // 把“是的”当填充词删除；否则只在时间窗很紧的单句里删除。
  const contextHeavy = yesCount >= 5 && yesSegCount / Math.max(segments.length, 1) >= 0.08;
  let changed = 0;
  const out = [];
  for (const seg of segments) {
    let text = collapseRepeatedYes(seg.text);
    const hasYes = countStandaloneYes(text) > 0;
    if (hasYes) {
      const dur = Math.max(0.2, Number(seg.end || seg.start || 0) - Number(seg.start || 0));
      const tightWindow = estimateCjkChars(text) / dur > 4.8
        || (dur < 1.6 && estimateCjkChars(text) >= 5);
      if (contextHeavy || tightWindow) {
        const stripped = stripStandaloneYesFiller(text);
        if (stripped !== text) {
          text = stripped;
          changed++;
        }
      }
    }
    if (text) out.push({ ...seg, text });
  }
  if (changed) {
    console.log(`[配音插件] ${label}清理“是的”填充词 ${changed} 处`
      + (contextHeavy ? '（上下文高频）' : '（时间窗紧张）'));
  }
  return out;
}

// 送入配音前的最后清洗。只删除括号/方括号/书名号式音效标记；
// 裸词“音乐/掌声”等一律保留，避免把正常正文删成只剩动词。
function sanitizeDubbingText(text) {
  let t = String(text || '');
  t = t.replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ');
  t = t.replace(/(?:鸡巴|鸡吧|屌|吊|阴茎|老二|生殖器)/gi, '下体');
  t = collapseRepeatedYes(t);
  return t
    .replace(/\s+/g, ' ')
    .replace(/\s+([，。！？、,.!?])/g, '$1')
    .replace(/([，。！？、,.!?])\1+/g, '$1')
    .trim();
}

function normalizeCaptionCompareText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[“”"‘’'`´]/g, '')
    .replace(/[，,、；;：:。！？!?…~～\-—_]/g, '')
    .toLowerCase()
    .trim();
}

function isNormalizedPrefix(a, b, minLen = 6) {
  const aa = normalizeCaptionCompareText(a);
  const bb = normalizeCaptionCompareText(b);
  if (!aa || !bb) return false;
  if (aa.length < minLen || bb.length < minLen) return false;
  return bb.startsWith(aa) && bb.length > aa.length;
}

function dedupPreparedSentenceSegments(segments) {
  if (!Array.isArray(segments) || segments.length < 2) return segments || [];
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(seg);
      continue;
    }
    const gap = (seg.start || 0) - (prev.end || prev.start || 0);
    const sameNorm = normalizeCaptionCompareText(seg.text) === normalizeCaptionCompareText(prev.text);
    const segExpandsPrev = isNormalizedPrefix(prev.text, seg.text, 4);
    const prevExpandsSeg = isNormalizedPrefix(seg.text, prev.text, 4);
    const close = gap < 1.2;
    // 只合并时间紧邻且文本相同/渐进扩展的滚动 cue；不同内容的第一、二句不会命中。
    if (close && (sameNorm || segExpandsPrev || prevExpandsSeg)) {
      if (segExpandsPrev) {
        out[out.length - 1] = { ...seg, start: prev.start, end: Math.max(prev.end || 0, seg.end || 0) };
      } else {
        prev.end = Math.max(prev.end || 0, seg.end || 0);
      }
      continue;
    }
    out.push(seg);
  }
  return out;
}

function parseTimedText(body) {
  if (!body || !body.trim()) return [];
  const t = body.trim();
  const segs = [];
  if (t[0] === '{') {
    try {
      const data = JSON.parse(t);
      const rowLimits = new Map();
      const windowState = new Map();
      const normalizeLines = (raw) => String(raw || '')
        .split(/\n+/)
        .map((x) => stripNonSpeechMarker(x.trim()))
        .filter(Boolean);
      const getState = (winId) => {
        if (!windowState.has(winId)) {
          windowState.set(winId, { visibleLines: [], pendingLineBreak: false });
        }
        return windowState.get(winId);
      };
      const overlapLines = (prevLines, curLines) => {
        if (!prevLines.length || !curLines.length) return 0;
        const max = Math.min(prevLines.length, curLines.length);
        for (let k = max; k > 0; k--) {
          let ok = true;
          for (let i = 0; i < k; i++) {
            const prevLine = prevLines[prevLines.length - k + i];
            const curLine = curLines[i];
            if (prevLine === curLine) continue;
            const last = i === k - 1;
            if (last && curLine.startsWith(prevLine) && curLine.length > prevLine.length) continue;
            ok = false;
            break;
          }
          if (ok) return k;
        }
        return 0;
      };
      const emitSeg = (start, end, lines) => {
        const filtered = (lines || []).map((x) => String(x || '').trim()).filter(Boolean);
        if (!filtered.length) return;
        const text = filtered.join(' ').trim();
        if (!text) return;
        segs.push({ start, end, text, lines: filtered });
      };
      for (const ev of data.events || []) {
        if (ev?.wpWinPosId != null) {
          const winPos = data.wpWinPositions?.[ev.wpWinPosId];
          if (winPos?.rcRows) rowLimits.set(ev.wWinId ?? ev.id ?? 0, Math.max(1, Number(winPos.rcRows) || 2));
        }
      }
      for (const ev of data.events || []) {
        if (!ev.segs || ev.dDurationMs == null) continue;
        const winId = ev.wWinId ?? 0;
        const state = getState(winId);
        const rowLimit = rowLimits.get(winId) || 2;
        const rawText = ev.segs.map((s) => s.utf8 || '').join('');
        const newlineOnly = rawText.replace(/\s/g, '') === '';
        if (newlineOnly && rawText.includes('\n')) {
          state.pendingLineBreak = true;
          continue;
        }
        const start = ev.tStartMs / 1000;
        const end = (ev.tStartMs + ev.dDurationMs) / 1000;
        const lines = normalizeLines(rawText);
        if (!lines.length) continue;
        if (state.pendingLineBreak && lines.length === 1) {
          state.pendingLineBreak = false;
          state.visibleLines = [...state.visibleLines, lines[0]].slice(-rowLimit);
          emitSeg(start, end, [lines[0]]);
          continue;
        }
        state.pendingLineBreak = false;
        const prevLines = state.visibleLines;
        const overlap = overlapLines(prevLines, lines);
        if (overlap > 0) {
          const delta = lines.slice(overlap);
          if (delta.length) emitSeg(start, end, delta);
          else if (lines.length && prevLines.length) {
            const prevLast = prevLines[prevLines.length - 1];
            const curLast = lines[Math.min(overlap - 1, lines.length - 1)];
            if (curLast && prevLast && curLast.startsWith(prevLast) && curLast.length > prevLast.length) {
              emitSeg(start, end, [curLast.slice(prevLast.length).trim()]);
            }
          }
        } else {
          emitSeg(start, end, lines);
        }
        state.visibleLines = lines.slice(-rowLimit);
      }
      return segs;
    } catch (e) { return []; }
  }
  try {
    const doc = new DOMParser().parseFromString(t, 'text/xml');
    for (const node of doc.querySelectorAll('text')) {
      const start = parseFloat(node.getAttribute('start'));
      const dur = parseFloat(node.getAttribute('dur') || '0');
      const rawText = (node.textContent || '').replace(/&#39;/g,"'").replace(/&quot;/g,'"')
        .replace(/&amp;/g,'&').trim();
      const lines = rawText.split(/\n+/).map((x) => stripNonSpeechMarker(x.trim())).filter(Boolean);
      const text = stripNonSpeechMarker(rawText.replace(/\n/g, ' ').trim());
      if (text && !isNaN(start)) segs.push({ start, end: start + dur, text, lines });
    }
  } catch (e) {}
  return segs;
}

function cueLines(seg) {
  const lines = Array.isArray(seg?.lines) && seg.lines.length
    ? seg.lines
    : String(seg?.text || '').split(/\n+/);
  return lines.map((x) => String(x || '').trim()).filter(Boolean);
}

function isCueLineExpansion(prev, seg) {
  const prevLines = cueLines(prev);
  const segLines = cueLines(seg);
  if (!prevLines.length || !segLines.length) return false;
  if (segLines.length < prevLines.length) return false;
  let i = 0;
  while (i < prevLines.length && i < segLines.length) {
    const a = prevLines[i];
    const b = segLines[i];
    if (a === b || normalizeCaptionCompareText(a) === normalizeCaptionCompareText(b)) {
      i++;
      continue;
    }
    if (i === prevLines.length - 1
      && (b.startsWith(a) && b.length > a.length || isNormalizedPrefix(a, b, 4))) {
      return true;
    }
    return false;
  }
  return segLines.length > prevLines.length
    || seg.text.startsWith(prev.text)
    || isNormalizedPrefix(prev.text, seg.text, 4);
}

// 相邻字幕 cue 在换行时经常在边界留下 1～几个字重叠（如「随着天」+「天蝎座」→
// 「天天蝎座」、配音念出来就成了"口吃"——一个字念两遍）。返回 a 的尾部与 b 的
// 头部最长公共长度，供下面合并/分句时把重叠部分去掉一份。
function textBoundaryOverlapLen(a, b) {
  if (!a || !b) return 0;
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k--) {
    if (a.slice(-k) === b.slice(0, k)) return k;
  }
  return 0;
}

function mergeOverlappingText(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  const k = textBoundaryOverlapLen(a, b);
  return k > 0 ? a + b.slice(k) : a + b;
}

// 去除"滚动字幕"渐进重复：YouTube 自动字幕（含自动翻译轨）逐字/逐行滚动刷新时，
// 相邻 cue 常是同一句话的"渐进版本"——前一条是后一条的文本前缀（或反过来，
// 后一条是前一条被截断的残留），时间窗紧贴甚至重叠。直接顺序朗读会把同一句读
// 两遍，且重叠的时间窗会让播放端的"当前应播段"判断错乱，导致漏读/跳读。
// 只按"前缀关系 + 时间紧邻"判断合并，不按整体相似度删句——避免误删歌词副歌等
// 真实重复的台词（见项目记忆：不要按相似度删整段）。
function dedupRollingCaptions(segments) {
  if (!segments || segments.length < 2) return segments;
  const out = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev) {
      const closeInTime = (seg.start - prev.end) < 1.5;
      if (closeInTime) {
        if (seg.text === prev.text
          || normalizeCaptionCompareText(seg.text) === normalizeCaptionCompareText(prev.text)) {
          prev.end = Math.max(prev.end, seg.end);
          continue;   // 完全相同的紧邻重复 cue：合并时间窗，不重复保留
        }
        if (isCueLineExpansion(prev, seg)) {
          out[out.length - 1] = { ...seg, start: prev.start };  // 后一条是更完整的渐进版本
          continue;
        }
        if (isCueLineExpansion(seg, prev)
          || prev.text.startsWith(seg.text)
          || isNormalizedPrefix(seg.text, prev.text, 4)) {
          continue;   // 这一条是前一条的截断残留，跳过
        }
        // 换行滚动时常见「前条尾字 = 后条首字」的部分重叠（非整句前缀），合并去重，
        // 避免拼接后变成"天天蝎座"这种重复字，配音念出来就是"口吃"。
        const overlap = textBoundaryOverlapLen(prev.text, seg.text);
        if (overlap > 0) {
          out[out.length - 1] = {
            start: prev.start,
            end: Math.max(prev.end, seg.end),
            text: mergeOverlappingText(prev.text, seg.text),
          };
          continue;
        }
      }
    }
    out.push(seg);
  }
  return out;
}

// 中文分句：把零碎字幕行重新组织成完整句子，让 TTS 连读、且每句时长合理。
//
// 关键：YouTube 滚动字幕【按显示宽度换行，不按句子换行】，所以真正的句末标点
// （。！？）经常落在某一行的【中间】，而行尾多是逗号或无标点（实测 390 行里 260 行
// 行尾无标点、73 行的句末标点在行中间）。旧逻辑只看累积文本【末字】是否句末标点，
// 于是把句末标点埋在中间的行一路合并成 20 秒以上的超长句。
//
// 新逻辑：把所有行展开成"带时间的字符流"（行内按字符线性插值时间），**只要遇到
// 句末标点就断句**（无论它在行中间还是行尾）；行间大间隔（说话人卡壳）也断；
// 再加无标点超长兜底。断点时间按字符位置插值，不丢字、不改内容。
function groupChineseSentences(segments) {
  if (!segments || !segments.length) return segments;
  const END = '。！？…!?';     // 句末标点：一定断
  const SOFT = '，、,；;';      // 次级标点：句子已偏长时在此断，避免逗号长串
  const STUCK_GAP = 2.5;       // 行间 ≥2.5s 视为说话人真实卡壳 → 断句
  const SOFT_DUR = 10;         // 累积超过这个秒数后，遇到逗号等就断
  const MAX_DUR = 10;          // 单句绝对上限（VTT 降级时无标点超长句兜底）
  const MED_DUR = 6;           // 中断词：累积≥6s 才在此断
  // 连词分三级断句（原则：连词引入"新语义块/长分句"才断，短连接如"我和你"不断）：
  //   strong 强断—结构转向词，处于子句边界就断；
  //   medium 中断—累积已偏长(≥MED_DUR)才断；
  //   weak   弱断—并列词，累积很长(≥SOFT_DUR)才断，避免切碎短并列。
  // 单字连词额外要求"紧跟逗号"，避免误切"可以/可能/我和你/但凡"等词中字。
  // 按长到短排序，先匹配长词（但是>但、以及>及）。
  const CONJ = [
    ['与此同时','strong'],
    ['但是','strong'],['然而','strong'],['不过','strong'],['可是','strong'],
    ['所以','strong'],['因此','strong'],['于是','strong'],['因为','strong'],['由于','strong'],
    ['如果','strong'],['只要','strong'],['假如','strong'],['要是','strong'],['除非','strong'],
    ['虽然','strong'],['尽管','strong'],['即使','strong'],['既然','strong'],['否则','strong'],
    ['首先','strong'],['其次','strong'],['再次','strong'],['最后','strong'],
    ['而且','medium'],['并且','medium'],['甚至','medium'],['然后','medium'],['接着','medium'],
    ['随后','medium'],['另外','medium'],['此外','medium'],['例如','medium'],['比如','medium'],['包括','medium'],
    ['以及','weak'],['或者','weak'],['还是','weak'],
    ['但','strong'],['却','strong'],['可','strong'],['而','medium'],
    ['和','weak'],['与','weak'],['及','weak'],['或','weak'],['并','weak'],['且','weak'],
  ].sort((a, b) => b[0].length - a[0].length);
  const COMMA = '，、,；;';
  const matchConjAt = (s, i) => CONJ.find(([w]) => s.startsWith(w, i)) || null;

  const out = [];
  let cur = null;  // { start, end, text }
  const flush = () => {
    if (cur && cur.text.trim()) {
      out.push({ start: cur.start, end: Math.max(cur.end, cur.start + 0.05), text: cur.text.trim() });
    }
    cur = null;
  };

  for (const seg of segments) {
    let text = (seg.text || '').trim();
    if (!text) continue;
    // 与上一句间隔过大（说话人停顿）→ 先断
    if (cur && (seg.start - cur.end) >= STUCK_GAP) flush();
    // 紧邻 cue 在换行边界常留 1 字重叠，拼进当前句前先去掉（避免「天天蝎座」「双双鱼座」）。
    if (cur && cur.text) {
      const k = textBoundaryOverlapLen(cur.text, text);
      if (k > 0) {
        text = text.slice(k);
        if (!text) {
          cur.end = Math.max(cur.end, seg.end);
          continue;
        }
      }
    }

    const n = text.length;
    const dur = Math.max(0, (seg.end || seg.start) - seg.start);
    let pieceStart = 0;     // 当前子句在本行内的起始字符下标
    for (let i = 0; i < n; i++) {
      // 连词断句：在连词前断开，让连词起新句。分级 + 长度阈值 + 边界保护。
      const conj = matchConjAt(text, i);
      if (conj) {
        const [word, tier] = conj;
        const prev = i > 0 ? text[i - 1] : '';
        const afterComma = COMMA.includes(prev);
        const lineStartWithCur = (i === 0 && cur && cur.text.trim());
        // 边界：紧跟逗号，或多字连词出现在行首且已有累积内容
        let boundary = afterComma || (word.length > 1 && lineStartWithCur);
        if (word.length === 1 && !afterComma) boundary = false;   // 单字连词必须紧跟逗号
        if (boundary) {
          // 当前累积子句（含未并入的尾巴）的时长，用于中/弱断的长度判断
          const candStart = cur ? cur.start : seg.start + (n > 1 ? dur * pieceStart / n : 0);
          const candEnd = seg.start + (n > 1 ? dur * i / n : dur);
          const clauseLen = candEnd - candStart;
          const doBreak = tier === 'strong'
            || (tier === 'medium' && clauseLen >= MED_DUR)
            || (tier === 'weak' && clauseLen >= SOFT_DUR);
          if (doBreak) {
            const piece = text.slice(pieceStart, i);   // 连词之前、还没收进 cur 的尾巴
            if (piece) {
              if (!cur) cur = { start: candStart, end: candEnd, text: '' };
              cur.text += piece;
              cur.end = candEnd;
              pieceStart = i;
            }
            if (cur && cur.text.trim()) flush();   // 连词前断句，连词起新句
          }
        }
      }
      const isEnd = END.includes(text[i]);
      const isSoft = SOFT.includes(text[i]);
      const projectedStart = cur
        ? cur.start
        : seg.start + (n > 1 ? dur * pieceStart / n : 0);
      const projectedEnd = seg.start + (n > 1 ? dur * (i + 1) / n : dur);
      const hardBreak = (projectedEnd - projectedStart) >= MAX_DUR;
      if (isEnd || isSoft || hardBreak || i === n - 1) {
        const piece = text.slice(pieceStart, i + 1);
        // 本子句的起止时间：行内按字符位置线性插值
        const ps = seg.start + (n > 1 ? dur * pieceStart / n : 0);
        const pe = seg.start + (n > 1 ? dur * (i + 1) / n : dur);
        if (!cur) cur = { start: ps, end: pe, text: '' };
        cur.text += piece;
        cur.end = pe;
        pieceStart = i + 1;
        if (isEnd || hardBreak) flush();                      // 句末或过长：立即断（含行中间）
        else if (isSoft && (cur.end - cur.start) >= SOFT_DUR) flush();  // 已偏长：在逗号处断
      }
    }
    // hardBreak 在字符循环内已执行；这里保留对空/异常 cue 的兜底。
    if (cur && (cur.end - cur.start) >= MAX_DUR) flush();
  }
  flush();

  // 合并"太短的碎片"（如连词断出来的"所以，"）：按时间窗决定并入哪边。
  //   · 碎片以连词开头且与下句紧邻 → 并入下句（连词引领下文）；
  //   · 否则与上一句几乎无时间差 → 并入上句；
  //   · 否则与下一句几乎无时间差 → 并入下句；
  //   · 与两侧都有较长时间差 → 是独立短句，保留。
  const TINY = 5;        // ≤5 字（且不含句末标点）才算碎片
  const TIGHT = 0.4;     // 间隔 ≤0.4s 视为"几乎无时间差"
  for (let i = 0; i < out.length; i++) {
    const f = out[i];
    const t = f.text.trim();
    if (t.length > TINY || END.includes(t.slice(-1))) continue;   // 完整短句(带句末标点)不动
    const prev = out[i - 1], next = out[i + 1];
    const gapPrev = prev ? (f.start - prev.end) : Infinity;
    const gapNext = next ? (next.start - f.end) : Infinity;
    const startsConj = !!matchConjAt(t, 0);
    if (startsConj && next && gapNext <= TIGHT) {
      next.text = t + next.text; next.start = f.start; out.splice(i, 1); i--;
    } else if (prev && gapPrev <= TIGHT) {
      prev.text += t; prev.end = f.end; out.splice(i, 1); i--;
    } else if (next && gapNext <= TIGHT) {
      next.text = t + next.text; next.start = f.start; out.splice(i, 1); i--;
    }
    // 否则两侧都有较长间隔 → 保留独立
  }

  // 削平"局部密度异常"的句子：用户反馈"特别赶"的往往不是真的长句，而是某一小段
  // 时间窗本来只够念一个字、却塞进了五个字（多半是合并/断句时间戳插值的边界误差），
  // 单独留它在自己的窗口里只能靠提速硬撑，听起来就是"赶"。处理方式不是再去提速，
  // 而是把这段异常密的内容"挪给前一句或后一句"——哪边富余时间多就并去哪边，两句共享
  // 一个更大的时间窗，密度被摊薄，不再需要异常提速。用户明确说了：这样做完时间戳跟
  // 原视频画面对不太上也没关系，下一个分句点会自然把节奏校回来，不强求逐句严格对齐。
  // 判断标准：密度（字数/秒）超过全视频中位数密度的 2.5 倍才算异常，避免误并真正的长句
  // （真长句密度其实接近平均水平，只是绝对时长长，不该被这里处理）。
  if (out.length >= 2) {
    const densities = out
      .map((s) => s.text.length / Math.max(0.3, s.end - s.start))
      .filter((d) => isFinite(d) && d > 0)
      .sort((a, b) => a - b);
    const median = densities.length ? densities[Math.floor(densities.length / 2)] : 0;
    if (median > 0) {
      const THRESHOLD = median * 2.5;
      // 富余时间 = 这句自己的时长 - 按中位数密度本该需要的时长（越正越闲）
      const slackOf = (s) => (s.end - s.start) - s.text.length / median;
      let i = 1;
      while (i < out.length) {
        const cur = out[i];
        const dur = Math.max(0.3, cur.end - cur.start);
        const density = cur.text.length / dur;
        if (density > THRESHOLD) {
          const prev = out[i - 1];
          const next = i + 1 < out.length ? out[i + 1] : null;
          const slackPrev = slackOf(prev);
          const slackNext = next ? slackOf(next) : -Infinity;
          if (next && slackNext > slackPrev) {
            // 后一句更闲 → 并入后一句（往后挪）
            next.text = cur.text + next.text;
            next.start = cur.start;
            out.splice(i, 1);
          } else {
            // 前一句更闲（或没有后一句）→ 并入前一句（往前提）
            prev.text += cur.text;
            prev.end = cur.end;
            out.splice(i, 1);   // 并入后数组在原位置自动接上下一个，不用 i++
          }
        } else {
          i++;
        }
      }
    }
  }

  return out.length ? out : segments;
}

function prepareSegmentsForBackgroundDub(segments) {
  let prepared = (segments || [])
    .map((s) => ({
      ...s,
      text: sanitizeDubbingText(stripNonSpeechMarker(String(s.text || ''))),
    }))
    .filter((s) => s.text);
  prepared = dedupRollingCaptions(prepared);
  prepared = prepared
    .map((s) => ({
      ...s,
      text: s.text.replace(/[\[【(（][^\]】)）]{0,12}[\]】)）]/g, '').trim(),
    }))
    .filter((s) => s.text);
  const fillerRe = /[嗯呃唔诶呣]+[，、。．.…!！?？~～\s]*/g;
  prepared = prepared
    .map((s) => ({ ...s, text: s.text.replace(fillerRe, '').trim() }))
    .filter((s) => s.text);
  prepared = groupChineseSentences(prepared);
  prepared = dedupPreparedSentenceSegments(prepared);
  return prepared;
}

// 解析 WebVTT 文本（<track> 用）
function parseVTT(vtt) {
  const segs = [];
  const blocks = vtt.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [s, e] = timeLine.split('-->').map((p) => {
      const parts = p.trim().split(':');
      let sec = 0;
      for (const part of parts) sec = sec * 60 + parseFloat(part);
      return sec;
    });
    const text = stripNonSpeechMarker(lines.slice(lines.indexOf(timeLine) + 1).join(' ')
      .replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim());
    if (text && !isNaN(s)) segs.push({ start: s, end: e || s + 2, text });
  }
  return segs;
}

// ===== 字幕显示（position:fixed，贴视频底部，不超出视频框）=====
function getSubtitleLine(text, elapsed, duration) {
  if (!text) return '';
  const clauses = text.match(/[^，。！？；、…\n]+[，。！？；、…]?/g) || [text];
  if (clauses.length <= 1) return text;
  const idx = Math.min(Math.floor((elapsed / Math.max(duration, 0.1)) * clauses.length), clauses.length - 1);
  return clauses[idx].trim();
}

function ensureSubtitleEl(sess) {
  if (sess.subtitleEl && document.contains(sess.subtitleEl)) return sess.subtitleEl;
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;text-align:center;' +
    'box-sizing:border-box;display:none;overflow:hidden;';
  document.body.appendChild(el);
  sess.subtitleEl = el;
  return el;
}

// 字幕和"提示"性质不同：字幕是视频内容的一部分，录屏要把它录进去，所以字幕维持
// 叠在视频画面上——贴视频底部、居中、从下往上长（多行时新行垫在上面，不会往下越界）。
// 提示（缓冲中之类的纯状态信息）不是内容，录屏不需要，单独放视频外侧（见 showBufferIndicator）。
function _subtitleMetrics(sess) {
  const r = sess.video.getBoundingClientRect();
  const fontSize = Math.max(10, Math.min(36, r.width * 0.038 * subFontScale));
  return { r, fontSize, boxWidth: r.width };
}

function positionSubtitleEl(sess) {
  if (!sess.subtitleEl) return;
  const { r, fontSize, boxWidth } = _subtitleMetrics(sess);
  if (r.width < 10 || r.height < 10) { sess.subtitleEl.style.display = 'none'; return; }
  sess.subtitleEl.style.left = r.left + 'px';
  sess.subtitleEl.style.right = '';
  sess.subtitleEl.style.top = '';
  sess.subtitleEl.style.bottom = Math.max(0, window.innerHeight - r.bottom + r.height * 0.06) + 'px';
  // 配音逐字高亮模式（curAudio在播）只显示一行，高度封顶约1.4行防止极端情况撑出
  // 多行；但没有curAudio在播时走的是整句兜底显示（updateSubtitle 里 white-space:
  // normal 那条分支），文本本来就可能正常换行到2行甚至更多——之前这两种情况共用
  // 同一个1.4行的高度上限，导致兜底显示换行后，第二行下半部分被 overflow:hidden
  // 截掉了一部分。现在按当前是不是在单行高亮模式分别给不同的高度上限。
  const maxLines = sess.curAudio ? 1.4 : 3;
  sess.subtitleEl.style.maxHeight = Math.round(fontSize * 1.6 * maxLines) + 'px';
  sess.subtitleEl.style.width = boxWidth + 'px';
  sess.subtitleEl.style.fontSize = fontSize + 'px';
  sess.subtitleEl.style.padding = '0 ' + Math.round(boxWidth * 0.04) + 'px';
}

const CJK_RE = /[一-鿿぀-ヿ가-힣]/;

// 把整段文本按"一行能放多少"切成若干段（用 em 估算视觉宽度：CJK 按 1 个字宽算，
// 其它语言按每个词的字符数*0.55 估算），返回 [[startIdx,endIdx], ...]（半开区间，按 units 下标）。
// 用来在逐字高亮时只显示当前读到的那一行，避免长句子一次性铺成两三行挤占视频画面。
function _splitUnitsIntoLines(units, isCJK, capacityEm) {
  const lines = [];
  let start = 0, width = 0;
  for (let i = 0; i < units.length; i++) {
    const w = isCJK ? 1 : Math.max(0.3, units[i].length * 0.55);
    if (width + w > capacityEm && i > start) {
      lines.push([start, i]);
      start = i;
      width = 0;
    }
    width += w;
  }
  lines.push([start, units.length]);
  return lines;
}

// 按"已读/未读"逐词（CJK 按字、其它语言按空格分词）高亮当前播放进度——念过的变绿，
// 没念到的保持暗淡，用来核对是不是把每个字/词都念到了。朗读、配音两个模式共用这一个
// 渲染函数，区别只在调用方传入的文本字段（原文 vs 译文）。只显示当前读到的那一行，
// 不会因为整句太长而堆成两三行挡住画面（用户明确要求"一次只显示一行"）。
// 用 curAudio.currentTime / duration 算进度比例（用音频自身进度，比 video 时间稳）。
function renderHighlightSubtitle(sess, text) {
  const hide = () => { if (sess.subtitleEl) sess.subtitleEl.style.display = 'none'; };
  if (sess._userPaused) return hide();
  if (!sess.curAudio) return hide();
  if (!text) return hide();
  const dur = sess.curAudio.duration || sess.curSegment?.tts_duration || sess.curSegment?.duration || 0.1;
  const ratio = Math.max(0, Math.min(1, (sess.curAudio.currentTime || 0) / Math.max(dur, 0.1)));

  const isCJK = CJK_RE.test(text);
  const units = isCJK ? [...text] : text.split(/(\s+)/);
  // 只对非空白 token 计数（CJK 按字全计），决定"已读到第几个词"
  const wordPositions = isCJK ? units.map((_, i) => i) : units.map((u, i) => (u.trim() ? i : -1)).filter((i) => i >= 0);
  const total = wordPositions.length || 1;
  const readCount = Math.min(total, Math.max(0, Math.round(ratio * total)));

  // 按当前视频宽度/字号算一行能放多少字（留padding余量），切行后只取"当前读到的那一行"。
  // 下面渲染时文字外面还套了一层 inner span，有固定 12px*2 的水平内边距（见下方
  // inner.style.cssText），这里必须把它换算成em减掉——宽屏视频框够宽时这点像素占比
  // 很小看不出来，竖屏视频框窄，同样24px占比就大很多，没扣掉就会导致估计"刚好能
  // 放下"的最后一个字其实放不下，被 overflow:hidden 切掉一半。
  const { fontSize, boxWidth } = _subtitleMetrics(sess);
  const INNER_PADDING_PX = 24;   // 跟下面 inner 的 padding:3px 12px 对应（12px*2边）
  const usableEm = Math.max(2, (boxWidth * 0.9 - INNER_PADDING_PX) / fontSize);
  const lines = _splitUnitsIntoLines(units, isCJK, Math.max(4, usableEm));
  const curIdx = Math.min(total - 1, readCount);
  let lineRange = lines[lines.length - 1];
  for (const [s, e] of lines) {
    if (curIdx >= s && curIdx < e) { lineRange = [s, e]; break; }
  }
  const [lineStart, lineEnd] = lineRange;

  // 缓存键带上行区间，确保翻到下一行、或本行内高亮推进时都会重新渲染
  const cacheKey = text + '|' + readCount + '|' + lineStart + '-' + lineEnd;
  if (cacheKey === sess.lastSubText) return;
  sess.lastSubText = cacheKey;

  const readSet = new Set(wordPositions.slice(0, readCount));
  const el = ensureSubtitleEl(sess);
  const span = document.createElement('span');
  span.style.cssText =
    "display:block;width:100%;line-height:1.6;font-family:'Microsoft YaHei',sans-serif;" +
    'white-space:nowrap;overflow:hidden;text-overflow:clip;';
  const inner = document.createElement('span');
  inner.style.cssText =
    `display:inline;background:rgba(8,8,8,${subBgOpacity});padding:3px 12px;border-radius:4px;` +
    'box-decoration-break:clone;-webkit-box-decoration-break:clone;';
  for (let i = lineStart; i < lineEnd; i++) {
    const u = units[i];
    const unitSpan = document.createElement('span');
    unitSpan.textContent = u;
    const read = isCJK ? readSet.has(i) : (u.trim() ? readSet.has(i) : false);
    unitSpan.style.cssText = read
      ? 'color:#7CFC00;'   // 已读：高亮绿色，不加粗
      : 'color:#fff;opacity:0.6;';          // 未读：偏暗白色
    inner.appendChild(unitSpan);
  }
  span.appendChild(inner);
  el.innerHTML = '';
  el.appendChild(span);
  positionSubtitleEl(sess);
  el.style.display = 'block';
}

// 朗读模式：高亮文本用原文（sess.curSegment.text）。
function renderReadHighlight(sess) {
  if (!sess.curSegment) { if (sess.subtitleEl) sess.subtitleEl.style.display = 'none'; return; }
  renderHighlightSubtitle(sess, sess.curSegment.text || '');
}

// 字幕显示：跟随视频时间轴，实现"严格对齐"：原字幕窗 ← 配音 → 配音字幕。
// 视频恒定 1.0x，原始时间窗不变；每句配音被压缩进自己的窗口（见 playNextDue），
// 字幕窗与配音、画面逐句严格对齐——画面里"蹦出来"的内容仍在原时刻出现。
function updateSubtitle(sess) {
  // 朗读模式：用逐词高亮进度条核对朗读完整性（见 renderReadHighlight），
  // 与下面配音模式的整句字幕逻辑分开，原生 CC 继续显示选中字幕不受影响。
  if (sess._readMode) { renderReadHighlight(sess); return; }
  if (!showSubs || sess._userPaused) { if (sess.subtitleEl) sess.subtitleEl.style.display = 'none'; return; }

  // 配音正在播放 → 跟朗读模式一样逐字高亮（用译文），念过的变绿，方便核对有没有漏字/抢拍。
  // 不再像之前那样把整句切成一句一句轮流显示——高亮本身就能体现进度，没必要再分句隐藏全文。
  if (sess.curSegment && sess.curAudio) {
    const text = sess.curSegment.translation || sess.curSegment.text || '';
    renderHighlightSubtitle(sess, text);
    return;
  }

  let cur = '';
  // 还没有配音音频在播（合成中/段间空隙）时没法按音频进度高亮，退回旧的整句/原始字幕展示。
  if (sess.curSegment) {
    cur = sess.curSegment.translation || sess.curSegment.text || '';
  } else if (sess._displaySegments) {
    const t = sess.video.currentTime;
    const seg = sess._displaySegments.find((s) => t >= s.start && t < s.end);
    // 这个兜底分支是纯按视频时间戳找字幕，跟 playNextDue 里"最近重复段跳过不发声"
    // 是两套独立判断——之前没同步：配音那边判定重复跳过了（没声音），但这个兜底
    // 不知道，等视频时间走到那条重复段自己的时间窗，照样把它的文字显示出来，
    // 表现就是"刚配完音的那句又显示了一遍，但没声音"。这里也查一下最近播过的记录，
    // 命中就当没有这一条，跟音频那边的判断保持一致。
    const suppressed = seg && isRealtimeSubtitleSuppressed(sess, seg);
    const isDup = seg && sess._recentSpoken && sess._recentSpoken.some(
      (r) => r.text === seg.text && (seg.start - r.end) < 12
    );
    if (seg && !isDup && !suppressed) {
      // _displaySegments 存的是原始（外语）字幕，不是译文——之前这里直接显示
      // seg.text，配音真正播放时显示的是中文译文（绿色高亮），两者一对比就像
      // "突然冒出一句不相关的黑色字幕"。这里按时间戳去 dubSegments 里找同一句，
      // 有译文就显示译文，跟"刚配完音"那句保持同一种语言，不会显得像两句话。
      const dub = sess.dubSegments && sess.dubSegments.find((d) => _segKey(d) === _segKey(seg));
      const text = (dub && (dub.translation || dub.text)) || seg.text;
      cur = getSubtitleLine(text, t - seg.start, seg.end - seg.start);
    } else {
      cur = '';
    }
  }
  if (cur === sess.lastSubText) return;
  sess.lastSubText = cur;
  const el = ensureSubtitleEl(sess);
  if (cur) {
    const span = document.createElement('span');
    span.style.cssText =
      'display:block;width:100%;color:#fff;line-height:1.5;' +
      "font-family:'Microsoft YaHei',sans-serif;white-space:normal;word-break:break-all;";
    // 背景只包裹文字本身（内层 span），换行时每行都有背景
    const inner = document.createElement('span');
    inner.textContent = cur;
    inner.style.cssText =
      `display:inline;background:rgba(8,8,8,${subBgOpacity});padding:3px 12px;border-radius:4px;` +
      'box-decoration-break:clone;-webkit-box-decoration-break:clone;';
    span.appendChild(inner);
    el.innerHTML = '';
    el.appendChild(span);
    positionSubtitleEl(sess);
    el.style.display = 'block';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function removeSubtitleEl(sess) {
  if (sess.subtitleEl && sess.subtitleEl.parentNode)
    sess.subtitleEl.parentNode.removeChild(sess.subtitleEl);
  sess.subtitleEl = null;
  sess.lastSubText = null;
  sess.curSegment = null;
}

// ===== 配音调度 =====
// 通过 background service worker 取音频（绕过 Private Network Access），返回 Promise<HTMLAudioElement>
// 单次向后台请求音频；SW 睡眠时会报 "Receiving end does not exist"，由上层重试唤醒。
function _requestAudioB64Once(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: 'fetchAudioB64', url }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp?.ok) return reject(new Error(resp?.error || '音频获取失败'));
        resolve(resp.b64);
      });
    } catch (e) { reject(e); }
  });
}

// 通过 background service worker 取音频（绕过 Private Network Access），返回 Promise<HTMLAudioElement>。
// MV3 的 SW 会被闲置回收，首次发消息可能报 "Receiving end does not exist"——发消息本身会
// 唤醒 SW，故对这类错误退避重试几次即可恢复，避免那一段配音没声音。
async function fetchAudioViaBackground(url) {
  const delays = [0, 150, 400, 800];
  let lastErr = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const b64 = await _requestAudioB64Once(url);
      const bytes = atob(b64);
      const arr = new Uint8Array(bytes.length);
      for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
      const blob = new Blob([arr], { type: 'audio/mpeg' });
      return new Audio(URL.createObjectURL(blob));
    } catch (e) {
      lastErr = e;
      const msg = e?.message || '';
      // 仅对 SW 未唤醒类错误重试；其它错误（如真正的网络失败）直接抛出
      if (!/Receiving end does not exist|Could not establish connection|message port closed/i.test(msg)) {
        throw e;
      }
    }
  }
  throw lastErr || new Error('音频获取失败');
}

function getDubAudioUrlCandidates(seg) {
  const raw = seg?.audio_url || '';
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw) || raw.startsWith('blob:')) return [raw];
  const servers = [];
  pushUniqueServer(servers, seg._dubServer || seg.server_url || '');
  for (const server of getDubServerCandidates()) pushUniqueServer(servers, server);
  return servers.map((server) => `${server}${raw.startsWith('/') ? raw : `/${raw}`}`);
}

function audioFromBase64(audioB64) {
  const bin = atob(audioB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const audio = new Audio(URL.createObjectURL(blob));
  // 新建的 Audio 在部分 Chrome 版本不会立刻开始读取 blob，直到第一次 play()
  // 才触发解码。这会让“开头三句已就绪”的验证永久等不到 canplay。显式预加载，
  // 但不播放，既不打断视频也不会产生声音。
  audio.preload = 'auto';
  try { audio.load(); } catch (_) {}
  return audio;
}

async function readLocalDubAudio(videoId, seg) {
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const row = await new Promise((resolve) => {
      const req = store.get(localDubKey(videoId, seg));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    db.close();
    return row?.audio_b64 || null;
  } catch (_) {
    return null;
  }
}

async function readLocalDubAudioLoose(videoId, seg) {
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const targetVoice = seg?._strictCacheVoice ? String(seg?.voice || '') : '';
    const row = await new Promise((resolve) => {
      let found = null;
      const lower = `${videoId}|`;
      const upper = `${videoId}|\uffff`;
      const req = store.openCursor(IDBKeyRange.bound(lower, upper));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(found);
        const key = String(cursor.primaryKey || '');
        const value = cursor.value || {};
        const voice = localDubRowVoice(value, key);
        if (targetVoice && voice && voice !== targetVoice) {
          cursor.continue();
          return;
        }
        if (localDubRowMatchesSegment(value, key, seg)) {
          found = value;
          return resolve(found);
        }
        cursor.continue();
      };
      req.onerror = () => resolve(found);
    });
    db.close();
    return row?.audio_b64 || null;
  } catch (_) {
    return null;
  }
}

async function getAudio(sess, seg) {
  if (!seg.audio_url) return null;
  if (sess.audioCache[seg.audio_url]) return sess.audioCache[seg.audio_url];
  sess._audioFetches = sess._audioFetches || {};
  if (sess._audioFetches[seg.audio_url]) return sess._audioFetches[seg.audio_url];
  const pending = loadAudioOnce(sess, seg);
  sess._audioFetches[seg.audio_url] = pending;
  try {
    return await pending;
  } finally {
    if (sess._audioFetches[seg.audio_url] === pending) {
      delete sess._audioFetches[seg.audio_url];
    }
  }
}

// 启动阶段保持轻量：前三句已合成并能在浏览器本机播放，就允许从零点开播。
// 不再把十几分钟库存或大段护栏塞到开头，否则会出现“字幕出来了、配音迟迟不启动”。
const STARTUP_PLAYABLE_SEGMENTS = 3;
function startupRequiredSegmentCount(sess, t) {
  const available = (sess?._allSegments || [])
    .filter((seg) => seg.end >= (t || 0) - 0.5).length;
  // 很短的视频或字幕极少的视频不能因为凑不满三句永远卡在准备中。
  return Math.max(1, Math.min(STARTUP_PLAYABLE_SEGMENTS, available || STARTUP_PLAYABLE_SEGMENTS));
}
function waitForAudioCanPlay(audio, timeoutMs = 1400) {
  if (!audio) return Promise.resolve(false);
  if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('canplaythrough', onReady);
      audio.removeEventListener('error', onError);
      resolve(ok);
    };
    const onReady = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA), timeoutMs);
    audio.addEventListener('canplay', onReady, { once: true });
    audio.addEventListener('canplaythrough', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
  });
}
async function startupAudioGateReady(sess, t) {
  const requiredCount = startupRequiredSegmentCount(sess, t);
  const candidates = (sess?.dubSegments || [])
    .filter((seg) => {
      const end = segmentTimelineEnd(seg);
      return seg.audio_url && !seg._invalidAudio && !seg._skippedStale && end >= (t || 0) - 0.5;
    })
    .sort(compareDubSegments)
    .slice(0, requiredCount);
  if (candidates.length < requiredCount) return false;
  try {
    const decoded = await Promise.race([
      Promise.all(candidates.map(async (seg) => {
        const audio = await getAudio(sess, seg);
        return {
          seg,
          audio,
          ready: await waitForAudioCanPlay(audio),
        };
      })),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  if (!Array.isArray(decoded)) return false;
    // 失败的缓存 URL 不能继续伪装成“已有配音”。但“旧电脑/大文件 blob 解码超时”
    // 不能当坏缓存，否则明明有缓存也会被反复 invalid 掉、卡在开头。
    for (const item of decoded) {
      if (item?.ready) continue;
      if (item?.seg && (!item.audio || item.audio.error)) {
        item.seg._invalidAudio = true;
        delete sess.audioCache?.[item.seg.audio_url];
      }
    }
    if (decoded.every((item) => item?.ready)) return true;
    // 本地缓存命中的音频已经有完整 base64/blob，不能因为 Chrome 对离屏 Audio
    // canplay 事件迟迟不触发就把开头卡住一分钟。只要 Audio 对象已创建且没有报错，
    // 允许进入播放，由真正的 playNextDue 负责发声。
    const localCacheUsable = decoded.every((item) =>
      item?.seg?._localDubCacheHit && item.audio && !item.audio.error);
    if (localCacheUsable) {
      recordDiagnostic(sess, 'startup_audio_gate_released_for_local_cache', {
        currentTime: +(t || 0).toFixed(3),
        count: decoded.length,
        voice: sess._cachedVoice || '',
      });
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function primeStartupAudio(sess, t) {
  const requiredCount = startupRequiredSegmentCount(sess, t);
  const candidates = (sess?.dubSegments || [])
    .filter((seg) => {
      const end = segmentTimelineEnd(seg);
      return seg.audio_url && end >= (t || 0) - 0.5 && !seg._invalidAudio && !seg._skippedStale;
    })
    .sort(compareDubSegments)
    .slice(0, requiredCount);
  for (const seg of candidates) {
    getAudio(sess, seg).catch(() => {});
  }
}

function kickDubbingAfterSeek(sess, t, attempts = 6) {
  if (!sess?.started) return;
  sess._audioLoading = false;
  sess._audioLoadingSince = null;
  sess._pendingSeg = null;
  const current = Number(t || sess.video?.currentTime || 0);
  for (const seg of sess.dubSegments || []) {
    const end = segmentTimelineEnd(seg);
    // 回到开头或任意 seek 点后，当前窗口附近的句子必须重新变成可播，
    // 否则之前的“已播/跳过”状态会导致只显示字幕、不播放配音。
    if (end >= current - 0.5 && seg.start <= current + 8) {
      seg.played = false;
      delete seg._skippedStale;
      delete seg._invalidAudio;
    }
  }
  let n = 0;
  const tick = () => {
    if (!sess.started || sess.weArePausing || sess._buffering) return;
    if (sess.video?.paused) {
      if (++n < attempts) setTimeout(tick, n < 2 ? 80 : 220);
      return;
    }
    playNextDue(sess, sess.video.currentTime || current);
    if (++n < attempts && !sess.curAudio && !sess._audioLoading && !sess._webSpeechActive) {
      setTimeout(tick, n < 2 ? 80 : 220);
    }
  };
  tick();
}

async function loadAudioOnce(sess, seg) {
  if (!seg.audio_url) return null;
  if (!sess.audioCache[seg.audio_url]) {
    sess.audioCache[seg.audio_url] = null;  // 占位
    try {
      // 服务器现在会把音频内容直接编码进返回结果（audio_b64），优先用它而不是
      // 再发一次请求去 audio_url 取文件——避免"生成时存文件、播放时再单独取"这
      // 两步之间服务器重启/清临时文件（云端免费档尤其容易遇到）导致文件已经不在了，
      // 取的时候404；重试多了又可能撞上429。有 audio_b64 就直接解码成本地blob，
      // 完全不用再碰网络。
      if (seg.audio_b64) {
        sess.audioCache[seg.audio_url] = audioFromBase64(seg.audio_b64);
        // Base64比原始MP3还大约33%。长视频若把几千句Base64一直留在dubSegments，
        // 即使Audio/Blob已释放，内存仍会持续增长直至浏览器静默停播。
        delete seg.audio_b64;
      } else if (seg.audio_url.startsWith('blob:')) {
        // 朗读模式：audio_url 本身就是 sendChunkReadAloudCloud 生成的 blob: URL（同源），
        // 直接拿来当 Audio.src 用，不用再绕 background 中转（那条路径是为了绕过本地服务器
        // 的 Private Network Access 限制，blob: URL 没有这个问题）。
        sess.audioCache[seg.audio_url] = new Audio(seg.audio_url);
      } else {
        let localAudioB64 = await readLocalDubAudio(sess.videoId, seg);
        if (!localAudioB64) localAudioB64 = await readLocalDubAudioLoose(sess.videoId, seg);
        if (localAudioB64) {
          sess.audioCache[seg.audio_url] = audioFromBase64(localAudioB64);
        } else {
          const urls = getDubAudioUrlCandidates(seg);
          let lastFetchErr = null;
          for (const url of urls) {
            try {
              sess.audioCache[seg.audio_url] = await fetchAudioViaBackground(url);
              lastFetchErr = null;
              break;
            } catch (err) {
              lastFetchErr = err;
              console.warn('[配音插件] 音频URL加载失败，尝试备用来源', url, err?.message || err);
            }
          }
          if (lastFetchErr) throw lastFetchErr;
        }
      }
    } catch (e) {
      try {
        const looseB64 = await readLocalDubAudioLoose(sess.videoId, seg);
        if (looseB64) {
          console.warn('[配音插件] 音频URL失效，已从本地缓存回补', seg.audio_url);
          sess.audioCache[seg.audio_url] = audioFromBase64(looseB64);
          return sess.audioCache[seg.audio_url];
        }
      } catch (_) {}
      console.warn('[配音插件] 音频加载失败', seg.audio_url, e);
      // "Extension context invalidated"：插件被重新加载/更新过，但这个页面还在用旧的
      // content script 实例，旧实例连不上新的 service worker，会导致后续每一段音频都
      // 加载失败、却只在 console 里看得到一行英文报错，用户感知就是"忽然没有配音了"。
      // 这里检测到这个特定错误就在屏幕上弹一次清晰提示，并整段停掉，不再逐句重复报错。
      if (/Extension context invalidated/i.test(e?.message || '')) {
        notifyExtensionContextInvalidated(sess);
      }
      delete sess.audioCache[seg.audio_url];
      return null;
    }
  }
  return sess.audioCache[seg.audio_url];
}

// 在 timeupdate 时预取接下来 N 段，避免一口气把所有段都拉进内存
const PREFETCH_AHEAD = 30;
function prefetchAhead(sess, t) {
  if (!sess.dubSegments) return;
  let count = 0;
  for (const seg of sess.dubSegments) {
    if (seg.played || seg.start < t) continue;
    if (count >= PREFETCH_AHEAD) break;
    if (!sess.audioCache[seg.audio_url]) {
      getAudio(sess, seg);   // 触发预取，结果缓存
    }
    count++;
  }
}

// 长视频不能把已经播放数小时的 Audio/Blob 一直留在内存。音频的原始 Base64 已在
// IndexedDB 持久化，用户 seek 回去时会由 hydrateLocalCacheWindow 按需取回；这里只
// 释放播放点五分钟前的内存副本，既避免浏览器后半段内存压力，也不牺牲回看能力。
const PLAYED_AUDIO_MEMORY_KEEP_SECONDS = 5 * 60;
function prunePlayedAudioCache(sess, t) {
  if (!sess?.audioCache || !sess?.dubSegments) return;
  if (Date.now() - (sess._lastAudioCachePruneAt || 0) < 20000) return;
  sess._lastAudioCachePruneAt = Date.now();
  const cutoff = Math.max(0, Number(t || 0) - PLAYED_AUDIO_MEMORY_KEEP_SECONDS);
  let freed = 0;
  for (const seg of sess.dubSegments) {
    const end = segmentTimelineEnd(seg);
    if (end >= cutoff || seg === sess.curSegment || !seg.audio_url) continue;
    const audio = sess.audioCache[seg.audio_url];
    if (!audio) continue;
    try {
      audio.pause?.();
      audio.onended = null;
      if (audio.src?.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    } catch (_) {}
    delete sess.audioCache[seg.audio_url];
    freed++;
  }
  if (freed) recordDiagnostic(sess, 'played_audio_memory_pruned', { freed, cutoff: +cutoff.toFixed(3) });
}

const BUFFER_MISS_THRESHOLD = 8;

// 可懂度优先「宁可慢视频不丢内容」：音频尽量自然语速，放不下时优先放慢视频，
// 而不是把配音提速到听不清。COMFORT_AUDIO_RATE 是音频允许的提速上限（封顶后这里
// 之前一直没真正接进计算，导致个别密句子会算出 1.8x/2x 的离谱提速，听感就是"赶"，
// 2026-06 改成真正生效）；超出后宁可顺延，不再无限提速。MIN_VIDEO_RATE 是视频最低
// 速率，从 0.8 放宽到 0.7，多给视频端一点缓冲空间，减少撞到音频提速上限的频率。
const COMFORT_AUDIO_RATE = 1.5;   // 音频提速上限（不变调，1.5x 仍清晰），超过这个宁可顺延也不让声音听起来赶
const MIN_VIDEO_RATE = 0.7;       // 视频最低速率：从 0.8 略放宽，给视频端多一点吸收空间
// 朗读模式：主要靠整体视频速率匹配字幕语言的语速需求（见 estimateReadPaceRatio/
// computeReadVideoRate），语音自身只做局部微调兜底个别句子的偏差。
// 用户反馈：±10% 太窄，朗读跟不上字幕导致大量跳读——宁可视频明显变慢、原声静音，
// 也要保证每一条字幕都能读完；个别局部还不够的句子再靠语音临时提速补差。
const READ_VIDEO_RATE_MIN = 0.4;  // 视频整体调速范围放宽：允许明显放慢，保证朗读跟得上
const READ_VIDEO_RATE_MAX = 1.3;
const READ_MAX_RATE = 1.6;        // 局部字幕仍紧张时，语音临时提速补差的上限
const READ_BREATH_GAP = 0.18;     // 每句结束后预留的"气口"时长（秒），让换行不那么生硬

// 估算"按这门语言朗读这批字幕，需要的语速"相对"该语言自然语速"的比值。
// >1：字幕偏密，自然语速读不完，要放慢视频腾出时间；<1：字幕偏稀疏，可以让视频快一点；
// =1（或样本太少时）：不调，维持 1.0x。
// CJK 类语言（中日韩泰，书写不用空格）按字符数计；其它语言按空格分词的词数计，
// 各自配一个"自然语速基准"（字符/秒 或 词/秒）。
function estimateReadPaceRatio(segs, lang) {
  const prefix = (lang || '').toLowerCase().split('-')[0];
  const isCJK = ['zh', 'ja', 'ko', 'th'].includes(prefix);
  let totalUnits = 0, totalDuration = 0;
  for (const s of segs) {
    const dur = Math.max(0, s.end - s.start);
    if (dur < 0.1) continue;
    const text = s.text || '';
    const units = isCJK
      ? [...text].filter((c) => /[一-鿿぀-ヿ가-힣฀-๿]/.test(c)).length
      : text.trim().split(/\s+/).filter(Boolean).length;
    totalUnits += units;
    totalDuration += dur;
  }
  if (totalDuration < 1 || totalUnits < 3) return 1.0;  // 样本太少，不调
  const unitsPerSec = totalUnits / totalDuration;
  const baseline = isCJK ? 4.0 : 2.5;  // 自然语速基准：中文系约4字/秒，词语类语言约2.5词/秒
  return unitsPerSec / baseline;
}

function computeReadVideoRate(paceRatio) {
  if (!paceRatio || !isFinite(paceRatio)) return 1.0;
  const raw = 1 / paceRatio;  // 需要更多时间 → 视频变慢(<1)；需要更少时间 → 视频变快(>1)
  return Math.max(READ_VIDEO_RATE_MIN, Math.min(READ_VIDEO_RATE_MAX, raw));
}

// 各处"恢复默认视频速率"要用的基准：朗读模式恢复到 sess._readVideoRate，配音模式
// 恢复到 sess._dubVideoRate——两者现在是同一套思路：全视频统一算好的基准速率，
// 不是写死的 1.0x，避免句间来回跳变速（"忽快忽慢"）。
function defaultVideoRate(sess) {
  if (sess._readMode) return sess._readVideoRate || 1.0;
  return sess._dubVideoRate || 1.0;
}
// 统一的视频调速入口：除了真正调用 video.playbackRate，还把"从这个原视频时间点起，
// 速率变成多少"记进 sess._rateLog——给"先单独录配音音频，事后把下载到的原速视频
// 按同样的变速节奏拉伸再合并音频"这个工作流用的依据。不去单独记录墙钟时间：
// ffmpeg 拉伸时按 setpts=PTS/rate 处理每一段原视频区间即可重现同样的"原视频时间→
// 拉伸后时长"映射，不需要额外对齐墙钟。连续相同速率不重复记，控制日志体积。
function setVideoRate(sess, rate) {
  try {
    const cur = sess.video.playbackRate;
    if (Math.abs(cur - rate) > 0.001) {
      sess.video.playbackRate = rate;
      if (!sess._rateLog) sess._rateLog = [];
      const t = sess.video.currentTime;
      const last = sess._rateLog[sess._rateLog.length - 1];
      if (last && Math.abs(last.t - t) < 0.001) {
        last.rate = rate;   // 同一时刻多次调速，只保留最后一次
      } else {
        sess._rateLog.push({ t, rate });
      }
    }
  } catch (_) {}
}
// 把 sess._rateLog（[{t: 原视频时间点, rate: 从这个时间点起的播放速率}, ...]）
// 整理成连续区间 [{start, end, rate}, ...] 并触发下载，供本地脚本拉伸下载到的原视频用。
function exportRateLog(sess) {
  if (!sess._rateLog || !sess._rateLog.length) return;
  const log = sess._rateLog.slice().sort((a, b) => a.t - b.t);
  const intervals = [];
  for (let i = 0; i < log.length; i++) {
    const start = log[i].t;
    const end = (i + 1 < log.length) ? log[i + 1].t : (sess.video.duration || start);
    if (end > start) intervals.push({ start: +start.toFixed(3), end: +end.toFixed(3), rate: log[i].rate });
  }
  const payload = {
    videoId: sess.videoId, title: sess.title,
    videoUrl: location.href,   // 方便事后核对/重新下载到的是不是同一个视频
    videoDuration: sess.video.duration || null,
    note: '用于把单独下载的原速视频按本次配音的变速节奏拉伸，再合并单独录制的配音音频。intervals按[start,end)覆盖原视频时间轴，rate是该区间播放速率（拉伸后时长=区间长度/rate）。',
    intervals,
  };
  try {
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `${buildExportFilenamePrefix(sess)}_ratelog.json`);
  } catch (e) { console.warn('[配音插件] 导出变速日志失败', e); }
}

function exportDiagnosticLog(sess) {
  if (!sess || (!sess._diagnosticLog?.length && !Object.keys(sess._diagnosticCounts || {}).length)) return;
  const payload = {
    videoId: sess.videoId,
    title: sess.title,
    videoUrl: location.href,
    generatedAt: new Date().toISOString(),
    counts: sess._diagnosticCounts || {},
    entries: sess._diagnosticLog || [],
    playedSourceEvents: sess._playedSourceEvents || [],
  };
  try {
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `${buildExportFilenamePrefix(sess)}_diaglog.json`
    );
  } catch (e) {
    console.warn('[配音插件] 导出诊断日志失败', e);
  }
}

function buildSourceSubtitleLedger(rawSegments, stage = 'source') {
  return (rawSegments || []).map((s, i) => {
    const sourceIndex = Number.isFinite(Number(s._sourceIndex)) ? Number(s._sourceIndex) : i;
    const item = {
      index: i + 1,
      sourceIndex,
      stage,
      start: +(+s.start || 0).toFixed(3),
      end: +(+s.end || +s.start || 0).toFixed(3),
      text: String(s.text || ''),
    };
    item.sourceKey = makeSourceSegKey(item);
    return item;
  });
}

function exportRawSourceSubtitles(sess) {
  const entries = sess?._sourceRawSubtitles || [];
  if (!entries.length) return;
  const payload = {
    videoId: sess.videoId,
    title: sess.title,
    videoUrl: location.href,
    generatedAt: new Date().toISOString(),
    note: '这是平台返回的原始字幕事件账本；原始字幕本身重复不算脚本重复。判断脚本重复时，请对照 playedSourceEvents/sourceKey。',
    entries,
    processedTimeline: sess._processedSourceSubtitles || [],
    playedSourceEvents: sess._playedSourceEvents || [],
  };
  try {
    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `${buildExportFilenamePrefix(sess)}_source_subtitles.json`
    );
  } catch (e) {
    console.warn('[配音插件] 导出原始字幕JSON失败', e);
  }

  try {
    const lines = entries.map((e, i) =>
      `${i + 1}\n${_srtTimestamp(e.start)} --> ${_srtTimestamp(Math.max(e.end, e.start + 0.05))}\n${e.text}\n`
    );
    downloadBlob(
      new Blob([lines.join('\n')], { type: 'text/srt' }),
      `${buildExportFilenamePrefix(sess)}_source_subtitles.srt`
    );
  } catch (e) {
    console.warn('[配音插件] 导出原始字幕SRT失败', e);
  }
}

// 从播放列表侧边栏面板里找这个videoId在列表里的固定序号——面板每一项自己的链接上
// 都带着&index=，那是它在这个播放列表里的位置，跟"你刚才走的哪条路径进来的"无关。
// 找不到面板（没在播放列表里看、面板还没渲染出来）就返回null，调用方退回当前URL的
// &index= 兜底。
function getCanonicalPlaylistIndex(videoId) {
  try {
    const items = document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint[href], ytd-playlist-panel-video-renderer a#thumbnail[href]');
    for (const a of items) {
      const href = a.getAttribute('href') || '';
      const vMatch = href.match(/[?&]v=([^&]+)/);
      const idxMatch = href.match(/[?&]index=(\d+)/);
      if (vMatch && vMatch[1] === videoId && idxMatch) return idxMatch[1];
    }
  } catch (_) {}
  return null;
}

// 导出文件名前缀：优先用"播放列表序号-视频标题"，没有播放列表就只用标题，
// 标题取不到才退回 videoId。Windows文件名不允许 \/:*?"<>| 这几个字符，
// 全部替换掉；另外限制长度避免标题过长导致路径超限。
function buildExportFilenamePrefix(sess) {
  let title = (sess.title || sess.videoId || 'video').trim();
  // Chrome标签页标题有时会被别的扩展（未读消息数之类）在最前面塞一个"(16716) "
  // 这样的括号数字角标，不是视频名称本身的一部分，要先去掉，不然文件名里会带上它。
  title = title.replace(/^\(\d+\)\s*/, '');
  // 序号用 sess._playlistIndex（dub开始那一刻就从URL记下来的），不在这里实时读
  // location.search——之前就是实时读的，但导出发生在 stopDubbing 里，而切到下一个
  // 视频时 autoDub 是先检测到新视频、再去停旧视频的会话，这时 URL 的 &index= 早就
  // 已经指向新视频了，导致旧视频导出文件用的是新视频的序号（全部错位）。
  // 同一个session反复导出（比如手动点过一次，停止时又自动导出一次）用的都是
  // 同一个记下来的序号，不会变来变去。
  let prefix = sess._playlistIndex ? `${sess._playlistIndex}-${title}` : title;
  prefix = prefix.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  if (prefix.length > 80) prefix = prefix.slice(0, 80);
  return prefix || (sess.videoId || 'video');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// 真正续播（auto-resume 或用户手动按播放键）那一刻调用：记一个墙钟时间原点，
// 后面每段配音播放时用这个原点算出"在录音文件里的第几秒"，用来导出对齐的字幕。
// 录音本身已经在点击配音/朗读按钮那一刻启动（见 startRecordingOnClick，Chrome的
// streamId 有效期只有几秒，等不到这里才启动），sess._recordStartWallClock 也是
// 那时候设的——这里不再重复设置/触发录音，只是历史遗留的调用点保留着，万一那一步
// 因为某些原因没设上（比如 autoExportFiles 是在按钮点击后才勾选生效的），兜底记一下
// 计时原点，让字幕导出至少不会完全对不上（不影响录音本身，录音这次就是没有了）。
function markPlaybackStart(sess) {
  if (!sess._recordStartWallClock) sess._recordStartWallClock = Date.now();
}

function _srtTimestamp(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

// 配音字幕导出：时间轴跟自动录音（dub_audio）、变速日志（ratelog）保持同一套——
// 都是"从真正开始续播那一刻起算的墙钟时间"，所以这份SRT能直接跟录音文件、
// 拉伸后的视频一起拖进剪辑软件，三者天然对齐，不需要再手动对时间。
function exportSubtitles(sess) {
  if (!sess._subtitleLog || !sess._subtitleLog.length) return;
  const entries = sess._subtitleLog.slice().sort((a, b) => a.start - b.start);
  const lines = entries.map((e, i) =>
    `${i + 1}\n${_srtTimestamp(e.start)} --> ${_srtTimestamp(e.end)}\n${e.text}\n`
  );
  try {
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/srt' }),
      `${buildExportFilenamePrefix(sess)}.srt`);
  } catch (e) { console.warn('[配音插件] 导出配音字幕失败', e); }
}

function _assTimestamp(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);   // ASS用百分之一秒，不是毫秒
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// ASS（卡拉OK特效）字幕导出：用 \kf 逐字描边特效模拟播放时"念过的字变绿"的效果。
// 跟屏幕上 renderHighlightSubtitle 同一个假设——按字数线性分配时间，不是逐字真实
// TTS时长（拿不到那么细的数据），所以是近似效果，不会跟实际发音帧级对齐。
// 注意：这个特效要播放器/工具支持ASS的\k标签才会显示渐变色（VLC、mpv、
// ffmpeg的subtitles滤镜——底层都是libass，能正确渲染；大多数剪辑软件如Premiere、
// Final Cut只会显示纯文字，不会有逐字变色效果，只能当成普通字幕用）。
// 跟屏幕上 renderHighlightSubtitle 的逐行逻辑一个思路：长句没有自然断句点时不能
// 整行甩给播放器自动换行听天由命，这里手动按"大约多少字一行"插入 \N 强制换行，
// 同时把卡拉OK的 \kf 逐字标签按原计划摊进去（换行不影响 \kf 累计时长的语义）。
function _buildKaraokeAssDialogue(e, maxCharsPerLine, escape) {
  const isCJK = CJK_RE.test(e.text);
  const units = isCJK ? [...e.text] : e.text.split(/(\s+)/).filter((u) => u.trim());
  const dur = Math.max(0.05, e.end - e.start);
  const perUnitCs = Math.max(1, Math.round((dur / Math.max(1, units.length)) * 100));
  let charsInLine = 0;
  const parts = units.map((u) => {
    const w = isCJK ? 1 : Math.max(0.3, u.length * 0.55);
    let breakBefore = '';
    if (charsInLine + w > maxCharsPerLine && charsInLine > 0) {
      breakBefore = '\\N';
      charsInLine = 0;
    }
    charsInLine += w;
    return `${breakBefore}{\\kf${perUnitCs}}${escape(u)}`;
  });
  return `Dialogue: 0,${_assTimestamp(e.start)},${_assTimestamp(e.end)},Dub,,0,0,0,,${parts.join('')}`;
}

function exportKaraokeSubtitles(sess) {
  if (!sess._subtitleLog || !sess._subtitleLog.length) return;
  // 没写 PlayResX/PlayResY，libass 渲染时只能自己猜这份字幕的参照分辨率，猜错了
  // 字号/边距相对实际视频画面的比例就全乱了，表现就是"字幕超出画面边界"。
  // 这里明确写成原视频自己的像素分辨率，跟下面 Style 里的字号/边距数值对应起来，
  // 不管最后烧录到什么分辨率的视频，libass 都会按这个参照系正确等比缩放。
  const resX = sess.video?.videoWidth || 1280;
  const resY = sess.video?.videoHeight || 720;
  const MAX_CHARS_PER_LINE = 20;
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
  const entries = sess._subtitleLog.slice().sort((a, b) => a.start - b.start);
  const events = entries.map((e) => _buildKaraokeAssDialogue(e, MAX_CHARS_PER_LINE, escape));
  const header =
`[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Dub,Microsoft YaHei,${Math.round(resY * 0.045)},&H0000FC7C,&H99FFFFFF,&H00000000,&H88000000,0,0,0,0,100,100,0,0,1,2,0,2,${Math.round(resX * 0.05)},${Math.round(resX * 0.05)},${Math.round(resY * 0.04)},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  try {
    downloadBlob(new Blob([header + events.join('\n') + '\n'], { type: 'text/plain' }),
      `${buildExportFilenamePrefix(sess)}.ass`);
  } catch (e) { console.warn('[配音插件] 导出卡拉OK字幕失败', e); }
}

// ===== 自动录制配音/朗读音频，配合变速日志一起下载 =====
// 改用 chrome.tabCapture：从标签页整体层面录音，完全不碰页面里任何具体的audio元素
// （之前用 createMediaElementSource 接管播放中的audio元素，Web Audio上下文一出问题
// 就永久没声音，用户反馈了好几次）。实际录音工作在background+offscreen document里做
// （content script这边只是发消息触发，service worker没有MediaRecorder能力）。
// 点击配音/朗读按钮那一刻（真人手势窗口内）立即拿streamId并启动录制，两步一次做完、
// 不再拆开等待。Chrome官方文档：chrome.tabCapture.getMediaStreamId() 拿到的streamId
// "只能用一次，几秒内不消费（不拿去调getUserMedia）就会过期"——不仅"拿streamId"这一步
// 需要真实用户手势，"消费streamId"（getUserMedia）本身也有几秒的极短时限，两层都不能
// 拖。之前的版本只解决了"拿streamId"的手势问题，把"消费streamId"留到markPlaybackStart
// 才做——这中间隔着取字幕等一大堆异步等待（10~40秒），streamId早就过期了，实际报错是
// "getUserMedia 失败: Error starting tab capture"。
// 现在改成点击那一刻把两步一次做完：录音会从点击那一刻就开始（包含等首批配音就绪的
// 这段静音）。原设计是等真正出声那一刻才开始录音以避免静音开头，但这个时机在技术上
// 已经不可行——宁可多一小段静音开头，也不能让整个录音功能完全用不了。
// sess._recordStartWallClock 在这里记录这个真实起点（不再由markPlaybackStart设置），
// 保证字幕/变速日志导出的时间轴跟这份录音文件对齐。
async function startRecordingOnClick(sess) {
  if (!autoExportFiles || sess._tabRecording) return;
  // 内存标志可能在扩展Service Worker重启后丢失，但offscreen里的MediaRecorder
  // 仍持有有效tabCapture流。申请新流前先查询真实状态，避免
  // “Cannot capture a tab with an active stream”。
  try {
    const existing = await chrome.runtime.sendMessage({ type: 'getTabRecordingStatus' });
    if (existing?.active) {
      _continuousTabRecording = true;
      sess._tabRecording = true;
      sess._recordStartWallClock = Date.now();
      console.log('[配音插件] 检测到已有标签页录制流，直接复用');
      return;
    }
  } catch (_) {}
  if (_continuousTabRecording) {
    // popup已经取得tabCapture并启动MediaRecorder；页面按钮只需绑定当前session，
    // 不能再次申请第二条流（Chrome会以active stream错误拒绝）。
    sess._tabRecording = true;
    sess._recordStartWallClock = Date.now();
    console.log('[配音插件] 复用弹窗已启动的标签页录制');
    return;
  }
  if (!isExtensionContextValid()) { notifyExtensionContextInvalidated(sess); return; }
  sess._recordStartWallClock = Date.now();
  try {
    const prep = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'prepareTabCapture' }, (resp) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(resp || { ok: false, error: '未知错误' });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    });
    if (!prep?.ok || !prep.streamId) {
      const errMsg = prep?.error || '未知错误';
      console.warn('[配音插件] 启动录制失败（不影响正常配音）', errMsg);
      return;
    }
    chrome.runtime.sendMessage(
      { type: 'startTabAudioRecording', withVideo: autoRecordVideo, streamId: prep.streamId },
      (resp) => {
        if (chrome.runtime.lastError) {
          console.warn('[配音插件] 启动录制失败（不影响正常配音）', chrome.runtime.lastError.message);
          return;
        }
        if (!resp?.ok) {
          const errMsg = resp?.error || chrome.runtime.lastError?.message || '未知错误';
          console.warn('[配音插件] 启动录制失败（不影响正常配音）', errMsg);
        } else {
          sess._tabRecording = true;
          _continuousTabRecording = true;
          console.log(`[配音插件] 开始录制本标签页${autoRecordVideo ? '画面+音频' : '音频'}（tabCapture）`);
        }
      }
    );
  } catch (e) {
    console.warn('[配音插件] 启动录制异常（不影响正常配音）', e);
    // "Cannot read properties of undefined (reading 'sendMessage')"这类报错说明
    // chrome.runtime 整个失效了（插件被重新加载过，这个标签页还是旧的content script
    // 实例）——只在console里警告用户根本看不到，改成弹出跟其他地方一致的清晰提示。
    if (/Cannot read propert/i.test(e?.message || '') || !isExtensionContextValid()) {
      notifyExtensionContextInvalidated(sess);
    }
  }
}

function checkTabRecordingStatus(sess) {
  if (!autoExportFiles || !isExtensionContextValid()) return;
  chrome.runtime.sendMessage({ type: 'getTabRecordingStatus' }, (status) => {
    if (chrome.runtime.lastError) {
      console.warn('[配音插件] 录音/录像状态检查失败:', chrome.runtime.lastError.message);
      return;
    }
    if (!status?.active) {
      console.warn('[配音插件] 录音/录像未运行（不影响配音播放）:', status?.error || status);
      return;
    }
    console.log(
      `[配音插件] ● 录音/录像运行中：recorder=${status.recorderState}` +
      ` 音轨=${(status.audioTracks || []).join('/') || '无'}` +
      ` 视频轨=${(status.videoTracks || []).join('/') || '无'}` +
      ` chunks=${status.chunks || 0} bytes=${status.bytes || 0}` +
      (status.checkpoint?.verified
        ? `；服务器检查点 duration=${status.checkpoint.duration}s size=${status.checkpoint.size}B saved_at=${status.checkpoint.saved_at}`
        : status.checkpointState === 'uploading'
          ? '；服务器检查点=正在上传'
          : status.checkpointState === 'failed'
            ? `；服务器检查点=失败(${status.checkpointError || '检测未通过'})`
            : status.checkpointState === 'not-configured'
              ? '；服务器检查点=尚未绑定视频ID/服务器'
              : '；服务器检查点=等待首个检查点')
    );
  });
}

function startRecordingStatusMonitor(sess) {
  if (sess._recordingStatusTimer) clearInterval(sess._recordingStatusTimer);
  if (!autoExportFiles) return;
  checkTabRecordingStatus(sess);
  sess._recordingStatusTimer = setInterval(() => {
    if (!sess.started) {
      clearInterval(sess._recordingStatusTimer);
      sess._recordingStatusTimer = null;
      return;
    }
    checkTabRecordingStatus(sess);
  }, 15000);
}

function beginCleanRecordingSegment(sess) {
  if (!autoExportFiles || sess._recordingSegmentStarted) return Promise.resolve();
  sess._recordingSegmentStarted = true;
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'resetTabRecordingSegment',
      videoId: sess.videoId,
      server: SERVER,
    }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        console.warn('[配音插件] 录音/录像无法从配音起点清零（不影响配音播放）:',
          chrome.runtime.lastError?.message || resp?.error || '未知错误');
      } else {
        sess._recordStartWallClock = Date.now();
        console.log('[配音插件] ● 配音真正开始，录音/录像已从此处清零计时');
      }
      resolve();
    });
  });
}

function stopTabAudioRecordingAndDownload(sess, keepStream = false) {
  // 不再相信页面里的_tabRecording标记；扩展重载或SPA切页可能让标记丢失，
  // 而offscreen里的MediaRecorder仍在运行。始终让offscreen查询真实状态。
  sess._tabRecording = false;
  if (!keepStream) _continuousTabRecording = false;
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        {
          type: 'stopTabAudioRecording',
          filename: buildExportFilenamePrefix(sess),
          keepStream,
          videoId: sess.videoId,
          server: SERVER,
        },
        (resp) => {
          if (resp?.cache?.ok) {
            const c = resp.cache;
            console.log(
              `[配音插件] ✓ 服务器录制缓存检测：verified=${c.verified}` +
              ` duration=${c.duration}s size=${c.size}B` +
              ` audio=${c.has_audio} video=${c.has_video}` +
              ` saved_at=${c.saved_at} path=${c.path}`
            );
          } else if (resp?.cache) {
            console.warn('[配音插件] 服务器录制缓存失败（不影响配音播放）:', resp.cache.error);
          }
          if (chrome.runtime.lastError) {
            if (keepStream) _continuousTabRecording = false;
            console.warn('[配音插件] 录音/录像切分未完成（不影响配音播放）', chrome.runtime.lastError.message);
          } else if (!resp?.ok) {
            if (keepStream) _continuousTabRecording = false;
            console.warn('[配音插件] 录音/录像切分未完成（不影响配音播放）', resp?.error);
          } else {
            console.log('[配音插件] ✓ 录音/录像已直接下载到电脑', resp);
            if (resp.cache && (!resp.cache.ok || !resp.cache.verified)) {
              console.warn('[配音插件] 服务器缓存未成功，但不影响本地文件下载',
                resp.cache.error || resp.cache);
            }
          }
          resolve();
        }
      );
    } catch (e) { console.warn('[配音插件] 停止录音异常', e); resolve(); }
  });
}

// 合成宽限：字幕没就绪时先让视频继续播多少个 timeupdate（约每秒4次）再考虑暂停。
// 非常短暂的缺口（≈1秒内）能自己缓过来，不必停；连续没就绪才真暂停缓冲。
const SYNTH_GRACE_TICKS = 4;
const REALTIME_START_CRITICAL_SECONDS = 5 * 60;
const REALTIME_MIN_READY_SECONDS = 15 * 60;
const REALTIME_NORMAL_AHEAD_SECONDS = REALTIME_MIN_READY_SECONDS;
const REALTIME_START_AHEAD_SECONDS = 15 * 60;
const AUTO_DOWNLOAD_SIDECARS = false; // 暂停自动下载 ASS/SRT/变速JSON；手动导出按钮仍可用

function makeSourceSegKey(seg) {
  if (seg?._sourceKey) return seg._sourceKey;
  const start = Math.round(Number(seg?.start || 0) * 1000);
  const endValue = Number.isFinite(Number(seg?.end)) ? Number(seg.end) : Number(seg?._sourceEnd);
  const end = Number.isFinite(endValue) ? Math.round(endValue * 1000) : '';
  const text = normalizeCaptionCompareText(seg?._sourceText || seg?.text || seg?.translation || '');
  return `${start}:${end}:${localDubHash(text)}`;
}

function sourceOrderOf(seg) {
  const n = Number(seg?._sourceIndex);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function segEndForOrder(seg) {
  const directEnd = Number(seg?.end);
  if (Number.isFinite(directEnd)) return directEnd;
  const sourceEnd = Number(seg?._sourceEnd);
  if (Number.isFinite(sourceEnd)) return sourceEnd;
  return Number(seg?.start || 0) + Math.max(0, Number(seg?.tts_duration || seg?.duration || 0));
}

function compareDubSegments(a, b) {
  const startDiff = Number(a?.start || 0) - Number(b?.start || 0);
  if (Math.abs(startDiff) > 0.001) return startDiff;
  const orderDiff = sourceOrderOf(a) - sourceOrderOf(b);
  if (Number.isFinite(orderDiff) && orderDiff !== 0) return orderDiff;
  return segEndForOrder(a) - segEndForOrder(b);
}

// 跨端唯一键不能只看 start：YouTube 开头滚动字幕可能多个事件共享同一个 start。
// 也不能直接用服务端返回的 duration/end：服务端会按 TTS 时长重算。解决办法是把
// 字幕源事件键(_sourceKey)随请求带着走；服务端没返回时，前端按请求顺序补回来。
const _segKey = (s) => makeSourceSegKey(s);
function applySessionVoice(sess, segments) {
  return segments.map((seg) => {
    const manualVoice = getPreferredChineseVoice();
    const cachedVoice = sess._cachedVoice || null;
    const preferredAutoVoice = autoDub ? (sess._autoVoice || null) : null;
    const preferredManualVoice = manualVoice || null;
    // 已有缓存的声音优先：否则同一视频再次打开时，若自动识别误判或用户改了默认声音，
    // 会查不到旧缓存并重新合成，既浪费又导致同一视频前后音色不一致。
    const voice = cachedVoice
      || (multiSpeakerEnabled ? classifySegmentVoice(sess, seg) : null)
      || preferredAutoVoice
      || preferredManualVoice
      || sess._autoVoice
      || null;
    if (voice) console.log(`[配音插件] seg${seg.start.toFixed(1)}s → ${voice}`);
    const cleanText = sanitizeDubbingText(seg.text);
    const sourceKey = makeSourceSegKey(seg);
    const withSource = {
      ...seg,
      text: cleanText,
      _sourceKey: sourceKey,
      _sourceStart: seg.start,
      _sourceEnd: seg.end,
      _sourceText: seg._sourceText || seg.text,
      _sourceIndex: Number.isFinite(Number(seg._sourceIndex)) ? Number(seg._sourceIndex) : null,
    };
    return voice ? { ...withSource, voice, _strictCacheVoice: !!cachedVoice } : withSource;
  }).filter((seg) => seg.text);
}

// 对指定时间位置附近"尚未合成"的句子优先合成（按离 t 由近到远），用于 seek 后
// 立即跳到新位置配音，而不是等顺序合成慢慢爬过去。并发去重靠 _synthInFlight。
async function requestSynthAround(sess, t) {
  if (!sess._allSegments || !sess.started || !sess.videoId) return;
  // 启动准备阶段由 processDubbingChunked 的主流负责生成第一批。此时 timeupdate /
  // seeking 也可能被“归零、暂停”等内部动作触发；若再从这里发一条优先请求，就会
  // 与主流重复占用服务器并发，最坏会两边都卡到150秒后反复重发。首批就绪后
  // onFirstChunkReady 会把 phase 改成 dubbing，届时快进和缺口补齐才允许走这里。
  if (sess._phase === 'preparing') return;
  sess._synthInFlight = sess._synthInFlight || new Set();
  // 已有对象不等于已有可播放音频：404 后会保留同一时间轴对象以便替换，
  // 不能再把它当作“已合成”而永远不重试。
  const have = new Set(sess.dubSegments
    .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
    .map(_segKey));
  const pending = sess._allSegments
    .filter((s) => (s.end || s.start) >= t - 0.5)            // 当前位置及之后
    .filter((s) => !have.has(_segKey(s)) && !sess._synthInFlight.has(_segKey(s)))
    .sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))  // 离 t 最近优先
    .slice(0, getDubLeadSeconds(sess, t) < 120 ? 12 : 8);
  if (!pending.length) return;
  const keys = pending.map(_segKey);
  keys.forEach((k) => sess._synthInFlight.add(k));

  const pushAndMaybeResume = (got) => {
    if (!(got && got.length && sess.started)) return;
    const existing = new Map(sess.dubSegments.map((item) => [_segKey(item), item]));
    const ct = sess.video?.currentTime || t || 0;
    for (const s of got) {
      const key = _segKey(s);
      const prior = existing.get(key);
      if (!prior) {
        const inserted = { ...s, played: initialPlayedStateForInsertedSegment(sess, s, ct) };
        sess.dubSegments.push(inserted);
        existing.set(key, inserted);
      } else if (prior._invalidAudio || prior._skipLocalCache || prior._skippedStale || !prior.audio_url
          || (!prior._persistedLocalAudio && s._persistedLocalAudio)) {
        const previousUrl = prior.audio_url;
        if (previousUrl && previousUrl !== s.audio_url) delete sess.audioCache?.[previousUrl];
        Object.assign(prior, s, {
          played: initialPlayedStateForInsertedSegment(sess, s, ct),
          _invalidAudio: false,
          _loadRetryCount: 0,
        });
        delete prior._skippedStale;
        delete prior._skipLocalCache;
        delete prior._audioFailureRecovering;
      }
    }
    sess.dubSegments.sort(compareDubSegments);
    if (!sess._startupGatePending && sess._buffering && _segReadyAt(sess, sess.video.currentTime)) {
      sess._buffering = false; sess.weArePausing = false;
      hideBufferIndicator();
      try { sess.video.play().catch(() => {}); } catch (_) {}
    }
  };

  // 朗读模式：快进/快退后要尽快出声——批量等8句一起合成会被最慢那句拖累。
  // 这里先单独抓"离 t 最近的1句"，拿到立刻推入播放队列并主动踢一次调度；
  // 剩下几句再并行补齐、不阻塞这第一句出声。
  if (sess._readMode) {
    const [closest, ...rest] = pending;
    try {
      const got1 = await sendChunkReadAloudCloud(
        [{ start: closest.start, end: closest.end, text: closest.text }], sess._readLang);
      pushAndMaybeResume(got1);
      playNextDue(sess, sess.video.currentTime);
    } catch (e) {
      console.warn('[朗读] seek后优先合成最近句失败', e?.message);
    } finally {
      sess._synthInFlight.delete(_segKey(closest));
    }
    if (rest.length) {
      sendChunkReadAloudCloud(rest.map((s) => ({ start: s.start, end: s.end, text: s.text })), sess._readLang)
        .then(pushAndMaybeResume)
        .catch((e) => console.warn('[朗读] seek后补齐剩余句失败', e?.message))
        .finally(() => rest.forEach((s) => sess._synthInFlight.delete(_segKey(s))));
    }
    return;
  }

  try {
    let segs = applySessionVoice(sess, pending);
    const localCached = await loadLocalDubBatch(sess.videoId, segs);
    if (!sess.started) return;
    if (localCached?.some(Boolean)) {
      const hits = localCached.filter(Boolean);
      pushAndMaybeResume(hits);
      if (hits.length === segs.length) {
        sess._priorityRetryCount = 0;
        clearTimeout(sess._priorityRetryTimer);
        sess._priorityRetryTimer = null;
        recordDiagnostic(sess, 'priority_loaded_from_local_cache', {
          currentTime: +(sess.video?.currentTime || t || 0).toFixed(3),
          count: hits.length,
        });
        playNextDue(sess, sess.video.currentTime);
        return;
      }
      segs = segs.filter((_, i) => !localCached[i]);
    }
    const got = await sendChunk(sess.videoId, sess.title, segs, sess._baseRatePct || 0, sess._readMode, sess._readLang, sess._subtitleMode === 'gemini');
    pushAndMaybeResume(got);
    if (got?.length) {
      sess._priorityRetryCount = 0;
      clearTimeout(sess._priorityRetryTimer);
      sess._priorityRetryTimer = null;
    }
  } catch (e) {
    console.warn('[配音插件] 优先合成失败', e?.message);
    // 视频已经因缺句暂停后不会再产生timeupdate；若这里只记录错误，就永远没有
    // 下一次补救机会。失败后主动定时重试当前位置，成功时pushAndMaybeResume会续播。
    sess._priorityRetryCount = (sess._priorityRetryCount || 0) + 1;
    if (sess._priorityRetryCount >= 2) {
      sess._forceConservativeDubbing = true;
      recordDiagnostic(sess, 'priority_synth_failure_triggered_conservative_mode', {
        priorityRetryCount: sess._priorityRetryCount,
        currentTime: +(sess.video?.currentTime || 0).toFixed(3),
        error: e?.message || String(e || ''),
      });
    }
    const delay = getPriorityRetryDelayMs(sess, t);
    clearTimeout(sess._priorityRetryTimer);
    sess._priorityRetryTimer = setTimeout(() => {
      if (sess.started) requestSynthAround(sess, sess.video.currentTime);
    }, delay);
    const lead = getDubLeadSeconds(sess, t);
    if (lead < 90) {
      showBufferIndicator(`🎧 当前句配音暂时失败，${(delay / 1000).toFixed(delay < 1000 ? 1 : 0)}秒后自动重试…`, sess.video);
    } else {
      console.warn(`[配音插件] 当前句配音暂时失败，库存仍有 ${Math.round(lead)} 秒，静默重试`);
    }
  } finally {
    keys.forEach((k) => sess._synthInFlight.delete(k));
  }
}

function requestRealtimeCurrentSentenceRepair(sess, seg, t) {
  if (!sess?.started || !seg || !sess.videoId || sess._readMode) return;
  if (_currentSegReadyAt(sess, t)) return;
  const key = _segKey(seg);
  sess._realtimeCurrentRepair = sess._realtimeCurrentRepair || new Map();
  const state = sess._realtimeCurrentRepair.get(key) || { tries: 0, inFlight: false, lastAt: 0 };
  if (state.inFlight) return;
  const now = Date.now();
  const early = Number(t || 0) < 3 * 60;
  const minGap = early ? Math.min(1200, 250 + state.tries * 250) : getPriorityRetryDelayMs(sess, t);
  if (now - state.lastAt < minGap) return;

  state.inFlight = true;
  state.lastAt = now;
  state.tries += 1;
  sess._realtimeCurrentRepair.set(key, state);
  recordDiagnostic(sess, 'realtime_current_sentence_repair_start', {
    currentTime: +(t || 0).toFixed(3),
    missingStart: +(seg.start || 0).toFixed(3),
    tries: state.tries,
    early,
  });

  (async () => {
    try {
      const requested = applySessionVoice(sess, [seg]);
      const localCached = await loadLocalDubBatch(sess.videoId, requested);
      if (sess.started && localCached?.[0]) {
        const item = localCached[0];
        const existingByKey = new Map((sess.dubSegments || []).map((x) => [_segKey(x), x]));
        const existing = existingByKey.get(_segKey(item));
        if (existing) {
          Object.assign(existing, item, {
            played: initialPlayedStateForInsertedSegment(sess, item, sess.video?.currentTime || t || 0),
            _loadRetryCount: 0,
            _invalidAudio: false,
          });
          delete existing._skippedStale;
        } else {
          sess.dubSegments.push({
            ...item,
            played: initialPlayedStateForInsertedSegment(sess, item, sess.video?.currentTime || t || 0),
          });
        }
        sess.dubSegments.sort(compareDubSegments);
        const frontier = segmentTimelineEnd(item);
        sess._maxSynthedTime = Math.max(sess._maxSynthedTime || 0, frontier);
        if (sess._onChunkProgress) sess._onChunkProgress(sess._maxSynthedTime);
        recordDiagnostic(sess, 'realtime_current_sentence_loaded_from_local_cache', {
          currentTime: +(sess.video?.currentTime || 0).toFixed(3),
          missingStart: +(seg.start || 0).toFixed(3),
          tries: state.tries,
        });
        playNextDue(sess, sess.video.currentTime);
        return;
      }
      const got = await sendChunk(sess.videoId, sess.title, requested, sess._baseRatePct || 0,
        false, null, sess._subtitleMode === 'gemini');
      if (!sess.started || !got?.length) return;
      await saveLocalDubBatch(sess.videoId, requested, got);
      const existingByKey = new Map((sess.dubSegments || []).map((item) => [_segKey(item), item]));
      let repaired = 0;
      for (const item of got) {
        const itemKey = _segKey(item);
        const existing = existingByKey.get(itemKey);
        if (existing) {
          const previousUrl = existing.audio_url;
          if (previousUrl && previousUrl !== item.audio_url) delete sess.audioCache[previousUrl];
          Object.assign(existing, item, {
            played: initialPlayedStateForInsertedSegment(sess, item, sess.video?.currentTime || t || 0),
            _loadRetryCount: 0,
            _invalidAudio: false,
          });
          delete existing._skipLocalCache;
          delete existing._audioFailureRecovering;
        } else {
          sess.dubSegments.push({
            ...item,
            played: initialPlayedStateForInsertedSegment(sess, item, sess.video?.currentTime || t || 0),
          });
          existingByKey.set(itemKey, item);
        }
        repaired++;
      }
      if (repaired) {
        sess.dubSegments.sort(compareDubSegments);
        markReturnedAudioPersisted(sess, got, sess.video?.currentTime || t || 0);
        const frontier = Math.max(...got.map(segmentTimelineEnd));
        sess._maxSynthedTime = Math.max(sess._maxSynthedTime || 0, frontier);
        if (sess._onChunkProgress) sess._onChunkProgress(sess._maxSynthedTime);
        recordDiagnostic(sess, 'realtime_current_sentence_repair_done', {
          currentTime: +(sess.video?.currentTime || 0).toFixed(3),
          missingStart: +(seg.start || 0).toFixed(3),
          repaired,
          tries: state.tries,
        });
        playNextDue(sess, sess.video.currentTime);
      }
    } catch (e) {
      recordDiagnostic(sess, 'realtime_current_sentence_repair_failed', {
        currentTime: +(sess.video?.currentTime || 0).toFixed(3),
        missingStart: +(seg.start || 0).toFixed(3),
        tries: state.tries,
        error: e?.message || String(e || ''),
      });
      console.warn('[配音插件] 当前句即时补救失败，继续短间隔重试', e?.message || e);
    } finally {
      state.inFlight = false;
      state.lastAt = Date.now();
      sess._realtimeCurrentRepair.set(key, state);
      if (sess.started && !_currentSegReadyAt(sess, sess.video.currentTime)
          && Math.abs((sess.video.currentTime || 0) - (seg.start || 0)) < (early ? 8 : 4)) {
        const delay = early ? Math.min(1200, 250 + state.tries * 250) : getPriorityRetryDelayMs(sess, sess.video.currentTime);
        clearTimeout(state.timer);
        state.timer = setTimeout(() => requestRealtimeCurrentSentenceRepair(sess, seg, sess.video.currentTime), delay);
      }
    }
  })();
}

function rememberMissedRealtimeSegment(sess, seg, reason = 'not_ready') {
  if (!sess || !seg) return;
  sess._missedRealtimeSegments = sess._missedRealtimeSegments || new Map();
  const key = _segKey(seg);
  if (!sess._missedRealtimeSegments.has(key)) {
    sess._missedRealtimeSegments.set(key, {
      key,
      start: seg.start,
      end: seg.end,
      text: seg.translation || seg.text,
      sourceIndex: Number.isFinite(Number(seg._sourceIndex)) ? Number(seg._sourceIndex) : null,
      firstSeenAt: Date.now(),
      reason,
    });
  }
}

function getMissedRealtimeDisplayRows(sess) {
  if (!sess?._missedRealtimeSegments?.size) return [];
  const playedKeys = new Set((sess._playedSourceEvents || [])
    .filter((item) => item?.mode === 'audio' || item?.mode === 'web_speech')
    .map((item) => item.sourceKey));
  const all = Array.isArray(sess._allSegments) ? sess._allSegments : [];
  const lineByKey = new Map(all.map((seg, index) => [
    _segKey(seg),
    Number.isFinite(Number(seg._sourceIndex)) ? Number(seg._sourceIndex) + 1 : index + 1,
  ]));
  return [...sess._missedRealtimeSegments.values()]
    .filter((item) => item?.key && !playedKeys.has(item.key))
    .map((item) => ({
      ...item,
      line: Number.isFinite(Number(item.sourceIndex))
        ? Number(item.sourceIndex) + 1
        : (lineByKey.get(item.key) || 0),
      text: String(item.text || '').trim(),
    }))
    .filter((item) => item.text)
    .sort((a, b) => (a.line || 0) - (b.line || 0) || (a.start || 0) - (b.start || 0));
}

function showMissedRealtimeSummary(sess) {
  const rows = getMissedRealtimeDisplayRows(sess);
  if (!rows.length) return;
  const old = document.getElementById('yt-dub-missed-summary');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.id = 'yt-dub-missed-summary';
  panel.style.cssText = [
    'position:fixed',
    'right:18px',
    'bottom:18px',
    'z-index:2147483647',
    'max-width:min(620px,calc(100vw - 36px))',
    'max-height:min(360px,60vh)',
    'overflow:auto',
    'background:#111827',
    'color:#fff',
    'font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'border:1px solid rgba(255,255,255,.18)',
    'border-radius:14px',
    'box-shadow:0 12px 36px rgba(0,0,0,.35)',
    'padding:14px',
  ].join(';');
  const top = document.createElement('div');
  top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px';
  const title = document.createElement('div');
  title.textContent = `本次有 ${rows.length} 句未在视频中显示`;
  title.style.cssText = 'font-weight:700;font-size:15px';
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = '关闭';
  close.style.cssText = 'border:0;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px';
  close.addEventListener('click', () => panel.remove());
  top.append(title, close);

  const hint = document.createElement('div');
  hint.textContent = '以下内容为实时播放时自动跳过的句子；重新播放会优先使用/补齐缓存。';
  hint.style.cssText = 'opacity:.82;margin-bottom:8px';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px';
  const visibleRows = rows.slice(0, 40);
  for (const item of visibleRows) {
    const div = document.createElement('div');
    div.style.cssText = 'background:rgba(255,255,255,.08);border-radius:8px;padding:7px 9px';
    const time = formatHMS(Number(item.start || 0));
    const line = item.line ? `第${item.line}行 / ${time}` : `约 ${time}`;
    div.textContent = `${line}：（${item.text}）未在视频中显示，重新播放会补全。`;
    list.appendChild(div);
  }
  if (rows.length > visibleRows.length) {
    const more = document.createElement('div');
    more.style.cssText = 'opacity:.75;margin-top:4px';
    more.textContent = `另有 ${rows.length - visibleRows.length} 句未显示，已记录在诊断日志中。`;
    list.appendChild(more);
  }
  panel.append(top, hint, list);
  const anchor = document.querySelector('#player') || document.querySelector('#movie_player')?.parentElement;
  if (anchor?.parentElement) {
    panel.style.position = 'relative';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.margin = '10px 0';
    anchor.insertAdjacentElement('afterend', panel);
  } else {
    document.documentElement.appendChild(panel);
  }
  recordDiagnostic(sess, 'realtime_missed_summary_shown', {
    count: rows.length,
    lines: rows.slice(0, 80).map((item) => ({
      line: item.line,
      start: item.start,
      time: formatHMS(Number(item.start || 0)),
      text: item.text,
    })),
  });
}

function isRealtimeSubtitleSuppressed(sess, seg) {
  if (!sess?._missedRealtimeSegments || !seg) return false;
  const key = _segKey(seg);
  if (!sess._missedRealtimeSegments.has(key)) return false;
  const ready = (sess.dubSegments || []).find(
    (s) => _segKey(s) === key && (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale);
  return !ready;
}

// 前十分钟是实时配音唯一没有冗余的区域。主流合成即使后来已经做到十分钟之后，
// 也不能掩盖前面某批失败、坏音频或浏览器解码失败造成的洞。这里按“织地毯”方式：
// 每 2 秒审计已播位置前后 90 秒，优先小批替换缺段/坏段；绝不暂停已开始的视频。
function repairEarlyDubbingWindow(sess, t) {
  if (!sess?.started || sess._readMode || sess._phase !== 'dubbing' || t > 600) return;
  const now = Date.now();
  const critical = Number(t || 0) < REALTIME_START_CRITICAL_SECONDS;
  if (sess._earlyWindowRepairing || now - (sess._lastEarlyWindowAuditAt || 0) < (critical ? 900 : 2000)) return;
  sess._lastEarlyWindowAuditAt = now;
  const valid = new Set((sess.dubSegments || [])
    .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
    .map(_segKey));
  const end = Math.min(
    REALTIME_START_AHEAD_SECONDS,
    Math.max(critical ? REALTIME_START_AHEAD_SECONDS : 120, t + (critical ? REALTIME_START_AHEAD_SECONDS : 90)));
  const missing = (sess._allSegments || [])
    .filter((s) => s.start <= end && !valid.has(_segKey(s)))
    .filter((s) => !sess._synthInFlight?.has(_segKey(s)))
    .slice(0, critical ? 24 : 12);
  if (!missing.length) return;
  sess._earlyWindowRepairing = true;
  const keys = missing.map(_segKey);
  sess._synthInFlight = sess._synthInFlight || new Set();
  keys.forEach((key) => sess._synthInFlight.add(key));
  recordDiagnostic(sess, 'early_window_gap_repair_start', {
    currentTime: +(+t || 0).toFixed(3), end, count: missing.length,
  });
  (async () => {
    try {
      const requested = applySessionVoice(sess, missing);
      const got = await sendChunk(sess.videoId, sess.title, requested, sess._baseRatePct || 0,
        false, null, sess._subtitleMode === 'gemini');
      if (!sess.started || !got?.length) return;
      await saveLocalDubBatch(sess.videoId, requested, got);
      const existing = new Map((sess.dubSegments || []).map((s) => [_segKey(s), s]));
      for (const item of got) {
        const old = existing.get(_segKey(item));
        const ct = sess.video.currentTime || 0;
        if (old) Object.assign(old, item, {
          // 旧对象可能正是之前被“过期跳过”的那一条。音频回补后必须按当前
          // 原字幕窗口重新判断，不能沿用 played=true，否则缓存虽已恢复仍永远不播。
          played: initialPlayedStateForInsertedSegment(sess, item, ct),
          _invalidAudio: false,
          _loadRetryCount: 0,
        });
        if (old) {
          delete old._skippedStale;
          delete old._skipLocalCache;
          delete old._audioFailureRecovering;
        }
        else sess.dubSegments.push({ ...item, played: initialPlayedStateForInsertedSegment(sess, item, ct) });
      }
      sess.dubSegments.sort(compareDubSegments);
      markReturnedAudioPersisted(sess, got, sess.video.currentTime || t || 0);
      recordDiagnostic(sess, 'early_window_gap_repair_done', { count: got.length, end });
      playNextDue(sess, sess.video.currentTime);
    } catch (e) {
      recordDiagnostic(sess, 'early_window_gap_repair_failed', { error: e?.message || String(e || ''), end });
      console.warn('[配音插件] 前十分钟缺段补救暂时失败，将继续短间隔审计', e?.message || e);
    } finally {
      keys.forEach((key) => sess._synthInFlight?.delete(key));
      sess._earlyWindowRepairing = false;
    }
  })();
}

// 当前时间 t 处是否已有"就绪(已合成带音频)"的配音段
function _segReadyAt(sess, t) {
  return sess.dubSegments.some((s) => {
    const segEnd = segmentTimelineEnd(s);
    return (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale
      && s.start <= t + 0.5 && segEnd >= t - 0.5;
  }) || sess.dubSegments.some(
    (s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale
      && s.start > t && s.start <= t + 4);
}

function _currentSegReadyAt(sess, t) {
  return sess.dubSegments.some((s) => {
    const segEnd = segmentTimelineEnd(s);
    return (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale
      && s.start <= t + 0.5 && segEnd >= t - 0.5;
  });
}

function rememberPlayedSourceEvent(sess, seg, mode = 'audio') {
  if (!sess || !seg) return;
  sess._playedSourceEvents = sess._playedSourceEvents || [];
  const key = _segKey(seg);
  const epoch = sess._seekEpoch || 0;
  const countSameEpoch = sess._playedSourceEvents.filter(
    (e) => e.sourceKey === key && e.seekEpoch === epoch).length;
  const entry = {
    sourceKey: key,
    seekEpoch: epoch,
    mode,
    start: +(+seg.start || 0).toFixed(3),
    end: +(segmentTimelineEnd(seg) || 0).toFixed(3),
    text: String(seg.translation || seg.text || ''),
    playedAt: new Date().toISOString(),
    duplicateWithinSeek: countSameEpoch > 0,
  };
  sess._playedSourceEvents.push(entry);
  if (sess._playedSourceEvents.length > 2000) sess._playedSourceEvents.shift();
  if (entry.duplicateWithinSeek) {
    recordDiagnostic(sess, 'played_source_event_duplicate', entry);
  }
}

function rememberCompletedSpoken(sess, seg) {
  if (!sess || !seg) return;
  if (!sess._recentSpoken) sess._recentSpoken = [];
  sess._recentSpoken.push({
    key: _segKey(seg),
    text: seg.text,
    start: seg.start,
    end: segmentTimelineEnd(seg),
    videoId: sess.videoId,
    seekEpoch: sess._seekEpoch || 0,
  });
  if (sess._recentSpoken.length > 6) sess._recentSpoken.shift();
}

function _hasForwardDubCache(sess, t, windowSec = 45) {
  const end = t + windowSec;
  return !!sess.dubSegments?.some((s) => {
    if (!s.audio_url && !s.web_speech) return false;
    if (s._invalidAudio || s._skippedStale) return false;
    const segEnd = segmentTimelineEnd(s);
    return segEnd >= t - 0.5 && s.start <= end;
  });
}

// 音频“已合成”不等于浏览器一定能解码/播放。旧逻辑在播放失败时保留
// played=true 与 audio_url，导致该段既不再尝试，也仍被库存统计视为“已就绪”。
// 长视频后段出现“库存领先但字幕和声音同时消失”正是这一状态机漏洞。
function removeFailedLocalDubRow(videoId, seg) {
  if (!videoId || !seg) return;
  openLocalDubDB().then((db) => {
    try {
      const tx = db.transaction('segments', 'readwrite');
      tx.objectStore('segments').delete(localDubKey(videoId, seg));
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
      tx.onabort = () => db.close();
    } catch (_) { try { db.close(); } catch (_) {} }
  }).catch(() => {});
}

function recoverFailedPlaybackAudio(sess, seg, reason, error = '') {
  if (!sess || !seg || seg._audioFailureRecovering) return;
  seg._audioFailureRecovering = true;
  const retries = (seg._loadRetryCount || 0) + 1;
  seg._loadRetryCount = retries;
  seg.played = false;
  const staleUrl = seg.audio_url;
  if (staleUrl) delete sess.audioCache?.[staleUrl];
  recordDiagnostic(sess, 'audio_playback_failure_retry', {
    reason, retries,
    segStart: +(Number(seg.start || 0)).toFixed(3),
    segEnd: +(segmentEndForPlayback(seg)).toFixed(3),
    error: String(error || '').slice(0, 240),
  });

  if (retries >= 2) {
    // 两次实际播放/解码失败后才判定缓存损坏。删除本地旧行并明确标为无效，
    // 让库存前沿与看门狗都看见真实缺口，再走当前句的高优先级补救。
    seg._invalidAudio = true;
    seg._skipLocalCache = true;
    seg.audio_b64 = null;
    seg.audio_url = '';
    removeFailedLocalDubRow(sess.videoId, seg);
    recordDiagnostic(sess, 'audio_segment_forced_regeneration', {
      reason, retries, segStart: +(Number(seg.start || 0)).toFixed(3),
    });
    console.warn('[配音插件] 音频缓存两次播放失败，已剔除并立即重新合成：',
      `${Number(seg.start || 0).toFixed(1)}s`, reason);
    setVideoRate(sess, defaultVideoRate(sess));
    setTimeout(() => {
      seg._audioFailureRecovering = false;
      if (!sess.started || sess._userPaused) return;
      requestRealtimeCurrentSentenceRepair(sess, seg, sess.video?.currentTime || 0);
      ensurePlaybackWindowFromLocalCache(sess, sess.video?.currentTime || 0,
        'failed_audio_forced_regeneration', 2, 90);
    }, 80);
    return;
  }

  setTimeout(() => {
    seg._audioFailureRecovering = false;
    if (sess.started && !sess._userPaused && !sess.video?.paused) {
      playNextDue(sess, sess.video.currentTime);
    }
  }, 250);
}

function getLoadedDubQueueFrontier(sess, t = null) {
  const now = t == null ? Number(sess?.video?.currentTime || 0) : Number(t || 0);
  let frontier = now;
  const sorted = (sess?.dubSegments || [])
    .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
    .sort(compareDubSegments);
  for (const seg of sorted) {
    const end = segmentTimelineEnd(seg);
    if (end < frontier - 0.5) continue;
    if (seg.start > frontier + 1.2) break;
    frontier = Math.max(frontier, end);
  }
  return frontier;
}

function getDubLeadSeconds(sess, t = null) {
  const now = t == null ? Number(sess?.video?.currentTime || 0) : Number(t || 0);
  return Math.max(0, getLoadedDubQueueFrontier(sess, now) - now);
}

function getPriorityRetryDelayMs(sess, t = null) {
  const lead = getDubLeadSeconds(sess, t);
  const tries = sess?._priorityRetryCount || 1;
  const now = t == null ? Number(sess?.video?.currentTime || 0) : Number(t || 0);
  if (now < 3 * 60) return Math.min(1200, 250 + tries * 250);
  if (lead < 30) return Math.min(2500, 800 + tries * 400);
  if (lead < 90) return Math.min(4000, 1200 + tries * 600);
  if (lead < 5 * 60) return Math.min(7000, 2000 + tries * 900);
  return Math.min(12000, 3000 + tries * 1200);
}

const REALTIME_STALE_SEGMENT_GRACE = 0.9;

// 时间轴调度（是否轮到、是否过期、库存连续性）以原字幕 end 为准，不能以
// TTS 实际时长为准。后者经常更短，会让还在原字幕时间窗内的段被提前跳过。
function segmentTimelineEnd(seg) {
  const start = Number(seg?.start || 0);
  const sourceEnd = Number(seg?._sourceEnd ?? seg?.end);
  if (Number.isFinite(sourceEnd) && sourceEnd > start) return sourceEnd;
  return start + Math.max(0.05, Number(seg?.duration || seg?.tts_duration || 0));
}

function segmentEndForPlayback(seg) {
  return segmentTimelineEnd(seg);
}

function isRealtimeSegmentStale(seg, t, grace = REALTIME_STALE_SEGMENT_GRACE) {
  if (!seg || seg.played || seg._invalidAudio) return false;
  return segmentEndForPlayback(seg) < Number(t || 0) - grace;
}

function skipRealtimeStaleSegment(sess, seg, t, reason = 'stale_overdue') {
  if (!sess || !seg || seg.played) return false;
  seg.played = true;
  seg._skippedStale = true;
  rememberMissedRealtimeSegment(sess, seg, reason);
  recordDiagnostic(sess, 'realtime_stale_segment_skipped', {
    currentTime: +(Number(t || 0)).toFixed(3),
    segStart: +(Number(seg.start || 0)).toFixed(3),
    segEnd: +(segmentEndForPlayback(seg)).toFixed(3),
    sourceIndex: Number.isFinite(Number(seg._sourceIndex)) ? Number(seg._sourceIndex) : null,
    text: String(seg.translation || seg.text || '').slice(0, 80),
    reason,
  });
  return true;
}

function initialPlayedStateForInsertedSegment(sess, seg, t) {
  if (isRealtimeSegmentStale(seg, t)) {
    skipRealtimeStaleSegment(sess, seg, t, 'inserted_after_window');
    return true;
  }
  // 不能只因为开始时间在当前点前 5 秒就把它标成已播：一条原字幕可能持续
  // 十几秒，而 TTS/IndexedDB 刚好在其时间窗内到达。旧条件会让“缓存已满”
  // 的视频在这类边界句开始连续静音。是否已错过只由完整的原字幕时间窗决定。
  return false;
}

const LOCAL_CACHE_LOW_WATER_SECONDS = REALTIME_MIN_READY_SECONDS;
const LOCAL_CACHE_TARGET_SECONDS = 25 * 60;

function _ensureLocalCacheLead(sess, t) {
  if (!sess?.started || !sess.videoId || !Array.isArray(sess._allSegments)) return;
  if (!sess._knownFullLocalCache && !sess._cachedVoice && !sess._localDubCoverage?.hitCount) return;
  const lead = getDubLeadSeconds(sess, t);
  if (lead >= LOCAL_CACHE_LOW_WATER_SECONDS) return;
  if (sess._localCacheLeadLoading) return;
  const minGapMs = lead < 60 ? 800 : (lead < 3 * 60 ? 1500 : 2500);
  if (Date.now() - (sess._lastLocalCacheLeadLoadAt || 0) < minGapMs) return;
  sess._lastLocalCacheLeadLoadAt = Date.now();
  sess._localCacheLeadLoading = true;

  (async () => {
    try {
      const from = Math.max(0, t - 2);
      const to = t + LOCAL_CACHE_TARGET_SECONDS;
      const existingReady = new Set((sess.dubSegments || [])
        .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
        .map(_segKey));
      const candidates = sess._allSegments
        .filter((s) => {
          if (existingReady.has(_segKey(s))) return false;
          const end = segmentTimelineEnd(s);
          return end >= from && s.start <= to;
        })
        .slice(0, lead < 60 ? 420 : 260);
      if (!candidates.length) return;

      const requested = applySessionVoice(sess, candidates);
      const cached = await loadLocalDubBatch(sess.videoId, requested);
      if (!sess.started) return;

      let loaded = 0;
      let frontier = sess._maxSynthedTime || 0;
      const byKey = new Map((sess.dubSegments || []).map((item) => [_segKey(item), item]));
      for (let i = 0; i < cached.length; i++) {
        const item = cached[i];
        if (!item) continue;
        const key = _segKey(item);
        const existing = byKey.get(key);
        if (existing && (existing.audio_url || existing.web_speech)
            && !existing._invalidAudio && !existing._skippedStale) continue;
        if (existing) {
          Object.assign(existing, item, {
            played: initialPlayedStateForInsertedSegment(sess, item, t),
            _invalidAudio: false,
            _loadRetryCount: 0,
          });
          delete existing._skippedStale;
        } else {
          const inserted = { ...item, played: initialPlayedStateForInsertedSegment(sess, item, t) };
          sess.dubSegments.push(inserted);
          byKey.set(key, inserted);
        }
        loaded++;
        frontier = Math.max(frontier, segmentTimelineEnd(item));
      }
      if (!loaded) return;
      sess.dubSegments.sort(compareDubSegments);
      sess._maxSynthedTime = Math.max(sess._maxSynthedTime || 0, frontier);
      if (sess._onChunkProgress) sess._onChunkProgress(sess._maxSynthedTime);
      recordDiagnostic(sess, 'loaded_forward_local_cache_into_play_queue', {
        loaded,
        currentTime: +(t || 0).toFixed(3),
        maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
      });
      if (!sess._startupGatePending && sess._buffering && _segReadyAt(sess, sess.video.currentTime)) {
        sess._buffering = false;
        sess.weArePausing = false;
        sess._bufferingSince = null;
        hideBufferIndicator();
        try { sess.video.play().catch(() => {}); } catch (_) {}
      }
    } catch (e) {
      console.warn('[配音插件] 装载本地前方缓存失败', e?.message || e);
    } finally {
      sess._localCacheLeadLoading = false;
    }
  })();
}

function ensurePlaybackWindowFromLocalCache(sess, t, reason = 'playback_window_missing', beforeSec = 3, afterSec = 180) {
  if (!sess?.started || sess._readMode || !sess.videoId || !Array.isArray(sess._allSegments)) return;
  if (!sess._knownFullLocalCache && !sess._cachedVoice && !sess._localDubCoverage?.hitCount) return;
  if (sess._playbackWindowHydrating) return;
  const now = Date.now();
  const current = Number(t || sess.video?.currentTime || 0);
  const minGap = current < REALTIME_START_CRITICAL_SECONDS ? 350 : 900;
  if (now - (sess._lastPlaybackWindowHydrateAt || 0) < minGap) return;
  sess._lastPlaybackWindowHydrateAt = now;
  sess._playbackWindowHydrating = true;
  hydrateLocalCacheWindow(sess, current, beforeSec, afterSec)
    .then((count) => {
      if (!sess.started) return;
      if (count) {
        recordDiagnostic(sess, 'playback_window_hydrated_from_local_cache', {
          reason,
          currentTime: +current.toFixed(3),
          count,
        });
        playNextDue(sess, sess.video?.currentTime || current);
      }
    })
    .catch((e) => console.warn('[配音插件] 当前播放窗口本地缓存装载失败', e?.message || e))
    .finally(() => { sess._playbackWindowHydrating = false; });
}

// 位置感知缓冲：只看"当前位置该有的句子是否已合成"，而非全局顺序前沿。
// 这样 seek 到任意位置都能就地等该位置合成，不必等顺序合成爬过来。
function maybeBufferForSynthesis(sess, t) {
  const unbuffer = () => {
    // 开头归零后的三句闸门只能由 startupAudioGateReady 放行。这里是“中后段
    // 不停视频”的通用逻辑，若在开头也放行，就会出现字幕一路走、声音随后补的空播。
    if (sess._startupGatePending) return;
    if (sess._buffering) {
      sess._buffering = false; sess.weArePausing = false;
      sess._bufferingSince = null;
      hideBufferIndicator();
      try { sess.video.play().catch(() => {}); } catch (_) {}
    }
  };
  _ensureLocalCacheLead(sess, t);
  // 快速路径：只要合成前沿/可播缓存已经覆盖或明显领先当前时间，就不因为某个
  // 边界句短暂未命中而暂停视频。长视频几千段字幕时，这也是避免每个 timeupdate
  // 都全量扫描、最后二十分钟主线程越来越卡的关键。
  // 先判断当前位置是否本来就有字幕/配音。即使之前曾标记“全部完成”，当前位置
  // 缺少音频也必须重新打开补合成状态，不能因为_synthDone而直接放行空播。
  const expected = sess._allSegments && sess._allSegments.find((s) => {
    const segEnd = Math.max(s.end || s.start, s.start + 0.5);
    return s.start <= t + 0.5 && segEnd >= t - 0.5;
  });
  if (!expected) { unbuffer(); hideBufferIndicator(); sess._synthMiss = 0; return false; }
  if (_currentSegReadyAt(sess, t)) { unbuffer(); hideBufferIndicator(); sess._synthMiss = 0; return false; }
  ensurePlaybackWindowFromLocalCache(sess, t, 'maybe_buffer_current_sentence_missing',
    Number(t || 0) < REALTIME_START_CRITICAL_SECONDS ? 2 : 5,
    Number(t || 0) < REALTIME_START_CRITICAL_SECONDS ? REALTIME_START_AHEAD_SECONDS : LOCAL_CACHE_TARGET_SECONDS);
  if (sess._synthDone) {
    sess._synthDone = false;
    sess._allDone = false;
    sess._phase = 'dubbing';
    console.warn('[配音插件] 已完成状态下发现当前位置缺少配音，重新进入自动补合成');
  }

  // 只认“从当前播放点连续不断”的可播队列，绝不能拿某个远处片段的最大时间
  // 冒充库存前沿。否则中间已经断粮，界面仍会误以为有库存并放行视频。
  requestRealtimeCurrentSentenceRepair(sess, expected, t);
  const frontier = getLoadedDubQueueFrontier(sess, t);
  if (frontier >= t + 0.5) { unbuffer(); hideBufferIndicator(); sess._synthMiss = 0; return false; }

  // 该句还没合成 → 先催合成
  requestSynthAround(sess, t);

  // “前五分钟重要”指优先补齐、提高重试频率，绝不等于前五分钟任意一条缺口
  // 都可以把视频暂停。旧条件只看 t < 5min：首批已经开始播放后，23 秒处遇到
  // 一条暂未装载的段也会重新进入启动闸门；视频一旦被自身暂停，t 不再变化，
  // 形成“正在补齐当前配音”的无限暂停。真正允许阻塞画面的仅是启动/归零闸门。
  const criticalStart = Number(t || 0) < REALTIME_START_CRITICAL_SECONDS
    && (sess._startupGatePending || sess._phase === 'preparing');
  if (criticalStart) {
    const releaseCriticalStartIfCacheCanCarry = (reason) => {
      const currentReady = _currentSegReadyAt(sess, t);
      const hasForwardCache = _hasForwardDubCache(sess, t, 45);
      if (!currentReady && !hasForwardCache) return false;
      if (!currentReady) rememberMissedRealtimeSegment(sess, expected, reason);
      recordDiagnostic(sess, 'critical_start_released_with_cache_available', {
        reason,
        currentReady,
        hasForwardCache,
        currentTime: +(t || 0).toFixed(3),
        missingStart: +(expected.start || 0).toFixed(3),
        maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
      });
      sess._buffering = false;
      sess._startupGatePending = false;
      sess.weArePausing = false;
      sess._bufferingSince = null;
      hideBufferIndicator();
      try { sess.video.play().catch(() => {}); } catch (_) {}
      setTimeout(() => kickDubbingAfterSeek(sess, sess.video?.currentTime || t, 8), 80);
      return true;
    };
    if (!sess._criticalStartHydrating) {
      sess._criticalStartHydrating = true;
      hydrateLocalCacheWindow(sess, t, 2, 240)
        .then((count) => {
          if (!sess.started) return;
          if (count && sess._buffering) {
            releaseCriticalStartIfCacheCanCarry('local_cache_hydrated_during_critical_start');
          }
        })
        .catch((e) => console.warn('[配音插件] 开头本地缓存回补失败', e?.message || e))
        .finally(() => { sess._criticalStartHydrating = false; });
    }
    if (!sess._buffering) {
      sess._buffering = true;
      sess._bufferingSince = Date.now();
      sess.weArePausing = true;
      if (sess.curAudio) {
        try { sess.curAudio.pause(); } catch (_) {}
        sess.curAudio = null;
        sess.curSegment = null;
      }
      try { sess.video.pause(); } catch (_) {}
      showBufferIndicator('🎧 正在补齐开头当前句配音…', sess.video);
      recordDiagnostic(sess, 'critical_start_hold_for_current_sentence', {
        currentTime: +(t || 0).toFixed(3),
        missingStart: +(expected.start || 0).toFixed(3),
        maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
      });
    } else if (Date.now() - (sess._bufferingSince || Date.now()) > 8000
        && Date.now() - (sess._lastBufferRescueAt || 0) > 3000) {
      sess._lastBufferRescueAt = Date.now();
      sess._synthInFlight?.clear();
      if (releaseCriticalStartIfCacheCanCarry('critical_start_wait_timeout_keep_video_moving')) return false;
      console.warn('[配音插件] 开头当前句等待超过8秒，释放旧批次锁并立即重试当前位置');
      requestRealtimeCurrentSentenceRepair(sess, expected, t);
      requestSynthAround(sess, t);
    }
    return true;
  }

  rememberMissedRealtimeSegment(sess, expected, 'playhead_passed_before_audio_ready');

  if (sess._buffering) {
    recordDiagnostic(sess, 'realtime_buffer_released_to_keep_video_moving', {
      currentTime: +(t || 0).toFixed(3),
      missingStart: +(expected.start || 0).toFixed(3),
      maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
    });
    unbuffer();
    return false;
  }

  // 如果当前位置这一句暂时没拿到，但前方已经有可用缓存，继续往前走。
  // 这比把整条视频暂停住更安全：缺句会继续被 requestSynthAround 补救，而录屏
  // 不会因为一个短暂缺口直接废掉。真正没有缓存可用时，下面才进入暂停等待。
  if (!sess._buffering && _hasForwardDubCache(sess, t, 45)) {
    sess._synthMiss = 0;
    if (Date.now() - (sess._lastForwardCacheSkipLogAt || 0) > 10000) {
      sess._lastForwardCacheSkipLogAt = Date.now();
      recordDiagnostic(sess, 'missing_current_sentence_but_forward_cache_available', {
        currentTime: +(t || 0).toFixed(3),
        maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
      });
      console.warn('[配音插件] 当前句未就绪，但前方已有缓存，继续播放并后台补救');
    }
    return false;
  }

  // 启动闸门放行以后，实时播放以不断流为最高优先级：当前句如果已经来不及，就静默跳过，
  // 自绘字幕也跟着隐藏；后续由 requestSynthAround/收尾补漏补回缓存，供重看或导出使用。
  sess._synthMiss = 0;
  if (Date.now() - (sess._lastNoPauseMissingLogAt || 0) > 10000) {
    sess._lastNoPauseMissingLogAt = Date.now();
    recordDiagnostic(sess, 'realtime_missing_sentence_continue_without_pause', {
      currentTime: +(t || 0).toFixed(3),
      missingStart: +(expected.start || 0).toFixed(3),
      maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
    });
    console.warn('[配音插件] 当前句未及时配音，实时播放继续，稍后补齐缓存');
  }
  if (sess._bufferingSince && Date.now() - sess._bufferingSince >= 12000) {
    if (!sess._forceConservativeDubbing) {
      sess._forceConservativeDubbing = true;
      recordDiagnostic(sess, 'buffer_wait_triggered_conservative_mode', {
        currentTime: +(t || 0).toFixed(3),
        bufferingMs: Date.now() - sess._bufferingSince,
      });
    }
  }
  return false;
}

function playNextDue(sess, t) {
  // 同步双锁：curAudio（已在播）和 _audioLoading（异步加载中）。
  // 后者关键：getAudio 是异步的，curAudio 要等 .then 才置位；快进时短时间内
  // 大量 timeupdate/seeking 会重入本函数，没有 _audioLoading 就会同时起多段 → 重叠。
  if (sess._userPaused) return;   // 配音已暂停（视频仍在放原音），不调度配音
  // 我们自己正让视频保持暂停（启动归零等首批就绪、或缓冲等待合成）——这期间
  // video.currentTime 的变动（比如 beginDubbing 归零）仍会触发 seeking/timeupdate，
  // 进而走到这里把第一段提前播完，等真正 video.play() 时这段已经标记 played=true
  // 不会再放，录屏/用户耳朵都听不到这一句。视频还没真正开始播放时，不调度任何配音。
  if (sess.weArePausing) return;
  // 用户要求：视频暂停（包括拖动进度条、把时间轴归零还没点播放）时，配音不出声。
  // 之前只靠 weArePausing 挡"我们自己造成的暂停"，但用户手动拖滑块/归零时
  // video.paused 同样是 true，weArePausing 并不会被置位，导致这里照样选段播放——
  // 等真正点击播放时这一段已经 played=true，听感上就是"第一句被吃掉"。
  // 直接以 video.paused 为准，不区分"谁"让它暂停的。
  if (sess.video && sess.video.paused) return;
  // 看门狗：_audioLoading 卡死超过 4 秒还没解锁（极端情况下 getAudio 的 promise
  // 因为某种异常没走到任何一条 resolve/reject 路径），强制解锁，避免"配音明明已经
  // 生成好了，却一直不开始播"——表现就是卡死后再也不会有声音，直到用户重新触发。
  if (sess._audioLoading) {
    if (!sess._audioLoadingSince) sess._audioLoadingSince = Date.now();
    if (Date.now() - sess._audioLoadingSince > 4000) {
      console.warn('[配音插件] _audioLoading 卡死超时，强制解锁重试');
      sess._audioLoading = false;
      sess._audioLoadingSince = null;
    } else {
      return;
    }
  } else {
    sess._audioLoadingSince = null;
  }
  if (sess.curAudio || sess._webSpeechActive) return;
  if (Array.isArray(sess.dubSegments)) {
    sess.dubSegments.sort(compareDubSegments);
    for (const seg of sess.dubSegments) {
      if (seg.played) continue;
      if (seg === sess.curSegment || seg === sess._pendingSeg) continue;
      if (!isRealtimeSegmentStale(seg, t)) break;
      skipRealtimeStaleSegment(sess, seg, t, 'play_scheduler_window_passed');
    }
  }
  let best = null;
  // 策略：优先找"包含当前时间或紧跟当前时间"的未播段
  // 1. 先找 start <= t < end 的段（当前正应播放）
  // 2. 再找 start <= t + 0.5 的段（即将播放）
  // 3. 最后找 start > t 的最近段（用户快进）
  for (const seg of sess.dubSegments) {
    if (seg.played) continue;
    // 用原字幕时间窗调度；TTS 实际时长只用于音频自身结束与变速。
    const segEnd = segmentTimelineEnd(seg);
    if (seg.start <= t && t < segEnd) {
      // 当前时间在这个段的时间窗内，优先级最高
      best = seg;
      break;
    }
    if (seg.start <= t + 0.5) {
      if (!best || seg.start > best.start) best = seg;
    }
  }
  // 注意：不再"提前抢播"远处的未来段。原视频停顿/间隙时若提前播下一句，
  // 音频会越跑越前、与视频时间线累积漂移（差距越来越大）。这里只播当前时间窗内或
  // 0.5s 内即将到的段（上面的循环已处理），其余等视频时间走到其 start 附近再播。
  // 快进场景由 _onSeeking 重新对齐：seek 后视频会很快进入目标段的 0.5s 窗内被选中。
  if (!best) {
    // 当前没有可播的段：不在这里弹任何提示。是否需要提示由 maybeBufferForSynthesis
    // 决定——只有它真正暂停视频缓冲时才显示提示（用户要求：不暂停就不提示）。
    ensurePlaybackWindowFromLocalCache(sess, t, 'play_scheduler_no_due_segment', 5, LOCAL_CACHE_TARGET_SECONDS);
    return;
  }
  // 二道防线：即使字幕解析阶段的滚动去重（dedupRollingCaptions）漏掉了某条，
  // 这里再挡一次——文字完全相同的段，直接当重复跳过（标记已播但不出声）。
  // 加了长度门槛（≥4字）：用户反馈出现过整句配音"漏读"，怀疑是这里误把"对，对""好的"这类
  // 正常语境下本来就会紧挨着重复说两次的短句/语气词当成"滚动重复"误删——短句太容易撞上
  // 真实的重复用语，只对足够长的句子做这个去重判断，短句宁可漏判重复也不要错删真实内容。
  // 之前只跟"刚念完那一句"比，用户反馈又看到"字幕忽然跳回前几条"——说明残留的重复不只
  // 紧挨着出现，隔几句也会有（滚动字幕去重在解析阶段没抓干净）。改成跟"最近几句"的
  // 历史记录比，而不是只看上一句，但仍然只在时间足够近（12秒内）才判定重复，相隔较远的
  // 真实重复台词（如歌词副歌）不受影响。
  if (sess._recentSpoken) {
    const sameEventDup = sess._recentSpoken.find((r) => {
      if (!r?.key || r.key !== _segKey(best)) return false;
      if (r.videoId && sess.videoId && r.videoId !== sess.videoId) return false;
      if (r.seekEpoch != null && sess._seekEpoch != null && r.seekEpoch !== sess._seekEpoch) return false;
      return true;
    });
    if (sameEventDup) {
      console.warn('[配音插件] 检测到同一字幕事件重复调度，跳过朗读：', best.start.toFixed(1) + 's', String(best.text || '').slice(0, 20));
      best.played = true;
      return playNextDue(sess, t);
    }
  }
  if (best.text.length >= 6 && sess._recentSpoken) {
    const dup = sess._recentSpoken.find((r) => {
      if (!r) return false;
      if (r.videoId && sess.videoId && r.videoId !== sess.videoId) return false;
      if (r.seekEpoch != null && sess._seekEpoch != null && r.seekEpoch !== sess._seekEpoch) return false;
      if (r.text !== best.text) return false;
      const gap = best.start - r.end;
      if (gap < -0.6 || gap > 4) return false;
      if ((best.start || 0) <= (r.start || 0)) return false;
      return true;
    });
    if (dup) {
      console.warn('[配音插件] 检测到近期重复段，跳过朗读：', best.start.toFixed(1) + 's', best.text.slice(0, 20));
      best.played = true;
      return playNextDue(sess, t);   // 跳过后立即看看还有没有下一句该播
    }
  }
  sess.bufferMissCount = 0;
  hideBufferIndicator();
  best.played = true;
  if (best.web_speech) {
    try {
      const utter = new SpeechSynthesisUtterance(best.translation || best.text || '');
      const voices = window.speechSynthesis?.getVoices?.() || [];
      const wanted = String(sess._autoVoice || langVoiceOverrides['zh'] || '')
        .replace(/^zh-CN-/i, '').replace(/Neural$/i, '').toLowerCase();
      const localVoice = voices.find(
        (v) => wanted && v.name.toLowerCase().includes(wanted))
        || voices.find((v) => /^zh(-|_)/i.test(v.lang || ''));
      if (localVoice) { utter.voice = localVoice; utter.lang = localVoice.lang; }
      else utter.lang = 'zh-CN';
      sess._webSpeechActive = true;
      sess.curSegment = best;
      utter.onend = () => {
        sess._webSpeechActive = false;
        if (sess.curSegment === best) sess.curSegment = null;
        rememberCompletedSpoken(sess, best);
        rememberPlayedSourceEvent(sess, best, 'web_speech');
        if (sess.started) playNextDue(sess, sess.video.currentTime);
      };
      utter.onerror = () => {
        sess._webSpeechActive = false;
        best.played = false;
        if (sess.curSegment === best) sess.curSegment = null;
        if (sess.started) playNextDue(sess, sess.video.currentTime);
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
      console.warn('[配音插件] 云端音频为空，使用默认配音员继续：',
        best.start.toFixed(1) + 's');
      return;
    } catch (e) {
      sess._webSpeechActive = false;
      best.played = false;
      console.warn('[配音插件] 默认配音员启动失败', e?.message || e);
      return;
    }
  }
  sess._audioLoading = true;
  // 记录"正在加载、还没真正开始播"的这一句——getAudio 是异步的，从标记 played=true
  // 到真正赋给 curAudio 之间有个空档，这期间如果用户暂停了视频，sess.curAudio 还是
  // null，onPause 的兜底逻辑找不到它去重置 played，这句就会永远卡在"已播"状态、
  // 续播时被跳过。用 _pendingSeg 记下来，onPause 也会检查这个并重置。
  sess._pendingSeg = best;
  const epoch = sess._seekEpoch;   // 记录本次加载所属的时间轴状态
  getAudio(sess, best).then((audio) => {
    if (sess._pendingSeg === best) sess._pendingSeg = null;
    // 纪元检查必须在解锁之前：若加载期间发生过 seek，_onSeeking 已把锁释放、
    // 新纪元可能已起新加载并重新上锁。此处属过期纪元，直接丢弃、绝不碰锁，
    // 否则会误清掉新加载的锁，导致并发起多段 → 重叠。播放会由 seek 后的
    // timeupdate 重新驱动，无需在此重选。
    if (epoch !== sess._seekEpoch) { best.played = false; return; }
    sess._audioLoading = false;
    if (!audio) {
      recoverFailedPlaybackAudio(sess, best, 'audio_loader_returned_empty', 'loadAudioOnce returned no playable Audio');
      return;
    }
    if (!sess.started) return;
    // 加载期间已有别的段抢先开播 → 放弃本段，避免两段同时响（重叠）
    if (sess.curAudio) { best.played = false; return; }
    sess.curAudio = audio;
    sess.curSegment = best;
    // 跟随音频进度逐句刷新字幕（视频放慢时 video 的 timeupdate 较稀疏，靠音频自身的更稳）
    audio.addEventListener('timeupdate', () => { if (sess.curAudio === audio) updateSubtitle(sess); });
    updateSubtitle(sess);   // 立即把字幕切到这一段，与配音同步
    audio.currentTime = 0;

    // 内容对齐：窗口 budget = 到下一句开始前的间隔。原则（用户要求）：
    //   ① 配音匀速优先：能放下就视频 1.0x、配音自然语速（绝不变速）；
    //   ② 时间窗不够 → 放慢视频把这句塞下（视频最低 MIN_VIDEO_RATE，幅度受控、不易察觉）；
    //   ③ 放慢到底仍不够 → 最后才提高配音语速补差（不变调）；
    //   ④ 这一句读完立刻把视频恢复 1.0x（见 audio.onended）。
    // 不用 best.duration（已被 estimate_durations 压缩过）。
    let nextStart = Infinity;
    for (const s of sess.dubSegments) {
      if (s.start > best.start && s.start < nextStart) nextStart = s.start;
    }
    const ttsDur = Math.max(0.05, best.tts_duration || best.duration || 0.05);
    const budget = (nextStart === Infinity) ? Infinity : Math.max(0.05, nextStart - best.start);
    let audioRate = 1.0, videoRate = 1.0;
    if (sess._readMode) {
      // 朗读模式：视频整体已经按 sess._readVideoRate 调过速（见 startDubbing），
      // 这里维持那个基准，只用语音做个别句子的小幅微调兜底，不再逐句单独猜视频速度。
      videoRate = sess._readVideoRate || 1.0;
      if (budget !== Infinity) {
        // 故意从窗口里预留一小段"气口"：下一句要等视频时间走到它自己的起点才会
        // 开播（不会因为这句提前播完就抢播），所以只要这句结束得比窗口早一点，
        // 中间自然就是停顿。之前贴着窗口边缘卡死时长，导致两句无缝衔接、很生硬。
        const realTime = Math.max(0.05, budget / videoRate - READ_BREATH_GAP);
        if (ttsDur > realTime) {
          audioRate = Math.min(READ_MAX_RATE, ttsDur / realTime);
        }
      }
    } else {
      // 配音模式：① 默认用全视频统一基准（sess._dubVideoRate，见 startDubbing），
      // 不再是每句都从 1.0x 重新猜——句间恢复到的是这个基准，不是 1.0x，避免来回跳变速。
      videoRate = sess._dubVideoRate || 1.0;
      if (budget !== Infinity) {
        const realTime = budget / videoRate;
        if (ttsDur > realTime) {
          // ② 这句在基准之上还不够 → 针对这一句再单独多放慢一点（封底 MIN_VIDEO_RATE）
          videoRate = Math.max(MIN_VIDEO_RATE, budget / ttsDur);
          const realTime2 = budget / videoRate;
          // ③ 放慢到底仍塞不下 → 才提高配音语速补差
          // 注意：之前这里没有封顶，遇到特别密的句子 audioRate 会算出很离谱的值（1.8x/2x+），
          // 听起来就是"赶"。现在封顶在 COMFORT_AUDIO_RATE（1.5x，仍清晰不变调）——
          // 极少数仍塞不下的句子宁可让它顺延占用一点下一句的时间，也不让声音听起来赶。
          if (ttsDur > realTime2 + 0.01) audioRate = Math.min(COMFORT_AUDIO_RATE, ttsDur / realTime2);
        }
      }
    }
    try { audio.preservesPitch = true; } catch (_) {}        // 提速不变调，避免"花栗鼠"音
    try { audio.mozPreservesPitch = true; } catch (_) {}
    try { audio.webkitPreservesPitch = true; } catch (_) {}
    audio.playbackRate = audioRate;
    setVideoRate(sess, videoRate);
    // 记这一段在"录音文件时间轴"上的起止点，供 exportSubtitles 用——不依赖录音
    // 是否真的成功（markPlaybackStart 总会记一个墙钟原点），录音失败也照样能导出字幕。
    if (sess._recordStartWallClock) {
      const text = (best.translation || best.text || '').trim();
      if (text) {
        if (!sess._subtitleLog) sess._subtitleLog = [];
        const activePauseMs = sess._networkPauseStartedAt
          ? Date.now() - sess._networkPauseStartedAt : 0;
        const wallStart = (
          Date.now() - sess._recordStartWallClock
          - (sess._recordPausedMs || 0) - activePauseMs) / 1000;
        sess._subtitleLog.push({ start: wallStart, end: wallStart + ttsDur / audioRate, text });
      }
    }
    // 卡死兜底用的"理应播完"时间点：这段按当前语速算，正常多久该播完（留5秒余量）。
    // 用户反馈过整段卡住没声音一分钟以上——curAudio 既没触发 ended 也没被认为 paused
    // （比如解码卡住但浏览器没报错/没结束），下面那个看门狗只查 ended/paused 抓不到
    // 这种"假装还在播、其实已经卡死"的情况，加这个超时判断兜底。
    sess._curAudioDeadline = Date.now() + (ttsDur / audioRate) * 1000 + 5000;

    audio.onended = () => {
      // 播完立即释放 Blob URL 和缓存，避免内存持续积累
      try { if (audio.src?.startsWith('blob:')) URL.revokeObjectURL(audio.src); } catch (_) {}
      delete sess.audioCache[best.audio_url];
      if (sess.curAudio === audio) { sess.curAudio = null; sess.curSegment = null; }
      sess.lastSubText = null;
      rememberCompletedSpoken(sess, best);
      // 句末恢复默认速率：配音档3慢放只作用于这一句，读完即恢复1.0x；
      // 朗读恢复到整体调过的 sess._readVideoRate，不是1.0x。
      setVideoRate(sess, defaultVideoRate(sess));
      if (sess.started) playNextDue(sess, sess.video.currentTime);
    };
    // 音频出错（解码失败/被中断）：不能只“跳过”。旧逻辑留下 played=true，
    // 使这一句永久消失，且 audio_url 仍让库存显示为领先。统一交给恢复器重试/重合成。
    audio.onerror = () => {
      console.warn('[配音插件] 音频出错，正在恢复本段', best.start.toFixed(1) + 's');
      try { if (audio.src?.startsWith('blob:')) URL.revokeObjectURL(audio.src); } catch (_) {}
      delete sess.audioCache[best.audio_url];
      if (sess.curAudio === audio) { sess.curAudio = null; sess.curSegment = null; }
      setVideoRate(sess, defaultVideoRate(sess));
      recoverFailedPlaybackAudio(sess, best, 'media_element_error', audio.error?.message || audio.error?.code || 'audio error');
    };
    audio.play().then(() => {
      // 必须等 play() 真正成功后再记“最近出声时间”。旧版 Chrome 可能先返回
      // Audio 对象、随后 play() 被 pause() 打断；若提前记时间，看门狗会误以为
      // 配音仍正常，从而让“按钮显示配音中但一直没声音”的状态持续很久。
      sess._lastDubAudioTs = Date.now();
      best._loadRetryCount = 0;
      best._playRetryCount = 0;
      rememberPlayedSourceEvent(sess, best, 'audio');
      console.log('[配音插件] ▶ 播放音频段', best.start.toFixed(1) + 's');
      // 朗读模式：第一段真正出声 → 结束"初始化"倒计时，按钮转为"朗读中"
      if (sess._readMode && !sess._reading) {
        sess._reading = true;
        if (sess._initTimer) { clearInterval(sess._initTimer); sess._initTimer = null; }
        const rb = document.getElementById('read-ext-btn');
        if (rb) { rb.textContent = '🔊朗读中'; rb.title = '点击暂停朗读'; }
      }
    }).catch((e) => {
      if (e?.name === 'AbortError') {
        // 切视频、缓冲或主动暂停会中断尚未完成的 play()。旧实现只清 curAudio，
        // 却把该句永久留在 played=true，随后整条播放队列可能静默停住。
        if (sess.curAudio === audio) { sess.curAudio = null; sess.curSegment = null; }
        best.played = false;
        setVideoRate(sess, defaultVideoRate(sess));
        if (sess.started && !sess._userPaused && !sess.video.paused) {
          console.warn('[配音插件] audio.play() 被 pause() 打断，自动恢复本句');
          showBufferIndicator('🔄 音频播放被浏览器打断，正在自动恢复…', sess.video);
          setTimeout(() => {
            if (sess.started && !sess._userPaused) {
              hideBufferIndicator();
              playNextDue(sess, sess.video.currentTime);
            }
          }, 300);
        }
        return;
      }
      // 解码/来源失败和“自动播放策略拒绝”不是同一件事。前者必须进入缓存
      // 修复链，不能沿用旧代码的“重两次就整个会话暂停”，否则长视频会在一段
      // 坏 MP3 后永久静音。只有 NotAllowedError 才需要用户手势恢复。
      console.error('[配音插件] ✗ audio.play() 被拦截/失败', e?.name, e?.message);
      if (sess.curAudio === audio) { sess.curAudio = null; sess.curSegment = null; }
      setVideoRate(sess, defaultVideoRate(sess));
      if (e?.name !== 'NotAllowedError') {
        recoverFailedPlaybackAudio(sess, best, 'audio_play_rejected', e?.message || e?.name || 'play rejected');
        return;
      }
      best.played = false;
      best._playRetryCount = (best._playRetryCount || 0) + 1;
      if (best._playRetryCount <= 2 && sess.started && !sess.video.paused) {
        showBufferIndicator(`🔄 浏览器播放音频失败，正在重试（${best._playRetryCount}/2）…`, sess.video);
        setTimeout(() => playNextDue(sess, sess.video.currentTime), 500);
      } else {
        sess._userPaused = true;
        const btn = document.getElementById(sess._readMode ? 'read-ext-btn' : 'dub-ext-btn');
        if (btn) {
          btn.textContent = '⚠️播放被阻止';
          btn.title = '点击后恢复配音';
        }
        showBufferIndicator(
          `⚠️ 浏览器阻止了配音播放（${e?.name || '播放错误'}）。请点击“播放被阻止”恢复。`,
          sess.video);
      }
    });
  }).catch((e) => {
    console.error('[配音插件] ✗ getAudio 异常', e);
    // 加载异常也要解锁并放回，否则 _audioLoading 卡死导致整段不再发声。
    // 但仅当仍属当前纪元时才解锁，避免清掉 seek 后新加载的锁。
    if (epoch === sess._seekEpoch) sess._audioLoading = false;
    recoverFailedPlaybackAudio(sess, best, 'audio_loader_exception', e?.message || String(e || ''));
  });
}

// 从字幕计算全视频的平均说话字速，换算成 edge-tts 基准速率偏移量（整数%）。
// 只统计有字幕的时间窗（不含说话人停顿），只计中文字符。
// edge-tts 基准约 4.0 CJK字/秒（+0%），偏快则正数，偏慢则负数，钳位在 -30%~+50%。
function calcBaseRatePct(segs) {
  let totalChars = 0, totalDuration = 0;
  for (const s of segs) {
    const dur = Math.max(0, s.end - s.start);
    if (dur < 0.1) continue;
    const cjk = [...(s.text || '')].filter(c => c >= '一' && c <= '鿿').length;
    totalChars += cjk;
    totalDuration += dur;
  }
  if (totalDuration < 1 || totalChars < 5) return 0;
  const charsPerSec = totalChars / totalDuration;
  const BASELINE = 4.0;  // edge-tts +0% 时约 4 字/秒
  const adj = Math.round((charsPerSec / BASELINE - 1) * 100);
  return Math.max(-30, Math.min(50, adj));
}

// ===== 服务端请求 =====
const LOCAL_DUB_DB = 'youtube-dub-audio-cache-v1';

function localDubHash(text) {
  let h = 2166136261;
  for (const ch of String(text || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function localDubKey(videoId, seg) {
  return `${videoId}|${makeSourceSegKey(seg)}|`
    + `${seg.voice || ''}|${localDubHash(seg.text || '')}`;
}

// 长视频每十几秒都会查一次本地库存。旧实现只要当前批里有一条未命中，便把该视频
// 数千条带 base64 的缓存全部 cursor 扫一遍；四小时视频越播数据库越大，扫描又和
// 合成主链串行，最终“有库存却越播越落后”。这里仅把可匹配的元数据建成会话索引，
// 真正的 base64 仍按命中的 key 从 IndexedDB 读取，既不反复全库扫描也不把音频常驻内存。
const _localDubLooseIndexes = new Map();

function makeLocalDubLooseIndex(videoId) {
  return { videoId, bySource: new Map(), byStart: new Map(), ready: false, promise: null };
}

function addLocalDubRowsToLooseIndex(videoId, rows) {
  const index = _localDubLooseIndexes.get(videoId);
  if (!index || !Array.isArray(rows)) return;
  for (const row of rows) {
    const key = String(row?.key || '');
    const value = row?.value || {};
    const voice = row?.voice || localDubRowVoice(value, key);
    if (!key || !voice || !value.audio_b64) continue;
    // 只留下匹配所需字段；不得把长视频所有 audio_b64 放进 JS 内存。
    const meta = {
      key,
      voice,
      value: {
        _sourceKey: value._sourceKey || '',
        _sourceStart: value._sourceStart ?? value.start,
        _sourceEnd: value._sourceEnd ?? value.end,
        _sourceText: value._sourceText || value.text || '',
        start: value.start,
        end: value.end,
      },
    };
    const sourceKey = meta.value._sourceKey || String(key).split('|')[1] || '';
    if (sourceKey) {
      const arr = index.bySource.get(sourceKey) || [];
      if (!arr.some((item) => item.key === key)) arr.push(meta);
      index.bySource.set(sourceKey, arr);
    }
    const startMs = Math.round(Number(meta.value._sourceStart ?? meta.value.start ?? 0) * 1000);
    const bucket = Math.round(startMs / 100);
    const byStart = index.byStart.get(bucket) || [];
    if (!byStart.some((item) => item.key === key)) byStart.push(meta);
    index.byStart.set(bucket, byStart);
  }
}

function getLocalDubLooseCandidates(index, seg) {
  if (!index || !seg) return [];
  const sourceKey = seg._sourceKey || makeSourceSegKey(seg);
  const startBucket = Math.round(Math.round(Number(seg.start || 0) * 1000) / 100);
  const seen = new Set();
  const candidates = [
    ...(index.bySource.get(sourceKey) || []),
    ...(index.byStart.get(startBucket - 1) || []),
    ...(index.byStart.get(startBucket) || []),
    ...(index.byStart.get(startBucket + 1) || []),
  ];
  return candidates.filter((item) => {
    if (!item?.key || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

async function getLocalDubLooseIndex(videoId) {
  let index = _localDubLooseIndexes.get(videoId);
  if (index?.ready) return index;
  if (index?.promise) return index.promise;
  index = index || makeLocalDubLooseIndex(videoId);
  _localDubLooseIndexes.set(videoId, index);
  index.promise = collectLocalDubRows(videoId)
    .then((rows) => {
      addLocalDubRowsToLooseIndex(videoId, rows || []);
      index.ready = true;
      return index;
    })
    .catch(() => index)
    .finally(() => { index.promise = null; });
  return index.promise;
}

function isChineseDubVoice(voice) {
  return /^zh-(CN|TW|HK)-/i.test(String(voice || ''));
}

function voiceFromLocalDubKey(key) {
  const parts = String(key || '').split('|');
  return parts.length >= 4 ? parts[2] : '';
}

function localDubRowVoice(row, key) {
  const valueVoice = row?.voice || '';
  const keyVoice = voiceFromLocalDubKey(key);
  return isChineseDubVoice(valueVoice) ? valueVoice
    : (isChineseDubVoice(keyVoice) ? keyVoice : '');
}

function normalizeLocalDubMatchText(text) {
  return normalizeCaptionCompareText(text)
    .replace(/[\[\]【】()（）<>《》]/g, '');
}

function localDubTextLooksCompatible(rowText, targetText) {
  const a = normalizeLocalDubMatchText(rowText);
  const b = normalizeLocalDubMatchText(targetText);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const minLen = Math.min(a.length, b.length);
  const maxLen = Math.max(a.length, b.length);
  if (minLen < 6 || maxLen <= 0 || minLen / maxLen < 0.72) return false;
  let samePos = 0;
  for (let i = 0; i < minLen; i++) {
    if (a[i] === b[i]) samePos++;
  }
  return samePos / minLen >= 0.78;
}

// 2026-07 的旧服务曾把“我操纵”错误清洗为“哎呀纵”。本地 IndexedDB 的 key 以
// 原字幕时间轴为准，旧音频会因此继续命中。仅对含正常“操”复合词的旧条目做一次
// 策略迁移：重新请求后会写入版本 2，以后仍正常复用缓存，不影响其它数千句库存。
const LOCAL_DUB_CENSOR_POLICY_VERSION = 2;
const NORMAL_CAO_COMPOUND_RE = /操(?:纵|作|控|盘|练|演|课|行|典|刀|琴|办|持|心|劳|守|履|切|权|业|用|觚|场)/;
const LOCAL_DUB_GLOSSARY_POLICY_VERSION = 2;
const GLOSSARY_REWRITE_SOURCE_RE = /(?:刽子手|劊子手)/;

function needsCensorPolicyRefresh(row, seg) {
  const source = String(seg?._sourceText || seg?.text || '');
  return NORMAL_CAO_COMPOUND_RE.test(source)
    && Number(row?._censorPolicyVersion || 0) < LOCAL_DUB_CENSOR_POLICY_VERSION;
}

function needsGlossaryPolicyRefresh(row, seg) {
  const source = String(seg?._sourceText || seg?.text || '');
  return GLOSSARY_REWRITE_SOURCE_RE.test(source)
    && Number(row?._glossaryPolicyVersion || 0) < LOCAL_DUB_GLOSSARY_POLICY_VERSION;
}

function needsLocalDubPolicyRefresh(row, seg) {
  return needsCensorPolicyRefresh(row, seg) || needsGlossaryPolicyRefresh(row, seg);
}

function localDubRowMatchesSegment(row, key, seg, requireAudio = true) {
  if ((!row?.audio_b64 && requireAudio) || !seg) return false;
  if (needsLocalDubPolicyRefresh(row, seg)) return false;
  const sourceKey = seg._sourceKey || makeSourceSegKey(seg);
  const rowSourceKey = String(row._sourceKey || '');
  const keySourceKey = String(key || '').split('|')[1] || '';
  if (rowSourceKey || keySourceKey) {
    // A source key is the cue identity, not merely a timestamp. Never allow a
    // former VTT mega-cue to impersonate one of the new json3 source events.
    return (rowSourceKey || keySourceKey) === sourceKey;
  }
  const targetStart = Math.round((seg?.start || 0) * 1000);
  const rowStart = Math.round((row._sourceStart ?? row.start ?? 0) * 1000);
  const sameStart = Math.abs(rowStart - targetStart) <= 150;
  if (!sameStart) return false;
  const targetText = String(seg?.text || '').trim();
  const rowText = String(row._sourceText || row.text || '').trim();
  if (localDubTextLooksCompatible(rowText, targetText)) return true;
  const targetEnd = Number(seg?._sourceEnd ?? seg?.end);
  const rowEnd = Number(row._sourceEnd ?? row.end);
  const sameEnd = Number.isFinite(targetEnd) && Number.isFinite(rowEnd)
    && Math.abs(rowEnd - targetEnd) <= 0.8;
  // Only truly legacy rows without source identities may use this timestamp
  // fallback. New rows must match the exact source event above.
  return sameEnd;
}

function mergeLocalDubRow(seg, row, key) {
  const voice = localDubRowVoice(row, key) || seg.voice || '';
  return {
    ...seg,
    ...row,
    voice,
    _sourceKey: seg._sourceKey || row._sourceKey || makeSourceSegKey(seg),
    _sourceStart: seg._sourceStart ?? row._sourceStart ?? seg.start,
    _sourceEnd: seg._sourceEnd ?? row._sourceEnd ?? seg.end,
    _sourceText: seg._sourceText || row._sourceText || seg.text,
    _sourceIndex: Number.isFinite(Number(seg._sourceIndex)) ? Number(seg._sourceIndex) : row._sourceIndex,
    audio_url: row.audio_url || seg.audio_url || `local://${seg.start}`,
    _localDubCacheHit: true,
    _persistedLocalAudio: true,
  };
}

async function collectLocalDubRows(videoId) {
  if (!videoId) return null;
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const rows = [];
    await new Promise((resolve) => {
      // 缓存库会越来越大；不能每次启动配音都全库扫描，否则“明明有缓存”
      // 也会卡在准备阶段。key 以 videoId| 开头，直接用前缀范围只扫当前视频。
      const lower = `${videoId}|`;
      const upper = `${videoId}|\uffff`;
      const range = IDBKeyRange.bound(lower, upper);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const key = String(cursor.primaryKey || '');
        const value = cursor.value || {};
        const voice = localDubRowVoice(value, key);
        if (voice && value.audio_b64) rows.push({ key, value, voice });
        cursor.continue();
      };
      req.onerror = resolve;
    });
    db.close();
    return rows;
  } catch (e) {
    console.warn('[配音插件] 扫描本地配音缓存失败', e?.message || e);
    return null;
  }
}

function buildSegmentsFromLocalDubRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const byKey = new Map();
  for (const row of rows) {
    const value = row?.value || {};
    const start = Number(value._sourceStart ?? value.start);
    if (!Number.isFinite(start)) continue;
    const endValue = Number(value._sourceEnd ?? value.end);
    const duration = Number(value.tts_duration || value.duration || 0);
    const end = Number.isFinite(endValue) && endValue > start
      ? endValue : start + Math.max(0.5, duration || 0.5);
    const text = String(value._sourceText || value.text || value.translation || '').trim();
    if (!text) continue;
    const sourceKey = value._sourceKey || String(row.key || '').split('|')[1]
      || `${Math.round(start * 1000)}:${Math.round(end * 1000)}:${localDubHash(text)}`;
    if (byKey.has(sourceKey)) continue;
    byKey.set(sourceKey, {
      start,
      end,
      text,
      _sourceKey: sourceKey,
      _sourceStart: start,
      _sourceEnd: end,
      _sourceText: text,
      _sourceIndex: Number.isFinite(Number(value._sourceIndex)) ? Number(value._sourceIndex) : byKey.size,
    });
  }
  return [...byKey.values()].sort(compareDubSegments);
}

async function inferCachedVoiceForVideo(videoId, segments = null, centerTime = 0) {
  try {
    const rows = await collectLocalDubRows(videoId);
    if (!rows?.length) return null;
    const counts = new Map();
    for (const row of rows) counts.set(row.voice, (counts.get(row.voice) || 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (Array.isArray(segments) && segments.length) {
      const from = Math.max(0, Number(centerTime || 0) - 2);
      const to = from + (from < 2 ? 10 * 60 : 8 * 60);
      const windowSegs = segments
        .filter((s) => Math.max(s.end || s.start, s.start + 0.5) >= from && s.start <= to)
        .slice(0, 260);
      const scores = new Map();
      for (const seg of windowSegs) {
        const hit = rows.find((row) => localDubRowMatchesSegment(row.value, row.key, seg));
        if (hit) scores.set(hit.voice, (scores.get(hit.voice) || 0) + 1);
      }
      if (scores.size) {
        const [voice, hitCount] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
        console.log(`[配音插件] 按当前字幕窗口命中缓存声音：${voice}（${hitCount}/${windowSegs.length || 0}句，库内${counts.get(voice) || 0}段）`);
        return voice;
      }
    }
    const [voice, count] = ranked[0];
    const total = rows.length;
    if (ranked.length > 1 && count / total < 0.8) {
      console.log(`[配音插件] 本视频存在多个配音员缓存，暂不提前锁定声音：`
        + ranked.map(([v, c]) => `${v}:${c}`).join('，'));
      return null;
    }
    console.log(`[配音插件] 本地已有配音缓存，沿用缓存声音：${voice}（${count}/${total}段）`);
    return voice;
  } catch (e) {
    console.warn('[配音插件] 扫描本地配音缓存声音失败', e?.message || e);
    return null;
  }
}

function openLocalDubDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DUB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('segments');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadLocalDubBatch(videoId, requested) {
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const values = await Promise.all(requested.map((seg) => new Promise((resolve) => {
      // 某段已经实际解码/播放失败时，不能立刻又把同一份本地 MP3 塞回来。
      // 该标记只持续到服务器补回新音频，避免长视频在同一个坏缓存上无限空转。
      if (seg?._skipLocalCache) { resolve(null); return; }
      const req = store.get(localDubKey(videoId, seg));
      req.onsuccess = () => {
        const cached = req.result || null;
        resolve(cached && !needsLocalDubPolicyRefresh(cached, seg)
          ? mergeLocalDubRow(seg, cached, localDubKey(videoId, seg)) : null);
      };
      req.onerror = () => resolve(null);
    })));
    db.close();

    const missingIndexes = values
      .map((v, i) => (v ? -1 : i))
      .filter((i) => i >= 0);
    if (!missingIndexes.length) return values;

    const looseIndex = await getLocalDubLooseIndex(videoId);
    const candidatesByIndex = new Map();
    const keysToRead = new Set();
    for (const idx of missingIndexes) {
      const seg = requested[idx];
      if (seg?._skipLocalCache) continue;
      const candidates = getLocalDubLooseCandidates(looseIndex, seg).filter((row) => {
        if (seg._strictCacheVoice && seg.voice && row.voice && row.voice !== seg.voice) return false;
        return localDubRowMatchesSegment(row.value, row.key, seg, false);
      });
      if (!candidates.length) continue;
      candidatesByIndex.set(idx, candidates);
      candidates.forEach((row) => keysToRead.add(row.key));
    }
    if (!keysToRead.size) return values;

    const readDb = await openLocalDubDB();
    const readTx = readDb.transaction('segments', 'readonly');
    const readStore = readTx.objectStore('segments');
    const rowByKey = new Map();
    await Promise.all([...keysToRead].map((key) => new Promise((resolve) => {
      const req = readStore.get(key);
      req.onsuccess = () => {
        if (req.result?.audio_b64) rowByKey.set(key, req.result);
        resolve();
      };
      req.onerror = resolve;
    })));
    readDb.close();
    for (const [idx, candidates] of candidatesByIndex) {
      const seg = requested[idx];
      const hit = candidates.find((candidate) => {
        const row = rowByKey.get(candidate.key);
        return row && localDubRowMatchesSegment(row, candidate.key, seg);
      });
      if (hit) values[idx] = mergeLocalDubRow(seg, rowByKey.get(hit.key), hit.key);
    }
    return values;
  } catch (_) {
    return requested.map(() => null);
  }
}

function setDubButtonRealtimeCacheState(btn, coverage) {
  if (!btn || !coverage || coverage.hitCount <= 0) return;
  const frontierSec = Number(coverage.frontier || 0);
  const furthestSec = Number(coverage.furthest || coverage.frontier || 0);
  const hms = formatHMS(furthestSec);
  const frontierHms = formatHMS(frontierSec);
  if (coverage.full) {
    btn.style.setProperty('background', '#16803a', 'important');
    btn.style.setProperty('border-radius', '16px', 'important');
    btn.dataset.realtimeCacheState = 'ready';
    btn.textContent = '🎧缓存 ✓';
    btn.title = `完整配音缓存已就绪，当前使用缓存配音员：${coverage.voice || '未知'}`;
    return;
  }
  if (btn.dataset.backgroundDubState === 'processing') return;
  btn.textContent = furthestSec > frontierSec + 10 ? `🎧缓存≈${hms}` : `🎧缓存→${hms}`;
  btn.title = furthestSec > frontierSec + 10
    ? `已命中本地配音缓存：连续到 ${frontierHms}，最远到 ${hms}；当前优先使用缓存配音员：${coverage.voice || '未知'}`
    : `已命中本地配音缓存到 ${hms}，当前优先使用缓存配音员：${coverage.voice || '未知'}`;
}

function clearRealtimeCacheButtonStyle(btn) {
  if (!btn || btn.dataset.backgroundDubState === 'ready' || btn.dataset.backgroundDubState === 'processing') return;
  if (btn.dataset.realtimeCacheState === 'ready') {
    btn.style.removeProperty('background');
    btn.style.removeProperty('border-radius');
    delete btn.dataset.realtimeCacheState;
  }
}

const DUB_VOICE_META = {
  'zh-CN-XiaoxiaoNeural': { name: '晓晓', gender: '女声' },
  'zh-CN-XiaoyiNeural': { name: '晓伊', gender: '女声' },
  'zh-CN-XiaohanNeural': { name: '晓涵', gender: '女声' },
  'zh-CN-XiaomoNeural': { name: '晓墨', gender: '女声' },
  'zh-CN-XiaoqiuNeural': { name: '晓秋', gender: '女声' },
  'zh-CN-XiaorouNeural': { name: '晓柔', gender: '女声' },
  'zh-CN-XiaoruiNeural': { name: '晓睿', gender: '女声' },
  'zh-CN-XiaoshuangNeural': { name: '晓双', gender: '女声' },
  'zh-CN-XiaoxuanNeural': { name: '晓萱', gender: '女声' },
  'zh-CN-XiaoyanNeural': { name: '晓颜', gender: '女声' },
  'zh-CN-XiaoyouNeural': { name: '晓悠', gender: '女声' },
  'zh-CN-XiaozhenNeural': { name: '晓甄', gender: '女声' },
  'zh-CN-YunxiNeural': { name: '云希', gender: '男声' },
  'zh-CN-YunxiaNeural': { name: '云夏', gender: '男声' },
  'zh-CN-YunjianNeural': { name: '云健', gender: '男声' },
  'zh-CN-YunyangNeural': { name: '云扬', gender: '男声' },
  'zh-TW-HsiaoChenNeural': { name: '曉臻', gender: '女声' },
  'zh-TW-HsiaoYuNeural': { name: '曉雨', gender: '女声' },
  'zh-TW-YunJheNeural': { name: '雲哲', gender: '男声' },
  'zh-HK-HiuGaaiNeural': { name: '曉佳', gender: '女声' },
  'zh-HK-HiuMaanNeural': { name: '曉曼', gender: '女声' },
  'zh-HK-WanLungNeural': { name: '雲龍', gender: '男声' },
};

function dubVoiceMeta(voice) {
  const known = DUB_VOICE_META[voice];
  if (known) return known;
  const raw = String(voice || '');
  const name = raw.replace(/^zh-[A-Z]{2}-/i, '').replace(/Neural$/i, '') || '未知配音员';
  let gender = '未知';
  if (/xia|hsiao|hiu/i.test(raw)) gender = '女声';
  if (/yun|jhe|lung|jian|yang/i.test(raw)) gender = '男声';
  return { name, gender };
}

function formatDubCacheVoiceChoice(choice, index) {
  const meta = dubVoiceMeta(choice.voice);
  const n = ['一', '二', '三', '四', '五', '六'][index] || String(index + 1);
  const count = Number(choice.count || 0);
  const total = Number(choice.total || 0);
  const frontierSec = Number(choice.frontier || 0);
  const furthestSec = Number(choice.furthest || choice.frontier || 0);
  const frontier = formatHMS(frontierSec);
  const furthest = formatHMS(furthestSec);
  const full = choice.full ? '完整缓存'
    : (furthestSec > frontierSec + 10 ? `连续到 ${frontier}，最远到 ${furthest}` : `连续到 ${frontier}`);
  return `配音员${n}：${meta.name}（${meta.gender}，${count}/${total}句，${full}）`;
}

function selectDubCoverageVoice(coverage, voice) {
  const ranked = Array.isArray(coverage?.rankedVoices) ? coverage.rankedVoices : [];
  const selected = ranked.find((item) => item.voice === voice) || ranked[0];
  if (!selected) return coverage;
  return {
    ...coverage,
    voice: selected.voice,
    hitCount: selected.count,
    frontier: selected.frontier,
    furthest: selected.furthest,
    firstGapStart: selected.firstGapStart,
    full: !!selected.full,
  };
}

function purgeNonSelectedVoiceSegments(sess, voice) {
  if (!sess || !voice || !Array.isArray(sess.dubSegments)) return 0;
  let removed = 0;
  sess.dubSegments = sess.dubSegments.filter((seg) => {
    const segVoice = seg?.voice || '';
    if (!isChineseDubVoice(segVoice) || segVoice === voice) return true;
    if (seg.audio_url) {
      try {
        const audio = sess.audioCache?.[seg.audio_url];
        if (audio?.src?.startsWith('blob:')) URL.revokeObjectURL(audio.src);
      } catch (_) {}
      if (sess.audioCache) delete sess.audioCache[seg.audio_url];
    }
    if (sess.curSegment === seg) {
      try { sess.curAudio?.pause?.(); } catch (_) {}
      sess.curAudio = null;
      sess.curSegment = null;
      sess._audioLoading = false;
    }
    removed++;
    return false;
  });
  if (removed) {
    console.warn(`[配音插件] 已清除非选定配音员缓存片段：${removed} 段，保留 ${voice}`);
  }
  return removed;
}

function showDubCacheVoiceDialog(choices) {
  return new Promise((resolve) => {
    const old = document.getElementById('yt-dub-cache-voice-dialog');
    if (old) old.remove();
    const panel = document.createElement('div');
    panel.id = 'yt-dub-cache-voice-dialog';
    panel.style.cssText = [
      'position:fixed',
      'right:18px',
      'bottom:18px',
      'z-index:2147483647',
      'width:min(390px,calc(100vw - 36px))',
      'background:#111827',
      'color:#fff',
      'font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'border:1px solid rgba(255,255,255,.18)',
      'border-radius:14px',
      'box-shadow:0 12px 36px rgba(0,0,0,.35)',
      'padding:14px',
    ].join(';');
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px';
    const title = document.createElement('div');
    title.textContent = '本视频有多个配音缓存，请选择声音';
    title.style.cssText = 'font-weight:700;font-size:15px';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '关闭并按随机处理';
    close.style.cssText = 'border:0;background:transparent;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px';
    top.append(title, close);

    const hint = document.createElement('div');
    const topChoice = choices[0];
    const topMeta = dubVoiceMeta(topChoice.voice);
    hint.textContent = `选择后立即开始；“随机”会使用缓存最多的配音员：${topMeta.name}（${topMeta.gender}）。`;
    hint.style.cssText = 'opacity:.82;margin-bottom:10px';

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const rememberWrap = document.createElement('label');
    rememberWrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;cursor:pointer;user-select:none';
    const remember = document.createElement('input');
    remember.type = 'checkbox';
    const rememberText = document.createElement('span');
    rememberText.textContent = '今后无需再问（默认随机/缓存最多）';
    rememberWrap.append(remember, rememberText);

    const finish = (voice) => {
      if (remember.checked) {
        dubCacheVoiceAutoPick = true;
        try { chrome.storage.local.set({ dubCacheVoiceAutoPick: true }); } catch (_) {}
      }
      panel.remove();
      resolve(voice || choices[0].voice);
    };

    const addButton = (label, voice, accent = false) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        'text-align:left',
        'border:1px solid rgba(255,255,255,.18)',
        `background:${accent ? '#db2777' : 'rgba(255,255,255,.08)'}`,
        'color:#fff',
        'border-radius:10px',
        'padding:9px 10px',
        'cursor:pointer',
        'font:inherit',
      ].join(';');
      btn.addEventListener('click', () => finish(voice));
      list.appendChild(btn);
    };

    addButton(`随机（使用缓存最多：${topMeta.name} / ${topMeta.gender} / ${topChoice.count}句）`, topChoice.voice, true);
    choices.forEach((choice, index) => addButton(formatDubCacheVoiceChoice(choice, index), choice.voice));
    close.addEventListener('click', () => finish(choices[0].voice));
    panel.append(top, hint, list, rememberWrap);
    const anchor = document.querySelector('#player') || document.querySelector('#movie_player')?.parentElement;
    if (anchor?.parentElement) {
      panel.style.position = 'relative';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.width = 'min(390px, 100%)';
      panel.style.margin = '10px 0';
      anchor.insertAdjacentElement('afterend', panel);
    } else {
      document.documentElement.appendChild(panel);
    }
  });
}

async function chooseDubCacheCoverageVoice(coverage) {
  const ranked = (coverage?.rankedVoices || []).filter((item) => item.voice && item.count > 0);
  if (ranked.length <= 1) return coverage;
  if (dubCacheVoiceAutoPick) {
    return selectDubCoverageVoice(coverage, ranked[0].voice);
  }
  const pickedVoice = await showDubCacheVoiceDialog(ranked);
  return selectDubCoverageVoice(coverage, pickedVoice);
}

async function assessLocalDubCoverage(videoId, segments, centerTime = 0) {
  const rows = await collectLocalDubRows(videoId);
  if (!rows?.length || !segments?.length) {
    return { full: false, hitCount: 0, total: segments?.length || 0, frontier: 0, furthest: 0, voice: '', rankedVoices: [] };
  }
  // 覆盖扫描本身已经读过当前视频全部缓存；顺手把“只含匹配元数据”的索引建好，
  // 后面运行中的每个小批次就不必重新 cursor 扫描整部四小时视频。
  let looseIndex = _localDubLooseIndexes.get(videoId);
  if (!looseIndex) {
    looseIndex = makeLocalDubLooseIndex(videoId);
    _localDubLooseIndexes.set(videoId, looseIndex);
  }
  addLocalDubRowsToLooseIndex(videoId, rows);
  looseIndex.ready = true;
  const rowsBySource = new Map();
  const rowsByStart = new Map();
  for (const row of rows) {
    const value = row.value || {};
    const sourceKey = value._sourceKey || String(row.key || '').split('|')[1] || '';
    if (sourceKey) {
      if (!rowsBySource.has(sourceKey)) rowsBySource.set(sourceKey, []);
      rowsBySource.get(sourceKey).push(row);
    }
    const startMs = Math.round(Number(value._sourceStart ?? value.start ?? 0) * 1000);
    const startBucket = Math.round(startMs / 100);
    if (!rowsByStart.has(startBucket)) rowsByStart.set(startBucket, []);
    rowsByStart.get(startBucket).push(row);
  }

  const sorted = segments.slice().sort(compareDubSegments);
  const hitsByVoice = new Map();
  for (const seg of sorted) {
    const sourceKey = makeSourceSegKey(seg);
    const startMs = Math.round(Number(seg.start || 0) * 1000);
    const startBucket = Math.round(startMs / 100);
    const candidates = [
      ...(rowsBySource.get(sourceKey) || []),
      ...(rowsByStart.get(startBucket - 1) || []),
      ...(rowsByStart.get(startBucket) || []),
      ...(rowsByStart.get(startBucket + 1) || []),
    ];
    const seen = new Set();
    for (const hit of candidates) {
      if (seen.has(hit.key)) continue;
      seen.add(hit.key);
      if (!localDubRowMatchesSegment(hit.value, hit.key, seg)) continue;
      const voice = hit.voice || localDubRowVoice(hit.value, hit.key);
      if (!voice) continue;
      if (!hitsByVoice.has(voice)) hitsByVoice.set(voice, new Set());
      hitsByVoice.get(voice).add(sourceKey);
    }
  }
  const total = sorted.length;
  const rankedVoices = [...hitsByVoice.entries()].map(([voice, hitKeys]) => {
    let frontier = Math.max(0, Number(centerTime || 0));
    let furthest = 0;
    let firstGapStart = null;
    for (const seg of sorted) {
      if (!hitKeys.has(makeSourceSegKey(seg))) continue;
      furthest = Math.max(furthest, Number(seg.end || seg.start || 0));
    }
    for (const seg of sorted.filter((s) => Math.max(s.end || s.start, s.start + 0.5) >= frontier - 0.5)) {
      if (!hitKeys.has(makeSourceSegKey(seg))) {
        firstGapStart = Number(seg.start || 0);
        break;
      }
      frontier = Math.max(frontier, Number(seg.end || seg.start || 0));
    }
    return {
      voice,
      count: hitKeys.size,
      total,
      frontier,
      furthest,
      firstGapStart,
      full: hitKeys.size === total && sorted.every((seg) => hitKeys.has(makeSourceSegKey(seg))),
    };
  }).sort((a, b) => (b.count - a.count) || (b.furthest - a.furthest) || (b.frontier - a.frontier) || String(a.voice).localeCompare(String(b.voice)));
  const best = rankedVoices[0];
  if (!best) return { full: false, hitCount: 0, total, frontier: 0, furthest: 0, voice: '', rankedVoices: [] };
  return {
    full: !!best.full,
    hitCount: best.count,
    total,
    frontier: best.frontier,
    furthest: best.furthest,
    firstGapStart: best.firstGapStart,
    voice: best.voice,
    rankedVoices,
  };
}

async function primeLocalDubCoverageForSession(sess, videoId, segments, centerTime) {
  try {
    let coverage = await assessLocalDubCoverage(videoId, segments, centerTime);
    const forcedVoice = isChineseDubVoice(sess?._forcedDubVoice) ? sess._forcedDubVoice : null;
    if (forcedVoice) {
      const forcedHit = coverage?.rankedVoices?.find((item) => item.voice === forcedVoice);
      coverage = forcedHit
        ? selectDubCoverageVoice(coverage, forcedVoice)
        : {
            ...(coverage || {}),
            full: false,
            hitCount: 0,
            total: segments?.length || coverage?.total || 0,
            frontier: Math.max(0, Number(centerTime || 0)),
            furthest: 0,
            voice: forcedVoice,
            rankedVoices: coverage?.rankedVoices || [],
          };
      console.log(`[配音插件] 按用户指定声音启动：${forcedVoice}（${forcedHit ? '命中同声缓存' : '无同声缓存，将按此声音补生成'}）`);
    } else if (coverage?.rankedVoices?.length > 1 && sess.started && sess.videoId === videoId) {
      // 多个缓存声音时，用户选择必须发生在第一批请求之前；否则开头已经按
      // “缓存最多/默认声音”排队，后面再切换就会出现“我选了A却先用了B”。
      coverage = await chooseDubCacheCoverageVoice(coverage);
      if (coverage?.voice) {
        console.log(`[配音插件] 已锁定本轮缓存配音员：${coverage.voice}（${coverage.hitCount}/${coverage.total}句）`);
      }
    }
    if (!sess.started || sess.videoId !== videoId) return coverage;
    sess._localDubCoverage = coverage;
    if (coverage.voice) {
      sess._cachedVoice = coverage.voice;
      sess._autoVoice = coverage.voice;
      purgeNonSelectedVoiceSegments(sess, coverage.voice);
      const far = Number(coverage.furthest || coverage.frontier || 0);
      console.log(`[配音插件] 本视频缓存扫描：${coverage.hitCount}/${coverage.total} 段，优先沿用 ${coverage.voice}，连续缓存到 ${formatHMS(coverage.frontier)}，最远命中到 ${formatHMS(far)}`);
      if (far > Number(coverage.frontier || 0) + 60) {
        console.warn(`[配音插件] 缓存前沿被早期缺口卡住：连续到 ${formatHMS(coverage.frontier)}，但后面仍有缓存到 ${formatHMS(far)}，会继续沿用已命中的后续缓存并补缺口。`);
      }
    }
    if (coverage.full) sess._knownFullLocalCache = true;
    setDubButtonRealtimeCacheState(sess._dubButton, coverage);
    return coverage;
  } catch (e) {
    console.warn('[配音插件] 本视频缓存覆盖扫描失败，不影响实时配音', e?.message || e);
    return null;
  }
}

async function saveLocalDubBatch(videoId, requested, returned) {
  if (!returned?.length) return 0;
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readwrite');
    const store = tx.objectStore('segments');
    const byKey = new Map(requested.map(
      (s) => [s._sourceKey || makeSourceSegKey(s), s]));
    const byStart = new Map(requested.map(
      (s) => [Math.round((s.start || 0) * 1000), s]));
    const savedRows = [];
    const persistedItems = [];
    for (const item of returned) {
      if (!item?.audio_b64) continue;
      const source = byKey.get(item._sourceKey || '') || byStart.get(Math.round((item.start || 0) * 1000));
      if (!source) continue;
      const saved = {
          ...item,
          voice: source.voice || item.voice || '',
          _censorPolicyVersion: LOCAL_DUB_CENSOR_POLICY_VERSION,
          _glossaryPolicyVersion: LOCAL_DUB_GLOSSARY_POLICY_VERSION,
          _sourceKey: source._sourceKey || makeSourceSegKey(source),
          _sourceStart: source.start,
          _sourceEnd: source.end,
          _sourceText: source._sourceText || source.text,
          _sourceIndex: Number.isFinite(Number(source._sourceIndex)) ? Number(source._sourceIndex) : null,
          audio_url: item.audio_url || `local://${videoId}/${item.start}`,
        };
      const key = localDubKey(videoId, source);
      store.put(saved, key);
      savedRows.push({ key, value: saved, voice: saved.voice });
      persistedItems.push(item);
    }
    const committed = await new Promise((resolve) => {
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
    db.close();
    if (!committed) throw new Error('IndexedDB 写入事务未完成');
    // 只有事务真正提交后，才允许页面端删除 Base64 内存副本。
    persistedItems.forEach((item) => { item._persistedLocalAudio = true; });
    // 若本会话已建立索引，立即增量写入；后续批次不会重新扫完整视频缓存。
    addLocalDubRowsToLooseIndex(videoId, savedRows);
    return savedRows.length;
  } catch (e) {
    console.warn('[配音插件] 写入本地音频缓存失败', e?.message || e);
    return 0;
  }
}

// 合成结果已安全落盘后，远处片段的 Base64 再留在 content script 没有价值：
// 四小时视频有数千段，旧逻辑把它们全部挂在 dubSegments 上，浏览器后段会因内存
// 压力而无法解码/加载音频。仅保留当前点后两分钟的热窗口，其余按需从 IndexedDB 读回。
const IN_MEMORY_AUDIO_PAYLOAD_AHEAD_SECONDS = 120;
function trimPersistedFutureAudioPayloads(sess, t, reason = 'periodic') {
  if (!sess?.dubSegments?.length) return 0;
  const now = Number(t == null ? sess.video?.currentTime || 0 : t || 0);
  if (Date.now() - (sess._lastPayloadTrimAt || 0) < 8000) return 0;
  sess._lastPayloadTrimAt = Date.now();
  const keepThrough = now + IN_MEMORY_AUDIO_PAYLOAD_AHEAD_SECONDS;
  let released = 0;
  let chars = 0;
  for (const seg of sess.dubSegments) {
    if (!seg?._persistedLocalAudio || !seg.audio_b64 || seg.start <= keepThrough) continue;
    chars += String(seg.audio_b64).length;
    delete seg.audio_b64;
    released++;
  }
  if (released) {
    recordDiagnostic(sess, 'persisted_future_audio_payloads_released', {
      released, approxBytes: Math.round(chars * 0.75), keepThrough: +keepThrough.toFixed(3), reason,
    });
    console.log(`[配音插件] 已释放 ${released} 段远期音频内存（约 ${(chars * 0.75 / 1048576).toFixed(1)} MB）`);
  }
  return released;
}

function markReturnedAudioPersisted(sess, returned, t) {
  if (!sess?.dubSegments?.length || !Array.isArray(returned) || !returned.length) return;
  const keys = new Set(returned.filter((item) => item?._persistedLocalAudio).map(_segKey));
  if (!keys.size) return;
  for (const seg of sess.dubSegments) {
    if (keys.has(_segKey(seg))) seg._persistedLocalAudio = true;
  }
  trimPersistedFutureAudioPayloads(sess, t, 'batch_saved');
}

async function hydrateLocalCacheWindow(sess, centerTime, beforeSec = 12, afterSec = 240) {
  if (!sess?.started || !sess?.videoId || !Array.isArray(sess._allSegments)) return 0;
  const from = Math.max(0, Number(centerTime || 0) - beforeSec);
  const to = Number(centerTime || 0) + afterSec;
  const candidates = sess._allSegments
    .filter((s) => {
      const end = Math.max(s.end || s.start, s.start + 0.5);
      return end >= from && s.start <= to;
    })
    .slice(0, centerTime < 2 ? 520 : 320);
  if (!candidates.length) return 0;
  const requested = applySessionVoice(sess, candidates);
  const cached = await loadLocalDubBatch(sess.videoId, requested);
  if (!sess.started || !cached?.length) return 0;
  const hydratedVoice = cached.find((item) => isChineseDubVoice(item?.voice))?.voice || null;
  if (hydratedVoice && !sess._cachedVoice) {
    sess._cachedVoice = hydratedVoice;
    sess._autoVoice = hydratedVoice;
    console.log(`[配音插件] 从本地缓存窗口恢复配音员：${hydratedVoice}`);
  }
  const map = new Map((sess.dubSegments || []).map((s) => [_segKey(s), s]));
  let count = 0;
  let frontier = sess._maxSynthedTime || 0;
  for (let i = 0; i < cached.length; i++) {
    const item = cached[i];
    if (!item?.audio_b64) continue;
    const seg = { ...requested[i], ...item };
    seg.played = initialPlayedStateForInsertedSegment(sess, seg, centerTime);
    const key = _segKey(seg);
    const existing = map.get(key);
    if (existing) {
      Object.assign(existing, seg);
      delete existing._skippedStale;
    }
    else {
      sess.dubSegments.push(seg);
      map.set(key, seg);
    }
    frontier = Math.max(frontier, segmentTimelineEnd(seg));
    count++;
  }
  if (count) {
    sess.dubSegments.sort(compareDubSegments);
    sess._maxSynthedTime = Math.max(sess._maxSynthedTime || 0, frontier);
    primeStartupAudio(sess, centerTime);
    if (sess._onChunkProgress) sess._onChunkProgress(sess._maxSynthedTime);
  }
  return count;
}

async function clearLocalDubVideo(videoId) {
  _localDubLooseIndexes.delete(videoId);
  try {
    const db = await openLocalDubDB();
    const tx = db.transaction('segments', 'readwrite');
    const store = tx.objectStore('segments');
    await new Promise((resolve) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        if (String(cursor.key || '').startsWith(`${videoId}|`)) cursor.delete();
        cursor.continue();
      };
      req.onerror = resolve;
    });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = resolve;
      tx.onabort = resolve;
    });
    db.close();
  } catch (e) {
    console.warn('[配音插件] 清除本地音频缓存失败', e?.message || e);
  }
  try {
    await new Promise((resolve) => chrome.storage.local.remove(
      [`subs_v4_${videoId}`, `subs_${videoId}`], resolve));
  } catch (_) {}
  try {
    await fetch(`${SERVER}/clear_cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
    });
  } catch (e) {
    console.warn('[配音插件] 清除服务器配音缓存失败', e?.message || e);
  }
}

async function sendChunkToServer(server, videoId, title, segments, baseRatePct, readMode, lang, allowGemini, onProgress) {
  const requestId = allowGemini
    ? `${videoId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` : '';
  const requestSegments = segments || [];
  const sourceByKey = new Map(requestSegments.map((s) => [s._sourceKey || makeSourceSegKey(s), s]));
  const sourceByStart = new Map();
  for (const s of requestSegments) {
    const k = Math.round((s.start || 0) * 1000);
    if (!sourceByStart.has(k)) sourceByStart.set(k, []);
    sourceByStart.get(k).push(s);
  }
  const attachSourceMetadata = (s, i = 0) => {
    if (!s) return;
    const byStart = sourceByStart.get(Math.round((s?.start || 0) * 1000)) || [];
    const source = sourceByKey.get(s._sourceKey || '')
      || requestSegments[i]
      || byStart[sourceOrderOf(s)]
      || byStart[0];
    if (!source) return;
    s._sourceKey = source._sourceKey || makeSourceSegKey(source);
    s._sourceStart = source.start;
    s._sourceEnd = source.end;
    s._sourceText = source._sourceText || source.text;
    s._sourceIndex = Number.isFinite(Number(source._sourceIndex)) ? Number(source._sourceIndex) : i;
  };
  let progressTimer = null;
  const seenProgress = new Set();
  if (allowGemini && onProgress) {
    const poll = () => {
      chrome.runtime.sendMessage({
        type: 'fetch', url: `${server}/gemini_progress/${requestId}`,
        options: { method: 'GET' },
      }, (r) => {
        const items = r?.data?.items || [];
        const fresh = items.filter((x, i) => {
          attachSourceMetadata(x, i);
          const k = x._sourceKey || `${Math.round(x.start * 1000)}:${sourceOrderOf(x)}:${localDubHash(x.text || x.translation || '')}`;
          if (seenProgress.has(k)) return false;
          seenProgress.add(k);
          return true;
        });
        if (fresh.length) onProgress(fresh.sort(compareDubSegments));
      });
    };
    progressTimer = setInterval(poll, 500);
  }
  return new Promise((resolve, reject) => {
    // Gemini翻译模式现在一批发送的段数远大于普通模式（见 CHUNK_SIZES），服务器那边
    // 流式翻译+边译边合成一大批要的时间也更长，150s 对这个模式太紧，放宽到5分钟。
    // 普通中文字幕模式有本机中文语音兜底，不应为一个卡住的云端请求等150秒；
    // Gemini翻译没有安全的原文兜底，仍保留较长等待。
    const timeoutMs = allowGemini ? 300000 : 45000;
    const timer = setTimeout(() => {
      if (progressTimer) clearInterval(progressTimer);
      reject(new Error(`配音请求超时(${timeoutMs / 1000}s)`));
    }, timeoutMs);
    let sent = false;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'fetch',
          url: `${server}/dub`,
          options: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              video_id: videoId, title, segments, base_rate_pct: baseRatePct || 0,
              read_mode: !!readMode, lang: lang || 'zh-CN',
              use_gemini_translate: allowGemini,
              client_id: _clientId, request_id: requestId,
            }),
          },
        },
        (resp) => {
          if (progressTimer) clearInterval(progressTimer);
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message || '';
            if (msg.includes('invalidated') || msg.includes('disconnected')) {
              return reject(new Error('扩展已重新加载，请刷新页面后重试'));
            }
            return reject(new Error(msg));
          }
          if (!resp?.ok) return reject(new Error(resp?.error || '后端请求失败'));
          const segs = resp.data?.segments || [];
          if (segments?.length && !segs.length) return reject(new Error('后端未返回配音段'));
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            attachSourceMetadata(s, i);
            if (s && s.audio_url && !/^blob:|^https?:\/\//i.test(s.audio_url)) s._dubServer = server;
          }
          segs.sort(compareDubSegments);
          // 翻译失败的句子数（Gemini模式才会有），挂在数组对象上当副信息带出去——
          // 不改变 segs 本身还是个普通数组这一点，调用方原有的 for/.length 用法不用改，
          // 想要失败信息的调用方（目前只有 runStream）多读一下这个属性就行。
          segs.translateFailedStarts = resp.data?.translate_failed_starts || [];
          resolve(segs);
        }
      );
      sent = true;
    } catch (e) {
      if (progressTimer) clearInterval(progressTimer);
      clearTimeout(timer);
      if (!sent) reject(new Error('扩展已重新加载，请刷新页面后重试'));
    }
  });
}

async function sendChunk(videoId, title, segments, baseRatePct, readMode, lang, useGemini, onProgress) {
  // 朗读模式：走云端 TTS，不碰本机服务器，下面这条 /dub 请求路径只服务配音模式。
  if (readMode) {
    return sendChunkReadAloudCloud(segments, lang);
  }
  // 费用硬开关：调用方即使因为旧session状态或备用路径误传了true，只要用户当前
  // 没有勾选“Gemini翻译”，这里就强制关掉，绝不把Gemini标志发给服务器。
  const allowGemini = !!useGemini && !!useGeminiTranslate;
  let lastErr = null;
  const candidates = getDubServerCandidates();
  for (let i = 0; i < candidates.length; i++) {
    const server = candidates[i];
    try {
      const segs = await sendChunkToServer(server, videoId, title, segments, baseRatePct,
        readMode, lang, allowGemini, onProgress);
      if (i > 0) console.warn('[配音插件] 主配音服务器失败后已切换备用服务器', server);
      return segs;
    } catch (e) {
      lastErr = e;
      console.warn('[配音插件] 配音服务器未拿到有效音频，尝试下一个', server, e?.message || e);
    }
  }
  throw lastErr || new Error('所有配音服务器均未返回有效音频');
}

// 健康检查必须走扩展后台，和 /dub 使用完全相同的网络路径。直接在 YouTube 页面
// fetch 云端 /health 会受到 CORS / Mixed Content / 页面安全策略影响，容易把
// “页面不能跨域访问”误判成“网络或配音服务器断开”。
async function probeDubServiceHealth(timeoutMs = 10000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(!!ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      chrome.runtime.sendMessage({
        type: 'fetch',
        url: `${SERVER}/health`,
        options: { method: 'GET', cache: 'no-store' },
      }, (resp) => {
        if (chrome.runtime.lastError) return finish(false);
        finish(!!resp?.ok);
      });
    } catch (_) {
      finish(false);
    }
  });
}

// 网络断开或云端短暂重启时，不丢弃当前批次。先在不暂停视频的情况下确认：
// 短暂请求抖动、单个大批次超时或页面跨域问题都不能直接暂停。只有连续三次
// 后台健康检查失败也不暂停已经开始的实时视频；恢复仍需连续两次成功，避免闪断。
async function waitForDubServiceRecovery(sess, videoId, lastError) {
  const errText = String(lastError || '');
  if (/扩展已重新加载|刷新页面后重试|Extension context invalidated|context invalidated|disconnected/i.test(errText)) {
    console.warn('[配音插件] 扩展上下文已失效，当前页面必须刷新后才能继续通信:', errText);
    notifyExtensionContextInvalidated(sess);
    return false;
  }
  showBufferIndicator(
    `🌐 配音请求暂时失败，正在确认服务状态…${lastError ? `（${lastError}）` : ''}`,
    sess.video);
  let confirmFailures = 0;
  for (let i = 0; i < 3 && sess.started && sess.videoId === videoId; i++) {
    const healthy = await probeDubServiceHealth(10000);
    if (healthy) {
      hideBufferIndicator();
      console.log('[配音插件] 健康检查正常：判定为单次请求抖动，不暂停视频，重发当前批次');
      return true;
    }
    confirmFailures++;
    if (i < 2) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (confirmFailures < 3 || !sess.started || sess.videoId !== videoId) return false;

  if (_hasForwardDubCache(sess, sess.video?.currentTime || 0, 90)) {
    recordDiagnostic(sess, 'network_failure_ignored_because_forward_cache_exists', {
      error: lastError || '',
      currentTime: +(sess.video?.currentTime || 0).toFixed(3),
      maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
    });
    hideBufferIndicator();
    console.warn('[配音插件] 服务短暂不可用，但前方已有配音缓存，不暂停视频');
    return true;
  }

  // 实时配音的首要原则是不因网络问题反向卡住视频。缺少的句子会在恢复后
  // 重发当前批次，并由看门狗补齐；只有用户在开头主动等待时才允许另行暂停。
  recordDiagnostic(sess, 'network_recovery_keeps_video_running', {
    error: lastError || '', currentTime: +(sess.video?.currentTime || 0).toFixed(3),
  });
  let consecutive = 0;
  let attempt = 0;
  showBufferIndicator(
    `🌐 网络或配音服务暂时不可用，保留当前进度并等待恢复…${lastError ? `（${lastError}）` : ''}`,
    sess.video);
  while (sess.started && sess.videoId === videoId) {
    const delay = Math.min(30000, 3000 * Math.pow(1.6, attempt++));
    await new Promise((resolve) => setTimeout(resolve, delay));
    const healthy = await probeDubServiceHealth(10000);
    if (healthy) {
      consecutive++;
      showBufferIndicator(`🌐 连接正在恢复，确认中（${consecutive}/2）…`, sess.video);
      if (consecutive >= 2) {
        if (!sess._buffering) hideBufferIndicator();
        console.log('[配音插件] 网络/服务已恢复，从中断批次继续');
        return true;
      }
    } else {
      consecutive = 0;
    }
  }
  return false;
}

async function setTabRecorderPaused(paused) {
  try {
    return await chrome.runtime.sendMessage({
      type: 'setTabRecordingPaused', paused: !!paused,
    });
  } catch (e) {
    console.warn('[配音插件] 录制器暂停/恢复消息失败', e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

async function pauseForNetworkRecovery(sess) {
  if (sess._networkRecoveryPaused) return;
  const deadline = Date.now() + 30000;
  while (sess.started && sess.curAudio && !sess.curAudio.ended && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!sess.started) return;
  sess._networkShouldResumeVideo = !sess.video.paused || !!sess._buffering
    || sess._resumeAfterStart !== false;
  try { sess.video.pause(); } catch (_) {}
  if (sess.curAudio) { try { sess.curAudio.pause(); } catch (_) {} }
  sess.weArePausing = true;
  sess._networkRecoveryPaused = true;
  sess._networkPauseStartedAt = Date.now();
  const rec = await setTabRecorderPaused(true);
  console.log('[配音插件] 网络恢复等待：视频、配音已暂停',
    rec?.ok ? '录制器已暂停' : '未运行录制器');
}

async function resumeAfterNetworkRecovery(sess) {
  if (!sess._networkRecoveryPaused) return;
  const pausedMs = Date.now() - (sess._networkPauseStartedAt || Date.now());
  sess._recordPausedMs = (sess._recordPausedMs || 0) + pausedMs;
  sess._networkPauseStartedAt = null;
  await setTabRecorderPaused(false);
  sess._networkRecoveryPaused = false;
  sess.weArePausing = false;
  if (sess._buffering && getLoadedDubQueueFrontier(sess, sess.video.currentTime) > sess.video.currentTime + 0.25) {
    sess._buffering = false;
  }
  const shouldResume = sess._networkShouldResumeVideo;
  sess._networkShouldResumeVideo = false;
  if (shouldResume && sess.started && !sess._startupGatePending) {
    try { await sess.video.play(); } catch (_) {}
  }
  hideBufferIndicator();
  console.log(`[配音插件] 配音批次已恢复，视频和录制继续；扣除暂停 ${(pausedMs / 1000).toFixed(1)} 秒`);
}

// ===== 双向分块流式配音（通用，任何平台）=====
async function processDubbingChunked(rawSegments, videoId, title, sess, fail, onFirstChunkReady) {
  const video = sess.video;
  const t0 = video.currentTime;
  const ordered = rawSegments.slice().sort(compareDubSegments);
  const upcoming = ordered.filter((s) => s.end >= t0 - 1);
  const pastAll = ordered.filter((s) => s.end < t0 - 1);
  const head = pastAll.slice(0, Math.min(6, pastAll.length));
  const rest = pastAll.slice(head.length).reverse();
  const past = [...head, ...rest];

  // Gemini翻译模式：服务器现在是整批一次性发给Gemini（带术语参考，流式消费、边译边
  // 合成），不再是"发一句翻一句"，所以没必要像旧版那样切成2/6/10这种小碎片——小碎片
  // 反而意味着每碎片都要重新发一次请求、重新判断一次相关术语，效率更低。改用大得多的
  // 批量，让服务器一次拿到更完整的上下文。普通模式（已经是中文，不用翻译）维持原来的
  // 小批量节奏不变，那条路径不存在"按批次重复开销"的问题，没必要跟着改。
  // 默认只保留约十分钟前瞻，避免用户刚打开视频就生产大量不会收看的音频。
  // 但播放位置超过全片三分之一后，用户继续看完的概率已经很高；此时改为持续生成到结尾，
  // 让长视频后段不再因为固定十分钟窗口而断粮。拖动到三分之一以后也同样适用：此时
  // 立即为用户实际要看的剩余部分铺好库存，而不会回头合成已跳过的前半段。
  const FULL_REMAINDER_CACHE_START_RATIO = 1 / 3;
  const getSynthesisAheadSeconds = () => {
    const duration = Number(video.duration || 0);
    const current = Number(video.currentTime || 0);
    const watchedFromHeadEnough = !!sess._startedFromBeginning && current >= REALTIME_START_CRITICAL_SECONDS;
    const watchedThirdEnough = Number.isFinite(duration) && duration > 0
      && current >= duration * FULL_REMAINDER_CACHE_START_RATIO;
    if (!Number.isFinite(duration) || duration <= 0 || (!watchedFromHeadEnough && !watchedThirdEnough)) {
      return current < REALTIME_START_CRITICAL_SECONDS
        ? REALTIME_START_AHEAD_SECONDS
        : REALTIME_NORMAL_AHEAD_SECONDS;
    }
    if (!sess._fullRemainderCaching) {
      sess._fullRemainderCaching = true;
      sess._watchedFiveFullCacheLogged = watchedFromHeadEnough;
      const remaining = Math.max(0, duration - current);
      recordDiagnostic(sess, 'watched_third_switch_to_full_remainder_cache', {
        currentTime: +current.toFixed(3),
        duration: +duration.toFixed(3),
        remaining: +remaining.toFixed(3),
        reason: watchedFromHeadEnough ? 'played_from_start_over_5min' : 'watched_over_one_third',
      });
      console.log(`[配音插件] 缓存策略升级：${watchedFromHeadEnough ? '从头播放已超过5分钟' : '已播放到三分之一以后'}，持续生成剩余 ${formatHMS(remaining)} 配音`);
    }
    return Math.max(REALTIME_NORMAL_AHEAD_SECONDS, duration - current + 1);
  };
  const STARTUP_PREROLL_MAX_SEGMENTS = STARTUP_PLAYABLE_SEGMENTS;
  let firstDone = false;
  console.log('[配音插件] 开始配音流程，字幕总数:', rawSegments.length, 'upcoming:', upcoming.length, 'past:', past.length);
  const localCoveragePromise = primeLocalDubCoverageForSession(sess, videoId, ordered, t0);
  // 覆盖扫描现在只扫当前视频前缀，速度足够快；若有多个缓存声音，则必须等用户
  // 选定后再发第一批，确保开头也使用用户选择的配音员。
  await localCoveragePromise;

  const startupPrerollSegments = () => {
    const segs = upcoming
      .filter((s) => s.end >= t0 - 0.5)
      .slice(0, STARTUP_PREROLL_MAX_SEGMENTS);
    return segs.length ? segs : upcoming.slice(0, Math.min(1, upcoming.length));
  };

  const isStartupPrerollReady = () => {
    const required = startupPrerollSegments();
    if (!required.length) return !!sess.dubSegments?.length;
    const have = new Set((sess.dubSegments || [])
      .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
      .map(_segKey));
    return required.every((s) => have.has(_segKey(s)));
  };

  const maybeMarkFirstReady = () => {
    if (firstDone || !isStartupPrerollReady()) return;
    firstDone = true;
    // “首批片段已返回”与“Audio 已完全解码”是两道不同的门。前者一到就必须
    // 放开正常调度/即时补救；否则某个损坏的缓存音频会把整个会话永久锁在 preparing。
    // 真正续播仍由 onFirstChunkReady 的三段可播放验证控制。
    sess._phase = 'dubbing';
    primeStartupAudio(sess, video.currentTime || t0);
    recordDiagnostic(sess, 'startup_preroll_ready', {
      currentTime: +(video.currentTime || 0).toFixed(3),
      required: startupPrerollSegments().length,
      maxReady: +(sess._maxSynthedTime || 0).toFixed(3),
    });
    if (onFirstChunkReady) onFirstChunkReady();
  };

  async function runStream(queue, isPrimary) {
    let idx = 0, chunkNo = 0;
    while (idx < queue.length) {
      // 不能只查 sess.started：播放列表切视频时，旧视频这个 runStream 调用可能正
      // await 在 sendChunk 上，stopDubbing 把 started 设 false 后，新视频的
      // startDubbing 几乎立刻又把它设回 true——旧调用的 await 一恢复，只查
      // started 会以为"还是当时那次配音"，把旧视频的结果当成新视频的塞进
      // sess.dubSegments，表现就是"切到新视频，配音内容却完全对不上"。
      // 必须同时确认 sess.videoId 没变过，才说明这个调用没有跨视频。
      if (!sess.started || sess.videoId !== videoId) return;
      const chunkStartIndex = idx;
      if (isPrimary) {
        while (idx < queue.length
            && queue[idx].start > video.currentTime + getSynthesisAheadSeconds()) {
          if (!sess.started || sess.videoId !== videoId) return;
          sess._longVideoWaiting = true;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
        sess._longVideoWaiting = false;
      }
      let chunk;
      if (sess._subtitleMode === 'gemini') {
        // 首批小而快，尽快让第一段真正出声；后续再用大批量建立长视频缓存。
        // 若第一批也塞满1200字，旧机器或网络稍慢时会长时间只有录制占位信息，
        // 用户看到的就是“录音一直运行，但没有开始配音”。
        const maxEstimatedZh = chunkNo === 0 ? 240 : 1200;
        const maxSegments = chunkNo === 0 ? 8 : Number.POSITIVE_INFINITY;
        let end = idx, estimatedZh = 0;
        while (end < queue.length && end - idx < maxSegments) {
          const s = queue[end];
          const chars = Math.max(1, Math.round(Math.max(0.25, s.end - s.start) * 4));
          if (end > idx && estimatedZh + chars > maxEstimatedZh) break;
          estimatedZh += chars;
          end++;
        }
        chunk = queue.slice(idx, end);
        idx = end;
      } else {
        // 启动放行条件是“当前三句都可播放”。旧逻辑首批却只发送2句，必然还要
        // 等第二个网络往返才能放行，开头再快的缓存也被人为拖慢。首批固定三句，
        // 只覆盖马上要播的内容；从第二批起仍按原有风险感知分批，不扩大库存。
        const size = isPrimary && chunkNo === 0
          ? STARTUP_PLAYABLE_SEGMENTS
          : getAdaptiveChunkSize(sess, chunkNo);
        chunk = queue.slice(idx, idx + size);
        idx += size;
      }
      chunkNo++;

      const chunkWithVoice = applySessionVoice(sess, chunk);
      let requestForServer = chunkWithVoice;
      let cachedHits = [];
      const forceLockedVoice = (items) => {
        const locked = sess._cachedVoice || '';
        if (!locked || !Array.isArray(items)) return items;
        return items.map((item) => item ? { ...item, voice: locked, _strictCacheVoice: true } : item);
      };
      const normalizeReturnedVoices = (items, sourceSegments) => {
        if (!Array.isArray(items)) return items;
        const byKey = new Map((sourceSegments || []).map((s) => [s._sourceKey || makeSourceSegKey(s), s]));
        const byStart = new Map((sourceSegments || []).map((s) => [Math.round((s.start || 0) * 1000), s]));
        return items.map((item, i) => {
          if (!item) return item;
          const source = byKey.get(item._sourceKey || '')
            || byStart.get(Math.round((item.start || 0) * 1000))
            || sourceSegments?.[i]
            || null;
          const voice = source?.voice || sess._cachedVoice || item.voice || '';
          return voice ? { ...item, voice, _strictCacheVoice: !!sess._cachedVoice } : item;
        });
      };
      sess._synthInFlight = sess._synthInFlight || new Set();
      chunk.forEach((s) => sess._synthInFlight.add(_segKey(s)));
      console.log(`[配音插件] 发送第${chunkNo}批，${chunk.length}段，起始=${chunk[0]?.start?.toFixed(1)}s`);

      let got = null;
      let lastChunkError = null;
      const acceptProgress = (fresh) => {
        if (!sess.started || sess.videoId !== videoId || !fresh?.length) return;
        fresh = normalizeReturnedVoices(fresh, requestForServer);
        const existing = new Map(sess.dubSegments.map((item) => [_segKey(item), item]));
        const ct = video.currentTime;
        for (const s of fresh) {
          const key = _segKey(s);
          const prior = existing.get(key);
          if (!prior) {
            sess.dubSegments.push({ ...s, played: initialPlayedStateForInsertedSegment(sess, s, ct) });
            existing.set(key, sess.dubSegments[sess.dubSegments.length - 1]);
          } else if (prior._invalidAudio || prior._skipLocalCache || prior._skippedStale || !prior.audio_url
              || (!prior._persistedLocalAudio && s._persistedLocalAudio)) {
            Object.assign(prior, s, {
              played: initialPlayedStateForInsertedSegment(sess, s, ct),
              _invalidAudio: false,
              _loadRetryCount: 0,
            });
            delete prior._skipLocalCache;
            delete prior._skippedStale;
            delete prior._audioFailureRecovering;
          }
        }
        sess.dubSegments.sort(compareDubSegments);
        markReturnedAudioPersisted(sess, fresh, video.currentTime || t0);
        primeStartupAudio(sess, video.currentTime || t0);
        const frontier = Math.max(...fresh.map(segmentTimelineEnd));
        sess._maxSynthedTime = Math.max(sess._maxSynthedTime, frontier);
        if (!sess._startupGatePending && !sess._networkRecoveryPaused && sess._buffering
            && getLoadedDubQueueFrontier(sess, video.currentTime) > video.currentTime + 0.25) {
          sess._buffering = false; sess.weArePausing = false;
          hideBufferIndicator();
          video.play().catch(() => {});
        }
        maybeMarkFirstReady();
      };
      // 真正的本地持久缓存优先于任何网络请求。只有整批未完整命中时才访问服务器；
      // 已完整配过的视频会在这里立即返回，不等待TTS或健康检查。
      const localCached = await loadLocalDubBatch(videoId, chunkWithVoice);
      const cachedVoice = localCached.find((item) => isChineseDubVoice(item?.voice))?.voice || null;
      if (cachedVoice && !sess._cachedVoice) {
        sess._cachedVoice = cachedVoice;
        sess._autoVoice = cachedVoice;
        console.log(`[配音插件] 首批命中本地缓存，沿用缓存配音员：${cachedVoice}`);
      }
      if (localCached.length === chunkWithVoice.length && localCached.every(Boolean)) {
        got = localCached;
        console.log(`[配音插件] 第${chunkNo}批命中浏览器本地音频缓存 ${got.length}/${chunkWithVoice.length}`);
      } else if (localCached.some(Boolean)) {
        cachedHits = localCached.filter(Boolean);
        acceptProgress(cachedHits);
        requestForServer = chunkWithVoice.filter((_, i) => !localCached[i]);
        console.log(`[配音插件] 第${chunkNo}批部分命中浏览器本地音频缓存 ${cachedHits.length}/${chunkWithVoice.length}，只补 ${requestForServer.length} 段`);
      }
      const lockedVoice = sess._cachedVoice || cachedVoice || '';
      if (lockedVoice) {
        requestForServer = requestForServer.map((seg) => ({ ...seg, voice: lockedVoice, _strictCacheVoice: true }));
        if (requestForServer.length) {
          console.log(`[配音插件] 补缺请求锁定缓存配音员：${lockedVoice}，${requestForServer.length}段`);
        }
      }
      const maxChunkAttempts = sess._subtitleMode === 'gemini' ? 3 : 1;
      for (let attempt = 0; got === null && attempt < maxChunkAttempts; attempt++) {
        try {
          got = await sendChunk(videoId, title, requestForServer, sess._baseRatePct || 0,
            sess._readMode, sess._readLang, sess._subtitleMode === 'gemini', acceptProgress);
          got = normalizeReturnedVoices(got, requestForServer);
          await saveLocalDubBatch(videoId, requestForServer, got);
          break;
        } catch (e) {
          lastChunkError = e;
          if (!firstDone && isPrimary && attempt === maxChunkAttempts - 1)
            console.warn('[配音插件] 首批连续失败，进入断点等待而不是结束配音');
          console.warn(`[配音插件] 第${chunkNo}批第${attempt + 1}次失败，${attempt < maxChunkAttempts - 1 ? '重试…' : '切换兜底'}`, e.message);
          if (attempt < maxChunkAttempts - 1) await new Promise(
            r => setTimeout(r, attempt === 0 ? 2000 : 5000));
        }
      }
      chunk.forEach((s) => sess._synthInFlight.delete(_segKey(s)));

      if (!sess.started || sess.videoId !== videoId) return;   // 同上：防止把旧视频的迟到结果塞进新视频
      if (got === null && cachedHits.length) {
        got = forceLockedVoice(cachedHits);
        lastChunkError = null;
        console.warn(`[配音插件] 第${chunkNo}批补缺失败，但已有 ${cachedHits.length} 段本地缓存，先继续播放，缺句后续补救`);
      } else if (Array.isArray(got) && cachedHits.length) {
        got = [...forceLockedVoice(cachedHits), ...normalizeReturnedVoices(got, requestForServer)];
      }
      if (got === null && lastChunkError) {
        const recovered = await waitForDubServiceRecovery(
          sess, videoId, lastChunkError?.message || String(lastChunkError));
        if (!recovered) return;
        // 回滚到当前批次起点；恢复后完整重发，不跳句，也不从视频开头重做。
        idx = chunkStartIndex;
        chunkNo = Math.max(0, chunkNo - 1);
        continue;
      }
      if (sess._networkRecoveryPaused) {
        await resumeAfterNetworkRecovery(sess);
      }
      if (Array.isArray(got) && got.length === 0 && requestForServer.length) {
        return fail('中文神经网络配音服务未返回音频；未使用浏览器机械语音');
      }
      if (got?.translateFailedStarts?.length) {
        // Gemini翻译有句子失败了，服务器那边已经不再"原文照读"凑数——这里同样不能
        // 悄悄跳过当没事发生，必须让用户立刻察觉。直接暂停视频+暂停配音、给一个不会
        // 自动消失的明显提示，而不是让坏的/缺失的几句悄悄混在播放里过去，尤其录屏场景
        // 等录完逐句听才发现就晚了。
        pauseForTranslateFailure(sess, got.translateFailedStarts);
        return;
      }
      if (got && got.length) {
        const ct = video.currentTime;
        // 只有明显已经播过(用户手动快进)的段才标记已播；
        // 正常合成落后由视频暂停缓冲兜住，不在这里丢句。
        const existing = new Map(sess.dubSegments.map((item) => [_segKey(item), item]));
        for (const s of got) {
          const key = _segKey(s);
          const prior = existing.get(key);
          if (!prior) {
            sess.dubSegments.push({ ...s, played: initialPlayedStateForInsertedSegment(sess, s, ct) });
            existing.set(key, sess.dubSegments[sess.dubSegments.length - 1]);
          } else if (prior._invalidAudio || prior._skipLocalCache || prior._skippedStale || !prior.audio_url
              || (!prior._persistedLocalAudio && s._persistedLocalAudio)) {
            const previousUrl = prior.audio_url;
            if (previousUrl && previousUrl !== s.audio_url) delete sess.audioCache[previousUrl];
            Object.assign(prior, s, {
              played: initialPlayedStateForInsertedSegment(sess, s, ct),
              _invalidAudio: false,
              _loadRetryCount: 0,
            });
            delete prior._skipLocalCache;
            delete prior._skippedStale;
            delete prior._audioFailureRecovering;
          }
        }
        sess.dubSegments.sort(compareDubSegments);
        markReturnedAudioPersisted(sess, got, video.currentTime || t0);
        primeStartupAudio(sess, video.currentTime || t0);

        // ASR 识别结果处理：
        // - 若立即返回了 asr_segments（前几批），直接用
        // - 若没返回但有合并（需要 ASR），启动轮询接口等待后台完成
        let hasASRSegs = false;
        for (const s of got) {
          if (s.asr_segments) {
            hasASRSegs = true;
            if (!sess._asrSubtitles) sess._asrSubtitles = [];
            sess._asrSubtitles.push(...s.asr_segments);
          }
        }

        if (sess._hasMerged && !hasASRSegs && !sess._asrPolling) {
          // 字幕有合并但还没 ASR 结果 → 启动轮询等待后台任务
          console.log(`[配音插件] 字幕合并已检测，启动 ASR 轮询…`);
          let pollFails = 0;
          sess._asrPolling = setInterval(async () => {
            try {
              const resp = await fetch(`${SERVER}/asr_results/${videoId}`);
              if (!resp.ok) {
                pollFails++;
                if (pollFails >= 15) {  // 15 次失败（15秒）后放弃
                  console.warn(`[配音插件] ASR 轮询 15 次失败，已停止。使用 YouTube 原生字幕。`);
                  clearInterval(sess._asrPolling);
                  sess._asrPolling = null;
                }
                return;
              }
              const data = await resp.json();
              if (data.asr_segments && Object.keys(data.asr_segments).length > 0) {
                // 收到 ASR 结果，构造字幕显示
                const asr_segs = [];
                for (const seg_map of Object.values(data.asr_segments)) {
                  asr_segs.push(...seg_map);
                }
                sess._asrSubtitles = asr_segs.sort((a, b) => a.start - b.start);
                sess._displaySegments = sess._asrSubtitles;
                if (IS_YOUTUBE) { disableCaptions(); }
                console.log(`[配音插件] ASR 识别完成，已改为自绘字幕 ${asr_segs.length} 行`);
                clearInterval(sess._asrPolling);
                sess._asrPolling = null;
              }
            } catch (e) {
              console.warn(`[配音插件] ASR 轮询异常：${e.message}`);
              pollFails++;
              if (pollFails >= 15) {
                clearInterval(sess._asrPolling);
                sess._asrPolling = null;
              }
            }
          }, 1000);  // 每秒轮询一次
        } else if (sess._asrSubtitles && sess._asrSubtitles.length > 0) {
          // 已收到 ASR 结果，更新字幕显示
          sess._displaySegments = sess._asrSubtitles.sort((a, b) => a.start - b.start);
          if (IS_YOUTUBE) { disableCaptions(); }
          console.log(`[配音插件] 更新为 ASR 字幕分段 ${sess._asrSubtitles.length} 行`);
        }

        // 推进"合成前沿"：上行流按时间顺序返回，故可视为连续已合成到此
        if (isPrimary) {
          const frontier = Math.max(...got.map(segmentTimelineEnd));
          sess._maxSynthedTime = Math.max(sess._maxSynthedTime, frontier);
          // 若视频正因合成落后而暂停缓冲，且前沿已追上 → 自动恢复播放
          if (!sess._startupGatePending && !sess._networkRecoveryPaused && sess._buffering
              && getLoadedDubQueueFrontier(sess, video.currentTime) > video.currentTime + 0.25) {
            sess._buffering = false;
            sess.weArePausing = false;
            hideBufferIndicator();
            video.play().catch(() => {});
          }
          // 时间轴对齐不在此做：视频恒定 1.0x，每句播放时压缩配音音频塞进
          // 自己的原始窗口（见 playNextDue），保证内容严格对齐、不累积漂移。
        }
        const maxSec = sess.dubSegments.reduce(
          (max, s) => Math.max(max, s.start + (s.duration || 0)), 0);
        if (sess._onChunkProgress) sess._onChunkProgress(maxSec);
        console.log(`[配音插件] 第${chunkNo}批返回${got.length}段`);
      }
      maybeMarkFirstReady();
    }
  }

  await runStream(upcoming, true);
  if (sess.started && sess.videoId === videoId && past.length) await runStream(past, false);
  if (!sess.started || sess.videoId !== videoId) return;   // 用户已停止，或这次调用已经是旧视频的了，不触发 fail
  if (!sess.dubSegments?.length) return fail('后端未返回任何配音片段');

  // 健壮性兜底：之前每批失败重试1次后就直接放弃、永远丢掉那批内容——长视频（尤其是
  // 几十分钟以上）批次很多，云端服务器偶尔某一批超时/出错的概率不低，用户反馈过"前面
  // 都好、最后几分钟有字幕没配音"，正是这里漏的批次刚好落在视频末尾。这里在收尾前
  // 做一次"补漏"：比对应该有的全量句子(_allSegments)和实际拿到的(dubSegments)，
  // 把缺的那些再尝试几轮，仍然失败也不再无限重试（避免真没法生成时卡死收尾）。
  for (let round = 0; round < 3 && sess.started && sess.videoId === videoId; round++) {
    const have = new Set(sess.dubSegments
      .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
      .map(_segKey));
    const missing = (sess._allSegments || []).filter((s) => !have.has(_segKey(s)));
    if (!missing.length) break;
    console.warn(`[配音插件] 收尾补漏第${round + 1}轮：发现 ${missing.length} 句之前没成功合成，重新尝试`);
    // 缺失可能有几百/几千句，绝不能重新塞进一个巨型请求。按正常批次上限切开，
    // 一批失败不拖垮其它批，尤其适用于3小时以上视频。
    for (let offset = 0; offset < missing.length; offset += 40) {
      try {
        const repairPart = missing.slice(offset, offset + 40);
        const segs = applySessionVoice(sess, repairPart);
        const got = await sendChunk(videoId, title, segs, sess._baseRatePct || 0,
          sess._readMode, sess._readLang, sess._subtitleMode === 'gemini');
        if (!sess.started || sess.videoId !== videoId) return;
        if (got?.translateFailedStarts?.length) {
          pauseForTranslateFailure(sess, got.translateFailedStarts);
          return;
        }
        if (got && got.length) {
          await saveLocalDubBatch(videoId, segs, got);
          const existing = new Map(sess.dubSegments.map((item) => [_segKey(item), item]));
          for (const s of got) {
            const key = _segKey(s);
            const old = existing.get(key);
            if (old) {
              const previousUrl = old.audio_url;
              if (previousUrl && previousUrl !== s.audio_url) delete sess.audioCache[previousUrl];
              Object.assign(old, s, {
                played: initialPlayedStateForInsertedSegment(sess, s, sess.video?.currentTime || 0),
                _invalidAudio: false,
                _loadRetryCount: 0,
              });
              delete old._skipLocalCache;
              delete old._skippedStale;
              delete old._audioFailureRecovering;
            } else {
              sess.dubSegments.push({
                ...s,
                played: initialPlayedStateForInsertedSegment(sess, s, sess.video?.currentTime || 0),
              });
              existing.set(key, sess.dubSegments[sess.dubSegments.length - 1]);
            }
          }
          sess.dubSegments.sort(compareDubSegments);
          markReturnedAudioPersisted(sess, got, sess.video?.currentTime || 0);
          console.log(`[配音插件] 收尾补漏第${round + 1}轮：补回 ${got.length} 句`);
        }
      } catch (e) {
        console.warn(`[配音插件] 收尾补漏第${round + 1}轮分批失败：`, e?.message || e);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  const finalHave = new Set(sess.dubSegments
    .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
    .map(_segKey));
  const finalMissing = (sess._allSegments || []).filter(
    (s) => !finalHave.has(_segKey(s)));
  sess._synthDone = finalMissing.length === 0;
  if (finalMissing.length) {
    sess._allDone = false;
    sess._phase = 'dubbing';
    console.warn(`[配音插件] 收尾后仍缺 ${finalMissing.length} 句，保持自动补合成状态，不标记全部完成`);
    const btn = document.getElementById('dub-ext-btn');
    if (btn) {
      btn.textContent = `🎧待补${finalMissing.length}句`;
      btn.title = '播放到缺失位置时会继续往前走，并在后台补齐缓存';
    }
    requestSynthAround(sess, sess.video.currentTime);
    return;
  }
  // 全部合成完，若还卡在缓冲暂停则恢复播放
  if (!sess._startupGatePending && sess._buffering) {
    sess._buffering = false;
    sess.weArePausing = false;
    hideBufferIndicator();
    if (sess.started) video.play().catch(() => {});
  }
  console.log('[配音插件] 全部配音就绪', sess.dubSegments.length, '段');
  if (sess._onAllDone) sess._onAllDone();
}

// Gemini翻译有句子失败时，暂停视频+暂停配音，给一个不会自动消失的明显提示。
// 跟"录屏才发现翻译/配音坏了"这种用户反馈直接相关——宁可中断体验，也不要让用户
// 在不知情的情况下放着坏内容继续播完。
function pauseForTranslateFailure(sess, failedStarts) {
  try { sess.video.pause(); } catch (_) {}
  sess._userPaused = true;   // 让 playNextDue 的现有保护停止继续调度配音
  sess.weArePausing = false;
  if (sess.curAudio) { try { sess.curAudio.pause(); } catch (_) {} }
  // 记下最早的失败点——出问题时可能已经在不正常的状态下播了一段，用这个点
  // （而不是"当前播放位置"）作为"恢复并补救"时回退衔接的锚点更准确。
  sess._lastTranslateFailureStart = Math.min(...failedStarts);
  const n = failedStarts.length;
  const sample = failedStarts.slice(0, 3).map((t) => formatHMS(t)).join('、');
  const msg = `❌ Gemini翻译失败 ${n} 句（约 ${sample} 处），视频已暂停。多为Gemini服务临时繁忙，重新点击配音重试即可；仍反复失败再检查网络/服务器。`;
  console.error('[配音插件] ' + msg, failedStarts);
  showBufferIndicator(msg, sess.video);
  // 故意不设置自动消失的 setTimeout——这条提示必须等用户自己处理完才消失，
  // 不能像别的友好提示那样几秒后悄悄飘走。
  const btn = document.getElementById('dub-ext-btn');
  if (btn) { btn.textContent = '🎧翻译失败'; btn.title = msg; }
}

// 手动补救：配音进行中如果发现某段没声音（合成失败、网络抖动等），不用整个重新
// 开始（归零重来很慢、还会把已经听过的部分重播一遍），右键菜单"补救并恢复"触发这个
// （之前是双击触发，双击对触屏板/触控手势不友好，只有独立鼠标才方便双击，改成右键
// 菜单更适合所有输入设备），只重新尝试"应该有但目前还没拿到音频"的那些句子，
// 补回 sess.dubSegments，不影响已经在播的部分。复用收尾补漏同一套逐句比对逻辑，
// 单独抽出来供手动触发。
async function repairDubbing(sess, btn, { resumeAfter = false, silent = false } = {}) {
  if (!sess.started || sess._readMode || !sess._allSegments?.length) return;
  // 防重入：看门狗自动补救和用户手动点"补救并恢复"可能撞在同一时间，两份补救
  // 并发跑会对同一批缺失句子重复发请求。带2分钟兜底超时——万一上一次补救因为
  // 未捕获异常没走到清理，不至于永远锁死再也不能补救。
  if (sess._repairing && Date.now() - (sess._repairingSince || 0) < 120000) return;
  sess._repairing = true;
  sess._repairingSince = Date.now();
  const have = new Set((sess.dubSegments || [])
    .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
    .map(_segKey));
  const missing = sess._allSegments.filter((s) => !have.has(_segKey(s)));

  // 补救完成后如果是"恢复并续播"（比如右键菜单选的、或翻译失败暂停后用户确认恢复），
  // 不要直接从暂停的那个点（往往正好卡在失败的硬边界上）接着播，回退到失败点之前两句
  // 正常配音的位置，重新听一下衔接，体验更顺，不会觉得"突然冒出来"。
  const finishResume = () => {
    if (!resumeAfter) return;
    const ordered = sess._allSegments.slice().sort(compareDubSegments);
    const anchor = sess._lastTranslateFailureStart ?? sess.video.currentTime;
    let idx = ordered.findIndex((s) => s.start >= anchor);
    if (idx < 0) idx = ordered.length - 1;
    const backIdx = Math.max(0, idx - 2);
    const rewindTo = ordered[backIdx]?.start ?? anchor;
    try { sess.video.currentTime = rewindTo; } catch (_) {}
    sess._userPaused = false;
    sess._lastTranslateFailureStart = null;
    try { sess.video.play().catch(() => {}); } catch (_) {}
    console.log(`[配音插件] 补救完成，从 ${formatHMS(rewindTo)} 衔接续播（往前回退了2句）`);
  };

  if (!missing.length) {
    if (!silent) {
      showBufferIndicator('🔧 没有发现缺失的句子', sess.video);
      setTimeout(hideBufferIndicator, 2000);
    }
    finishResume();
    sess._repairing = false;
    return;
  }
  console.log(`[配音插件] 手动补救：发现 ${missing.length} 句缺失，重新尝试合成`);
  if (!silent) showBufferIndicator(`🔧 正在补救 ${missing.length} 句缺失的配音…`, sess.video);

  // 之前这里是把全部缺失句子（哪怕几百句）一次性塞进一个请求发出去，跟长视频走正常
  // 配音流程时用的分批节奏（processDubbingChunked 的 CHUNK_SIZES）完全不一样。
  // 缺失句子越多，这一个请求体就越大、服务器合成耗时越长，越容易超时/连接被掐断
  // （表现为 "Failed to fetch"）——而且没有重试，一炸就是几百句全军覆没。
  // 现在改成分批发送+每批失败重试一次，单批失败不连累其它批，最大化能补回来的部分。
  const REPAIR_CHUNK = 40;
  const videoId = curVideoId();
  const title = document.title.replace(/ - YouTube$/, '');
  let translateFailedStarts = null;   // finally 里要先用它判断要不要保留提示，所以在外层声明
  let recovered = 0;
  let stillMissing = 0;
  let lastFetchError = null;
  for (let i = 0; i < missing.length; i += REPAIR_CHUNK) {
    const batch = missing.slice(i, i + REPAIR_CHUNK);
    const segs = applySessionVoice(sess, batch);
    let got = null;
    for (let attempt = 0; attempt < 2; attempt++) {   // 单批失败重试一次，不连累其它批
      try {
        got = await sendChunk(videoId, title, segs, sess._baseRatePct || 0, false, null, sess._subtitleMode === 'gemini');
        break;
      } catch (e) {
        lastFetchError = e?.message || String(e);
        console.warn(`[配音插件] 手动补救：第${i / REPAIR_CHUNK + 1}批第${attempt + 1}次失败，${attempt < 1 ? '重试…' : '跳过此批'}`, lastFetchError);
        if (attempt < 1) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (got?.translateFailedStarts?.length) {
      translateFailedStarts = got.translateFailedStarts;
      stillMissing += missing.length - i - batch.length;
      break;
    } else if (got && got.length) {
      await saveLocalDubBatch(videoId, segs, got);
      const existing = new Map((sess.dubSegments || []).map((s) => [_segKey(s), s]));
      for (const s of got) {
        const old = existing.get(_segKey(s));
        if (old) {
          Object.assign(old, s, {
            played: initialPlayedStateForInsertedSegment(sess, s, sess.video?.currentTime || 0),
            _invalidAudio: false,
            _loadRetryCount: 0,
          });
          delete old._skipLocalCache;
          delete old._skippedStale;
          delete old._audioFailureRecovering;
        }
        else sess.dubSegments.push({
          ...s,
          played: initialPlayedStateForInsertedSegment(sess, s, sess.video?.currentTime || 0),
        });
      }
      sess.dubSegments.sort(compareDubSegments);
      markReturnedAudioPersisted(sess, got, sess.video?.currentTime || 0);
      recovered += got.length;
      stillMissing += Math.max(0, batch.length - got.length);
    } else {
      stillMissing += batch.length;
    }
    // 补一批就踢一下调度，不用等全部批次跑完——用户能更快听到已经补回来的部分。
    if (sess.started) playNextDue(sess, sess.video.currentTime);
  }
  console.log(`[配音插件] 手动补救：补回 ${recovered} 句，仍缺失 ${stillMissing} 句`);

  if (translateFailedStarts) {
    // 还是失败：不要被这里的 hideBufferIndicator 把提示冲掉，继续停在暂停状态，
    // pauseForTranslateFailure 自己会显示一条不会自动消失的提示，等用户再次处理。
    pauseForTranslateFailure(sess, translateFailedStarts);
  } else if (stillMissing > 0) {
    // 之前这里只要 catch 到异常就打印一行警告，外层 finally 判断不到任何失败标记，
    // 照样走"成功"分支隐藏提示、回退两句、恢复播放——网络一抖，缺失的句子其实
    // 一句都没补回去，却显示得像是补好了，留下一整段没配音也没字幕、只有原声的
    // "哑视频"。现在按实际补回数量明确提示，部分成功也如实说明还差多少句。
    const msg = recovered > 0
      ? `⚠️ 补回 ${recovered} 句，仍有 ${stillMissing} 句失败（${lastFetchError || '未知原因'}），请右键选"补救并恢复"重试`
      : `❌ 补救失败（${lastFetchError || '未知原因'}），${stillMissing} 句仍缺失，请检查网络/服务器后右键选"补救并恢复"重试`;
    showBufferIndicator(msg, sess.video);
    if (btn) btn.title = msg;
    console.error('[配音插件] ' + msg);
  } else {
    hideBufferIndicator();
    finishResume();
  }
  sess._repairing = false;
}

// 统一格式化成 时:分:秒（HH:MM:SS），方便直接对照原视频进度条上的时间戳，
// 不用再口算"223分钟是几点几分"。秒数不到一小时也照样补全"00:"前缀，格式统一。
function formatHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// 点击按钮时根据当前阶段弹确认框，避免用户乱点导致状态不明。
// 返回 true 表示用户确认关闭。
function confirmStopDubbing(sess) {
  let msg;
  if (sess._phase === 'done') {
    msg = '配音已全部生成完成，正在播放。确定要关闭配音吗？';
  } else if (sess._phase === 'dubbing') {
    const f = sess._maxSynthedTime || 0;
    msg = `配音正在进行中，已配音到 ${formatHMS(f)}。确定要关闭配音吗？`;
  } else {
    const sec = sess._startTs ? Math.round((Date.now() - sess._startTs) / 1000) : 0;
    msg = `配音正在准备中（已等待约 ${sec} 秒），关闭后需重新开始。确定要关闭吗？`;
  }
  return window.confirm(msg);
}

// ===== 停止配音 =====
function finalizeSessionExports(sess, keepRecordingForNextVideo = false) {
  // 连续自动配音时会话本身已经明确表示需要自动收尾；不要只依赖异步同步过来的
  // autoExportFiles 内存值，否则视频恰好在设置回调前切换会整段漏导出。
  const shouldExport = autoExportFiles || !!sess?._isPlaylistAutoContinue;
  if (!shouldExport || !sess || sess._exportsFinalized || !sess.videoId) return;
  sess._exportsFinalized = true;
  if (AUTO_DOWNLOAD_SIDECARS) {
    try { exportRateLog(sess); } catch (e) { console.warn('[配音插件] 导出变速日志异常', e); }
    try { exportSubtitles(sess); } catch (e) { console.warn('[配音插件] 导出字幕异常', e); }
    try { exportKaraokeSubtitles(sess); } catch (e) { console.warn('[配音插件] 导出卡拉OK字幕异常', e); }
    try { exportRawSourceSubtitles(sess); } catch (e) { console.warn('[配音插件] 导出原始字幕异常', e); }
    try { exportDiagnosticLog(sess); } catch (e) { console.warn('[配音插件] 导出诊断日志异常', e); }
  }
  // 始终额外下载服务器合成的完整MP3。它不依赖tabCapture，即使Chrome录屏权限/
  // MediaRecorder失败，至少配音音频一定有文件；录屏成功时WebM仍会另外下载。
  try {
    chrome.runtime.sendMessage({
      type: 'downloadMergedAudio',
      videoId: sess.videoId,
      filename: `${buildExportFilenamePrefix(sess)}_dubbing.mp3`,
      server: SERVER,
    });
  } catch (e) {
    console.warn('[配音插件] 备用MP3下载消息发送失败', e);
  }
  stopTabAudioRecordingAndDownload(sess, keepRecordingForNextVideo);
}

function stopDubbing(sess, btn, keepRecordingForNextVideo = false) {
  if (sess._endFinalizeTimer) {
    clearTimeout(sess._endFinalizeTimer);
    sess._endFinalizeTimer = null;
  }
  sess.started = false;
  if (sess._recordingStatusTimer) {
    clearInterval(sess._recordingStatusTimer);
    sess._recordingStatusTimer = null;
  }
  clearTimeout(sess._priorityRetryTimer);
  sess._priorityRetryTimer = null;
  sess._priorityRetryCount = 0;
  sess._userPaused = false;
  sess._readMode = false;
  sess.weArePausing = false;
  sess.bufferMissCount = 0;
  try { window.speechSynthesis?.cancel(); } catch (_) {}  // 停止时也要喊停浏览器自带语音兜底
  // 默认不自动下载变速日志/字幕/录音，要用popup里"下载本次配音变速日志+字幕"手动导出；
  // 勾了popup里"自动下载配音文件"这个独立开关（autoExportFiles）才自动导出整套文件——
  // 不管是单个视频还是播放列表连续配音都生效，跟autoDub/_isPlaylistAutoContinue
  // 是两件不同的事（那个只管"要不要自动触发下一个视频/自动识别配音员"）。
  finalizeSessionExports(sess, keepRecordingForNextVideo);
  try { sess.video.playbackRate = 1.0; } catch (_) {}
  hideBufferIndicator();
  const video = sess.video;
  if (sess._onTimeUpdate) video.removeEventListener('timeupdate', sess._onTimeUpdate);
  if (sess._onSeeking) video.removeEventListener('seeking', sess._onSeeking);
  if (sess._onPause) video.removeEventListener('pause', sess._onPause);
  if (sess._onPlay) video.removeEventListener('play', sess._onPlay);
  if (sess._onEnded) video.removeEventListener('ended', sess._onEnded);
  if (sess._onResize) {
    window.removeEventListener('resize', sess._onResize);
    window.removeEventListener('scroll', sess._onResize);
  }
  if (sess._onTextTrackChange) {
    try { video.textTracks?.removeEventListener('change', sess._onTextTrackChange); } catch (_) {}
    sess._onTextTrackChange = null;
  }
  clearTimeout(sess._trackChangeTimer);
  teardownDiarization(sess);
  video.volume = 1.0;
  for (const a of Object.values(sess.audioCache)) {
    try {
      a.pause();
      a.onended = null;
      if (a.src?.startsWith('blob:')) URL.revokeObjectURL(a.src);
    } catch (_) {}
  }
  sess.audioCache = {};
  sess._audioFetches = {};
  sess.curAudio = null;
  sess.dubSegments = null;
  removeSubtitleEl(sess);
  if (sess._asrPolling) { clearInterval(sess._asrPolling); sess._asrPolling = null; }  // 停止 ASR 轮询
  if (sess._initTimer) { clearInterval(sess._initTimer); sess._initTimer = null; }     // 停止朗读初始化倒计时
  sess._reading = false;
  try { hideLangSwitchBtn(); } catch (_) {}   // 朗读停止时移除换语言按钮
  // 复位两个按钮的默认文案（无论传入哪个）
  const _db = document.getElementById('dub-ext-btn');
  const _rb = document.getElementById('read-ext-btn');
  if (_db) {
    clearRealtimeCacheButtonStyle(_db);
    _db.textContent = '🎧配音';
    _db.title = '生成中文配音';
  }
  if (_rb) { _rb.textContent = '🔊朗读'; _rb.title = '朗读选中的字幕（忠实时间轴，不影响视频）'; }
}

// ===== 暂停 / 继续配音 =====
// 暂停：只停配音，视频继续播放、原音恢复正常音量（配音不影响视频）。
// 继续：配音从当前视频位置重新跟上，原音再压低。
// 注意：自动录音（startAudioRecording）这里没有停/续——MediaRecorder在暂停期间
// 仍会持续写入静音，跟变速日志（按原视频时间点记录，不含真实暂停的空档）对不上：
// 如果中途真的长时间暂停过，导出的音频会比变速日志"多出"一段静音，从那之后
// retime_video.py 拉伸出的视频会跟这段录音错位。临时暂停一两秒问题不大，
// 长时间暂停后建议整段重新配音，不要指望这种情况下时间轴还能精确对齐。
function pauseDubbing(sess, btn) {
  sess._userPaused = true;
  if (sess.curAudio) { try { sess.curAudio.pause(); } catch (_) {} }
  if (sess.curSegment) sess.curSegment.played = false;  // 当前段放回，继续时从当前位置重选
  sess.curAudio = null; sess.curSegment = null;
  try { window.speechSynthesis?.cancel(); } catch (_) {}  // 同样要喊停浏览器自带语音兜底
  try { sess.video.playbackRate = 1.0; } catch (_) {}   // 撤销档3慢放
  try { sess.video.volume = 1.0; } catch (_) {}          // 恢复原音
  sess.lastSubText = null;
  if (sess.subtitleEl) sess.subtitleEl.style.display = 'none';  // 暂停期间不显示自绘字幕
  hideBufferIndicator();
  if (btn) { btn.textContent = '⏸️已暂停'; btn.title = '点击继续（视频不受影响，原音播放中）'; }
}

function resumeDubbing(sess, btn) {
  sess._userPaused = false;
  if (sess._readMode) {
    try { sess.video.volume = 0; } catch (_) {}          // 朗读：静音原音（朗读独立全音量）
    if (btn) { btn.textContent = '🔊朗读中'; btn.title = '点击暂停朗读'; }
  } else {
    try { sess.video.volume = origVolume; } catch (_) {} // 配音：压低原音
    const modeTag = sess._subtitleMode === 'zh' ? '📝' : '🌐';
    if (btn) { btn.textContent = `🎧${modeTag}配音中`; btn.title = '点击暂停配音'; }
  }
  // 视频本就在播，不动它；配音由调度从当前位置续上
  playNextDue(sess, sess.video.currentTime);
}

// ===== 说话人识别（注册式：用户标记采样点，系统记录音色特征）=====

// 自相关提取基频（F0），能量不足返回 null
function extractF0(data, sampleRate) {
  const SIZE = data.length, HALF = SIZE >> 1;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += data[i] * data[i];
  if (Math.sqrt(rms / SIZE) < 0.005) return null;
  const lo = Math.floor(sampleRate / 400), hi = Math.floor(sampleRate / 70);
  let best = -1, bestP = -1;
  for (let p = lo; p <= hi && p < HALF; p++) {
    let c = 0;
    for (let i = 0; i < HALF; i++) c += data[i] * data[i + p];
    if (c > best) { best = c; bestP = p; }
  }
  const f0 = bestP > 0 ? sampleRate / bestP : 0;
  return f0 >= 70 && f0 <= 400 ? f0 : null;
}

// 从 pitchLog 中取时间窗口的 F0 中位数
function medianF0(samples) {
  if (!samples?.length) return null;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// 口语基频归一化：自相关偶尔会把二次谐波当成F0（例如真实约192Hz却报384Hz）。
// 但女声 280~320Hz 并不罕见，不能粗暴折半；只把 330Hz 以上的明显异常按八度折半。
function normalizedSpeechF0(samples) {
  if (!samples?.length) return null;
  const folded = samples.map((v) => {
    let f = v;
    while (f > 330) f /= 2;
    while (f < 75) f *= 2;
    return f;
  }).filter((f) => f >= 75 && f <= 330).sort((a, b) => a - b);
  if (!folded.length) return null;
  const trim = Math.floor(folded.length * 0.15);
  const stable = folded.slice(trim, Math.max(trim + 1, folded.length - trim));
  return stable[Math.floor(stable.length / 2)];
}

// 单人版性别判断（区别于下面"多人对话配音"那套要手动标记的diarization）：
// 持续采样直到攒够足够多的有效音高样本（不是固定采样1.5秒就停）——开头是片头音乐、
// 或人声很轻/很远的视频，前1-2秒很可能一个有效音高都采不到，固定窗口会直接判断失败；
// 改成"够了才停，到了上限还不够就放弃"，碰到这种情况能多等一会儿，等人声出现再判断。
// 取够样后用中位数跟经验阈值（165Hz，男声大多在此之下、女声大多在此之上）比，
// 返回一个具体的TTS配音员ID，或null（一直采不到/超时就不覆盖，退回手动设置）。
// 必须在视频还在正常播放出声时调用——视频是暂停的话采的全是静音，extractF0全是null。
async function waitForActualVideoPlayback(video, maxWaitMs = 5000) {
  const deadline = Date.now() + maxWaitMs;
  let lastTime = Number(video.currentTime || 0);
  try {
    if (video.paused) await video.play();
  } catch (_) {}
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const now = Number(video.currentTime || 0);
    if (!video.paused && video.readyState >= 3 && now > lastTime + 0.08) return true;
    lastTime = now;
  }
  return false;
}

function isVideoOperational(video) {
  if (!video) return false;
  if (video.paused) return false;
  if (video.readyState < 3) return false;
  if (video.seeking) return false;
  if (video.ended) return false;
  return true;
}

async function detectSpeakerGender(video) {
  const AUTO_MALE_VOICE = getDefaultChineseDubVoiceByGender('male');
  const AUTO_FEMALE_VOICE = getDefaultChineseDubVoiceByGender('female');
  const MIN_SAMPLES = 5;       // 每个位置取少量稳定样本，至少取两个位置交叉判断
  const MAX_WAIT_MS = 1300;    // 单个位置最多1.3秒；两处合计仍不能明显拖慢启动
  const INTERVAL_MS = 100;
  let ctx, src;
  const decideVoiceFromWindows = (windows, sourceLabel) => {
    const good = windows.filter((w) => w && Number.isFinite(w.f0));
    if (!good.length) return null;
    let female = 0, male = 0, ambiguous = 0;
    for (const w of good) {
      if (w.f0 >= 165) female++;
      else if (w.f0 <= 145) male++;
      else ambiguous++;
    }
    const sorted = good.map((w) => w.f0).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // 145~165Hz 是灰区；只要另一处明确女声，就不把灰区误判为男声。
    const isFemale = female > 0 && female >= male;
    const isMale = !isFemale && male > 0 && female === 0;
    const voice = isFemale ? AUTO_FEMALE_VOICE
      : (isMale ? AUTO_MALE_VOICE : (median >= 155 ? AUTO_FEMALE_VOICE : AUTO_MALE_VOICE));
    const gender = voice === AUTO_FEMALE_VOICE ? '女声' : '男声';
    const detail = good.map((w, i) => `${i + 1}:${w.f0.toFixed(0)}Hz/${w.samples || 0}样本`).join('，');
    console.log(`[配音插件] 自动判断说话人（${sourceLabel}，两处采样）：${detail}`
      + `；投票 女${female}/男${male}/灰${ambiguous} → ${gender} → ${voice}`);
    return voice;
  };
  try {
    // 勾选录音/录像时，tabCapture拿到的是标签页当前真正输出的声音，不受视频从
    // 0秒还是中途播放影响，也不会遇到video.captureStream没有音轨的问题。
    try {
      const tabWindows = [];
      let lastTabSample = null;
      for (let i = 0; i < 2; i++) {
        const sampled = await chrome.runtime.sendMessage({ type: 'sampleCurrentTabVoice' });
        lastTabSample = sampled || null;
        if (sampled?.ok && sampled.f0) tabWindows.push(sampled);
        if (i === 0) await new Promise((r) => setTimeout(r, 650));
      }
      const voice = decideVoiceFromWindows(tabWindows, '当前标签页声音');
      if (voice) return voice;
      if (lastTabSample?.error && !/没有可采样/.test(lastTabSample.error)) {
        console.log(`[配音插件] 当前声音暂未识别人声：${lastTabSample.error}，改用视频音轨补采`);
      }
    } catch (_) {}

    // 新视频刚切换那一刻，captureStream() 拿到的流有时还没挂上音频轨道
    // （MediaStream has no audio track），短暂重试几次，不要第一次没拿到就直接放弃。
    let stream = null;
    for (let i = 0; i < 10; i++) {
      stream = video.captureStream();
      if (stream.getAudioTracks().length > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!stream || stream.getAudioTracks().length === 0) {
      console.warn('[配音插件] 当前播放声音无法直接采样，使用默认配音员');
      return null;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const sampleWindow = async () => {
      const samples = [];
      const t0 = Date.now();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          const f0 = extractF0(buf, ctx.sampleRate);
          if (f0) samples.push(f0);
          if (samples.length >= MIN_SAMPLES || Date.now() - t0 > MAX_WAIT_MS) {
            clearInterval(timer);
            resolve();
          }
        }, INTERVAL_MS);
      });
      const rawF0 = medianF0(samples);
      const f0 = normalizedSpeechF0(samples);
      return f0 ? { f0, rawF0, samples: samples.length } : null;
    };
    const windows = [];
    windows.push(await sampleWindow());
    await new Promise((r) => setTimeout(r, 650));
    if (isVideoOperational(video)) windows.push(await sampleWindow());
    const voice = decideVoiceFromWindows(windows, '视频音轨');
    if (!voice) {
      console.warn(`[配音插件] 自动判断说话人性别：两处采样仍采不到有效音高（一直是音乐/静音？），不自动选配音员`);
      return null;
    }
    return voice;
  } catch (e) {
    console.warn('[配音插件] 自动判断说话人性别失败（不影响正常配音，用回默认配音员）', e);
    return null;
  } finally {
    try { src?.disconnect(); } catch (_) {}
    try { ctx?.close(); } catch (_) {}
  }
}

function setupDiarization(sess) {
  try {
    const stream = sess.video.captureStream();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    sess._diarCtx = ctx;
    sess._diarAnalyser = analyser;
    sess._diarStream = stream;
    sess._pitchLog = {};
    sess._profiles = [];
    sess._enrollBtns = [];
    sess._diarization = null;
    sess._speakerVoiceMap = null;

    // 同时录制音频，供 pyannote 后端分析
    sess._recordStartVideoTime = sess.video.currentTime;
    sess._recordedChunks = [];
    sess._recorder = null;
    try {
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length > 0) {
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus' : 'audio/webm';
        sess._recorder = new MediaRecorder(new MediaStream([audioTracks[0]]), { mimeType });
        sess._recorder.ondataavailable = (e) => { if (e.data.size > 0) sess._recordedChunks.push(e.data); };
        sess._recorder.start(1000);
        console.log('[配音插件] 开始录音供 pyannote 分析（录制起点:', sess._recordStartVideoTime.toFixed(1), 's）');
      }
    } catch (e) {
      console.warn('[配音插件] 录音启动失败（将只用F0方案）:', e.message);
    }

    console.log('[配音插件] 说话人分析已启动');
    return true;
  } catch (e) {
    console.warn('[配音插件] 说话人分析不可用:', e.message);
    return false;
  }
}

function sampleDiarization(sess) {
  if (!sess._diarAnalyser) return;
  const buf = new Float32Array(sess._diarAnalyser.fftSize);
  sess._diarAnalyser.getFloatTimeDomainData(buf);
  const f0 = extractF0(buf, sess._diarCtx.sampleRate);
  if (f0 === null) return;
  const t = Math.floor(sess.video.currentTime);
  if (!sess._pitchLog[t]) sess._pitchLog[t] = [];
  sess._pitchLog[t].push(f0);

  // 每秒打印一次当前 F0 及匹配结果（取样阶段调试用）
  if (sess._pitchLog[t].length === 1) {
    const active = sess._profiles?.filter(Boolean) || [];
    if (active.length) {
      let bestLabel = '?', bestScore = Infinity;
      for (const p of active) {
        const score = Math.abs(f0 - p.f0Mean) / p.f0Std;
        if (score < bestScore) { bestScore = score; bestLabel = p.label; }
      }
      console.log(`[F0] ${sess.video.currentTime.toFixed(1)}s  ${f0.toFixed(0)}Hz → ${bestLabel}（得分${bestScore.toFixed(2)}）`);
    } else {
      console.log(`[F0] ${sess.video.currentTime.toFixed(1)}s  ${f0.toFixed(0)}Hz（未注册档案）`);
    }
  }
}

// 用户点"标记"时，抓取当前 ±2s 的 F0 样本累积到档案（多次点击越来越准）
function enrollSpeaker(sess, profileIdx, voice, label) {
  const t = sess.video.currentTime;
  let newSamples = [];
  for (let s = Math.floor(t - 2); s <= Math.ceil(t + 2); s++) {
    if (sess._pitchLog[s]) newSamples = newSamples.concat(sess._pitchLog[s]);
  }
  if (!newSamples.length) { console.warn('[配音插件] 当前无有效音频，请在人声段落点击'); return false; }

  // 累积已有样本（多次标记同一说话人）
  const existing = sess._profiles[profileIdx];
  const allSamples = existing?._rawSamples
    ? existing._rawSamples.concat(newSamples)
    : newSamples;

  const mean = allSamples.reduce((a, x) => a + x, 0) / allSamples.length;
  const variance = allSamples.reduce((v, x) => v + (x - mean) ** 2, 0) / allSamples.length;
  const std = Math.sqrt(variance);
  sess._profiles[profileIdx] = {
    f0Mean: mean,
    f0Std: Math.max(std, 10),
    voice,
    label,
    _rawSamples: allSamples,   // 保留原始样本供后续累积
    _clickCount: (existing?._clickCount || 0) + 1,
  };
  const n = sess._profiles[profileIdx]._clickCount;
  console.log(`[配音插件] 注册说话人${profileIdx} "${label}" 第${n}次 F0=${mean.toFixed(1)}Hz ±${std.toFixed(1)} (${allSamples.length}个样本)`);
  return true;
}

// 根据 F0 匹配最近的档案（得分 = 距离/std，最小为最匹配）
function matchProfile(sess, f0) {
  const active = sess._profiles?.filter(Boolean) || [];
  if (!active.length) return null;
  let best = null, bestScore = Infinity;
  for (const p of active) {
    const score = Math.abs(f0 - p.f0Mean) / p.f0Std;
    if (score < bestScore) { bestScore = score; best = p; }
  }
  // 只有1个档案时，要求得分<3才确认（避免把沉默/背景音归为该说话人）
  // 有2+个档案时，总是分配给得分最低者（片段必然属于其中一人）
  return (active.length >= 2 || bestScore <= 3) ? best : null;
}

// 对一个字幕段，返回分配的 voice（优先 pyannote，回退 F0）
function classifySegmentVoice(sess, seg) {
  // === 优先：pyannote 说话人分离结果 ===
  if (sess._diarization?.length && sess._speakerVoiceMap) {
    const segEnd = seg.end || seg.start + 3;
    let bestSpeaker = null, bestOverlap = 0;
    for (const d of sess._diarization) {
      if (d.end <= seg.start || d.start >= segEnd) continue;
      const overlap = Math.min(d.end, segEnd) - Math.max(d.start, seg.start);
      if (overlap > bestOverlap) { bestOverlap = overlap; bestSpeaker = d.speaker; }
    }
    if (bestSpeaker) {
      const voice = sess._speakerVoiceMap[bestSpeaker];
      if (voice) {
        console.log(`[分配] ${seg.start.toFixed(1)}s pyannote→${bestSpeaker}→${voice}`);
        return voice;
      }
    }
    // 超出录制范围：延续最后一段的说话人
    const lastD = sess._diarization[sess._diarization.length - 1];
    const v = sess._speakerVoiceMap[lastD?.speaker];
    if (v) {
      console.log(`[分配] ${seg.start.toFixed(1)}s 超出录制范围 → 延续 ${lastD.speaker} → ${v}`);
      return v;
    }
  }

  // === 回退：F0 注册式分析 ===
  if (!sess._diarAnalyser) return null;
  const active = sess._profiles?.filter(Boolean) || [];
  if (!active.length) return null;

  const samples = [];
  for (let t = Math.floor(seg.start); t <= Math.ceil(seg.end); t++)
    if (sess._pitchLog?.[t]) samples.push(...sess._pitchLog[t]);
  if (!samples.length && sess._pitchLog) {
    const keys = Object.keys(sess._pitchLog).map(Number)
      .filter(t => t <= Math.floor(seg.start)).sort((a, b) => b - a);
    if (keys.length) samples.push(...sess._pitchLog[keys[0]]);
  }

  const f0 = medianF0(samples);
  const fallback = sess._lastMatchedProfile || active[0];
  if (!f0) {
    console.log(`[分配] ${seg.start.toFixed(1)}s 无F0数据 → 延续 ${fallback.label}`);
    return fallback.voice;
  }
  const matched = matchProfile(sess, f0);
  const result = matched || fallback;
  if (matched) sess._lastMatchedProfile = matched;
  const scores = active.map(p => `${p.label}:${(Math.abs(f0 - p.f0Mean) / p.f0Std).toFixed(2)}`).join(' ');
  console.log(`[分配] ${seg.start.toFixed(1)}s F0=${f0.toFixed(0)}Hz [${scores}] → ${result.label}`);
  return result.voice;
}

// 创建悬浮标记按钮（配音启动后显示）
function showEnrollButtons(sess, video) {
  removeEnrollButtons(sess);
  if (!multiSpeakerEnabled || !sess._diarAnalyser) return;
  const total = speakerCfg.maleCount + speakerCfg.femaleCount;
  if (total < 2) return;

  // 构造每个说话人的 voice 和 label
  const slots = [];
  for (let i = 0; i < speakerCfg.maleCount; i++)
    slots.push({ voice: speakerCfg.maleVoices[i] || 'zh-CN-YunxiNeural', label: `男${speakerCfg.maleCount > 1 ? i + 1 : ''}` });
  for (let i = 0; i < speakerCfg.femaleCount; i++)
    slots.push({ voice: speakerCfg.femaleVoices[i] || 'zh-CN-XiaoxiaoNeural', label: `女${speakerCfg.femaleCount > 1 ? i + 1 : ''}` });

  function reposition() {
    const r = video.getBoundingClientRect();
    if (r.width < 10) return;
    sess._enrollBtns.forEach((btn, i) => {
      btn.style.top  = (r.top + 8 + i * 36) + 'px';
      btn.style.left = (r.left + 8) + 'px';
    });
  }

  slots.forEach((slot, i) => {
    const btn = document.createElement('button');
    btn.style.cssText =
      'position:fixed;z-index:2147483647;background:rgba(30,30,30,0.82);color:#fff;' +
      'border:1.5px solid #aaa;border-radius:6px;padding:4px 10px;font-size:12px;' +
      "cursor:pointer;font-family:'Microsoft YaHei',sans-serif;";
    btn.textContent = `🎤 标记${slot.label}`;
    btn.title = `点击：当前正在说话的是"${slot.label}"`;
    btn.addEventListener('click', () => {
      const ok = enrollSpeaker(sess, i, slot.voice, slot.label);
      if (ok) {
        const n = sess._profiles[i]?._clickCount || 1;
        btn.style.background = 'rgba(0,120,60,0.85)';
        btn.textContent = `✓ ${slot.label} ×${n}`;
        setTimeout(() => {
          btn.style.background = 'rgba(30,30,30,0.82)';
          btn.textContent = `🎤 标记${slot.label} (×${n})`;
        }, 1500);
      } else {
        btn.style.background = 'rgba(160,30,30,0.85)';
        btn.textContent = `🎤 标记${slot.label}（无音频）`;
        setTimeout(() => {
          btn.style.background = 'rgba(30,30,30,0.82)';
          const n = sess._profiles[i]?._clickCount || 0;
          btn.textContent = n ? `🎤 标记${slot.label} (×${n})` : `🎤 标记${slot.label}`;
        }, 1500);
      }
    });
    document.body.appendChild(btn);
    sess._enrollBtns.push(btn);
  });

  reposition();
  sess._enrollRepos = reposition;
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition, { passive: true });
}

function removeEnrollButtons(sess) {
  sess._enrollBtns?.forEach((b) => b.parentNode?.removeChild(b));
  sess._enrollBtns = [];
  if (sess._confirmBtn) {
    sess._confirmBtn.parentNode?.removeChild(sess._confirmBtn);
    sess._confirmBtn = null;
  }
  if (sess._enrollRepos) {
    window.removeEventListener('scroll', sess._enrollRepos);
    window.removeEventListener('resize', sess._enrollRepos);
    sess._enrollRepos = null;
  }
}

// 注册说话人后，把已缓存但未播放的片段清掉，重新用新音色合成
async function resynthesizeFuture(sess) {
  if (!sess.started || !sess.dubSegments || !sess.videoId) return;
  const now = sess.video.currentTime;
  const futureSegs = sess.dubSegments.filter((s) => !s.played && s.start >= now - 0.5);
  if (!futureSegs.length) {
    console.log('[配音插件] 无待重新合成的片段');
    return;
  }
  // 清除这些片段的音频缓存（让 getAudio 拿到新文件）
  for (const seg of futureSegs) {
    if (sess.audioCache[seg.audio_url]) {
      try { sess.audioCache[seg.audio_url].pause(); } catch (_) {}
      delete sess.audioCache[seg.audio_url];
    }
  }
  // 构造重发的 raw 段：用已翻译文本，加上音色分配
  const rawFuture = futureSegs.map((seg) => ({
    start: seg.start,
    end: seg.start + (seg.duration || 3),
    text: seg.translation || seg.text,
    _sourceKey: seg._sourceKey,
    _sourceStart: seg._sourceStart,
    _sourceEnd: seg._sourceEnd,
    _sourceText: seg._sourceText,
    _sourceIndex: seg._sourceIndex,
  }));
  const withVoice = applySessionVoice(sess, rawFuture);
  const voiced = withVoice.filter((s) => s.voice).length;
  console.log(`[配音插件] 重新合成 ${futureSegs.length} 片段，其中 ${voiced} 个已分配专属音色`);
  try {
    const CHUNK = 20;
    for (let i = 0; i < withVoice.length; i += CHUNK) {
      if (!sess.started) return;
      await sendChunk(sess.videoId, sess.title, withVoice.slice(i, i + CHUNK), 0, false, sess._readLang);
    }
    console.log('[配音插件] 重新合成完成');
  } catch (e) {
    console.warn('[配音插件] 重新合成出错:', e.message);
  }
}

function teardownDiarization(sess) {
  removeEnrollButtons(sess);
  try { if (sess._recorder?.state === 'recording') sess._recorder.stop(); } catch (_) {}
  sess._recorder = null; sess._recordedChunks = [];
  try { sess._diarCtx?.close(); } catch (_) {}
  try { sess._diarStream?.getTracks().forEach((t) => t.stop()); } catch (_) {}
  sess._diarCtx = null; sess._diarAnalyser = null;
  sess._diarStream = null; sess._pitchLog = null; sess._profiles = null;
  sess._diarization = null; sess._speakerVoiceMap = null;
}

// 把录制的音频 chunks 发给后端 pyannote（经 background.js 中转）
async function sendAudioForDiarization(chunks, numSpeakers) {
  const blob = new Blob(chunks, { type: 'audio/webm' });
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let b64 = '';
  for (let i = 0; i < bytes.length; i += 8192)
    b64 += String.fromCharCode(...bytes.subarray(i, i + 8192));
  console.log(`[配音插件] 发送音频 ${(blob.size / 1024).toFixed(0)}KB → pyannote（${numSpeakers}位说话人）`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('pyannote 超时(120s)')), 120000);
    chrome.runtime.sendMessage({ type: 'diarize', audioB64: btoa(b64), numSpeakers }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) return reject(new Error(resp?.error || '说话人分离失败'));
      resolve(resp.data);
    });
  });
}

// 按出场顺序把 pyannote speaker 标签映射到配置的音色
function buildSpeakerVoiceMap(sess) {
  const order = [];
  for (const seg of sess._diarization)
    if (!order.includes(seg.speaker)) order.push(seg.speaker);
  // 面板里女声在前、男声在后
  const voices = [
    ...(speakerCfg.femaleVoices || []).slice(0, speakerCfg.femaleCount || 0),
    ...(speakerCfg.maleVoices   || []).slice(0, speakerCfg.maleCount   || 0),
  ];
  if (!voices.length) voices.push(getDefaultChineseDubVoice());
  sess._speakerVoiceMap = {};
  order.forEach((spk, i) => { sess._speakerVoiceMap[spk] = voices[i % voices.length]; });
  console.log('[配音插件] 说话人→音色映射:', JSON.stringify(sess._speakerVoiceMap));
}

// ===== 启动配音（通用入口）=====
async function startDubbing(sess, btn, getRawSegments, videoId, title) {
  await _settingsLoaded;   // 见上面定义处注释：避免设置还没读完就用默认女声发出第一批请求
  const fastLocalCacheStart = !!sess._startFromLocalCacheFast;
  const playbackReady = fastLocalCacheStart
    ? true
    : await waitForActualVideoPlayback(sess.video, 8000);
  if (!playbackReady) {
    if (btn) {
      btn.textContent = sess._readMode ? '🔊等待播放' : '🎧等待播放';
      btn.title = '视频尚未正常播放，暂不启动脚本';
    }
    sess.started = false;
    return;
  }
  sess.started = true;
  sess._userPaused = false;
  sess.dubSegments = [];
  sess.videoId = videoId;
  sess.title = title;
  // 从启动第一刻就执行用户设置的原声音量，不能等到首批配音就绪后才压低。
  // 性别取样直接分析音轨数据，不需要把扬声器原音临时放大给用户听。
  try { sess.video.volume = sess._readMode ? 0 : origVolume; } catch (_) {}
  sess._exportsFinalized = false;
  // 在这一刻（这个视频刚开始配音）记下播放列表序号，供导出文件名用。不要在导出
  // （stopDubbing）时才读，那时URL可能已经被autoDub切到下一个视频了。
  // 优先用播放列表侧边栏面板里这个视频自己链接上的index——那是它在列表里的固定
  // 位置，不随"你实际点开的顺序"变化；当前页面URL的&index=反映的是"你刚点进来时
  // 走的那条路径"，如果中途跳着看（先看第3个、又跳回第1个），同一个视频在不同
  // 时刻进来时URL的index可能不一样，靠它命名文件会让同一个视频前后导出成不同编号。
  sess._playlistIndex = getCanonicalPlaylistIndex(videoId)
    || (() => { try { return new URLSearchParams(location.search).get('index') || null; } catch (_) { return null; } })();
  sess._allDone = false;
  sess._displaySegments = null;
  sess._maxSynthedTime = 0;     // 已合成到的最大时间点（合成前沿）
  sess._synthDone = false;      // 全部合成完成
  sess._buffering = false;      // 是否正因合成落后而暂停缓冲
  sess._audioLoading = false;   // 是否有一段音频正在异步加载（同步防重叠锁）
  sess._seekEpoch = 0;          // 时间轴纪元，每次 seek +1，作废加载中的旧段
  sess._rawSubtitles = null;    // 原始字幕（处理前）
  sess._asrSubtitles = null;    // ASR 拆割后的字幕
  sess._hasMerged = false;      // 是否有字幕合并
  sess._asrPolling = null;      // ASR 轮询任务的定时器
  sess._phase = 'preparing';    // preparing → dubbing → done
  sess._startTs = Date.now();
  sess._recordPausedMs = 0;
  sess._networkPauseStartedAt = null;
  sess._networkRecoveryPaused = false;
  sess._networkShouldResumeVideo = false;
  sess._skipStartupPause = false;
  // 开头必须先确认前三句“实际可以发声”，而不是只看服务器回了 URL。
  // 该标记只保护归零启动/归零 seek；中后段继续沿用“不断视频、缺句后补”。
  sess._startupGatePending = false;
  sess._webSpeechActive = false;
  sess._recordingSegmentStarted = false;
  function fail(reason, err) {
    console.error('[配音插件]', reason, err || '');
    if (sess._initTimer) { clearInterval(sess._initTimer); sess._initTimer = null; }
    if (btn) { btn.textContent = sess._readMode ? '🔊失败' : '🎧失败'; btn.title = (sess._readMode ? '朗读失败：' : '配音失败：') + reason; }
    sess.weArePausing = false;
    sess._startupGatePending = false;
    showBufferIndicator(`⚠️ ${reason}`, sess.video);
    setTimeout(hideBufferIndicator, 8000);
    sess.started = false;
    // 配音失败时恢复视频播放，避免卡在启动暂停状态
    if (sess._resumeAfterStart !== false) { try { sess.video.play().catch(() => {}); } catch (_) {} }
  }

  // "原本是否在播放"决定首批就绪后会不会自动续播——这里一直是反复出问题的地方：
  // 单靠某一瞬间的 video.paused 判断不可靠，播放列表切视频前后视频本身就容易有
  // 短暂缓冲/卡顿，哪怕autoDub的检测循环看到"没暂停"才点了按钮，紧接着这一刻
  // video.paused 完全可能因为缓冲又短暂变true——错误记成"原本就是暂停的"，
  // 导致首批就绪后走到"等用户手动按播放键"那条分支。autoDub场景没人会去手动按，
  // 这个视频就会卡死在暂停状态，连带播放列表后面的视频也触发不了（这个视频的
  // sess.started 一直是true，停不下来）。
  // 这次是脚本模拟点击触发的（_isPlaylistAutoContinue），根本不存在"用户手动暂停后
  // 才点按钮"这种使用场景，直接当成"原本在播放"，不要去赌那一瞬间的 video.paused。
  sess._resumeAfterStart = (sess._forceResumeAfterCacheStart || sess._isPlaylistAutoContinue)
    ? true
    : !sess.video.paused;
  // 播放列表连续配音：不同视频说话人可能不同性别，但配音员设置是全局的，一直用
  // 同一个声音配所有视频。这里在视频还没被下面暂停掉之前（必须趁它还在正常出声）
  // 抽样一下原声音高，自动判断男女声、选对应配音员，不用每个视频手动切配音员设置。
  // 只在这个自动场景做：手动点按钮配音时尊重用户在popup里手动选的配音员，不覆盖。
  // 这一步绝对不能卡住/中断后面的配音流程——分辨不出男女声就用默认配音员继续，
    // 而不是让识别失败变成"整个视频不配音了"。外面再包一层超时兜底。
  sess._autoVoice = null;
  // 不能在启动时遍历 IndexedDB 的整库来猜音色：长视频/多次测试后缓存可能有数千段，
  // 这会让“字幕已命中”之后仍卡在准备中。首批按段缓存命中时会立即采用其中的声音
  // （见 processDubbingChunked），不需要为猜音色阻塞当前前三句。
  const forcedVoice = isChineseDubVoice(sess._forcedDubVoice) ? sess._forcedDubVoice : null;
  sess._cachedVoice = forcedVoice || null;
  if (forcedVoice) {
    sess._autoVoice = forcedVoice;
    sess._shouldAutoDetectVoice = false;
    console.log(`[配音插件] 本轮已锁定配音员：${forcedVoice}`);
  }
  if (!forcedVoice && !fastLocalCacheStart && (sess._isPlaylistAutoContinue || sess._shouldAutoDetectVoice)) {
    sess._shouldAutoDetectVoice = false;
    // 只快速检测一轮；识别失败立即使用默认配音员，绝不能阻塞配音。
    for (let round = 0; playbackReady && round < 1 && !sess._autoVoice && !sess._cachedVoice; round++) {
      try {
        sess._autoVoice = await detectSpeakerGender(sess.video);
      } catch (e) {
        console.warn('[配音插件] 自动判断说话人性别异常', e);
      }
      if (!sess.started || sess.videoId !== videoId) return;
    }
    if (!sess._autoVoice) {
      sess._autoVoice = getDefaultChineseDubVoice();
      sess._skipStartupPause = false;
      sess._resumeFromCurrentPosition = false;
      showBufferIndicator('⚠ 未识别人声，立即使用中文默认配音员继续', sess.video);
      setTimeout(() => hideBufferIndicator(), 2500);
      console.warn('[配音插件] 未检测到男女声，立即使用中文默认配音员继续：',
        sess._autoVoice);
    } else {
      sess._skipStartupPause = false;
    }
  }
  // 配音一启动就暂停视频并提示——取字幕+合成需要时间（被限流时更久），
  // 在此期间让画面停住，避免"视频先播一段、再突然跳回 0 暂停"的突兀感。
  sess.weArePausing = !sess._skipStartupPause;
  if (!sess._skipStartupPause) {
    try { sess.video.pause(); } catch (_) {}
    showBufferIndicator(sess._readMode ? '🔊 朗读正在启动，请稍候…' : '🎧 配音正在启动，视频已暂停，请稍候…', sess.video);
  }
  let rawSegments = await getCachedSubs(videoId);
  if (rawSegments?.length) {
    console.log('[配音插件] 启动时命中本地字幕缓存，跳过重新取字幕');
    captionsReadyForVideo(videoId, rawSegments);
  } else if (btn) {
    btn.textContent = sess._readMode ? '🔊取字幕…' : '🎧取字幕…';
    btn.title = '正在获取字幕';
  }
  if (!rawSegments?.length) {
    try {
      rawSegments = await Promise.race([
        getRawSegments(),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('字幕获取超过150秒，已停止等待')), 150000)),
      ]);
    } catch (e) {
      return fail(`取字幕失败：${e?.message || '请求异常'}。请刷新视频页面后重试`);
    }
  }
  if (!rawSegments || !rawSegments.length) {
    // 没拿到字幕，常见原因是请求令牌过期或被限流（见 fetchChineseFromPotUrl 注释，
    // 已不再用浏览器直连硬撞这两种情况）。这两种都是"刷新页面拿全新令牌/换个时机"
    // 才有用，不是代码这边重试能解决的，所以直接提示用户刷新，而不是自己死磕重试。
    return fail('未获取到字幕，请打开“自动翻译→配音指定字幕”后重试');
  }

  // 完整保留平台返回的原始字幕事件，供排查“字幕源本来重复”还是“脚本重复播放”。
  // 这份账本必须早于音效过滤、滚动去重和合句；后续任何处理都不能覆盖它。
  sess._sourceRawSubtitles = buildSourceSubtitleLedger(rawSegments, 'platform_raw');

  // 所有字幕来源在任何滚动去重/合句之前统一清除音效标记。服务器缓存和本地缓存
  // 返回的是已解析segments，不一定经过parseTimedText里的过滤；旧顺序先合句，
  // 会把独立“音乐”拼进前后正文（如“我花了20年时间研究”+“音乐”），之后就
  // 再也无法判断它原本只是音效标签。这里只删除整条纯标记，正常正文“我喜欢音乐”
  // 不受影响。
  const beforeNonSpeechFilter = rawSegments.length;
  rawSegments = rawSegments
    .map((s) => ({
      ...s,
      text: sanitizeDubbingText(stripNonSpeechMarker(String(s.text || ''))),
    }))
    .filter((s) => s.text);
  if (rawSegments.length !== beforeNonSpeechFilter) {
    console.log(`[配音插件] 合句前已删除 ${beforeNonSpeechFilter - rawSegments.length} 条纯音乐/音效标记`);
  }
  if (!rawSegments.length) return fail('字幕全部是音乐/音效标记，无可配音正文');

  // 留存字幕源开头事件，作为“第一、二句到底是不是实际字幕”的可核查证据。
  // 后续去滚动、合句和送配音都不能覆盖这份原始时间轴记录。
  sess._sourceOpeningSegments = rawSegments
    .filter((s) => (s.start || 0) < 20)
    .slice(0, 16)
    .map((s) => ({ start: +(+s.start || 0).toFixed(3), end: +(+s.end || 0).toFixed(3), text: s.text }));
  recordDiagnostic(sess, 'subtitle_source_opening_events', {
    count: sess._sourceOpeningSegments.length,
    events: sess._sourceOpeningSegments,
  });
  console.log('[配音插件] 字幕源开头事件（配音前，不做文字去重）：', sess._sourceOpeningSegments);

  // 去掉滚动字幕的渐进重复 cue（见 dedupRollingCaptions 注释），两种模式都要做——
  // 配音模式即使后面会合并整句，重叠的重复 cue 也会让合并逻辑产生错误的时间窗。
  rawSegments = dedupRollingCaptions(rawSegments);

  // 诊断：输出原始字幕的时间戳
  console.log('[配音插件] 原始字幕时间戳（前10条）：');
  for (let i = 0; i < Math.min(10, rawSegments.length); i++) {
    console.log(`  [${i}] ${rawSegments[i].start.toFixed(2)}s - ${rawSegments[i].end.toFixed(2)}s: ${rawSegments[i].text.substring(0, 30)}`);
  }

  // 过滤音效注释：[音乐]【掌声】(Music) 等。整条只是注释 → 丢弃；
  // 行内夹带 → 去掉注释保留正文。
  const annOnly = /^[\s\[\]【】()（）]*[\[【(（][^\]】)）]*[\]】)）][\s\[\]【】()（）]*$/;
  rawSegments = rawSegments
    .map((s) => ({ ...s, text: s.text.replace(/[\[【(（][^\]】)）]{0,12}[\]】)）]/g, '').trim() }))
    .filter((s) => s.text && !annOnly.test(s.text));
  if (!rawSegments.length) return fail('字幕全是音效注释，无可朗读内容');

  // 配音模式才去口头填充词（嗯/呃/唔/诶 等）；朗读模式原文照读，不动文本。
  if (!sess._readMode) {
    const FILLER = '嗯呃唔诶呣';
    const fillerRe = new RegExp(`[${FILLER}]+[，、。．.…!！?？~～\\s]*`, 'g');
    rawSegments = rawSegments
      .map((s) => ({ ...s, text: s.text.replace(fillerRe, '').trim() }))
      .filter((s) => s.text);
    if (!rawSegments.length) return fail('字幕去除填充词后无可朗读内容');
  }

  // 检测字幕语言：CJK 占比 > 30% 视为中文字幕，无需 API 翻译。
  // 注意：勾选了"Gemini翻译"时这个检测完全不作数——这时取来的就是故意要的原文，
  // 而且日语/韩语等本身大量使用汉字，CJK占比一样会很高，会被这个简单的字符
  // 范围判断误判成"已经是中文"，导致明明想走Gemini重翻译却被当成中文直接照读。
  // 所以勾了这个选项就无条件走Gemini路径，不看cjkRatio。
  const sample = rawSegments.slice(0, 8).map(s => s.text).join('');
  const cjkRatio = [...sample].filter(c => c >= '一' && c <= '鿿').length / Math.max(sample.length, 1);
  // 自动续播拿不到YouTube中文字幕时允许退回原文字幕，并强制走现有Gemini翻译。
  // 这是按当前session设置，不会改动用户的全局复选框。
  // 是否调用Gemini只认用户复选框；session备用标志无权越过费用开关。
  const shouldTranslateOriginal = !!useGeminiTranslate;
  const isChinese = !shouldTranslateOriginal && cjkRatio > 0.3;
  // 配音模式：非中文（没拿到自动翻译中文字幕）→ 直接停，不走 API 翻译省 token。
  // 但用户在弹窗勾选了"Gemini翻译"时例外：这次发的就是原文（不是YT翻译过的），
  // 故意不要求中文，交给服务器用 Gemini 重新翻译——通常是YT自动翻译质量太差
  // （比如日语→中文这类二手翻译听不懂）才会勾这个选项。
  // 朗读模式：忠实朗读用户选中的字幕轨，无论语言，不做此拦截。
  // 中文检测仅用于配音模式（决定是否翻译/拦截）。朗读模式与中文无关，直接跳过。
  if (!sess._readMode) {
    if (!isChinese && !shouldTranslateOriginal) {
      if (btn) { btn.textContent = '🎧重试'; btn.title = '未获取到字幕，请打开“自动翻译→配音指定字幕”后重试'; }
      sess.started = false;
      showBufferIndicator('⚠ 未获取到字幕，请打开“自动翻译→配音指定字幕”后重试。', sess.video);
      console.warn('[配音插件] 未获取到字幕，已停止且未调用Gemini。');
      return;
    }
    sess._subtitleMode = isChinese ? 'zh' : 'gemini';
    if (isChinese) {
      console.log(`[配音插件] 字幕语言检测：CJK占比${(cjkRatio * 100).toFixed(0)}% → 中文字幕（不耗API）`);
      if (btn) btn.title = '中文字幕模式（不耗API）';
    } else {
      console.log('[配音插件] 非中文字幕，已勾选Gemini翻译，将对原文重新翻译（耗API）');
      if (btn) btn.title = 'Gemini翻译模式（耗API，原文已发给服务器重新翻译）';
    }
    // 配音：TTS 自然语速（base_rate=0），每句在播放端按窗口对齐。
    sess._baseRatePct = 0;
    console.log('[配音插件] 每句独立对齐模式：base_rate=0，视频随句变速贴合 TTS 时长');
  }

  // 字幕显示策略：
  // - YouTube 默认用原生字幕（时间窗与画面天然对齐）
  // - 若服务端返回了 asr_segments（字幕被合并过），改为自绘字幕用 ASR 时间戳
  //   （确保"一句配音"与"多行字幕原始行"逐行对齐）
  // - 非 YouTube（B站）一直用自绘，配音时更新为 asr_segments（若有）或原始分段
  // 配音文本独立于字幕显示，只影响朗读、不影响屏幕字幕——彻底解耦。

  // 先记录原始字幕用于后续 ASR 处理
  sess._rawSubtitles = rawSegments.map((s) => ({ start: s.start, end: s.end, text: s.text }));

  if (sess._readMode) {
    // 朗读模式：忠实按字幕时间窗朗读，不合并。平均朗读速度 = 总字数/总时长，
    // 据此设 base_rate（窗口紧张时再由播放端提速，宽松用平均速度）。
    sess._baseRatePct = calcBaseRatePct(rawSegments);
    // 整体视频调速：按字幕语言估算自然语速跟现有时间窗的匹配程度，
    // 提前把视频整体调慢/调快，优先保证朗读跟得上字幕（原声已静音，明显变速也可接受），
    // 减少逐句靠语音提速兜底的幅度。
    const paceRatio = estimateReadPaceRatio(rawSegments, sess._readLang);
    sess._readVideoRate = computeReadVideoRate(paceRatio);
    console.log(`[朗读] 忠实时间轴朗读，共 ${rawSegments.length} 段，平均语速 base_rate=${sess._baseRatePct}%，`
      + `语速比=${paceRatio.toFixed(2)}，视频调速=${sess._readVideoRate.toFixed(2)}x`);
  } else {
    const before = rawSegments.length;
    // 把碎片字幕按标点合并成完整句子再配音：避免一句话被拆成两段读。
    // 字幕跟随配音段（curSegment）显示，合并后屏幕字幕自动变成整句。
    rawSegments = groupChineseSentences(rawSegments);
    rawSegments = pruneExcessYesFillers(rawSegments, '配音字幕');
    if (!rawSegments.length) return fail('字幕清理后无可配音正文');
    sess._hasMerged = before > rawSegments.length;
    console.log(`[配音插件] 按句合并：${before} 行 → ${rawSegments.length} 句`);
    // 全局视频调速：跟朗读模式同一个思路——提前算一个全视频统一的基准速率，而不是
    // 每句都从 1.0x 重新猜。之前的逐句独立调速会出现"这句1.0x、下句0.85x、再下句又
    // 跳回1.0x"这种忽快忽慢，因为每句播完都会恢复到硬编码的 1.0x。现在播完恢复到这个
    // 统一基准（见 defaultVideoRate），只有个别句子在基准之上还不够时才临时再降一点。
    const dubPaceRatio = estimateReadPaceRatio(rawSegments, 'zh');
    sess._dubVideoRate = computeReadVideoRate(dubPaceRatio);
    console.log(`[配音插件] 全局视频调速：语速比=${dubPaceRatio.toFixed(2)}，统一基准=${sess._dubVideoRate.toFixed(2)}x`);
  }
  rawSegments = rawSegments.map((s, i) => ({
    ...s,
    _sourceIndex: Number.isFinite(Number(s._sourceIndex)) ? Number(s._sourceIndex) : i,
  }));
  sess._processedSourceSubtitles = buildSourceSubtitleLedger(
    rawSegments,
    sess._readMode ? 'read_timeline' : 'dub_sentence_timeline');

  // 自绘字幕的回退分段也用合并后的整句，避免播放间隙显示碎片旧行
  sess._displaySegments = rawSegments.map((s) => ({ start: s.start, end: s.end, text: s.text }));

  const video = sess.video;

  // 绑定全功能 timeupdate（配音阶段用）
  function attachDubbingListeners() {
    sess._onTimeUpdate = () => {
      if (!sess.dubSegments) return;
      // YouTube切视频、恢复播放或其它内部逻辑可能把volume重置。配音运行期间
      // 持续守住用户设置值（例如5%），避免配音突然开始时原声又跳回100%。
      const expectedVolume = sess._readMode ? 0 : origVolume;
      if (!sess._userPaused && Math.abs(sess.video.volume - expectedVolume) > 0.001) {
        try { sess.video.volume = expectedVolume; } catch (_) {}
      }
      const t = video.currentTime;
      // 看门狗：curAudio 已结束/被异常暂停（非我方主动暂停、非缓冲）却没被清，
      // 会让 playNextDue 永久 early-return → 后续全程没声音。这里兜底清掉并恢复调度。
      // 还加了"早就该播完却还没结束"的超时判断（_curAudioDeadline）——有些卡死场景
      // audio 既不报 ended 也不报 paused（解码卡住但浏览器没触发任何事件），光查
      // ended/paused 抓不到，这种"看起来在播、其实卡死"才是用户反馈"卡一分钟没声音"的真因。
      if (sess.curAudio && !sess._buffering && !sess.weArePausing &&
          (sess.curAudio.ended || (sess.curAudio.paused && !video.paused) ||
           (sess._curAudioDeadline && Date.now() > sess._curAudioDeadline))) {
        if (!sess.curAudio.ended && !(sess.curAudio.paused && !video.paused)) {
          console.warn('[配音插件] curAudio 超时未结束（疑似卡死），强制清掉恢复调度');
          try { sess.curAudio.pause(); } catch (_) {}
        }
        sess.curAudio = null; sess.curSegment = null;
      }
      // 合成跟不上播放时，暂停视频缓冲，等合成前沿超过当前时间再继续，
      // 避免视频跑到未合成区域导致后到的句子被当作"已播"而丢句。
      if (maybeBufferForSynthesis(sess, t)) return;
      repairEarlyDubbingWindow(sess, t);
      sampleDiarization(sess);
      playNextDue(sess, t);
      prefetchAhead(sess, t);
      if (IS_YOUTUBE) maybePrefetchNextPlaylistCaptions(video);
      prunePlayedAudioCache(sess, t);
      trimPersistedFutureAudioPayloads(sess, t, 'timeupdate');
      // 结尾不再主动减慢视频。若尾音略长于画面，就保持最后一帧，等待配音自然说完；
      // 这样观感比明显慢放更自然，也更接近用户期望。
      // 字幕显示：自绘覆盖层（所有平台）
      if (sess._displaySegments) { updateSubtitle(sess); positionSubtitleEl(sess); }
    };
    sess._onResize = () => { if (sess._displaySegments) positionSubtitleEl(sess); };
    window.addEventListener('resize', sess._onResize);
    // 字幕框位置算的是视口坐标（跟着视频的 getBoundingClientRect 走）——光靠
    // timeupdate 时跟着更新，视频暂停时滚动页面会跟丢一下，加个 scroll 监听兜底。
    window.addEventListener('scroll', sess._onResize, { passive: true });
    sess._onSeeking = () => {
      if (!sess.dubSegments) return;
      const t = video.currentTime;
      // 纪元 +1：让加载中的旧段在 .then 里发现位置已变而自动作废，避免错位/重叠
      sess._seekEpoch = (sess._seekEpoch || 0) + 1;
      const seekEpoch = sess._seekEpoch;
      sess._audioLoading = false;
      if (sess.curAudio) {
        try { sess.curAudio.pause(); } catch (_) {}
        // 释放被打断段的 blob 和缓存，否则泄漏且下次取到已失效的缓存元素
        try { if (sess.curAudio.src?.startsWith('blob:')) URL.revokeObjectURL(sess.curAudio.src); } catch (_) {}
        if (sess.curSegment) delete sess.audioCache[sess.curSegment.audio_url];
        sess.curAudio = null; sess.curSegment = null;
      }
      try { window.speechSynthesis?.cancel(); } catch (_) {}  // 跳转了，旧位置的兜底语音不能再念
      setVideoRate(sess, defaultVideoRate(sess));  // 防御性复位到默认速率
      sess.bufferMissCount = 0;
      sess._synthMiss = 0;        // 重置合成宽限计数（跳转后重新计）
      sess._recentSpoken = [];  // 跳转后旧的"最近念过"记录不再适用
      hideBufferIndicator();
      // 只标记已**完全播过**的段落（end < t）为已播，新位置的段落保持未播。
      // 以原字幕时间轴判断是否已经完全播过；不能因 TTS 比字幕短而提前跳过。
      for (const seg of sess.dubSegments) {
        seg.played = segmentTimelineEnd(seg) < t;
        if (!seg.played) delete seg._skippedStale;
      }
      if (sess._phase === 'preparing') {
        recordDiagnostic(sess, 'startup_seek_ignored_until_voice_locked', {
          currentTime: +(t || 0).toFixed(3),
          cachedVoice: sess._cachedVoice || '',
        });
        return;
      }
      // 快进后先把本地缓存挂回当前窗口，再对新位置优先合成，避免明明已有缓存却还去等服务器。
      const shouldHoldAtStart = t < 2.2;
      if (shouldHoldAtStart) {
        sess._startupGatePending = true;
        sess._buffering = true;
        sess.weArePausing = true;
        try { sess.video.pause(); } catch (_) {}
        showBufferIndicator('🎧 正在对齐开头配音…', sess.video);
      }
      const releaseStartSeekWhenPlayable = async () => {
        if (!sess.started || sess._seekEpoch !== seekEpoch || video.currentTime >= 2.2) return;
        const restored = await hydrateLocalCacheWindow(sess, video.currentTime || 0, 1.5, 300).catch(() => 0);
        if (restored) {
          recordDiagnostic(sess, 'seek_zero_local_cache_restored_before_gate', {
            currentTime: +(video.currentTime || 0).toFixed(3),
            restored,
            cachedVoice: sess._cachedVoice || '',
          });
          primeStartupAudio(sess, video.currentTime || 0);
        }
        const ready = await startupAudioGateReady(sess, video.currentTime || 0);
        if (ready) {
          sess._startupGatePending = false;
          sess._buffering = false;
          sess.weArePausing = false;
          hideBufferIndicator();
          try { await video.play(); } catch (_) {}
          kickDubbingAfterSeek(sess, video.currentTime || 0);
          recordDiagnostic(sess, 'seek_zero_audio_gate_released', { currentTime: +(video.currentTime || 0).toFixed(3) });
          return;
        }
        const missing = (sess._allSegments || []).find((seg) => {
          if (seg.start < (video.currentTime || 0) - 0.5) return false;
          const item = (sess.dubSegments || []).find((candidate) => _segKey(candidate) === _segKey(seg));
          return !item?.audio_url || !sess.audioCache?.[item.audio_url] || item._invalidAudio;
        });
        if (missing) requestRealtimeCurrentSentenceRepair(sess, missing, video.currentTime || 0);
        showBufferIndicator('🎧 正在恢复开头前三句配音…', video);
        setTimeout(releaseStartSeekWhenPlayable, 300);
      };
      if (!shouldHoldAtStart) {
        hydrateLocalCacheWindow(sess, t, 12, 240)
          .catch(() => 0)
          .finally(() => {
            requestSynthAround(sess, t);
            prefetchAhead(sess, t);
          });
      }
      // 反复快进快退时，每次拖动都会触发上面这些、但中间状态的请求大多会被新的
      // seekEpoch 作废——只在"用户停下来不再拖了"这一刻才真正要紧。这里加个停顿
      // 后的兜底：停止拖动 280ms 后，主动检查一次缓冲状态 + 踢一次播放调度，
      // 不依赖视频是不是还在走 timeupdate（万一刚好定格在暂停状态，也能补上）。
      clearTimeout(sess._seekSettleTimer);
      sess._seekSettleTimer = setTimeout(() => {
        if (!sess.started) return;
        const tt = sess.video.currentTime;
        if (tt < 2.2) return releaseStartSeekWhenPlayable();
        if (maybeBufferForSynthesis(sess, tt)) return;
        playNextDue(sess, tt);
      }, 280);
    };
    sess._onPause = () => {
      // HTML video自然播放结束时也会触发pause事件。此时最后一句配音必须继续说完，
      // 不能按“用户手动暂停”处理，否则音频会被暂停，30秒后收尾逻辑只能强制裁掉。
      if (video.ended) {
        console.log('[配音插件] 视频画面已自然结束，保留最后一句配音继续播放');
        return;
      }
      // 注意：不能用 sess.weArePausing 挡住这里——之前若该标记在缓冲流程里
      // 残留为 true（如缓冲刚结束、状态还没来得及复位），用户这时手动暂停视频，
      // 旧逻辑会被错误跳过，导致"视频停了、朗读音频还在继续念"。
      // 停止朗读音频不依赖任何内部标志，只要视频暂停就无条件停，最安全。
      // 关键修复：能走到这里说明这段音频是被"中途打断"的（正常念完会走 onended，
      // 那里才会清掉 curAudio/curSegment）——这段早先在 playNextDue 里已经被标记
      // played=true，如果这里不把它改回 false，续播时会被当成"已经读过"直接跳过，
      // 表现就是"暂停再播放，少读了一两句"。这里改回 false，续播时会重新选中它、
      // 从头重念这一句（保证一定能听到，比漏读体验好得多）。
      if (sess.curAudio) {
        try { sess.curAudio.pause(); } catch (_) {}
        if (sess.curSegment) sess.curSegment.played = false;
        sess.curAudio = null; sess.curSegment = null;
      }
      // 同样的道理：还在异步加载中、还没真正赋给 curAudio 的那一句（见 _pendingSeg）
      // 也要重置，否则它会卡在"已播"状态、续播时被跳过——这是另一种"少读一句"的成因。
      if (sess._pendingSeg) {
        sess._pendingSeg.played = false;
        sess._pendingSeg = null;
        sess._audioLoading = false;
      }
      // 视频暂停，朗读必须跟着停——包括云端TTS失败时退到的浏览器自带语音
      // （speakWithWebSpeech 是独立播放的，不会跟着 curAudio 一起暂停，得单独喊停）。
      try { window.speechSynthesis?.cancel(); } catch (_) {}
      sess._webSpeechActive = false;
      // 防御：若暂停时正处于变速状态，恢复默认速率，避免续播后卡在错误速度
      try { sess.video.playbackRate = defaultVideoRate(sess); } catch (_) {}
    };
    // 用户把原生暂停的视频重新播放后，按理 timeupdate 会自己续上调度，
    // 但这里加一道主动踢一脚兜底（防"暂停了一段时间再播"卡住没声音）。
    sess._onPlay = () => {
      if (sess.weArePausing) {
        // 见 onFirstChunkReady 里 _readyForManualResume 的注释：首批已就绪、
        // 只是在等用户自己按播放键——这次真实的play事件就是用户按下了，放行并
        // 真正清掉 weArePausing，否则配音会永远卡在"已就绪但从不开始"。
        if (!sess._readyForManualResume) return;
        sess._readyForManualResume = false;
        sess.weArePausing = false;
        hideBufferIndicator();
      }
      markPlaybackStart(sess);   // 用户手动续播这一刻才真正开始录/计时，同样要避开等待期的静音
      const t = video.currentTime;
      kickDubbingAfterSeek(sess, t, 8);
      prefetchAhead(sess, t);
    };
    // ended 通常比播放列表切换 URL 早一点到达。稍等一小段时间：若期间检测到
    // videoId 变化，看门狗会用 keepRecordingForNextVideo=true 切分文件并取消本计时；
    // 若确实是列表末尾，则延时到点后关闭捕获流。
    sess._onEnded = () => {
      clearTimeout(sess._endFinalizeTimer);
      const deadline = Date.now() + 30000;
      const waitForLastVoice = async () => {
        if (sess.curAudio && !sess.curAudio.ended && Date.now() < deadline) {
          console.log('[配音插件] 视频画面已结束，等待最后一句配音说完后再停止录制');
          sess._endFinalizeTimer = setTimeout(waitForLastVoice, 500);
          return;
        }
        try {
          await repairDubbing(sess, btn, { resumeAfter: false, silent: true });
        } catch (e) {
          console.warn('[配音插件] 视频结束后补漏失败，仍继续结束会话', e?.message || e);
        }
        showMissedRealtimeSummary(sess);
        sess._endFinalizeTimer = setTimeout(() => stopDubbing(sess, btn, false), 300);
      };
      waitForLastVoice();
    };
    video.addEventListener('timeupdate', sess._onTimeUpdate);
    video.addEventListener('seeking', sess._onSeeking);
    video.addEventListener('pause', sess._onPause);
    video.addEventListener('play', sess._onPlay);
    video.addEventListener('ended', sess._onEnded);
  }

  // 开始真正配音/朗读（取样确认后 或 单人模式直接调用）
  function beginDubbing() {
    sess._startupGatePending = !sess._skipStartupPause;
    sess._dubButton = btn || null;
    sess._startedFromBeginning = !sess._resumeFromCurrentPosition;
    sess._watchedFiveFullCacheLogged = false;
    sess._knownFullLocalCache = false;
    // 朗读：静音原视频（朗读音频独立全音量）；配音：压低原音
    video.volume = sess._readMode ? 0 : origVolume;
    // 保留 CC：不自动关闭，由用户手动控制。配音时插件自绘中文覆盖层；朗读时显示原生 CC。
    // 字幕显示改回自绘（更可控）。若有 ASR 结果会自动用 ASR 时间戳更新。
    attachDubbingListeners();
    // 朗读模式按钮文案由"初始化倒计时/首段出声"接管，这里不覆盖
    if (btn && !sess._readMode) {
      clearRealtimeCacheButtonStyle(btn);
      btn.textContent = `🎧${sess._subtitleMode === 'zh' ? '📝字幕' : '🌐翻译'}`;
    }

    video.playbackRate = sess._readMode ? (sess._readVideoRate || 1.0) : 1.0;
    sess._rateLog = [];   // 每次fresh start都从头记变速日志，不跨session累积
    sess._subtitleLog = [];
    sess._recentSpoken = [];
    // 注意：sess._recordStartWallClock 不在这里清空/重置——录音（如果勾了自动导出）
    // 已经在点击配音/朗读按钮那一刻启动（见 startRecordingOnClick），这里再清空会让
    // markPlaybackStart 之后重新赋一个新值，跟录音文件的真实起点对不上，导出的字幕/
    // 变速日志会和录音错位。streamId 只有几秒有效期，等不到这里（还要经过取字幕等
    // 异步流程）才启动，只能接受录音开头会带一小段等待中的静音。
    // 默认每次点"开始配音"都归零重播（左键按钮的行为，跟过去一致，避免改变
    // 大多数人熟悉的默认体验）。长视频中途断了、不想从头重新听一遍时，右键菜单
    // 选"从当前位置配音"会把 sess._resumeFromCurrentPosition 设成true，这里就
    // 跳过归零，保留视频当前停留的位置（不管是用户手动跳转到的，还是YouTube自己
    // "继续观看"恢复的）。不管哪种情况，下面那套"暂停+等首批就绪再续播"的逻辑
    // 都照常生效——会先等这个位置附近的配音准备好（服务器对已经配过的句子有按
    // 时间戳+音色的磁盘缓存，见 dub9.synthesize_segment，之前配过的部分会很快
    // 命中缓存，不是从头慢慢重新合成）才自动续播，避免"视频空播追不上配音"。
    if (!sess._resumeFromCurrentPosition) video.currentTime = 0;
    sess._startedFromBeginning = !sess._resumeFromCurrentPosition || (video.currentTime || 0) < 5;

    // 视频已在 startDubbing 开头暂停；这里沿用「原本是否在播放」决定第一段就绪后是否续播
    const wasPlaying = sess._resumeAfterStart !== false;
    sess.weArePausing = !sess._skipStartupPause;
    if (!sess._skipStartupPause) {
      try { video.pause(); } catch (_) {}
      showBufferIndicator('🎧 配音正在启动，视频已暂停，请稍候…', video);
    }

    async function onFirstChunkReady() {
      // “首批生成”不等于“首批可以播放”。先验证前三句已经在本机解码；失败时
      // 保持开场暂停、以极短间隔修复，而不是让视频先走八秒再发现开头漏配音。
      const startupTime = video.currentTime || 0;
      primeStartupAudio(sess, startupTime);
      let startupReady = await startupAudioGateReady(sess, startupTime);
      if (!startupReady) {
        if (!sess._startupGateFirstWaitAt) sess._startupGateFirstWaitAt = Date.now();
        const waitedMs = Date.now() - sess._startupGateFirstWaitAt;
        const cacheCanCarry = _hasForwardDubCache(sess, startupTime, 45);
        if (cacheCanCarry && waitedMs >= 5000) {
          startupReady = true;
          recordDiagnostic(sess, 'startup_audio_gate_timeout_released_with_forward_cache', {
            currentTime: +startupTime.toFixed(3),
            waitedMs,
            cachedSegments: sess.dubSegments?.length || 0,
            maxSynthedTime: +(sess._maxSynthedTime || 0).toFixed(3),
          });
          console.warn('[配音插件] 开场解码等待超时，但已有缓存可接力，先启动播放并后台补缺');
        }
      }
      if (!startupReady) {
        const firstMissing = (sess._allSegments || []).find((seg) => {
          if (seg.start < startupTime - 0.5) return false;
          const ready = (sess.dubSegments || []).find((item) => _segKey(item) === _segKey(seg));
          return !ready?.audio_url || !sess.audioCache?.[ready.audio_url] || ready._invalidAudio;
        });
        if (firstMissing) requestRealtimeCurrentSentenceRepair(sess, firstMissing, startupTime);
        showBufferIndicator('🎧 正在验证开场配音，视频将从第一句开始播放…', video);
        recordDiagnostic(sess, 'startup_audio_decode_gate_wait', {
          currentTime: +startupTime.toFixed(3),
          cachedSegments: sess.dubSegments?.length || 0,
        });
        setTimeout(() => {
          if (sess.started && sess.weArePausing && sess.videoId === videoId) onFirstChunkReady();
        }, 300);
        return;
      }
      sess._startupGateFirstWaitAt = null;
      sess._phase = 'dubbing';
      sess._startupGatePending = false;
      // 捕获流在用户授权时已经占用，但准备阶段数据全部丢弃；从第一批配音真正就绪
      // 这一刻重新开一个干净分段，最终文件无需裁切前面的等待过程。
      await beginCleanRecordingSegment(sess);
      // 准备字幕/翻译期间，录制流只是为保留tabCapture权限而占位。状态巡检从
      // 第一批配音真正就绪后再开始，避免每15秒刷录音信息掩盖启动问题。
      startRecordingStatusMonitor(sess);
      // 这次没走到"用户提前选好字幕、纯被动监听"的理想路径，靠脚本自己点CC/服务器
      const fallbackTip = '';
      if (wasPlaying && sess.weArePausing) {
        sess.weArePausing = false;
        markPlaybackStart(sess);   // 真正要续播了才开始录/计时——避免录进"等首批就绪"这段空播的静音
        video.play().catch(() => {});
        hideBufferIndicator();
        setTimeout(() => kickDubbingAfterSeek(sess, video.currentTime || startupTime, 8), 80);
      } else if (sess.weArePausing) {
        // 点配音那一刻视频本来就是暂停的，按设计不会自动续播（不替用户做决定）——
        // 但用户没法从按钮文字一眼看出"已经可以播放了"，加个提示明确告诉一下，
        // 免得以为还在"生成中"、傻等永远不会到来的自动播放。这种情况录音留给用户
        // 自己按播放键时再启动（见 sess._onPlay），不在这里启动。
        // 注意：weArePausing 这里故意先不清掉（不然提前清了，"还没真正按下播放"
        // 这段空档也会被当成已经在播，提前出声）——靠 _readyForManualResume 这个
        // 单独的标记告诉 sess._onPlay："已就绪，下一次真实的play事件可以放行了"。
        // 之前的bug：这里一直没设这个标记，weArePausing 永远不清，用户手动按播放后
        // sess._onPlay 看到 weArePausing 还是true 就直接 return，配音永远不会真正开始。
        sess._readyForManualResume = true;
        showBufferIndicator(`🎧 第一批配音已就绪，可以按播放键了${fallbackTip}`, video);
        setTimeout(() => { if (!sess._buffering) hideBufferIndicator(); }, 5000);
        return;
      } else {
        hideBufferIndicator();
      }
      if (fallbackTip) {
        setTimeout(() => { if (!sess._buffering) hideBufferIndicator(); }, 5000);
      }
    }

    const icon = sess._readMode ? '🔊' : '🎧';
    const modeTag = sess._readMode ? '' : (sess._subtitleMode === 'zh' ? '📝' : '🌐');
    const verb = sess._readMode ? '朗读' : '配音';

    // 同时显示“最远生成位置”和“从播放点连续可播库存”。后者才是不会断配音的
    // 真正库存，不能再把某个远处返回的片段当作已安全可播。
    sess._onChunkProgress = (upToSec) => {
      if (!btn || sess._allDone) return;
      if (sess._knownFullLocalCache) {
        setDubButtonRealtimeCacheState(btn, {
          full: true,
          hitCount: sess._allSegments?.length || 1,
          total: sess._allSegments?.length || 1,
          frontier: sess.video?.duration || upToSec,
          voice: sess._cachedVoice || sess._autoVoice || '',
        });
        return;
      }
      const now = Number(sess.video?.currentTime || 0);
      const continuousTo = getLoadedDubQueueFrontier(sess, now);
      const continuousLead = Math.max(0, continuousTo - now);
      const generatedHms = formatHMS(upToSec);
      const continuousHms = formatHMS(continuousTo);
      btn.textContent = `${icon}${modeTag}库存${Math.floor(continuousLead / 60)}分 · 生成→${generatedHms}`;
      btn.title = `${verb}生成中：连续可播到 ${continuousHms}（库存 ${Math.round(continuousLead)} 秒）；最远已生成到 ${generatedHms}`;
    };

    // 全部生成完成
    sess._onAllDone = () => {
      sess._phase = 'done';
      if (!btn) return;
      sess._allDone = true;
      if (!sess._readMode) {
        sess._knownFullLocalCache = true;
        setDubButtonRealtimeCacheState(btn, {
          full: true,
          hitCount: sess._allSegments?.length || 1,
          total: sess._allSegments?.length || 1,
          frontier: sess.video?.duration || 0,
          voice: sess._cachedVoice || sess._autoVoice || '',
        });
      } else {
        btn.textContent = '正在朗读';
        btn.title = `全部${verb}已生成，正在播放（再点暂停）`;
      }
    };

    sess._allSegments = rawSegments;   // 合并后的全量句子，供 seek 后按位置优先合成
    processDubbingChunked(rawSegments, videoId, title, sess, fail, onFirstChunkReady);
  }

  // ===== 多人模式：先取样，再配音 =====
  if (IS_YOUTUBE && multiSpeakerEnabled) {
    console.log('[配音插件] 多人模式取样阶段，原声保持原量，请标记说话人');
    if (btn) btn.textContent = '🎤 取样中';

    setupDiarization(sess);

    // 取样阶段只做 F0 采样，不播配音、不降原声
    sess._onTimeUpdate = () => { sampleDiarization(sess); };
    sess._onResize = () => {};
    window.addEventListener('resize', sess._onResize);
    video.addEventListener('timeupdate', sess._onTimeUpdate);

    showEnrollButtons(sess, video);

    // 确认按钮：取样完毕后点击，从当前位置开始正式配音
    const confirmBtn = document.createElement('button');
    confirmBtn.style.cssText =
      'position:fixed;z-index:2147483647;background:rgba(0,100,200,0.88);color:#fff;' +
      'border:1.5px solid #6af;border-radius:6px;padding:5px 12px;font-size:13px;' +
      "cursor:pointer;font-family:'Microsoft YaHei',sans-serif;font-weight:bold;";
    confirmBtn.textContent = '✅ 开始多人配音';
    confirmBtn.title = '取样完成后点击，从当前时间点开始配音';

    function repositionConfirm() {
      const r = video.getBoundingClientRect();
      if (r.width < 10) return;
      const total = (speakerCfg.maleCount || 0) + (speakerCfg.femaleCount || 0);
      confirmBtn.style.top  = (r.top + 8 + total * 36 + 8) + 'px';
      confirmBtn.style.left = (r.left + 8) + 'px';
    }
    repositionConfirm();
    sess._enrollReposOrig = sess._enrollRepos;
    const origRepos = sess._enrollRepos;
    sess._enrollRepos = () => { origRepos?.(); repositionConfirm(); };
    window.removeEventListener('scroll', origRepos);
    window.removeEventListener('resize', origRepos);
    window.addEventListener('scroll', sess._enrollRepos, { passive: true });
    window.addEventListener('resize', sess._enrollRepos, { passive: true });

    confirmBtn.addEventListener('click', async () => {
      video.removeEventListener('timeupdate', sess._onTimeUpdate);
      removeEnrollButtons(sess);

      // 停止录音，尝试 pyannote 分析（失败则降级到 F0 方案）
      const total = (speakerCfg.maleCount || 0) + (speakerCfg.femaleCount || 0);
      if (sess._recorder?.state === 'recording') sess._recorder.stop();
      if (sess._recordedChunks?.length && total >= 2) {
        // 临时显示分析进度提示
        const hint = document.createElement('div');
        hint.style.cssText =
          'position:absolute;z-index:2147483647;' +
          'background:rgba(0,0,0,0.82);color:#fff;font-size:14px;padding:14px 24px;' +
          "border-radius:8px;font-family:'Microsoft YaHei',sans-serif;pointer-events:none;";
        hint.textContent = '🔍 pyannote 分析说话人，请稍候…';
        document.body.appendChild(hint);
        placeElOutsideVideo(hint);
        try {
          await new Promise(r => setTimeout(r, 300)); // 等录音最后一帧刷入
          const result = await sendAudioForDiarization(sess._recordedChunks, total);
          if (result?.segments?.length) {
            const offset = sess._recordStartVideoTime || 0;
            sess._diarization = result.segments.map(s => ({
              ...s,
              start: +(s.start + offset).toFixed(2),
              end:   +(s.end   + offset).toFixed(2),
            }));
            buildSpeakerVoiceMap(sess);
          } else {
            console.warn('[配音插件] pyannote 返回空结果，降级到 F0 方案');
          }
        } catch (e) {
          console.warn('[配音插件] pyannote 失败，降级到 F0 方案:', e.message);
        } finally {
          hint.parentNode?.removeChild(hint);
        }
      }

      beginDubbing();
    });

    document.body.appendChild(confirmBtn);
    sess._confirmBtn = confirmBtn;
    return;  // 等待用户点确认
  }

  // ===== 单人模式：直接开始配音 =====
  beginDubbing();
}

// ============================================================
// ===== YouTube 专属逻辑 =====
// ============================================================
let ytPlayerResponse = null;
let ytInterceptedSegments = null;   // 拦截到的字幕（已是中文翻译版）
let ytInterceptedVideoId = null;    // 上述字幕属于哪个视频，防止SPA切换后误用旧字幕
let ytTimedtextUrl = null;          // 带 pot 令牌的原始字幕 URL，供直接构造中文版
let ytTimedtextVideoId = null;      // URL被拦截时页面上的当前videoId
let ytTimedtextWaiter = null;
let ytUrlWaiter = null;             // 等待拦截到带 pot 的字幕 URL
let ytPrefetchStarted = false;      // 是否已发起后台预取，避免重复
let ytPrefetchScheduled = false;    // 是否已调度预取（playerResponse 会重复触发）
let _chineseFetchPromise = null;    // 正在飞行的中文字幕请求 Promise（去重）
// 这次取字幕有没有用到"非理想路径"（脚本自己点CC/找服务器要翻译，而不是用户
// 自己提前选好、纯被动监听到的）——用来在配音开始后提示用户"建议自己开自动翻译
// 中文更稳"，不阻断配音，只是个友好提示。每次 _doGetYTCaptions 重新判定。
let _lastSubFetchWasFallback = false;
let _forceRequestPromise = null;    // 正在飞行的 CC 触发 Promise（去重）
let _ytCaptionsPromises = {};       // per-video 的 getYTCaptions 并发控制，防止同一视频的多个请求
let _nextPrefetchedVid = null;      // 已经发起过"下一个视频"预取请求的videoId，避免重复请求
// 自动翻译字幕仅允许对播放器刚生成的 URL 直读一次。它不是 Gemini，也绝不做
// 浏览器端的重试风暴；目的是修复服务器/旧缓存返回截断时间轴时的唯一安全兜底。
const _autoTranslatePlayerFetchAttempted = new Set();

if (IS_YOUTUBE) {
  function injectPlayerResponseScript() {
    // 每次切视频（yt-navigate-finish）都会重新调用这个函数——如果这个标签页
    // 打开期间插件被重新加载过，chrome.runtime 早就失效了，chrome.runtime.getURL()
    // 会直接抛未捕获异常，把这次调用之后的所有逻辑都炸掉（字幕拦截脚本注入不了，
    // 表现就是"切到第二个视频就再也拿不到字幕"）。先检测，不行就提示刷新，不再硬调。
    if (!isExtensionContextValid()) { notifyExtensionContextInvalidated(); return; }
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject.js');
      // 外部脚本尚未加载完成就 remove()，在部分 Chrome 版本会直接取消请求。
      // 等真正执行完再移除节点，保证切到第二个视频后实时 playerResponse 监听仍存在。
      script.onload = () => script.remove();
      script.onerror = () => script.remove();
      document.documentElement.appendChild(script);
    } catch (e) {
      console.warn('[配音插件] 注入字幕拦截脚本失败', e);
      notifyExtensionContextInvalidated();
    }
  }
  injectPlayerResponseScript();

  // 注入搜索页面增强脚本
  function injectYouTubeSearchScript() {
    if (!isExtensionContextValid()) return;   // 静默跳过：搜索增强不是核心功能，不用弹提示打扰
    try {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL('inject_youtube.js');
      document.documentElement.appendChild(script);
      script.remove();
    } catch (e) {
      console.warn('[配音插件] 注入搜索增强脚本失败', e);
    }
  }
  injectYouTubeSearchScript();

  // 兜底：独立定时器持续尝试注入配音按钮，不依赖后面的 observer/storage 初始化。
  // 先读 autoDub，再每秒重试一次注入（按钮已存在时 injectYTButton 自身会跳过）。
  try {
    chrome.storage.local.get({ autoDub: false }, (cfg) => { autoDub = cfg.autoDub; });
  } catch (e) { console.warn('[配音插件] 读取 autoDub 失败', e); }
  let _autoDubFired = false;
  let _autoDubLastVideoId = null;
  // 保留真人手动启动标志供兼容旧会话；自动配音现在由autoDub开关本身决定，
  // 勾选后第一个视频与后续视频规则一致，不再要求先手动点击一次。
  let _userManuallyStartedDub = false;
  setInterval(() => {
    try {
      injectYTButton();
      injectShortsButton();

      // 播放列表/自动播放切到下一个视频时，YouTube 经常【复用同一个 <video> 元素】，
      // 只是换内容，不一定会触发 yt-navigate-finish（那条只覆盖典型的整页跳转场景）。
      // videoSessionMap 是按 <video> 元素存的，元素没变就会拿到上一个视频的旧 session
      // （它的 started 还停留在 true），导致：①下面 !sess.started 判断被挡住，新视频
      // 不会自动配音；②旧 session 的调度逻辑还挂在新视频上瞎跑。这里改成主动比对
      // 当前视频ID，发现变了就先彻底停掉旧 session、重置触发标记，再走自动配音判断。
      const curId = (typeof curVideoId === 'function') ? curVideoId() : null;
      if (curId && curId !== _autoDubLastVideoId) {
        _autoDubLastVideoId = curId;
        _autoDubFired = false;
        // YouTube有时复用同一个<video>元素（只换src/内容），有时切视频时直接换成
        // 全新元素——后一种情况下 videoSessionMap.get(video0) 找到的是"新视频这个
        // 全新元素"，查不到旧session（记录还挂在已经被丢弃的旧元素上），旧视频的
        // 配音/录制会话就再也没人去停止。优先按元素查（覆盖"复用元素"场景），
        // 查不到就退回不依赖DOM的 _lastActiveSess（覆盖"元素被替换"场景）。
        const video0 = document.querySelector('video');
        const oldSess = (video0 && videoSessionMap.get(video0)) || _lastActiveSess;
        if (oldSess && oldSess.started) {
          console.log('[配音插件] 检测到切换到新视频（播放列表/自动播放），停掉上一个视频的配音会话');
          try { stopDubbing(oldSess, document.getElementById('dub-ext-btn') || document.getElementById('read-ext-btn'), true); } catch (_) {}
        } else if (oldSess) {
          // 某些切换顺序里 ended 已先把 started 清掉，但导出尚未执行；按videoId边界
          // 再做一次幂等收尾，保证第一个视频不会漏下载。
          finalizeSessionExports(oldSess, true);
        }

        // 不能只依赖 yt-navigate-finish 清字幕状态：YouTube 播放列表经常复用播放器，
        // URL/videoId 已经变了却不发该事件。若保留这些全局值，第二个视频会直接拿到
        // 第一个视频的中文字幕或已完成的 Promise，最终表现为无字幕/无配音。
        ytInterceptedSegments = null;
        ytInterceptedVideoId = null;
        ytTimedtextUrl = null;
        ytTimedtextVideoId = null;
        ytTimedtextWaiter = null;
        ytUrlWaiter = null;
        ytPrefetchStarted = false;
        ytPrefetchScheduled = false;
        _chineseFetchPromise = null;
        _forceRequestPromise = null;
        _lastSubFetchWasFallback = false;
        _autoTranslatePlayerFetchAttempted.clear();
        injectPlayerResponseScript();
      }

      // 自动配音：等按钮注入 + 播放器数据就绪 + 用户真正按下播放后，才自动触发一次。
      // 之前没检查播放状态，页面一加载（哪怕用户还没点播放）就会自动开始取字幕/配音，
      // 用户要求"播放键没启动，配音不要自己启动"——这里加上 !video.paused 的判断。
      // 播放列表/自动播放切到下一个视频后，视频会自己继续播放（!video.paused 天然满足），
      // 配合上面的新视频检测，下一个视频开始播放就会自动走一遍正常的"暂停→取字幕→开始
      // 配音→自动续播"流程，跟手动点按钮触发的是同一套逻辑，不是另开了一条特殊路径。
      // ytPlayerResponse 是 inject.js 每500ms异步 postMessage 过来的，切到新视频那一刻
      // 未必已经更新——之前只判断"truthy"，切视频瞬间这个变量可能还是上一个视频的旧数据。
      // 拿着旧视频的字幕轨道信息去给新视频取字幕会返回空，startDubbing 内部 fail() 静默
      // 失败（只有console.error），视频直接恢复原声播放，用户完全看不到任何提示（今天
      // 踩的坑：连续播放第二个视频"自动原音了，完全没有配音"）。这里额外核对
      // videoDetails.videoId 是否真的等于当前视频，对不上就跳过这一tick，等下一秒
      // ytPlayerResponse 追上了再触发，不拿旧数据抢跑。
      const _curVidForAutoDub = (typeof curVideoId === 'function') ? curVideoId() : null;
      const _playerResponseFresh = ytPlayerResponse
        && (!_curVidForAutoDub || ytPlayerResponse.videoDetails?.videoId === _curVidForAutoDub);
      // 视频ID和按钮出现后立即触发；播放器数据由startDubFlow内部短暂等待。
      // 不再把playerResponse完全同步作为按钮点击的前置条件，避免自动配音永不触发。
      if (autoDub && !_autoDubFired && _curVidForAutoDub) {
        const b = document.getElementById('dub-ext-btn') || document.getElementById('read-ext-btn');
        const video = document.querySelector('video');
        if (b && video) {
          if (!isVideoOperational(video)) return;
          const sess = videoSessionMap.get(video);
          if (!sess || !sess.started) {
            _autoDubFired = true;
            b._autoContinuation = false;
            console.log('[配音插件] 自动配音：视频已稳定播放，开始触发');
            b.click();
            // 触发时播放器数据可能仍在SPA切换。若这次没有真正进入配音，必须
            // 自动解除一次性锁，让下一轮重新触发；否则第一次抢跑失败后会永久沉默。
            const triggeredVideoId = _curVidForAutoDub;
            setTimeout(() => {
              if (!autoDub || curVideoId() !== triggeredVideoId) return;
              const currentVideo = document.querySelector('video');
              const currentSess = currentVideo && videoSessionMap.get(currentVideo);
              if (!currentSess?.started) {
                _autoDubFired = false;
                if (b) {
                  b.disabled = false;
                  b.textContent = '🎧配音';
                  b.title = '自动启动尚未成功，正在重试';
                }
                console.warn('[配音插件] 自动配音首次触发未进入配音状态，已解除锁并重试');
              }
            }, 7000);
          }
        }
      }

      // ===== 配音中断看门狗（长视频"静默断配音"的自动补救）=====
      // 用户反馈的核心症状：长视频播到中途，原音还是压低的（会话还活着），但配音
      // 没了，也不报任何错。根因通常是某一批合成请求失败后，那之后的句子永远没有
      // 音频，playNextDue 找不到可播的段就一直安静空转。补救机制（repairDubbing）
      // 一直都有，但只挂在右键菜单上靠人肉发现——这里改成自动检测：正在配音、
      // 视频在播、但短时间没有任何一句真正出声，且当前时间窗口内
      // 确实存在"该有音频却没有"的缺失句，就自动触发补救。纯粹的长间隙（视频里
      // 本来就没人说话）不会误触发——那种情况窗口内没有缺失句。动态冷却防止
      // 服务器持续故障时连环触发。
      const ws = _lastActiveSess;
      // 完整缓存（绿色按钮）仍然只是“生成完成”，不是播放调度可以停止。
      // 旧条件排除了 phase=done，导致缓存播放在中途卡住时看门狗永远不再介入。
      if (ws && ws.started && !ws._readMode && (ws._phase === 'dubbing' || ws._phase === 'done')
          && !ws._userPaused && !ws.weArePausing && !ws._repairing
          && ws.video && !ws.video.paused && ws._allSegments?.length) {
        const now = Date.now();
        const lastAlive = Math.max(ws._lastDubAudioTs || 0, ws._startTs || 0, ws._lastAutoRepairTs || 0);
        const t = ws.video.currentTime;
        // 开头库存最关键，漏句要尽快补；中后段保留稍长窗口以避免把正常停顿误判。
        const watchdogMs = t < 180 ? 1500 : 12000;
        if (now - lastAlive > watchdogMs) {
          const have = new Set((ws.dubSegments || [])
            .filter((s) => (s.audio_url || s.web_speech) && !s._invalidAudio && !s._skippedStale)
            .map(_segKey));
          const missedRecently = ws._allSegments.some(
            (s) => s.start >= t - (watchdogMs / 1000) && s.start <= t && !have.has(_segKey(s)));
          if (missedRecently) {
            ws._lastAutoRepairTs = now;
            console.warn(`[配音插件] 看门狗：超过${watchdogMs / 1000}秒无配音且检测到缺失句，自动补救`);
            showBufferIndicator('🔧 检测到配音中断，自动补救中…', ws.video);
            repairDubbing(ws, document.getElementById('dub-ext-btn'), { resumeAfter: false });
          } else {
            // 音频已经全部生成，但浏览器播放队列自身卡住时，have 中并不缺段，
            // 原来的“缺失句补救”不会触发。检查当前附近是否有应播的现成音频，
            // 有则释放可能残留的加载锁并重新踢一次调度。
            const readyDue = (ws.dubSegments || []).find(
              (s) => !s.played && s.audio_url && s.start >= t - 8 && s.start <= t + 0.5);
            if (readyDue && !ws.curAudio) {
              ws._lastAutoRepairTs = now;
              ws._audioLoading = false;
              ws._audioLoadingSince = null;
              console.warn('[配音插件] 看门狗：音频缓存完整但播放队列停滞，自动恢复调度');
              showBufferIndicator('🔄 检测到浏览器播放队列停滞，正在自动恢复…', ws.video);
              playNextDue(ws, t);
            }
          }
        }
      }
    } catch (e) { console.error('[配音插件] 注入/自动配音出错', e); }
  }, 1000);
  // 切换视频时重置自动触发标记（整页跳转场景下，配合上面按视频ID检测的兜底）
  window.addEventListener('yt-navigate-finish', () => { _autoDubFired = false; });

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || !msg.__dubExt) return;
    if (msg.type === 'playerResponse') {
      ytPlayerResponse = msg.data;
      // 拿到播放器数据后，后台静默预取中文字幕（只调度一次，避免重复）。
      // 之前不管有没有开"自动配音"都会预取——抓字幕本身就有被 429 限流的风险，
      // 用户不一定每个打开的视频都要配音/朗读，平白增加限流机会不值得。
      // 现在只有真正开了"自动配音"（这种情况反正马上就要自动开始）才预取；
      // 手动点按钮触发的配音/朗读走的是另一条按需取字幕的路径，不受这里影响。
      if (!ytPrefetchScheduled) {
        ytPrefetchScheduled = true;
        chrome.storage.local.get({ autoDub: false }, (cfg) => {
          if (cfg.autoDub) {
            setTimeout(prefetchChineseCaptions, 800);
            // 下一个视频不能在开头抢占连接、CPU 或字幕配额。等当前视频距结束15分钟
            // 以内，再由 timeupdate 调度下一视频的预取。
          }
        });
      }
    } else if (msg.type === 'setCaptionTranslationResult') {
      // 播放器内部API切"自动翻译→中文"的执行结果——成功与否都记录，方便在F12里
      // 直接判断这条新路径有没有生效（失败会自然退回后面的服务器兜底，不阻断流程）。
      console.log('[配音插件] 播放器切中文自动翻译命令:',
        msg.ok ? '已发送（等待实际中文字幕请求确认）' : `失败(${msg.error})`);
    } else if (msg.type === 'timedtext') {
      // 记录带 pot 的 URL（供 content 自行拉字幕）。
      // 注意：不能加"仅当当前为空才更新"的限制——否则同一视频里用户切换了
      // 第二次字幕语言（如俄语→法语）时，这里会一直锁死在第一次的语言，
      // 永远拿不到最新选中的轨道。这里始终覆盖成最新一次请求的 URL。
      if (msg.url) {
        ytTimedtextUrl = msg.url;
        ytTimedtextVideoId = curVideoId();
        console.log('[配音插件] 拦截到字幕请求URL（带pot）');
        if (ytUrlWaiter) { ytUrlWaiter(msg.url); ytUrlWaiter = null; }
      }
      // 仅当播放器本身请求的就是中文（原生中文轨/已选自动翻译）才直接用其 body
      if (msg.isChinese && msg.body) {
        const segs = parseTimedText(msg.body);
        if (segs.length) {
          ytInterceptedSegments = segs;
          ytInterceptedVideoId = curVideoId();
          if (ytTimedtextWaiter) { ytTimedtextWaiter(segs); ytTimedtextWaiter = null; }
        }
      }
    }
  });

  // 页面加载后后台预取：静默开一下 CC 触发播放器请求字幕，
  // inject.js 拦截并拉取中文翻译版，缓存到 ytInterceptedSegments。
  // 用户点配音时字幕已就绪，省去等待，确保 10 秒内出配音。
  async function prefetchChineseCaptions() {
    // 朗读模式：不预取中文字幕（朗读读的是用户选中的原文字幕，配音那套完全不参与）
    if (dubMode === 'read') return;
    const video = document.querySelector('video');
    if (!isVideoOperational(video)) return;
    // 关键：同步上锁，必须在任何 await 之前，否则多次调用会在 await 间隙
    // 全部通过检查，导致 CC 被反复切换、字幕请求被放大十几倍触发限流。
    if (ytPrefetchStarted || ytInterceptedSegments?.length) return;
    if (!ytPlayerResponse) return;
    ytPrefetchStarted = true;
    // 本地已缓存该视频字幕 → 不必预取，避免无谓请求
    const cached = await getCachedSubs(curVideoId());
    if (cached) {
      console.log('[配音插件] 字幕预取跳过：本地已有字幕缓存（不代表音频缓存完整）');
      captionsReadyForVideo(curVideoId(), cached);
      return;
    }
    const track = pickCaptionTrack();
    if (!track) { console.log('[配音插件] 预取：无字幕轨道'); return; }
    console.log('[配音插件] 开始后台预取中文字幕…', track._needTranslate ? '(YouTube自动翻译中文，非Gemini)' : '(原生中文轨)');
    const vid = curVideoId();
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    const wasOn = ccBtn?.getAttribute('aria-pressed') === 'true';
    await forceRequestCaptions();            // 触发播放器请求字幕（仅 1 个请求，拿 pot URL）
    // 原生中文轨：播放器直接返回中文，等其 body
    if (!track._needTranslate) {
      const segs = await waitForTimedText(6000);
      if (segs?.length) captionsReadyForVideo(vid, segs);
    } else {
      // 需YouTube自动翻译：先让播放器自己切"自动翻译→中文"轨（最稳，见 _doGetYTCaptions 3.5 步
      // 同款注释），拦不到再退回服务器兜底。
      await ensurePlayerChineseTrack(vid);
      let segs = await waitForTimedText(8000);
      if (ytInterceptedVideoId !== vid) segs = [];
      // 新版播放器可能只让页面脚本看到请求URL、看不到响应正文。后台预取也必须
      // 使用播放器生成的当前视频中文URL，不能只有用户点击后的取字幕路径才使用。
      if (!segs?.length && ytTimedtextVideoId === vid
          && ytTimedtextUrl
          && /[?&](?:tlang|lang)=zh(?:-|&|$)/i.test(ytTimedtextUrl)) {
        segs = await fetchSubtitleSegments(ytTimedtextUrl, true, { allowPlayerUrlOnce: true });
        if (segs?.length) {
          console.log('[配音插件] 后台预取通过播放器中文URL拿到字幕', segs.length, '条');
        }
      }
      if (!segs?.length) {
        await waitForUrl(6000);
        segs = await fetchChineseFromPotUrl();
      }
      if (segs.length) {
        ytInterceptedSegments = segs;
        ytInterceptedVideoId = vid;
        captionsReadyForVideo(vid, segs);
      }
    }
    // 字幕已经进入缓存后立刻关闭YouTube原生CC；每个视频切换后会重新开启、获取、再关闭。
    if (ytInterceptedVideoId === vid && ytInterceptedSegments?.length) disableCaptions();
  }

  // 从播放列表侧边栏面板找"下一个视频"的videoId：当前视频在面板里的固定序号+1，
  // 去面板项里找href带这个&index=的那一条，取它的&v=。找不到面板/已是最后一个
  // 就返回null（比如不在播放列表里看，或播放列表已经放到最后一个）。
  function getNextPlaylistVideoId() {
    try {
      const curIdx = getCanonicalPlaylistIndex(curVideoId());
      if (!curIdx) return null;
      const nextIdx = String(parseInt(curIdx, 10) + 1);
      const items = document.querySelectorAll('ytd-playlist-panel-video-renderer a#wc-endpoint[href], ytd-playlist-panel-video-renderer a#thumbnail[href]');
      for (const a of items) {
        const href = a.getAttribute('href') || '';
        const vMatch = href.match(/[?&]v=([^&]+)/);
        const idxMatch = href.match(/[?&]index=(\d+)/);
        if (idxMatch && idxMatch[1] === nextIdx && vMatch) return vMatch[1];
      }
    } catch (_) {}
    return null;
  }

  // 提前预取"播放列表下一个视频"的中文字幕，趁当前视频还在播的时候，在后台把
  // 下一个视频的中文字幕请求发出去、缓存下来。这样等真正切到下一个视频时，
  // _doGetYTCaptions 第0步（本地缓存）直接命中，不用现场再走一遍"CC被YouTube重置→
  // 兜底转服务器yt-dlp"这条较慢也有429风险的路径——见与用户的讨论：YouTube切
  // 播放列表下一个视频时会把字幕/自动翻译设置重置掉，被动监听这条路对下一个视频
  // 天然失效，只能靠服务器端yt-dlp兜底；这里提前把这次请求做掉，缩短甚至消除
  // 切视频那一刻的等待和限流风险。
  // 直接调服务器 /prefetch_captions，不碰当前页面的CC按钮/播放器状态——那些是
  // 当前正在播放视频的UI，不能因为预取下一个视频而误触。
  async function prefetchNextPlaylistCaptions() {
    if (!autoDub || dubMode === 'read') return;   // 朗读模式语言因人而异，不代为预判下一个视频要读什么语言
    try {
      const nextVid = getNextPlaylistVideoId();
      if (!nextVid || nextVid === _nextPrefetchedVid) return;
      const cached = await getCachedSubs(nextVid);
      if (cached) { _nextPrefetchedVid = nextVid; return; }
      _nextPrefetchedVid = nextVid;
      // 不在当前视频播放期间主动用yt-dlp请求下一个视频字幕。连续提前请求最容易
      // 触发YouTube 429/限流，也会与当前视频的配音和录制争用连接。这里只登记下一个
      // videoId；真正切过去后，让该视频自己的播放器产生带pot令牌的字幕请求并缓存。
      console.log('[配音插件] 已登记下一个视频（安全预取模式：不提前请求YouTube字幕）', nextVid);
    } catch (e) {
      console.warn('[配音插件] 预取下一个视频字幕失败（不影响当前视频，切过去时会走正常兜底流程）', e);
    }
  }

  const NEXT_VIDEO_PREFETCH_LEAD_SECONDS = 15 * 60;
  function maybePrefetchNextPlaylistCaptions(video) {
    const duration = Number(video?.duration || 0);
    const current = Number(video?.currentTime || 0);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(current)) return;
    if (duration - current > NEXT_VIDEO_PREFETCH_LEAD_SECONDS) return;
    prefetchNextPlaylistCaptions();
  }

  window.addEventListener('yt-navigate-finish', () => {
    ytPlayerResponse = null;
    ytInterceptedSegments = null;
    ytInterceptedVideoId = null;
    ytTimedtextUrl = null;
    ytTimedtextVideoId = null;
    ytPrefetchStarted = false;
    ytPrefetchScheduled = false;
    _chineseFetchPromise = null;
    _forceRequestPromise = null;
    _autoTranslatePlayerFetchAttempted.clear();
    // 播放列表连续播放时，YouTube 常常在这个事件触发前就已经把 <video> 换成全新
    // 元素——这时 document.querySelector('video') 拿到的是新视频的元素，
    // videoSessionMap 里查不到它的记录（记录挂在已经被丢弃的旧元素上），下面这段
    // "找旧session并停止"的逻辑会静默失败，表现就是"连续配音时，上一个视频的
    // 录制/下载永远不会触发"。改用不依赖DOM查找的 _lastActiveSess 强引用。
    const btn = document.getElementById('dub-ext-btn') || document.getElementById('read-ext-btn');
    if (btn && _lastActiveSess?.started) {
      stopDubbing(_lastActiveSess, btn, autoDub);
    } else if (_lastActiveSess) {
      finalizeSessionExports(_lastActiveSess, autoDub);
    }
    injectPlayerResponseScript();
  });

  function enableCaptions() {
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn) {
        const pressed = btn.getAttribute('aria-pressed');
        if (pressed === 'false' || !pressed) {
          btn.click();
          console.log('[配音插件] CC 按钮已点击（开启）');
          return true;
        } else {
          console.log('[配音插件] CC 字幕已开启');
          return true;
        }
      } else {
        console.warn('[配音插件] 未找到 CC 按钮');
      }
    } catch (e) {
      console.error('[配音插件] enableCaptions 失败：', e);
    }
    return false;
  }
  function disableCaptions() {
    try {
      const btn = document.querySelector('.ytp-subtitles-button');
      if (btn && btn.getAttribute('aria-pressed') === 'true') {
        btn.click();
        console.log('[配音插件] CC 字幕已关闭');
      }
    } catch (e) {
      console.error('[配音插件] disableCaptions 失败：', e);
    }
  }

  function captionsReadyForVideo(vid, segs, options = {}) {
    if (!segs?.length) return segs || [];
    if (!options.skipCache) setCachedSubs(vid, segs);
    // 只关闭当前视频自己的原生字幕；后台预取“下一个视频”时不能误关当前视频。
    if (curVideoId() === vid) {
      setTimeout(() => {
        if (curVideoId() === vid) disableCaptions();
      }, 0);
    }
    return segs;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 让播放器自己切到"自动翻译→中文"字幕轨（inject.js 用播放器内部 API setOption
  // 完成，不点菜单DOM）。播放器随后会像用户手动选了自动翻译一样，自己发出带
  // pot 令牌的 tlang=zh-Hans 字幕请求，被现有的 fetch/XHR 拦截器接住——这是解决
  // "第二个视频起拿不到中文字幕/被限流"的根治路径：所有字幕请求都由播放器真身
  // 发出，我们从头到尾不构造任何自己的请求，跟用户手动操作无法区分。
  function requestPlayerChineseTrack() {
    try {
      window.postMessage({ __dubExt: true, type: 'setCaptionTranslation', targetLang: 'zh-Hans' }, '*');
    } catch (_) {}
  }

  // YouTube有些版本会接受播放器内部setOption、却不真正切轨。用与人工操作完全相同
  // 的设置菜单作为兜底：设置 → 字幕 → 自动翻译 → 中文（简体）。
  async function selectChineseCaptionsViaMenu() {
    const settings = document.querySelector('.ytp-settings-button');
    if (!settings) return false;
    const labels = () => Array.from(document.querySelectorAll(
      '.ytp-settings-menu .ytp-menuitem-label, .ytp-panel-menu .ytp-menuitem-label'));
    const clickLabel = (patterns) => {
      const el = labels().find((node) => patterns.some((re) => re.test((node.textContent || '').trim())));
      if (!el) return false;
      (el.closest('.ytp-menuitem') || el).click();
      return true;
    };
    try {
      settings.click();
      await sleep(350);
      if (!clickLabel([/字幕/, /subtitles?\/?cc/i, /captions?/i])) return false;
      await sleep(350);
      if (!clickLabel([/自动翻译/, /auto-translate/i])) return false;
      await sleep(350);
      const ok = clickLabel([
        /中文.*简体/, /简体中文/, /chinese.*simplified/i,
        /^中文$/, /^chinese$/i,
      ]);
      if (ok) console.log('[配音插件] 已通过YouTube设置菜单选择“自动翻译→中文（简体）”');
      return ok;
    } catch (e) {
      console.warn('[配音插件] 自动操作字幕菜单失败', e);
      return false;
    }
  }

  async function ensurePlayerChineseTrack(vid) {
    requestPlayerChineseTrack();
    await sleep(1500);
    const hasChineseRequest = ytTimedtextVideoId === vid && ytTimedtextUrl
      && /[?&](?:tlang|lang)=zh(?:-|&|$)/i.test(ytTimedtextUrl);
    if (hasChineseRequest) return true;
    console.log('[配音插件] 内部切轨未产生中文字幕请求，改用YouTube设置菜单');
    return selectChineseCaptionsViaMenu();
  }

  // 可靠触发播放器请求字幕：无论当前开关状态，都确保发生一次"关→开"，
  // 让 YouTube 重新请求 timedtext，inject.js 才能拦截。带真实延迟避免 DOM 竞态。
  // 去重：若已有一次 CC 触发正在进行，后来者直接复用同一 Promise，不重复点击。
  function forceRequestCaptions() {
    if (_forceRequestPromise) {
      console.log('[配音插件] CC触发已在进行中，复用');
      return _forceRequestPromise;
    }
    _forceRequestPromise = _doForceRequestCaptions().finally(() => { _forceRequestPromise = null; });
    return _forceRequestPromise;
  }

  async function _doForceRequestCaptions() {
    // CC 按钮可能尚未渲染，最多等 3 秒
    let btn = null;
    for (let i = 0; i < 15; i++) {
      btn = document.querySelector('.ytp-subtitles-button');
      if (btn) break;
      await sleep(200);
    }
    if (!btn) { console.warn('[配音插件] 找不到字幕(CC)按钮'); return false; }
    const state0 = btn.getAttribute('aria-pressed');
    console.log('[配音插件] CC按钮初始状态 aria-pressed=', state0);
    // 关键修复：CC 已经开着时绝不能"关了再开"——YouTube 这么做经常会把字幕轨
    // 重置回视频默认语言（通常是英文），把用户手动选的俄语/法语等字幕轨冲掉，
    // 表现为"选好字幕、一开始朗读就自动变回英文"。已经开着说明请求早就发生过，
    // 不需要也不能再触发；只有原本是关的才点开（这是唯一安全的触发场景）。
    if (state0 === 'false') {
      btn.click();             // 开 → 触发请求
      await sleep(300);
      console.log('[配音插件] 已开启CC，等待播放器请求字幕');
    }
    return true;
  }

  function pickCaptionTrack() {
    try {
      const tracks = ytPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const zhTrack = tracks.find((t) => t.languageCode?.startsWith('zh'));
      if (zhTrack) return zhTrack;
      // 没有中文轨：取第一条，后续在 getYTCaptions 里用 tlang 拿中文翻译
      const base = tracks[0];
      return base ? { ...base, _needTranslate: true } : null;
    } catch (_) { return null; }
  }

  // Gemini翻译只允许使用视频原生字幕，绝不能选YouTube自动翻译出来的中文轨。
  // 优先播放器标记的默认字幕轨；没有标记时使用captionTracks中的第一种原始语言，
  // 并在同语言下优先人工字幕、其次自动识别字幕(kind=asr)。
  function pickOriginalCaptionTrack() {
    try {
      const renderer = ytPlayerResponse?.captions?.playerCaptionsTracklistRenderer;
      const tracks = (renderer?.captionTracks || []).filter(
        (track) => track?.baseUrl && !/[?&]tlang=/i.test(track.baseUrl));
      if (!tracks.length) return null;

      let preferred = null;
      const audioTracks = renderer?.audioTracks || [];
      const defaultAudio = audioTracks.find((item) => item.hasDefaultTrack)
        || audioTracks[renderer?.defaultAudioTrackIndex || 0]
        || audioTracks[0];
      const defaultIndex = defaultAudio?.defaultCaptionTrackIndex;
      if (Number.isInteger(defaultIndex) && tracks[defaultIndex]) {
        preferred = tracks[defaultIndex];
      }
      if (!preferred) preferred = tracks.find((track) => track.isDefault) || tracks[0];

      const originalLang = preferred.languageCode;
      const sameLanguage = tracks.filter((track) => track.languageCode === originalLang);
      const manual = sameLanguage.find(
        (track) => track.kind !== 'asr' && !String(track.vssId || '').startsWith('a.'));
      const result = manual || sameLanguage[0] || preferred;
      console.log('[配音插件] Gemini选择本视频原字幕：',
        result.languageCode, result.kind === 'asr' ? '自动识别字幕' : '人工字幕',
        result.name?.simpleText || '');
      return { ...result, _needTranslate: false, _originalTrack: true };
    } catch (e) {
      console.warn('[配音插件] 选择原字幕轨失败', e);
      return null;
    }
  }

  function waitForTimedText(ms) {
    if (ytInterceptedSegments?.length) return Promise.resolve(ytInterceptedSegments);
    return new Promise((resolve) => {
      let done = false;
      ytTimedtextWaiter = (segs) => { if (!done) { done = true; resolve(segs); } };
      setTimeout(() => { if (!done) { done = true; ytTimedtextWaiter = null; resolve(ytInterceptedSegments || []); } }, ms);
    });
  }

  async function waitForManualChineseCaptions(vid, ms = 90000) {
    const video = document.querySelector('video');
    const msg = '⚠ 未获取到中文字幕，请手动打开 YouTube 字幕：字幕 → 自动翻译 → 中文（简体）。插件会自动检测，检测到后继续配音。未调用Gemini。';
    showBufferIndicator(msg, video);
    const startedAt = Date.now();
    let lastLogAt = 0;
    while (Date.now() - startedAt < ms) {
      if (ytInterceptedSegments?.length && ytInterceptedVideoId === vid) {
        hideBufferIndicator();
        console.log('[配音插件] 已检测到用户手动打开的中文字幕，继续配音', ytInterceptedSegments.length, '条');
        return captionsReadyForVideo(vid, ytInterceptedSegments);
      }
      if (ytTimedtextVideoId === vid && ytTimedtextUrl
          && /[?&](?:tlang|lang)=zh(?:-|&|$)/i.test(ytTimedtextUrl)) {
        if (Date.now() - lastLogAt > 5000) {
          lastLogAt = Date.now();
          console.log('[配音插件] 已检测到中文字幕URL，等待播放器返回字幕正文');
        }
      }
      await sleep(600);
    }
    console.warn('[配音插件] 等待用户手动打开自动翻译中文字幕超时，未调用Gemini');
    return [];
  }

  // 等待拦截到带 pot 令牌的字幕 URL（播放器一发字幕请求就能拿到）
  function waitForUrl(ms) {
    if (ytTimedtextUrl) return Promise.resolve(ytTimedtextUrl);
    return new Promise((resolve) => {
      let done = false;
      ytUrlWaiter = (url) => { if (!done) { done = true; resolve(url); } };
      setTimeout(() => { if (!done) { done = true; ytUrlWaiter = null; resolve(ytTimedtextUrl || null); } }, ms);
    });
  }

  // 浏览器直取字幕（兜底路径，优先走服务器 prefetch_captions）。
  // 注意：自动翻译轨(tlang)由浏览器直接 fetch 最容易被 YouTube 429。自动翻译中文是
  // 我们的低成本主路径，不是错误；但取它必须尽量走“播放器被动拦截正文/服务器yt-dlp”
  // 这两条路。这里不再对自动翻译URL做 0/3/8/20 秒硬重试，避免越补越触发限流。
  async function fetchSubtitleSegments(baseUrl, isAutoTranslate, options = {}) {
    const allowPlayerUrlOnce = !!options.allowPlayerUrlOnce;
    if (isAutoTranslate && !allowPlayerUrlOnce) {
      console.log('[配音插件] 跳过浏览器直取自动翻译字幕URL，避免触发YouTube 429；改走服务器/缓存路径');
      return [];
    }
    const videoId = curVideoId();
    if (isAutoTranslate) {
      if (_autoTranslatePlayerFetchAttempted.has(videoId)) {
        console.log('[配音插件] 播放器中文URL本轮已单次读取过，不重复请求');
        return [];
      }
      _autoTranslatePlayerFetchAttempted.add(videoId);
      console.log('[配音插件] 读取播放器刚生成的中文URL（仅此一次，不重试）');
    }
    const delays = isAutoTranslate ? [0] : [0, 2000];
    const jsonUrl = baseUrl.includes('fmt=') ? baseUrl : baseUrl + '&fmt=json3';
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) {
        console.log(`[朗读] 浏览器直取字幕未成功，${delays[i] / 1000}s 后重试（第 ${i}/${delays.length - 1} 次）…`);
        await sleep(delays[i]);
      }
      try {
        const resp = await fetch(jsonUrl, { credentials: 'include' });
        if (resp.status === 429) continue;
        const segs = parseTimedText(await resp.text());
        if (segs.length) return segs;
      } catch (_) {}
    }
    if (isAutoTranslate) return [];
    try {
      const xmlUrl = baseUrl.replace(/&fmt=\w+/, '');
      const resp = await fetch(xmlUrl, { credentials: 'include' });
      return parseTimedText(await resp.text());
    } catch (_) { return []; }
  }

  // 字幕本地缓存：成功拿到一次后存扩展存储，重测同一视频直接复用，
  // 避免反复请求 YouTube timedtext 触发 429 限流。
  function curVideoId() {
    const u = new URL(location.href);
    // Shorts: /shorts/VIDEO_ID
    const shortsMatch = u.pathname.match(/^\/shorts\/([^/?#]+)/);
    if (shortsMatch) return shortsMatch[1];
    return u.searchParams.get('v') || 'yt_unknown';
  }

  function isYTShorts() {
    return /^\/shorts\//.test(location.pathname);
  }
  // 字幕缓存键带版本号：解析逻辑改动后 bump 版本，旧缓存自动失效、全部重新解析。
  // v2：修复 YouTube 滚动字幕被旧逻辑解析成"每句重复"的问题。
  // v3：json3 在朗读模式（不走 groupChineseSentences 合并）下仍会暴露渐进式滚动重复
  //     cue，新增 dedupRollingCaptions 按"前缀关系+时间紧邻"合并，bump 版本失效旧缓存。
  // v4：相邻 cue 换行边界 1 字重叠（天天蝎座/双双鱼座，配音念出来像口吃）→
  //     textBoundaryOverlapLen 合并，bump 版本失效旧缓存。
  // v5：开头二十秒不再按文字相似度删事件，旧缓存可能已误删第一、二句，必须重取。
  // v6：恢复滚动 cue 的时间轴去重；第一、二句依靠会话重置和可播放门槛保障，不靠取消去重。
  // v8：服务端改用 json3 原始时间事件；v7 的 VTT 时间窗可能稀疏，不能再复用。
  const SUBS_CACHE_PREFIX = 'subs_v8_';
  function getCachedSubs(vid) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([SUBS_CACHE_PREFIX + vid], (r) => {
          const segs = r && r[SUBS_CACHE_PREFIX + vid];
          if (!Array.isArray(segs) || !segs.length) { resolve(null); return; }
          const info = captionTimelineInfo(segs);
          if (hasUnexpectedCaptionTailGap(info)) {
            console.warn('[配音插件] 本地字幕缓存尾部异常截断，自动废弃：', {
              count: info.count, lastEnd: +info.lastEnd.toFixed(1),
              duration: +info.duration.toFixed(1), tailGap: +info.tailGap.toFixed(1),
            });
            try { chrome.storage.local.remove(SUBS_CACHE_PREFIX + vid); } catch (_) {}
            resolve(null);
            return;
          }
          resolve(segs);
        });
      } catch (_) { resolve(null); }
    });
  }
  function setCachedSubs(vid, segs) {
    try {
      if (Array.isArray(segs) && segs.length)
        chrome.storage.local.set({ [SUBS_CACHE_PREFIX + vid]: segs });
    } catch (_) {}
  }
  function removeCachedSubs(vid) {
    try { chrome.storage.local.remove(SUBS_CACHE_PREFIX + vid); } catch (_) {}
  }

  function captionTimelineInfo(segs, video = document.querySelector('video')) {
    const rows = Array.isArray(segs) ? segs : [];
    const lastEnd = rows.reduce((max, seg) => Math.max(max, Number(seg?.end || seg?.start || 0)), 0);
    const duration = Number(video?.duration || 0);
    const tailGap = duration > 0 ? Math.max(0, duration - lastEnd) : 0;
    return { count: rows.length, lastEnd, duration, tailGap };
  }

  function hasUnexpectedCaptionTailGap(info) {
    // 只针对长视频且缺失至少 15 分钟/全片 12% 的情况。正常片尾无话、片尾
    // 几分钟没有字幕不会误判；例如 2:48:52 的视频字幕若在 19:56 截断则必定命中。
    return Number(info?.duration || 0) >= 20 * 60
      && Number(info?.tailGap || 0) >= Math.max(15 * 60, Number(info.duration) * 0.12);
  }

  async function resolveChineseCaptionTimeline(vid, segs, source = '') {
    if (!segs?.length) return segs || [];
    let selected = segs;
    let info = captionTimelineInfo(selected);
    if (!hasUnexpectedCaptionTailGap(info)) return captionsReadyForVideo(vid, selected);

    // A partial cache must never show as a complete cache. Prefer exactly one
    // direct read of the URL that YouTube itself just issued for Chinese.
    console.warn('[配音插件] 检测到字幕时间轴异常截断，废弃该缓存并校验播放器中文URL：', {
      source, count: info.count, lastEnd: +info.lastEnd.toFixed(1),
      duration: +info.duration.toFixed(1), tailGap: +info.tailGap.toFixed(1),
    });
    removeCachedSubs(vid);
    const playerChineseUrl = ytTimedtextVideoId === vid ? ytTimedtextUrl : null;
    if (playerChineseUrl && /[?&](?:tlang|lang)=zh(?:-|&|$)/i.test(playerChineseUrl)) {
      const direct = await fetchSubtitleSegments(playerChineseUrl, true, { allowPlayerUrlOnce: true });
      const directInfo = captionTimelineInfo(direct);
      if (direct?.length && directInfo.lastEnd > info.lastEnd + 60) {
        selected = direct;
        info = directInfo;
        console.log('[配音插件] 播放器中文URL已补回更完整的字幕时间轴：',
          `${info.count}条，至 ${info.lastEnd.toFixed(1)}s`);
      }
    }
    if (hasUnexpectedCaptionTailGap(info)) {
      // 不把坏账本重新落盘或标成“完整缓存”。当前轮仍把已有前段交给调用方，
      // 但控制台会给出明确原因，刷新后可重新取得新的播放器令牌。
      console.warn('[配音插件] 中文字幕时间轴仍不完整，未写入缓存：', {
        source, count: info.count, lastEnd: +info.lastEnd.toFixed(1),
        duration: +info.duration.toFixed(1), tailGap: +info.tailGap.toFixed(1),
      });
      return captionsReadyForVideo(vid, selected, { skipCache: true });
    }
    return captionsReadyForVideo(vid, selected);
  }
  // 字幕缓存改成正常持久化（不再每次刷新页面就清空）——之前是开发阶段怕解析逻辑
  // 改动后吃到旧版本留下的脏缓存，故意每次刷新都清掉；现在解析逻辑已经稳定，持久
  // 缓存能避免"刷新页面后重新配音要重新抓字幕、还可能撞上限流"这种情况。真要清缓存
  // （比如确认某个视频缓存的字幕有问题），用弹窗设置里"🗑 清除当前视频配音缓存"
  // 按钮手动清，不用每次刷新都全量清掉。SUBS_CACHE_PREFIX 的版本号机制还保留：
  // 以后再改解析逻辑，bump一下版本号，旧版本缓存自然失效，不用全量清。

  // 优先让服务器用 yt-dlp（带 cookie + impersonate）取中文字幕，彻底绕开浏览器端 429。
  // 服务器失败时才退回浏览器直取（带退避重试）。
  // 去重：若已有一次请求正在飞行，后来者直接复用同一 Promise。
  function fetchChineseFromPotUrl() {
    if (_chineseFetchPromise) {
      console.log('[配音插件] 中文字幕请求已在进行中，复用');
      return _chineseFetchPromise;
    }
    _chineseFetchPromise = _doFetchChineseFromPotUrl().finally(() => { _chineseFetchPromise = null; });
    return _chineseFetchPromise;
  }

  async function _doFetchChineseFromPotUrl() {
    const vid = curVideoId();

    // 1) 优先：让服务器用 yt-dlp + cookie 取字幕，避免浏览器端 429。
    // 超时设25秒——之前这里写的是"8秒后快速退回浏览器直取"，但浏览器直连那条路
    // 已经因为太容易被429而去掉了（见下面第2步注释），没有第二道保底路径要赶着切过去，
    // 8秒对服务器端yt-dlp（要走cookie/可能还有代理）偏紧，正常情况下也可能撑不到
    // 拿到结果就被打断，放宽一些给它更合理的完成时间。
    if (vid && vid !== 'yt_unknown') {
      try {
        console.log('[配音插件] 通过服务器 yt-dlp 取中文字幕…');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 25000);
        const resp = await fetch(`${SERVER}/prefetch_captions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_id: vid }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          if (data.segments && data.segments.length) {
            console.log('[配音插件] 服务器字幕', data.segments.length, '条');
            return data.segments;
          }
          console.log('[配音插件] 服务器没取到字幕（返回了空结果）');
        }
      } catch (e) {
        console.warn('[配音插件] 服务器取字幕失败/超时', e?.message || e);
      }
    }

    // 2) 之前这里是"浏览器自己直连一次该URL，带429退避重试"。实测这条路基本必定
    // 被YouTube判429（不是缺token那种空响应，是真限流），越重试越容易把这个IP的
    // 额度耗得更狠，对解决问题没帮助。改成不再自己发这个请求——失败原因大概率是
    // pot令牌过期或者真被限流，这两种都不是"换个写法重新请求"能解决的，老实承认
    // 这次没拿到，提示用户刷新页面重试（刷新能拿到全新令牌，对"令牌过期"这种情况
    // 有效；对真限流没用，但刷新本身没有副作用，配音本来就是归零重来）。
    console.log('[配音插件] 服务器取字幕未成功，且不再走浏览器直连这条路（容易被限流）。');
    return [];
  }

  async function getYTCaptions(track) {
    const vid = curVideoId();

    // 并发控制：如果同一视频的请求已在进行中，复用之前的 Promise（防止 429）
    if (_ytCaptionsPromises[vid]) {
      console.log('[配音插件] 同一视频的字幕请求已在进行中，等待中…');
      return _ytCaptionsPromises[vid];
    }

    // 创建新的 Promise，并保存到全局字典
    _ytCaptionsPromises[vid] = _doGetYTCaptions(vid, track)
      .finally(() => { delete _ytCaptionsPromises[vid]; });
    return _ytCaptionsPromises[vid];
  }

  async function _doGetYTCaptions(vid, track) {
    _lastSubFetchWasFallback = false;
    // 0) 本地缓存命中 → 秒回，完全不碰 YouTube
    const cached = await getCachedSubs(vid);
    if (cached) {
      console.log('[配音插件] 命中本地缓存字幕', cached.length, '条');
      return resolveChineseCaptionTimeline(vid, cached, 'local_cache');
    }

    // 1) 预取已就绪 → 直接用。这是用户自己提前选好字幕、纯被动监听到的理想路径。
    if (ytInterceptedSegments?.length && ytInterceptedVideoId === vid) {
      console.log('[配音插件] 命中预取中文字幕', ytInterceptedSegments.length, '条');
      return resolveChineseCaptionTimeline(vid, ytInterceptedSegments, 'player_intercept');
    }

    // 走到这里说明用户点配音前没选好中文字幕，接下来只能靠播放器自己的
    // YouTube自动翻译中文/服务器字幕兜底；未勾选Gemini时绝不调用API翻译。
    _lastSubFetchWasFallback = true;

    // 2) 确保播放器已发过字幕请求（拿到 pot URL）。预取没成时触发一次。
    if (!ytTimedtextUrl) await forceRequestCaptions();
    await waitForUrl(8000);

    // 3) 原生中文轨：等播放器返回的中文 body
    if (!track._needTranslate) {
      const w = await waitForTimedText(6000);
      if (w?.length) return resolveChineseCaptionTimeline(vid, w, 'native_chinese_track');
    }

    // 3.5) 需YouTube自动翻译：先让播放器自己切"自动翻译→中文"轨（播放器内部API，见
    // requestPlayerChineseTrack 注释）——播放器会自己发出带 pot 令牌的 zh-Hans
    // 请求，被动拦截即可，跟"用户提前手动选好"是同一级别的最稳路径。拦到就直接
    // 用；8秒内没拦到（播放器API不可用/字幕轨异常）才退回服务器 yt-dlp 兜底。
    if (track._needTranslate) {
      await ensurePlayerChineseTrack(vid);
      const viaPlayer = await waitForTimedText(8000);
      if (viaPlayer?.length && ytInterceptedVideoId === vid) {
        console.log('[配音插件] 播放器自动翻译轨拿到中文字幕', viaPlayer.length, '条');
        return resolveChineseCaptionTimeline(vid, viaPlayer, 'player_auto_translate');
      }
      // 有些YouTube播放器版本的字幕请求不再经过页面fetch/XHR，因此inject.js只能
      // 拦到请求URL，拿不到响应正文。此时URL本身已经包含播放器生成的pot令牌和
      // tlang=zh，直接读取它即可；这不是重新构造字幕请求，也不依赖服务器猜轨道。
      const liveChineseUrl = ytTimedtextUrl;
      if (liveChineseUrl && ytTimedtextVideoId === vid
          && /[?&](?:tlang|lang)=zh(?:-|&|$)/i.test(liveChineseUrl)) {
        const directChinese = await fetchSubtitleSegments(liveChineseUrl, true, { allowPlayerUrlOnce: true });
        if (directChinese?.length) {
          console.log('[配音插件] 通过播放器中文字幕URL拿到字幕', directChinese.length, '条');
          return resolveChineseCaptionTimeline(vid, directChinese, 'player_chinese_url');
        }
      }
      console.log('[配音插件] 播放器自动翻译轨8秒内未返回中文，退回服务器兜底');
    }

    // 4) 需YouTube自动翻译：走服务器字幕兜底，不启用Gemini
    const zh = await fetchChineseFromPotUrl();
    if (zh.length) return resolveChineseCaptionTimeline(vid, zh, 'server_ytdlp');

    // 5) 仍拿不到中文：不退回原语言+API。提示用户手动在 YouTube 菜单里打开
    // “自动翻译→中文”，脚本继续被动监听播放器自己的中文字幕请求。
    console.warn('[配音插件] 未能自动获取中文字幕，等待用户手动打开YouTube自动翻译中文；未调用Gemini');
    const manual = await waitForManualChineseCaptions(vid, 90000);
    if (manual.length) return manual;
    return [];
  }

  // 创建配音按钮（普通视频和 Shorts 共用同一点击逻辑）
  // 朗读：用户当前在 YouTube 选中的字幕轨（实时跟踪，用户切字幕马上更新）
  async function getReadAloudSegments() {
    // 不再在这里清空 ytTimedtextUrl/强制关再开 CC——CC 已经开着时关了再开，
    // YouTube 经常会把字幕轨重置回视频默认语言（通常是英文），把用户手动选的
    // 俄语/法语等字幕轨冲掉（这正是"选好字幕、一开始朗读就跳回英文"的根因）。
    // 现在 forceRequestCaptions 只在 CC 原本是关的时候才点开；用户手动切轨时
    // 播放器会自然发起新请求，上面的 message 监听器会一直覆盖成最新 URL，
    // 这里只需要确保 CC 是开着的、然后拿当前已知的最新 URL（没有就等一下）。
    await forceRequestCaptions();
    await waitForUrl(8000);
    if (!ytTimedtextUrl) return [];

    // 自动翻译字幕用 tlang=de，原生字幕用 lang=en；tlang 优先级更高
    const tlangMatch = ytTimedtextUrl.match(/[?&]tlang=([^&]+)/);
    const langMatch  = ytTimedtextUrl.match(/[?&]lang=([^&]+)/);
    const rawLang = (tlangMatch || langMatch)?.[1] || 'en';  // 完整语言码，如 zh-TW / de / en
    const isAutoTranslate = !!tlangMatch;
    const video = document.querySelector('video');
    if (video && videoSessionMap.has(video)) {
      const sess = videoSessionMap.get(video);
      sess._readLang = rawLang;  // 保留完整语言码，让服务器精确匹配 zh-TW/zh-HK 等
      console.log(`%c[朗读] 字幕语言检测`, 'color:#f90;font-weight:bold',
        `\n  URL tlang=${tlangMatch?.[1]||'(无)'} lang=${langMatch?.[1]||'(无)'}`,
        `\n  → 使用语言码: "${rawLang}"`,
        `\n  → 将送往服务器选择 TTS 配音员`);
    }

    // 自动翻译字幕（tlang）是最容易被 YouTube 429 限流的请求——浏览器端直接 fetch
    // 没有登录态/没有 impersonate，很容易被拦。优先走本地服务器（yt-dlp + cookie +
    // impersonate，见 youtube-429-cookies 经验），明显更抗限流；服务器不可用才退回
    // 浏览器直取（带退避重试）。原生字幕（非自动翻译）走浏览器直取通常够用，
    // 但服务器路径同样支持，统一优先走服务器更省心、也降低被 429 的概率。
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 25000);
      const resp = await fetch(`${SERVER}/prefetch_captions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: curVideoId(), lang: rawLang }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        if (data.segments && data.segments.length) {
          console.log(`[朗读] 服务器取字幕成功 ${data.segments.length} 条（匹配语言=${data.matched_lang}）`);
          return data.segments;
        }
        console.warn('[朗读] 服务器没找到该语言字幕，退回浏览器直取');
      } else {
        console.warn('[朗读] 服务器取字幕请求失败 HTTP', resp.status, '，退回浏览器直取');
      }
    } catch (e) {
      console.warn('[朗读] 连不上本地服务器，退回浏览器直取', e?.message);
    }

    const segs = await fetchSubtitleSegments(ytTimedtextUrl, isAutoTranslate);
    if (segs && segs.length) return segs;
    return [];
  }

  // Gemini需要“原字幕”，不需要先让YouTube生成中文自动翻译轨。优先直接读取
  // playerResponse中现成的原字幕URL；只有浏览器读取失败才请服务器用yt-dlp兜底。
  // 两条路径都有超时，不能让按钮永久停在“取字幕”。
  async function getOriginalSegmentsForGemini(track) {
    if (track?.baseUrl) {
      try {
        const direct = await Promise.race([
          fetchSubtitleSegments(track.baseUrl, false),
          new Promise((_, reject) => setTimeout(
            () => reject(new Error('播放器原字幕读取超时')), 8000)),
        ]);
        if (direct?.length) {
          console.log('[配音插件] Gemini直接取得播放器原字幕', direct.length, '条');
          // 原文已经安全取到并写入缓存，现在才关闭YouTube原生CC；之后画面只显示
          // 插件根据Gemini译文绘制的配音字幕。
          return captionsReadyForVideo(curVideoId(), direct);
        }
      } catch (e) {
        console.warn('[配音插件] 播放器原字幕读取失败，转服务器兜底', e?.message || e);
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const resp = await fetch(`${SERVER}/prefetch_captions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_id: curVideoId(),
          lang: track?.languageCode || 'en',
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`服务器返回 HTTP ${resp.status}`);
      const data = await resp.json();
      if (Array.isArray(data.segments) && data.segments.length) {
        console.log('[配音插件] Gemini通过服务器取得原字幕', data.segments.length, '条');
        return captionsReadyForVideo(curVideoId(), data.segments);
      }
      throw new Error('服务器返回空字幕');
    } finally {
      clearTimeout(timer);
    }
  }

  // 朗读核心逻辑（按钮点击 和 换语言按钮 共用）
  async function doStartReadAloud(video, btn) {
    const sess = getOrCreateSession(video);
    if (sess.started) stopDubbing(sess, btn);
    if (!ytPlayerResponse) { btn.title = '未拿到播放器数据，请刷新后重试'; return; }
    sess._readMode = true;
    sess._reading = false;
    const videoId = curVideoId();
    const title = document.title.replace(/ - YouTube$/, '');
    const initEstimate = 3;
    let remain = initEstimate;
    btn.textContent = `🔊初始化 ${remain}s`;
    if (sess._initTimer) clearInterval(sess._initTimer);
    sess._initTimer = setInterval(() => {
      if (sess._reading) return;
      remain--;
      const rb = document.getElementById('read-ext-btn');
      if (rb) rb.textContent = remain > 0 ? `🔊初始化 ${remain}s` : '🔊即将开始…';
    }, 1000);
    // 换语言时显示换语言按钮
    showLangSwitchBtn();
    watchNativeTrackChange(video, sess);
    await startDubbing(sess, btn, () => getReadAloudSegments(), videoId, title);
  }

  // 自动感知用户在 YouTube 原生 CC 菜单里切换了字幕轨：之前只能靠手动点 🔄，
  // 切完字幕后插件毫无反应（不重新取词、也不会恢复播放）。这里监听 video.textTracks
  // 的 'change' 事件（用户选中/切换字幕轨时浏览器会触发），自动用新轨重新开始朗读，
  // 并沿用 doStartReadAloud→startDubbing 里"原本是否在播放就自动续播"的逻辑。
  function watchNativeTrackChange(video, sess) {
    if (sess._onTextTrackChange) {
      try { video.textTracks?.removeEventListener('change', sess._onTextTrackChange); } catch (_) {}
    }
    sess._onTextTrackChange = () => {
      if (!sess.started || !sess._readMode) return;
      clearTimeout(sess._trackChangeTimer);
      // 防抖：切轨瞬间可能连续触发多次 change，只用最后一次
      sess._trackChangeTimer = setTimeout(() => {
        if (!sess.started || !sess._readMode) return;
        const rb = document.getElementById('read-ext-btn');
        if (rb) doStartReadAloud(video, rb);
      }, 400);
    };
    try { video.textTracks?.addEventListener('change', sess._onTextTrackChange); } catch (_) {}
  }

  // 换语言按钮：朗读中用户换了字幕轨，点此按钮立即用新轨重新初始化
  function showLangSwitchBtn() {
    if (document.getElementById('read-lang-btn')) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;
    const langBtn = document.createElement('button');
    langBtn.id = 'read-lang-btn';
    langBtn.className = 'ytp-button';
    langBtn.title = '换语言：用当前选中字幕重新朗读';
    langBtn.textContent = '🔄';
    langBtn.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:auto;padding:0 6px;font-size:15px;line-height:48px;' +
      'color:#fff;vertical-align:top;cursor:pointer;opacity:0.85;';
    langBtn.addEventListener('click', async () => {
      const video = document.querySelector('video');
      if (!video) return;
      const readBtn = document.getElementById('read-ext-btn');
      if (readBtn) await doStartReadAloud(video, readBtn);
    });
    // 插在朗读按钮旁边
    const readBtn = document.getElementById('read-ext-btn');
    if (readBtn) controls.insertBefore(langBtn, readBtn.nextSibling);
    else controls.insertBefore(langBtn, controls.firstChild);
  }

  function hideLangSwitchBtn() {
    document.getElementById('read-lang-btn')?.remove();
  }

  // 朗读按钮：忠实按字幕时间轴朗读用户选中的字幕，不动视频、静音原音。
  // 检测当前是否已登录 YouTube/Google 账号。登录态决定字幕请求的限流配额——
  // 未登录的请求配额低得多，更容易撞 429（见之前排查的限流问题）。
  // 商业化后我们没法再用"自己账号"兜所有用户的请求，所以要求用户自己登录账号，
  // 让每个用户用自己的配额，分散压力、也减少对我们代理流量的依赖。
  function isYouTubeLoggedIn() {
    try {
      if (document.querySelector('#avatar-btn')) return true;   // 已登录：头像按钮存在
      const signInLink = document.querySelector(
        'a[href*="accounts.google.com/ServiceLogin"], a[href*="accounts.google.com/signin"], ytd-button-renderer a[href*="accounts.google.com"]'
      );
      if (signInLink) return false;                              // 未登录：顶部有"登录"链接
      return true;   // 拿不准时保守放过，避免误挡已登录用户
    } catch (_) { return true; }
  }

  function showLoginReminder() {
    if (document.getElementById('dub-ext-login-reminder')) return;
    const box = document.createElement('div');
    box.id = 'dub-ext-login-reminder';
    box.style.cssText =
      'position:absolute;z-index:2147483647;' +
      'background:rgba(20,20,20,0.95);color:#fff;padding:20px 28px;border-radius:10px;' +
      "font-family:'Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;text-align:center;" +
      'box-shadow:0 4px 20px rgba(0,0,0,0.5);max-width:320px;';
    box.innerHTML =
      '<div style="font-size:20px;margin-bottom:8px;">🔒 请先登录 YouTube</div>' +
      '<div style="opacity:0.85;margin-bottom:14px;">未登录账号会导致字幕请求很容易被限流，影响配音/朗读体验。请先登录你的 YouTube/Google 账号再使用本插件。</div>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '知道了';
    closeBtn.style.cssText =
      'background:#3ea6ff;color:#000;border:none;border-radius:6px;padding:8px 18px;' +
      'font-size:14px;cursor:pointer;font-weight:bold;';
    closeBtn.addEventListener('click', () => box.remove());
    box.appendChild(closeBtn);
    document.body.appendChild(box);
    placeElOutsideVideo(box);
    setTimeout(() => box.remove(), 8000);
  }

  function makeReadButton() {
    if (document.getElementById('read-ext-btn')) return null;
    const btn = document.createElement('button');
    btn.id = 'read-ext-btn';
    btn.title = '朗读选中的字幕（忠实时间轴，不影响视频）\n左键：开始/暂停/继续　右键：彻底停止';
    btn.textContent = '🔊朗读';
    btn.addEventListener('click', async (e) => {
      if (e.isTrusted) _userManuallyStartedDub = true;   // 真人点击才解锁后续自动续播，脚本模拟点击不算
      const video = document.querySelector('video');
      if (!video) return;
      const sess = getOrCreateSession(video);
      // 必须在这里（点击处理函数最开头，任何await之前）就立即发起，占住"用户手势"的
      // 有效窗口——见 startRecordingOnClick 注释。真人点击（e.isTrusted）才有真实
      // 手势可占；脚本模拟点击（播放列表自动续播）本来就没有可用的用户手势，
      // tabCapture在那种场景下必然拿不到，这是Chrome API本身的限制，不是bug。
      if (e.isTrusted) startRecordingOnClick(sess);
      // 这个标记同时用在两个地方：①变速日志/字幕是否自动下载（见 stopDubbing）
      // ②是否自动按音高判断这个视频说话人是男是女、自动选配音员（见 startDubbing）。
      // 只看"打开视频自动开始配音"这个开关有没有开——不能像之前那样只看"这次点击是不是
      // 脚本模拟的"：播放列表第一个视频是用户手动点的，但只要勾了自动配音，就该把
      // 整个播放列表当成一次连续的自动配音过程，第一个视频也要自动导出/自动识别，
      // 不然"第一个切到第二个"这次切换永远不会触发导出（第一个视频那次判断标记是false）。
      sess._isPlaylistAutoContinue = autoDub;
      if (_continuousTabRecording && autoDub) {
        // offscreen 已在视频边界开启了新分段；把新 session 绑定到它，确保结束时
        // 会下载本视频，而不是因为脚本点击无法重新申请 tabCapture 而漏掉文件。
        sess._tabRecording = true;
        sess._recordStartWallClock = Date.now();
      }
      if (sess.started && sess._readMode) {
        if (sess._userPaused) resumeDubbing(sess, btn); else pauseDubbing(sess, btn);
        return;
      }
      // 跟配音按钮一样的保护：点一次先禁用几秒，防止连点导致同一时间发出多份重叠请求。
      if (btn.disabled) return;
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 3000);
      if (sess.started && !sess._readMode) stopDubbing(sess, document.getElementById('dub-ext-btn'));
      if (!isYouTubeLoggedIn()) { showLoginReminder(); return; }
      await doStartReadAloud(video, btn);
    });
    // 右键：彻底停止（不是暂停）。跟单击的暂停/继续切换分开，避免逻辑打架。
    // 这个按钮是插进YouTube播放器自己的控制栏（.ytp-right-controls）里的，右键事件
    // 会冒泡到YouTube播放器自己的contextmenu监听器，弹出它自己那套"循环播放/迷你
    // 播放器/复制视频网址"菜单，跟我们的菜单重叠/互相遮挡（颜色还很接近，不容易
    // 看出是两层菜单叠在一起）。只调 preventDefault 只挡得住浏览器原生右键菜单，
    // 挡不住事件继续往上冒泡触发YouTube自己的菜单——必须再调 stopPropagation
    // 才能把事件截在这里，不让它冒泡到YouTube播放器的监听器上。
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const video = document.querySelector('video');
      if (!video) return;
      const sess = getOrCreateSession(video);
      if (sess.started && sess._readMode) stopDubbing(sess, btn);
    });
    return btn;
  }

  function makeDubButton() {
    if (document.getElementById('dub-ext-btn')) return null;
    const btn = document.createElement('button');
    btn.id = 'dub-ext-btn';
    btn.title = '生成中文配音\n左键：默认从头播放缓存配音（完整命中时不调用Gemini）'
      + '\n右键：停止／从当前位置播放缓存／切换男女声／明确重新翻译';
    btn.textContent = '🎧配音';

    // 真正启动配音的流程，左键点击和右键菜单"从当前位置配音"共用这一份逻辑，
    // 只通过 fromCurrentPosition 区分"要不要把视频归零重播"——见 beginDubbing
    // 里 sess._resumeFromCurrentPosition 的使用处。
    async function startDubFlow(fromCurrentPosition, forceRegenerate = false, forcedVoice = null) {
      const video = document.querySelector('video');
      if (!video) return;
      const sess = getOrCreateSession(video);
      const lockedVoice = isChineseDubVoice(forcedVoice) ? forcedVoice : null;
      if (forceRegenerate) {
        const videoId = curVideoId();
        showBufferIndicator('♻ 正在清除本视频缓存，准备重新翻译并生成配音…', video);
        await clearLocalDubVideo(videoId);
        for (const audio of Object.values(sess.audioCache || {})) {
          try { audio?.pause(); } catch (_) {}
        }
        sess.audioCache = {};
        sess.dubSegments = [];
        console.log('[配音插件] 用户明确选择重新生成，已清除本地及服务器缓存：', videoId);
      } else {
        console.log('[配音插件] 默认从头播放缓存配音；完整缓存命中时不会调用Gemini');
      }
      const isAutoContinuation = !!btn._autoContinuation;
      btn._autoContinuation = false;
      sess._forceTranslateOriginal = false;
      // 同上：只有"自动配音"开着、且这次是脚本模拟点击（播放列表自动续播）才自动导出，
      // 手动点按钮配音默认不自动下载变速日志/字幕，要用popup里的按钮手动导出。
      sess._isPlaylistAutoContinue = autoDub;
      if (_continuousTabRecording && autoDub) {
        // 连续播放的底层捕获流仍在，offscreen 已经开启本视频的新分段。
        sess._tabRecording = true;
        sess._recordStartWallClock = Date.now();
      }
      btn._dubVideo = video;
      btn.dataset.dubVideoIdx = '0';
      if (sess.started && !sess._readMode) {
        // 配音中 ⇄ 暂停 切换（无需确认）；继续时从当前视频时间接着配
        if (sess._userPaused) resumeDubbing(sess, btn);
        else pauseDubbing(sess, btn);
        return;
      }
      sess._forcedDubVoice = lockedVoice || null;
      // 勾选“打开视频自动开始配音”时才自动检测男女声；手动启动尊重默认配音员。
      // 右键“切换男女声”会传入 lockedVoice，优先级最高。
      sess._shouldAutoDetectVoice = !lockedVoice && !!autoDub;
      // 取字幕/连云端服务器这一步现在可能要等好几秒到几十秒（尤其连的是云端服务器、
      // 浏览器直取字幕又被限流时）。用户反馈见过"点了没反应，又连点了好几次"——
      // 点击按钮到 sess.started 真正置位中间有一个短暂窗口，这期间再点一次理论上
      // 不该出问题，但为了绝对保险、也让用户能立刻看到反馈，这里点一次就先禁用按钮，
      // 防止手快连点导致同一时间对服务器发出多份重叠请求。
      if (btn.disabled) return;
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 3000);
      if (sess.started && sess._readMode) stopDubbing(sess, document.getElementById('read-ext-btn'));  // 朗读→配音
      if (!isYouTubeLoggedIn()) { showLoginReminder(); return; }
      sess._readMode = false;
      // 默认（左键点击）每次都从0秒归零重播；右键菜单"从当前位置配音"选这个时
      // 设为true，beginDubbing 里会跳过归零，原地等当前位置附近的配音就绪再续播
      // （长视频中途断了、不想从头重新听一遍时用这个）。
      sess._resumeFromCurrentPosition = fromCurrentPosition;

      // 刷新页面后优先看本地缓存：如果已经有本视频字幕缓存 + 配音音频缓存，
      // 不再等待 YouTube 播放器稳定、playerResponse 同步或字幕轨道重建。直接用
      // 现有缓存开播；视频稳定后的字幕预取/校验在后台并行，不阻塞用户观看。
      const fastVideoId = curVideoId();
      if (!forceRegenerate && !sess._readMode) {
        try {
          let cachedSubs = await getCachedSubs(fastVideoId);
          const localRows = await collectLocalDubRows(fastVideoId);
          if (!cachedSubs?.length && localRows?.length) {
            cachedSubs = buildSegmentsFromLocalDubRows(localRows);
            if (cachedSubs.length) {
              console.log(`[配音插件] 字幕缓存缺失，但命中本地音频缓存，已从缓存重建字幕时间轴：${cachedSubs.length}条`);
              setCachedSubs(fastVideoId, cachedSubs);
            }
          }
          if (cachedSubs?.length && localRows?.length) {
            const title = document.title.replace(/ - YouTube$/, '');
            sess._startFromLocalCacheFast = true;
            sess._forceResumeAfterCacheStart = true;
            sess._shouldAutoDetectVoice = false;
            btn.textContent = '🎧缓存启动…';
            console.log(`[配音插件] 刷新后命中本地字幕+配音缓存，跳过视频稳定等待直接启动：字幕${cachedSubs.length}条，音频缓存${localRows.length}条`);
            waitForActualVideoPlayback(video, 12000).then((ok) => {
              if (!ok || !sess.started || sess.videoId !== fastVideoId) return;
              console.log('[配音插件] 视频已稳定，后台并行检查/预取字幕，不影响缓存播放');
              try { prefetchChineseCaptions().catch(() => {}); } catch (_) {}
            }).catch(() => {});
            try {
              await startDubbing(sess, btn, () => Promise.resolve(cachedSubs), fastVideoId, title);
            } finally {
              sess._startFromLocalCacheFast = false;
              sess._forceResumeAfterCacheStart = false;
            }
            return;
          }
        } catch (e) {
          console.warn('[配音插件] 本地缓存快速启动检查失败，回到常规流程', e?.message || e);
        }
      }

      // 连续播放的第二个及后续视频不再依赖页面 CC/播放器字幕轨同步。YouTube 的
      // playerResponse 在 SPA 切换时存在明显竞态，但服务器只需要准确 videoId 就能
      // 用 yt-dlp 取中文字幕；成功后直接进入同一套配音流程，页面轨道仅作失败兜底。
      if (isAutoContinuation) {
        const autoVideoId = curVideoId();
        const autoTitle = document.title.replace(/ - YouTube$/, '');
        try {
          btn.textContent = '🎧获取字幕…';
          const resp = await fetch(`${SERVER}/prefetch_captions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: autoVideoId }),
          });
          const data = await resp.json();
          if (resp.ok && Array.isArray(data.segments) && data.segments.length) {
            captionsReadyForVideo(autoVideoId, data.segments);
            btn.textContent = '🎧准备中…';
            await startDubbing(sess, btn, () => Promise.resolve(data.segments), autoVideoId, autoTitle);
            return;
          }
          console.warn('[配音插件] 自动续播服务器中文字幕为空',
            useGeminiTranslate ? '，尝试原文字幕+Gemini翻译' : '，继续尝试YouTube中文轨');
        } catch (e) {
          console.warn('[配音插件] 自动续播服务器中文字幕失败',
            useGeminiTranslate ? '，尝试原文字幕+Gemini翻译' : '，继续尝试YouTube中文轨', e);
        }

        // 只有用户明确勾选 Gemini 翻译，才允许拿原文字幕交给 Gemini。
        // 未勾选时必须继续走下面的 YouTube 中文字幕轨路径，不能偷偷切换模式。
        if (useGeminiTranslate) {
          for (let i = 0; i < 12 && ytPlayerResponse?.videoDetails?.videoId !== autoVideoId; i++) {
            await sleep(500);
          }
          const originalTrack = pickOriginalCaptionTrack();
          if (originalTrack) {
            let originalSegments = [];
            try {
              if (originalTrack.baseUrl) {
                originalSegments = await fetchSubtitleSegments(originalTrack.baseUrl, false);
              }
            } catch (_) {}
            if (!originalSegments.length && originalTrack.languageCode) {
              try {
                const originalResp = await fetch(`${SERVER}/prefetch_captions`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    video_id: autoVideoId,
                    lang: originalTrack.languageCode,
                  }),
                });
                const originalData = await originalResp.json();
                if (originalResp.ok && Array.isArray(originalData.segments)) {
                  originalSegments = originalData.segments;
                }
              } catch (_) {}
            }
            if (originalSegments.length) {
              sess._forceTranslateOriginal = true;
              captionsReadyForVideo(autoVideoId, originalSegments);
              btn.textContent = '🎧翻译原字幕…';
              await startDubbing(
                sess, btn, () => Promise.resolve(originalSegments), autoVideoId, autoTitle);
              return;
            }
          }
        }
      }
      // ytPlayerResponse 由 inject.js 每500ms异步postMessage过来，切视频瞬间点击
      // （尤其是自动续播场景）可能拿到的还是上一个视频的旧数据——用旧数据取字幕轨道
      // 会查错视频，字幕请求返回空导致静默失败、视频恢复原声播放却没有任何提示。
      // 这里等一下新数据追上来（最多3秒，inject.js的推送间隔是500ms，正常远用不到这么久）。
      const _thisVid = curVideoId();
      for (let _i = 0; _i < 6 && ytPlayerResponse?.videoDetails?.videoId !== _thisVid; _i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!ytPlayerResponse) {
        btn.title = '未拿到播放器数据，请刷新后重试';
        showBufferIndicator('⚠ 未拿到播放器数据，配音未启动，请刷新页面', video);
        setTimeout(() => hideBufferIndicator(), 4000);
        sess.started = false;
        return;
      }
      if (ytPlayerResponse.videoDetails?.videoId !== _thisVid) {
        btn.title = '播放器数据未同步到当前视频，请稍后重试';
        showBufferIndicator('⚠ 播放器数据未跟上，本次配音未启动，请手动重试', video);
        setTimeout(() => hideBufferIndicator(), 4000);
        sess.started = false;
        return;
      }
      const track = useGeminiTranslate ? pickOriginalCaptionTrack() : pickCaptionTrack();
      if (!track) {
        if (!useGeminiTranslate) {
          btn.textContent = '🎧等字幕';
          btn.title = '未获取到字幕，请手动打开 YouTube 字幕：自动翻译→中文（简体）。未调用Gemini。';
          const manualSegs = await waitForManualChineseCaptions(_thisVid, 90000);
          if (manualSegs.length) {
            const title = document.title.replace(/ - YouTube$/, '');
            btn.textContent = '🎧准备中…';
            await startDubbing(sess, btn, () => Promise.resolve(manualSegs), _thisVid, title);
            return;
          }
          btn.textContent = '🎧无字幕';
          sess.started = false;
          return;
        }
        const ok = confirm(
          '此视频无字幕轨道。\n\n' +
          '是否使用本地 Whisper 语音识别 + Gemini 翻译生成字幕？\n' +
          '（需下载视频音频并调用翻译 API，会产生少量 API 费用，耗时约 1-3 分钟）'
        );
        if (!ok) { btn.textContent = '🎧无字幕'; sess.started = false; return; }
        btn.textContent = '🎧转录中…';
        const videoId = curVideoId();
        const title = document.title.replace(/ - YouTube$/, '');
        try {
          const resp = await fetch(`${SERVER}/transcribe_video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ video_id: videoId }),
          });
          const data = await resp.json();
          if (!resp.ok || !data.segments || !data.segments.length) {
            btn.textContent = '🎧转录失败';
            alert('转录失败：' + (data.error || '未知错误'));
            sess.started = false;
            return;
          }
          const segs = data.segments;
          setCachedSubs(videoId, segs);
          btn.textContent = '🎧准备中…';
          await startDubbing(sess, btn, () => Promise.resolve(segs), videoId, title);
        } catch (e) {
          btn.textContent = '🎧转录失败';
          alert('转录请求出错：' + e.message);
          sess.started = false;
        }
        return;
      }
      const videoId = curVideoId();
      const title = document.title.replace(/ - YouTube$/, '');
      btn.textContent = '🎧准备中…';
      // 勾选了"Gemini翻译"：要的是原文（不是YT已经翻译过的二手中文，会失真），
      // 复用朗读模式那套"不挑语言、有什么字幕轨就拿什么"的获取逻辑，不再像
      // getYTCaptions 那样费劲去凑中文。拿到原文后交给服务器用 Gemini 重新翻译。
      const getSegs = useGeminiTranslate
        ? () => getOriginalSegmentsForGemini(track)
        : () => getYTCaptions(track);
      await startDubbing(sess, btn, getSegs, videoId, title);
    }

    async function switchDubGenderAndRestart() {
      const video = document.querySelector('video');
      if (!video) return;
      const sess = getOrCreateSession(video);
      const currentVoice = sess._forcedDubVoice || sess._cachedVoice || sess._autoVoice || getDefaultChineseDubVoice();
      const targetVoice = getOppositeDefaultDubVoice(currentVoice);
      const meta = dubVoiceMeta(targetVoice);
      showBufferIndicator(`🎧 已切换为${meta.gender}：${meta.name}，从头重新开始配音`, video);
      if (sess.started && !sess._readMode) stopDubbing(sess, btn);
      try { video.currentTime = 0; } catch (_) {}
      await startDubFlow(false, false, targetVoice);
    }

    btn.addEventListener('click', async (e) => {
      if (e.isTrusted) _userManuallyStartedDub = true;   // 真人点击才解锁后续自动续播，脚本模拟点击不算
      // 必须在这里（点击处理函数最开头，任何await之前）就立即发起，占住"用户手势"的
      // 有效窗口——见 startRecordingOnClick 注释。真人点击才有真实手势可占；
      // 脚本模拟点击（播放列表自动续播）本来就没有可用的用户手势，tabCapture在那种
      // 场景下必然拿不到，这是Chrome API本身的限制，不是bug。
      if (e.isTrusted) {
        const video = document.querySelector('video');
        if (video) startRecordingOnClick(getOrCreateSession(video));
      }
      await startDubFlow(false, false);   // 左键：默认从头复用缓存，归零重播
    });
    // 右键：配音中弹"停止/补救并恢复"菜单；还没开始配音时弹"从当前位置配音"这一个
    // 选项——长视频中途断了、刷新页面后不想从头重新听一遍时，用这个从当前停留的
    // 位置（不归零）开始配音。不再用双击触发补救——按钮本来就是单击交互，双击
    // 手感很怪，用户反馈过。
    // 这个按钮是插在YouTube播放器控制栏里的，必须同时调 preventDefault（挡浏览器
    // 原生菜单）+ stopPropagation（挡事件冒泡到YouTube播放器自己的contextmenu
    // 监听器），否则YouTube自己的"循环播放/迷你播放器/复制视频网址"菜单会跟着
    // 弹出来，跟我们的菜单重叠、颜色还很接近不容易发现。
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const video = document.querySelector('video');
      if (!video) return;
      const sess = getOrCreateSession(video);
      if (sess.started && !sess._readMode) {
        showDubActionMenu(sess, btn, e.clientX, e.clientY, switchDubGenderAndRestart);
      } else if (!sess.started) {
        showDubStartMenu(
          e.clientX, e.clientY,
          () => {
            _userManuallyStartedDub = true;
            startRecordingOnClick(sess);
            startDubFlow(false, false);
          },
          () => {
            _userManuallyStartedDub = true;
            startRecordingOnClick(sess);
            startDubFlow(true, false);
          },
          () => {
            if (!confirm(
              '这会清除当前视频已有翻译和配音缓存，并重新生成。'
              + (useGeminiTranslate ? '\n已勾选Gemini，将产生新的API费用。' : '')
              + '\n\n确定继续吗？')) return;
            _userManuallyStartedDub = true;
            startRecordingOnClick(sess);
            startDubFlow(false, true);
          },
          switchDubGenderAndRestart,
          async () => {
            const videoId = curVideoId();
            const title = document.title.replace(/ - YouTube$/, '');
            const originalTrack = useGeminiTranslate ? pickOriginalCaptionTrack() : null;
            // Background dubbing deliberately does not auto-detect gender.
            // Lock the user's current Chinese voice; if unset, use the stable
            // Chinese default so later playback cannot silently choose another
            // voice from a noisy/failed speaker sample.
            sess._autoVoice = getDefaultChineseDubVoice();
            showBufferIndicator(
              `后台配音固定使用：${sess._autoVoice}`,
              video);
            let captionSegments = null;
            if (useGeminiTranslate) {
              if (originalTrack) {
                try {
                  captionSegments = await getOriginalSegmentsForGemini(originalTrack);
                } catch (_) {}
              }
            } else {
              captionSegments = await getCachedSubs(videoId);
              if (!captionSegments?.length) {
                if (ytTimedtextVideoId === videoId && ytTimedtextUrl) {
                  try {
                    captionSegments = await fetchSubtitleSegments(ytTimedtextUrl, true);
                    if (captionSegments?.length)
                      captionsReadyForVideo(videoId, captionSegments);
                  } catch (_) {}
                }
              }
              if (!captionSegments?.length) {
                try { await prefetchChineseCaptions(); } catch (_) {}
                for (let attempt = 0; attempt < 10 && !captionSegments?.length; attempt++) {
                  captionSegments = (ytInterceptedVideoId === videoId
                    ? ytInterceptedSegments : null) || await getCachedSubs(videoId);
                  if (!captionSegments?.length)
                    await new Promise((resolve) => setTimeout(resolve, 500));
                }
              }
            }
            if (!captionSegments?.length) {
              showBufferIndicator(
                '⚠ 未获取到字幕，请打开“自动翻译→配音指定字幕”后重试。',
                video);
              return;
            }
            // Use exactly the same cleanup/dedup/sentence grouping as realtime
            // playback. Otherwise "100% background ready" can still miss at a
            // late playhead because the two paths generated different keys.
            captionSegments = prepareSegmentsForBackgroundDub(captionSegments);
            // Lock the voice selected at queue time into every cache key.
            captionSegments = applySessionVoice(sess, captionSegments);
            const voices = [...new Set(
              captionSegments.map((segment) => segment.voice).filter(Boolean))];
            const response = await chrome.runtime.sendMessage({
              action: 'queueBackgroundDub',
              videoId,
              title,
              url: location.href,
              // Never infer Gemini. This is true only when the user checked it.
              useGemini: useGeminiTranslate === true,
              originalLang: originalTrack?.languageCode || '',
              clientId: _clientId,
              captionSegments,
              voices,
            });
            if (response?.ok) {
              setDubButtonBackgroundState('background', videoId, 0);
              startBackgroundDubStatusPolling(videoId);
            }
            showBufferIndicator(
              response?.message || '🎧 已加入后台配音队列，完成后会通知',
              video);
          },
          async () => {
            const videoId = curVideoId();
            const response = await chrome.runtime.sendMessage({
              action: 'cancelBackgroundDub', videoId,
            });
            if (response?.ok) {
              if (_backgroundDubPollTimer) clearInterval(_backgroundDubPollTimer);
              _backgroundDubPollTimer = null;
              setDubButtonBackgroundState('idle', videoId);
            }
            showBufferIndicator(
              response?.message || response?.error || '后台配音停止失败',
              video);
          },
        );
      }
    });
    return btn;
  }

  // 右键小菜单的通用渲染（停止/补救菜单、从当前位置配音菜单共用这一份），
  // 避免每个菜单各自重复一遍定位/样式/点外面关闭这套逻辑。
  function removeDubActionMenu() {
    document.getElementById('dub-action-menu')?.remove();
  }
  function showSmallMenu(items, x, y) {
    removeDubActionMenu();
    const menu = document.createElement('div');
    menu.id = 'dub-action-menu';
    menu.style.cssText =
      'position:fixed;z-index:2147483647;background:rgba(30,30,30,0.95);color:#fff;' +
      'border:1px solid #666;border-radius:6px;padding:4px;font-size:13px;' +
      "font-family:'Microsoft YaHei',sans-serif;min-width:150px;box-shadow:0 2px 10px rgba(0,0,0,0.5);";
    menu.style.left = Math.min(x, window.innerWidth - 160) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 230) + 'px';

    for (const [label, onClick] of items) {
      const item = document.createElement('div');
      item.textContent = label;
      item.style.cssText = 'padding:7px 12px;cursor:pointer;border-radius:4px;white-space:nowrap;';
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.15)'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        removeDubActionMenu();
        onClick();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);

    const closeOnOutside = (ev) => {
      if (!menu.contains(ev.target)) {
        removeDubActionMenu();
        document.removeEventListener('mousedown', closeOnOutside, true);
      }
    };
    document.addEventListener('mousedown', closeOnOutside, true);
  }
  // 停止配音 / 补救并恢复，二选一（配音进行中右键弹出）。
  function showDubActionMenu(sess, btn, x, y, onSwitchGender) {
    showSmallMenu([
      ['⏸ 停止配音', () => stopDubbing(sess, btn)],
      ['🔧 补救并恢复', () => repairDubbing(sess, btn, { resumeAfter: true })],
      ['🔁 切换男女声并从头重配', onSwitchGender],
    ], x, y);
  }
  // 从当前位置配音（还没开始配音时右键弹出）：长视频中途断了、刷新页面后
  // 不想从头重新听一遍，用这个从视频当前停留的位置开始，不归零。
  function showDubStartMenu(
      x, y, onReplayCachedFromStart, onResumeFromCurrent, onRegenerate,
      onSwitchGender, onBackgroundDub, onStopBackgroundDub) {
    const items = [
      ['▶ 从头播放缓存配音（默认）', onReplayCachedFromStart],
      ['⏩ 从当前位置播放缓存配音', onResumeFromCurrent],
      ['🔁 切换男女声并从头重配', onSwitchGender],
      ['🕓 后台配音后通知', onBackgroundDub],
      ['♻ 重新翻译并生成配音', onRegenerate],
    ];
    if (document.getElementById('dub-ext-btn')?.dataset.backgroundDubState === 'processing') {
      items.unshift(['⏹ 停止后台配音', onStopBackgroundDub]);
    }
    showSmallMenu(items, x, y);
  }

  // 普通视频：按设置里选的模式注入对应按钮（配音 或 朗读，只显示一个）
  function injectYTButton() {
    if (isYTShorts()) return;
    if (document.getElementById('dub-ext-btn') || document.getElementById('read-ext-btn')) return;
    const controls = document.querySelector('.ytp-right-controls');
    if (!controls) return;   // 控制栏还没渲染，等下一次重试
    const css =
      'display:inline-flex;align-items:center;justify-content:center;' +
      'width:auto;padding:0 8px;font-size:13px;line-height:48px;' +
      'color:#fff;vertical-align:top;cursor:pointer;opacity:1;';
    const btn = (dubMode === 'read') ? makeReadButton() : makeDubButton();
    if (!btn) return;
    btn.className = 'ytp-button';
    btn.style.cssText = css;
    controls.insertBefore(btn, controls.firstChild);
    console.log(`[配音插件] ✓ ${dubMode === 'read' ? '朗读' : '配音'}按钮已注入控制栏`);
    if (dubMode !== 'read') {
      restoreBackgroundDubIndicatorForCurrentVideo();
    }
  }

  // Shorts：注入到右侧竖向操作栏（点赞/踩/分享按钮区域），找不到则 fixed 悬浮兜底
  function injectShortsButton() {
    if (!isYTShorts()) return;
    if (document.getElementById('dub-ext-btn')) return;
    const btn = makeDubButton();
    if (!btn) return;

    const actionPanel = document.querySelector(
      'ytd-reel-video-renderer[is-active] #actions, ' +
      'ytd-shorts-player-container #actions, ' +
      '#shorts-container #actions, ' +
      'ytd-reel-player-overlay-renderer #actions'
    );
    if (actionPanel) {
      // 圆形图标按钮，融入 Shorts 右侧操作栏
      btn.style.cssText =
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;' +
        'width:48px;height:48px;font-size:22px;cursor:pointer;margin:8px auto;';
      btn.textContent = '🎧';
      const shareBtn = actionPanel.querySelector('ytd-button-renderer, yt-button-shape');
      if (shareBtn) actionPanel.insertBefore(btn, shareBtn);
      else actionPanel.appendChild(btn);
    } else {
      // 选择器没命中：fixed 悬浮在屏幕右侧中部
      btn.style.cssText =
        'position:fixed;right:12px;top:50%;transform:translateY(-50%);z-index:2147483647;' +
        'background:rgba(0,0,0,0.7);color:#fff;border:none;border-radius:24px;' +
        'padding:8px 14px;font-size:14px;cursor:pointer;font-family:"Microsoft YaHei",sans-serif;';
      document.body.appendChild(btn);
    }
    restoreBackgroundDubIndicatorForCurrentVideo();
  }

  const ytObs = new MutationObserver(() => { injectYTButton(); injectShortsButton(); });
  function startYouTubeButtonObserver() {
    if (!document.body) {
      setTimeout(startYouTubeButtonObserver, 80);
      return;
    }
    ytObs.observe(document.body, { childList: true, subtree: true });
    injectYTButton();
    injectShortsButton();
  }
  startYouTubeButtonObserver();
  // 等 storage 读完再注入，避免 autoDub 时序问题
  chrome.storage.local.get({ autoDub: false }, (cfg) => {
    autoDub = cfg.autoDub;
    injectYTButton();
    injectShortsButton();
  });
}

// ============================================================
// ===== 通用视频（非YouTube）=====
// ============================================================
if (!IS_YOUTUBE) {
  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h).toString(36);
  }

  // ===== Bilibili 字幕拦截 =====
  let biliInterceptedSubs = null;
  let biliSubWaiter = null;

  // 注入拦截脚本
  (function injectBiliScript() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject_bilibili.js');
    document.documentElement.appendChild(s);
    s.remove();
  })();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__dubExt) return;
    if (e.data.type === 'biliSubtitle' && e.data.body?.length) {
      console.log('[配音插件] 拦截到B站字幕', e.data.body.length, '条');
      biliInterceptedSubs = e.data.body.map((item) => ({
        start: item.from,
        end: item.to,
        text: item.content,
      }));
      if (biliSubWaiter) { biliSubWaiter(biliInterceptedSubs); biliSubWaiter = null; }
    } else if (e.data.type === 'biliImportPlaylist') {
      // 处理 Bilibili 搜索页面的播放列表导入
      const { playlistName, videos } = e.data;
      console.log('[配音插件] 导入B站播放列表:', playlistName, '包含', videos.length, '个视频');
      chrome.runtime.sendMessage({
        action: 'createPlaylist',
        name: playlistName,
        videos: videos.map(v => ({ id: v.id, title: v.title }))
      }, (resp) => {
        console.log('[配音插件] 创建播放列表响应:', resp);
      });
    } else if (e.data.type === 'ytImportPlaylist') {
      // 处理 YouTube 搜索页面的播放列表导入
      const { playlistName, videos } = e.data;
      console.log('[配音插件] 导入YouTube播放列表:', playlistName, '包含', videos.length, '个视频');
      chrome.runtime.sendMessage({
        action: 'createPlaylist',
        name: playlistName,
        videos: videos.map(v => ({ id: v.id, title: v.title }))
      }, (resp) => {
        console.log('[配音插件] 创建播放列表响应:', resp);
      });
    } else if (e.data.type === 'getPrefetchStatus') {
      // Bilibili 搜索页面请求配音状态
      chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, (st) => {
        if (st?.videoStates) {
          // 将状态发送回 inject_bilibili.js
          Object.entries(st.videoStates).forEach(([videoId, status]) => {
            // 获取视频标题（从 collected_videos 中查找）
            chrome.storage.local.get({ collected_videos: [] }, (storage) => {
              const video = storage.collected_videos.find(v => v.id === videoId);
              const title = video?.title || videoId;
              window.postMessage({
                __dubExt: true,
                type: 'updateDubStatus',
                videoId,
                status,
                title
              }, '*');
            });
          });
        }
      });
    }
  });

  function waitForBiliSubs(ms) {
    if (biliInterceptedSubs?.length) return Promise.resolve(biliInterceptedSubs);
    return new Promise((resolve) => {
      let done = false;
      biliSubWaiter = (s) => { if (!done) { done = true; resolve(s); } };
      setTimeout(() => { if (!done) { done = true; biliSubWaiter = null; resolve(null); } }, ms);
    });
  }

  // ===== Bilibili 字幕获取 =====
  function getBilibiliIds() {
    let aid, bvid, cid;
    // 1. 从 URL 路径拿 BV号 / av号
    const pathM = location.pathname.match(/\/(BV[a-zA-Z0-9]+|av(\d+))/i);
    if (pathM) {
      if (pathM[1].toUpperCase().startsWith('BV')) bvid = pathM[1];
      else aid = pathM[2];
    }
    const params = new URL(location.href).searchParams;
    if (!aid) aid = params.get('aid');
    if (!bvid) bvid = params.get('bvid');
    // 2. 从页面变量拿 cid（和 aid/bvid 兜底）
    try {
      const st = window.__INITIAL_STATE__;
      if (st) {
        if (!aid) aid = st.aid || st.videoData?.aid;
        if (!bvid) bvid = st.bvid || st.videoData?.bvid;
        // 优先取当前分P的cid
        const pageNum = parseInt(new URL(location.href).searchParams.get('p') || '1', 10);
        const pages = st.videoData?.pages || st.pages || [];
        const curPage = pages[pageNum - 1];
        cid = curPage?.cid || st.cid || st.videoData?.cid || st.epInfo?.cid;
      }
    } catch (_) {}
    // 3. 正则扫 HTML（兜底）
    if (!cid) {
      try {
        const m = document.documentElement.innerHTML.match(/"cid"\s*[=:]\s*(\d+)/);
        if (m) cid = m[1];
      } catch (_) {}
    }
    console.log('[配音插件] B站 ids:', { aid, bvid, cid });
    return { aid, bvid, cid };
  }

  async function getBilibiliSubtitles() {
    // 已拦截到直接用（和平台显示完全一致）
    if (biliInterceptedSubs?.length) {
      console.log('[配音插件] 使用拦截字幕', biliInterceptedSubs.length, '条');
      return biliInterceptedSubs;
    }
    // 两路并行：拦截 vs API，谁先返回有效数据用谁
    async function fetchViaApi() {
      let { aid, bvid, cid } = getBilibiliIds();
      if (!cid && (bvid || aid)) {
        try {
          const idParam = bvid ? `bvid=${bvid}` : `aid=${aid}`;
          const pr = await fetch(`https://api.bilibili.com/x/player/pagelist?${idParam}`, { credentials: 'include' });
          const pd = await pr.json();
          const pageNum = parseInt(new URL(location.href).searchParams.get('p') || '1', 10);
          cid = pd?.data?.[pageNum - 1]?.cid || pd?.data?.[0]?.cid;
          console.log('[配音插件] pagelist cid:', cid, '第', pageNum, 'P');
        } catch (e) { console.warn('[配音插件] pagelist 失败', e); }
      }
      if (!cid) return [];
      const idParam = bvid ? `bvid=${bvid}` : `aid=${aid}`;
      try {
        const resp = await fetch(`https://api.bilibili.com/x/player/v2?${idParam}&cid=${cid}`, { credentials: 'include' });
        const data = await resp.json();
        const subs = data?.data?.subtitle?.subtitles || [];
        console.log('[配音插件] 字幕轨:', subs.map((s) => `${s.lan}/${s.lan_doc}`));
        const sub = subs.find((s) => s.lan_doc?.includes('中文') || s.lan?.includes('zh')) || subs[0];
        if (!sub?.subtitle_url) return [];
        const url = sub.subtitle_url.startsWith('//') ? 'https:' + sub.subtitle_url : sub.subtitle_url;
        const sresp = await fetch(url);
        const sdata = await sresp.json();
        return (sdata.body || []).map((item) => ({ start: item.from, end: item.to, text: item.content }));
      } catch (e) { console.warn('[配音插件] API字幕失败', e); return []; }
    }

    const [intercepted, fromApi] = await Promise.all([
      waitForBiliSubs(5000),
      fetchViaApi(),
    ]);
    // 拦截到的优先（与平台完全一致），否则用 API 结果
    const result = intercepted?.length ? intercepted : fromApi;
    console.log('[配音插件] 最终字幕来源:', intercepted?.length ? '拦截' : 'API', result.length, '条');
    return result;
  }

  async function getGenericSubtitles(video) {
    console.log('[配音插件] getGenericSubtitles hostname:', location.hostname);
    // Bilibili 专属（www.bilibili.com / live.bilibili.com 等）
    if (/bilibili\.com/.test(location.hostname)) {
      return await getBilibiliSubtitles();
    }
    // 标准 <track> 字幕（其他平台）
    const trackEl = video.querySelector('track[kind="subtitles"],track[kind="captions"]') ||
                    video.querySelector('track');
    if (trackEl && trackEl.src) {
      try {
        const resp = await fetch(trackEl.src);
        const text = await resp.text();
        const segs = parseVTT(text);
        if (segs.length) return segs;
      } catch (_) {}
    }
    return [];
  }

  // 用 position:fixed 贴在视频右上角，避免父容器 overflow:hidden 裁剪
  function makeFixedBtn(video) {
    const btn = document.createElement('button');
    btn.textContent = '🎧配音';
    btn.title = '生成中文配音';
    btn.style.cssText =
      'position:fixed;z-index:2147483647;display:none;' +
      'background:rgba(0,0,0,0.70);color:#fff;border:none;border-radius:6px;' +
      "padding:5px 14px;font-size:13px;cursor:pointer;font-family:'Microsoft YaHei',sans-serif;" +
      'box-shadow:0 2px 8px rgba(0,0,0,0.4);';
    document.body.appendChild(btn);

    function reposition() {
      const r = video.getBoundingClientRect();
      // 视频不在视口内或太小则隐藏按钮
      if (r.width < 80 || r.height < 50 ||
          r.bottom < 0 || r.top > window.innerHeight ||
          r.right < 0 || r.left > window.innerWidth) {
        btn.style.display = 'none';
        return;
      }
      btn.style.display = 'block';
      // 贴视频外边缘：优先放在视频上边缘外侧（不进入视频画面，录屏不会拍到）；
      // 上方空间不足时放到下边缘外侧。
      const above = r.top - 34;
      if (above > 4) btn.style.top = above + 'px';
      else btn.style.top = (r.bottom + 6) + 'px';
      btn.style.right = Math.max(4, window.innerWidth - r.right) + 'px';
    }

    reposition();
    // 跟随视频位置变化（滚动/全屏/布局变化）
    const ro = new ResizeObserver(reposition);
    ro.observe(video);
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    btn._cleanup = () => { ro.disconnect(); };

    btn._dubVideo = video;
    btn.dataset.dubVideoIdx = String(Math.random());

    btn.addEventListener('click', async () => {
      const sess = getOrCreateSession(video);
      if (sess.started) {
        if (sess._userPaused) resumeDubbing(sess, btn);
        else pauseDubbing(sess, btn);
        return;
      }
      const videoSrc = video.currentSrc || video.src || location.href;
      const videoId = 'gen_' + simpleHash(videoSrc);
      const title = document.title || 'untitled';
      btn.textContent = '🎧准备中…';
      await startDubbing(sess, btn, () => getGenericSubtitles(video), videoId, title);
    });

    return btn;
  }

  function addButtonToVideo(video) {
    if (video._dubBtnInjected) return;
    // 跳过太小的 video（广告像素、头像等）
    if (video.offsetWidth < 80 && video.offsetWidth !== 0) return;
    video._dubBtnInjected = true;
    makeFixedBtn(video);
  }

  function scanVideos() {
    document.querySelectorAll('video').forEach(addButtonToVideo);
  }

  const genericObs = new MutationObserver(scanVideos);
  genericObs.observe(document.body, { childList: true, subtree: true });
  scanVideos();
}

// ===== 后台预取字幕支持 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'dubBackgroundReady') {
    startBackgroundDubStatusPolling(message.videoId);
    document.getElementById(`dub-ready-${message.videoId}`)?.remove();
    const notice = document.createElement('div');
    notice.id = `dub-ready-${message.videoId}`;
    notice.style.cssText =
      'position:absolute;z-index:2147483647;max-width:420px;' +
      'background:#173d27;color:#fff;padding:14px 42px 14px 16px;border-radius:10px;' +
      'box-shadow:0 5px 24px rgba(0,0,0,.45);font:14px/1.5 Microsoft YaHei,sans-serif;';
    const link = document.createElement('a');
    link.href = message.url;
    link.textContent = `✅ 完整配音已就绪：${message.title}`;
    link.style.cssText = 'color:#fff;text-decoration:underline;font-weight:700;';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '关闭';
    close.style.cssText =
      'position:absolute;right:8px;top:7px;border:0;background:transparent;' +
      'color:#fff;font-size:22px;cursor:pointer;';
    close.onclick = () => notice.remove();
    notice.append(link, close);
    document.body.appendChild(notice);
    placeElOutsideVideo(notice);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'dubBackgroundFailed') {
    setDubButtonBackgroundState('idle', message.videoId);
    const video = document.querySelector('video');
    showBufferIndicator(
      `❌ 后台配音失败：${message.error || '未知错误'}。可右键重新加入后台队列。`,
      video);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === 'tabRecordingArmed') {
    _continuousTabRecording = true;
    if (_lastActiveSess) {
      _lastActiveSess._tabRecording = true;
      _lastActiveSess._recordStartWallClock = Date.now();
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.action === 'getPrefetchCaptions') {
    // 后台任务请求获取特定视频的字幕
    const videoId = message.videoId;
    console.log('[配音插件] 后台预取请求:', videoId);

    // 因为内容脚本无法直接导航到其他视频，我们通过本地服务器来获取
    // 服务器会用 yt-dlp 等工具来获取字幕
    fetch(`${SERVER}/prefetch_captions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId })
    })
    .then(r => r.json())
    .then(data => {
      console.log('[配音插件] 后台预取成功:', videoId, data.segments?.length, '条');
      sendResponse({ segments: data.segments || [] });
    })
    .catch(e => {
      console.error('[配音插件] 后台预取失败:', e);
      sendResponse({ segments: [] });
    });

    return true; // 异步回复
  }

  if (message.action === 'extractPlaylistVideos') {
    // 从当前播放列表页面提取视频 ID 列表
    if (IS_YOUTUBE) {
      try {
        // 访问 window.ytInitialData（由 YouTube 注入）
        if (window.ytInitialData?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents) {
          const contents = window.ytInitialData.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents;
          const videos = [];

          for (const section of contents) {
            const items = section?.itemSectionRenderer?.contents?.[0]?.playlistVideoListRenderer?.contents || [];
            for (const item of items) {
              const id = item?.playlistVideoRenderer?.videoId;
              if (id && id !== 'rCEQHOZQvn0') videos.push(id); // 避免播放列表本身
            }
          }

          console.log('[配音插件] 从播放列表提取了', videos.length, '个视频');
          sendResponse({ videos });
          return true;
        }
      } catch (e) {
        console.error('[配音插件] 提取播放列表失败:', e);
      }
    }

    sendResponse({ videos: [] });
    return true;
  }

  if (message.action === 'exportRateLog') {
    // popup里手动点"下载变速日志"——正常情况点"停止配音"会自动导出，这个按钮
    // 是给"忘了点停止就关页面/中途想先导出看一下"这种情况兜底用的。字幕（SRT）
    // 跟变速日志同一套时间轴，一起导出，省得用户再单独找一个按钮。
    const sessions = activeSessions().filter((s) =>
      (s._rateLog && s._rateLog.length)
      || (s._subtitleLog && s._subtitleLog.length)
      || (s._sourceRawSubtitles && s._sourceRawSubtitles.length));
    if (!sessions.length) {
      sendResponse({ ok: false, error: '当前没有可导出的记录（还没开始配音，或这个session还没产生过变速/字幕）' });
      return true;
    }
    sessions.forEach((s) => {
      exportRateLog(s);
      exportSubtitles(s);
      exportKaraokeSubtitles(s);
      exportRawSourceSubtitles(s);
      exportDiagnosticLog(s);
    });
    sendResponse({ ok: true, count: sessions.length });
    return true;
  }
});

// ===== YouTube 点赞时自动收藏 =====
if (IS_YOUTUBE) {
  function getVideoInfo() {
    const url = new URL(location.href);
    const videoId = url.searchParams.get('v');
    if (!videoId) return null;

    const titleEl = document.querySelector('h1 yt-formatted-string, yt-formatted-string.title a, #title a');
    const title = titleEl?.textContent?.trim() || document.title;

    const channelEl = document.querySelector('ytd-channel-tagline-renderer a, #channel-name a');
    const channelTitle = channelEl?.textContent?.trim() || 'Unknown Channel';

    return { videoId, title, channelTitle };
  }

  // 监听点赞按钮点击
  function setupLikeListener() {
    const observer = new MutationObserver(() => {
      // 查找点赞按钮（YouTube 的按钮 ID 通常包含 like）
      const likeButton = document.querySelector('[aria-label*="点赞"], [aria-label*="Like"], [aria-label*="顶"]');
      if (likeButton && !likeButton._dubLikeListener) {
        likeButton._dubLikeListener = true;
        likeButton.addEventListener('click', () => {
          setTimeout(() => {
            const info = getVideoInfo();
            if (info && likeButton.getAttribute('aria-pressed') === 'true') {
              // 用户点赞了，自动收藏
              const videoData = {
                id: info.videoId,
                title: info.title,
                channelTitle: info.channelTitle,
                publishedAt: new Date().toISOString(),
                collectedAt: Date.now()
              };

              // 保存到 chrome.storage.local
              chrome.storage.local.get({ collected_videos: [] }, (result) => {
                const videos = result.collected_videos;
                if (!videos.find(v => v.id === videoData.id)) {
                  videos.push(videoData);
                  chrome.storage.local.set({ collected_videos: videos });
                  console.log('[配音插件] ✓ 已自动收藏:', info.title);

                  // 创建浮窗提示
                  const toast = document.createElement('div');
                  toast.textContent = '✓ 已收藏到播放列表';
                  toast.style.cssText = `
                    position: absolute; z-index: 99999;
                    background: #4caf50; color: white; padding: 12px 16px; border-radius: 4px;
                    font-size: 12px; font-family: Arial; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                  `;
                  document.body.appendChild(toast);
                  placeElOutsideVideo(toast);
                  setTimeout(() => toast.remove(), 2000);
                }
              });
            }
          }, 500);
        });
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  setupLikeListener();
}
