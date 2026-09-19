/**
 * YouTube 音量鎖定 ＆ 純音模式 - Popup 邏輯
 * 依據 Design Craft 規範重構：精簡、直覺、響應迅速、零雜訊。
 * 支援固定畫質與 3 倍速快捷控制 (參考 YouTube Tweak malfbchbmmlhkjjbepjodfkmnbngckoi)
 */

document.addEventListener('DOMContentLoaded', () => {
  const DEFAULT_LOCAL_SETTINGS = {
    enabled: true,
    targetVolume: 50,
    rangeTightness: 'strict',
    mode: 'standard',
    musicMode: false,
    lockedQuality: 'auto',
    playbackSpeed: 1.0,
    volumeVersion: 2,
  };

  // DOM 元素引用
  const appContainer = document.querySelector('.app-container');
  const toggleEnabled = document.getElementById('toggle-enabled');
  const targetSlider = document.getElementById('target-slider');
  const targetValDisplay = document.getElementById('target-val-display');
  const btnResetTarget = document.getElementById('btn-reset-target');
  
  const statusPill = document.getElementById('status-pill');
  const statusText = document.getElementById('status-text');
  const compValueBadge = document.getElementById('comp-value-badge');
  const vuFill = document.getElementById('vu-fill');
  
  // 速度與畫質控制元素
  const speedButtons = document.querySelectorAll('.btn-speed');
  const selectQuality = document.getElementById('select-quality');

  const toggleMusicMode = document.getElementById('toggle-music-mode');
  const toggleShuffle = document.getElementById('toggle-shuffle');
  const shuffleStatusHint = document.getElementById('shuffle-status-hint');
  
  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedContent = document.getElementById('advanced-content');
  const tightnessRadios = document.querySelectorAll('input[name="range-tightness"]');
  const modeRadios = document.querySelectorAll('input[name="normalizer-mode"]');

  let vuPort = null;

  // 1. 初始化讀取 Local 設定 (含 v2 50% 基準平滑遷移)
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

  // 2. 初始化讀取 Session 設定 (真隨機)
  if (chrome.storage && chrome.storage.session) {
    chrome.storage.session.get({ trueShuffle: false }, (stored) => {
      toggleShuffle.checked = Boolean(stored && stored.trueShuffle);
    });
  }

  function applyUiState(settings) {
    toggleEnabled.checked = settings.enabled;
    targetSlider.value = settings.targetVolume;
    targetValDisplay.textContent = `${settings.targetVolume}%`;
    toggleMusicMode.checked = Boolean(settings.musicMode);

    if (selectQuality && settings.lockedQuality) {
      selectQuality.value = settings.lockedQuality;
    }

    updateSpeedButtonState(settings.playbackSpeed || 1.0);

    const targetTightness = document.querySelector(`input[name="range-tightness"][value="${settings.rangeTightness}"]`);
    if (targetTightness) targetTightness.checked = true;

    const targetMode = document.querySelector(`input[name="normalizer-mode"][value="${settings.mode}"]`);
    if (targetMode) targetMode.checked = true;

    updateContainerDisabledState(settings.enabled);
  }

  function updateSpeedButtonState(speed) {
    const num = parseFloat(speed) || 1.0;
    speedButtons.forEach((btn) => {
      const btnSpeed = parseFloat(btn.getAttribute('data-speed'));
      if (Math.abs(btnSpeed - num) < 0.05) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  function updateContainerDisabledState(isEnabled) {
    if (isEnabled) {
      appContainer.classList.remove('is-disabled');
      setStatusPill('idle', '待命中');
    } else {
      appContainer.classList.add('is-disabled');
      setStatusPill('idle', '已停用');
      compValueBadge.textContent = '0.0 dB';
      compValueBadge.className = 'comp-offset';
      vuFill.style.width = '0%';
    }
  }

  function setStatusPill(type, text) {
    statusPill.className = 'status-pill';
    if (type === 'locked') {
      statusPill.classList.add('status-locked');
    } else if (type === 'boosting') {
      statusPill.classList.add('status-boosting');
    } else if (type === 'cutting') {
      statusPill.classList.add('status-cutting');
    } else {
      statusPill.classList.add('status-idle');
    }
    statusText.textContent = text;
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
    chrome.storage.local.set({ targetVolume: val, volume: val });
  });

  // 5. 重設為 50% 基準點
  btnResetTarget.addEventListener('click', () => {
    targetSlider.value = 50;
    targetValDisplay.textContent = '50%';
    chrome.storage.local.set({ targetVolume: 50, volume: 50, volumeVersion: 2 });
  });

  // 6. 播放速度切換 (1.0x / 1.5x / 2.0x / 3.0x)
  speedButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.getAttribute('data-speed')) || 1.0;
      updateSpeedButtonState(speed);
      chrome.storage.local.set({ playbackSpeed: speed });

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SET_PLAYBACK_SPEED',
            speed: speed,
          }).catch(() => {});
        }
      });
    });
  });

  // 7. 固定最高畫質下拉切換
  if (selectQuality) {
    selectQuality.addEventListener('change', () => {
      const quality = selectQuality.value;
      chrome.storage.local.set({ lockedQuality: quality });

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0] && tabs[0].id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'SET_LOCKED_QUALITY',
            quality: quality,
          }).catch(() => {});
        }
      });
    });
  }

  // 8. 純聽音樂模式開關
  toggleMusicMode.addEventListener('change', () => {
    const isChecked = toggleMusicMode.checked;
    chrome.storage.local.set({ musicMode: isChecked });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_MUSIC_MODE',
          enabled: isChecked,
        }).catch(() => {});
      }
    });
  });

  // 9. 播放清單真隨機開關 (Session Storage)
  toggleShuffle.addEventListener('change', () => {
    const isChecked = toggleShuffle.checked;
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ trueShuffle: isChecked });
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'TOGGLE_TRUE_SHUFFLE',
          enabled: isChecked,
        }).catch(() => {});
      }
    });
  });

  // 10. 進階微調展開/收合
  btnToggleAdvanced.addEventListener('click', () => {
    const isOpen = advancedContent.classList.toggle('open');
    btnToggleAdvanced.setAttribute('aria-expanded', String(isOpen));
  });

  // 11. 嚴格度切換
  tightnessRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ rangeTightness: e.target.value });
      }
    });
  });

  // 12. 等化風格切換
  modeRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
      if (e.target.checked) {
        chrome.storage.local.set({ mode: e.target.value });
      }
    });
  });

  // 13. 監聽全域設定異動以即時同步 Popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if ('musicMode' in changes) {
        toggleMusicMode.checked = Boolean(changes.musicMode.newValue);
      }
      if ('playbackSpeed' in changes) {
        updateSpeedButtonState(changes.playbackSpeed.newValue);
      }
      if ('lockedQuality' in changes && selectQuality) {
        selectQuality.value = changes.lockedQuality.newValue;
      }
      if ('enabled' in changes) {
        toggleEnabled.checked = Boolean(changes.enabled.newValue);
        updateContainerDisabledState(toggleEnabled.checked);
      }
      if ('targetVolume' in changes) {
        const v = changes.targetVolume.newValue;
        targetSlider.value = v;
        targetValDisplay.textContent = `${v}%`;
      }
    } else if (area === 'session') {
      if ('trueShuffle' in changes) {
        toggleShuffle.checked = Boolean(changes.trueShuffle.newValue);
      }
    }
  });

  // 14. 連接 YouTube 分頁接收即時狀態
  function connectToActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) return;
      const activeTab = tabs[0];

      if (!activeTab.url || !activeTab.url.includes('youtube.com')) {
        setStatusPill('idle', '非 YT 頁面');
        shuffleStatusHint.textContent = '未在 YouTube 播放頁';
        return;
      }

      try {
        vuPort = chrome.tabs.connect(activeTab.id, { name: 'yt-volume-vu' });

        vuPort.onMessage.addListener((msg) => {
          if (msg.type === 'VU_DATA') {
            if (!toggleEnabled.checked) return;

            // 同步純音模式狀態
            if (msg.isMusicMode !== undefined && toggleMusicMode.checked !== msg.isMusicMode) {
              toggleMusicMode.checked = msg.isMusicMode;
            }

            // 同步播放速度
            if (msg.playbackSpeed !== undefined) {
              updateSpeedButtonState(msg.playbackSpeed);
            }

            // 同步鎖定畫質
            if (msg.lockedQuality !== undefined && selectQuality && selectQuality.value !== msg.lockedQuality) {
              selectQuality.value = msg.lockedQuality;
            }

            // 即時動態狀態膠囊
            if (msg.isPlaying) {
              if (msg.statusMode === 'boosting') {
                setStatusPill('boosting', '⬆️ 微弱增益');
              } else if (msg.statusMode === 'cutting') {
                setStatusPill('cutting', '⬇️ 爆音抑制');
              } else if (msg.statusMode === 'locked') {
                setStatusPill('locked', '🟢 舒適鎖定');
              } else {
                setStatusPill('idle', '偵測中...');
              }
            } else {
              setStatusPill('idle', '暫停中');
            }

            // 自動補償數值
            if (msg.offsetDb) {
              compValueBadge.textContent = msg.offsetDb;
              if (msg.rawOffset > 0.6) {
                compValueBadge.className = 'comp-offset boost';
              } else if (msg.rawOffset < -0.6) {
                compValueBadge.className = 'comp-offset cut';
              } else {
                compValueBadge.className = 'comp-offset';
              }
            }

            // VU 能量條
            vuFill.style.width = `${Math.min(100, Math.max(0, msg.level))}%`;

            // 真隨機清單回饋
            if (msg.isPlaylist) {
              if (msg.isTrueShuffle) {
                shuffleStatusHint.textContent = `🟢 真隨機運作中 (${msg.playedCount}/${msg.playlistCount} 首)`;
              } else {
                shuffleStatusHint.textContent = `偵測到清單 (${msg.playlistCount} 首，尚未開啟)`;
              }
            } else {
              shuffleStatusHint.textContent = '未偵測到清單 (進入歌單後生效)';
            }
          }
        });

        vuPort.onDisconnect.addListener(() => {
          vuPort = null;
          if (toggleEnabled.checked) {
            setStatusPill('idle', '待命中');
          }
          vuFill.style.width = '0%';
        });
      } catch (err) {
        console.warn('無法建立即時監聽 Port:', err);
      }
    });
  }
});
