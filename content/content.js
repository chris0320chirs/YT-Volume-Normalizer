/**
 * YouTube 音量平衡鎖定器 - Content Script (智慧範圍等化引擎)
 * 核心功能：
 * 1. 太小聲影片：自動迅速平滑調高 (最高 +24 dB，約 16 倍提升)
 * 2. 太大聲影片或廣告：自動即刻調低 (最高 -24 dB，保護耳朵防爆音)
 * 3. 嚴格維持在使用者自訂之「目標音量範圍」內
 * 4. 新影片切換瞬時收斂 (Fast Initial Convergence)：0.1 秒內自動咬定目標音量
 * 5. -62 dBFS 寬容語音閘門：極弱語音照樣偵測拉升，純無聲間隙智慧鎖定增益防底噪
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
      maxBoostDb: 28,      // 人聲極限拉高
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
  let currentStatusMode = 'idle'; // 'boosting' (調高) | 'cutting' (調低) | 'locked' (範圍內) | 'idle'
  let currentOutputVu = 0;
  let currentOutputPeak = 0;
  let isNewVideoConvergence = true;
  const activePorts = new Set();

  // 1. 初始化讀取設定
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    if (stored.volume !== undefined && stored.targetVolume === undefined) {
      stored.targetVolume = Math.min(150, Math.max(0, stored.volume));
    }
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    updateAudioParameters();
  });

  // 監聽全域設定變更
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [k, v] of Object.entries(changes)) {
      if (k in currentSettings) {
        currentSettings[k] = v.newValue;
      } else if (k === 'volume') {
        currentSettings.targetVolume = Math.min(150, Math.max(0, v.newValue));
      }
    }
    updateAudioParameters();
  });

  /**
   * 計算並套用目標分貝
   */
  function updateAudioParameters() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const config = MODE_CONFIGS[currentSettings.mode] || MODE_CONFIGS.standard;

    // 將使用者設定的百分比映射到基準目標分貝
    // 100% -> -16dB, 50% -> -24dB, 150% -> -8dB
    const factor = currentSettings.targetVolume / 100;
    currentTargetDb = config.baseTargetDb + (factor - 1) * 16;

    // 乾濕平滑切換
    if (wetGainNode && dryGainNode) {
      const wetTarget = currentSettings.enabled ? 1.0 : 0.0;
      const dryTarget = currentSettings.enabled ? 0.0 : 1.0;
      wetGainNode.gain.setTargetAtTime(wetTarget, now, 0.03);
      dryGainNode.gain.setTargetAtTime(dryTarget, now, 0.03);
    }

    // 防破音限制器
    if (limiterNode) {
      limiterNode.threshold.setTargetAtTime(-1.0, now, 0.02);
      limiterNode.knee.setTargetAtTime(config.knee, now, 0.02);
      limiterNode.ratio.setTargetAtTime(config.ratio, now, 0.02);
      limiterNode.attack.setTargetAtTime(0.001, now, 0.02);
      limiterNode.release.setTargetAtTime(0.06, now, 0.02);
    }
  }

  /**
   * 切換新影片時重設暫態計量，觸發瞬時收斂
   */
  function resetVideoLoudnessState() {
    rmsHistory.length = 0;
    isNewVideoConvergence = true;
    currentAppliedOffsetDb = 0;
    currentStatusMode = 'idle';
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

      // 前饋取樣分析節點 (取樣原生未處理的影片聲音)
      inputAnalyserNode = audioCtx.createAnalyser();
      inputAnalyserNode.fftSize = 2048;
      inputAnalyserNode.smoothingTimeConstant = 0.2;

      // 自動增益節點與限制器
      agcGainNode = audioCtx.createGain();
      limiterNode = audioCtx.createDynamicsCompressor();
      wetGainNode = audioCtx.createGain();
      dryGainNode = audioCtx.createGain();

      // 最終輸出分析節點 (取樣使用者實際聽到的聲音)
      outputAnalyserNode = audioCtx.createAnalyser();
      outputAnalyserNode.fftSize = 512;
      outputAnalyserNode.smoothingTimeConstant = 0.4;

      // 拓撲連接：
      // 1. Bypass 旁路
      mediaSourceNode.connect(dryGainNode);
      dryGainNode.connect(audioCtx.destination);

      // 2. 前饋分析
      mediaSourceNode.connect(inputAnalyserNode);

      // 3. 處理通道：Source -> agcGain -> Limiter -> wetGain -> Destination
      mediaSourceNode.connect(agcGainNode);
      agcGainNode.connect(limiterNode);
      limiterNode.connect(wetGainNode);
      wetGainNode.connect(audioCtx.destination);

      // 4. 輸出分析
      wetGainNode.connect(outputAnalyserNode);

      connectedVideo = videoElement;

      // 影片生命週期監聽（換片時立即清空歷史，瞬時收斂）
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

      console.log('[YT Volume Normalizer] 音訊管線已就緒，自動調高太小/自動調低太大機制啟動。');
    } catch (e) {
      console.warn('[YT Volume Normalizer] 管線掛載提示:', e);
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

      // 1. 測量原生輸入 RMS
      inputAnalyserNode.getFloatTimeDomainData(inBuf);
      let sumSq = 0;
      for (let i = 0; i < inBuf.length; i++) {
        const s = inBuf[i];
        sumSq += s * s;
      }
      const frameRms = Math.sqrt(sumSq / inBuf.length);
      const frameDb = 20 * Math.log10(Math.max(frameRms, 0.000001));

      // 寬容語音閘門 (-62 dBFS)：低於此數值判定為完全靜音或對話暫停
      // 對話暫停時凍結目前增益，不拉高底噪；若有微弱聲音 (如 -58dBFS) 依然拉高
      const hasSound = frameDb > -62;

      if (hasSound) {
        rmsHistory.push(frameRms);
        if (rmsHistory.length > LOUDNESS_WINDOW_SIZE) {
          rmsHistory.shift();
        }
      }

      // 2. 自動調高太小、調低太大核心運算
      if (currentSettings.enabled && rmsHistory.length >= 2 && agcGainNode) {
        let histSum = 0;
        for (let i = 0; i < rmsHistory.length; i++) {
          histSum += rmsHistory[i] * rmsHistory[i];
        }
        const integratedRms = Math.sqrt(histSum / rmsHistory.length);
        const currentInputDb = 20 * Math.log10(Math.max(integratedRms, 0.000001));

        const config = MODE_CONFIGS[currentSettings.mode] || MODE_CONFIGS.standard;
        const tolerance = TIGHTNESS_MAP[currentSettings.rangeTightness] || 2.0;

        // 目標差距
        const diffDb = currentTargetDb - currentInputDb;

        // 判斷是否落在使用者設定的舒適範圍內
        if (Math.abs(diffDb) <= tolerance) {
          // 已落在設定範圍內，微持穩定
          currentStatusMode = 'locked';
        } else if (diffDb > tolerance) {
          // 音量太低！自動調高 (Boosting)
          currentStatusMode = 'boosting';
        } else {
          // 音量太高！自動調低 (Cutting)
          currentStatusMode = 'cutting';
        }

        // 鉗制在安全範圍內 (最高調高 +24dB，最高調低 -24dB)
        const clampedDiffDb = Math.min(config.maxBoostDb, Math.max(config.maxCutDb, diffDb));
        currentAppliedOffsetDb = clampedDiffDb;

        const targetGain = Math.pow(10, clampedDiffDb / 20);

        // 新影片開頭瞬時收斂 (0.05s 瞬間定位)，之後採非對稱平滑
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

      // 3. 測量最終輸出給使用者的 VU 量表
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
    const payload = {
      type: 'VU_DATA',
      level: Math.round(currentOutputVu),
      peak: Math.min(100, Math.round(currentOutputPeak * 100)),
      offsetDb: `${offsetSign}${currentAppliedOffsetDb.toFixed(1)} dB`,
      rawOffset: currentAppliedOffsetDb,
      statusMode: currentStatusMode, // 'boosting' | 'cutting' | 'locked' | 'idle'
      targetDb: `${Math.round(currentTargetDb)} dBFS`,
      targetVolume: currentSettings.targetVolume,
      rangeTightness: currentSettings.rangeTightness,
      isPlaying: connectedVideo ? !connectedVideo.paused && !isPaused : false,
      enabled: currentSettings.enabled,
    };

    for (const port of activePorts) {
      try {
        port.postMessage(payload);
      } catch {
        activePorts.delete(port);
      }
    }
  }

  // 監聽 Popup 長連線
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'yt-volume-vu') {
      activePorts.add(port);
      port.onDisconnect.addListener(() => {
        activePorts.delete(port);
      });
    }
  });

  /**
   * 搜尋並監聽 YouTube 影片標籤
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
