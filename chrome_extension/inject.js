// 运行在页面主世界(MAIN world)：
// 1) 读取 window.ytInitialPlayerResponse 转发给 content script
// 2) 拦截 YouTube 播放器自己发出的字幕(timedtext)网络请求——
//    直接从插件 fetch 字幕地址会被 YouTube 限制返回空(缺pot令牌)，
//    但播放器自身的请求带着正确令牌，截获它的返回即可拿到字幕。
(function () {
  // window.ytInitialPlayerResponse 只在整页加载时由YouTube写一次（SSR快照），
  // 播放列表/自动播放切到下一个视频时YouTube不会更新它——这个变量名字带"Initial"
  // 不是没道理的。之前只读这一个全局变量，导致：第一个视频之后，自动配音用的
  // 字幕轨道信息全部是第一个视频的旧数据（表现是"自动配音看起来触发了但配不出来/
  // 配的是错视频的字幕"）。改用播放器自己的 getPlayerResponse()——这个方法反映的
  // 是当前正在播放的视频，每次切视频都会更新，是更可靠的实时数据源。
  function getLivePlayerResponse() {
    try {
      var player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        var r = player.getPlayerResponse();
        if (r && r.videoDetails) return r;
      }
    } catch (e) {}
    return window.ytInitialPlayerResponse;
  }
  var lastSentVid = null;
  function send(force) {
    try {
      var data = getLivePlayerResponse();
      if (!data) return;
      var vid = data.videoDetails && data.videoDetails.videoId;
      if (!force && vid && vid === lastSentVid) return;   // 没变就不重复发，减少无谓的消息
      lastSentVid = vid || lastSentVid;
      window.postMessage({ __dubExt: true, type: 'playerResponse', data: data }, '*');
    } catch (e) {}
  }
  send(true);
  var tries = 0;
  // 不再像之前那样10次后 clearInterval：播放列表/自动播放会持续切视频，需要长期盯着
  // videoId 变化主动重新推送，否则字幕轨道数据永远停在第一个视频上不更新。
  setInterval(function () {
    tries++;
    send(tries <= 10);   // 前10次（刚加载，数据可能还没就位）强制发；之后只在videoId变了才发
  }, 500);

  function isTimedText(url) {
    return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;
  }

  // 转发拦截到的字幕：URL（带 pot 令牌）+ 原始 body + 是否已是中文。
  // inject 不再自己发任何额外请求，中文翻译统一由 content.js 拉取一次，
  // 避免 inject 与 content 重复请求同一中文 URL 触发 429。
  function relay(url, body) {
    if (!url) return;
    var isZh = url.indexOf('tlang=zh') !== -1 || url.indexOf('lang=zh') !== -1;
    window.postMessage({
      __dubExt: true, type: 'timedtext',
      url: url, body: (body && body.trim()) ? body : '', isChinese: isZh,
    }, '*');
  }

  // 拦截 fetch
  var origFetch = window.fetch;
  window.fetch = function () {
    var args = arguments;
    var p = origFetch.apply(this, args);
    try {
      var url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url);
      if (isTimedText(url)) {
        p.then(function (resp) {
          resp.clone().text().then(function (t) { relay(url, t); }).catch(function () { relay(url, ''); });
        }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };

  // 拦截 XHR
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dubUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    if (isTimedText(xhr.__dubUrl)) {
      xhr.addEventListener('load', function () {
        try { relay(xhr.__dubUrl, xhr.responseText); } catch (e) { relay(xhr.__dubUrl, ''); }
      });
    }
    return origSend.apply(this, arguments);
  };

  // content.js 请求：让播放器自己切换到"自动翻译→目标语言"的字幕轨。
  // 用播放器内部 API（loadModule/setOption），不点任何菜单 DOM——效果等同用户手动在
  // "设置→字幕→自动翻译→中文"里选了一遍：播放器会自己发出带 tlang=zh-Hans + pot 令牌
  // 的真实字幕请求，上面的 fetch/XHR 拦截自然就能截到中文结果。这是被动监听之外
  // 最稳的取字幕方式（请求完全由播放器构造，令牌/指纹/登录态全是真的，跟用户手动
  // 操作发出的请求无法区分），比脚本自己构造 URL 或服务器 yt-dlp 代抓的限流风险低得多。
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || !msg.__dubExt || msg.type !== 'setCaptionTranslation') return;
    var result = { __dubExt: true, type: 'setCaptionTranslationResult', ok: false, error: '' };
    try {
      var player = document.getElementById('movie_player');
      if (!player || typeof player.setOption !== 'function') {
        result.error = 'no player or setOption unavailable';
        window.postMessage(result, '*');
        return;
      }
      // 确保字幕模块已加载（等同开启CC）；已加载时重复调用无害
      try { if (typeof player.loadModule === 'function') player.loadModule('captions'); } catch (e) {}
      var tracks = [];
      try { tracks = player.getOption('captions', 'tracklist') || []; } catch (e) {}
      var base = tracks && tracks.length ? tracks[0] : null;
      // SPA 切到后续视频后，只传 languageCode 会被播放器静默忽略。必须保留
      // 当前基础字幕轨的完整字段，再叠加目标翻译语言。
      var opt = base ? Object.assign({}, base) : {};
      // targetLang 传空 = 还原到原文轨。YouTube 会跨视频记住"自动翻译→中文"这个
      // 偏好，取完中文兜底不还原的话，下一轮主路径开 CC 只会等到 tlang=zh 的请求，
      // 原文轨永远拦不到，用户就会看到"未拦到原文字幕，请手动选 en"。
      if (msg.targetLang) {
        opt.translationLanguage = { languageCode: msg.targetLang };
      } else {
        delete opt.translationLanguage;
      }
      player.setOption('captions', 'track', opt);
      result.ok = true;
    } catch (e) {
      result.error = String((e && e.message) || e);
    }
    window.postMessage(result, '*');
  });
})();
