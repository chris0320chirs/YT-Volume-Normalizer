/**
 * YouTube 音量範圍鎖定器與真隨機 - Content Script
 * 核心架構：【v1.4.0 純淨抗噪零破音引擎 (Clean Anti-Noise & Zero-Clipping Leveler)】
 * 徹底解決「在特定設備出現雜音／破音／底噪抽吸」問題！
 *
 * 架構重點：
 * 1. 零溢出超平滑軟限制器 (WaveShaper Soft Clipper, 4x Oversampling)：
 *    - 物理硬性鎖定最大輸出振幅絕對 $\le -0.5$ dBFS (峰值 $\le 0.945$)。
 *    - 採用雙曲正切超平滑飽和曲線，完全杜絕任何外接 DAC / 音效卡之數位削頂爆裂雜音 (Pops & Crackles)。
 *    - $|x| \le 0.80$ 區間維持 100% 絕對線性純淨輸出 (0 畸變)。
 * 2. 智慧抗底噪門限與向下擴展 (Smart Noise Floor Gate & Downward Expander)：
 *    - 底噪門限設於 -46.0 dBFS；在安靜場景或對話暫停時，自動【凍結 AGC 增益】，不盲目拉高背景環境音。
 *    - 對話間歇啟動溫和向下擴展 (-8 dB)，徹底根絕每句對話之間的「沙沙沙」抽吸喘息現象 (Noise Floor Pumping)。
 * 3. 廣播級平滑壓縮動態 (10:1 Broadcast Compression, 380ms Release)：
 *    - 消除過快釋放與極端壓縮引發的低頻波形調制失真 (Waveform Tracking Distortion)。
 * 4. 消除冗餘延遲節點 (Zero Delay Node)：
 *    - 移除主通道 25ms 延遲緩衝，徹底消除藍牙時鐘抖動 (Buffer Underruns) 與 Seek 跳轉殘留雜音。
 * 5. 滯後防抖死區 (0.35dB Hysteresis Deadband)：
 *    - 消除微小音量波動下的頻繁參數自動化重設，根除拉鍊雜音 (Zipper Noise)。
 * 6. 拓撲單例複用機制：
 *    - YouTube SPA 切換影片時乾淨複用音訊節點，杜絕節點殘留洩漏與雙重增益梳狀濾波。
 */

(() => {
  'use strict';

  if (window.__YT_VOLUME_NORMALIZER_LOADED__) return;
  window.__YT_VOLUME_NORMALIZER_LOADED__ = true;

  // 預設設定 (重新校準：以 50% 為剛好標準舒適點)
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetVolume: 50,         // 目標固定音量：0% ~ 100% (50% 為剛好標準推薦)
    rangeTightness: 'strict', // 預設嚴格鎖定
    mode: 'standard',         // 'standard' (日常平衡) | 'vocal' (人聲強化) | 'music' (音樂原味)
    musicMode: false,         // 純聽音樂模式 (遮擋畫面、節能省電、專注好音樂)
    lockedQuality: 'auto',    // 固定畫質: 'auto' | 'hd2160' | 'hd1440' | 'hd1080' | 'hd720'
    playbackSpeed: 2.0,       // 當前播放速度 (預設 2.0x 滿足看片習慣)
    smartSpeedEnabled: true,  // 智慧音樂與影片自動調速 (聽歌 1.0x，看片 2.0x)
    musicSpeed: 1.0,          // 聽歌 / 音樂時自動套用之速度 (預設 1.0x)
    videoSpeed: 2.0,          // 一般影片時自動套用之速度 (預設 2.0x)
    shuffleWhitelist: [],     // 自動隨機白名單播放清單 ID 清單 (例如 ['PLxxxx', 'OLAK5uy_...'])
    volumeVersion: 2,         // 版本升級標記，自動將舊版數值平滑遷移至 50%
  };

  // 廣播級等化風格與壓縮器矩陣 (以 50% 為剛剛好的舒適聆聽基準)
  const LEVELER_CONFIGS = {
    standard: {
      threshold: -24.0,       // dBFS (最佳工作點)
      ratio: 10.0,            // 10:1 廣播平整比，保留良好質感且不再互調失真
      knee: 18.0,             // 18dB 寬膝平滑過渡
      attack: 0.008,          // 8ms 瞬態平滑，杜絕低頻破音
      release: 0.38,          // 380ms 自然平滑釋放，杜絕喘息與底噪抽吸
      baseMakeupGainDb: -1.5, // 50% 時的標準化妝增益 (剛好舒適)
    },
    vocal: {
      threshold: -27.0,       // 更深捕獲微弱對話
      ratio: 12.0,
      knee: 16.0,
      attack: 0.006,
      release: 0.32,
      baseMakeupGainDb: -0.5, // 50% 時的人聲強化化妝增益
    },
    music: {
      threshold: -20.0,
      ratio: 6.0,
      knee: 20.0,
      attack: 0.015,
      release: 0.45,
      baseMakeupGainDb: -3.0, // 50% 時的音樂原味化妝增益
    },
  };

  let currentSettings = { ...DEFAULT_SETTINGS };
  let audioCtx = null;
  let pipeline = null;             // 單例音訊處理節點集合
  let connectedVideo = null;
  let currentSourceNode = null;
  let macroMonitorLoopId = null;

  // 官方預讀元數據
  let ytOfficialLoudnessDb = null;

  // 宏觀長期滑動視窗 (3.0 秒，平穩追蹤)
  const MACRO_WINDOW_SIZE = 60; // 60 * 50ms = 3.0s
  const macroRmsHistory = [];
  let consecutiveQuietFrames = 0;
  let lastAppliedTargetDb = 0;
  let currentStatusMode = 'locked';
  let currentOutputVu = 0;
  let currentOutputPeak = 0;
  let currentAppliedOffsetDb = 0;
  const activePorts = new Set();

  /* ==========================================================================
     播放清單真隨機 (True Shuffle) 狀態
     ========================================================================== */
  let isTrueShuffleEnabled = false;
  let autoEnabledByWhitelist = false; // 標記目前是否由白名單自動接管真隨機
  let currentPlaylistId = null;
  const playedVideoIds = new Set();

  /* ==========================================================================
     智慧音樂與影片自動調速 (Smart Music & Video Speed) 狀態
     ========================================================================== */
  let lastEvaluatedVideoId = null;
  let manualSpeedOverriddenVideoId = null; // 當前被使用者手動覆蓋速度的影片 ID
  let currentVideoIsMusic = false;         // 當前影片是否判定為音樂
  const currentVideoMetadata = {
    category: null,
    title: null,
    author: null,
    musicVideoType: null,
  };

  /**
   * 生成 65536 點超高精度零溢出雙曲正切軟削頂曲線
   * |x| <= 0.80: 絕對 1:1 線性純淨輸出 (0 畸變)
   * |x| >  0.80: 漸進收斂至絕對天花板 0.945 (-0.5 dBFS)，杜絕硬體 DAC 削頂爆裂破音
   */
  function createZeroOvershootCurve(points = 65536) {
    const curve = new Float32Array(points);
    const xLin = 0.80;
    const k = 0.18;
    const half = (points - 1) / 2;

    for (let i = 0; i < points; i++) {
      const x = (i - half) / half;
      const absX = Math.abs(x);
      if (absX <= xLin) {
        curve[i] = x;
      } else {
        const s = Math.sign(x);
        curve[i] = s * (xLin + k * Math.tanh((absX - xLin) / k));
      }
    }
    return curve;
  }

  // 1. 初始化讀取 Local 設定 (含 v2 50% 基準平滑遷移)
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    // 平滑遷移：若使用者的設定為舊版（例如 100% 或舊版拉到極低值 6%），自動遷移至新版標準 50%
    if (!stored.volumeVersion || stored.volumeVersion < 2) {
      stored.targetVolume = 50;
      stored.volumeVersion = 2;
      chrome.storage.local.set({ targetVolume: 50, volume: 50, volumeVersion: 2 });
    } else if (stored.volume !== undefined && stored.targetVolume === undefined) {
      stored.targetVolume = Math.min(100, Math.max(0, stored.volume));
    }
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    updateAudioParameters();
    applyMusicMode(Boolean(currentSettings.musicMode));
    applyLockedQuality(currentSettings.lockedQuality);
    applyPlaybackSpeed(currentSettings.playbackSpeed);
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
      let musicModeChanged = false;
      for (const [k, v] of Object.entries(changes)) {
        if (k in currentSettings) {
          currentSettings[k] = v.newValue;
          if (k === 'musicMode') musicModeChanged = true;
          if (k === 'lockedQuality') applyLockedQuality(v.newValue);
          if (k === 'playbackSpeed') {
            // 關鍵防護：僅在關閉智慧調速（使用全域固定速度）時，才跨分頁同步套用
            // 若開啟智慧調速，各分頁依據自身內容（聽歌 1.0x / 看片 2.0x）獨立維持，杜絕互相干擾
            if (!currentSettings.smartSpeedEnabled) {
              applyPlaybackSpeed(v.newValue);
            }
          }
          if (k === 'smartSpeedEnabled' || k === 'musicSpeed' || k === 'videoSpeed') {
            evaluateAndApplySmartSpeed(true);
          }
          if (k === 'shuffleWhitelist') {
            currentSettings.shuffleWhitelist = Array.isArray(v.newValue) ? v.newValue : [];
            checkPlaylistContext();
          }
        } else if (k === 'volume') {
          currentSettings.targetVolume = Math.min(100, Math.max(0, v.newValue));
        }
      }
      updateAudioParameters();
      if (musicModeChanged) {
        applyMusicMode(Boolean(currentSettings.musicMode));
      }
    } else if (area === 'session') {
      if ('trueShuffle' in changes) {
        isTrueShuffleEnabled = Boolean(changes.trueShuffle.newValue);
        checkPlaylistContext();
      }
    }
  });

  // 接收 page_bridge.js 官方 Content Loudness 與影片元數據
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'YT_NORMALIZER_CONTENT_LOUDNESS') {
      const val = event.data.loudnessDb;
      if (typeof val === 'number' && !isNaN(val)) {
        ytOfficialLoudnessDb = val;
        console.log(`[YT Normalizer] 成功接收 YouTube 官方 Content Loudness: ${val} dB`);

        // 在影片開始前直接對齊宏觀基準 (正值表示原片小聲需拉高，負值表示原片大聲需壓制)
        // 增益上限嚴格限制在 +12.0dB，防止極度安靜或異常標註引發底噪爆鳴
        if (currentSettings.enabled && pipeline && audioCtx) {
          const baseOffsetDb = -val;
          const clamped = Math.min(12.0, Math.max(-18.0, baseOffsetDb));
          currentAppliedOffsetDb = clamped;
          lastAppliedTargetDb = clamped;
          const macroGainVal = Math.pow(10, clamped / 20);
          pipeline.macroGain.gain.setTargetAtTime(macroGainVal, audioCtx.currentTime, 0.05);
        }
      }

      // 更新官方影片元數據
      if (event.data.category !== undefined) currentVideoMetadata.category = event.data.category;
      if (event.data.title !== undefined) currentVideoMetadata.title = event.data.title;
      if (event.data.author !== undefined) currentVideoMetadata.author = event.data.author;
      if (event.data.musicVideoType !== undefined) currentVideoMetadata.musicVideoType = event.data.musicVideoType;

      // 收到元數據後即時進行智慧音樂辨識與自動調速
      evaluateAndApplySmartSpeed();
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'TOGGLE_TRUE_SHUFFLE') {
      isTrueShuffleEnabled = Boolean(msg.enabled);
      autoEnabledByWhitelist = false; // 使用者手動切換，清除自動接管標記
      checkPlaylistContext();
      sendResponse({ status: 'ok', isTrueShuffleEnabled });
    } else if (msg.type === 'TOGGLE_MUSIC_MODE') {
      const isEnabled = Boolean(msg.enabled);
      currentSettings.musicMode = isEnabled;
      chrome.storage.local.set({ musicMode: isEnabled });
      applyMusicMode(isEnabled);
      sendResponse({ status: 'ok', musicMode: isEnabled });
    } else if (msg.type === 'SET_LOCKED_QUALITY') {
      currentSettings.lockedQuality = msg.quality || 'auto';
      chrome.storage.local.set({ lockedQuality: currentSettings.lockedQuality });
      applyLockedQuality(currentSettings.lockedQuality);
      sendResponse({ status: 'ok', lockedQuality: currentSettings.lockedQuality });
    } else if (msg.type === 'SET_PLAYBACK_SPEED') {
      const speed = parseFloat(msg.speed) || 1.0;
      currentSettings.playbackSpeed = speed;
      manualSpeedOverriddenVideoId = getCurrentVideoIdFromUrl(); // 使用者主動手動設定速度，鎖定當前影片
      chrome.storage.local.set({ playbackSpeed: speed });
      applyPlaybackSpeed(speed);
      sendResponse({ status: 'ok', playbackSpeed: speed });
    } else if (msg.type === 'SET_SMART_SPEED_CONFIG') {
      if (msg.smartSpeedEnabled !== undefined) currentSettings.smartSpeedEnabled = Boolean(msg.smartSpeedEnabled);
      if (msg.musicSpeed !== undefined) currentSettings.musicSpeed = parseFloat(msg.musicSpeed) || 1.0;
      if (msg.videoSpeed !== undefined) currentSettings.videoSpeed = parseFloat(msg.videoSpeed) || 2.0;
      chrome.storage.local.set({
        smartSpeedEnabled: currentSettings.smartSpeedEnabled,
        musicSpeed: currentSettings.musicSpeed,
        videoSpeed: currentSettings.videoSpeed,
      });
      evaluateAndApplySmartSpeed(true);
      sendResponse({ status: 'ok' });
    } else if (msg.type === 'GET_PLAYLIST_STATUS') {
      sendResponse(getPlaylistStats());
    } else if (msg.type === 'TAB_ACTIVATED') {
      onTabContextSynchronize();
      sendResponse({ status: 'ok', playbackSpeed: currentSettings.playbackSpeed });
    }
  });

  /**
   * 建立或取得單例 Web Audio 處理管線
   */
  function initAudioPipeline(ctx) {
    if (pipeline) return pipeline;

    // 1. 探測通道 (零延遲探針)
    const inputAnalyser = ctx.createAnalyser();
    inputAnalyser.fftSize = 2048;
    inputAnalyser.smoothingTimeConstant = 0.2;

    // 2. 宏觀基準增益節點 (Macro AGC Stage: -18dB ~ +12dB)
    const macroGain = ctx.createGain();
    macroGain.gain.setValueAtTime(1.0, ctx.currentTime);

    // 3. 智慧抗底噪向下擴展閘門 (Smart Noise Floor Gate / Downward Expander)
    const noiseGateGain = ctx.createGain();
    noiseGateGain.gain.setValueAtTime(1.0, ctx.currentTime);

    // 4. 核心廣播壓平機 (Leveler Compressor: 10:1 平滑廣播級)
    const levelerCompressor = ctx.createDynamicsCompressor();

    // 5. 目標耳感化妝增益 (Target Makeup Gain)
    const targetMakeupGain = ctx.createGain();
    targetMakeupGain.gain.setValueAtTime(1.0, ctx.currentTime);

    // 6. 前級瞬態平滑器 (Fast Peak Limiter)
    const peakLimiter = ctx.createDynamicsCompressor();
    peakLimiter.threshold.setValueAtTime(-1.5, ctx.currentTime);
    peakLimiter.knee.setValueAtTime(2.0, ctx.currentTime);
    peakLimiter.ratio.setValueAtTime(20.0, ctx.currentTime);
    peakLimiter.attack.setValueAtTime(0.001, ctx.currentTime);
    peakLimiter.release.setValueAtTime(0.04, ctx.currentTime);

    // 7. 零溢出超平滑軟限制器 (WaveShaper Soft Clipper, 4x Oversampling)
    const softClipper = ctx.createWaveShaper();
    softClipper.curve = createZeroOvershootCurve(65536);
    try {
      softClipper.oversample = '4x';
    } catch {
      // 容錯防護
    }

    // 8. 旁路 (Bypass Dry) 與處理 (Wet) 控制節點
    const wetGain = ctx.createGain();
    const dryGain = ctx.createGain();
    wetGain.gain.setValueAtTime(currentSettings.enabled ? 1.0 : 0.0, ctx.currentTime);
    dryGain.gain.setValueAtTime(currentSettings.enabled ? 0.0 : 1.0, ctx.currentTime);

    // 9. 輸出量表分析節點
    const outputAnalyser = ctx.createAnalyser();
    outputAnalyser.fftSize = 512;
    outputAnalyser.smoothingTimeConstant = 0.4;

    // =========================================================================
    // 拓撲連接：
    // A. 處理通道：
    //    macroGain -> noiseGateGain -> levelerCompressor -> targetMakeupGain -> peakLimiter -> softClipper -> wetGain -> destination
    macroGain.connect(noiseGateGain);
    noiseGateGain.connect(levelerCompressor);
    levelerCompressor.connect(targetMakeupGain);
    targetMakeupGain.connect(peakLimiter);
    peakLimiter.connect(softClipper);
    softClipper.connect(wetGain);
    wetGain.connect(ctx.destination);
    wetGain.connect(outputAnalyser);

    // B. 旁路通道 (停用時才輸出原聲)：
    //    dryGain -> destination
    dryGain.connect(ctx.destination);
    // =========================================================================

    pipeline = {
      inputAnalyser,
      macroGain,
      noiseGateGain,
      levelerCompressor,
      targetMakeupGain,
      peakLimiter,
      softClipper,
      wetGain,
      dryGain,
      outputAnalyser,
    };

    return pipeline;
  }

  /**
   * 計算並套用音訊核心參數
   */
  function updateAudioParameters() {
    if (!audioCtx || !pipeline) return;
    const now = audioCtx.currentTime;
    const cfg = LEVELER_CONFIGS[currentSettings.mode] || LEVELER_CONFIGS.standard;

    // 1. 乾濕旁路切換 (平滑 ramp 避免開關時產生切換喀噠聲)
    const wetTarget = currentSettings.enabled ? 1.0 : 0.0;
    const dryTarget = currentSettings.enabled ? 0.0 : 1.0;
    pipeline.wetGain.gain.setTargetAtTime(wetTarget, now, 0.015);
    pipeline.dryGain.gain.setTargetAtTime(dryTarget, now, 0.015);

    // 2. 廣播級壓平機參數調校
    let effectiveRatio = cfg.ratio;
    let effectiveThreshold = cfg.threshold;
    let effectiveKnee = cfg.knee;
    let effectiveBaseMakeup = cfg.baseMakeupGainDb;

    if (currentSettings.rangeTightness === 'strict') {
      effectiveRatio = Math.min(14.0, cfg.ratio * 1.25);
      effectiveThreshold = cfg.threshold - 2.0;
      effectiveKnee = Math.max(12.0, cfg.knee - 4.0);
      effectiveBaseMakeup += 0.5;
    } else if (currentSettings.rangeTightness === 'wide') {
      effectiveRatio = Math.max(4.0, cfg.ratio * 0.65);
      effectiveThreshold = cfg.threshold + 3.0;
      effectiveKnee = cfg.knee + 4.0;
      effectiveBaseMakeup -= 0.5;
    }

    pipeline.levelerCompressor.threshold.setValueAtTime(effectiveThreshold, now);
    pipeline.levelerCompressor.knee.setValueAtTime(effectiveKnee, now);
    pipeline.levelerCompressor.ratio.setValueAtTime(effectiveRatio, now);
    pipeline.levelerCompressor.attack.setValueAtTime(cfg.attack, now);
    pipeline.levelerCompressor.release.setValueAtTime(cfg.release, now);

    // 3. 使用者目標耳感化妝增益 (Target Makeup Gain)
    // 經全新校準：以 50% 為剛剛好的舒適聆聽基準 (0 dB Delta)
    // 50% ~ 100%: 向上平滑增益 +14 dB，充裕微調弱音
    // 0% ~ 50%: 向下平滑減弱至 -26 dB，0% 為靜音
    const v = Math.min(100, Math.max(0, currentSettings.targetVolume));
    if (v === 0) {
      pipeline.targetMakeupGain.gain.setTargetAtTime(0.0, now, 0.02);
    } else {
      let deltaDb = 0;
      if (v >= 50) {
        deltaDb = (v - 50) * (14.0 / 50); // 50%->0dB, 75%->+7dB, 100%->+14dB
      } else {
        deltaDb = (v - 50) * (26.0 / 50); // 50%->0dB, 25%->-13dB, 10%->-20.8dB, 1%->-25.5dB
      }
      const totalMakeupDb = effectiveBaseMakeup + deltaDb;
      const linearMakeupGain = Math.max(0.0001, Math.pow(10, totalMakeupDb / 20));
      pipeline.targetMakeupGain.gain.setTargetAtTime(linearMakeupGain, now, 0.02);
    }
  }

  function resetVideoLoudnessState() {
    macroRmsHistory.length = 0;
    consecutiveQuietFrames = 0;
    currentAppliedOffsetDb = 0;
    lastAppliedTargetDb = 0;
    currentStatusMode = 'locked';
    ytOfficialLoudnessDb = null;
    currentVideoMetadata.category = null;
    currentVideoMetadata.title = null;
    currentVideoMetadata.author = null;
    currentVideoMetadata.musicVideoType = null;
    checkPlaylistContext();
  }

  function onVideoSeeking() {
    macroRmsHistory.length = 0;
    consecutiveQuietFrames = 0;
    if (pipeline && audioCtx) {
      pipeline.noiseGateGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.02);
    }
  }

  /**
   * 建立並掛載純淨抗噪 Web Audio API 音訊管線
   */
  function setupAudioPipeline(videoElement) {
    if (!videoElement) return;
    if (connectedVideo === videoElement && currentSourceNode) return;

    try {
      if (!audioCtx) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioCtxClass();
      }

      const p = initAudioPipeline(audioCtx);

      // 如果先前已連接其他 video，先斷開舊 sourceNode 的連接，避免音訊重疊與洩漏
      if (currentSourceNode) {
        try {
          currentSourceNode.disconnect();
        } catch {}
      }

      // 取得或建立該 videoElement 的 MediaElementSourceNode (單一媒體標籤僅允許建立一次)
      let sourceNode = videoElement.__ytNormalizerSource;
      if (!sourceNode) {
        sourceNode = audioCtx.createMediaElementSource(videoElement);
        videoElement.__ytNormalizerSource = sourceNode;
      }

      // 連接新的 sourceNode 到管線：
      // 1. 探測通道
      sourceNode.connect(p.inputAnalyser);
      // 2. 旁路通道 (停用時輸出)
      sourceNode.connect(p.dryGain);
      // 3. 處理通道 (啟用時輸出)
      sourceNode.connect(p.macroGain);

      currentSourceNode = sourceNode;
      connectedVideo = videoElement;

      // 監聽媒體狀態事件
      videoElement.addEventListener('loadstart', resetVideoLoudnessState);
      videoElement.addEventListener('emptied', resetVideoLoudnessState);
      videoElement.addEventListener('seeking', onVideoSeeking);

      const wakeAudioCtx = () => {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().then(() => {
            updateAudioParameters();
          });
        }
        consecutiveQuietFrames = 0;
        if (p && audioCtx) {
          p.noiseGateGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.02);
        }
      };
      videoElement.addEventListener('play', wakeAudioCtx);
      videoElement.addEventListener('playing', wakeAudioCtx);
      document.addEventListener('click', wakeAudioCtx, { passive: true });
      document.addEventListener('keydown', wakeAudioCtx, { passive: true });
      wakeAudioCtx();

      updateAudioParameters();
      startMacroLoudnessLoop();

      console.log('[YT Normalizer v1.4.0] 純淨抗噪零破音引擎已啟動。');
    } catch (e) {
      console.warn('[YT Normalizer] 管線掛載提示:', e);
    }
  }

  /**
   * 宏觀平穩積分循環 (含智慧抗底噪門限與 0.35dB 防抖死區)
   */
  function startMacroLoudnessLoop() {
    if (macroMonitorLoopId) clearInterval(macroMonitorLoopId);

    const inBuf = new Float32Array(pipeline ? pipeline.inputAnalyser.fftSize : 2048);
    const outBuf = new Float32Array(pipeline ? pipeline.outputAnalyser.fftSize : 512);

    macroMonitorLoopId = setInterval(() => {
      if (!audioCtx || !pipeline || !connectedVideo) return;

      const isMutedOrPaused = connectedVideo.paused || connectedVideo.muted || connectedVideo.playbackRate === 0;
      if (isMutedOrPaused) {
        currentOutputVu *= 0.8;
        currentOutputPeak *= 0.85;
        currentStatusMode = 'idle';
        broadcastStatus(isMutedOrPaused);
        return;
      }

      // 1. 取樣未延遲的輸入訊號
      pipeline.inputAnalyser.getFloatTimeDomainData(inBuf);
      let sumSq = 0;
      for (let i = 0; i < inBuf.length; i++) {
        const s = inBuf[i];
        sumSq += s * s;
      }
      const frameRms = Math.sqrt(sumSq / inBuf.length);
      const frameDb = 20 * Math.log10(Math.max(frameRms, 0.000001));

      // 2. 智慧抗底噪門限判定 (Noise Floor Threshold: -46.0 dBFS)
      // 在對話間歇或純環境雜音時，啟動向下擴展，絕不盲目拉高噪訊
      const NOISE_FLOOR_DB = -46.0;
      const isSignalActive = frameDb > NOISE_FLOOR_DB;

      if (isSignalActive) {
        consecutiveQuietFrames = 0;
        macroRmsHistory.push(frameRms);
        if (macroRmsHistory.length > MACRO_WINDOW_SIZE) {
          macroRmsHistory.shift();
        }
        // 人聲或音樂活躍，降噪閘門平滑維持 1.0 (全頻段無衰減)
        pipeline.noiseGateGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.03);
      } else {
        consecutiveQuietFrames++;
        // 連續 3 幀 (150ms) 低於門限，判定為對話間歇或純背景底噪
        if (consecutiveQuietFrames >= 3) {
          // 向下擴展溫和衰減 -8dB (0.4x)，徹底杜絕「嘶嘶沙沙」抽吸喘息聲
          pipeline.noiseGateGain.gain.setTargetAtTime(0.4, audioCtx.currentTime, 0.08);
        }
      }

      // 3. 廣播級連續動態 AGC (僅在有效訊號累積充足且非安靜段落時微調，凍結底噪追逐)
      if (currentSettings.enabled && macroRmsHistory.length >= 8 && isSignalActive) {
        let histSum = 0;
        for (let i = 0; i < macroRmsHistory.length; i++) {
          histSum += macroRmsHistory[i] * macroRmsHistory[i];
        }
        const integratedRms = Math.sqrt(histSum / macroRmsHistory.length);
        const inputDb = 20 * Math.log10(Math.max(integratedRms, 0.000001));

        // 基準期望值設定為 -21.0 dBFS (進入 Leveler 最佳線性工作點)
        const diffDb = -21.0 - inputDb;
        // 安全增益邊界：拉高上限嚴格限制在 +12.0dB (防底噪暴增)，壓低至 -18.0dB (防耳膜受損)
        const clampedDiff = Math.min(12.0, Math.max(-18.0, diffDb));

        // 0.35dB 滯後死區 (Hysteresis Deadband)：微小音量波動不反覆觸發自動化，消除拉鍊噪音
        if (Math.abs(clampedDiff - lastAppliedTargetDb) > 0.35) {
          lastAppliedTargetDb = clampedDiff;

          let slewSpeed = 0.20;
          let slewTime = 0.8;
          if (currentSettings.rangeTightness === 'strict') {
            slewSpeed = 0.30;
            slewTime = 0.5;
          } else if (currentSettings.rangeTightness === 'wide') {
            slewSpeed = 0.10;
            slewTime = 1.5;
          }

          currentAppliedOffsetDb = currentAppliedOffsetDb * (1.0 - slewSpeed) + clampedDiff * slewSpeed;
          const targetMacro = Math.pow(10, currentAppliedOffsetDb / 20);
          pipeline.macroGain.gain.setTargetAtTime(targetMacro, audioCtx.currentTime, slewTime);
        }
      }

      // 4. 狀態標記
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

      // 5. 測量最終耳機輸出量表 (經零溢出軟削頂後之絕對安全輸出)
      pipeline.outputAnalyser.getFloatTimeDomainData(outBuf);
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

      const vuPercent = Math.min(100, Math.max(0, Math.round((outDb + 42) * 2.5)));
      currentOutputVu = currentOutputVu * 0.3 + vuPercent * 0.7;

      if (outPeak > currentOutputPeak) {
        currentOutputPeak = outPeak;
      } else {
        currentOutputPeak *= 0.94;
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
    const currentTargetDb = -20.0 + ((currentSettings.targetVolume - 50) / 50) * 10.0;

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
      hasLookahead: false,
      hasSoftClipper: true,
      hasNoiseGate: true,
      officialLoudness: ytOfficialLoudnessDb !== null ? `${ytOfficialLoudnessDb.toFixed(1)} dB` : null,
      isPlaylist: playlistStats.isPlaylist,
      playlistCount: playlistStats.itemCount,
      playedCount: playlistStats.playedCount,
      playlistId: playlistStats.listId || '',
      isWhitelistPlaylist: Boolean(
        playlistStats.listId &&
        Array.isArray(currentSettings.shuffleWhitelist) &&
        currentSettings.shuffleWhitelist.includes(playlistStats.listId)
      ),
      isTrueShuffle: isTrueShuffleEnabled,
      isAutoShuffle: autoEnabledByWhitelist,
      isMusicMode: Boolean(currentSettings.musicMode),
      lockedQuality: currentSettings.lockedQuality || 'auto',
      playbackSpeed: currentSettings.playbackSpeed || 2.0,
      isMusicDetected: currentVideoIsMusic,
      smartSpeedEnabled: Boolean(currentSettings.smartSpeedEnabled),
      musicSpeed: currentSettings.musicSpeed || 1.0,
      videoSpeed: currentSettings.videoSpeed || 2.0,
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
    const v = params.get('v');
    if (v) return v;
    const match = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }


  /**
   * 檢查當前清單是否在白名單中，若是則自動啟用真隨機；若離開則自動還原關閉
   */
  function checkAndApplyWhitelistShuffle(listId) {
    const whitelist = Array.isArray(currentSettings.shuffleWhitelist) ? currentSettings.shuffleWhitelist : [];
    const isWhitelisted = Boolean(listId && whitelist.includes(listId));

    if (isWhitelisted) {
      if (!isTrueShuffleEnabled) {
        console.log(`[YT True Shuffle] 🎯 命中白名單播放清單 (${listId})，自動開啟真隨機！`);
        isTrueShuffleEnabled = true;
        autoEnabledByWhitelist = true;
        if (chrome.storage && chrome.storage.session) {
          chrome.storage.session.set({ trueShuffle: true });
        }
      }
    } else {
      // 若先前為白名單自動接管，離開白名單清單時自動還原為關閉
      if (autoEnabledByWhitelist && isTrueShuffleEnabled) {
        console.log(`[YT True Shuffle] 離開白名單播放清單，自動還原關閉真隨機。`);
        isTrueShuffleEnabled = false;
        autoEnabledByWhitelist = false;
        if (chrome.storage && chrome.storage.session) {
          chrome.storage.session.set({ trueShuffle: false });
        }
      }
    }
  }

  function checkPlaylistContext() {
    const listId = getPlaylistIdFromUrl();
    if (listId !== currentPlaylistId) {
      currentPlaylistId = listId;
      playedVideoIds.clear();
      const currentV = getCurrentVideoIdFromUrl();
      if (currentV) playedVideoIds.add(currentV);
    }
    checkAndApplyWhitelistShuffle(listId);
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

  /* ==========================================================================
     純聽音樂模式 (Music Mode) 畫面遮擋、快捷鈕與省電防中斷核心
     ========================================================================== */

  function injectMusicModeStyles() {
    if (document.getElementById('yt-music-mode-styles')) return;
    const style = document.createElement('style');
    style.id = 'yt-music-mode-styles';
    style.textContent = `
      /* 全域純聽音樂模式：物理級強制遮擋影片、字幕與資訊卡，絕不漏光 */
      html.yt-music-mode-active video,
      html.yt-music-mode-active .html5-video-container video,
      html.yt-music-mode-active .ytp-caption-window-container,
      html.yt-music-mode-active .caption-window,
      html.yt-music-mode-active .ytp-ce-element,
      html.yt-music-mode-active .ytp-cards-teaser,
      html.yt-music-mode-active .ytp-paid-content-overlay,
      #movie_player.yt-music-mode-active video,
      #movie_player.yt-music-mode-active .html5-video-container video,
      #movie_player.yt-music-mode-active .ytp-caption-window-container,
      #movie_player.yt-music-mode-active .caption-window,
      #movie_player.yt-music-mode-active .ytp-ce-element,
      #movie_player.yt-music-mode-active .ytp-cards-teaser,
      #movie_player.yt-music-mode-active .ytp-paid-content-overlay {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      #movie_player.yt-music-mode-active {
        background: #08080c !important;
      }

      /* YouTube 純聽音樂高層級沉浸遮罩 (z-index 58 位於底欄 60 之下，所有影片與字幕之上) */
      .yt-music-mode-overlay {
        position: absolute !important;
        top: 0 !important;
        left: 0 !important;
        width: 100% !important;
        height: 100% !important;
        z-index: 58 !important;
        background: radial-gradient(circle at center, #181924 0%, #08080c 100%) !important;
        display: none;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        pointer-events: auto;
        user-select: none;
        transition: opacity 0.3s ease;
      }

      .yt-music-mode-overlay.active {
        display: flex !important;
      }

      /* 確保 YouTube 底部控制列依然置頂可操作 */
      .html5-video-player .ytp-chrome-bottom {
        z-index: 60 !important;
      }
      .html5-video-player .ytp-gradient-bottom {
        z-index: 59 !important;
      }

      .yt-music-mode-card {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        max-width: 82%;
        padding: 32px 36px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 20px;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .yt-music-mode-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.8);
      }

      .yt-music-mode-visual {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-bottom: 18px;
      }

      .yt-music-mode-disc {
        width: 54px;
        height: 54px;
        border-radius: 50%;
        background: linear-gradient(135deg, #ff0033 0%, #b91c1c 100%);
        display: flex;
        align-items: center;
        justify-content: center;
        color: #ffffff;
        box-shadow: 0 0 24px rgba(255, 0, 51, 0.45);
      }

      .yt-music-mode-disc svg {
        width: 28px;
        height: 28px;
      }

      .yt-music-mode-bars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 28px;
      }

      .yt-music-mode-bars .bar {
        width: 4px;
        border-radius: 2px;
        background: #ff0033;
        animation: ytMusicBarWave 1.2s ease-in-out infinite alternate;
      }

      .yt-music-mode-bars .bar:nth-child(1) { height: 12px; animation-delay: 0.1s; }
      .yt-music-mode-bars .bar:nth-child(2) { height: 26px; animation-delay: 0.3s; }
      .yt-music-mode-bars .bar:nth-child(3) { height: 18px; animation-delay: 0.2s; }
      .yt-music-mode-bars .bar:nth-child(4) { height: 28px; animation-delay: 0.45s; }
      .yt-music-mode-bars .bar:nth-child(5) { height: 15px; animation-delay: 0.15s; }

      @keyframes ytMusicBarWave {
        0% { transform: scaleY(0.25); opacity: 0.5; }
        100% { transform: scaleY(1); opacity: 1; }
      }

      .yt-music-mode-title {
        font-family: 'PingFang TC', 'Microsoft JhengHei', Roboto, -apple-system, sans-serif;
        font-size: 20px;
        font-weight: 700;
        color: #ffffff;
        margin-bottom: 6px;
        line-height: 1.35;
        max-width: 580px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
      }

      .yt-music-mode-channel {
        font-family: 'PingFang TC', 'Microsoft JhengHei', Roboto, -apple-system, sans-serif;
        font-size: 14px;
        color: #a1a1aa;
        margin-bottom: 16px;
      }

      .yt-music-mode-tags {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .yt-music-mode-badge {
        font-size: 11px;
        font-weight: 600;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.12);
        border: 1px solid rgba(56, 189, 248, 0.25);
        padding: 3px 10px;
        border-radius: 9999px;
        letter-spacing: 0.3px;
      }

      .yt-music-mode-hint {
        font-size: 11px;
        color: #71717a;
      }

      /* 控制列按鈕 */
      .ytp-music-mode-btn {
        width: 44px !important;
        min-width: 44px !important;
        height: 100% !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        cursor: pointer !important;
        position: relative;
        text-align: center;
        vertical-align: top;
      }

      .ytp-music-mode-btn svg {
        width: 22px !important;
        height: 22px !important;
        fill: #eeeeee;
        transition: fill 0.2s ease, filter 0.2s ease, transform 0.15s ease;
      }

      .ytp-music-mode-btn:hover svg {
        fill: #ffffff;
        transform: scale(1.1);
      }

      .ytp-music-mode-btn.active svg {
        fill: #ff0033 !important;
        filter: drop-shadow(0 0 6px rgba(255, 0, 51, 0.7));
      }

      /* 播放器速度快捷按鈕 */
      .ytp-speed-btn {
        position: relative;
        text-align: center;
        vertical-align: top;
        font-family: 'Roboto', 'YouTube Noto', sans-serif;
        display: inline-flex !important;
        align-items: center;
        justify-content: center;
        min-width: 44px;
      }

      .ytp-speed-badge {
        font-size: 11.5px;
        font-weight: 700;
        color: #eeeeee;
        background: rgba(255, 255, 255, 0.12);
        padding: 2px 6px;
        border-radius: 4px;
        transition: all 0.2s ease;
        line-height: 1.1;
      }

      .ytp-speed-btn:hover .ytp-speed-badge {
        background: rgba(255, 255, 255, 0.22);
        color: #ffffff;
        transform: scale(1.08);
      }

      .ytp-speed-btn.speed-boosted .ytp-speed-badge {
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.2);
        border: 1px solid rgba(56, 189, 248, 0.35);
      }

      .ytp-speed-btn.speed-music .ytp-speed-badge {
        color: #c084fc;
        background: rgba(168, 85, 247, 0.22);
        border: 1px solid rgba(168, 85, 247, 0.45);
        box-shadow: 0 0 6px rgba(168, 85, 247, 0.4);
      }

      .ytp-speed-btn.speed-turbo .ytp-speed-badge {
        color: #ff0033;
        background: rgba(255, 0, 51, 0.25);
        border: 1px solid rgba(255, 0, 51, 0.5);
        box-shadow: 0 0 8px rgba(255, 0, 51, 0.5);
        animation: turboGlow 1.5s ease-in-out infinite alternate;
      }

      @keyframes turboGlow {
        0% { box-shadow: 0 0 6px rgba(255, 0, 51, 0.4); }
        100% { box-shadow: 0 0 12px rgba(255, 0, 51, 0.8); }
      }
    `;
    const target = document.head || document.documentElement;
    if (target) {
      target.appendChild(style);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.head || document.documentElement).appendChild(style);
      });
    }
  }

  function ensureMusicModeUi() {
    injectMusicModeStyles();

    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!player) return;

    // 1. 確保遮罩存在
    let overlay = document.getElementById('yt-music-mode-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'yt-music-mode-overlay';
      overlay.className = 'yt-music-mode-overlay';
      overlay.innerHTML = `
        <div class="yt-music-mode-card" id="yt-music-mode-card">
          <div class="yt-music-mode-visual">
            <div class="yt-music-mode-disc">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h6V3h-8z"/>
              </svg>
            </div>
            <div class="yt-music-mode-bars">
              <span class="bar"></span>
              <span class="bar"></span>
              <span class="bar"></span>
              <span class="bar"></span>
              <span class="bar"></span>
            </div>
          </div>
          <div class="yt-music-mode-title" id="yt-music-mode-title">純聽音樂模式</div>
          <div class="yt-music-mode-channel" id="yt-music-mode-channel">YouTube 音量鎖定與純音模式</div>
          <div class="yt-music-mode-tags">
            <span class="yt-music-mode-badge">🎵 畫面已遮擋・省電降溫</span>
            <span class="yt-music-mode-hint">按 Shift+M 或點擊右下角按鈕切換</span>
          </div>
        </div>
      `;

      // 點擊遮罩空白處支援播放/暫停
      overlay.addEventListener('click', (e) => {
        if (e.target.closest('#yt-music-mode-card')) {
          return;
        }
        const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
        if (video) {
          if (video.paused) video.play();
          else video.pause();
        }
      });

      player.appendChild(overlay);
    }

    // 2. 確保播放器控制列按鈕存在
    const rightControls = player.querySelector('.ytp-right-controls');
    if (rightControls && !document.getElementById('ytp-music-mode-btn')) {
      const btn = document.createElement('button');
      btn.id = 'ytp-music-mode-btn';
      btn.className = 'ytp-button ytp-music-mode-btn';
      btn.setAttribute('title', '純聽音樂模式 (遮擋畫面) (Shift+M)');
      btn.setAttribute('aria-label', '純聽音樂模式');
      btn.innerHTML = `
        <svg height="100%" version="1.1" viewBox="0 0 36 36" width="100%">
          <path class="ytp-svg-fill" d="M15 13v10.18c-.61-.35-1.3-.56-2.03-.56-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V17h8v6.18c-.61-.35-1.3-.56-2.03-.56-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V13h-12z"></path>
        </svg>
      `;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = !currentSettings.musicMode;
        applyMusicMode(next);
        chrome.storage.local.set({ musicMode: next });
      });

      // 插入於設定齒輪前
      const settingsBtn = rightControls.querySelector('.ytp-settings-button') || rightControls.firstChild;
      rightControls.insertBefore(btn, settingsBtn);
    }

    updateMusicModeVisualState(currentSettings.musicMode);
  }

  function updateMusicModeMetadata() {
    const titleEl = document.getElementById('yt-music-mode-title');
    const channelEl = document.getElementById('yt-music-mode-channel');
    if (!titleEl || !channelEl) return;

    const docTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent ||
                     document.querySelector('.title.ytd-video-primary-info-renderer')?.textContent ||
                     document.title.replace(' - YouTube', '');
    const docChannel = document.querySelector('#owner #channel-name a')?.textContent ||
                       document.querySelector('ytd-channel-name a')?.textContent || '';

    if (docTitle && docTitle.trim()) {
      titleEl.textContent = docTitle.trim();
    }
    if (docChannel && docChannel.trim()) {
      channelEl.textContent = docChannel.trim();
    }
  }

  function updateMusicModeVisualState(enabled) {
    const overlay = document.getElementById('yt-music-mode-overlay');
    const btn = document.getElementById('ytp-music-mode-btn');
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');

    if (enabled) {
      document.documentElement.classList.add('yt-music-mode-active');
      if (player) player.classList.add('yt-music-mode-active');
      if (overlay) {
        overlay.classList.add('active');
        updateMusicModeMetadata();
      }
      if (btn) {
        btn.classList.add('active');
        btn.setAttribute('title', '關閉純聽音樂 (恢復畫面) (Shift+M)');
      }
      if (video) {
        video.style.opacity = '0';
      }
      // 送出 144p 節能節流訊息給 page_bridge.js
      window.postMessage({ type: 'YT_NORMALIZER_SET_QUALITY', quality: 'small' }, '*');
    } else {
      document.documentElement.classList.remove('yt-music-mode-active');
      if (player) player.classList.remove('yt-music-mode-active');
      if (overlay) {
        overlay.classList.remove('active');
      }
      if (btn) {
        btn.classList.remove('active');
        btn.setAttribute('title', '純聽音樂模式 (遮擋畫面) (Shift+M)');
      }
      if (video) {
        video.style.opacity = '1';
      }
      // 恢復原本設定之畫質
      applyLockedQuality(currentSettings.lockedQuality);
    }
  }

  function applyMusicMode(enabled) {
    currentSettings.musicMode = Boolean(enabled);
    ensureMusicModeUi();
    updateMusicModeVisualState(currentSettings.musicMode);
  }

  /* ==========================================================================
     固定畫質 (Lock Quality) ＆ 3倍速播放控制 (Speed Control)
     ========================================================================== */

  const SPEED_LEVELS = [1.0, 1.5, 2.0, 3.0];

  function applyLockedQuality(quality) {
    currentSettings.lockedQuality = quality || 'auto';
    if (currentSettings.musicMode) return; // 純聽音樂模式中維持 144p 節省 GPU
    window.postMessage({ type: 'YT_NORMALIZER_LOCK_QUALITY', quality: currentSettings.lockedQuality }, '*');
  }

  /**
   * 多層級智慧音樂歌曲檢測 (Smart Music Detector)
   */
  function evaluateIsMusicVideo() {
    // 1. 純聽音樂模式開啟中
    if (currentSettings.musicMode) {
      return { isMusic: true, reason: '純聽音樂模式' };
    }

    // 2. 白名單歌單或 YouTube 官方音樂清單 (OLAK5uy, RDMM, RD, LM)
    const listId = getPlaylistIdFromUrl();
    if (listId) {
      if (Array.isArray(currentSettings.shuffleWhitelist) && currentSettings.shuffleWhitelist.includes(listId)) {
        return { isMusic: true, reason: `白名單歌單 (${listId})` };
      }
      if (listId.startsWith('OLAK5uy_') || listId.startsWith('RDMM') || listId.startsWith('RD') || listId === 'LM') {
        return { isMusic: true, reason: `官方音樂合輯/專輯清單 (${listId})` };
      }
    }

    // 3. 官方分類元數據 Category === 'Music' (最高信度官方標註)
    const category = currentVideoMetadata.category || '';
    if (category && category.toLowerCase() === 'music') {
      return { isMusic: true, reason: '官方分類標籤：Music' };
    }

    // 4. 官方音樂影片類型 (MUSIC_VIDEO_TYPE_OMV / ATV / UGC 等)
    const mType = currentVideoMetadata.musicVideoType || '';
    if (mType && String(mType).toUpperCase().includes('MUSIC')) {
      return { isMusic: true, reason: `官方音樂類型：${mType}` };
    }

    // 5. YouTube 官方 Topic 音樂頻道 (例如 "Artist - Topic")
    const domAuthor = document.querySelector('ytd-channel-name a, #channel-name a')?.textContent?.trim() || '';
    const author = currentVideoMetadata.author || domAuthor;
    if (author.endsWith(' - Topic') || author.endsWith('- Topic')) {
      return { isMusic: true, reason: `官方主題音樂頻道 (${author})` };
    }

    // 6. 官方音樂人徽章 (Musical Note Badge / Verified Artist)
    const artistBadge = document.querySelector(
      'ytd-channel-name yt-icon[title*="音樂"], ytd-channel-name yt-icon[aria-label*="音樂"], ' +
      'ytd-channel-name yt-icon[aria-label*="Artist"], ytd-channel-name yt-icon[title*="Artist"], ' +
      'ytd-channel-name .badge-style-type-verified-artist'
    );
    if (artistBadge) {
      return { isMusic: true, reason: '官方音樂人認證標章' };
    }

    // 7. 說明欄官方音樂版權結構化資訊 (Music in this video / 歌曲 / 演出者)
    const structuredDesc = document.querySelector(
      'ytd-structured-description-content-renderer, ytd-metadata-row-container-renderer'
    );
    if (structuredDesc) {
      const descText = structuredDesc.textContent || '';
      if (
        descText.includes('Music in this video') ||
        descText.includes('這部影片中的音樂') ||
        (descText.includes('歌曲') && descText.includes('演出者'))
      ) {
        return { isMusic: true, reason: '說明欄包含官方版權音樂資訊' };
      }
    }

    // 8. 影片標題強特徵規則 (MV / Official Music Video / Official Audio 等)
    const domTitle = document.querySelector('h1.ytd-watch-metadata, h1.title')?.textContent?.trim() || document.title || '';
    const title = currentVideoMetadata.title || domTitle;
    const musicTitlePatterns = [
      /\bofficial\s+(music\s+)?video\b/i,
      /\bofficial\s+audio\b/i,
      /\bofficial\s+lyric\s+video\b/i,
      /\blyric(s)?\s+video\b/i,
      /\b(mv|m\/v)\b/i,
      /\b(feat\.|ft\.)\b/i,
      /\b(remix|instrumental|ost|soundtrack|bgm)\b/i,
      /「.*」\s*(official\s+video|mv)/i,
      /【.*】\s*(official\s+video|mv|動畫MV|音樂錄影帶)/i,
    ];
    if (musicTitlePatterns.some((pattern) => pattern.test(title))) {
      return { isMusic: true, reason: '標題命中音樂關鍵字特徵' };
    }

    return { isMusic: false, reason: '一般影片' };
  }

  /**
   * 智慧評估並套用倍速 (聽歌 1.0x，看片 2.0x)
   */
  function evaluateAndApplySmartSpeed(isUserAction = false) {
    const currentVid = getCurrentVideoIdFromUrl();

    // 若換片了，清除舊影片的手動覆蓋
    if (currentVid && currentVid !== lastEvaluatedVideoId) {
      manualSpeedOverriddenVideoId = null;
      lastEvaluatedVideoId = currentVid;
    }

    const evaluation = evaluateIsMusicVideo();
    currentVideoIsMusic = evaluation.isMusic;

    // 若未開啟智慧調速，直接套用全域 playbackSpeed
    if (!currentSettings.smartSpeedEnabled) {
      applyPlaybackSpeed(currentSettings.playbackSpeed || 2.0);
      return;
    }

    // 若目前影片已被使用者手動指定過速度，且非主動重置，則尊重使用者的手動選擇
    if (manualSpeedOverriddenVideoId === currentVid && !isUserAction) {
      return;
    }

    // 根據音樂或一般影片自動切換速度 (音樂預設 1.0x，一般預設 2.0x)
    const targetSpeed = currentVideoIsMusic
      ? (parseFloat(currentSettings.musicSpeed) || 1.0)
      : (parseFloat(currentSettings.videoSpeed) || 2.0);

    console.log(`[YT Smart Speed] 評估結果: ${currentVideoIsMusic ? '🎵 音樂歌曲' : '🎬 一般影片'} (${evaluation.reason}) ➔ 自動套用速度: ${targetSpeed}x`);

    applyPlaybackSpeed(targetSpeed);
  }

  function applyPlaybackSpeed(speed) {
    const num = parseFloat(speed) || 1.0;
    currentSettings.playbackSpeed = num;
    window.postMessage({ type: 'YT_NORMALIZER_SET_SPEED', speed: num }, '*');
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video) {
      video.playbackRate = num;
    }
    updateSpeedButtonDisplay(num);
  }

  function cyclePlaybackSpeed() {
    manualSpeedOverriddenVideoId = getCurrentVideoIdFromUrl(); // 使用者主動點擊，鎖定當前影片手動速度
    const cur = parseFloat(currentSettings.playbackSpeed) || 1.0;
    let idx = SPEED_LEVELS.indexOf(cur);
    if (idx === -1) idx = 0;
    const nextIdx = (idx + 1) % SPEED_LEVELS.length;
    const nextSpeed = SPEED_LEVELS[nextIdx];
    applyPlaybackSpeed(nextSpeed);
    chrome.storage.local.set({ playbackSpeed: nextSpeed });
  }

  function updateSpeedButtonDisplay(speed) {
    const badge = document.getElementById('ytp-speed-badge');
    const btn = document.getElementById('ytp-speed-btn');
    const num = parseFloat(speed) || 1.0;

    if (badge) {
      if (currentVideoIsMusic) {
        badge.textContent = `🎵${num.toFixed(1)}x`;
      } else if (num === 3.0) {
        badge.textContent = '⚡3.0x';
      } else if (num > 1.0) {
        badge.textContent = `⚡${num.toFixed(1)}x`;
      } else {
        badge.textContent = `${num.toFixed(1)}x`;
      }
    }

    if (btn) {
      btn.className = 'ytp-button ytp-speed-btn';
      if (currentVideoIsMusic) {
        btn.classList.add('speed-music');
        btn.title = `智慧調速：已識別為音樂歌曲 (${num.toFixed(1)}x 原速) · 點擊切換倍速`;
      } else if (num === 3.0) {
        btn.classList.add('speed-turbo');
        btn.title = `智慧調速：一般影片 (⚡3.0x 暴衝速) · 點擊切換倍速`;
      } else if (num > 1.0) {
        btn.classList.add('speed-boosted');
        btn.title = `智慧調速：一般影片 (${num.toFixed(1)}x 倍速) · 點擊切換倍速`;
      } else {
        btn.title = `智慧調速：一般影片 (1.0x) · 點擊切換倍速`;
      }
    }
  }

  function ensurePlayerSpeedButton() {
    const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
    if (!player) return;
    const rightControls = player.querySelector('.ytp-right-controls');
    if (!rightControls) return;

    let btn = document.getElementById('ytp-speed-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'ytp-speed-btn';
      btn.className = 'ytp-button ytp-speed-btn';
      btn.setAttribute('title', '播放速度：點擊循環切換 (1.0x / 1.5x / 2.0x / 3.0x) [Shift+S / Shift+3]');
      btn.setAttribute('aria-label', '播放速度');
      btn.innerHTML = `<span class="ytp-speed-badge" id="ytp-speed-badge">1.0x</span>`;

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cyclePlaybackSpeed();
      });

      const musicBtn = document.getElementById('ytp-music-mode-btn');
      const settingsBtn = rightControls.querySelector('.ytp-settings-button');
      if (musicBtn && musicBtn.nextSibling) {
        rightControls.insertBefore(btn, musicBtn.nextSibling);
      } else if (settingsBtn) {
        rightControls.insertBefore(btn, settingsBtn);
      } else {
        rightControls.appendChild(btn);
      }
    }

    updateSpeedButtonDisplay(currentSettings.playbackSpeed || 1.0);
  }

  // 監聽鍵盤快捷鍵 (Shift+M / Shift+S / Shift+3)
  document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    
    // Shift+M: 純聽音樂模式切換
    if (e.shiftKey && (e.key === 'M' || e.key === 'm')) {
      e.preventDefault();
      const next = !currentSettings.musicMode;
      applyMusicMode(next);
      chrome.storage.local.set({ musicMode: next });
    }
    // Shift+S: 播放速度循環切換 (1.0x -> 1.5x -> 2.0x -> 3.0x)
    else if (e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      manualSpeedOverriddenVideoId = getCurrentVideoIdFromUrl();
      cyclePlaybackSpeed();
    }
    // Shift+3: 一鍵直達 3.0x (再次按下還原 1.0x)
    else if (e.shiftKey && (e.key === '3' || e.key === '#')) {
      e.preventDefault();
      manualSpeedOverriddenVideoId = getCurrentVideoIdFromUrl();
      const cur = parseFloat(currentSettings.playbackSpeed) || 1.0;
      const target = cur === 3.0 ? 1.0 : 3.0;
      applyPlaybackSpeed(target);
      chrome.storage.local.set({ playbackSpeed: target });
    }
  });

  // 多分頁切換時同步情境倍速 (Tab Context Re-synchronization)
  function onTabContextSynchronize() {
    if (document.visibilityState === 'hidden') return;

    // 重新評估當前分頁影片內容情境 (音樂 1.0x / 影片 2.0x / 手動覆蓋) 並套用
    evaluateAndApplySmartSpeed();

    // 確保底欄速度膠囊按鈕存在且顯示正確
    ensurePlayerSpeedButton();

    // 當前作用中分頁將自身速度記錄至 storage 供 Popup 即時讀取
    if (document.visibilityState === 'visible' && currentSettings.playbackSpeed) {
      chrome.storage.local.set({ playbackSpeed: currentSettings.playbackSpeed });
    }

    // 立即向 Popup 推送一幀狀態更新
    broadcastStatus(false);
  }

  // 監聽分頁可見度切換事件 (Tab Switch)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      onTabContextSynchronize();
    }
  });

  // 監聽視窗聚焦事件 (Window Focus)
  window.addEventListener('focus', () => {
    onTabContextSynchronize();
  });

  // 自動防速度被 YouTube 重設 (防廣告或 SPA 偷改，全速域精確守護)
  document.addEventListener('ratechange', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') {
      const expected = parseFloat(currentSettings.playbackSpeed) || 1.0;
      if (Math.abs(e.target.playbackRate - expected) > 0.05) {
        setTimeout(() => {
          if (e.target && !e.target.paused) {
            e.target.playbackRate = expected;
            window.postMessage({ type: 'YT_NORMALIZER_SET_SPEED', speed: expected }, '*');
          }
        }, 150);
      }
    }
  }, true);

  // 自動防中斷與純音自動跳廣告 Watchdog
  function startMusicModeWatchdog() {
    setInterval(() => {
      // 1. 自動跳過「影片已暫停。要繼續觀看嗎？」(Confirm Dialog)
      const confirmBtn = document.querySelector('yt-confirm-dialog-renderer button#confirm-button, yt-confirm-dialog-renderer .yt-spec-button-shape-next');
      if (confirmBtn && confirmBtn.offsetParent !== null) {
        console.log('[YT Normalizer] 自動跳過 YouTube 暫停中斷確認');
        confirmBtn.click();
      }

      // 2. 純音模式下自動跳過廣告 (Auto Skip Ads)
      if (currentSettings.musicMode) {
        const skipBtn = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern');
        if (skipBtn && skipBtn.offsetParent !== null) {
          skipBtn.click();
        }
        const adShowing = document.querySelector('.ad-showing, .ytp-ad-player-overlay');
        if (adShowing) {
          const video = document.querySelector('video.html5-main-video');
          if (video && !isNaN(video.duration) && video.duration > 0) {
            video.currentTime = video.duration;
          }
        }
      }
    }, 800);
  }

  function findAndHookVideo() {
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    if (video) {
      setupAudioPipeline(video);
      if (currentSettings.playbackSpeed && currentSettings.playbackSpeed !== 1.0) {
        video.playbackRate = currentSettings.playbackSpeed;
      }
    }
    ensureMusicModeUi();
    ensurePlayerSpeedButton();
    applyLockedQuality(currentSettings.lockedQuality);
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
    setTimeout(() => {
      findAndHookVideo();
      updateMusicModeMetadata();
      checkPlaylistContext();
      applyLockedQuality(currentSettings.lockedQuality);
      evaluateAndApplySmartSpeed();
    }, 150);
    setTimeout(() => evaluateAndApplySmartSpeed(), 600);
    setTimeout(() => evaluateAndApplySmartSpeed(), 1500);
  });
  window.addEventListener('popstate', () => {
    resetVideoLoudnessState();
    setTimeout(() => {
      findAndHookVideo();
      updateMusicModeMetadata();
      checkPlaylistContext();
      applyLockedQuality(currentSettings.lockedQuality);
      evaluateAndApplySmartSpeed();
    }, 150);
    setTimeout(() => evaluateAndApplySmartSpeed(), 600);
    setTimeout(() => evaluateAndApplySmartSpeed(), 1500);
  });

  document.addEventListener('play', (e) => {
    if (e.target && e.target.tagName === 'VIDEO') setupAudioPipeline(e.target);
  }, true);

  startMusicModeWatchdog();
  setInterval(findAndHookVideo, 1500);
})();
