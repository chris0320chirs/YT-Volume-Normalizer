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

  const QUALITY_PRIORITY = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

  /**
   * 讀取 YouTube 本地儲存之畫質偏好 (在 document_start 於 MAIN 世界第 0 毫秒同步取得)
   */
  function getStoredQualityPreference() {
    try {
      const raw = window.localStorage.getItem('yt-player-quality');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.data && parsed.data !== 'auto') {
          return parsed.data;
        }
      }
    } catch {}
    return 'auto';
  }

  /**
   * 同步寫入 YouTube 本地儲存 yt-player-quality
   * 使 YouTube 原生播放器 ABR 在初始讀取 Manifest 前便以此作為預設目標畫質，杜絕以 360p/480p 低畫質預載
   */
  function persistQualityPreference(quality) {
    try {
      const target = quality || 'auto';
      const now = Date.now();
      window.localStorage.setItem('yt-player-quality', JSON.stringify({
        data: target,
        creation: now,
        expiration: now + 2592000000 // 30 天
      }));
    } catch {}
  }

  let currentLockedQuality = getStoredQualityPreference();

  function computeChosenQuality(targetQuality, available) {
    if (!targetQuality || targetQuality === 'auto') return 'auto';
    if (!Array.isArray(available) || available.length === 0) return targetQuality;
    if (available.includes(targetQuality)) return targetQuality;

    const prefIdx = QUALITY_PRIORITY.indexOf(targetQuality);
    const fallbackList = prefIdx >= 0 ? QUALITY_PRIORITY.slice(prefIdx) : QUALITY_PRIORITY;
    const matched = fallbackList.find((q) => available.includes(q));
    return matched || available[0];
  }

  let hookedPlayer = null;
  function ensurePlayerListeners(player) {
    try {
      if (!player || hookedPlayer === player) return;
      if (typeof player.addEventListener === 'function') {
        player.addEventListener('onStateChange', (state) => {
          // -1: UNSTARTED, 1: PLAYING, 3: BUFFERING, 5: CUED
          if (state === -1 || state === 3 || state === 1 || state === 5) {
            if (currentLockedQuality && currentLockedQuality !== 'auto') {
              applyQuality(currentLockedQuality);
            }
          }
        });
        player.addEventListener('onPlaybackQualityChange', (newQuality) => {
          if (currentLockedQuality && currentLockedQuality !== 'auto') {
            // 若 YouTube 嘗試降級，立即再次強制鎖定
            if (newQuality !== currentLockedQuality) {
              applyQuality(currentLockedQuality);
            }
          }
        });
        hookedPlayer = player;
      }
    } catch {}
  }

  function applyQuality(targetQuality) {
    try {
      const player = getActivePlayer() || document.getElementById('movie_player');
      if (!player) return;

      ensurePlayerListeners(player);

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

      const chosen = computeChosenQuality(targetQuality, available);

      // 若目前播放品質已是 chosen，避免重複呼叫打斷串流緩衝
      if (typeof player.getPlaybackQuality === 'function' && player.getPlaybackQuality() === chosen) {
        return;
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

  let qualityLadderTimers = [];
  function clearQualityLadder() {
    qualityLadderTimers.forEach((t) => clearTimeout(t));
    qualityLadderTimers = [];
  }

  /**
   * 零延遲畫質鎖定階梯 (Zero-Delay Quality Ladder)
   * 0ms 立即執行第一次嘗試，並搭配微小間隔快速重試，
   * 確保播放器只要一就緒或清晰度清單剛填充，瞬間鎖定，杜絕低畫質預載
   */
  function triggerQualityLadder(targetQuality) {
    const q = targetQuality || currentLockedQuality;
    if (!q || q === 'auto') return;

    // 0ms 立即執行
    applyQuality(q);

    clearQualityLadder();
    const delays = [20, 60, 150, 300, 600, 1200];
    for (const d of delays) {
      const timer = setTimeout(() => {
        applyQuality(q);
      }, d);
      qualityLadderTimers.push(timer);
    }
  }

  // 監聽 YouTube SPA 生命週期事件 (全鏈路 0ms 觸發)
  window.addEventListener('yt-navigate-start', () => {
    try {
      triggerQualityLadder();
    } catch {}
  });

  window.addEventListener('yt-navigate-finish', () => {
    try {
      onNavigateReapply();
    } catch {}
  });

  window.addEventListener('yt-page-data-updated', () => {
    try {
      if (currentLockedQuality && currentLockedQuality !== 'auto') {
        triggerQualityLadder();
      }
    } catch {}
  });

  window.addEventListener('loadstart', () => {
    try {
      onNavigateReapply();
    } catch {}
  }, true);

  window.addEventListener('loadedmetadata', () => {
    try {
      if (currentLockedQuality && currentLockedQuality !== 'auto') {
        triggerQualityLadder();
      }
    } catch {}
  }, true);

  window.addEventListener('canplay', () => {
    try {
      if (currentLockedQuality && currentLockedQuality !== 'auto') {
        applyQuality(currentLockedQuality);
      }
    } catch {}
  }, true);

  function isShortsUrl() {
    return window.location.pathname.startsWith('/shorts') || Boolean(document.querySelector('ytd-shorts'));
  }

  function getActiveVideo() {
    try {
      if (isShortsUrl()) {
        const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (activeReel) {
          const v = activeReel.querySelector('video');
          if (v) return v;
        }
        const shortsVideos = document.querySelectorAll('ytd-shorts video, ytd-reel-video-renderer video');
        for (const v of shortsVideos) {
          if (!v.paused && v.readyState >= 2) return v;
        }
        for (const v of shortsVideos) {
          if (v.currentTime > 0) return v;
        }
        if (shortsVideos.length > 0) return shortsVideos[0];
      }
    } catch {}
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }

  function getActivePlayer() {
    try {
      if (isShortsUrl()) {
        const activeReel = document.querySelector('ytd-reel-video-renderer[is-active]');
        if (activeReel) {
          const p = activeReel.querySelector('.html5-video-player') || activeReel.querySelector('#player-container') || activeReel;
          if (p) return p;
        }
      }
    } catch {}
    return document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  }

  function togglePlay() {
    try {
      const player = getActivePlayer();
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
      const video = getActiveVideo();
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
      const player = getActivePlayer();
      if (player && typeof player.setPlaybackRate === 'function') {
        player.setPlaybackRate(num);
      }
      const video = getActiveVideo();
      if (video) {
        video.playbackRate = num;
      }
    } catch (e) {
      // 容錯防護
    }
  }

  function applyVolume(vol) {
    try {
      const volume = Math.min(100, Math.max(0, Math.round(vol)));
      const player = getActivePlayer();
      if (player && typeof player.setVolume === 'function') {
        if (typeof player.isMuted === 'function' && player.isMuted() && volume > 0) {
          if (typeof player.unMute === 'function') player.unMute();
        }
        player.setVolume(volume);
      }
      const video = getActiveVideo();
      if (video) {
        if (video.muted && volume > 0) {
          video.muted = false;
        }
        video.volume = volume / 100;
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
        persistQualityPreference(currentLockedQuality);
        triggerQualityLadder(currentLockedQuality);
      } else if (event.data.type === 'YT_NORMALIZER_SET_SPEED') {
        applySpeed(event.data.speed);
      } else if (event.data.type === 'YT_NORMALIZER_SET_VOLUME') {
        applyVolume(event.data.volume);
      } else if (event.data.type === 'YT_NORMALIZER_TOGGLE_PLAY') {
        togglePlay();
      }
    } catch {}
  });

  function onNavigateReapply() {
    try {
      extractAndSendLoudness();
      triggerQualityLadder();
      setTimeout(extractAndSendLoudness, 300);
      setTimeout(extractAndSendLoudness, 800);
      setTimeout(extractAndSendLoudness, 1600);
    } catch {}
  }

  // 初始嘗試提取與畫質立即鎖定
  try {
    extractAndSendLoudness();
    if (currentLockedQuality && currentLockedQuality !== 'auto') {
      triggerQualityLadder(currentLockedQuality);
    }
    setTimeout(extractAndSendLoudness, 500);
    setTimeout(extractAndSendLoudness, 1500);
  } catch {}
})();
