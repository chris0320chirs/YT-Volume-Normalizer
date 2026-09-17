/**
 * YouTube 音量平衡鎖定器與真隨機 - Content Script
 * 核心功能：
 * 1. 音量範圍鎖定：太小自動調高、太大自動調低，嚴格維持在目標音量範圍內
 * 2. 播放清單真隨機 (True Shuffle)：
 *    - 預設關閉，且只存於 session storage (關閉 Chrome 自動還原為關閉)
 *    - 杜絕 YouTube 演算法加權與特定幾首歌循環，真正均勻隨機 (Fisher-Yates) 播放
 *    - 攔截影片結束 (ended) 與播放器「下一首 (Next Button)」
 * 3. 換片 0.1 秒瞬時收斂
 */

(() => {
  'use strict';

  if (window.__YT_VOLUME_NORMALIZER_LOADED__) return;
  window.__YT_VOLUME_NORMALIZER_LOADED__ = true;

  // 預設設定
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetVolume: 100,      // 目標固定音量：0% ~ 150% (100% 標稱標準 -16 dBFS)
    rangeTightness: 'standard', // 'strict' (嚴格 ±1dB) | 'standard' (標準 ±2dB) | 'wide' (寬容 ±3.5dB)
    mode: 'standard',       // 'standard' (日常平衡) | 'vocal' (人聲強化) | 'music' (音樂原味)
  };

  // 容許範圍半徑 (dB)
  const TIGHTNESS_MAP = {
    strict: 1.0,
    standard: 2.0,
    wide: 3.5,
  };

  // 模式細節配置
  const MODE_CONFIGS = {
    standard: {
      baseTargetDb: -16,
      maxBoostDb: 24,      // 太低最高調高 +24 dB
      maxCutDb: -24,       // 太高最高調低 -24 dB
      rampUpSpeed: 0.35,   // 太小時調高的過渡時間 (秒)
      rampDownSpeed: 0.05, // 太高時調低的反應速度 (秒)
      knee: 10,
      ratio: 16,
    },
    vocal: {
      baseTargetDb: -14,
      maxBoostDb: 28,
      maxCutDb: -26,
      rampUpSpeed: 0.25,
      rampDownSpeed: 0.04,
      knee: 8,
      ratio: 20,
    },
    music: {
      baseTargetDb: -17,
      maxBoostDb: 20,
      maxCutDb: -20,
      rampUpSpeed: 0.60,
      rampDownSpeed: 0.08,
      knee: 16,
      ratio: 8,
    },
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let audioCtx = null;
  let mediaSourceNode = null;
  let inputAnalyserNode = null;
  let agcGainNode = null;
  let limiterNode = null;
  let wetGainNode = null;
  let dryGainNode = null;
  let outputAnalyserNode = null;
  let connectedVideo = null;
  let agcLoopId = null;

  // 響度平滑滑動視窗
  const LOUDNESS_WINDOW_SIZE = 22; // 約 1.1 秒
  const rmsHistory = [];
  let currentTargetDb = -16;
  let lastAppliedGain = 1.0;
  let currentAppliedOffsetDb = 0;
  let currentStatusMode = 'idle'; // 'boosting' | 'cutting' | 'locked' | 'idle'
  let currentOutputVu = 0;
  let currentOutputPeak = 0;
  let isNewVideoConvergence = true;
  const activePorts = new Set();

  /* ==========================================================================
     播放清單真隨機 (True Shuffle) 狀態與變數
     ========================================================================== */
  let isTrueShuffleEnabled = false; // 預設關閉！
  let currentPlaylistId = null;
  const playedVideoIds = new Set();

  // 1. 初始化讀取 Local 設定 (音量等化)
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    if (stored.volume !== undefined && stored.targetVolume === undefined) {
      stored.targetVolume = Math.min(150, Math.max(0, stored.volume));
    }
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    updateAudioParameters();
  });

  // 2. 初始化讀取 Session 設定 (真隨機 - 僅存在於工作階段，重開瀏覽器必為關閉)
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get({ trueShuffle: false }, (stored) => {
      isTrueShuffleEnabled = Boolean(stored && stored.trueShuffle);
      checkPlaylistContext();
    });
  }

  // 監聽全域設定變更 (包含 local 與 session)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      for (const [k, v] of Object.entries(changes)) {
        if (k in currentSettings) {
          currentSettings[k] = v.newValue;
        } else if (k === 'volume') {
          currentSettings.targetVolume = Math.min(150, Math.max(0, v.newValue));
        }
      }
      updateAudioParameters();
    } else if (area === 'session') {
      if ('trueShuffle' in changes) {
        isTrueShuffleEnabled = Boolean(changes.trueShuffle.newValue);
        checkPlaylistContext();
      }
    }
  });

  // 支援直接 Runtime 訊息切換真隨機
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TOGGLE_TRUE_SHUFFLE') {
      isTrueShuffleEnabled = Boolean(msg.enabled);
      checkPlaylistContext();
      sendResponse({ status: 'ok', isTrueShuffleEnabled });
    } else if (msg.type === 'GET_PLAYLIST_STATUS') {
      sendResponse(getPlaylistStats());
    }
  });

  /**
   * 計算並套用目標分貝
   */
  function updateAudioParameters() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const config = MODE_CONFIGS[currentSettings.mode] || MODE_CONFIGS.standard;

    const factor = currentSettings.targetVolume / 100;
    currentTargetDb = config.baseTargetDb + (factor - 1) * 16;

    if (wetGainNode && dryGainNode) {
      const wetTarget = currentSettings.enabled ? 1.0 : 0.0;
      const dryTarget = currentSettings.enabled ? 0.0 : 1.0;
      wetGainNode.gain.setTargetAtTime(wetTarget, now, 0.03);
      dryGainNode.gain.setTargetAtTime(dryTarget, now, 0.03);
    }

    if (limiterNode) {
      limiterNode.threshold.setTargetAtTime(-1.0, now, 0.02);
      limiterNode.knee.setTargetAtTime(config.knee, now, 0.02);
      limiterNode.ratio.setTargetAtTime(config.ratio, now, 0.02);
      limiterNode.attack.setTargetAtTime(0.001, now, 0.02);
      limiterNode.release.setTargetAtTime(0.06, now, 0.02);
    }
  }

  function resetVideoLoudnessState() {
    rmsHistory.length = 0;
    isNewVideoConvergence = true;
    currentAppliedOffsetDb = 0;
    currentStatusMode = 'idle';
    checkPlaylistContext();
  }

  /**
   * 建立 Web Audio API 音訊管線
   */
  function setupAudioPipeline(videoElement) {
    if (!videoElement || connectedVideo === videoElement) return;

    try {
      if (!audioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioCtxClass();
      }

      if (!videoElement.__ytNormalizerSource) {
        mediaSourceNode = audioCtx.createMediaElementSource(videoElement);
        videoElement.__ytNormalizerSource = mediaSourceNode;
      } else {
        mediaSourceNode = videoElement.__ytNormalizerSource;
      }

      inputAnalyserNode = audioCtx.createAnalyser();
      inputAnalyserNode.fftSize = 2048;
      inputAnalyserNode.smoothingTimeConstant = 0.2;

      agcGainNode = audioCtx.createGain();
      limiterNode = audioCtx.createDynamicsCompressor();
      wetGainNode = audioCtx.createGain();
      dryGainNode = audioCtx.createGain();

      outputAnalyserNode = audioCtx.createAnalyser();
      outputAnalyserNode.fftSize = 512;
      outputAnalyserNode.smoothingTimeConstant = 0.4;

      // 拓撲連接
      mediaSourceNode.connect(dryGainNode);
      dryGainNode.connect(audioCtx.destination);

      mediaSourceNode.connect(inputAnalyserNode);

      mediaSourceNode.connect(agcGainNode);
      agcGainNode.connect(limiterNode);
      limiterNode.connect(wetGainNode);
      wetGainNode.connect(audioCtx.destination);

      wetGainNode.connect(outputAnalyserNode);

      connectedVideo = videoElement;

      videoElement.addEventListener('loadstart', resetVideoLoudnessState);
      videoElement.addEventListener('emptied', resetVideoLoudnessState);
      videoElement.addEventListener('seeking', () => { isNewVideoConvergence = true; });

      const wakeAudioCtx = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
      };
      videoElement.addEventListener('play', wakeAudioCtx);
      videoElement.addEventListener('playing', wakeAudioCtx);
      document.addEventListener('click', wakeAudioCtx, { passive: true });
      document.addEventListener('keydown', wakeAudioCtx, { passive: true });
      wakeAudioCtx();

      updateAudioParameters();
      startEqualizerLoop();

      console.log('[YT Normalizer & Shuffle] 音訊管線已就緒。');
    } catch (e) {
      console.warn('[YT Normalizer & Shuffle] 管線掛載提示:', e);
    }
  }

  /**
   * 智慧調高/調低與範圍鎖定循環 (50ms 週期)
   */
  function startEqualizerLoop() {
    if (agcLoopId) clearInterval(agcLoopId);

    const inBuf = new Float32Array(inputAnalyserNode ? inputAnalyserNode.fftSize : 2048);
    const outBuf = new Float32Array(outputAnalyserNode ? outputAnalyserNode.fftSize : 512);

    agcLoopId = setInterval(() => {
      if (!audioCtx || !inputAnalyserNode || !connectedVideo) return;

      const isMutedOrPaused = connectedVideo.paused || connectedVideo.muted || connectedVideo.playbackRate === 0;
      if (isMutedOrPaused) {
        currentOutputVu *= 0.8;
        currentOutputPeak *= 0.85;
        currentStatusMode = 'idle';
        broadcastStatus(isMutedOrPaused);
        return;
      }

      inputAnalyserNode.getFloatTimeDomainData(inBuf);
      let sumSq = 0;
      for (let i = 0; i < inBuf.length; i++) {
        const s = inBuf[i];
        sumSq += s * s;
      }
      const frameRms = Math.sqrt(sumSq / inBuf.length);
      const frameDb = 20 * Math.log10(Math.max(frameRms, 0.000001));

      const hasSound = frameDb > -62;
      if (hasSound) {
        rmsHistory.push(frameRms);
        if (rmsHistory.length > LOUDNESS_WINDOW_SIZE) {
          rmsHistory.shift();
        }
      }

      if (currentSettings.enabled && rmsHistory.length >= 2 && agcGainNode) {
        let histSum = 0;
        for (let i = 0; i < rmsHistory.length; i++) {
          histSum += rmsHistory[i] * rmsHistory[i];
        }
        const integratedRms = Math.sqrt(histSum / rmsHistory.length);
        const currentInputDb = 20 * Math.log10(Math.max(integratedRms, 0.000001));

        const config = MODE_CONFIGS[currentSettings.mode] || MODE_CONFIGS.standard;
        const tolerance = TIGHTNESS_MAP[currentSettings.rangeTightness] || 2.0;

        const diffDb = currentTargetDb - currentInputDb;

        if (Math.abs(diffDb) <= tolerance) {
          currentStatusMode = 'locked';
        } else if (diffDb > tolerance) {
          currentStatusMode = 'boosting';
        } else {
          currentStatusMode = 'cutting';
        }

        const clampedDiffDb = Math.min(config.maxBoostDb, Math.max(config.maxCutDb, diffDb));
        currentAppliedOffsetDb = clampedDiffDb;

        const targetGain = Math.pow(10, clampedDiffDb / 20);

        let rampTime;
        if (isNewVideoConvergence) {
          rampTime = 0.05;
          if (rmsHistory.length >= 5) {
            isNewVideoConvergence = false;
          }
        } else {
          const isLowering = targetGain < lastAppliedGain;
          rampTime = isLowering ? config.rampDownSpeed : config.rampUpSpeed;
        }

        agcGainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, rampTime);
        lastAppliedGain = targetGain;
      } else if (!currentSettings.enabled && agcGainNode) {
        currentAppliedOffsetDb = 0;
        currentStatusMode = 'idle';
        agcGainNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.04);
      }

      if (outputAnalyserNode) {
        outputAnalyserNode.getFloatTimeDomainData(outBuf);
        let outSum = 0;
        let outPeak = 0;
        for (let i = 0; i < outBuf.length; i++) {
          const val = outBuf[i];
          const abs = Math.abs(val);
          if (abs > outPeak) outPeak = abs;
          outSum += val * val;
        }
        const outRms = Math.sqrt(outSum / outBuf.length);
        const outDb = 20 * Math.log10(Math.max(outRms, 0.000001));

        const vuPercent = Math.min(100, Math.max(0, Math.round((outDb + 48) * 2.2)));
        currentOutputVu = currentOutputVu * 0.35 + vuPercent * 0.65;

        if (outPeak > currentOutputPeak) {
          currentOutputPeak = outPeak;
        } else {
          currentOutputPeak *= 0.94;
        }
      }

      broadcastStatus(false);
    }, 50);
  }

  /**
   * 推播即時狀態至控制面板
   */
  function broadcastStatus(isPaused) {
    if (activePorts.size === 0) return;

    const offsetSign = currentAppliedOffsetDb >= 0 ? '+' : '';
    const playlistStats = getPlaylistStats();

    const payload = {
      type: 'VU_DATA',
      level: Math.round(currentOutputVu),
      peak: Math.min(100, Math.round(currentOutputPeak * 100)),
      offsetDb: `${offsetSign}${currentAppliedOffsetDb.toFixed(1)} dB`,
      rawOffset: currentAppliedOffsetDb,
      statusMode: currentStatusMode,
      targetDb: `${Math.round(currentTargetDb)} dBFS`,
      targetVolume: currentSettings.targetVolume,
      rangeTightness: currentSettings.rangeTightness,
      isPlaying: connectedVideo ? !connectedVideo.paused && !isPaused : false,
      enabled: currentSettings.enabled,
      // 真隨機播放清單資訊
      isPlaylist: playlistStats.isPlaylist,
      playlistCount: playlistStats.itemCount,
      playedCount: playlistStats.playedCount,
      isTrueShuffle: isTrueShuffleEnabled,
    };

    for (const port of activePorts) {
      try {
        port.postMessage(payload);
      } catch {
        activePorts.delete(port);
      }
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'yt-volume-vu') {
      activePorts.add(port);
      port.onDisconnect.addListener(() => {
        activePorts.delete(port);
      });
    }
  });

  /* ==========================================================================
     播放清單真隨機 (True Shuffle) 核心演算法
     ========================================================================== */
  function getPlaylistIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('list');
  }

  function getCurrentVideoIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('v');
  }

  function checkPlaylistContext() {
    const listId = getPlaylistIdFromUrl();
    if (listId !== currentPlaylistId) {
      currentPlaylistId = listId;
      playedVideoIds.clear();
      const currentV = getCurrentVideoIdFromUrl();
      if (currentV) playedVideoIds.add(currentV);
    }
  }

  function getPlaylistElements() {
    return Array.from(document.querySelectorAll('ytd-playlist-panel-video-renderer'));
  }

  function getPlaylistStats() {
    const listId = getPlaylistIdFromUrl();
    const items = getPlaylistElements();
    return {
      isPlaylist: Boolean(listId),
      listId: listId || '',
      itemCount: items.length,
      playedCount: playedVideoIds.size,
      isEnabled: isTrueShuffleEnabled,
    };
  }

  function playNextRandomVideo() {
    if (!isTrueShuffleEnabled) return;
    const listId = getPlaylistIdFromUrl();
    if (!listId) return;

    const items = getPlaylistElements();
    if (!items || items.length <= 1) return;

    const currentVid = getCurrentVideoIdFromUrl();
    if (currentVid) playedVideoIds.add(currentVid);

    // 擷取清單中所有候選項目的 Video ID 與 DOM 節點
    const candidates = [];
    for (const item of items) {
      const anchor = item.querySelector('a#wc-endpoint') || item.querySelector('a#thumbnail') || item.querySelector('a');
      if (!anchor) continue;
      const href = anchor.getAttribute('href') || '';
      const match = href.match(/[?&]v=([^&]+)/);
      const vid = match ? match[1] : null;

      if (vid && vid !== currentVid) {
        candidates.push({ item, anchor, vid });
      }
    }

    if (candidates.length === 0) return;

    // 過濾未曾播放過的項目 (杜絕演算法偏頗與重複播放)
    let unplayed = candidates.filter((c) => !playedVideoIds.has(c.vid));

    // 全數播完時重設一輪循環
    if (unplayed.length === 0) {
      playedVideoIds.clear();
      if (currentVid) playedVideoIds.add(currentVid);
      unplayed = candidates.filter((c) => !playedVideoIds.has(c.vid));
      if (unplayed.length === 0) unplayed = candidates;
    }

    // 真・均勻隨機抽選 (Fisher-Yates 原理)
    const randomIndex = Math.floor(Math.random() * unplayed.length);
    const chosen = unplayed[randomIndex];

    console.log(`[YT True Shuffle] 真隨機選中: ${chosen.vid} (本輪未播剩餘: ${unplayed.length - 1} 首)`);

    playedVideoIds.add(chosen.vid);

    // 觸發 YouTube SPA 內部無縫導航
    if (chosen.anchor) {
      chosen.anchor.click();
    } else {
      window.location.href = `/watch?v=${chosen.vid}&list=${listId}`;
    }
  }

  // 1. 攔截影片播放結束 (ended) 事件
  document.addEventListener('ended', (e) => {
    if (isTrueShuffleEnabled && e.target && e.target.tagName === 'VIDEO') {
      const listId = getPlaylistIdFromUrl();
      if (listId) {
        setTimeout(playNextRandomVideo, 250);
      }
    }
  }, true);

  // 2. 攔截 YouTube 控制列「下一首」按鈕點擊
  document.addEventListener('click', (e) => {
    if (!isTrueShuffleEnabled) return;
    const nextBtn = e.target.closest('.ytp-next-button');
    if (nextBtn) {
      const listId = getPlaylistIdFromUrl();
      if (listId) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        playNextRandomVideo();
      }
    }
  }, true);

  /**
   * 搜尋並掛載 YouTube 影片標籤
   */
  function findAndHookVideo() {
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video && video !== connectedVideo) {
      setupAudioPipeline(video);
    }
  }

  const observer = new MutationObserver(() => findAndHookVideo());
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    findAndHookVideo();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      findAndHookVideo();
    });
  }

  window.addEventListener('yt-navigate-finish', () => {
    resetVideoLoudnessState();
    setTimeout(findAndHookVideo, 150);
  });
  window.addEventListener('popstate', () => {
    resetVideoLoudnessState();
    setTimeout(findAndHookVideo, 150);
  });
  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') setupAudioPipeline(e.target);
  }, true);

  setInterval(findAndHookVideo, 1500);
})();
