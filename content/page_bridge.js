/**
 * YouTube 音量範圍鎖定器 - Page World Bridge
 * 運行於 YouTube 頁面主世界 (world: "MAIN")，
 * 具備直接存取 YouTube 內部播放器 API (movie_player / ytInitialPlayerResponse) 之權限。
 * 核心功能：在影片載入第 0 秒讀取官方 Content Loudness 響度元數據，並透過 postMessage 傳給 Content Script。
 */

(() => {
  'use strict';

  function extractAndSendLoudness() {
    let loudnessDb = null;

    try {
      // 途徑 1: 存取 YouTube 播放器實例的 API
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const res = player.getPlayerResponse();
        if (res && res.playerConfig && res.playerConfig.audioConfig) {
          loudnessDb = res.playerConfig.audioConfig.loudnessDb;
        }
      }

      // 途徑 2: 存取 Stats for Nerds 資料
      if (loudnessDb === null && player && typeof player.getStatsForNerds === 'function') {
        const stats = player.getStatsForNerds();
        if (stats && stats.content_loudness) {
          const match = String(stats.content_loudness).match(/([-+]?\d+(\.\d+)?)/);
          if (match) {
            loudnessDb = parseFloat(match[1]);
          }
        }
      }

      // 途徑 3: 存取全域初始播放器響應物件
      if (loudnessDb === null && window.ytInitialPlayerResponse) {
        const audioCfg = window.ytInitialPlayerResponse?.playerConfig?.audioConfig;
        if (audioCfg && audioCfg.loudnessDb !== undefined) {
          loudnessDb = audioCfg.loudnessDb;
        }
      }
    } catch (err) {
      // 忽略跨域或未初始化例外
    }

    if (loudnessDb !== null && !isNaN(loudnessDb)) {
      window.postMessage({
        type: 'YT_NORMALIZER_CONTENT_LOUDNESS',
        loudnessDb: parseFloat(loudnessDb),
        url: window.location.href,
      }, '*');
    }
  }

  // 監聽 YouTube 導航完成事件
  window.addEventListener('yt-navigate-finish', () => {
    onNavigateReapply();
  });

  window.addEventListener('loadstart', () => {
    onNavigateReapply();
  }, true);

  const QUALITY_PRIORITY = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
  let currentLockedQuality = 'auto';

  function applyQuality(targetQuality) {
    try {
      const player = document.getElementById('movie_player');
      if (!player) return;

      if (!targetQuality || targetQuality === 'auto') {
        if (typeof player.setPlaybackQualityRange === 'function') {
          player.setPlaybackQualityRange('auto', 'auto');
        } else if (typeof player.setPlaybackQuality === 'function') {
          player.setPlaybackQuality('auto');
        }
        return;
      }

      const available = typeof player.getAvailableQualityLevels === 'function'
        ? player.getAvailableQualityLevels()
        : [];

      let chosen = targetQuality;
      if (available.length > 0 && !available.includes(targetQuality)) {
        const prefIdx = QUALITY_PRIORITY.indexOf(targetQuality);
        const fallbackList = prefIdx >= 0 ? QUALITY_PRIORITY.slice(prefIdx) : QUALITY_PRIORITY;
        const matched = fallbackList.find((q) => available.includes(q));
        chosen = matched || available[0];
      }

      if (typeof player.setPlaybackQualityRange === 'function') {
        player.setPlaybackQualityRange(chosen, chosen);
      }
      if (typeof player.setPlaybackQuality === 'function') {
        player.setPlaybackQuality(chosen);
      }
    } catch (e) {
      // 容錯防護
    }
  }

  function applySpeed(speed) {
    try {
      const num = parseFloat(speed);
      if (isNaN(num) || num <= 0) return;
      const player = document.getElementById('movie_player');
      if (player && typeof player.setPlaybackRate === 'function') {
        player.setPlaybackRate(num);
      }
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video) {
        video.playbackRate = num;
      }
    } catch (e) {
      // 容錯防護
    }
  }

  // 監聽來自 Content Script 的指令
  window.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'YT_NORMALIZER_SET_QUALITY') {
      applyQuality(event.data.quality);
    } else if (event.data.type === 'YT_NORMALIZER_LOCK_QUALITY') {
      currentLockedQuality = event.data.quality || 'auto';
      applyQuality(currentLockedQuality);
    } else if (event.data.type === 'YT_NORMALIZER_SET_SPEED') {
      applySpeed(event.data.speed);
    }
  });

  function onNavigateReapply() {
    extractAndSendLoudness();
    if (currentLockedQuality && currentLockedQuality !== 'auto') {
      setTimeout(() => applyQuality(currentLockedQuality), 300);
      setTimeout(() => applyQuality(currentLockedQuality), 1000);
    }
  }

  // 初始嘗試提取
  extractAndSendLoudness();
  setTimeout(extractAndSendLoudness, 500);
  setTimeout(extractAndSendLoudness, 1500);
})();
