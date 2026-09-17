/**
 * YouTube 音量範圍鎖定器 - Popup 邏輯
 * 即時顯示：太小自動調高、太大自動調低、落入設定範圍之三態視覺指示
 */

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    targetVolume: 100,
    rangeTightness: 'standard',
    mode: 'standard',
  };

  // DOM 元素
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
  const vuFill = document.getElementById('vu-fill');
  const vuPeak = document.getElementById('vu-peak');
  const vuTargetMarker = document.getElementById('vu-target-marker');
  
  const tightnessRadios = document.querySelectorAll('input[name="range-tightness"]');
  const modeRadios = document.querySelectorAll('input[name="normalizer-mode"]');

  let vuPort = null;

  // 1. 初始化讀取設定
  chrome.storage.local.get(DEFAULT_SETTINGS, (stored) => {
    const currentVolume = stored.targetVolume !== undefined ? stored.targetVolume : (stored.volume || 100);
    const settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      targetVolume: currentVolume,
    };
    applyUiState(settings);
    connectToActiveTab();
  });

  function applyUiState(settings) {
    toggleEnabled.checked = settings.enabled;
    targetSlider.value = settings.targetVolume;
    targetValDisplay.textContent = `${settings.targetVolume}%`;

    // 嚴格度單選
    const targetTightness = document.querySelector(`input[name="range-tightness"][value="${settings.rangeTightness}"]`);
    if (targetTightness) targetTightness.checked = true;

    // 模式單選
    const targetMode = document.querySelector(`input[name="normalizer-mode"][value="${settings.mode}"]`);
    if (targetMode) targetMode.checked = true;

    updateTargetMarkerPosition(settings.targetVolume, settings.rangeTightness);
    updateContainerDisabledState(settings.enabled);
  }

  function updateTargetMarkerPosition(volume, tightness) {
    // 依目標音量計算目標區間在量表上的位置
    // volume 0% -> 30%, 100% -> 66%, 150% -> 82%
    const norm = Math.min(150, Math.max(0, volume)) / 150;
    const center = 32 + norm * 50;

    let width = 20;
    if (tightness === 'strict') width = 12;
    else if (tightness === 'wide') width = 30;

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

  // 2. 主開關
  toggleEnabled.addEventListener('change', () => {
    const isEnabled = toggleEnabled.checked;
    chrome.storage.local.set({ enabled: isEnabled });
    updateContainerDisabledState(isEnabled);
  });

  // 3. 目標固定音量滑桿
  targetSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    targetValDisplay.textContent = `${val}%`;
    const tightness = document.querySelector('input[name="range-tightness"]:checked')?.value || 'standard';
    updateTargetMarkerPosition(val, tightness);
    chrome.storage.local.set({ targetVolume: val, volume: val });
  });

  // 4. 重設按鈕
  btnResetTarget.addEventListener('click', () => {
    targetSlider.value = 100;
    targetValDisplay.textContent = '100%';
    const tightness = document.querySelector('input[name="range-tightness"]:checked')?.value || 'standard';
    updateTargetMarkerPosition(100, tightness);
    chrome.storage.local.set({ targetVolume: 100, volume: 100 });
  });

  // 5. 嚴格度變更
  tightnessRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ rangeTightness: e.target.value });
        updateTargetMarkerPosition(parseInt(targetSlider.value, 10), e.target.value);
      }
    });
  });

  // 6. 等化風格變更
  modeRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ mode: e.target.value });
      }
    });
  });

  /**
   * 7. 連接 YouTube 分頁接收即時自動調節狀態
   */
  function connectToActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const activeTab = tabs[0];

      if (!activeTab.url || !activeTab.url.includes('youtube.com')) {
        lockStatusBadge.textContent = '非 YT 頁面';
        lockStatusBadge.classList.remove('active');
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

            // 更新三態指示列：太小調高 / 命中在範圍內 / 太大調低
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

            // VU 量表
            vuFill.style.width = `${msg.level}%`;
            vuPeak.style.left = `${msg.peak}%`;
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
