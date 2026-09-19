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
    let videoCategory = null;
    let videoTitle = null;
    let videoAuthor = null;
    let musicVideoType = null;

    try {
      // 途徑 1: 存取 YouTube 播放器實例的 API
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const res = player.getPlayerResponse();
        if (res) {
          if (res.playerConfig && res.playerConfig.audioConfig) {
            loudnessDb = res.playerConfig.audioConfig.loudnessDb;
          }
          if (res.microformat && res.microformat.playerMicroformatRenderer) {
            videoCategory = res.microformat.playerMicroformatRenderer.category || null;
          }
          if (res.videoDetails) {
            videoTitle = res.videoDetails.title || null;
            videoAuthor = res.videoDetails.author || null;
            musicVideoType = res.videoDetails.musicVideoType || null;
          }
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
      if (window.ytInitialPlayerResponse) {
        const initRes = window.ytInitialPlayerResponse;
        if (loudnessDb === null && initRes?.playerConfig?.audioConfig?.loudnessDb !== undefined) {
          loudnessDb = initRes.playerConfig.audioConfig.loudnessDb;
        }
        if (!videoCategory && initRes?.microformat?.playerMicroformatRenderer?.category) {
          videoCategory = initRes.microformat.playerMicroformatRenderer.category;
        }
        if (!videoTitle && initRes?.videoDetails?.title) {
          videoTitle = initRes.videoDetails.title;
        }
        if (!videoAuthor && initRes?.videoDetails?.author) {
          videoAuthor = initRes.videoDetails.author;
        }
        if (!musicVideoType && initRes?.videoDetails?.musicVideoType) {
          musicVideoType = initRes.videoDetails.musicVideoType;
        }
      }
    } catch (err) {
      // 忽略跨域或未初始化例外
    }

    // 發送響度與官方影片分類元數據
    window.postMessage({
      type: 'YT_NORMALIZER_CONTENT_LOUDNESS',
      loudnessDb: (loudnessDb !== null && !isNaN(loudnessDb)) ? parseFloat(loudnessDb) : null,
      category: videoCategory,
      title: videoTitle,
      author: videoAuthor,
      musicVideoType: musicVideoType,
      url: window.location.href,
    }, '*');
  }

  // 監聽 YouTube 導航完成事件
  window.addEventListener('yt-navigate-finish', () => {
    try {
      onNavigateReapply();
    } catch {}
  });

  window.addEventListener('loadstart', () => {
    try {
      onNavigateReapply();
    } catch {}
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

      // 若目前播放品質已是 targetQuality，避免重複呼叫打斷串流緩衝
      if (typeof player.getPlaybackQuality === 'function' && player.getPlaybackQuality() === targetQuality) {
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

  function togglePlay() {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerState === 'function') {
        const state = player.getPlayerState();
        // 1 = playing, 2 = paused
        if (state === 1) {
          if (typeof player.pauseVideo === 'function') player.pauseVideo();
        } else {
          if (typeof player.playVideo === 'function') player.playVideo();
        }
        return;
      }
      const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
      if (video) {
        if (video.paused) video.play();
        else video.pause();
      }
    } catch {}
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
    try {
      if (event.source !== window) return;
      if (!event.data) return;
      if (event.data.type === 'YT_NORMALIZER_SET_QUALITY') {
        applyQuality(event.data.quality);
      } else if (event.data.type === 'YT_NORMALIZER_LOCK_QUALITY') {
        currentLockedQuality = event.data.quality || 'auto';
        applyQuality(currentLockedQuality);
      } else if (event.data.type === 'YT_NORMALIZER_SET_SPEED') {
        applySpeed(event.data.speed);
      } else if (event.data.type === 'YT_NORMALIZER_TOGGLE_PLAY') {
        togglePlay();
      }
    } catch {}
  });

  function onNavigateReapply() {
    try {
      extractAndSendLoudness();
      setTimeout(extractAndSendLoudness, 300);
      setTimeout(extractAndSendLoudness, 800);
      setTimeout(extractAndSendLoudness, 1600);
      if (currentLockedQuality && currentLockedQuality !== 'auto') {
        setTimeout(() => applyQuality(currentLockedQuality), 300);
        setTimeout(() => applyQuality(currentLockedQuality), 1000);
      }
    } catch {}
  }

  // 初始嘗試提取
  try {
    extractAndSendLoudness();
    setTimeout(extractAndSendLoudness, 500);
    setTimeout(extractAndSendLoudness, 1500);
  } catch {}
})();
