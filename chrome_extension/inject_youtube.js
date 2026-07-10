// 注入到 YouTube 页面，处理搜索结果页面的视频选择功能
(function () {
  console.log('[YT搜索] 脚本已加载');

  // 通用的查找视频容器函数（兼容各种 YouTube UI 版本）
  function findAllVideoContainers() {
    const containers = [];

    // 策略1: 查找所有包含 watch?v= 链接的元素
    document.querySelectorAll('[href*="watch?v="]').forEach(link => {
      const videoId = link.href.match(/v=([^&]+)/)?.[1];
      if (!videoId) return;

      // 从链接往上找容器（通常5层以内）
      let container = link.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        // 如果容器足够大（宽度/高度都有意义），就当它是视频项
        const rect = container.getBoundingClientRect();
        if (rect.width > 200 && rect.height > 100) {
          containers.push({ videoId, title: link.title || link.textContent?.trim() || videoId, container });
          break;
        }
        container = container.parentElement;
      }
    });

    return containers;
  }

  // 添加复选框到视频容器
  function addCheckboxes() {
    const containers = findAllVideoContainers();
    console.log('[YT搜索] 找到 ' + containers.length + ' 个视频容器');

    let addedCount = 0;
    containers.forEach(({ videoId, title, container }) => {
      if (container.querySelector('.yt-search-video-checkbox')) {
        return; // 已有复选框，跳过
      }

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'yt-search-video-checkbox';
      checkbox.dataset.videoId = videoId;
      checkbox.dataset.title = title;
      checkbox.style.cssText = 'width:18px;height:18px;margin:8px;cursor:pointer;';

      // 保证容器支持相对定位
      if (!container.style.position || container.style.position === 'static') {
        container.style.position = 'relative';
      }

      container.insertBefore(checkbox, container.firstChild);
      console.log('[YT搜索] ✓ 添加复选框: ' + videoId);
      addedCount++;
    });

    return addedCount;
  }

  // 主流程
  const isSearchPage = /\/results/.test(location.pathname);
  console.log('[YT搜索] 是否搜索页:', isSearchPage, '路径:', location.pathname);

  if (isSearchPage) {
    // 立即添加一次
    addCheckboxes();

    // 定时添加（防止动态加载的结果没有复选框）
    setInterval(() => {
      const added = addCheckboxes();
      if (added > 0) {
        console.log('[YT搜索] 定时发现 ' + added + ' 个新结果');
      }
    }, 2000);

    // 监听 DOM 变化
    const observer = new MutationObserver(() => {
      addCheckboxes();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 添加按钮（只添加一次）
    function ensureButton() {
      if (document.querySelector('.yt-import-btn')) return;

      const btn = document.createElement('button');
      btn.className = 'yt-import-btn';
      btn.textContent = '✓ 加入播放列表';
      btn.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 10px 16px;
        background: #065fd4;
        color: white;
        border: none;
        border-radius: 20px;
        cursor: pointer;
        font-size: 14px;
        z-index: 10000;
        font-weight: 500;
      `;

      btn.onclick = function(e) {
        e.preventDefault();
        const selected = Array.from(document.querySelectorAll('.yt-search-video-checkbox:checked')).map(cb => ({
          id: cb.dataset.videoId,
          title: cb.dataset.title
        }));

        if (!selected.length) {
          alert('请先选择要导入的视频');
          return;
        }

        const playlistName = prompt('将 ' + selected.length + ' 个视频加入播放列表\\n请输入播放列表名称：');
        if (!playlistName) return;

        window.postMessage({
          __dubExt: true,
          type: 'ytImportPlaylist',
          playlistName,
          videos: selected
        }, '*');

        console.log('[YT搜索] 已发送导入: ' + playlistName);
        alert('已将 ' + selected.length + ' 个视频加入"' + playlistName + '"播放列表');

        // 清除选中
        document.querySelectorAll('.yt-search-video-checkbox').forEach(cb => cb.checked = false);
      };

      document.body.appendChild(btn);
      console.log('[YT搜索] ✓ 按钮已添加');
    }

    setTimeout(ensureButton, 500);
    setInterval(ensureButton, 5000);
  }
})();
