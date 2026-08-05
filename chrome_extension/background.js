// Service Worker for background tasks
//
// 配音任务采用「存储驱动 + alarms 看门狗」模式：所有进度存在 chrome.storage.local['dubJob']，
// 即使弹窗关闭、Service Worker 被 Chrome 杀掉，任务也能由看门狗 alarm 重新拉起继续。
// 弹窗只是打开时读取状态显示，不参与实际配音。

// 跟 content.js 共用同一个 popup 设置（serverUrl）：默认本机，可改成局域网内
// 另一台跑服务的主机地址（比如这台电脑自己跑不了 Python 服务）。
const DEFAULT_SERVER = 'https://dub-server-921963653375.us-central1.run.app';
const TEST_SERVER = 'https://ingrid919-dub-server.hf.space';
let SERVER = DEFAULT_SERVER;
chrome.storage.local.get({ serverUrl: '' }, (cfg) => {
  if (cfg.serverUrl) SERVER = cfg.serverUrl.replace(/\/+$/, '');
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.serverUrl) {
    SERVER = (changes.serverUrl.newValue || DEFAULT_SERVER).replace(/\/+$/, '');
  }
});
// offscreen document 全扩展只能存在一份——录音的实际工作（MediaRecorder等）必须在
// 这种有DOM能力的隐藏页面里做，service worker 自己没有这些API。
let _offscreenReady = null;
async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  if (_offscreenReady) return _offscreenReady;
  _offscreenReady = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制配音音频（tabCapture）需要 MediaRecorder，service worker 没有这个能力',
  }).finally(() => { _offscreenReady = null; });
  return _offscreenReady;
}

// ===== 自动导出 YouTube cookies（每天一次）=====
// 之前一直靠用户手动用第三方插件"Get cookies.txt LOCALLY"导出到下载夹，服务器
// （本机/云端）再读这个文件。这里改成插件自己用 chrome.cookies API 直接读浏览器
// 里当前的 YouTube 登录态 cookie，格式化成 yt-dlp 认的 Netscape cookies.txt 格式，
// 写到下载夹一个固定文件名（conflictAction:'overwrite' 覆盖同一个文件，不会越攒越多）。
// 文件名特意保留"youtube"+"cookies"这两个词，跟 live_dub_server.py 的
// get_cookies_file() 现有的下载夹扫描逻辑（按文件名找 youtube+cookie，取最新mtime）
// 完全兼容，本机服务器不用改代码就能自动捡到这份新cookies。
// 云端（Cloud Run）不会自动读这个文件——它的 cookies 存在环境变量里，只能通过重新
// 部署/gcloud命令更新，那需要本机已登录的 gcloud 凭证，不能放进插件代码里（等于把
// 云端管理权限暴露在浏览器里）。云端那一步交给 Windows 计划任务，定期读这份自动导出
// 的文件、跑 gcloud 命令同步。
const AUTO_COOKIES_FILENAME = 'www.youtube.com_cookies_auto.txt';

function _cookiesToNetscapeTxt(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# 由插件自动导出，请勿手动编辑', ''];
  for (const c of cookies) {
    // Netscape格式字段：domain \t includeSubdomains \t path \t secure \t expiration \t name \t value
    // chrome.cookies返回的domain字段本身已经带不带前导点区分"是否包含子域名"
    // （带点.youtube.com=包含子域名，不带点=仅限该host），跟Netscape格式的第2列语义一致。
    const includeSub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expiration = c.session ? '0' : String(Math.round(c.expirationDate || 0));
    lines.push([c.domain, includeSub, c.path || '/', c.secure ? 'TRUE' : 'FALSE',
                expiration, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

async function refreshYouTubeCookiesFile() {
  try {
    // domain过滤会连子域名一起匹配（.youtube.com 和 www.youtube.com 等都在内），
    // 官方文档：Restricts the retrieved cookies to those whose domains match or
    // are subdomains of this one。
    const cookies = await chrome.cookies.getAll({ domain: 'youtube.com' });
    if (!cookies.length) {
      console.log('[配音插件] 自动导出cookies：未读到YouTube cookie（可能没登录）');
      return;
    }
    const text = _cookiesToNetscapeTxt(cookies);
    const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    chrome.downloads.download(
      { url, filename: AUTO_COOKIES_FILENAME, conflictAction: 'overwrite', saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          console.warn('[配音插件] 自动导出cookies失败', chrome.runtime.lastError?.message);
        } else {
          console.log(`[配音插件] 已自动导出 ${cookies.length} 条YouTube cookie → ${AUTO_COOKIES_FILENAME}`);
        }
      }
    );
  } catch (e) {
    console.warn('[配音插件] 自动导出cookies异常', e);
  }
}

// 每天刷新一次；插件启动/安装时也立即跑一次，不用等到第一次alarm触发（最长要等
// 到24小时后）。alarms在Chrome运行期间会持续存在并按时触发，哪怕service worker
// 被回收也会被alarm重新唤醒——但前提是Chrome本身在运行，Chrome完全关闭期间
// 不会有任何触发（cookies本来就只存在于运行中的浏览器里，这是无法绕开的前提）。
chrome.alarms.create('dailyCookiesRefresh', { periodInMinutes: 1440 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyCookiesRefresh') refreshYouTubeCookiesFile();
});
chrome.runtime.onStartup.addListener(() => refreshYouTubeCookiesFile());
chrome.runtime.onInstalled.addListener(() => refreshYouTubeCookiesFile());

const JOB_KEY = 'dubJob';
const GAP_MS = 8000;     // 视频之间的间隔（有 cookie 后 429 风险低）
let _looping = false;     // 内存防重入；SW 被杀后会重置，由 alarm 重新拉起
const _activeDubControllers = new Map();

// 长视频（几百句字幕）之前是一次性把全部字幕塞进一个 /dub 请求，服务器要把全部
// TTS 合成完才返回一个响应——这一个请求能挂起几分钟到十几分钟，中途网关超时/
// Service Worker被系统回收/网络抖动，整个视频的配音就全部作废、要从头再来，
// 这是长视频"几乎没有顺利完成的"的主因。现在改成按 DUB_CHUNK_SIZE 分批小请求，
// 每批独立重试，不连累其它批；服务器对每一句的TTS按时间戳+音色做了磁盘缓存
// （dub9.synthesize_segment），重发已经做完的批次只是快速命中缓存，不会重复合成。
const DUB_CHUNK_SIZE = 30;
const CHUNK_RETRY = 60;           // 429/断网可等待数小时恢复；每批断点独立，不推倒重来
const CHUNK_TIMEOUT_MS = 90000;   // 单批请求超时；30句TTS正常远用不到这么久，留足余量
const LOCAL_DUB_DB = 'youtube-dub-audio-cache-v1';

function _localDubHash(text) {
  let h = 2166136261;
  for (const ch of String(text || '')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function _localDubKey(videoId, seg) {
  return `${videoId}|${Math.round((seg.start || 0) * 1000)}|`
    + `${seg.voice || ''}|${_localDubHash(seg.text || '')}`;
}

function _openLocalDubDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LOCAL_DUB_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('segments');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _saveBackgroundAudioBatch(videoId, requested, returned) {
  if (!returned?.length) return;
  const db = await _openLocalDubDB();
  const tx = db.transaction('segments', 'readwrite');
  const store = tx.objectStore('segments');
  const byStart = new Map(requested.map(
    (seg) => [Math.round((seg.start || 0) * 1000), seg]));
  for (const item of returned) {
    if (!item?.audio_b64) continue;
    const source = byStart.get(Math.round((item.start || 0) * 1000));
    if (!source) continue;
    store.put(
      { ...item, audio_url: item.audio_url || `local://${videoId}/${item.start}` },
      _localDubKey(videoId, source));
  }
  await new Promise((resolve) => {
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
  db.close();
}

async function _hasCompleteLocalAudio(videoId, segments) {
  if (!Array.isArray(segments) || !segments.length) return false;
  try {
    const db = await _openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const found = await Promise.all(segments.map((seg) => new Promise((resolve) => {
      const req = store.get(_localDubKey(videoId, seg));
      req.onsuccess = () => resolve(!!req.result?.audio_b64);
      req.onerror = () => resolve(false);
    })));
    db.close();
    return found.every(Boolean);
  } catch (_) {
    return false;
  }
}

async function _missingLocalAudioSegments(videoId, segments) {
  if (!Array.isArray(segments) || !segments.length) return [];
  try {
    const db = await _openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    const missing = [];
    await Promise.all(segments.map((seg) => new Promise((resolve) => {
      const req = store.get(_localDubKey(videoId, seg));
      req.onsuccess = () => {
        if (!req.result?.audio_b64) missing.push(seg);
        resolve();
      };
      req.onerror = () => { missing.push(seg); resolve(); };
    })));
    db.close();
    return missing.sort((a, b) => (a.start || 0) - (b.start || 0));
  } catch (_) {
    return segments.slice();
  }
}

async function _clearBackgroundLocalDubVideo(videoId) {
  const result = {
    backgroundAudioDeleted: 0,
    backgroundAudioRemaining: null,
    backgroundTaskCancelled: false,
    errors: [],
  };
  if (!videoId) {
    result.errors.push('缺少视频ID');
    return result;
  }
  try {
    _activeDubControllers.get(videoId)?.abort();
    _activeDubControllers.delete(videoId);
  } catch (_) {}
  try {
    const job = await loadJob();
    if (job?.videoIds?.includes(videoId)) {
      job.states = job.states || {};
      job.states[videoId] = 'cancelled';
      job.cacheVerified = job.cacheVerified || {};
      job.cacheVerified[videoId] = false;
      if (job.progress) delete job.progress[videoId];
      if (job.errors) delete job.errors[videoId];
      if (job.options?.[videoId]) delete job.options[videoId].captionSegments;
      const hasActive = (job.videoIds || []).some((id) =>
        id !== videoId && (job.states?.[id] === 'pending' || job.states?.[id] === 'processing'));
      if (!hasActive) job.running = false;
      await saveJob(job);
      result.backgroundTaskCancelled = true;
    }
  } catch (e) {
    result.errors.push(`取消后台任务失败：${e?.message || e}`);
  }
  try {
    const data = await chrome.storage.local.get({ dubReadyNotices: [] });
    const notices = (data.dubReadyNotices || []).filter((n) => n.videoId !== videoId);
    if (notices.length !== (data.dubReadyNotices || []).length) {
      await chrome.storage.local.set({ dubReadyNotices: notices });
      await chrome.action.setBadgeText({ text: notices.length ? String(Math.min(notices.length, 99)) : '' });
    }
  } catch (_) {}
  try {
    await updateSharedBackgroundJob(videoId, {
      status: 'cancelled', done: 0, total: 0, verified: false,
      title: videoId, error: '',
    });
  } catch (_) {}
  try {
    const db = await _openLocalDubDB();
    const tx = db.transaction('segments', 'readwrite');
    const store = tx.objectStore('segments');
    await new Promise((resolve) => {
      const range = IDBKeyRange.bound(`${videoId}|`, `${videoId}|\uffff`);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        cursor.delete();
        result.backgroundAudioDeleted++;
        cursor.continue();
      };
      req.onerror = () => {
        result.errors.push('读取后台音频缓存时出错');
        resolve();
      };
    });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
      tx.onerror = () => {
        result.errors.push('删除后台音频缓存时出错');
        resolve();
      };
      tx.onabort = () => {
        result.errors.push('后台音频缓存删除事务被中止');
        resolve();
      };
    });
    db.close();
  } catch (e) {
    result.errors.push(`清除后台音频缓存失败：${e?.message || e}`);
  }
  try {
    const db = await _openLocalDubDB();
    const tx = db.transaction('segments', 'readonly');
    const store = tx.objectStore('segments');
    let remaining = 0;
    await new Promise((resolve) => {
      const range = IDBKeyRange.bound(`${videoId}|`, `${videoId}|\uffff`);
      const req = store.openCursor(range);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        remaining++;
        cursor.continue();
      };
      req.onerror = resolve;
    });
    db.close();
    result.backgroundAudioRemaining = remaining;
  } catch (_) {}
  result.ok = result.backgroundAudioRemaining === 0;
  return result;
}

async function _clearServerDubCache(videoId) {
  try {
    const response = await fetch(`${SERVER}/clear_cache`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId }),
    });
    return { ok: response.ok, status: response.status };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function _serverHasEnoughDubSegments(videoId, expectedTotal) {
  if (!expectedTotal) return false;
  try {
    const resp = await fetch(SERVER + '/dub_status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: [videoId] }),
    });
    const data = await resp.json().catch(() => ({}));
    const count = Number(data?.status?.[videoId] || 0);
    return resp.ok && count >= expectedTotal;
  } catch (_) {
    return false;
  }
}

function loadJob() {
  return new Promise(r => chrome.storage.local.get({ [JOB_KEY]: null }, d => r(d[JOB_KEY])));
}
function saveJob(job) {
  return new Promise(r => chrome.storage.local.set({ [JOB_KEY]: job }, r));
}

async function markLoopHeartbeat(extra = {}) {
  const job = await loadJob();
  if (!job) return;
  job._loop = {
    active: !!_looping,
    ts: Date.now(),
    ...job._loop,
    ...extra,
  };
  await saveJob(job);
}

async function ensureDubLoopRunning() {
  try {
    const job = await loadJob();
    if (!job?.running) return false;
    const hasWork = (job.videoIds || []).some((id) =>
      job.states?.[id] === 'pending' || job.states?.[id] === 'processing');
    if (!hasWork) return false;
    chrome.alarms.create('dubWatchdog', { when: Date.now() + 100 });
    if (!_looping) runDubLoop();
    return true;
  } catch (_) {
    return false;
  }
}

async function isBackgroundVideoCancelled(videoId) {
  const job = await loadJob();
  return !job || job.states?.[videoId] === 'cancelled';
}

async function waitBackgroundRetry(videoId, delayMs) {
  const deadline = Date.now() + delayMs;
  while (Date.now() < deadline) {
    if (await isBackgroundVideoCancelled(videoId)) return false;
    await new Promise((resolve) => setTimeout(
      resolve, Math.min(1000, deadline - Date.now())));
  }
  return true;
}

async function addDubReadyNotice(videoId, title) {
  const data = await chrome.storage.local.get({ dubReadyNotices: [] });
  const notices = (data.dubReadyNotices || []).filter((n) => n.videoId !== videoId);
  notices.unshift({
    videoId,
    title: title || videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    completedAt: Date.now(),
  });
  await chrome.storage.local.set({ dubReadyNotices: notices.slice(0, 200) });
  try {
    await chrome.action.setBadgeText({ text: String(Math.min(notices.length, 99)) });
    await chrome.action.setBadgeBackgroundColor({ color: '#16803a' });
  } catch (_) {}
  try {
    const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, {
        type: 'dubBackgroundReady',
        videoId,
        title: title || videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
      }).catch(() => {});
    }
  } catch (_) {}
}

async function updateSharedBackgroundJob(videoId, fields = {}) {
  try {
    await fetch(SERVER + '/background_job_update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, ...fields }),
    });
  } catch (_) {
    // Shared status is observability only; a temporary update failure must not
    // stop or alert an otherwise healthy dubbing job.
  }
}

// 发送一批字幕去合成配音，带超时保护（避免单批卡死导致整个循环悬挂）
async function dubChunk(videoId, segments, options = {}) {
  const controller = new AbortController();
  _activeDubControllers.set(videoId, controller);
  const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  try {
    const resp = await fetch(SERVER + '/dub', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        video_id: videoId,
        title: options.title || videoId,
        segments,
        // Only the user's checkbox may enable paid Gemini translation.
        use_gemini_translate: options.useGemini === true,
        client_id: options.clientId || '',
      }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const error = new Error(
        data?.error || ('配音生成失败 HTTP ' + resp.status));
      error.status = resp.status;
      throw error;
    }
    const returned = Array.isArray(data) ? data : (data.segments || []);
    await _saveBackgroundAudioBatch(videoId, segments, returned);
    const durableCount = returned.filter((item) => item?.audio_b64).length;
    if (durableCount < segments.length) {
      const error = new Error(
        `本批缓存不完整 ${durableCount}/${segments.length}，等待自动补齐`);
      error.status = 503;
      throw error;
    }
    return returned;
  } finally {
    clearTimeout(timer);
    if (_activeDubControllers.get(videoId) === controller)
      _activeDubControllers.delete(videoId);
  }
}

// 从 YouTube 拦截获取字幕的逻辑（保留，供其它地方用）
function parseTimedText(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'text/xml');
  const segs = [];
  doc.querySelectorAll('text').forEach((el) => {
    const start = parseFloat(el.getAttribute('start')) || 0;
    const dur = parseFloat(el.getAttribute('dur')) || 0;
    const text = (el.textContent || '').trim();
    if (text) segs.push({ start, end: start + dur, text });
  });
  return segs;
}

// 处理单个视频：取字幕 + 分批配音。返回 'done' | 'skipped' | 'failed'；失败原因写入 errObj.msg
// onProgress(done, total) 在每批合成成功后回调，供调用方持久化"当前视频做到第几句"。
async function processOne(videoId, errObj, onProgress) {
  try {
    console.log('[后台配音] 开始处理: ' + videoId);
    const currentJob = await loadJob();
    const options = currentJob?.options?.[videoId] || {};

    // Completion is based on exact local cache keys, never on an approximate
    // server file count. This remains valid after a server restart/deployment.
    if (await _hasCompleteLocalAudio(videoId, options.captionSegments)) {
      const serverReady = await _serverHasEnoughDubSegments(videoId, options.captionSegments.length);
      if (serverReady) {
        console.log(`[后台配音] ⏭ ${videoId} 本地+服务器缓存均完整，跳过`);
        return 'skipped';
      }
      console.log(`[后台配音] 本地缓存完整但服务器导出包不完整，继续补齐服务器缓存: ${videoId}`);
    }

    // 取字幕
    const captionLang = options.useGemini === true
      ? (options.originalLang || 'en')
      : 'zh-CN';
    let cap = null;
    if (Array.isArray(options.captionSegments) && options.captionSegments.length) {
      cap = { ok: true, segments: options.captionSegments };
      console.log('[后台配音] 使用当前页面已取得的字幕: ' + options.captionSegments.length + ' 条');
    } else {
      const capResp = await fetch(SERVER + '/prefetch_captions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: videoId, lang: captionLang }),
      });
      if (!capResp.ok) throw new Error('字幕获取失败');
      cap = await capResp.json();
      if (!cap.ok) throw new Error('字幕解析失败');
    }
    // 0 字幕不算成功（多半是 429 限流或无中文字幕）→ 判失败、记入重试
    if (!cap.segments || cap.segments.length === 0) {
      throw new Error(options.useGemini === true
        ? '未获取到原语言字幕，请打开“自动翻译→配音指定字幕”后重试'
        : '未获取到字幕，请打开“自动翻译→配音指定字幕”后重试（未调用Gemini）');
    }
    const totalSegs = cap.segments.length;
    console.log('[后台配音] ✓ ' + videoId + ': 字幕 ' + totalSegs + ' 条');
    await updateSharedBackgroundJob(videoId, {
      status: 'processing', done: 0, total: totalSegs,
      title: options.title || videoId, error: '', voices: options.voices || [],
      verified: false,
    });
    {
      const j = await loadJob();
      if (j) {
        j.progress = j.progress || {};
        j.progress[videoId] = { done: 0, total: totalSegs };
        await saveJob(j);
      }
    }

    // 记下这个视频的总段数：哪怕这次处理中途被打断（SW被杀/任务取消），下次
    // 续跑也能走上面"第一层"判断，不用为了确认是否已完成再骚扰一次 YouTube。
    {
      const j = await loadJob();
      if (j && options.useGemini !== true) {
        j.segCounts = j.segCounts || {};
        j.segCounts[videoId] = totalSegs;
        await saveJob(j);
      }
    }

    // Do not infer completion from a rough server file count. Completion is
    // declared only after every requested key has been persisted to IndexedDB.

    // 分批配音：第一轮以"往前走"为最高优先级。某一批网络差/429/超时，
    // 不让它卡住整个长视频；先记录失败批次，继续后面的批次，最后再集中补漏。
    let completedCount = 0;
    for (let i = 0; i < cap.segments.length; i += DUB_CHUNK_SIZE) {
      if (await isBackgroundVideoCancelled(videoId)) return 'cancelled';
      const batch = cap.segments.slice(i, i + DUB_CHUNK_SIZE);
      const batchNo = Math.floor(i / DUB_CHUNK_SIZE) + 1;
      let ok = false, lastErr = null;
      const firstPassRetry = Math.min(CHUNK_RETRY, 2);
      for (let attempt = 0; attempt <= firstPassRetry; attempt++) {
        if (await isBackgroundVideoCancelled(videoId)) return 'cancelled';
        try {
          await dubChunk(videoId, batch, options);
          ok = true;
          break;
        } catch (e) {
          lastErr = e;
          console.warn(`[后台配音] ${videoId} 第${batchNo}批第${attempt + 1}次失败：${e.message}`);
          const recoverable = e?.status === 429 || e?.status >= 500
            || e?.name === 'AbortError' || !e?.status;
          if (!recoverable) break;
          if (attempt < firstPassRetry) {
            // 第一轮只短重试，不在某一批上等待几小时；后面还有补漏阶段。
            const delay = Math.min(60000, 3000 * Math.pow(1.35, attempt));
            if (!await waitBackgroundRetry(videoId, delay)) return 'cancelled';
          }
        }
      }
      if (await isBackgroundVideoCancelled(videoId)) return 'cancelled';
      if (!ok) {
        console.warn(`[后台配音] ${videoId} 第${batchNo}批暂时跳过，继续后面的批次，最后补漏：${lastErr?.message || '未知错误'}`);
        await updateSharedBackgroundJob(videoId, {
          status: 'processing', done: completedCount,
          total: totalSegs, title: options.title || videoId,
          error: `暂时跳过第${batchNo}批，继续后面的批次，最后补漏`,
          voices: options.voices || [],
          verified: false,
        });
        continue;
      }
      completedCount += batch.length;
      if (onProgress) {
        try { await onProgress(Math.min(completedCount, totalSegs), totalSegs); } catch (_) {}
      }
      await updateSharedBackgroundJob(videoId, {
        status: 'processing', done: Math.min(completedCount, totalSegs),
        total: totalSegs, title: options.title || videoId, error: '',
        voices: options.voices || [],
        verified: false,
      });
    }

    let missing = await _missingLocalAudioSegments(videoId, cap.segments);
    if (missing.length) {
      console.warn(`[后台配音] 第一轮完成，仍缺 ${missing.length} 句，开始补漏`);
    }
    for (let round = 0; missing.length && round < 6; round++) {
      if (await isBackgroundVideoCancelled(videoId)) return 'cancelled';
      const retryList = missing.slice();
      for (let i = 0; i < retryList.length; i += DUB_CHUNK_SIZE) {
        if (await isBackgroundVideoCancelled(videoId)) return 'cancelled';
        const batch = retryList.slice(i, i + DUB_CHUNK_SIZE);
        try {
          await dubChunk(videoId, batch, options);
        } catch (e) {
          console.warn(`[后台配音] 补漏第${round + 1}轮失败一批：${e.message}`);
        }
        const nowMissing = await _missingLocalAudioSegments(videoId, cap.segments);
        const doneNow = Math.max(0, totalSegs - nowMissing.length);
        if (onProgress) {
          try { await onProgress(doneNow, totalSegs); } catch (_) {}
        }
        await updateSharedBackgroundJob(videoId, {
          status: 'processing', done: doneNow, total: totalSegs,
          title: options.title || videoId,
          error: nowMissing.length ? `正在补漏 ${nowMissing.length} 句` : '',
          voices: options.voices || [], verified: false,
        });
      }
      missing = await _missingLocalAudioSegments(videoId, cap.segments);
      if (missing.length) await waitBackgroundRetry(videoId, Math.min(60000, 5000 * (round + 1)));
    }
    if (missing.length) {
      throw new Error(`后台配音未完整：仍缺 ${missing.length} 句，暂不开放下载`);
    }

    console.log('[后台配音] ✓ ' + videoId + ': 配音完成');
    return 'done';
  } catch (e) {
    errObj.msg = e.message || String(e);
    console.error('[后台配音] ✗ ' + videoId + ': ' + errObj.msg);
    return 'failed';
  }
}

// 主循环：从存储读队列逐个处理，状态写回存储。
// SW 活着就一直跑；被杀后由看门狗 alarm 重新调用本函数续跑（_looping 防重入）。
async function runDubLoop() {
  if (_looping) return;
  _looping = true;
  try {
    await markLoopHeartbeat({ active: true, state: 'started' });
    while (true) {
      const job = await loadJob();
      if (!job || !job.running) break;
      await markLoopHeartbeat({ active: true, state: 'running' });

      // 优先捡起上次被中断（processing）的，再处理 pending
      let next = job.videoIds.find(id => job.states[id] === 'processing')
              || job.videoIds.find(id => job.states[id] === 'pending');
      if (!next) { job.running = false; await saveJob(job); break; }

      job.states[next] = 'processing';
      await saveJob(job);

      const errObj = {};
      // 分批配音可能触发几十次进度回调，每次都落盘太频繁；只在距离上次写入
      // 超过1.5秒、或这一批正好是最后一批时才真正写 storage，减少 I/O。
      let lastProgressWrite = 0;
      const result = await processOne(next, errObj, async (done, total) => {
        const now = Date.now();
        if (now - lastProgressWrite < 1500 && done < total) return;
        lastProgressWrite = now;
        const jp = await loadJob();
        if (!jp) return;
        jp.progress = jp.progress || {};
        jp.progress[next] = { done, total };
        await saveJob(jp);
      });

      // 处理期间可能被取消/改动，重新读一次再写
      const j2 = await loadJob();
      if (!j2) break;
      j2.states[next] = result === 'failed'
        ? 'failed' : (result === 'cancelled' ? 'cancelled' : 'done');
      j2.cacheVerified = j2.cacheVerified || {};
      j2.cacheVerified[next] = result === 'done' || result === 'skipped';
      if (result === 'cancelled') {
        delete j2.errors[next];
        await updateSharedBackgroundJob(next, {
          status: 'cancelled', error: '', verified: false,
          title: j2.videoMeta?.[next]?.title || next,
          done: j2.progress?.[next]?.done || 0,
          total: j2.progress?.[next]?.total || 0,
          voices: j2.options?.[next]?.voices || [],
        });
      } else if (result === 'failed') {
        j2.errors[next] = errObj.msg;
        await updateSharedBackgroundJob(next, {
          status: 'failed', error: errObj.msg,
          title: j2.videoMeta?.[next]?.title || next,
          done: j2.progress?.[next]?.done || 0,
          total: j2.progress?.[next]?.total || 0,
          voices: j2.options?.[next]?.voices || [],
          verified: false,
        });
        try {
          const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
          for (const tab of tabs) {
            if (!tab.id) continue;
            chrome.tabs.sendMessage(tab.id, {
              type: 'dubBackgroundFailed',
              videoId: next,
              error: errObj.msg,
            }).catch(() => {});
          }
        } catch (_) {}
      }
      else {
        delete j2.errors[next];
        const meta = j2.videoMeta?.[next] || {};
        const finalProgress = j2.progress?.[next] || {};
        await updateSharedBackgroundJob(next, {
          status: 'done', error: '', title: meta.title || next,
          done: finalProgress.total || finalProgress.done || 1,
          total: finalProgress.total || finalProgress.done || 1,
          voices: j2.options?.[next]?.voices || [],
          verified: true,
        });
        await addDubReadyNotice(next, meta.title || next);
        if (j2.options?.[next]) delete j2.options[next].captionSegments;
      }
      if (j2.progress) delete j2.progress[next];   // 完成/失败后这个数字不用再保留
      await saveJob(j2);
      if (!j2.running) break;

      if (result !== 'skipped') await new Promise(r => setTimeout(r, GAP_MS));
    }
  } finally {
    _looping = false;
    await markLoopHeartbeat({ active: false, state: 'idle' });
    const job = await loadJob();
    if (!job || !job.running) chrome.alarms.clear('dubWatchdog');
  }
}

// 看门狗：定时唤醒 SW，被杀后自动续跑
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dubWatchdog') {
    loadJob().then(job => { if (job && job.running) runDubLoop(); });
  }
});

// SW 启动时（含被杀后重启）：若有未完成任务，恢复看门狗并续跑
loadJob().then(job => {
  if (job && job.running) {
    chrome.alarms.create('dubWatchdog', { periodInMinutes: 0.5 });
    runDubLoop();
  }
});

// 处理来自 popup / content 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ===== 配音链路：content script 通过后台转发请求到本地服务 =====
  // （这些用 message.type 区分，是实时配音的核心；缺了会报 "message port closed"）
  if (message.type === 'fetch') {
    (async () => {
      try {
        const r = await fetch(message.url, message.options || {});
        const data = await r.json().catch(() => null);
        if (!r.ok) { sendResponse({ ok: false, error: (data && data.error) || ('HTTP ' + r.status) }); return; }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
  if (message.type === 'fetchAudioB64') {
    (async () => {
      try {
        const r = await fetch(message.url);
        if (!r.ok) { sendResponse({ ok: false, error: 'HTTP ' + r.status }); return; }
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        sendResponse({ ok: true, b64: btoa(bin) });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }
  if (message.type === 'diarize') {
    (async () => {
      try {
        const bin = atob(message.audioB64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const fd = new FormData();
        fd.append('audio', new Blob([arr], { type: 'audio/webm' }), 'audio.webm');
        fd.append('num_speakers', String(message.numSpeakers || 2));
        const r = await fetch(SERVER + '/diarize', { method: 'POST', body: fd });
        const data = await r.json().catch(() => null);
        if (!r.ok) { sendResponse({ ok: false, error: (data && data.error) || ('HTTP ' + r.status) }); return; }
        sendResponse({ ok: true, data });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (message.action === 'queueBackgroundDub') {
    (async () => {
      const videoId = message.videoId;
      if (!videoId) { sendResponse({ ok: false, error: '缺少视频ID' }); return; }
      let job = await loadJob();
      if (!job) {
        job = {
          running: true, videoIds: [], videoMeta: {}, options: {},
          states: {}, errors: {}, progress: {}, startedAt: Date.now(),
        };
      }
      job.videoIds = job.videoIds || [];
      job.videoMeta = job.videoMeta || {};
      job.options = job.options || {};
      job.states = job.states || {};
      job.errors = job.errors || {};
      if (!job.videoIds.includes(videoId)) job.videoIds.push(videoId);
      job.videoMeta[videoId] = {
        title: message.title || videoId,
        url: message.url || `https://www.youtube.com/watch?v=${videoId}`,
      };
      job.options[videoId] = {
        useGemini: message.useGemini === true,
        originalLang: message.originalLang || '',
        clientId: message.clientId || '',
        title: message.title || videoId,
        captionSegments: Array.isArray(message.captionSegments)
          ? message.captionSegments : [],
        voices: Array.isArray(message.voices) ? message.voices : [],
        verified: false,
      };
      job.states[videoId] = 'pending';
      job.cacheVerified = job.cacheVerified || {};
      job.cacheVerified[videoId] = false;
      delete job.errors[videoId];
      if (job.progress) delete job.progress[videoId];
      job.running = true;
      await saveJob(job);
      await updateSharedBackgroundJob(videoId, {
        status: 'pending', done: 0, total: 0,
        title: message.title || videoId, error: '',
        voices: Array.isArray(message.voices) ? message.voices : [],
      });
      chrome.alarms.create('dubWatchdog', { when: Date.now() + 100 });
      chrome.alarms.create('dubWatchdog', { periodInMinutes: 0.5 });
      runDubLoop();
      sendResponse({
        ok: true,
        message: message.useGemini === true
          ? '已加入后台队列：使用已勾选的Gemini翻译'
          : '已加入后台队列：使用平台中文字幕，不调用Gemini',
      });
    })();
    return true;

  } else if (message.action === 'cancelBackgroundDub') {
    (async () => {
      const videoId = message.videoId;
      const job = await loadJob();
      if (!job || !videoId || !job.videoIds?.includes(videoId)) {
        sendResponse({ ok: false, error: '没有找到该视频的后台任务' });
        return;
      }
      job.states = job.states || {};
      job.states[videoId] = 'cancelled';
      try { _activeDubControllers.get(videoId)?.abort(); } catch (_) {}
      job.cacheVerified = job.cacheVerified || {};
      job.cacheVerified[videoId] = false;
      if (job.errors) delete job.errors[videoId];
      await saveJob(job);
      await updateSharedBackgroundJob(videoId, {
        status: 'cancelled', done: job.progress?.[videoId]?.done || 0,
        total: job.progress?.[videoId]?.total || 0, verified: false,
        title: job.videoMeta?.[videoId]?.title || videoId,
        voices: job.options?.[videoId]?.voices || [], error: '',
      });
      sendResponse({ ok: true, message: '后台配音已停止；已完成缓存保留，可稍后继续' });
    })();
    return true;

  } else if (message.action === 'clearBackgroundVideoDubCache') {
    (async () => {
      const videoId = String(message.videoId || '').trim();
      if (!videoId) {
        sendResponse({ ok: false, error: '缺少视频ID' });
        return;
      }
      const result = await _clearBackgroundLocalDubVideo(videoId);
      if (message.clearServer !== false) {
        const server = await _clearServerDubCache(videoId);
        result.serverCleared = !!server.ok;
        if (!server.ok) result.errors.push(server.status
          ? `服务器缓存清除失败（HTTP ${server.status}）`
          : `服务器缓存清除失败：${server.error || '未知错误'}`);
      }
      result.ok = result.backgroundAudioRemaining === 0;
      sendResponse(result);
    })();
    return true;

  } else if (message.action === 'getSharedDubStatus') {
    (async () => {
      try {
        const response = await fetch(SERVER + '/background_job_status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ video_ids: message.videoIds || [] }),
        });
        const data = await response.json();
        sendResponse({ ok: response.ok, jobs: data.jobs || {}, error: data.error || '' });
      } catch (e) {
        sendResponse({ ok: false, jobs: {}, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.action === 'startPrefetchCaptions') {
    (async () => {
      const existing = await loadJob();
      if (existing && existing.running) {
        sendResponse({ message: '已有配音任务在运行' });
        return;
      }
      const videoIds = message.videoIds || [];
      const states = {}, errors = {};
      videoIds.forEach(id => { states[id] = 'pending'; });
      const videoMeta = {};
      for (const item of (message.videos || [])) {
        if (item?.id) videoMeta[item.id] = {
          title: item.title || item.id,
          url: item.url || `https://www.youtube.com/watch?v=${item.id}`,
        };
      }
      await saveJob({
        running: true, videoIds, videoMeta, states, errors, startedAt: Date.now(),
      });
      chrome.alarms.create('dubWatchdog', { periodInMinutes: 0.5 });
      sendResponse({ message: '已启动后台配音，共 ' + videoIds.length + ' 个视频（可关闭弹窗）' });
      runDubLoop();
    })();
    return true;

  } else if (message.action === 'getPrefetchStatus') {
    (async () => {
      const job = await loadJob();
      if (!job) {
        sendResponse({ total: 0, completed: 0, successCount: 0, failedCount: 0,
                       isRunning: false, videoStates: {}, videoErrors: {}, videoProgress: {} });
        return;
      }
      const ids = job.videoIds || [];
      let done = 0, failed = 0;
      for (const id of ids) {
        if (job.states[id] === 'done') done++;
        else if (job.states[id] === 'failed') failed++;
      }
      sendResponse({
        total: ids.length,
        completed: done + failed,
        successCount: done,
        failedCount: failed,
        isRunning: job.running,
        videoStates: job.states,
        videoErrors: job.errors,
        // 当前正在处理的视频做到第几句/共几句（分批配音的实时进度），
        // 供弹窗显示"长视频卡着不动其实是在跑"，而不是死等一个无进度的状态。
        videoProgress: job.progress || {},
        videoVoices: Object.fromEntries(ids.map((id) => [
          id, job.options?.[id]?.voices || [],
        ])),
        cacheVerified: job.cacheVerified || {},
        loopDebug: job._loop || { active: _looping, ts: Date.now(), state: 'unknown' },
      });
      ensureDubLoopRunning();
    })();
    return true;

  } else if (message.action === 'cancelPrefetch') {
    (async () => {
      const job = await loadJob();
      if (job) { job.running = false; await saveJob(job); }
      chrome.alarms.clear('dubWatchdog');
      sendResponse({ message: '已取消配音任务' });
    })();
    return true;

  } else if (message.action === 'retryPrefetchVideo') {
    (async () => {
      const videoId = message.videoId;
      let job = await loadJob();
      if (!job) job = { running: false, videoIds: [], states: {}, errors: {}, startedAt: Date.now() };
      if (!job.videoIds.includes(videoId)) job.videoIds.push(videoId);
      job.states[videoId] = 'pending';
      delete job.errors[videoId];
      if (job.progress) delete job.progress[videoId];   // 清掉上次失败留下的旧进度数字
      job.running = true;
      await saveJob(job);
      chrome.alarms.create('dubWatchdog', { periodInMinutes: 0.5 });
      runDubLoop();
      sendResponse({ message: '已重新加入队列' });
    })();
    return true;

  } else if (message.action === 'parsePlaylist') {
    // 需要在有 YouTube 标签页的情况下，从页面的脚本获取播放列表
    chrome.tabs.query({ url: '*://www.youtube.com/playlist*' }, async (tabs) => {
      if (!tabs.length) {
        sendResponse({ error: '未找到播放列表标签页' });
        return;
      }
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: 'extractPlaylistVideos' },
          { frameId: 0 },
          (response) => { resolve(response?.videos || []); }
        );
      });
      sendResponse({ videos: response });
    });
    return true; // 异步回复

  } else if (message.type === 'armTabRecording') {
    (async () => {
      try {
        const tabId = message.tabId;
        const streamId = message.streamId;
        if (!tabId || !streamId) {
          sendResponse({ ok: false, error: '弹窗未取得标签页录制权限' });
          return;
        }
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'start-recording', tabId, streamId,
          withVideo: !!message.withVideo,
        });
        if (resp?.ok) {
          chrome.tabs.sendMessage(tabId, { type: 'tabRecordingArmed' }).catch(() => {});
        }
        sendResponse(resp || { ok: false, error: '录制启动无响应' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'reuseTabRecording') {
    (async () => {
      try {
        const tabId = message.tabId;
        if (!tabId) { sendResponse({ ok: false, error: '找不到当前标签页' }); return; }
        await ensureOffscreenDocument();
        const status = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'recording-status', tabId,
        });
        if (status?.active) {
          await chrome.tabs.sendMessage(tabId, { type: 'tabRecordingArmed' }).catch(() => {});
          sendResponse({ ok: true, reused: true });
        } else {
          sendResponse({ ok: false, error: '未找到可复用的录制器' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'getTabRecordingStatus') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
        await ensureOffscreenDocument();
        const status = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'recording-status', tabId,
        });
        sendResponse(status);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'setTabRecordingPaused') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'set-recording-paused',
          tabId, paused: !!message.paused,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'sampleCurrentTabVoice') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'sample-current-tab-voice', tabId,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'resetTabRecordingSegment') {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'reset-recording-segment', tabId,
          videoId: message.videoId, server: message.server || SERVER,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'downloadMergedAudio') {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const server = String(message.server || SERVER).replace(/\/+$/, '');
        const videoId = encodeURIComponent(message.videoId || '');
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'download-remote-file',
          url: `${server}/merged_audio/${videoId}`,
          filename: message.filename || `dubbing_${videoId}.mp3`,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'prepareTabCapture') {
    // chrome.tabCapture.getMediaStreamId() 必须在"用户手势"的有效窗口内调用，过期后
    // 会静默失败（不抛异常，Chrome官方文档：requires a user gesture, e.g. a content
    // script click handler；过期后 fails silently——见 https://developer.chrome.com/
    // docs/extensions/reference/api/tabCapture）。之前的实现把这个调用放在
    // markPlaybackStart() 那一刻才发起，中间隔着取字幕（可能10-40+秒）、判断说话人
    // 性别等一大堆异步等待，早就超出手势有效期了——这正是"自动下载录音/录像从来没
    // 成功过"的根本原因，不是getUserMedia参数格式或别的什么细节问题。
    // 修复：content.js 在真人点击配音/朗读按钮那一刻（同一个事件循环里，手势仍然
    // 有效）就立即发这条消息拿到streamId，先攒着；真正要开始录制时（markPlaybackStart）
    // 直接用这个已经拿到手的streamId，不再现场调用getMediaStreamId。
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
      try {
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        await ensureOffscreenDocument();
        sendResponse({ ok: true, streamId });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'startTabAudioRecording') {
    // 用 chrome.tabCapture 录这个标签页的音频输出，而不是像之前那样在content script里
    // 用 createMediaElementSource 接管正在播放的 audio 元素——那种做法一旦Web Audio
    // 上下文出问题（标签页切后台被挂起等）就会永久没声音，用户反馈了好几次。tabCapture
    // 是从标签页整体层面录音，完全不碰页面里任何具体的音频元素，没有这个风险。
    // 实际录音工作在 offscreen document 里做（service worker 不能直接用 MediaRecorder）。
    // streamId 必须是 'prepareTabCapture' 提前（点击那一刻，手势窗口内）拿到的——见上面
    // 那条消息的注释。这里不再现场调用 getMediaStreamId，只负责把已有的streamId转发给
    // offscreen document 真正开始录制。
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
      if (!message.streamId) {
        sendResponse({ ok: false, error: '缺少streamId（未在点击时提前获取，可能是手势窗口已过期）' });
        return;
      }
      try {
        await ensureOffscreenDocument();
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'start-recording', tabId, streamId: message.streamId, withVideo: !!message.withVideo,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.type === 'stopTabAudioRecording') {
    (async () => {
      const tabId = sender.tab?.id;
      if (!tabId) { sendResponse({ ok: false, error: '缺少tabId' }); return; }
      try {
        const resp = await chrome.runtime.sendMessage({
          target: 'offscreen', type: 'stop-recording', tabId, filename: message.filename || 'dub_audio',
          keepStream: !!message.keepStream,
          videoId: message.videoId,
          server: message.server || SERVER,
        });
        sendResponse(resp);
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;

  } else if (message.action === 'createPlaylist') {
    // 创建播放列表（从 Bilibili/YouTube 搜索页面导入）
    const { name, videos } = message;
    chrome.storage.local.get({ playlists: [], collected_videos: [] }, (storage) => {
      const newPlaylist = {
        id: 'bili_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        name: name || '未命名播放列表',
        videos: videos || [],
        createdAt: new Date().toISOString(),
      };
      const updated = (storage.playlists || []).concat([newPlaylist]);
      const allVids = (storage.collected_videos || []).concat(videos || []);
      chrome.storage.local.set({
        playlists: updated,
        collected_videos: allVids
      }, () => {
        console.log('[后台] 创建播放列表:', name, '包含', (videos || []).length, '个视频');
        sendResponse({ ok: true, playlist: newPlaylist });
      });
    });
    return true; // 异步回复
  }
});
