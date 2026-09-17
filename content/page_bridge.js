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
    extractAndSendLoudness();
    setTimeout(extractAndSendLoudness, 200);
    setTimeout(extractAndSendLoudness, 600);
  });

  window.addEventListener('loadstart', () => {
    extractAndSendLoudness();
  }, true);

  // 初始嘗試提取
  extractAndSendLoudness();
  setTimeout(extractAndSendLoudness, 500);
  setTimeout(extractAndSendLoudness, 1500);
})();
