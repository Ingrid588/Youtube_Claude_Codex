// 运行在 offscreen document 里——service worker 不能直接用 MediaStream/MediaRecorder/
// getUserMedia，必须有这么一个隐藏的、有完整DOM能力的页面来做真正的录音工作。
// 用 tabId 区分不同标签页各自的录音状态，支持多个标签页同时各录各的（互不干扰），
// 对应"开多个标签页并行配音多个视频"这种用法。
const recordings = new Map();   // tabId -> { stream, recorder, chunks, mime }

function extractCurrentF0(data, sampleRate) {
  const half = data.length >> 1;
  let rms = 0;
  for (let i = 0; i < data.length; i++) rms += data[i] * data[i];
  if (Math.sqrt(rms / data.length) < 0.005) return null;
  const lo = Math.floor(sampleRate / 400);
  const hi = Math.floor(sampleRate / 70);
  let best = -1, bestPeriod = -1;
  for (let p = lo; p <= hi && p < half; p++) {
    let corr = 0;
    for (let i = 0; i < half; i++) corr += data[i] * data[i + p];
    if (corr > best) { best = corr; bestPeriod = p; }
  }
  let f0 = bestPeriod > 0 ? sampleRate / bestPeriod : 0;
  while (f0 > 280) f0 /= 2;
  while (f0 && f0 < 75) f0 *= 2;
  return f0 >= 75 && f0 <= 280 ? f0 : null;
}

async function sampleCurrentTabVoice(tabId) {
  const rec = recordings.get(tabId);
  if (!rec?.stream?.active || !rec?.src || !rec?.ctx) {
    return { ok: false, error: '没有可采样的标签页音频流' };
  }
  const analyser = rec.ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0;
  const buf = new Float32Array(analyser.fftSize);
  const samples = [];
  try {
    rec.src.connect(analyser);
    const deadline = Date.now() + 1800;
    while (Date.now() < deadline && samples.length < 16) {
      analyser.getFloatTimeDomainData(buf);
      const f0 = extractCurrentF0(buf, rec.ctx.sampleRate);
      if (f0) samples.push(f0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    try { rec.src.disconnect(analyser); } catch (_) {}
  }
  if (!samples.length) return { ok: false, error: '当前声音中未识别到稳定人声' };
  samples.sort((a, b) => a - b);
  return { ok: true, f0: samples[Math.floor(samples.length / 2)], samples: samples.length };
}

function createRecorder(rec) {
  const recorder = rec.mime
    ? new MediaRecorder(rec.stream, { mimeType: rec.mime })
    : new MediaRecorder(rec.stream);
  rec.chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) {
      rec.chunks.push(e.data);
      maybeCheckpointRecording(rec);
    }
  };
  recorder.start(5000);
  rec.recorder = recorder;
  rec.segmentStartedAt = Date.now();
  rec.totalPausedMs = 0;
  rec.pauseStartedAt = null;
}

function setRecordingPaused(tabId, paused) {
  const rec = recordings.get(tabId);
  if (!rec?.recorder) return { ok: false, error: '没有正在运行的录制器' };
  try {
    if (paused && rec.recorder.state === 'recording') {
      rec.recorder.pause();
      rec.pauseStartedAt = Date.now();
      return { ok: true, state: 'paused' };
    }
    if (!paused && rec.recorder.state === 'paused') {
      rec.totalPausedMs += Date.now() - (rec.pauseStartedAt || Date.now());
      rec.pauseStartedAt = null;
      rec.recorder.resume();
      return { ok: true, state: 'recording', totalPausedMs: rec.totalPausedMs };
    }
    return { ok: true, state: rec.recorder.state, unchanged: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function startRecording(tabId, streamId, withVideo) {
  const existing = recordings.get(tabId);
  if (existing) {
    if (!!existing.withVideo === !!withVideo && existing.stream?.active) {
      return { ok: true, reused: true, withVideo: !!existing.withVideo };
    }
    // 用户在仅音频与音视频之间切换时，旧流不能“升级轨道”。必须释放旧流，
    // 再消费popup刚取得的新streamId建立正确模式。
    try {
      existing.recorder.onstop = null;
      if (existing.recorder.state !== 'inactive') existing.recorder.stop();
    } catch (_) {}
    try { existing.src.disconnect(); } catch (_) {}
    try { existing.ctx.close(); } catch (_) {}
    try { existing.stream.getTracks().forEach((track) => track.stop()); } catch (_) {}
    recordings.delete(tabId);
  }
  try {
    // withVideo=true 时连标签页本身渲染的画面一起录——画面里天然就包含视频画面+
    // 我们叠加的字幕层（字幕是页面DOM的一部分，渲染时本来就会被画面捕获到），
    // 等于直接录出一份"画面+字幕+配音"三合一的成片，不需要OS级录屏、也不需要
    // 事后再拿脚本拼接字幕/对齐音频。
    //
    // Chrome 116+ 推荐写法：直接把 chromeMediaSource 放在约束顶层，不用 mandatory 包装。
    // mandatory 写法是旧版Chromium非标准扩展，某些版本下会被拒绝（NotSupportedError）。
    // 先试新写法，失败了再降级到旧写法——两种都不行才真正报错。
    const makeConstraints = (useMandatory) => ({
      audio: useMandatory
        ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
        : { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      video: withVideo
        ? (useMandatory
            ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
            : { chromeMediaSource: 'tab', chromeMediaSourceId: streamId })
        : false,
    });
    let stream, lastErr;
    for (const useMandatory of [false, true]) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(makeConstraints(useMandatory));
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!stream) return { ok: false, error: `getUserMedia 失败: ${lastErr?.message || lastErr}` };
    // tabCapture 拿到音频流后，这个标签页本身的声音输出会被静音（Chrome的默认行为）——
    // 必须手动把它接回扬声器，否则用户在这段录制期间会听不到配音。视频轨道不存在
    // 这个问题（画面捕获不影响画面本身的正常显示）。
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    src.connect(ctx.destination);

    const mimeCandidates = withVideo
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm'];
    const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const rec = {
      stream, recorder: null, chunks: [], withVideo,
      mime: mime || (withVideo ? 'video/webm' : 'audio/webm'),
      ctx, src,
    };
    createRecorder(rec);
    recordings.set(tabId, rec);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function downloadRemoteFile(url, filename) {
  let lastError = '文件尚未就绪';
  for (const delay of [0, 2000, 5000, 10000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const resp = await fetch(url);
      if (!resp.ok) { lastError = `HTTP ${resp.status}`; continue; }
      const blob = await resp.blob();
      if (!blob.size) { lastError = '空文件'; continue; }
      const blobUrl = URL.createObjectURL(blob);
      return await new Promise((resolve) => {
        chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (downloadId) => {
          const error = chrome.runtime.lastError?.message;
          setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
          resolve(error || downloadId === undefined
            ? { ok: false, error: error || '下载启动失败' }
            : { ok: true, downloadId });
        });
      });
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
  return { ok: false, error: lastError };
}

function downloadBlobToComputer(blob, filename) {
  if (!blob?.size) return Promise.resolve({ ok: false, error: '录制文件为空' });
  const blobUrl = URL.createObjectURL(blob);
  return new Promise((resolve) => {
    chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    }, (downloadId) => {
      const error = chrome.runtime.lastError?.message;
      if (error || downloadId === undefined) {
        URL.revokeObjectURL(blobUrl);
        resolve({ ok: false, error: error || '本地下载启动失败' });
        return;
      }
      // 大视频可能需要很久才能被下载管理器完整读取，不能固定30秒就销毁URL。
      const cleanup = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(cleanup);
          URL.revokeObjectURL(blobUrl);
        }
      };
      chrome.downloads.onChanged.addListener(cleanup);
      setTimeout(() => {
        chrome.downloads.onChanged.removeListener(cleanup);
        URL.revokeObjectURL(blobUrl);
      }, 6 * 60 * 60 * 1000);
      resolve({ ok: true, downloadId, size: blob.size, localDirect: true });
    });
  });
}

async function cacheRecordingOnServer(blob, server, videoId, rec) {
  if (!server || !videoId) return { ok: false, error: '缺少服务器地址或videoId' };
  const base = String(server).replace(/\/+$/, '');
  const activePauseMs = rec.pauseStartedAt ? Date.now() - rec.pauseStartedAt : 0;
  const duration = Math.max(0, (
    Date.now() - (rec.segmentStartedAt || Date.now())
    - (rec.totalPausedMs || 0) - activePauseMs) / 1000);
  try {
    const resp = await fetch(`${base}/recording_cache/${encodeURIComponent(videoId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': rec.mime || 'video/webm',
        'X-With-Video': String(!!rec.withVideo),
        'X-Client-Duration': String(duration),
        'X-Partial': String(!!rec.checkpointUpload),
      },
      body: blob,
    });
    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data?.error || `HTTP ${resp.status}` };
    return data;
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function maybeCheckpointRecording(rec) {
  if (!rec.server || !rec.videoId || rec.checkpointInFlight) return;
  const now = Date.now();
  if (now - (rec.lastCheckpointAt || 0) < 30000) return;
  rec.lastCheckpointAt = now;
  rec.checkpointInFlight = true;
  rec.checkpointUpload = true;
  rec.checkpointState = 'uploading';
  rec.checkpointError = null;
  const snapshot = new Blob(rec.chunks.slice(), { type: rec.mime });
  rec.checkpointPromise = cacheRecordingOnServer(snapshot, rec.server, rec.videoId, rec)
    .then((meta) => {
      rec.lastCheckpointMeta = meta;
      if (meta?.verified) {
        rec.checkpointState = 'verified';
        console.log('[offscreen] 录制检查点已缓存', meta.video_id, meta.duration, meta.size);
      } else {
        rec.checkpointState = 'failed';
        rec.checkpointError = meta?.error || '服务器检测未通过';
        console.warn('[offscreen] 录制检查点检测未通过', meta);
      }
    })
    .catch((e) => {
      rec.checkpointState = 'failed';
      rec.checkpointError = e?.message || String(e);
      console.warn('[offscreen] 录制检查点上传失败', e);
    })
    .finally(() => {
      rec.checkpointInFlight = false;
      rec.checkpointUpload = false;
      rec.checkpointPromise = null;
    });
}

function stopRecording(tabId, filename, keepStream, server, videoId) {
  const rec = recordings.get(tabId);
  if (!rec) {
    // 隐藏页/MediaRecorder中途丢失时，尝试从服务器最后一个滚动检查点恢复成果。
    if (server && videoId) {
      const base = String(server).replace(/\/+$/, '');
      return fetch(`${base}/recording_cache_meta/${encodeURIComponent(videoId)}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`服务器无可恢复缓存 HTTP ${r.status}`);
          const cache = await r.json();
          if (!cache?.verified) throw new Error('服务器最后检查点未通过检测');
          const dl = await downloadRemoteFile(
            `${base}/recording_cache/${encodeURIComponent(videoId)}`, `${filename}.webm`);
          return { ...dl, cache, recoveredFromCheckpoint: true };
        })
        .catch((e) => ({ ok: false, error: e.message || String(e) }));
    }
    return Promise.resolve({ ok: false, error: '没有正在进行的录音，也没有服务器检查点' });
  }
  return new Promise((resolve) => {
    const finish = async () => {
      let downloadResult = { ok: false, error: '尚未进入下载阶段' };
      let cacheResult = { ok: false, error: '没有录制数据' };
      let continued = false;
      try {
        const blob = new Blob(rec.chunks, { type: rec.mime });
        if (!blob.size) throw new Error('录制文件为空（0 bytes）');
        // 第一优先级：直接下载浏览器本地Blob。服务器是否在线、是否验证通过，
        // 都不再决定用户能不能拿到最终文件。
        downloadResult = await downloadBlobToComputer(blob, `${filename}.webm`);
        if (!downloadResult.ok) {
          throw new Error(downloadResult.error || '本地下载启动失败');
        }

        // 连续播放先立即启动下一段，避免等待大文件上传服务器造成视频之间漏录。
        const cacheContext = {
          mime: rec.mime,
          withVideo: rec.withVideo,
          segmentStartedAt: rec.segmentStartedAt,
          totalPausedMs: rec.totalPausedMs || 0,
          pauseStartedAt: rec.pauseStartedAt,
          checkpointUpload: false,
        };
        if (keepStream && rec.stream.active) {
          createRecorder(rec);
          continued = true;
        }

        // 第二优先级：服务器缓存仅作可选兜底。失败会返回状态供诊断，
        // 但绝不撤销已经启动的本地下载。
        if (rec.checkpointPromise) await rec.checkpointPromise;
        cacheResult = await cacheRecordingOnServer(
          blob, server, videoId, cacheContext);
      } catch (e) {
        console.warn('[offscreen] 本地录制下载失败', e);
        if (!downloadResult.ok) {
          downloadResult = { ok: false, error: e.message || String(e) };
        }
      }
      if (continued) {
        resolve({ ...downloadResult, cache: cacheResult, continued: true });
        return;
      }
      try { rec.src.disconnect(); } catch (_) {}
      try { rec.ctx.close(); } catch (_) {}
      try { rec.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      recordings.delete(tabId);
      resolve({ ...downloadResult, cache: cacheResult });
    };
    if (rec.recorder.state === 'inactive') { finish(); return; }
    rec.recorder.onstop = finish;
    try { rec.recorder.stop(); } catch (_) { finish(); }
  });
}

function resetRecordingSegment(tabId, server, videoId) {
  const rec = recordings.get(tabId);
  if (!rec) return Promise.resolve({ ok: false, error: '没有正在运行的录制器' });
  return new Promise((resolve) => {
    const restart = () => {
      try {
        rec.chunks = [];
        rec.server = server;
        rec.videoId = videoId;
        // 第一份检查点约10秒后即可上传；之后仍保持30秒间隔。
        rec.lastCheckpointAt = Date.now() - 20000;
        rec.lastCheckpointMeta = null;
        rec.checkpointState = 'waiting';
        rec.checkpointError = null;
        createRecorder(rec);
        resolve({ ok: true });
      } catch (e) {
        resolve({ ok: false, error: e.message || String(e) });
      }
    };
    if (rec.recorder.state === 'inactive') { restart(); return; }
    rec.recorder.onstop = restart;
    try { rec.recorder.stop(); } catch (_) { restart(); }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;
  if (message.type === 'start-recording') {
    startRecording(message.tabId, message.streamId, message.withVideo).then(sendResponse);
    return true;
  }
  if (message.type === 'stop-recording') {
    stopRecording(message.tabId, message.filename, !!message.keepStream,
      message.server, message.videoId).then(sendResponse);
    return true;
  }
  if (message.type === 'reset-recording-segment') {
    resetRecordingSegment(message.tabId, message.server, message.videoId).then(sendResponse);
    return true;
  }
  if (message.type === 'set-recording-paused') {
    sendResponse(setRecordingPaused(message.tabId, !!message.paused));
    return;
  }
  if (message.type === 'recording-status') {
    const rec = recordings.get(message.tabId);
    const audioTracks = rec?.stream?.getAudioTracks?.() || [];
    const videoTracks = rec?.stream?.getVideoTracks?.() || [];
    sendResponse({
      ok: true,
      active: !!(rec && rec.stream?.active && rec.recorder?.state !== 'inactive'),
      withVideo: !!rec?.withVideo,
      recorderState: rec?.recorder?.state || 'missing',
      totalPausedMs: rec?.totalPausedMs || 0,
      audioTracks: audioTracks.map((t) => t.readyState),
      videoTracks: videoTracks.map((t) => t.readyState),
      chunks: rec?.chunks?.length || 0,
      bytes: (rec?.chunks || []).reduce((n, b) => n + (b.size || 0), 0),
      checkpoint: rec?.lastCheckpointMeta || null,
      checkpointState: rec?.checkpointState || (
        rec?.server && rec?.videoId ? 'waiting' : 'not-configured'),
      checkpointError: rec?.checkpointError || null,
    });
    return;
  }
  if (message.type === 'sample-current-tab-voice') {
    sampleCurrentTabVoice(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === 'download-remote-file') {
    downloadRemoteFile(message.url, message.filename).then(sendResponse);
    return true;
  }
});
