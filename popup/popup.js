/**
 * YouTube 音量範圍鎖定器與真隨機 - Popup 邏輯
 * 處理：
 * 1. 音量等化與三態即時指示 (Local Storage 全域持久化)
 * 2. 播放清單真隨機開關 (Session Storage 單次工作階段有效，重啟 Chrome 自動還原為關閉)
 */

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_LOCAL_SETTINGS = {
    enabled: true,
    targetVolume: 50,
    rangeTightness: 'strict',
    mode: 'standard',
    volumeVersion: 2,
  };

  // DOM 元素引用
  const appContainer = document.querySelector('.app-container');
  const toggleEnabled = document.getElementById('toggle-enabled');
  const targetSlider = document.getElementById('target-slider');
  const targetValDisplay = document.getElementById('target-val-display');
  const btnResetTarget = document.getElementById('btn-reset-target');
  const lockStatusBadge = document.getElementById('lock-status-badge');
  
  const pillBoosting = document.getElementById('pill-boosting');
  const pillLocked = document.getElementById('pill-locked');
  const pillCutting = document.getElementById('pill-cutting');
  
  const compValueBadge = document.getElementById('comp-value-badge');
  const compDesc = document.getElementById('comp-desc');
  const officialLoudnessRow = document.getElementById('official-loudness-row');
  const officialLoudnessVal = document.getElementById('official-loudness-val');
  const vuFill = document.getElementById('vu-fill');
  const vuPeak = document.getElementById('vu-peak');
  const vuTargetMarker = document.getElementById('vu-target-marker');
  
  const tightnessRadios = document.querySelectorAll('input[name="range-tightness"]');
  const modeRadios = document.querySelectorAll('input[name="normalizer-mode"]');

  // 真隨機元素
  const toggleShuffle = document.getElementById('toggle-shuffle');
  const shufflePlaylistTag = document.getElementById('shuffle-playlist-tag');

  let vuPort = null;

  // 1. 初始化讀取 Local 設定 (音量等化，含 v2 50% 基準平滑遷移)
  chrome.storage.local.get(DEFAULT_LOCAL_SETTINGS, (stored) => {
    if (!stored.volumeVersion || stored.volumeVersion < 2) {
      stored.targetVolume = 50;
      stored.volumeVersion = 2;
      chrome.storage.local.set({ targetVolume: 50, volume: 50, volumeVersion: 2 });
    }
    const currentVolume = stored.targetVolume !== undefined ? stored.targetVolume : (stored.volume || 50);
    const settings = {
      ...DEFAULT_LOCAL_SETTINGS,
      ...stored,
      targetVolume: currentVolume,
    };
    applyUiState(settings);
    connectToActiveTab();
  });

  // 2. 初始化讀取 Session 設定 (真隨機 - 僅在此次瀏覽器工作階段有效，預設為關閉)
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get({ trueShuffle: false }, (stored) => {
      toggleShuffle.checked = Boolean(stored && stored.trueShuffle);
    });
  }

  function applyUiState(settings) {
    toggleEnabled.checked = settings.enabled;
    targetSlider.value = settings.targetVolume;
    targetValDisplay.textContent = `${settings.targetVolume}%`;

    const targetTightness = document.querySelector(`input[name="range-tightness"][value="${settings.rangeTightness}"]`);
    if (targetTightness) targetTightness.checked = true;

    const targetMode = document.querySelector(`input[name="normalizer-mode"][value="${settings.mode}"]`);
    if (targetMode) targetMode.checked = true;

    updateTargetMarkerPosition(settings.targetVolume, settings.rangeTightness);
    updateContainerDisabledState(settings.enabled);
  }

  function updateTargetMarkerPosition(volume, tightness) {
    const norm = Math.min(100, Math.max(0, volume)) / 100;
    const center = 28 + norm * 56;

    let width = 18;
    if (tightness === 'strict') width = 12;
    else if (tightness === 'wide') width = 28;

    const left = Math.max(0, Math.min(100 - width, center - (width / 2)));
    if (vuTargetMarker) {
      vuTargetMarker.style.left = `${left.toFixed(1)}%`;
      vuTargetMarker.style.width = `${width}%`;
    }
  }

  function updateContainerDisabledState(isEnabled) {
    if (isEnabled) {
      appContainer.classList.remove('is-disabled');
      lockStatusBadge.classList.remove('disabled');
      lockStatusBadge.textContent = '連線中...';
    } else {
      appContainer.classList.add('is-disabled');
      lockStatusBadge.classList.add('disabled');
      lockStatusBadge.textContent = '已停用';
      compValueBadge.textContent = '0.0 dB';
      compValueBadge.className = 'comp-value';
      compDesc.textContent = '功能已停用';
      clearPills();
      resetVuMeter();
    }
  }

  function clearPills() {
    pillBoosting.classList.remove('active-boost');
    pillLocked.classList.remove('active-locked');
    pillCutting.classList.remove('active-cut');
  }

  // 3. 音量主開關切換
  toggleEnabled.addEventListener('change', () => {
    const isEnabled = toggleEnabled.checked;
    chrome.storage.local.set({ enabled: isEnabled });
    updateContainerDisabledState(isEnabled);
  });

  // 4. 目標固定音量滑桿
  targetSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    targetValDisplay.textContent = `${val}%`;
    const tightness = document.querySelector('input[name="range-tightness"]:checked')?.value || 'standard';
    updateTargetMarkerPosition(val, tightness);
    chrome.storage.local.set({ targetVolume: val, volume: val });
  });

  // 5. 重設為 50% (剛剛好標準推薦)
  btnResetTarget.addEventListener('click', () => {
    targetSlider.value = 50;
    targetValDisplay.textContent = '50%';
    const tightness = document.querySelector('input[name="range-tightness"]:checked')?.value || 'standard';
    updateTargetMarkerPosition(50, tightness);
    chrome.storage.local.set({ targetVolume: 50, volume: 50, volumeVersion: 2 });
  });

  // 6. 嚴格度切換
  tightnessRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ rangeTightness: e.target.value });
        updateTargetMarkerPosition(parseInt(targetSlider.value, 10), e.target.value);
      }
    });
  });

  // 7. 等化風格模式切換
  modeRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ mode: e.target.value });
      }
    });
  });

  // 8. 播放清單真隨機開關 (Session Storage，關閉瀏覽器自動重設為關閉)
  toggleShuffle.addEventListener('change', () => {
    const isChecked = toggleShuffle.checked;

    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ trueShuffle: isChecked });
    }

    // 同步發送訊息至當前分頁即刻生效
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_TRUE_SHUFFLE',
          enabled: isChecked,
        }).catch(() => {});
      }
    });
  });

  /**
   * 8. 連接 YouTube 分頁接收即時自動調節狀態與清單偵測
   */
  function connectToActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const activeTab = tabs[0];

      if (!activeTab.url || !activeTab.url.includes('youtube.com')) {
        lockStatusBadge.textContent = '非 YT 頁面';
        lockStatusBadge.classList.remove('active');
        shufflePlaylistTag.textContent = '非 YouTube 頁面';
        return;
      }

      try {
        vuPort = chrome.tabs.connect(activeTab.id, { name: 'yt-volume-vu' });

        vuPort.onMessage.addListener((msg) => {
          if (msg.type === 'VU_DATA') {
            if (!toggleEnabled.checked) return;

            // 狀態徽章
            if (msg.isPlaying) {
              lockStatusBadge.textContent = '🟢 範圍鎖定運作中';
              lockStatusBadge.classList.add('active');
            } else {
              lockStatusBadge.textContent = '待命中 (暫停)';
              lockStatusBadge.classList.remove('active');
            }

            // 三態指示燈
            clearPills();
            if (msg.isPlaying) {
              if (msg.statusMode === 'boosting') {
                pillBoosting.classList.add('active-boost');
                compDesc.textContent = '太小聲，自動調高';
              } else if (msg.statusMode === 'cutting') {
                pillCutting.classList.add('active-cut');
                compDesc.textContent = '太大聲，自動調低';
              } else if (msg.statusMode === 'locked') {
                pillLocked.classList.add('active-locked');
                compDesc.textContent = '在您設定的範圍內';
              } else {
                compDesc.textContent = '分析音量中...';
              }
            } else {
              compDesc.textContent = '影片暫停中';
            }

            // 自動補償數值
            if (msg.offsetDb) {
              compValueBadge.textContent = msg.offsetDb;
              if (msg.rawOffset > 0.6) {
                compValueBadge.className = 'comp-value boost';
              } else if (msg.rawOffset < -0.6) {
                compValueBadge.className = 'comp-value cut';
              } else {
                compValueBadge.className = 'comp-value';
              }
            }

            // 官方預讀響度顯示
            if (msg.officialLoudness) {
              officialLoudnessRow.style.display = 'flex';
              officialLoudnessVal.textContent = msg.officialLoudness;
            } else {
              officialLoudnessRow.style.display = 'none';
            }

            // VU 量表
            vuFill.style.width = `${msg.level}%`;
            vuPeak.style.left = `${msg.peak}%`;

            // 真隨機播放清單狀態回饋
            if (msg.isPlaylist) {
              if (msg.isTrueShuffle) {
                shufflePlaylistTag.textContent = `🟢 真隨機運作中 (清單共 ${msg.playlistCount} 首)`;
                shufflePlaylistTag.classList.add('active');
              } else {
                shufflePlaylistTag.textContent = `已偵測清單 (共 ${msg.playlistCount} 首，尚未開啟)`;
                shufflePlaylistTag.classList.remove('active');
              }
            } else {
              shufflePlaylistTag.textContent = '未偵測到清單 (進入清單後生效)';
              shufflePlaylistTag.classList.remove('active');
            }
          }
        });

        vuPort.onDisconnect.addListener(() => {
          const err = chrome.runtime.lastError;
          vuPort = null;
          if (toggleEnabled.checked) {
            lockStatusBadge.textContent = err ? '請重新整理分頁' : '待命中';
            lockStatusBadge.classList.remove('active');
          }
          clearPills();
          resetVuMeter();
        });
      } catch (err) {
        console.warn('無法建立即時監聽 Port:', err);
      }
    });
  }

  function resetVuMeter() {
    vuFill.style.width = '0%';
    vuPeak.style.left = '0%';
  }
});
