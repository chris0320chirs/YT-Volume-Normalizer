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

  // 預設設定
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetVolume: 100,        // 目標固定音量：0% ~ 150% (100% 標稱標準推薦)
    rangeTightness: 'strict', // 預設嚴格鎖定
    mode: 'standard',         // 'standard' (日常平衡) | 'vocal' (人聲強化) | 'music' (音樂原味)
  };

  // 廣播級等化風格與壓縮器矩陣 (經聲學抗破音抗失真最佳化)
  const LEVELER_CONFIGS = {
    standard: {
      threshold: -24.0,       // dBFS (最佳工作點)
      ratio: 10.0,            // 10:1 廣播平平整比，保留良好質感且不再互調失真
      knee: 18.0,             // 18dB 寬膝平滑過渡
      attack: 0.008,          // 8ms 瞬態平滑，杜絕低頻破音
      release: 0.38,          // 380ms 自然平滑釋放，杜絕喘息與底噪抽吸
      baseMakeupGainDb: 6.0,  // 基礎化妝增益，保留充足 Headroom 防破音
    },
    vocal: {
      threshold: -27.0,       // 更深捕獲微弱對話
      ratio: 12.0,
      knee: 16.0,
      attack: 0.006,
      release: 0.32,
      baseMakeupGainDb: 7.5,
    },
    music: {
      threshold: -20.0,
      ratio: 6.0,
      knee: 20.0,
      attack: 0.015,
      release: 0.45,
      baseMakeupGainDb: 4.5,
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
  let currentPlaylistId = null;
  const playedVideoIds = new Set();

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
      effectiveBaseMakeup += 1.5;
    } else if (currentSettings.rangeTightness === 'wide') {
      effectiveRatio = Math.max(4.0, cfg.ratio * 0.65);
      effectiveThreshold = cfg.threshold + 3.0;
      effectiveKnee = cfg.knee + 4.0;
      effectiveBaseMakeup -= 1.5;
    }

    pipeline.levelerCompressor.threshold.setValueAtTime(effectiveThreshold, now);
    pipeline.levelerCompressor.knee.setValueAtTime(effectiveKnee, now);
    pipeline.levelerCompressor.ratio.setValueAtTime(effectiveRatio, now);
    pipeline.levelerCompressor.attack.setValueAtTime(cfg.attack, now);
    pipeline.levelerCompressor.release.setValueAtTime(cfg.release, now);

    // 3. 使用者目標耳感化妝增益 (Target Makeup Gain)
    // 預設 100% 音量為標準 -14 ~ -16 LUFS 輸出，保留充裕 Headroom 防止破音
    const userFactor = currentSettings.targetVolume / 100; // 0.0 ~ 1.5
    if (currentSettings.targetVolume === 0) {
      pipeline.targetMakeupGain.gain.setTargetAtTime(0.0, now, 0.02);
    } else {
      const totalMakeupDb = effectiveBaseMakeup + (userFactor - 1.0) * 10.0;
      const linearMakeupGain = Math.max(0.001, Math.pow(10, totalMakeupDb / 20));
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
      hasLookahead: false,
      hasSoftClipper: true,
      hasNoiseGate: true,
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
    if (video) {
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
