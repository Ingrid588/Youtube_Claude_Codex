// 配音服务器地址：跟 content.js/background.js 共用同一个 chrome.storage 设置（serverUrl）。
// 默认指向云端服务（Cloud Run），没自己搭本机/局域网服务的用户不用填任何东西。
// popup 这边发的请求（试听、清缓存、批量队列等）也要跟着用这个地址，不然只改了
// content.js 那边，popup 里的功能还是连着旧地址，连不上。
const DEFAULT_SERVER = 'https://dub-server-921963653375.us-central1.run.app';
const TEST_SERVER = 'https://ingrid919-dub-server.hf.space';
const TEST_SERVER_CONTROL = 'http://127.0.0.1:8766';
let SERVER = DEFAULT_SERVER;
try {
  const versionEl = document.getElementById('extensionVersion');
  if (versionEl) versionEl.textContent = `v${chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version}`;
} catch (_) {}
chrome.storage.local.get({ serverUrl: '' }, (cfg) => {
  if (cfg.serverUrl) SERVER = cfg.serverUrl.trim().replace(/\/+$/, '');
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.serverUrl) {
    SERVER = (changes.serverUrl.newValue || DEFAULT_SERVER).replace(/\/+$/, '');
  }
});

// edge-tts 目前全部中文配音员（zh-CN/zh-HK/zh-TW，含方言），通过 edge-tts --list-voices 核对，
// 一共 14 个：zh-CN 8个(含辽宁/陕西方言)、zh-HK 3个(粤语)、zh-TW 3个(台湾国语)。
const MALE_VOICES = [
  { value: 'zh-CN-YunxiNeural',   label: '云希（青年）' },
  { value: 'zh-CN-YunyangNeural', label: '云扬（播音）' },
  { value: 'zh-CN-YunjianNeural', label: '云健（成熟）' },
  { value: 'zh-CN-YunxiaNeural',  label: '云夏（温和）' },
  { value: 'zh-HK-WanLungNeural', label: '云龙（粤语）' },
  { value: 'zh-TW-YunJheNeural',  label: '云哲（台湾国语）' },
];
const FEMALE_VOICES = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓（温暖）' },
  { value: 'zh-CN-XiaoyiNeural',   label: '晓伊（活泼）' },
  { value: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北（东北方言）' },
  { value: 'zh-CN-shaanxi-XiaoniNeural',   label: '晓妮（陕西方言）' },
  { value: 'zh-HK-HiuGaaiNeural', label: '晓佳（粤语）' },
  { value: 'zh-HK-HiuMaanNeural', label: '晓曼（粤语）' },
  { value: 'zh-TW-HsiaoChenNeural', label: '晓臻（台湾国语）' },
  { value: 'zh-TW-HsiaoYuNeural',   label: '晓雨（台湾国语）' },
];
const MALE_DEFAULTS   = ['zh-CN-YunxiNeural',    'zh-CN-YunyangNeural'];
const FEMALE_DEFAULTS = ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural'];

// 朗读 + 配音共用的"语言 → 配音员"对照表，覆盖 edge-tts 全部 75 种语言。
// default_voice/default_label/default_gender 是当前已经在用的默认音色（跟 content.js 的
// _READ_VOICE_MAP、live_dub_server.py 的 lang_prefix_voice 保持一致，不会因为加了这个面板
// 就悄悄换掉老用户已经在用的声音）；alt_* 是同语言里另一种性别的备选音色。
// 用 edge-tts --list-voices 生成，详见 gen_lang_voice_table.py。
const LANG_VOICE_TABLE = [{"code": "af", "name": "南非荷兰语", "default_voice": "af-ZA-AdriNeural", "default_label": "Adri", "default_gender": "female", "alt_voice": "af-ZA-WillemNeural", "alt_label": "Willem", "alt_gender": "male"}, {"code": "am", "name": "阿姆哈拉语", "default_voice": "am-ET-AmehaNeural", "default_label": "Ameha", "default_gender": "male", "alt_voice": "am-ET-MekdesNeural", "alt_label": "Mekdes", "alt_gender": "female"}, {"code": "ar", "name": "阿拉伯语", "default_voice": "ar-SA-HamedNeural", "default_label": "Hamed", "default_gender": "male", "alt_voice": "ar-SA-ZariyahNeural", "alt_label": "Zariyah", "alt_gender": "female"}, {"code": "az", "name": "阿塞拜疆语", "default_voice": "az-AZ-BabekNeural", "default_label": "Babek", "default_gender": "male", "alt_voice": "az-AZ-BanuNeural", "alt_label": "Banu", "alt_gender": "female"}, {"code": "bg", "name": "保加利亚语", "default_voice": "bg-BG-BorislavNeural", "default_label": "Borislav", "default_gender": "male", "alt_voice": "bg-BG-KalinaNeural", "alt_label": "Kalina", "alt_gender": "female"}, {"code": "bn", "name": "孟加拉语", "default_voice": "bn-BD-NabanitaNeural", "default_label": "Nabanita", "default_gender": "female", "alt_voice": "bn-BD-PradeepNeural", "alt_label": "Pradeep", "alt_gender": "male"}, {"code": "bs", "name": "波斯尼亚语", "default_voice": "bs-BA-VesnaNeural", "default_label": "Vesna", "default_gender": "female", "alt_voice": "bs-BA-GoranNeural", "alt_label": "Goran", "alt_gender": "male"}, {"code": "ca", "name": "加泰罗尼亚语", "default_voice": "ca-ES-JoanaNeural", "default_label": "Joana", "default_gender": "female", "alt_voice": "ca-ES-EnricNeural", "alt_label": "Enric", "alt_gender": "male"}, {"code": "cs", "name": "捷克语", "default_voice": "cs-CZ-AntoninNeural", "default_label": "Antonin", "default_gender": "male", "alt_voice": "cs-CZ-VlastaNeural", "alt_label": "Vlasta", "alt_gender": "female"}, {"code": "cy", "name": "威尔士语", "default_voice": "cy-GB-AledNeural", "default_label": "Aled", "default_gender": "male", "alt_voice": "cy-GB-NiaNeural", "alt_label": "Nia", "alt_gender": "female"}, {"code": "da", "name": "丹麦语", "default_voice": "da-DK-JeppeNeural", "default_label": "Jeppe", "default_gender": "male", "alt_voice": "da-DK-ChristelNeural", "alt_label": "Christel", "alt_gender": "female"}, {"code": "de", "name": "德语", "default_voice": "de-DE-FlorianMultilingualNeural", "default_label": "FlorianMultilingual", "default_gender": "male", "alt_voice": "de-DE-AmalaNeural", "alt_label": "Amala", "alt_gender": "female"}, {"code": "el", "name": "希腊语", "default_voice": "el-GR-NestorasNeural", "default_label": "Nestoras", "default_gender": "male", "alt_voice": "el-GR-AthinaNeural", "alt_label": "Athina", "alt_gender": "female"}, {"code": "en", "name": "英语", "default_voice": "en-US-AriaNeural", "default_label": "Aria", "default_gender": "female", "alt_voice": "en-US-AndrewMultilingualNeural", "alt_label": "AndrewMultilingual", "alt_gender": "male"}, {"code": "es", "name": "西班牙语", "default_voice": "es-ES-AlvaroNeural", "default_label": "Alvaro", "default_gender": "male", "alt_voice": "es-ES-ElviraNeural", "alt_label": "Elvira", "alt_gender": "female"}, {"code": "et", "name": "爱沙尼亚语", "default_voice": "et-EE-AnuNeural", "default_label": "Anu", "default_gender": "female", "alt_voice": "et-EE-KertNeural", "alt_label": "Kert", "alt_gender": "male"}, {"code": "fa", "name": "波斯语", "default_voice": "fa-IR-DilaraNeural", "default_label": "Dilara", "default_gender": "female", "alt_voice": "fa-IR-FaridNeural", "alt_label": "Farid", "alt_gender": "male"}, {"code": "fi", "name": "芬兰语", "default_voice": "fi-FI-HarriNeural", "default_label": "Harri", "default_gender": "male", "alt_voice": "fi-FI-NooraNeural", "alt_label": "Noora", "alt_gender": "female"}, {"code": "fil", "name": "菲律宾语", "default_voice": "fil-PH-AngeloNeural", "default_label": "Angelo", "default_gender": "male", "alt_voice": "fil-PH-BlessicaNeural", "alt_label": "Blessica", "alt_gender": "female"}, {"code": "fr", "name": "法语", "default_voice": "fr-FR-DeniseNeural", "default_label": "Denise", "default_gender": "female", "alt_voice": "fr-FR-HenriNeural", "alt_label": "Henri", "alt_gender": "male"}, {"code": "ga", "name": "爱尔兰语", "default_voice": "ga-IE-ColmNeural", "default_label": "Colm", "default_gender": "male", "alt_voice": "ga-IE-OrlaNeural", "alt_label": "Orla", "alt_gender": "female"}, {"code": "gl", "name": "加利西亚语", "default_voice": "gl-ES-RoiNeural", "default_label": "Roi", "default_gender": "male", "alt_voice": "gl-ES-SabelaNeural", "alt_label": "Sabela", "alt_gender": "female"}, {"code": "gu", "name": "古吉拉特语", "default_voice": "gu-IN-NiranjanNeural", "default_label": "Niranjan", "default_gender": "male", "alt_voice": "gu-IN-DhwaniNeural", "alt_label": "Dhwani", "alt_gender": "female"}, {"code": "he", "name": "希伯来语", "default_voice": "he-IL-AvriNeural", "default_label": "Avri", "default_gender": "male", "alt_voice": "he-IL-HilaNeural", "alt_label": "Hila", "alt_gender": "female"}, {"code": "hi", "name": "印地语", "default_voice": "hi-IN-MadhurNeural", "default_label": "Madhur", "default_gender": "male", "alt_voice": "hi-IN-SwaraNeural", "alt_label": "Swara", "alt_gender": "female"}, {"code": "hr", "name": "克罗地亚语", "default_voice": "hr-HR-SreckoNeural", "default_label": "Srecko", "default_gender": "male", "alt_voice": "hr-HR-GabrijelaNeural", "alt_label": "Gabrijela", "alt_gender": "female"}, {"code": "hu", "name": "匈牙利语", "default_voice": "hu-HU-TamasNeural", "default_label": "Tamas", "default_gender": "male", "alt_voice": "hu-HU-NoemiNeural", "alt_label": "Noemi", "alt_gender": "female"}, {"code": "id", "name": "印尼语", "default_voice": "id-ID-ArdiNeural", "default_label": "Ardi", "default_gender": "male", "alt_voice": "id-ID-GadisNeural", "alt_label": "Gadis", "alt_gender": "female"}, {"code": "is", "name": "冰岛语", "default_voice": "is-IS-GudrunNeural", "default_label": "Gudrun", "default_gender": "female", "alt_voice": "is-IS-GunnarNeural", "alt_label": "Gunnar", "alt_gender": "male"}, {"code": "it", "name": "意大利语", "default_voice": "it-IT-GiuseppeMultilingualNeural", "default_label": "GiuseppeMultilingual", "default_gender": "male", "alt_voice": "it-IT-ElsaNeural", "alt_label": "Elsa", "alt_gender": "female"}, {"code": "iu", "name": "因纽特语", "default_voice": "iu-Latn-CA-SiqiniqNeural", "default_label": "Siqiniq", "default_gender": "female", "alt_voice": "iu-Latn-CA-TaqqiqNeural", "alt_label": "Taqqiq", "alt_gender": "male"}, {"code": "ja", "name": "日语", "default_voice": "ja-JP-NanamiNeural", "default_label": "Nanami", "default_gender": "female", "alt_voice": "ja-JP-KeitaNeural", "alt_label": "Keita", "alt_gender": "male"}, {"code": "jv", "name": "爪哇语", "default_voice": "jv-ID-DimasNeural", "default_label": "Dimas", "default_gender": "male", "alt_voice": "jv-ID-SitiNeural", "alt_label": "Siti", "alt_gender": "female"}, {"code": "ka", "name": "格鲁吉亚语", "default_voice": "ka-GE-GiorgiNeural", "default_label": "Giorgi", "default_gender": "male", "alt_voice": "ka-GE-EkaNeural", "alt_label": "Eka", "alt_gender": "female"}, {"code": "kk", "name": "哈萨克语", "default_voice": "kk-KZ-AigulNeural", "default_label": "Aigul", "default_gender": "female", "alt_voice": "kk-KZ-DauletNeural", "alt_label": "Daulet", "alt_gender": "male"}, {"code": "km", "name": "高棉语", "default_voice": "km-KH-PisethNeural", "default_label": "Piseth", "default_gender": "male", "alt_voice": "km-KH-SreymomNeural", "alt_label": "Sreymom", "alt_gender": "female"}, {"code": "kn", "name": "卡纳达语", "default_voice": "kn-IN-GaganNeural", "default_label": "Gagan", "default_gender": "male", "alt_voice": "kn-IN-SapnaNeural", "alt_label": "Sapna", "alt_gender": "female"}, {"code": "ko", "name": "韩语", "default_voice": "ko-KR-HyunsuMultilingualNeural", "default_label": "HyunsuMultilingual", "default_gender": "male", "alt_voice": "ko-KR-SunHiNeural", "alt_label": "SunHi", "alt_gender": "female"}, {"code": "lo", "name": "老挝语", "default_voice": "lo-LA-ChanthavongNeural", "default_label": "Chanthavong", "default_gender": "male", "alt_voice": "lo-LA-KeomanyNeural", "alt_label": "Keomany", "alt_gender": "female"}, {"code": "lt", "name": "立陶宛语", "default_voice": "lt-LT-LeonasNeural", "default_label": "Leonas", "default_gender": "male", "alt_voice": "lt-LT-OnaNeural", "alt_label": "Ona", "alt_gender": "female"}, {"code": "lv", "name": "拉脱维亚语", "default_voice": "lv-LV-EveritaNeural", "default_label": "Everita", "default_gender": "female", "alt_voice": "lv-LV-NilsNeural", "alt_label": "Nils", "alt_gender": "male"}, {"code": "mk", "name": "马其顿语", "default_voice": "mk-MK-AleksandarNeural", "default_label": "Aleksandar", "default_gender": "male", "alt_voice": "mk-MK-MarijaNeural", "alt_label": "Marija", "alt_gender": "female"}, {"code": "ml", "name": "马拉雅拉姆语", "default_voice": "ml-IN-MidhunNeural", "default_label": "Midhun", "default_gender": "male", "alt_voice": "ml-IN-SobhanaNeural", "alt_label": "Sobhana", "alt_gender": "female"}, {"code": "mn", "name": "蒙古语", "default_voice": "mn-MN-BataaNeural", "default_label": "Bataa", "default_gender": "male", "alt_voice": "mn-MN-YesuiNeural", "alt_label": "Yesui", "alt_gender": "female"}, {"code": "mr", "name": "马拉地语", "default_voice": "mr-IN-AarohiNeural", "default_label": "Aarohi", "default_gender": "female", "alt_voice": "mr-IN-ManoharNeural", "alt_label": "Manohar", "alt_gender": "male"}, {"code": "ms", "name": "马来语", "default_voice": "ms-MY-OsmanNeural", "default_label": "Osman", "default_gender": "male", "alt_voice": "ms-MY-YasminNeural", "alt_label": "Yasmin", "alt_gender": "female"}, {"code": "mt", "name": "马耳他语", "default_voice": "mt-MT-GraceNeural", "default_label": "Grace", "default_gender": "female", "alt_voice": "mt-MT-JosephNeural", "alt_label": "Joseph", "alt_gender": "male"}, {"code": "my", "name": "缅甸语", "default_voice": "my-MM-NilarNeural", "default_label": "Nilar", "default_gender": "female", "alt_voice": "my-MM-ThihaNeural", "alt_label": "Thiha", "alt_gender": "male"}, {"code": "nb", "name": "挪威语", "default_voice": "nb-NO-FinnNeural", "default_label": "Finn", "default_gender": "male", "alt_voice": "nb-NO-PernilleNeural", "alt_label": "Pernille", "alt_gender": "female"}, {"code": "ne", "name": "尼泊尔语", "default_voice": "ne-NP-HemkalaNeural", "default_label": "Hemkala", "default_gender": "female", "alt_voice": "ne-NP-SagarNeural", "alt_label": "Sagar", "alt_gender": "male"}, {"code": "nl", "name": "荷兰语", "default_voice": "nl-NL-MaartenNeural", "default_label": "Maarten", "default_gender": "male", "alt_voice": "nl-NL-ColetteNeural", "alt_label": "Colette", "alt_gender": "female"}, {"code": "pl", "name": "波兰语", "default_voice": "pl-PL-MarekNeural", "default_label": "Marek", "default_gender": "male", "alt_voice": "pl-PL-ZofiaNeural", "alt_label": "Zofia", "alt_gender": "female"}, {"code": "ps", "name": "普什图语", "default_voice": "ps-AF-GulNawazNeural", "default_label": "GulNawaz", "default_gender": "male", "alt_voice": "ps-AF-LatifaNeural", "alt_label": "Latifa", "alt_gender": "female"}, {"code": "pt", "name": "葡萄牙语", "default_voice": "pt-BR-ThalitaMultilingualNeural", "default_label": "ThalitaMultilingual", "default_gender": "female", "alt_voice": "pt-BR-AntonioNeural", "alt_label": "Antonio", "alt_gender": "male"}, {"code": "ro", "name": "罗马尼亚语", "default_voice": "ro-RO-AlinaNeural", "default_label": "Alina", "default_gender": "female", "alt_voice": "ro-RO-EmilNeural", "alt_label": "Emil", "alt_gender": "male"}, {"code": "ru", "name": "俄语", "default_voice": "ru-RU-DmitryNeural", "default_label": "Dmitry", "default_gender": "male", "alt_voice": "ru-RU-SvetlanaNeural", "alt_label": "Svetlana", "alt_gender": "female"}, {"code": "si", "name": "僧伽罗语", "default_voice": "si-LK-SameeraNeural", "default_label": "Sameera", "default_gender": "male", "alt_voice": "si-LK-ThiliniNeural", "alt_label": "Thilini", "alt_gender": "female"}, {"code": "sk", "name": "斯洛伐克语", "default_voice": "sk-SK-LukasNeural", "default_label": "Lukas", "default_gender": "male", "alt_voice": "sk-SK-ViktoriaNeural", "alt_label": "Viktoria", "alt_gender": "female"}, {"code": "sl", "name": "斯洛文尼亚语", "default_voice": "sl-SI-RokNeural", "default_label": "Rok", "default_gender": "male", "alt_voice": "sl-SI-PetraNeural", "alt_label": "Petra", "alt_gender": "female"}, {"code": "so", "name": "索马里语", "default_voice": "so-SO-MuuseNeural", "default_label": "Muuse", "default_gender": "male", "alt_voice": "so-SO-UbaxNeural", "alt_label": "Ubax", "alt_gender": "female"}, {"code": "sq", "name": "阿尔巴尼亚语", "default_voice": "sq-AL-IlirNeural", "default_label": "Ilir", "default_gender": "male", "alt_voice": "sq-AL-AnilaNeural", "alt_label": "Anila", "alt_gender": "female"}, {"code": "sr", "name": "塞尔维亚语", "default_voice": "sr-RS-NicholasNeural", "default_label": "Nicholas", "default_gender": "male", "alt_voice": "sr-RS-SophieNeural", "alt_label": "Sophie", "alt_gender": "female"}, {"code": "su", "name": "巽他语", "default_voice": "su-ID-JajangNeural", "default_label": "Jajang", "default_gender": "male", "alt_voice": "su-ID-TutiNeural", "alt_label": "Tuti", "alt_gender": "female"}, {"code": "sv", "name": "瑞典语", "default_voice": "sv-SE-MattiasNeural", "default_label": "Mattias", "default_gender": "male", "alt_voice": "sv-SE-SofieNeural", "alt_label": "Sofie", "alt_gender": "female"}, {"code": "sw", "name": "斯瓦希里语", "default_voice": "sw-KE-RafikiNeural", "default_label": "Rafiki", "default_gender": "male", "alt_voice": "sw-KE-ZuriNeural", "alt_label": "Zuri", "alt_gender": "female"}, {"code": "ta", "name": "泰米尔语", "default_voice": "ta-IN-ValluvarNeural", "default_label": "Valluvar", "default_gender": "male", "alt_voice": "ta-IN-PallaviNeural", "alt_label": "Pallavi", "alt_gender": "female"}, {"code": "te", "name": "泰卢固语", "default_voice": "te-IN-MohanNeural", "default_label": "Mohan", "default_gender": "male", "alt_voice": "te-IN-ShrutiNeural", "alt_label": "Shruti", "alt_gender": "female"}, {"code": "th", "name": "泰语", "default_voice": "th-TH-NiwatNeural", "default_label": "Niwat", "default_gender": "male", "alt_voice": "th-TH-PremwadeeNeural", "alt_label": "Premwadee", "alt_gender": "female"}, {"code": "tr", "name": "土耳其语", "default_voice": "tr-TR-AhmetNeural", "default_label": "Ahmet", "default_gender": "male", "alt_voice": "tr-TR-EmelNeural", "alt_label": "Emel", "alt_gender": "female"}, {"code": "uk", "name": "乌克兰语", "default_voice": "uk-UA-OstapNeural", "default_label": "Ostap", "default_gender": "male", "alt_voice": "uk-UA-PolinaNeural", "alt_label": "Polina", "alt_gender": "female"}, {"code": "ur", "name": "乌尔都语", "default_voice": "ur-PK-AsadNeural", "default_label": "Asad", "default_gender": "male", "alt_voice": "ur-PK-UzmaNeural", "alt_label": "Uzma", "alt_gender": "female"}, {"code": "uz", "name": "乌兹别克语", "default_voice": "uz-UZ-MadinaNeural", "default_label": "Madina", "default_gender": "female", "alt_voice": "uz-UZ-SardorNeural", "alt_label": "Sardor", "alt_gender": "male"}, {"code": "vi", "name": "越南语", "default_voice": "vi-VN-NamMinhNeural", "default_label": "NamMinh", "default_gender": "male", "alt_voice": "vi-VN-HoaiMyNeural", "alt_label": "HoaiMy", "alt_gender": "female"}, {"code": "zh", "name": "中文(普通话)", "default_voice": "zh-CN-XiaoxiaoNeural", "default_label": "Xiaoxiao", "default_gender": "female", "alt_voice": "zh-CN-YunjianNeural", "alt_label": "Yunjian", "alt_gender": "male"}, {"code": "zu", "name": "祖鲁语", "default_voice": "zu-ZA-ThandoNeural", "default_label": "Thando", "default_gender": "female", "alt_voice": "zu-ZA-ThembaNeural", "alt_label": "Themba", "alt_gender": "male"}];

function buildOptions(list, selected) {
  return list.map((v) =>
    `<option value="${v.value}"${v.value === selected ? ' selected' : ''}>${v.label}</option>`
  ).join('');
}

// 试听：用指定音色合成一句测试语音并播放
let testAudio = null;
let _previewSeq = 0;
async function previewVoice(voice, statusEl) {
  if (testAudio) { testAudio.pause(); testAudio = null; }
  statusEl.textContent = '⏳';
  try {
    // 每次用不同的起始时间，避免缓存串音
    const start = ++_previewSeq * 10;
    const resp = await fetch(`${SERVER}/dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: '_preview_',
        title: 'preview',
        segments: [{ start, end: start + 3, text: '大家好，这是配音员试听测试。', voice }],
      }),
    });
    const data = await resp.json();
    const seg = data?.segments?.[0];
    if (!seg) { statusEl.textContent = '❌'; return; }
    testAudio = new Audio(SERVER + seg.audio_url);
    testAudio.onended = () => { statusEl.textContent = '🔊'; };
    testAudio.play();
    statusEl.textContent = '▶';
  } catch (e) {
    statusEl.textContent = '❌';
    console.error('试听失败:', e);
  }
}

function renderVoiceRows(containerId, voiceList, count, savedVoices, defaults) {
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const row = document.createElement('div');
    row.className = 'speaker-row';
    row.style.marginBottom = '3px';
    const sel = savedVoices[i] || defaults[i] || voiceList[0].value;

    const selectEl = document.createElement('select');
    selectEl.id = `${containerId}_${i}`;
    selectEl.innerHTML = buildOptions(voiceList, sel);
    selectEl.addEventListener('change', saveAll);

    const statusSpan = document.createElement('span');
    statusSpan.style.cssText = 'cursor:pointer;font-size:14px;padding:0 4px;user-select:none;';
    statusSpan.textContent = '🔊';
    statusSpan.title = '试听该音色';
    statusSpan.addEventListener('click', () => previewVoice(selectEl.value, statusSpan));

    const label = document.createElement('label');
    label.textContent = `第 ${i + 1} 位：`;
    label.style.margin = '0';

    row.appendChild(label);
    row.appendChild(selectEl);
    row.appendChild(statusSpan);
    el.appendChild(row);
  }
}

function saveAll() {
  const mc = parseInt(document.getElementById('maleCount').value, 10);
  const fc = parseInt(document.getElementById('femaleCount').value, 10);
  const mv = [], fv = [];
  for (let i = 0; i < mc; i++) mv.push(document.getElementById(`maleVoices_${i}`)?.value || MALE_DEFAULTS[i]);
  for (let i = 0; i < fc; i++) fv.push(document.getElementById(`femaleVoices_${i}`)?.value || FEMALE_DEFAULTS[i]);
  chrome.storage.local.set({
    multiSpeaker: document.getElementById('multiSpeaker').checked,
    maleCount: mc, femaleCount: fc,
    maleVoices: mv, femaleVoices: fv,
  });
}

function refreshPanel(cfg) {
  const mc = parseInt(document.getElementById('maleCount').value, 10);
  const fc = parseInt(document.getElementById('femaleCount').value, 10);
  renderVoiceRows('maleVoices',   MALE_VOICES,   mc, cfg.maleVoices   || [], MALE_DEFAULTS);
  renderVoiceRows('femaleVoices', FEMALE_VOICES, fc, cfg.femaleVoices || [], FEMALE_DEFAULTS);
}

// ===== 语言 ↔ 配音员对照表（朗读 + 配音 共用）=====
// 选择结果存进 chrome.storage 的 langVoiceOverrides: { [langCode]: voiceId }，
// content.js 的 pickVoiceForLang（朗读）和发往 /dub 的 per-segment voice 字段（配音）
// 都会先查这里有没有用户自己选的音色，没有才退回 LANG_VOICE_TABLE 里的默认音色。
let _langVoiceOverrides = {};

// 中文(zh)的配音员选项远不止"默认+1个备选"这两个——edge-tts一共有14个中文音色
// （见上面 MALE_VOICES/FEMALE_VOICES），但 LANG_VOICE_TABLE 是给全部75种语言统一生成的，
// 每种语言只挑了一男一女做 default/alt，没把中文已有的全部音色摆出来给用户选。
// 这里单独给 zh 这一行补上其余的中文音色作为额外选项，其它语言不受影响。
(function attachExtraZhVoices() {
  const zhRow = LANG_VOICE_TABLE.find((r) => r.code === 'zh');
  if (!zhRow) return;
  const used = new Set([zhRow.default_voice, zhRow.alt_voice]);
  zhRow.extra_voices = [...MALE_VOICES, ...FEMALE_VOICES]
    .filter((v) => !used.has(v.value))
    .map((v) => ({ voice: v.value, label: v.label, gender: MALE_VOICES.includes(v) ? 'male' : 'female' }));
})();

function renderLangVoiceTable() {
  const tbody = document.getElementById('langTableBody');
  tbody.innerHTML = '';
  const orderedRows = [
    ...LANG_VOICE_TABLE.filter((r) => r.code === 'zh'),
    ...LANG_VOICE_TABLE.filter((r) => r.code !== 'zh'),
  ];
  for (const row of orderedRows) {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f0f0f0';

    const nameTd = document.createElement('td');
    nameTd.style.padding = '3px 4px';
    nameTd.textContent = `${row.name} (${row.code})`;

    const selectTd = document.createElement('td');
    selectTd.style.padding = '3px 4px';
    const select = document.createElement('select');
    select.style.cssText = 'width:100%;font-size:11px;padding:2px;';
    const genderTag = (g) => (g === 'male' ? '♂' : '♀');
    select.innerHTML =
      `<option value="">默认 - ${genderTag(row.default_gender)}${row.default_label}</option>` +
      `<option value="${row.alt_voice}">${genderTag(row.alt_gender)}${row.alt_label}</option>` +
      (row.extra_voices || []).map((v) =>
        `<option value="${v.voice}">${genderTag(v.gender)}${v.label}</option>`).join('');
    const saved = _langVoiceOverrides[row.code];
    const validValues = new Set([row.alt_voice, ...((row.extra_voices || []).map((v) => v.voice))]);
    select.value = validValues.has(saved) ? saved : '';
    select.addEventListener('change', () => {
      if (select.value) _langVoiceOverrides[row.code] = select.value;
      else delete _langVoiceOverrides[row.code];
      chrome.storage.local.set({ langVoiceOverrides: _langVoiceOverrides });
    });
    selectTd.appendChild(select);

    const previewTd = document.createElement('td');
    previewTd.style.padding = '3px 4px';
    previewTd.style.cursor = 'pointer';
    previewTd.style.userSelect = 'none';
    previewTd.textContent = '🔊';
    previewTd.title = '试听当前选中的音色';
    previewTd.addEventListener('click', () => {
      const voice = select.value || row.default_voice;
      previewVoice(voice, previewTd);
    });

    tr.appendChild(nameTd);
    tr.appendChild(selectTd);
    tr.appendChild(previewTd);
    tbody.appendChild(tr);
  }
}

chrome.storage.local.get({ langVoiceOverrides: {} }, (cfg) => {
  _langVoiceOverrides = cfg.langVoiceOverrides || {};
});

document.getElementById('toggleLangTable').addEventListener('click', () => {
  const panel = document.getElementById('langTablePanel');
  const show = panel.style.display === 'none';
  panel.style.display = show ? 'block' : 'none';
  if (show && !panel.dataset.rendered) {
    renderLangVoiceTable();
    panel.dataset.rendered = '1';
  }
});

// ===== 配音服务器地址 =====
const serverUrlEl = document.getElementById('serverUrl');
chrome.storage.local.get({ serverUrl: '' }, (cfg) => {
  serverUrlEl.value = cfg.serverUrl || '';
  updateTestServerControl();
});
serverUrlEl.addEventListener('change', () => {
  const url = serverUrlEl.value.trim();
  chrome.storage.local.set({ serverUrl: url });
  // 内置的几个地址（本机/局域网默认端口、HF Space）已经在manifest里固定声明了权限；
  // 用户填的是别的地址（比如局域网另一台主机的自定义IP）时，需要现场申请这个origin的
  // 权限——manifest里只声明了optional_host_permissions占位，不会自动生效。
  if (!url) return;
  try {
    const origin = new URL(url).origin + '/*';
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      if (!granted) {
        alert('未授权访问该地址，配音服务可能无法连接。可以重新填一次地址再次确认授权。');
      }
    });
  } catch (_) { /* 地址格式不对，留给后面连接失败时再提示 */ }
});

// ===== 音量 =====
const vol = document.getElementById('vol');
const volLabel = document.getElementById('volLabel');
chrome.storage.local.get({ origVolume: 0.3 }, (cfg) => {
  vol.value = Math.round(cfg.origVolume * 100);
  volLabel.textContent = Math.round(cfg.origVolume * 100) + '%';
});
vol.addEventListener('input', () => {
  volLabel.textContent = vol.value + '%';
  chrome.storage.local.set({ origVolume: parseInt(vol.value) / 100 });
});

// ===== 字幕大小 / 背景透明度 =====
const subFontScaleEl = document.getElementById('subFontScale');
const subFontLabel = document.getElementById('subFontLabel');
const subBgOpacityEl = document.getElementById('subBgOpacity');
const subBgLabel = document.getElementById('subBgLabel');
chrome.storage.local.get({ subFontScale: 1.0, subBgOpacity: 0.8 }, (cfg) => {
  subFontScaleEl.value = Math.round(cfg.subFontScale * 100);
  subFontLabel.textContent = Math.round(cfg.subFontScale * 100) + '%';
  subBgOpacityEl.value = Math.round(cfg.subBgOpacity * 100);
  subBgLabel.textContent = Math.round(cfg.subBgOpacity * 100) + '%';
});
subFontScaleEl.addEventListener('input', () => {
  subFontLabel.textContent = subFontScaleEl.value + '%';
  chrome.storage.local.set({ subFontScale: parseInt(subFontScaleEl.value, 10) / 100 });
});
subBgOpacityEl.addEventListener('input', () => {
  subBgLabel.textContent = subBgOpacityEl.value + '%';
  chrome.storage.local.set({ subBgOpacity: parseInt(subBgOpacityEl.value, 10) / 100 });
});

// ===== 功能模式（配音 / 朗读）=====
const modeRadios = document.querySelectorAll('input[name="dubMode"]');
chrome.storage.local.get({ dubMode: 'dub' }, (cfg) => {
  modeRadios.forEach((r) => { r.checked = (r.value === (cfg.dubMode || 'dub')); });
});
modeRadios.forEach((r) => r.addEventListener('change', () => {
  if (r.checked) chrome.storage.local.set({ dubMode: r.value });
}));

// ===== 自动配音 =====
const autoDubEl = document.getElementById('autoDub');
chrome.storage.local.get({ autoDub: false }, (cfg) => { autoDubEl.checked = cfg.autoDub; });
autoDubEl.addEventListener('change', () => chrome.storage.local.set({ autoDub: autoDubEl.checked }));

const autoExportFilesEl = document.getElementById('autoExportFiles');
chrome.storage.local.get({ autoExportFiles: false }, (cfg) => {
  autoExportFilesEl.checked = false;
  if (cfg.autoExportFiles) chrome.storage.local.set({ autoExportFiles: false, autoRecordVideo: false });
});
document.getElementById('useTestServer').addEventListener('click', () => {
  serverUrlEl.value = TEST_SERVER;
  chrome.storage.local.set({ serverUrl: TEST_SERVER });
  updateTestServerControl();
});
document.getElementById('useProductionServer').addEventListener('click', () => {
  serverUrlEl.value = '';
  chrome.storage.local.set({ serverUrl: '' });
  updateTestServerControl();
});
serverUrlEl.addEventListener('input', updateTestServerControl);

let testStatusTimer = null;
function isTestServerSelected() {
  return serverUrlEl.value.trim().replace(/\/+$/, '') === TEST_SERVER;
}
function updateTestServerControl() {
  const panel = document.getElementById('testServerControl');
  const selected = isTestServerSelected();
  panel.style.display = selected ? 'block' : 'none';
  if (testStatusTimer) {
    clearInterval(testStatusTimer);
    testStatusTimer = null;
  }
  if (selected) {
    refreshTestServerStatus();
    testStatusTimer = setInterval(refreshTestServerStatus, 5000);
  }
}
async function refreshTestServerStatus() {
  if (!isTestServerSelected()) return;
  const statusEl = document.getElementById('testServerStatus');
  try {
    const resp = await fetch(`${TEST_SERVER_CONTROL}/status`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const result = await resp.json();
    if (result.state === 'restarting') {
      statusEl.textContent = '🟡 重启中…';
    } else if (result.state === 'ready' && result.server_online) {
      statusEl.textContent = '🟢 Ready';
    } else if (result.state === 'error') {
      statusEl.textContent = `🔴 重启失败：${result.error || '未知错误'}`;
    } else {
      statusEl.textContent = '🟠 测试服务器离线';
    }
  } catch (_) {
    try {
      const healthResp = await fetch(`${TEST_SERVER}/health`, { cache: 'no-store' });
      statusEl.textContent = healthResp.ok
        ? '🟢 服务器在线（本机重启控制未运行）'
        : '🟠 测试服务器离线';
    } catch (_) {
      statusEl.textContent = '🟠 测试服务器离线';
    }
  }
}
document.getElementById('restartTestServer').addEventListener('click', async () => {
  const button = document.getElementById('restartTestServer');
  const statusEl = document.getElementById('testServerStatus');
  button.disabled = true;
  statusEl.textContent = '正在提交重启请求……';
  try {
    const resp = await fetch(`${TEST_SERVER_CONTROL}/restart`, { method: 'POST' });
    const result = await resp.json().catch(() => ({}));
    if (!resp.ok || !result.ok) throw new Error(result.error || `HTTP ${resp.status}`);
    statusEl.textContent = '🟡 已提交重启，等待服务器恢复……';
    setTimeout(refreshTestServerStatus, 1000);
  } catch (_) {
    statusEl.textContent = '🔴 本机重启控制程序未运行';
  } finally {
    setTimeout(() => { button.disabled = false; }, 5000);
  }
});
async function armCurrentTabRecording(withVideo) {
  const statusEl = document.getElementById('recordingStatus');
  if (statusEl) statusEl.textContent = '正在启动录制…';
  try {
    // 必须直接在 popup 点击事件的调用栈里取得 streamId；把这一步转发到 service
    // worker 后，Chrome 会丢失用户手势，表现为勾选成功但实际从未开始录制。
    // 第一条异步调用必须就是 tabCapture，前面不能先 await tabs.query，否则用户手势
    // 可能已在另一个任务周期失效。popup 场景省略 targetTabId 即捕获当前活动标签。
    const streamId = await chrome.tabCapture.getMediaStreamId();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (!tabId) throw new Error('找不到当前视频标签页');
    const resp = await chrome.runtime.sendMessage({
      type: 'armTabRecording', tabId, streamId, withVideo: !!withVideo,
    });
    if (!resp?.ok) throw new Error(resp?.error || '录制启动失败');
    if (statusEl) {
      statusEl.textContent = `🔴 录制运行中（${withVideo ? '画面+音频' : '仅音频'}）`;
      statusEl.style.color = '#d32f2f';
    }
    return true;
  } catch (e) {
    if (/active stream|already.*captur/i.test(e?.message || '')) {
      // 标签页已经由本扩展捕获时，不应再次申请新流；重新把现有录制绑定到页面即可。
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        const resp = await chrome.runtime.sendMessage({ type: 'reuseTabRecording', tabId });
        if (resp?.ok) {
          if (statusEl) {
            statusEl.textContent = '🔴 已复用正在运行的录制';
            statusEl.style.color = '#d32f2f';
          }
          return true;
        }
      } catch (_) {}
    }
    console.error('[自动下载] 录制授权失败', e);
    alert('自动录音/录像未能启动：' + (e?.message || e) + '\n请保持 YouTube 视频页为当前标签，将复选框取消后重新勾选。');
    if (statusEl) {
      statusEl.textContent = '❌ 录制未启动：' + (e?.message || e);
      statusEl.style.color = '#d32f2f';
    }
    return false;
  }
}
autoExportFilesEl.addEventListener('change', () => {
  autoExportFilesEl.checked = false;
  chrome.storage.local.set({ autoExportFiles: false, autoRecordVideo: false });
});

const autoRecordVideoEl = document.getElementById('autoRecordVideo');
chrome.storage.local.get({ autoRecordVideo: false }, (cfg) => {
  autoRecordVideoEl.checked = false;
  if (cfg.autoRecordVideo) chrome.storage.local.set({ autoRecordVideo: false, autoExportFiles: false });
});
autoRecordVideoEl.addEventListener('change', () => {
  autoRecordVideoEl.checked = false;
  autoExportFilesEl.checked = false;
  chrome.storage.local.set({ autoRecordVideo: false, autoExportFiles: false });
});

// ===== 字幕 =====
const subs = document.getElementById('subs');
chrome.storage.local.get({ showSubs: true }, (cfg) => { subs.checked = cfg.showSubs; });
subs.addEventListener('change', () => chrome.storage.local.set({ showSubs: subs.checked }));

// ===== Gemini翻译（配音模式专用，YouTube自动翻译质量差时勾选）=====
const useGeminiTranslateEl = document.getElementById('useGeminiTranslate');
chrome.storage.local.get({ useGeminiTranslate: false }, (cfg) => { useGeminiTranslateEl.checked = cfg.useGeminiTranslate; });
useGeminiTranslateEl.addEventListener('change', () =>
  chrome.storage.local.set({ useGeminiTranslate: useGeminiTranslateEl.checked }));

// ===== 多人配音 =====
const multiSpeaker  = document.getElementById('multiSpeaker');
const speakerPanel  = document.getElementById('speakerPanel');
const maleCountEl   = document.getElementById('maleCount');
const femaleCountEl = document.getElementById('femaleCount');

chrome.storage.local.get(
  { multiSpeaker: false, maleCount: 0, femaleCount: 2, maleVoices: [], femaleVoices: [] },
  (cfg) => {
    multiSpeaker.checked = cfg.multiSpeaker;
    speakerPanel.style.display = cfg.multiSpeaker ? 'block' : 'none';
    maleCountEl.value   = String(cfg.maleCount);
    femaleCountEl.value = String(cfg.femaleCount);
    refreshPanel(cfg);
  }
);

multiSpeaker.addEventListener('change', () => {
  speakerPanel.style.display = multiSpeaker.checked ? 'block' : 'none';
  saveAll();
});
maleCountEl.addEventListener('change', () => {
  chrome.storage.local.get({ maleVoices: [], femaleVoices: [] }, (cfg) => { refreshPanel(cfg); saveAll(); });
});
femaleCountEl.addEventListener('change', () => {
  chrome.storage.local.get({ maleVoices: [], femaleVoices: [] }, (cfg) => { refreshPanel(cfg); saveAll(); });
});

// ===== 清除缓存 =====
document.getElementById('clearCache').addEventListener('click', async () => {
  const msg = document.getElementById('clearMsg');
  msg.textContent = '正在清除…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab.url);
    // 支持普通视频 (?v=) 和 Shorts (/shorts/ID)
    const shortsMatch = url.pathname.match(/^\/shorts\/([^/?#]+)/);
    const videoId = shortsMatch ? shortsMatch[1] : (url.searchParams.get('v') ||
      'gen_' + Math.abs([...tab.url].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0)).toString(36));

    // 1) 清除 chrome.storage.local 中的字幕缓存。key带版本号前缀（content.js的
    // SUBS_CACHE_PREFIX，解析逻辑改动时会bump版本），不是单纯"subs_VIDEO_ID"——
    // 之前这里漏了前缀，点这个按钮其实没真正清掉字幕缓存，现在两个key都清一下
    // （新前缀+无前缀的旧版本兜底，防止还有旧版本遗留的缓存条目）。
    await new Promise((resolve) => chrome.storage.local.remove(
      ['subs_v4_' + videoId, 'subs_' + videoId], resolve));

    // 2) 清除服务器端 TTS 音频缓存（seg_*.mp3）
    let serverMsg = '';
    try {
      const resp = await fetch(`${SERVER}/clear_cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId }),
      });
      const data = await resp.json();
      serverMsg = data.message || '';
    } catch (_) {
      serverMsg = '配音缓存未清除（服务未启动）';
    }

    msg.textContent = `字幕+配音缓存已清除。${serverMsg}`;
  } catch (e) {
    msg.textContent = '清除失败：' + e.message;
  }
});

// ===== 下载变速日志（兜底入口，正常停止配音会自动下载一次）=====
document.getElementById('exportRateLog').addEventListener('click', async () => {
  const msg = document.getElementById('rateLogMsg');
  msg.textContent = '正在导出…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: 'exportRateLog' }, (resp) => {
      if (chrome.runtime.lastError) {
        msg.textContent = '导出失败：' + chrome.runtime.lastError.message;
        return;
      }
      if (!resp?.ok) {
        msg.textContent = resp?.error || '导出失败';
        return;
      }
      msg.textContent = `已下载变速日志（${resp.count} 个视频）。`;
    });
  } catch (e) {
    msg.textContent = '导出失败：' + e.message;
  }
});

function parseCurrentVideoId(url) {
  try {
    const u = new URL(url);
    if (/youtube\.com$/.test(u.hostname) || u.hostname.includes('youtube.com')) {
      return u.searchParams.get('v')
        || (u.pathname.match(/^\/shorts\/([^/?#]+)/)?.[1])
        || '';
    }
    if (u.hostname === 'youtu.be' || u.hostname.endsWith('.youtu.be')) {
      return u.pathname.replace(/^\/+/, '').split('/')[0] || '';
    }
  } catch (_) {}
  return '';
}

function sanitizePackageBase(name, fallback) {
  const cleaned = String(name || '')
    .replace(/\s+-\s+YouTube$/, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || fallback || 'dubbing';
}

document.getElementById('downloadDubPackage').addEventListener('click', async () => {
  const msg = document.getElementById('dubPackageMsg');
  msg.textContent = '正在下载后台配音包…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab?.url) throw new Error('未找到当前视频页面');
    const videoId = parseCurrentVideoId(tab.url);
    if (!videoId) throw new Error('当前页面不是可识别的视频页');
    const base = sanitizePackageBase(tab.title, `dubbing_${videoId}`);

    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url: `${SERVER}/export_package/${videoId}`,
        filename: `dub_workspace/segments/${base}.zip`,
        conflictAction: 'uniquify',
      }, (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          reject(new Error(chrome.runtime.lastError?.message || '下载启动失败'));
        } else {
          resolve(downloadId);
        }
      });
    });
    msg.textContent = '后台配音包已开始下载';
  } catch (e) {
    msg.textContent = `后台配音包下载失败：${e.message || e}`;
  }
});

// ===== 标签页切换 =====
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(tabName).classList.add('active');
    if (tabName === 'ready') renderDubReadyNotices();
  });
});

setInterval(() => {
  const readyTab = document.getElementById('ready');
  if (readyTab?.classList.contains('active')) renderDubReadyNotices();
}, 3000);

function escapeReadyText(value) {
  const el = document.createElement('div');
  el.textContent = String(value || '');
  return el.innerHTML;
}

async function renderDubReadyNotices() {
  const summaryEl = document.getElementById('dubReadySummary');
  const jobsEl = document.getElementById('dubReadyJobs');
  const list = document.getElementById('dubReadyList');
  if (!list) return;
  try {
    const status = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, (resp) => {
        resolve(resp || {
          total: 0, completed: 0, successCount: 0, failedCount: 0,
          isRunning: false, videoStates: {}, videoErrors: {}, videoProgress: {}, videoVoices: {},
        });
      });
    });
    const storage = await chrome.storage.local.get({ dubJob: null });
    const job = storage.dubJob || {};
    const ids = job.videoIds || [];
    const pendingRows = [];
    let processing = 0, pending = 0, failed = 0, done = 0;
    for (const id of ids) {
      const st = status.videoStates?.[id] || job.states?.[id] || 'pending';
      const meta = job.videoMeta?.[id] || { title: id, url: `https://www.youtube.com/watch?v=${id}` };
      if (st === 'processing') processing++;
      else if (st === 'pending') pending++;
      else if (st === 'failed') failed++;
      else if (st === 'done') done++;
      if (st === 'processing' || st === 'pending' || st === 'failed') {
        const p = status.videoProgress?.[id] || {};
        const percent = (p.total && p.done >= 0) ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
        const err = status.videoErrors?.[id] || job.errors?.[id] || '';
        pendingRows.push(`
          <div class="cache-item" style="margin-bottom:8px;">
            <div style="font-weight:bold;line-height:1.35;">${escapeReadyText(meta.title || id)}</div>
            <div style="font-size:10px;color:#777;word-break:break-all;margin-top:2px;">${escapeReadyText(meta.url || '')}</div>
            <div style="margin-top:6px;">
              <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${
                st === 'failed' ? '#fde7e9' : (st === 'processing' ? '#fff1d6' : '#eef3ff')
              };color:${
                st === 'failed' ? '#b00020' : (st === 'processing' ? '#9a5b00' : '#2457d6')
              };">
                ${st === 'failed' ? '失败' : (st === 'processing' ? `进行中 ${percent}%` : '排队中')}
              </span>
            </div>
            ${st === 'processing' && p.total ? `
              <div class="progress-bar"><div class="progress-bar-fill" style="width:${percent}%;"></div></div>
              <div class="hint">${p.done || 0}/${p.total || 0} 句</div>
            ` : ''}
            ${st === 'failed' ? `<div class="hint" style="color:#b00020;">${escapeReadyText(err || '后台配音失败')}</div>` : ''}
          </div>`);
      }
    }
    if (summaryEl) {
      summaryEl.textContent = `进行中 ${processing}｜排队中 ${pending}｜失败 ${failed}｜已完成 ${done}`;
    }
    if (jobsEl) {
      jobsEl.innerHTML = pendingRows.length
        ? pendingRows.join('')
        : '<div class="hint">当前没有进行中或失败的后台任务</div>';
    }
  } catch (e) {
    if (summaryEl) summaryEl.textContent = '后台状态读取失败';
    if (jobsEl) jobsEl.innerHTML = `<div class="hint">后台状态读取失败：${escapeReadyText(e.message || e)}</div>`;
  }
  const data = await chrome.storage.local.get({ dubReadyNotices: [] });
  const notices = data.dubReadyNotices || [];
  if (!notices.length) {
    list.innerHTML = '<div class="hint">暂无已完成通知</div>';
    try { await chrome.action.setBadgeText({ text: '' }); } catch (_) {}
    return;
  }
  list.innerHTML = notices.map((n, index) => `
    <div class="cache-item" style="display:flex;align-items:flex-start;gap:7px;">
      <button class="js-ready-open" data-url="${escapeReadyText(n.url)}"
        style="flex:1;text-align:left;border:none;background:transparent;padding:2px;color:#065fd4;">
        <div style="font-weight:bold;line-height:1.35;">${escapeReadyText(n.title)}</div>
        <div style="font-size:10px;color:#777;margin-top:3px;word-break:break-all;">${escapeReadyText(n.url)}</div>
      </button>
      <button class="js-ready-close" data-index="${index}" title="关闭这条通知"
        style="flex:0 0 auto;padding:2px 7px;color:#b00020;">×</button>
    </div>`).join('');
  list.querySelectorAll('.js-ready-open').forEach((button) => {
    button.addEventListener('click', () => chrome.tabs.create({ url: button.dataset.url }));
  });
  list.querySelectorAll('.js-ready-close').forEach((button) => {
    button.addEventListener('click', async () => {
      const current = await chrome.storage.local.get({ dubReadyNotices: [] });
      const rows = current.dubReadyNotices || [];
      rows.splice(Number(button.dataset.index), 1);
      await chrome.storage.local.set({ dubReadyNotices: rows });
      try {
        await chrome.action.setBadgeText({
          text: rows.length ? String(Math.min(rows.length, 99)) : '',
        });
      } catch (_) {}
      renderDubReadyNotices();
    });
  });
}

// ===== 字幕预取标签页 =====
function extractVideoIds(input) {
  const ids = [];
  const lines = input.trim().split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    try {
      const url = new URL(line);

      // 含 list= 的播放列表链接：同时记录 list ID 和可能带的单个 v=
      if (url.searchParams.has('list')) {
        ids.push({ type: 'playlist', id: url.searchParams.get('list') });
        // 如果同时有 v=，也把这个视频单独加入
        if (url.searchParams.has('v')) {
          ids.push({ type: 'video', id: url.searchParams.get('v') });
        }
        continue;
      }

      // 普通视频链接：?v=VIDEO_ID
      if (url.searchParams.has('v')) {
        ids.push({ type: 'video', id: url.searchParams.get('v') });
        continue;
      }

      // youtu.be 短链接：youtu.be/VIDEO_ID（视频 ID 在路径里）
      if (url.hostname === 'youtu.be' || url.hostname.endsWith('.youtu.be')) {
        const id = url.pathname.slice(1).split('/')[0];
        if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
          ids.push({ type: 'video', id });
          continue;
        }
      }

      // Shorts / embed / v / live：/shorts/ID, /embed/ID, /v/ID, /live/ID
      const pathMatch = url.pathname.match(/\/(?:shorts|embed|v|live)\/([a-zA-Z0-9_-]{11})/);
      if (pathMatch) {
        ids.push({ type: 'video', id: pathMatch[1] });
        continue;
      }
    } catch (_) {
      // 不是合法 URL，尝试直接当 video ID
    }

    // 直接的 11 位 video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(line)) {
      ids.push({ type: 'video', id: line });
    }
  }

  return ids;
}

// 把播放列表名清理成合法文件夹名
function sanitizeFolder(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// 把视频标题清理成合法文件名（去掉 Windows 非法字符，限长；空则退回视频ID）
function sanitizeFilename(name, videoId) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')   // 非法字符 → 空格
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);                              // 限长，避免路径过长
  return cleaned || `dubbing_${videoId}`;
}

// 生成后台配音包下载文件名：dub_workspace/segments/<播放列表名>/<原视频标题>.zip。
// 这个 zip 包含 manifest.json + segments/*.mp3 + subtitle.srt，可和本地视频合成。
function dubPackageFileName(videoId, folder, title) {
  const f = sanitizeFolder(folder);
  return 'dub_workspace/segments/' + (f ? f + '/' : '') + sanitizeFilename(title, videoId) + '.zip';
}

// 查询一批视频的配音状态：返回 {videoId: 分段数}（>0 即已配音）
async function getDubStatus(videoIds) {
  if (!videoIds || videoIds.length === 0) return {};
  try {
    const resp = await fetch(`${SERVER}/dub_status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: videoIds }),
    });
    if (!resp.ok) return {};
    const data = await resp.json();
    return data.status || {};
  } catch (_) {
    return {};
  }
}

// 用 chrome.downloads 下载后台配音包（关闭弹窗也不中断；支持子文件夹）。
// 返回 downloadId；视频未配音(404)时由下载管理器记为失败，调用方应先用 getDubStatus 过滤。
window.downloadSingleDub = function(videoId, folder, title) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: `${SERVER}/export_package/${videoId}`,
      filename: dubPackageFileName(videoId, folder, title),
      conflictAction: 'uniquify',
    }, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || '下载启动失败'));
      } else {
        // 统一在此记录已下载（计数 + 断点续传依据），覆盖所有下载入口（批量/单个/缓存tab）
        chrome.storage.local.get({ downloaded_videos: [] }, (s) => {
          const set = new Set(s.downloaded_videos);
          set.add(videoId);
          chrome.storage.local.set({ downloaded_videos: [...set] }, () => resolve(downloadId));
        });
      }
    });
  });
};


// ===== 缓存管理标签页 =====
async function refreshCacheList() {
  const cacheListEl = document.getElementById('cacheList');

  try {
    const storage = await new Promise(resolve => chrome.storage.local.get(null, resolve));

    // 构建 videoId -> playlist 的映射
    const playlists = storage.playlists || [];
    const collected = storage.collected_videos || [];
    const videoToPlaylist = {};
    for (const pl of playlists) {
      for (const vid of (pl.videos || [])) {
        const vidId = typeof vid === 'string' ? vid : vid.id;
        if (vidId) videoToPlaylist[vidId] = pl;
      }
    }
    // 构建 videoId -> title 的映射
    const videoTitles = {};
    for (const v of collected) {
      if (v.id) videoTitles[v.id] = v.title || v.id;
    }

    let cacheItems = Object.entries(storage)
      .filter(([k]) => k.startsWith('subs_'))
      .map(([k, v]) => {
        const videoId = k.slice(5);
        const duration = (v || []).reduce((max, seg) => Math.max(max, seg.end || 0), 0);
        return { videoId, segments: v, duration };
      });

    // 服务器才是已生成配音缓存的准确信息源。与浏览器字幕缓存合并后，
    // 即使清理过浏览器数据，服务器上仍存在的配音也会列出来。
    try {
      const response = await fetch(`${SERVER}/cache_list`, { cache: 'no-store' });
      if (response.ok) {
        const serverData = await response.json();
        const byId = new Map(cacheItems.map(item => [item.videoId, item]));
        for (const remote of (serverData.items || [])) {
          const item = byId.get(remote.video_id) || {
            videoId: remote.video_id, segments: [], duration: 0,
          };
          item.serverCached = true;
          item.serverTitle = remote.title || remote.video_id;
          item.serverSegments = remote.segments || 0;
          item.serverSize = remote.size || 0;
          item.updatedAt = remote.updated_at || '';
          byId.set(item.videoId, item);
          if (!videoTitles[item.videoId]) videoTitles[item.videoId] = item.serverTitle;
        }
        cacheItems = [...byId.values()].sort((a, b) =>
          String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      }
    } catch (_) {
      // 服务器暂时不可用时，仍显示浏览器本地缓存。
    }

    if (cacheItems.length === 0) {
      cacheListEl.innerHTML = '<div class="hint">暂无缓存</div>';
      return;
    }

    // 按播放列表分组，无归属的放"临时"
    const groups = new Map(); // playlistId -> { playlist, items[] }
    const tempItems = [];

    for (const item of cacheItems) {
      const pl = videoToPlaylist[item.videoId];
      if (pl) {
        if (!groups.has(pl.id)) groups.set(pl.id, { playlist: pl, items: [] });
        groups.get(pl.id).items.push(item);
      } else {
        tempItems.push(item);
      }
    }

    function renderCacheItem(item, folder) {
      const title = videoTitles[item.videoId] || item.videoId;
      const safeTitle = title.replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const folderAttr = folder ? ` data-folder="${String(folder).replace(/"/g, '&quot;')}"` : '';
      const downloaded = (storage.downloaded_videos || []).includes(item.videoId);
      const sizeText = item.serverSize
        ? `，${(item.serverSize / 1024 / 1024).toFixed(1)} MB`
        : '';
      const count = item.serverSegments || item.segments?.length || 0;
      return `
        <div class="cache-item" style="border-radius:0;border-top:none;">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px;" title="${safeTitle}">
            ${safeTitle}
          </div>
          <span class="hint">${count} 个配音片段${sizeText}</span>
          <button class="js-cache-download" data-video-id="${item.videoId}"${folderAttr} data-title="${safeTitle}" style="width:100%;margin-top:4px;">
            ${downloaded ? '✅ 已下载配音包（可再次下载）' : '📦 下载后台配音包'}
          </button>
        </div>`;
    }

    let html = '';

    for (const [plId, group] of groups) {
      const pl = group.playlist;
      const total = pl.count || pl.videos?.length || '?';
      const plName = pl.name || plId;
      html += `
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;font-size:11px;padding:5px 6px;background:#f0f0f0;border:1px solid #ddd;border-radius:3px 3px 0 0;display:flex;justify-content:space-between;align-items:center;">
            <span title="${plId}">📋 ${plName}</span>
            <span class="hint" style="margin:0;">${group.items.length}/${total}</span>
          </div>
          ${group.items.map(it => renderCacheItem(it, plName)).join('')}
        </div>`;
    }

    if (tempItems.length > 0) {
      html += `
        <div style="margin-bottom:10px;">
          <div style="font-weight:bold;font-size:11px;padding:5px 6px;background:#f0f0f0;border:1px solid #ddd;border-radius:3px 3px 0 0;">
            🗂 临时（${tempItems.length} 个视频）
          </div>
          ${tempItems.map(renderCacheItem).join('')}
        </div>`;
    }

    cacheListEl.innerHTML = html;
  } catch (e) {
    cacheListEl.innerHTML = '<div class="hint" style="color:red;">加载失败：' + e.message + '</div>';
  }
}

document.getElementById('refreshCache').addEventListener('click', refreshCacheList);

// 事件委托：MV3 默认 CSP 禁止内联 onclick，所以统一用委托处理缓存列表里的下载按钮
document.getElementById('cacheList').addEventListener('click', async (e) => {
  const btn = e.target.closest('.js-cache-download');
  if (btn) {
    btn.disabled = true;
    const ok = await downloadDubAudio(
      btn.dataset.videoId, btn.dataset.folder, btn.dataset.title);
    if (ok) btn.textContent = '✅ 已下载（可再次下载）';
    btn.disabled = false;
  }
});

// 页面加载时刷新缓存列表
refreshCacheList();

// ===== 内容收集标签页 =====

// 粘贴链接并解析
document.getElementById('parseCollectionList').addEventListener('click', async () => {
  const input = document.getElementById('collectionUrl').value.trim();
  const msg = document.getElementById('parseCollectionMsg');

  if (!input) {
    msg.textContent = '❌ 请输入链接';
    return;
  }

  msg.textContent = '⏳ 解析中…';

  try {
    const parsed = extractVideoIds(input);

    if (parsed.length === 0) {
      msg.textContent = '❌ 未识别到视频或播放列表链接';
      return;
    }

    // 分离出视频和播放列表
    const directVideos = parsed.filter(v => v.type === 'video');
    const playlists = parsed.filter(v => v.type === 'playlist');

    const videoIds = [...directVideos];
    const parsedPlaylists = [];  // 记录每个播放列表及其视频，供保存到"播放列表"区

    // 对每个播放列表，通过服务器端 yt-dlp 解析（不依赖打开的页面）
    for (const pl of playlists) {
      msg.textContent = `⏳ 解析播放列表 ${pl.id}…`;
      try {
        const resp = await fetch(`${SERVER}/parse_playlist`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playlist_id: pl.id })
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.videos?.length) {
            videoIds.push(...data.videos.map(v => ({ type: 'video', id: v.id, title: v.title })));
            parsedPlaylists.push({
              id: pl.id,
              name: data.playlist_title || pl.id,
              videos: data.videos,
              count: data.videos.length,
            });
          } else {
            msg.textContent = `❌ 播放列表 ${pl.id} 未解析到视频（服务返回0）`;
          }
        } else {
          const err = await resp.json().catch(() => ({}));
          msg.textContent = `❌ 解析播放列表失败：${err.error || resp.status}`;
        }
      } catch (e) {
        // 服务器不可用：明确提示，而不是静默吞掉只剩直接识别到的视频
        msg.textContent = `❌ 无法连接本地服务(8765)，请先启动 live_dub.bat：${e.message}`;
      }
    }

    if (videoIds.length === 0) {
      msg.textContent = '❌ 未识别到视频（服务未启动或链接无效）';
      return;
    }

    // 去重
    const seen = new Set();
    const uniqueVideos = videoIds.filter(v => {
      if (seen.has(v.id)) return false;
      seen.add(v.id);
      return true;
    });

    // 显示视频列表
    document.getElementById('collectionListContainer').style.display = 'block';
    document.getElementById('collectionVideoCount').textContent = uniqueVideos.length;

    window._collectionVideoStates = {};
    uniqueVideos.forEach(v => { window._collectionVideoStates[v.id] = 'pending'; });

    renderCollectionVideoList(uniqueVideos);

    window._pendingCollectionVideos = uniqueVideos;
    msg.textContent = `✓ 识别到 ${uniqueVideos.length} 个视频`;

    // 把解析结果存入本地存储，让"播放列表"和"待处理视频"区有数据、相关按钮可用
    try {
      const store = await new Promise(r => chrome.storage.local.get(
        { playlists: [], collected_videos: [] }, r));
      // 合并/更新播放列表
      const plMap = new Map(store.playlists.map(p => [p.id, p]));
      for (const pl of parsedPlaylists) plMap.set(pl.id, pl);
      // 合并待处理视频（去重）
      // 构建 videoId -> playlistId 映射（用于存储归属）
      const vidToPlId = {};
      for (const pl of parsedPlaylists) {
        for (const v of (pl.videos || [])) {
          const id = typeof v === 'string' ? v : v.id;
          if (id) vidToPlId[id] = pl.id;
        }
      }

      const seenV = new Set(store.collected_videos.map(v => v.id));
      for (const v of uniqueVideos) {
        if (!seenV.has(v.id)) {
          seenV.add(v.id);
          store.collected_videos.push({
            id: v.id,
            title: v.title || v.id,
            channelTitle: '(来自链接解析)',
            playlistId: vidToPlId[v.id] || null,
          });
        }
      }
      await new Promise(r => chrome.storage.local.set(
        { playlists: [...plMap.values()], collected_videos: store.collected_videos }, r));
      // 立即刷新底部"我的收藏/播放列表/待处理"显示
      if (typeof refreshCollectedVideos === 'function') refreshCollectedVideos();
    } catch (_) {}

  } catch (e) {
    msg.textContent = '❌ 解析失败：' + e.message;
  }
});

function renderCollectionVideoList(videoIds) {
  const listEl = document.getElementById('collectionVideoList');
  listEl.innerHTML = videoIds.slice(0, 100).map((v, i) => {
    const state = window._collectionVideoStates[v.id] || 'pending';
    const title = v.title || v.id;  // 优先用标题，否则用ID
    return `
      <div class="video-item ${state}" data-video-id="${v.id}" title="${title}">
        <input type="checkbox" class="video-checkbox" data-video-id="${v.id}" />
        <span class="status ${state}"></span>
        <span class="video-id">#${i+1} ${title}</span>
        <button class="download" title="下载" data-video-id="${v.id}" data-title="${String(title).replace(/"/g, '&quot;')}">⬇</button>
        <button class="retry" title="重试" data-video-id="${v.id}">🔄</button>
      </div>
    `;
  }).join('');

  if (videoIds.length > 100) {
    listEl.innerHTML += `<div class="video-item" style="text-align:center;"><strong>...</strong> 及其他 ${videoIds.length - 100} 个视频</div>`;
  }

  // 绑定复选框事件
  document.querySelectorAll('#collectionVideoList .video-checkbox').forEach(cb => {
    cb.addEventListener('change', updateCollectionBatchButtonState);
  });
}

// 事件委托：处理视频列表里的下载/重试按钮（MV3 CSP 禁止内联 onclick）
document.getElementById('collectionVideoList').addEventListener('click', (e) => {
  const dl = e.target.closest('.download');
  if (dl) { e.stopPropagation(); downloadSingleDub(dl.dataset.videoId, null, dl.dataset.title); return; }
  const rt = e.target.closest('.retry');
  if (rt) { e.stopPropagation(); retryCollectionVideo(rt.dataset.videoId); return; }
});

function updateCollectionVideoStatus(videoId, state) {
  window._collectionVideoStates[videoId] = state;
  const item = document.querySelector(`#collectionVideoList [data-video-id="${videoId}"]`);
  if (item) {
    item.classList.remove('pending', 'processing', 'done', 'failed');
    item.classList.add(state);
    const statusEl = item.querySelector('.status');
    if (statusEl) {
      statusEl.classList.remove('pending', 'processing', 'done', 'failed');
      statusEl.classList.add(state);
    }
  }
}

// 全选/全不选
document.getElementById('selectAllCollection').addEventListener('click', () => {
  document.querySelectorAll('#collectionVideoList .video-checkbox').forEach(cb => { cb.checked = true; });
  updateCollectionBatchButtonState();
});

document.getElementById('selectNoneCollection').addEventListener('click', () => {
  document.querySelectorAll('#collectionVideoList .video-checkbox').forEach(cb => { cb.checked = false; });
  updateCollectionBatchButtonState();
});

function updateCollectionBatchButtonState() {
  const checkedCount = document.querySelectorAll('#collectionVideoList .video-checkbox:checked').length;
  const batchBtn = document.getElementById('batchDownloadCollection');
  if (checkedCount > 0) {
    batchBtn.textContent = `⬇ 批量下载 (${checkedCount})`;
    batchBtn.disabled = false;
  } else {
    batchBtn.textContent = '⬇ 批量下载';
    batchBtn.disabled = true;
  }
}

// 批量下载（内容收集）
document.getElementById('batchDownloadCollection').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('#collectionVideoList .video-checkbox:checked'))
    .map(cb => cb.dataset.videoId)
    .filter(id => window._collectionVideoStates[id] === 'done' || window._collectionVideoStates[id] === 'failed');

  if (checked.length === 0) {
    alert('请选择至少一个已完成或失败的视频');
    return;
  }

  const btn = document.getElementById('batchDownloadCollection');
  btn.disabled = true;
  btn.textContent = '⏳ 下载中...';

  let failed = 0;
  for (const videoId of checked) {
    try {
      await downloadSingleDub(videoId);
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.error('下载失败:', videoId, e);
      failed++;
    }
  }

  btn.disabled = false;
  updateCollectionBatchButtonState();
  alert(`✓ 下载完成！成功: ${checked.length - failed}，失败: ${failed}`);
});

window.retryCollectionVideo = function(videoId) {
  console.log('重试视频:', videoId);
  chrome.runtime.sendMessage({
    action: 'retryPrefetchVideo',
    videoId: videoId
  });
  updateCollectionVideoStatus(videoId, 'pending');
};

// 开始配音预取（内容收集）
document.getElementById('startDubCollection').addEventListener('click', async () => {
  if (!window._pendingCollectionVideos || window._pendingCollectionVideos.length === 0) {
    alert('请先解析链接');
    return;
  }

  const videoIds = window._pendingCollectionVideos.map(v => v.id);
  const btn = document.getElementById('startDubCollection');
  const cancelBtn = document.getElementById('cancelDubCollection');
  btn.disabled = true;
  cancelBtn.style.display = 'inline-block';

  // 重置所有视频状态为 pending
  videoIds.forEach(id => { updateCollectionVideoStatus(id, 'pending'); });

  document.getElementById('dubCollectionMsg').textContent = '已启动后台任务…';

  // 发送给 background.js 进行后台预取
  chrome.runtime.sendMessage({
    action: 'startPrefetchCaptions',
    videoIds: videoIds,
    videos: window._pendingCollectionVideos.map((v) => ({
      id: v.id,
      title: v.title || v.id,
      url: `https://www.youtube.com/watch?v=${v.id}`,
    })),
  }, (response) => {
    document.getElementById('dubCollectionMsg').textContent = response?.message || '预取已启动';
  });

  // 定期刷新进度和详细状态
  const interval = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ action: 'getPrefetchStatus' });
    if (status) {
      // 更新总体进度条
      const progress = Math.round((status.completed / status.total) * 100);
      document.getElementById('dubCollectionProgress').style.width = progress + '%';
      // 长视频分批合成需要几分钟，光看"已完成 X/Y个视频"会让人以为卡住了——
      // 找出当前正在处理的那个视频，把它的句子级进度（来自 background.js 分批
      // 配音时上报的 videoProgress）也带出来，让用户能看到"其实在跑，只是这
      // 个视频句子多"，而不是一段时间数字不变就以为程序死了。
      const processingId = Object.entries(status.videoStates || {})
        .find(([, st]) => st === 'processing')?.[0];
      const curProg = processingId && status.videoProgress?.[processingId];
      const curProgText = curProg ? `，当前视频 ${curProg.done}/${curProg.total} 句` : '';
      document.getElementById('dubCollectionStatus').textContent =
        `已完成 ${status.completed}/${status.total}（成功: ${status.successCount}，失败: ${status.failedCount}）${curProgText}`;

      // 更新单个视频的状态
      if (status.videoStates) {
        Object.entries(status.videoStates).forEach(([vid, state]) => {
          updateCollectionVideoStatus(vid, state);
        });
      }

      if (!status.isRunning) {
        clearInterval(interval);
        btn.disabled = false;
        cancelBtn.style.display = 'none';
        const isDone = status.completed >= status.total;
        document.getElementById('dubCollectionMsg').textContent =
          isDone ? '✓ 配音预取完成！' : '⚠ 任务已取消';
      }
    }
  }, 1000);
});

// 取消配音预取
document.getElementById('cancelDubCollection').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'cancelPrefetch' }, (response) => {
    document.getElementById('dubCollectionMsg').textContent = '正在取消…';
  });
});

async function refreshCollectedVideos() {
  // 恢复配音任务的最新状态
  const status = await new Promise(r => chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, r));
  if (status?.videoStates) {
    window._collectionVideoStates = Object.assign(window._collectionVideoStates || {}, status.videoStates);
  }

  const storage = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  const collected = storage.collected_videos || [];
  const playlists = storage.playlists || [];
  const downloaded = storage.downloaded_videos || [];

  document.getElementById('playlistCount').textContent = playlists.length;
  document.getElementById('collectedCount').textContent = collected.filter(v => !downloaded.includes(v.id)).length;

  // 构建 videoId -> playlistId 映射（用于待处理视频的所属显示）
  const videoToPlaylistId = {};
  for (const pl of playlists) {
    for (const vid of (pl.videos || [])) {
      const vidId = typeof vid === 'string' ? vid : vid.id;
      if (vidId) videoToPlaylistId[vidId] = pl.name || pl.id;
    }
  }

  // 显示播放列表
  const playlistsEl = document.getElementById('playlistsList');
  if (playlists.length === 0) {
    playlistsEl.innerHTML = '<div class="hint" style="padding:4px;">暂无播放列表</div>';
  } else {
    // 查询所有播放列表视频的配音状态（一次性）
    const allIds = [];
    for (const p of playlists) for (const v of (p.videos || [])) allIds.push(typeof v === 'string' ? v : v.id);
    const dubStatus = await getDubStatus(allIds);
    const dlSet = new Set(downloaded);
    window._playlistData = {};  // 供展开列表/选择下载使用

    playlistsEl.innerHTML = playlists.map(p => {
      const vids = (p.videos || []).map(v => (typeof v === 'string' ? { id: v, title: v } : v));
      const total = vids.length;
      const dubbedCount = vids.filter(v => (dubStatus[v.id] || 0) > 0).length;
      const dlCount = vids.filter(v => dlSet.has(v.id)).length;
      const name = p.name || p.id;
      const safeName = String(name).replace(/</g, '&lt;');
      window._playlistData[p.id] = { name, vids };

      return `
        <div class="cache-item">
          <div style="display:flex;align-items:center;gap:4px;">
            <strong title="${p.id}" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${safeName}</strong>
            <button class="js-pl-delete" data-playlist-id="${p.id}" title="清除此播放列表"
                    style="flex-shrink:0;padding:2px 6px;background:#f44336;color:white;border:none;">✕</button>
          </div>
          <div class="hint" style="margin:2px 0;">共 ${total} · 🎙配音 ${dubbedCount}/${total} · ✅已下 ${dlCount}/${total}</div>
          <div style="display:flex;gap:4px;margin-top:4px;">
            <button class="js-pl-dub" data-playlist-id="${p.id}" style="flex:1;background:#2196f3;color:white;border:none;">🎙 配音此列表</button>
            <button class="js-pl-download" data-playlist-id="${p.id}" style="flex:1;background:#4caf50;color:white;border:none;">⬇ 下载此列表</button>
          </div>
          <button class="js-pl-toggle" data-playlist-id="${p.id}" style="width:100%;margin-top:4px;font-size:11px;">▾ 展开选择下载</button>
          <div class="js-pl-videos" data-playlist-id="${p.id}" style="display:none;margin-top:4px;border-top:1px solid #eee;">
            <div class="js-pl-vlist" data-playlist-id="${p.id}"></div>
            <button class="js-pl-dlselected" data-playlist-id="${p.id}" style="width:100%;margin-top:4px;background:#4caf50;color:white;border:none;">⬇ 下载选中</button>
          </div>
        </div>`;
    }).join('');
  }

  // 显示待处理视频（显示标题+所属播放列表）
  const undownloaded = collected.filter(v => !downloaded.includes(v.id)).slice(0, 50);
  const listEl = document.getElementById('collectedList');
  if (undownloaded.length === 0) {
    listEl.innerHTML = '<div class="hint" style="padding:4px;">暂无待处理视频</div>';
  } else {
    listEl.innerHTML = undownloaded.map(v => {
      const plLabel = videoToPlaylistId[v.id]
        ? `📋 ${videoToPlaylistId[v.id]}`
        : `🗂 临时`;
      const safeTitle = (v.title || v.id).replace(/</g, '&lt;');
      return `
        <div class="video-item" style="flex-wrap:wrap;">
          <input type="checkbox" class="video-checkbox" data-video-id="${v.id}" />
          <span class="video-id" style="flex-basis:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"
                title="${safeTitle}">${safeTitle}</span>
          <span class="hint" style="font-size:10px;flex-basis:100%;">${plLabel}</span>
        </div>`;
    }).join('');
  }
}

document.getElementById('refreshCollected').addEventListener('click', refreshCollectedVideos);

// 事件委托：处理播放列表里的删除/配音/下载/展开/下载选中按钮（MV3 CSP 禁止内联 onclick）
document.getElementById('playlistsList').addEventListener('click', (e) => {
  const del = e.target.closest('.js-pl-delete');
  if (del) { deletePlaylist(del.dataset.playlistId, del); return; }
  const dub = e.target.closest('.js-pl-dub');
  if (dub) { dubPlaylist(dub.dataset.playlistId, dub); return; }
  const dl = e.target.closest('.js-pl-download');
  if (dl) { downloadPlaylist(dl.dataset.playlistId, dl); return; }
  const tg = e.target.closest('.js-pl-toggle');
  if (tg) { togglePlaylistVideos(tg.dataset.playlistId, tg); return; }
  const dls = e.target.closest('.js-pl-dlselected');
  if (dls) { downloadSelected(dls.dataset.playlistId, dls); return; }
});

// 动态渲染某播放列表的视频列表（带实时状态色）
async function renderPlaylistVideos(playlistId) {
  const data = window._playlistData?.[playlistId];
  if (!data) return;
  const vlist = document.querySelector(`.js-pl-vlist[data-playlist-id="${playlistId}"]`);
  if (!vlist) return;

  // 获取实时配音状态和下载状态
  const dubStatus = await getDubStatus(data.vids.map(v => v.id));
  const storage = await new Promise(r => chrome.storage.local.get({ downloaded_videos: [] }, r));
  const dlSet = new Set(storage.downloaded_videos);

  // 轮询每秒重渲染会重建 innerHTML、冲掉用户刚勾的复选框。
  // 渲染前先记下已勾选的，渲染后再恢复，避免"选不中"的假象。
  const prevChecked = new Set(
    Array.from(vlist.querySelectorAll('.js-pl-vcheck:checked')).map(cb => cb.dataset.videoId));

  vlist.innerHTML = data.vids.map((v, i) => {
    const dubbed = (dubStatus[v.id] || 0) > 0;
    const dled = dlSet.has(v.id);
    const safeT = (v.title || v.id).replace(/</g, '&lt;');

    // 状态色：绿=已下载，橙=配音中，绿=已配音，灰=未配音，红=失败
    let color = '#666', icon = '⏳', status = '未配音';
    if (dled) { color = '#4caf50'; icon = '✅'; status = '已下载'; }
    else if (dubbed) { color = '#4caf50'; icon = '🎙'; status = '已配音'; }

    // 检查配音中状态（从 _collectionVideoStates）
    const curState = window._collectionVideoStates?.[v.id];
    if (curState === 'processing') { color = '#ff9800'; icon = '⏳'; status = '配音中'; }
    else if (curState === 'failed') { color = '#f44336'; icon = '❌'; status = '失败'; }

    return `
      <div class="video-item" style="gap:4px;border-left:3px solid ${color};" data-video-id="${v.id}">
        <input type="checkbox" class="js-pl-vcheck" data-playlist-id="${playlistId}" data-video-id="${v.id}"
               ${dubbed ? '' : 'disabled'} />
        <span class="video-id js-vid-title" style="flex:1;color:${color};cursor:${curState==='failed'?'pointer':'default'};"
              title="${safeT}" data-video-id="${v.id}">#${i+1} ${safeT}</span>
        <span style="margin:0;flex-shrink:0;font-size:10px;color:${color};">${icon} ${status}</span>
        ${curState === 'failed' ? `<button class="js-redo-dub" data-video-id="${v.id}" style="padding:2px 6px;background:#f44336;color:white;border:none;font-size:10px;">🔄</button>` : ''}
      </div>`;
  }).join('');

  // 恢复重渲染前的勾选状态
  if (prevChecked.size) {
    vlist.querySelectorAll('.js-pl-vcheck').forEach(cb => {
      if (prevChecked.has(cb.dataset.videoId)) cb.checked = true;
    });
  }
}

// 展开/收起某播放列表的视频列表
window.togglePlaylistVideos = async function(playlistId, btn) {
  const box = document.querySelector(`.js-pl-videos[data-playlist-id="${playlistId}"]`);
  if (!box) return;
  const show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  btn.textContent = show ? '▴ 收起' : '▾ 展开选择下载';

  if (show) {
    // 展开时，渲染一次 + 启动轮询
    await renderPlaylistVideos(playlistId);
    window._plTimer = window._plTimer || {};
    if (!window._plTimer[playlistId]) {
      window._plTimer[playlistId] = setInterval(async () => {
        // 轮询时同步 videoStates（用于显示配音中/失败等实时状态）
        const st = await new Promise(r => chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, r));
        if (st?.videoStates) {
          Object.assign(window._collectionVideoStates || {}, st.videoStates);
        }
        await renderPlaylistVideos(playlistId);
      }, 1000);
    }
  } else {
    // 收起时，停止轮询
    if (window._plTimer?.[playlistId]) {
      clearInterval(window._plTimer[playlistId]);
      delete window._plTimer[playlistId];
    }
  }
};

// 显示视频失败原因
window.showVideoError = function(videoId) {
  // 从 background.js 获取错误信息（通过 getPrefetchStatus 的 videoErrors）
  chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, (st) => {
    const err = st?.videoErrors?.[videoId] || '未知错误';
    alert(`视频 ${videoId} 配音失败：\n${err}`);
  });
};

// 给动态视频列表元素添加事件监听器（事件委托）
document.getElementById('playlistsList').addEventListener('click', (e) => {
  // 点击失败的视频标题，显示错误原因
  const vidTitle = e.target.closest('.js-vid-title');
  if (vidTitle) {
    const videoId = vidTitle.dataset.videoId;
    if (window._collectionVideoStates?.[videoId] === 'failed') {
      showVideoError(videoId);
    }
    return;
  }
  // 重新配音按钮
  const redoBtn = e.target.closest('.js-redo-dub');
  if (redoBtn) {
    const videoId = redoBtn.dataset.videoId;
    console.log('[重新配音] ' + videoId);
    chrome.runtime.sendMessage({ action: 'retryPrefetchVideo', videoId });
    return;
  }
});

// 后台配音整个播放列表（跳过已配音的）
window.dubPlaylist = async function(playlistId, btn) {
  const data = window._playlistData?.[playlistId];
  if (!data) return;
  const ids = data.vids.map(v => v.id);

  if (btn) { btn.disabled = true; btn._old = btn.textContent; btn.textContent = '⏳ 检查中...'; }
  const dubStatus = await getDubStatus(ids);
  if (btn) { btn.disabled = false; btn.textContent = btn._old || '🎙 配音此列表'; }

  const todo = ids.filter(id => (dubStatus[id] || 0) === 0);
  const doneCount = ids.length - todo.length;
  if (todo.length === 0) { alert('该列表所有视频都已配音 ✓'); return; }

  // 启动前先确认：配音耗时长（每个约15秒间隔防限流），避免误触发大量无用工作
  const mins = Math.ceil(todo.length * 16 / 60);
  const proceed = confirm(
    `即将后台配音 ${todo.length} 个未配音视频` +
    (doneCount ? `（已配音的 ${doneCount} 个会跳过）` : '') + `。\n\n` +
    `预计耗时约 ${mins} 分钟（每个视频间隔 15 秒防限流）。\n` +
    `期间可关闭弹窗，配音在后台进行。\n\n` +
    `点「确定」开始，「取消」不做任何操作。`
  );
  if (!proceed) return;

  chrome.runtime.sendMessage({ action: 'startPrefetchCaptions', videoIds: todo }, (resp) => {
    if (resp && /已有(预取|配音)/.test(resp.message || '')) {
      alert('已有配音任务在运行，请等它结束后再启动新的。');
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = `🎙 配音中 0/${todo.length}`; }
    // 轮询进度，更新按钮文字；完成后刷新列表（配音/已下计数会更新）
    const timer = setInterval(async () => {
      const st = await chrome.runtime.sendMessage({ action: 'getPrefetchStatus' });
      if (!st) return;
      if (btn) btn.textContent = `🎙 配音中 ${st.completed}/${st.total}`;
      if (!st.isRunning) {
        clearInterval(timer);
        if (btn) { btn.disabled = false; btn.textContent = btn._old || '🎙 配音此列表'; }
        refreshCollectedVideos();
      }
    }, 2000);
  });
};

// 下载某播放列表的选中视频（仅已配音的复选框可勾）
window.downloadSelected = async function(playlistId, btn) {
  const data = window._playlistData?.[playlistId];
  if (!data) return;
  const checked = Array.from(document.querySelectorAll(
    `.js-pl-vcheck[data-playlist-id="${playlistId}"]:checked`)).map(cb => cb.dataset.videoId);
  if (checked.length === 0) { alert('请先勾选要下载的视频（未配音的无法勾选）'); return; }
  await runPlaylistDownload(playlistId, checked, btn, false);
};

// 打开弹窗时立即填充"我的收藏/播放列表/待处理视频"，避免一直显示空白看起来像没反应
refreshCollectedVideos();

// 打开弹窗时恢复前一次的配音任务状态，使"配音中"指示数字持续显示
(async () => {
  const status = await new Promise(r => chrome.runtime.sendMessage({ action: 'getPrefetchStatus' }, r));
  if (status?.videoStates) {
    window._collectionVideoStates = Object.assign(window._collectionVideoStates || {}, status.videoStates);
  }
})();

window.deletePlaylist = async function(playlistId, btn) {
  const storage = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  const playlists = storage.playlists || [];
  const target = playlists.find(p => p.id === playlistId);
  const label = target?.name || playlistId;
  if (!confirm(`确定要清除播放列表「${label}」吗？\n（只从扩展列表移除，不影响 YouTube 上的播放列表）`)) {
    return;
  }

  // 移除该播放列表
  const newPlaylists = playlists.filter(p => p.id !== playlistId);

  // 同时清理只属于该列表的待处理视频（不在其它列表里的）
  const remainingVideoIds = new Set();
  for (const pl of newPlaylists) {
    for (const v of (pl.videos || [])) {
      remainingVideoIds.add(typeof v === 'string' ? v : v.id);
    }
  }
  const targetVideoIds = new Set((target?.videos || []).map(v => typeof v === 'string' ? v : v.id));
  const collected = (storage.collected_videos || []).filter(v => {
    // 保留：不属于被删列表的，或仍被其它列表引用的
    if (!targetVideoIds.has(v.id)) return true;
    return remainingVideoIds.has(v.id);
  });

  await new Promise(resolve => chrome.storage.local.set({
    playlists: newPlaylists,
    collected_videos: collected,
  }, resolve));

  refreshCollectedVideos();
  if (typeof refreshCacheList === 'function') refreshCacheList();
};

window.downloadPlaylist = async function(playlistId, btn) {
  const data = window._playlistData?.[playlistId];
  if (!data || data.vids.length === 0) { alert('播放列表为空'); return; }
  await runPlaylistDownload(playlistId, data.vids.map(v => v.id), btn, true);
};

// 下载一组视频到「播放列表名」子文件夹。
// onlyAuto=true 表示"下载整列表"：自动跳过未配音和已下载的（断点续传）。
// onlyAuto=false 表示"下载选中"：只下勾选的（仍跳过已下载，避免重复）。
async function runPlaylistDownload(playlistId, videoIds, btn, onlyAuto) {
  const data = window._playlistData?.[playlistId];
  const folder = data?.name || playlistId;

  // videoId -> 原视频标题（用作下载文件名，便于区分）
  const titleMap = {};
  (data?.vids || []).forEach(v => { if (v.id) titleMap[v.id] = v.title || v.id; });

  const storage = await new Promise(r => chrome.storage.local.get({ downloaded_videos: [] }, r));
  const downloaded = new Set(storage.downloaded_videos);

  if (btn) { btn.disabled = true; btn._old = btn.textContent; btn.textContent = '⏳ 准备中...'; }

  // 查配音状态，过滤：未配音的不能下；已下载的跳过（断点续传）
  const dubStatus = await getDubStatus(videoIds);
  const notDubbed = videoIds.filter(id => (dubStatus[id] || 0) === 0);
  const alreadyDl = videoIds.filter(id => downloaded.has(id) && (dubStatus[id] || 0) > 0);
  const toDownload = videoIds.filter(id => (dubStatus[id] || 0) > 0 && !downloaded.has(id));

  if (toDownload.length === 0) {
    if (btn) { btn.disabled = false; btn.textContent = btn._old || '⬇ 下载此列表'; }
    if (notDubbed.length && !alreadyDl.length) {
      alert(`这些视频还没配音，无法下载。\n请先点「🎙 配音此列表」，等配音完成后再下载。`);
    } else {
      alert(`没有需要新下载的视频。\n（已下载 ${alreadyDl.length} 个，未配音 ${notDubbed.length} 个）`);
    }
    return;
  }

  let ok = 0;
  for (const videoId of toDownload) {
    if (btn) btn.textContent = `⏳ 下载中 ${ok + 1}/${toDownload.length}`;
    try {
      await downloadSingleDub(videoId, folder, titleMap[videoId]);
      downloaded.add(videoId);
      ok++;
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.error('下载失败:', videoId, e.message);
    }
  }

  // 持久化已下载列表（断点续传依据）
  await new Promise(r => chrome.storage.local.set({ downloaded_videos: [...downloaded] }, r));

  if (btn) { btn.disabled = false; btn.textContent = btn._old || '⬇ 下载此列表'; }
  alert(`✓ 已下载 ${ok}/${toDownload.length} 个到「下载/${sanitizeFolder(folder)}/」\n` +
        (alreadyDl.length ? `（跳过已下载 ${alreadyDl.length} 个）` : '') +
        (notDubbed.length ? `（跳过未配音 ${notDubbed.length} 个）` : ''));
  refreshCollectedVideos();
}

// ===== 搜索视频标签页 =====
document.getElementById('searchDays').addEventListener('input', (e) => {
  document.getElementById('daysLabel').textContent = e.target.value + '天';
});

document.getElementById('searchViews').addEventListener('input', (e) => {
  const views = parseInt(e.target.value);
  document.getElementById('viewsLabel').textContent = (views / 1000).toFixed(0) + 'K';
});

document.getElementById('startSearch').addEventListener('click', async () => {
  const keywords = document.getElementById('searchKeywords').value.trim();
  const days = parseInt(document.getElementById('searchDays').value);
  const minViews = parseInt(document.getElementById('searchViews').value);

  if (!keywords) {
    alert('请输入搜索关键词');
    return;
  }

  const msg = document.getElementById('searchMsg');
  msg.textContent = '⏳ 搜索中...';

  try {
    const response = await fetch(`${SERVER}/search_videos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keywords: keywords.split('/').map(k => k.trim()).filter(k => k),
        days,
        min_views: minViews
      })
    });

    if (!response.ok) {
      throw new Error('搜索失败');
    }

    const data = await response.json();
    const rawResults = data.results || [];

    // 构建排除集合：①已在任意播放列表 ②已收集 ③看过但没加入播放列表的搜索结果
    const storage = await new Promise(r => chrome.storage.local.get(
      { playlists: [], collected_videos: [], seen_search_ids: [] }, r));
    const excludeSet = new Set(storage.seen_search_ids);
    for (const v of storage.collected_videos) excludeSet.add(v.id);
    for (const p of storage.playlists) {
      for (const vid of (p.videos || [])) excludeSet.add(typeof vid === 'string' ? vid : vid.id);
    }

    // 过滤掉频道名含中文的视频（中文频道无需配音）
    const hasCJK = s => /[㐀-鿿豈-﫿]/.test(s || '');
    let cnCount = 0, seenCount = 0;
    const results = rawResults.filter(v => {
      if (hasCJK(v.channelTitle)) { cnCount++; return false; }
      if (excludeSet.has(v.id)) { seenCount++; return false; }
      return true;
    });

    if (results.length === 0) {
      if (rawResults.length === 0) {
        msg.textContent = '⚠️ 未找到符合条件的视频（可降低最低播放数）';
      } else {
        msg.textContent = `⚠️ ${rawResults.length} 个结果全被排除：中文频道 ${cnCount} 个、已处理过 ${seenCount} 个。` +
          (seenCount > 0 ? '可点下方"清空已看过"让旧结果重现' : '');
      }
      document.getElementById('searchResultsContainer').style.display = 'none';
      return;
    }

    document.getElementById('resultCount').textContent = results.length;
    document.getElementById('searchResultsContainer').style.display = 'block';

    // 把 ISO 日期转成「X天前（YYYY-MM-DD）」
    const fmtAge = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d)) return '';
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      const ago = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days}天前`;
      return ` | 📅 ${ago}（${d.toLocaleDateString()}）`;
    };

    const resultsEl = document.getElementById('searchResults');
    resultsEl.innerHTML = results.map((v, idx) => {
      const safeTitle = (v.title || '').replace(/"/g, '&quot;');
      const safeChannel = (v.channelTitle || '').replace(/"/g, '&quot;');
      return `
      <div class="video-item">
        <input type="checkbox" class="video-checkbox" data-video-id="${v.id}" data-title="${safeTitle}" data-channel="${safeChannel}" />
        <span class="video-id" style="flex-basis:100%;">${v.title}</span>
        <span class="hint" style="font-size:10px;flex-basis:100%;">
          频道: ${v.channelTitle} | 播放: ${(v.views/1000).toFixed(0)}K${fmtAge(v.publishedAt)}
        </span>
      </div>
    `;
    }).join('');

    // 把本次显示的结果记入「看过」集合：下次搜索时，没被加入播放列表的会被自动排除
    const newSeen = Array.from(new Set([...storage.seen_search_ids, ...results.map(v => v.id)]));
    await new Promise(r => chrome.storage.local.set({ seen_search_ids: newSeen }, r));

    const exTotal = cnCount + seenCount;
    msg.textContent = exTotal > 0
      ? `✓ ${results.length} 个新视频（排除：中文频道 ${cnCount}、处理过 ${seenCount}）`
      : `✓ 找到 ${results.length} 个视频`;

    // 绑定选择事件
    document.getElementById('selectAllResults').addEventListener('click', () => {
      resultsEl.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = true; });
    });
    document.getElementById('selectNoneResults').addEventListener('click', () => {
      resultsEl.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = false; });
    });

  } catch (e) {
    msg.textContent = '❌ 搜索失败: ' + e.message;
  }
});

// 清空"已看过"记录：让之前搜索出现过但没加入播放列表的视频重新可见
// （已在播放列表/已收集的仍会被排除，不受影响）
document.getElementById('resetSeenSearch').addEventListener('click', async () => {
  if (!confirm('清空"已看过"记录？\n之前搜索出现过、但没加入播放列表的视频将重新出现。\n（已在播放列表里的不受影响。）')) return;
  await new Promise(r => chrome.storage.local.set({ seen_search_ids: [] }, r));
  document.getElementById('searchMsg').textContent = '✓ 已清空"已看过"记录，重新搜索即可看到旧结果';
});

document.getElementById('addToPlaylistBtn').addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('#searchResults input[type=checkbox]:checked'));

  if (checked.length === 0) {
    alert('请选择至少一个视频');
    return;
  }

  const storage = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  const collected = storage.collected_videos || [];
  const playlists = storage.playlists || [];
  const now = Date.now();

  // 让用户给播放列表命名（输入已存在的名字则追加到该列表）
  const defaultName = new Date().toISOString().split('T')[0] + ' 搜索';
  const inputName = prompt('给播放列表起个名字（输入已有名字则追加进去）：', defaultName);
  if (inputName === null) return; // 用户取消
  const playlistName = inputName.trim() || defaultName;

  // 找同名列表，没有就新建一个带 name 的列表
  let currentPlaylist = playlists.find(p => (p.name || p.id) === playlistName);
  if (!currentPlaylist) {
    const dateStr = new Date().toISOString().split('T')[0];
    currentPlaylist = {
      id: `${dateStr}_${Math.random().toString(36).slice(2, 7)}`,
      name: playlistName,
      createdAt: now,
      videos: [],
      count: 0
    };
    playlists.push(currentPlaylist);
  }

  // 添加视频到播放列表或已收集视频
  for (const checkbox of checked) {
    const videoId = checkbox.dataset.videoId;
    const title = checkbox.dataset.title;
    const channelTitle = checkbox.dataset.channel;

    // 检查是否已存在
    if (!collected.find(v => v.id === videoId)) {
      collected.push({
        id: videoId,
        title,
        channelTitle,
        publishedAt: new Date().toISOString(),
        collectedAt: now
      });
    }

    // 添加到播放列表
    if (!currentPlaylist.videos.includes(videoId)) {
      currentPlaylist.videos.push(videoId);
      currentPlaylist.count = (currentPlaylist.count || 0) + 1;
    }
  }

  // 保存到存储
  await new Promise(resolve => chrome.storage.local.set({
    collected_videos: collected,
    playlists: playlists,
    last_playlist_time: now
  }, resolve));

  // 从搜索结果里清除刚添加的视频（它们已进播放列表，无需再显示）
  for (const checkbox of checked) {
    const row = checkbox.closest('.video-item');
    if (row) row.remove();
  }
  // 更新剩余计数；若已清空则收起结果区
  const remaining = document.querySelectorAll('#searchResults .video-item').length;
  document.getElementById('resultCount').textContent = remaining;
  if (remaining === 0) {
    document.getElementById('searchResultsContainer').style.display = 'none';
    document.getElementById('searchMsg').textContent = '✓ 已全部加入播放列表，可继续搜索（已处理过的会自动排除）';
  }

  alert(`✓ 已添加 ${checked.length} 个视频到播放列表「${playlistName}」\n请到「📺 内容收集」标签查看`);
  refreshCollectedVideos();
});

// 页面加载时刷新内容收集列表
refreshCollectedVideos();

// 缓存管理 tab 的单个下载（folder 可选，按所属播放列表归类）
window.downloadDubAudio = async function(videoId, folder, title) {
  try {
    await downloadSingleDub(videoId, folder, title);
    return true;
  } catch (e) {
    console.error('[缓存管理] 下载失败:', e);
    alert('下载失败: ' + e.message);
    return false;
  }
};
