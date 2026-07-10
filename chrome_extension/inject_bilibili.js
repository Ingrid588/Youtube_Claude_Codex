// 注入到 B站页面，拦截字幕 JSON 请求，转发给 content.js，以及搜索页面的视频选择功能
(function () {
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      // B站 AI字幕 URL 特征
      if (url.includes('aisubtitle.hdslb.com') || url.includes('subtitle') && url.includes('.json')) {
        const clone = resp.clone();
        clone.json().then((data) => {
          if (data?.body?.length) {
            window.postMessage({ __dubExt: true, type: 'biliSubtitle', body: data.body }, '*');
          }
        }).catch(() => {});
      }
    } catch (_) {}
    return resp;
  };

  // 同时拦截 XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._dubUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._dubUrl || '';
    if (url.includes('aisubtitle.hdslb.com') || (url.includes('subtitle') && url.includes('.json'))) {
      this.addEventListener('load', () => {
        try {
          const data = JSON.parse(this.responseText);
          if (data?.body?.length) {
            window.postMessage({ __dubExt: true, type: 'biliSubtitle', body: data.body }, '*');
          }
        } catch (_) {}
      });
    }
    return origSend.apply(this, args);
  };

  // 搜索页面：检测并增强搜索结果 UI
  function enhanceSearchResults() {
    if (!/\/search\/type=video/.test(location.pathname)) return;

    // 添加配音状态显示容器（在页面顶部或侧边）
    if (!document.querySelector('.bili-dub-status-panel')) {
      const panel = document.createElement('div');
      panel.className = 'bili-dub-status-panel';
      panel.style.cssText = `
        position: fixed;
        top: 70px;
        right: 20px;
        width: 300px;
        max-height: 400px;
        overflow-y: auto;
        background: white;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 12px;
        z-index: 9999;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      `;

      const title = document.createElement('div');
      title.textContent = '配音中的视频';
      title.style.cssText = 'font-weight:bold;margin-bottom:8px;font-size:14px;';
      panel.appendChild(title);

      const list = document.createElement('div');
      list.className = 'bili-dub-status-list';
      list.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
      panel.appendChild(list);

      document.body.appendChild(panel);
    }

    // 监听搜索结果加载（通过 Mutation Observer）
    const observer = new MutationObserver(() => {
      // 查找所有视频项（Bilibili 搜索结果的 DOM 结构：.video-item）
      document.querySelectorAll('.video-item, [class*="search-result"], [class*="video-list"] > li, [class*="video-list"] > div').forEach(item => {
        // 跳过已处理的项（检查是否已有复选框）
        if (item.querySelector('.bili-search-video-checkbox')) return;

        // 尝试提取视频标题和 BV 号
        const titleEl = item.querySelector('a[title]') || item.querySelector('h2 a') || item.querySelector('.title a');
        const linkEl = item.querySelector('a[href*="bilibili.com/video"]');
        if (!titleEl || !linkEl) return;

        const title = titleEl.textContent?.trim();
        const href = linkEl.href;
        const bvidMatch = href.match(/BV[\w]+/);
        const bvid = bvidMatch ? bvidMatch[0] : null;
        if (!bvid || !title) return;

        // 在项前添加复选框
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'bili-search-video-checkbox';
        checkbox.dataset.bvid = bvid;
        checkbox.dataset.title = title;
        checkbox.style.cssText = 'margin-right:8px;cursor:pointer;';

        // 插入复选框到项的最前面
        item.insertBefore(checkbox, item.firstChild);
      });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 添加"加入播放列表"按钮（固定在底部或侧边）
    const containerEl = document.querySelector('.search-page-container, .feed, .main-container, main') || document.body;
    if (!document.querySelector('.bili-import-btn')) {
      const btn = document.createElement('button');
      btn.className = 'bili-import-btn';
      btn.textContent = '加入播放列表';
      btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 10px 16px;
        background: #0084ff;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        z-index: 10000;
      `;
      btn.addEventListener('click', () => {
        const selected = Array.from(document.querySelectorAll('.bili-search-video-checkbox:checked')).map(cb => ({
          id: cb.dataset.bvid,
          title: cb.dataset.title
        }));
        if (!selected.length) {
          alert('请先选择要导入的视频');
          return;
        }
        const playlistName = prompt(`将 ${selected.length} 个视频加入播放列表\n请输入播放列表名称：`);
        if (!playlistName) return;

        // 发送消息给 content.js，转发给 background.js
        window.postMessage({
          __dubExt: true,
          type: 'biliImportPlaylist',
          playlistName,
          videos: selected
        }, '*');

        alert(`已将 ${selected.length} 个视频加入"${playlistName}"播放列表`);
        // 清除选中
        document.querySelectorAll('.bili-search-video-checkbox:checked').forEach(cb => cb.checked = false);
      });
      document.body.appendChild(btn);
    }
  }

  enhanceSearchResults();
  // 页面加载后再执行一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', enhanceSearchResults);
  }

  // 监听来自 content.js 的配音状态更新
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__dubExt) return;
    if (e.data.type === 'updateDubStatus') {
      const { videoId, status, title } = e.data;
      updateDubStatusDisplay(videoId, status, title);
    }
  });

  // 更新配音状态显示
  function updateDubStatusDisplay(videoId, status, title) {
    const list = document.querySelector('.bili-dub-status-list');
    if (!list) return;

    // 检查该视频是否已在列表中
    let item = list.querySelector(`[data-video-id="${videoId}"]`);
    if (!item) {
      // 创建新项
      item = document.createElement('div');
      item.className = 'bili-dub-status-item';
      item.dataset.videoId = videoId;
      item.style.cssText = `
        padding: 8px;
        border: 1px solid #eee;
        border-radius: 3px;
        font-size: 11px;
      `;
      list.appendChild(item);
    }

    // 更新状态显示
    let color = '#666', icon = '⏳', statusText = '未配音';
    if (status === 'processing') {
      color = '#ff9800';
      icon = '🎙';
      statusText = '配音中';
    } else if (status === 'done') {
      color = '#4caf50';
      icon = '✅';
      statusText = '已完成';
    } else if (status === 'failed') {
      color = '#f44336';
      icon = '❌';
      statusText = '失败';
    }

    item.innerHTML = `
      <div style="color:${color};font-weight:bold;">${icon} ${statusText}</div>
      <div style="color:#999;margin-top:4px;word-break:break-all;">${title}</div>
    `;

    // 如果完成或失败，3秒后移除
    if (status === 'done' || status === 'failed') {
      setTimeout(() => {
        item.style.opacity = '0.5';
      }, 3000);
    }
  }

  // 定期轮询 chrome.storage 来同步配音状态（来自 popup.js 的 _collectionVideoStates）
  setInterval(() => {
    try {
      // 通过 postMessage 让 content.js 获取状态
      window.postMessage({
        __dubExt: true,
        type: 'getPrefetchStatus'
      }, '*');
    } catch (e) {
      // 轮询过程中的错误可以忽略
    }
  }, 1000);
})();
