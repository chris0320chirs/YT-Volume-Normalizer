/**
 * YouTube 音量範圍鎖定器與真隨機 - Content Script
 * 核心升級：【廣播級雙重動態等化引擎 (Broadcast Dual-Stage Leveler)】
 * 徹底解決「忽大忽小」問題，達成「聽到的聲音幾乎完全一樣」的終極目標！
 *
 * 架構說明：
 * 1. 杜絕乾聲洩漏 (Zero Dry Leakage)：明確初始化 dryGain 為 0，確保 100% 走處理通道。
 * 2. 宏觀預讀等化 (Macro Gain Stage)：結合 YouTube 官方 Content Loudness 元數據與 3秒積分響度，為每支影片定調基底。
 * 3. 核心廣播壓平機 (Core C++ DSP Leveler)：
 *    - 採用瀏覽器原生 DynamicsCompressorNode (48kHz sample-by-sample 運算)
 *    - Threshold: -28dBFS (捕獲所有說話聲、低語、音樂、吵雜背景)
 *    - Ratio: 20:1 (廣播級重度壓平：輸入每上升 20dB，輸出僅微動 1dB！)
 *    - Knee: 15dB (超平滑軟膝過渡，毫無機械感或破音)
 *    - Attack: 3ms (瞬間咬住突發音量)
 * 4. 目標耳感化妝增益 (Target Ear-Volume Makeup Stage)：
 *    - 將壓平後的音訊精準放大至使用者在面板設定的「耳朵目標固定音量」。
 * 5. 25ms Lookahead 前瞻預判與磚牆安全限制器 (Brickwall Limiter)。
 */

(() => {
  'use strict';

  if (window.__YT_VOLUME_NORMALIZER_LOADED__) return;
  window.__YT_VOLUME_NORMALIZER_LOADED__ = true;

  // 預設設定
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetVolume: 100,      // 目標固定音量：0% ~ 150% (100% 標稱標準 -16 dBFS)
    rangeTightness: 'strict', // 預設改為嚴格極致鎖定！
    mode: 'standard',       // 'standard' (日常平衡) | 'vocal' (人聲強化) | 'music' (音樂原味)
  };

  // 等化風格與壓縮器矩陣
  const LEVELER_CONFIGS = {
    standard: {
      threshold: -28.0, // dBFS (捕獲絕大部分語音與音樂)
      ratio: 20.0,      // 20:1 極限壓平，保證每支影片聲音一樣
      knee: 14.0,       // 軟膝平滑過渡
      attack: 0.003,    // 3ms 瞬時咬定
      release: 0.22,    // 220ms 自然釋放
      baseMakeupGainDb: 11.5, // 基準化妝增益
    },
    vocal: {
      threshold: -32.0, // 更深捕獲微弱低語
      ratio: 20.0,
      knee: 12.0,
      attack: 0.002,
      release: 0.18,
      baseMakeupGainDb: 14.0,
    },
    music: {
      threshold: -22.0,
      ratio: 12.0,
      knee: 18.0,
      attack: 0.005,
      release: 0.30,
      baseMakeupGainDb: 8.5,
    },
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let audioCtx = null;
  let mediaSourceNode = null;
  let inputAnalyserNode = null;
  let lookaheadDelayNode = null;
  let macroGainNode = null;         // 宏觀基準增益
  let levelerCompressorNode = null; // 核心 C++ DSP 壓平機 (20:1)
  let targetMakeupGainNode = null;  // 目標音量化妝增益
  let limiterNode = null;           // 磚牆防破音
  let wetGainNode = null;
  let dryGainNode = null;
  let outputAnalyserNode = null;
  let connectedVideo = null;
  let macroMonitorLoopId = null;

  // 官方預讀元數據
  let ytOfficialLoudnessDb = null;

  // 宏觀長期滑動視窗 (3.0 秒，避免被單詞呼吸干擾)
  const MACRO_WINDOW_SIZE = 60; // 60 * 50ms = 3.0s
  const macroRmsHistory = [];
  let currentStatusMode = 'locked';
  let currentOutputVu = 0;
  let currentOutputPeak = 0;
  let currentAppliedOffsetDb = 0;
  const activePorts = new Set();

  /* ==========================================================================
     播放清單真隨機 (True Shuffle)
     ========================================================================== */
  let isTrueShuffleEnabled = false;
  let currentPlaylistId = null;
  const playedVideoIds = new Set();

  // 1. 初始化讀取 Local 設定
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    if (stored.volume !== undefined && stored.targetVolume === undefined) {
      stored.targetVolume = Math.min(150, Math.max(0, stored.volume));
    }
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    updateAudioParameters();
  });

  // 2. 初始化讀取 Session 設定 (真隨機)
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get({ trueShuffle: false }, (stored) => {
      isTrueShuffleEnabled = Boolean(stored && stored.trueShuffle);
      checkPlaylistContext();
    });
  }

  // 監聽全域設定變更
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

  // 接收 page_bridge.js 官方 Content Loudness
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'YT_NORMALIZER_CONTENT_LOUDNESS') {
      const val = event.data.loudnessDb;
      if (typeof val === 'number' && !isNaN(val)) {
        ytOfficialLoudnessDb = val;
        console.log(`[YT Leveler] 成功接收 YouTube 官方 Content Loudness: ${val} dB`);

        // 在影片開始前直接對齊宏觀基準 (正值表示原片小聲需拉高，負值表示原片大聲需壓制)
        if (currentSettings.enabled && macroGainNode && audioCtx) {
          const baseOffsetDb = -val;
          const clamped = Math.min(20, Math.max(-18, baseOffsetDb));
          currentAppliedOffsetDb = clamped;
          const macroGain = Math.pow(10, clamped / 20);
          macroGainNode.gain.setTargetAtTime(macroGain, audioCtx.currentTime, 0.02);
        }
      }
    }
  });

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
   * 計算並套用音訊核心參數 (C++ DSP Leveler)
   */
  function updateAudioParameters() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const cfg = LEVELER_CONFIGS[currentSettings.mode] || LEVELER_CONFIGS.standard;

    // 1. 嚴格杜絕乾音洩漏 (Zero Dry Leakage)
    if (wetGainNode && dryGainNode) {
      const wetTarget = currentSettings.enabled ? 1.0 : 0.0;
      const dryTarget = currentSettings.enabled ? 0.0 : 1.0;
      wetGainNode.gain.setValueAtTime(wetTarget, now);
      dryGainNode.gain.setValueAtTime(dryTarget, now);
    }

    // 2. 核心 C++ DSP 壓平機配置 (DynamicsCompressor)
    if (levelerCompressorNode) {
      let effectiveRatio = cfg.ratio;
      let effectiveThreshold = cfg.threshold;
      let effectiveKnee = cfg.knee;
      let effectiveBaseMakeup = cfg.baseMakeupGainDb;

      if (currentSettings.rangeTightness === 'strict') {
        effectiveRatio = 20.0;
        effectiveThreshold = Math.min(-28.0, cfg.threshold - 2.0);
        effectiveKnee = Math.max(6.0, cfg.knee - 4.0);
        effectiveBaseMakeup += 2.0;
      } else if (currentSettings.rangeTightness === 'wide') {
        effectiveRatio = Math.max(4.0, cfg.ratio * 0.6);
        effectiveThreshold = cfg.threshold + 4.0;
        effectiveKnee = cfg.knee + 4.0;
        effectiveBaseMakeup -= 2.0;
      }

      levelerCompressorNode.threshold.setValueAtTime(effectiveThreshold, now);
      levelerCompressorNode.knee.setValueAtTime(effectiveKnee, now);
      levelerCompressorNode.ratio.setValueAtTime(effectiveRatio, now);
      levelerCompressorNode.attack.setValueAtTime(cfg.attack, now);
      levelerCompressorNode.release.setValueAtTime(cfg.release, now);

      // 3. 使用者目標耳感化妝增益 (Target Makeup Gain)
      // 透過此增益，將已經完全被壓平一致的聲音，縮放為使用者自訂的大小
      if (targetMakeupGainNode) {
        const userFactor = currentSettings.targetVolume / 100; // 0.0 ~ 1.5
        if (currentSettings.targetVolume === 0) {
          targetMakeupGainNode.gain.setTargetAtTime(0.0, now, 0.02);
        } else {
          const totalMakeupDb = effectiveBaseMakeup + (userFactor - 1.0) * 16.0;
          const linearMakeupGain = Math.max(0.001, Math.pow(10, totalMakeupDb / 20));
          targetMakeupGainNode.gain.setTargetAtTime(linearMakeupGain, now, 0.02);
        }
      }
    }

    // 4. 磚牆防破音限制器 (保護耳機不失真)
    if (limiterNode) {
      limiterNode.threshold.setValueAtTime(-0.5, now);
      limiterNode.knee.setValueAtTime(4.0, now);
      limiterNode.ratio.setValueAtTime(20.0, now);
      limiterNode.attack.setValueAtTime(0.001, now);
      limiterNode.release.setValueAtTime(0.05, now);
    }
  }

  function resetVideoLoudnessState() {
    macroRmsHistory.length = 0;
    currentAppliedOffsetDb = 0;
    currentStatusMode = 'locked';
    ytOfficialLoudnessDb = null;
    checkPlaylistContext();
  }

  /**
   * 建立廣播級 Web Audio API 音訊管線
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

      // 1. 前瞻取樣分析節點 (零延遲探針)
      inputAnalyserNode = audioCtx.createAnalyser();
      inputAnalyserNode.fftSize = 2048;
      inputAnalyserNode.smoothingTimeConstant = 0.2;

      // 2. 25ms Lookahead 前瞻延遲節點
      lookaheadDelayNode = audioCtx.createDelay(0.1);
      lookaheadDelayNode.delayTime.setValueAtTime(0.025, audioCtx.currentTime);

      // 3. 宏觀基準增益節點 (Macro Gain Stage)
      macroGainNode = audioCtx.createGain();
      macroGainNode.gain.value = 1.0;

      // 4. 核心 C++ DSP 壓平機 (Core Leveler Compressor)
      levelerCompressorNode = audioCtx.createDynamicsCompressor();

      // 5. 目標耳感化妝增益 (Target Makeup Gain)
      targetMakeupGainNode = audioCtx.createGain();
      targetMakeupGainNode.gain.value = 1.0;

      // 6. 磚牆防破音限制器 (Brickwall Safety Limiter)
      limiterNode = audioCtx.createDynamicsCompressor();

      // 7. 乾濕聲道切換 (明確初始化避免洩漏)
      wetGainNode = audioCtx.createGain();
      dryGainNode = audioCtx.createGain();
      wetGainNode.gain.value = currentSettings.enabled ? 1.0 : 0.0;
      dryGainNode.gain.value = currentSettings.enabled ? 0.0 : 1.0;

      // 8. 輸出量表分析節點
      outputAnalyserNode = audioCtx.createAnalyser();
      outputAnalyserNode.fftSize = 512;
      outputAnalyserNode.smoothingTimeConstant = 0.4;

      // =========================================================================
      // 拓撲連接：
      // A. 原生旁路 (Bypass): Source -> dryGain -> Destination (停用時才開)
      mediaSourceNode.connect(dryGainNode);
      dryGainNode.connect(audioCtx.destination);

      // B. 探測通道 (零延遲探針): Source -> inputAnalyserNode
      mediaSourceNode.connect(inputAnalyserNode);

      // C. 核心廣播等化播放通道：
      //    Source -> Lookahead(25ms) -> MacroGain -> LevelerCompressor(20:1) -> TargetMakeup -> Limiter -> wetGain -> Destination
      mediaSourceNode.connect(lookaheadDelayNode);
      lookaheadDelayNode.connect(macroGainNode);
      macroGainNode.connect(levelerCompressorNode);
      levelerCompressorNode.connect(targetMakeupGainNode);
      targetMakeupGainNode.connect(limiterNode);
      limiterNode.connect(wetGainNode);
      wetGainNode.connect(audioCtx.destination);

      // D. 輸出分析: wetGain -> outputAnalyserNode
      wetGainNode.connect(outputAnalyserNode);
      // =========================================================================

      connectedVideo = videoElement;

      videoElement.addEventListener('loadstart', resetVideoLoudnessState);
      videoElement.addEventListener('emptied', resetVideoLoudnessState);
      videoElement.addEventListener('seeking', () => { macroRmsHistory.length = 0; });

      const wakeAudioCtx = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => {
            updateAudioParameters();
          });
        }
      };
      videoElement.addEventListener('play', wakeAudioCtx);
      videoElement.addEventListener('playing', wakeAudioCtx);
      document.addEventListener('click', wakeAudioCtx, { passive: true });
      document.addEventListener('keydown', wakeAudioCtx, { passive: true });
      wakeAudioCtx();

      updateAudioParameters();
      startMacroLoudnessLoop();

      console.log('[YT Broadcast Leveler] 廣播級 20:1 核心壓平引擎已啟動，聲音將保持完全恆定。');
    } catch (e) {
      console.warn('[YT Broadcast Leveler] 管線掛載提示:', e);
    }
  }

  /**
   * 宏觀多秒積分循環 (平穩推升極小影片，不產生音量抖動與抽吸)
   */
  function startMacroLoudnessLoop() {
    if (macroMonitorLoopId) clearInterval(macroMonitorLoopId);

    const inBuf = new Float32Array(inputAnalyserNode ? inputAnalyserNode.fftSize : 2048);
    const outBuf = new Float32Array(outputAnalyserNode ? outputAnalyserNode.fftSize : 512);

    macroMonitorLoopId = setInterval(() => {
      if (!audioCtx || !inputAnalyserNode || !connectedVideo) return;

      const isMutedOrPaused = connectedVideo.paused || connectedVideo.muted || connectedVideo.playbackRate === 0;
      if (isMutedOrPaused) {
        currentOutputVu *= 0.8;
        currentOutputPeak *= 0.85;
        currentStatusMode = 'idle';
        broadcastStatus(isMutedOrPaused);
        return;
      }

      // 1. 取樣未延遲的輸入訊號
      inputAnalyserNode.getFloatTimeDomainData(inBuf);
      let sumSq = 0;
      for (let i = 0; i < inBuf.length; i++) {
        const s = inBuf[i];
        sumSq += s * s;
      }
      const frameRms = Math.sqrt(sumSq / inBuf.length);
      const frameDb = 20 * Math.log10(Math.max(frameRms, 0.000001));

      // 語音門檻：忽略完全無聲段落，防止底噪放大
      if (frameDb > -58) {
        macroRmsHistory.push(frameRms);
        if (macroRmsHistory.length > MACRO_WINDOW_SIZE) {
          macroRmsHistory.shift();
        }
      }

      // 2. 廣播級連續動態 AGC (平穩推升極小影片，壓制巨大影片)
      // 無論是否有官方 loudnessDb（官方數值在影片開始時作為 Jump-Start），AGC 持續微調宏觀基底
      if (currentSettings.enabled && macroRmsHistory.length >= 8 && macroGainNode) {
        let histSum = 0;
        for (let i = 0; i < macroRmsHistory.length; i++) {
          histSum += macroRmsHistory[i] * macroRmsHistory[i];
        }
        const integratedRms = Math.sqrt(histSum / macroRmsHistory.length);
        const inputDb = 20 * Math.log10(Math.max(integratedRms, 0.000001));

        // 基準期望值約為 -22dBFS (進入 Leveler 最佳工作點)
        const diffDb = -22.0 - inputDb;
        const clampedDiff = Math.min(22.0, Math.max(-18.0, diffDb));

        // 依據嚴格度調節滑動平滑速率
        let slewSpeed = 0.15;
        let slewTime = 1.0;
        if (currentSettings.rangeTightness === 'strict') {
          slewSpeed = 0.25;
          slewTime = 0.6;
        } else if (currentSettings.rangeTightness === 'wide') {
          slewSpeed = 0.08;
          slewTime = 1.8;
        }

        currentAppliedOffsetDb = currentAppliedOffsetDb * (1.0 - slewSpeed) + clampedDiff * slewSpeed;

        const targetMacro = Math.pow(10, currentAppliedOffsetDb / 20);
        macroGainNode.gain.setTargetAtTime(targetMacro, audioCtx.currentTime, slewTime);
      }

      // 3. 狀態標記 (Leveler 全時將動態壓縮在極窄範圍)
      if (currentSettings.enabled) {
        let threshold = 2.0;
        if (currentSettings.rangeTightness === 'strict') threshold = 1.0;
        else if (currentSettings.rangeTightness === 'wide') threshold = 3.5;

        if (currentAppliedOffsetDb > threshold) {
          currentStatusMode = 'boosting';
        } else if (currentAppliedOffsetDb < -threshold) {
          currentStatusMode = 'cutting';
        } else {
          currentStatusMode = 'locked';
        }
      } else {
        currentStatusMode = 'idle';
      }

      // 4. 測量最終耳機輸出量表
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

        // 由於 20:1 壓平，輸出動態將極度緊湊地停留在目標區間
        const vuPercent = Math.min(100, Math.max(0, Math.round((outDb + 42) * 2.5)));
        currentOutputVu = currentOutputVu * 0.3 + vuPercent * 0.7;

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
    const currentTargetDb = -20.0 + ((currentSettings.targetVolume - 100) / 50) * 8.0;

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
      hasLookahead: true,
      officialLoudness: ytOfficialLoudnessDb !== null ? `${ytOfficialLoudnessDb.toFixed(1)} dB` : null,
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
     播放清單真隨機 (True Shuffle) 核心
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

    let unplayed = candidates.filter((c) => !playedVideoIds.has(c.vid));

    if (unplayed.length === 0) {
      playedVideoIds.clear();
      if (currentVid) playedVideoIds.add(currentVid);
      unplayed = candidates.filter((c) => !playedVideoIds.has(c.vid));
      if (unplayed.length === 0) unplayed = candidates;
    }

    const randomIndex = Math.floor(Math.random() * unplayed.length);
    const chosen = unplayed[randomIndex];

    console.log(`[YT True Shuffle] 真隨機選中: ${chosen.vid} (本輪未播剩餘: ${unplayed.length - 1} 首)`);

    playedVideoIds.add(chosen.vid);

    if (chosen.anchor) {
      chosen.anchor.click();
    } else {
      window.location.href = `/watch?v=${chosen.vid}&list=${listId}`;
    }
  }

  document.addEventListener('ended', (e) => {
    if (isTrueShuffleEnabled && e.target && e.target.tagName === 'VIDEO') {
      const listId = getPlaylistIdFromUrl();
      if (listId) {
        setTimeout(playNextRandomVideo, 250);
      }
    }
  }, true);

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
