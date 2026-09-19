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
    playbackSpeed: 2.0,
    smartSpeedEnabled: true,
    musicSpeed: 1.0,
    videoSpeed: 2.0,
    shuffleWhitelist: [],
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
  const speedSmartBadge = document.getElementById('speed-smart-badge');
  const selectQuality = document.getElementById('select-quality');

  const toggleMusicMode = document.getElementById('toggle-music-mode');
  const toggleShuffle = document.getElementById('toggle-shuffle');
  const shuffleStatusHint = document.getElementById('shuffle-status-hint');
  const shuffleBadge = document.getElementById('shuffle-badge');
  const btnStarWhitelist = document.getElementById('btn-star-whitelist');
  
  const btnToggleAdvanced = document.getElementById('btn-toggle-advanced');
  const advancedContent = document.getElementById('advanced-content');
  const toggleSmartSpeed = document.getElementById('toggle-smart-speed');
  const tightnessRadios = document.querySelectorAll('input[name="range-tightness"]');
  const modeRadios = document.querySelectorAll('input[name="normalizer-mode"]');

  // 白名單管理 DOM 元素
  const whitelistCount = document.getElementById('whitelist-count');
  const inputWhitelistId = document.getElementById('input-whitelist-id');
  const btnAddWhitelist = document.getElementById('btn-add-whitelist');
  const whitelistQuickBar = document.getElementById('whitelist-quick-bar');
  const btnQuickAddCurrent = document.getElementById('btn-quick-add-current');
  const quickCurrentId = document.getElementById('quick-current-id');
  const whitelistTagsBox = document.getElementById('whitelist-tags-box');

  let vuPort = null;
  let currentShuffleWhitelist = [];
  let currentDetectedPlaylistId = '';
  let isCurrentPlaylistWhitelisted = false;
  let currentVideoIsMusic = false;
  let isSmartSpeedEnabled = true;


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
    renderWhitelist(settings.shuffleWhitelist || []);
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

    isSmartSpeedEnabled = settings.smartSpeedEnabled !== false;
    if (toggleSmartSpeed) {
      toggleSmartSpeed.checked = isSmartSpeedEnabled;
    }

    updateSpeedButtonState(settings.playbackSpeed || (currentVideoIsMusic ? 1.0 : 2.0));
    updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, settings.playbackSpeed);

    const targetTightness = document.querySelector(`input[name="range-tightness"][value="${settings.rangeTightness}"]`);
    if (targetTightness) targetTightness.checked = true;

    const targetMode = document.querySelector(`input[name="normalizer-mode"][value="${settings.mode}"]`);
    if (targetMode) targetMode.checked = true;

    updateContainerDisabledState(settings.enabled);
  }

  function formatSpeedText(speed) {
    const num = Math.round((parseFloat(speed) || 1.0) * 100) / 100;
    if (Math.abs(Math.round(num * 10) - num * 10) < 1e-5) {
      return num.toFixed(1);
    }
    return num.toFixed(2);
  }

  function updateSmartSpeedBadge(smartEnabled, isMusic, currentSpeed) {
    if (!speedSmartBadge) return;
    const speedNum = parseFloat(currentSpeed) || (isMusic ? 1.0 : 2.0);
    const speedStr = formatSpeedText(speedNum);
    if (!smartEnabled) {
      speedSmartBadge.className = 'speed-smart-badge off';
      speedSmartBadge.textContent = '智慧關閉';
      speedSmartBadge.title = '智慧歌曲自動調速已關閉，可在下方進階微調開啟';
    } else if (isMusic) {
      speedSmartBadge.className = 'speed-smart-badge';
      speedSmartBadge.textContent = `🎵 音樂 ${speedStr}x`;
      speedSmartBadge.title = `智慧情境：已識別為音樂歌曲，自動切換 1.0x 原速`;
    } else {
      speedSmartBadge.className = 'speed-smart-badge video';
      speedSmartBadge.textContent = `🎬 看片 ${speedStr}x`;
      speedSmartBadge.title = `智慧情境：已識別為一般影片，自動切換 2.0x 倍速`;
    }
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

  // 輔助函式：安全發送訊息至作用中 YouTube 分頁 (過濾非 YT 分頁，杜絕通訊錯誤)
  function sendMsgToActiveTab(message) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0] || !tabs[0].id) return;
      const tab = tabs[0];
      if (tab.url && tab.url.includes('youtube.com')) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    });
  }

  // 6. 播放速度切換 (1.0x / 1.5x / 2.0x / 3.0x)
  speedButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const speed = parseFloat(btn.getAttribute('data-speed')) || 1.0;
      updateSpeedButtonState(speed);
      updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, speed);
      chrome.storage.local.set({ playbackSpeed: speed });
      sendMsgToActiveTab({
        type: 'SET_PLAYBACK_SPEED',
        speed: speed,
      });
    });
  });

  // 6.1 智慧歌曲自動調速開關 (Smart Speed Toggle)
  if (toggleSmartSpeed) {
    toggleSmartSpeed.addEventListener('change', () => {
      const isChecked = toggleSmartSpeed.checked;
      isSmartSpeedEnabled = isChecked;
      chrome.storage.local.set({ smartSpeedEnabled: isChecked });
      updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, null);
      sendMsgToActiveTab({
        type: 'SET_SMART_SPEED_CONFIG',
        smartSpeedEnabled: isChecked,
      });
    });
  }

  // 7. 固定最高畫質下拉切換
  if (selectQuality) {
    selectQuality.addEventListener('change', () => {
      const quality = selectQuality.value;
      chrome.storage.local.set({ lockedQuality: quality });
      sendMsgToActiveTab({
        type: 'SET_LOCKED_QUALITY',
        quality: quality,
      });
    });
  }

  // 8. 純聽音樂模式開關
  toggleMusicMode.addEventListener('change', () => {
    const isChecked = toggleMusicMode.checked;
    chrome.storage.local.set({ musicMode: isChecked });
    sendMsgToActiveTab({
      type: 'TOGGLE_MUSIC_MODE',
      enabled: isChecked,
    });
  });

  // 9. 播放清單真隨機開關 (Session Storage)
  toggleShuffle.addEventListener('change', () => {
    const isChecked = toggleShuffle.checked;
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ trueShuffle: isChecked });
    }
    sendMsgToActiveTab({
      type: 'TOGGLE_TRUE_SHUFFLE',
      enabled: isChecked,
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

  // 12.1 白名單 ID 智慧解析 (支援純 ID 與 YouTube 完整網址)
  function parsePlaylistId(input) {
    if (!input || typeof input !== 'string') return '';
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
    return '';
  }

  // 12.2 渲染白名單標籤晶片
  function renderWhitelist(whitelist) {
    currentShuffleWhitelist = Array.isArray(whitelist) ? whitelist : [];
    if (whitelistCount) {
      whitelistCount.textContent = `${currentShuffleWhitelist.length} 個歌單`;
    }

    if (whitelistTagsBox) {
      whitelistTagsBox.innerHTML = '';
      if (currentShuffleWhitelist.length === 0) {
        const emptySpan = document.createElement('span');
        emptySpan.className = 'whitelist-empty-hint';
        emptySpan.textContent = '尚未加入任何歌單（命中加入的清單將自動開啟真隨機）';
        whitelistTagsBox.appendChild(emptySpan);
      } else {
        currentShuffleWhitelist.forEach((id) => {
          const chip = document.createElement('span');
          chip.className = 'tag-chip';

          const idText = document.createElement('span');
          idText.textContent = id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id;
          idText.title = id;

          const delBtn = document.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'btn-del-tag';
          delBtn.textContent = '✕';
          delBtn.title = `從白名單移除 ${id}`;
          delBtn.addEventListener('click', () => removePlaylistFromWhitelist(id));

          chip.appendChild(idText);
          chip.appendChild(delBtn);
          whitelistTagsBox.appendChild(chip);
        });
      }
    }

    updatePlaylistDetectionUi();
  }

  // 12.3 新增歌單至白名單
  function addPlaylistToWhitelist(rawInput) {
    const id = parsePlaylistId(rawInput);
    if (!id) {
      if (inputWhitelistId) inputWhitelistId.focus();
      return;
    }
    if (currentShuffleWhitelist.includes(id)) {
      if (inputWhitelistId) inputWhitelistId.value = '';
      return;
    }
    const updated = [...currentShuffleWhitelist, id];
    chrome.storage.local.set({ shuffleWhitelist: updated }, () => {
      if (inputWhitelistId) inputWhitelistId.value = '';
      renderWhitelist(updated);
    });
  }

  // 12.4 從白名單移除歌單
  function removePlaylistFromWhitelist(idToRemove) {
    const updated = currentShuffleWhitelist.filter((id) => id !== idToRemove);
    chrome.storage.local.set({ shuffleWhitelist: updated }, () => {
      renderWhitelist(updated);
    });
  }

  // 12.5 更新播放清單偵測視覺回饋 (主卡片按鈕、徽章與快速加入列)
  function updatePlaylistDetectionUi() {
    if (!shuffleBadge || !btnStarWhitelist) return;

    if (!currentDetectedPlaylistId) {
      btnStarWhitelist.style.display = 'none';
      if (whitelistQuickBar) whitelistQuickBar.style.display = 'none';
      shuffleBadge.className = 'badge-session';
      shuffleBadge.textContent = '重開重設';
      shuffleBadge.title = '單次工作階段有效，重啟瀏覽器自動關閉';
      return;
    }

    isCurrentPlaylistWhitelisted = currentShuffleWhitelist.includes(currentDetectedPlaylistId);

    // 主卡片按鈕與徽章連動
    btnStarWhitelist.style.display = 'inline-flex';
    if (isCurrentPlaylistWhitelisted) {
      btnStarWhitelist.className = 'btn-star-whitelist active';
      btnStarWhitelist.textContent = '★已設自動隨機';
      btnStarWhitelist.title = '點擊從白名單移除此歌單';
      shuffleBadge.className = 'badge-whitelist';
      shuffleBadge.textContent = '🌟自動隨機';
      shuffleBadge.title = '此歌單命中白名單，已自動接管隨機播放';
      if (whitelistQuickBar) whitelistQuickBar.style.display = 'none';
    } else {
      btnStarWhitelist.className = 'btn-star-whitelist';
      btnStarWhitelist.textContent = '⭐自動隨機';
      btnStarWhitelist.title = '點擊將當前歌單設為自動隨機白名單';
      shuffleBadge.className = 'badge-session';
      shuffleBadge.textContent = '重開重設';
      shuffleBadge.title = '單次工作階段有效，重啟瀏覽器自動關閉';

      // 展開進階抽屜時的快捷加入列
      if (whitelistQuickBar && quickCurrentId) {
        whitelistQuickBar.style.display = 'block';
        quickCurrentId.textContent = currentDetectedPlaylistId.length > 16 
          ? `${currentDetectedPlaylistId.slice(0, 6)}...${currentDetectedPlaylistId.slice(-4)}`
          : currentDetectedPlaylistId;
      }
    }
  }

  // 12.6 白名單介面事件綁定
  if (btnAddWhitelist && inputWhitelistId) {
    btnAddWhitelist.addEventListener('click', () => {
      addPlaylistToWhitelist(inputWhitelistId.value);
    });

    inputWhitelistId.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        addPlaylistToWhitelist(inputWhitelistId.value);
      }
    });
  }

  if (btnQuickAddCurrent) {
    btnQuickAddCurrent.addEventListener('click', () => {
      if (currentDetectedPlaylistId) {
        addPlaylistToWhitelist(currentDetectedPlaylistId);
      }
    });
  }

  if (btnStarWhitelist) {
    btnStarWhitelist.addEventListener('click', () => {
      if (!currentDetectedPlaylistId) return;
      if (isCurrentPlaylistWhitelisted) {
        removePlaylistFromWhitelist(currentDetectedPlaylistId);
      } else {
        addPlaylistToWhitelist(currentDetectedPlaylistId);
      }
    });
  }

  // 13. 監聽全域設定異動以即時同步 Popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if ('shuffleWhitelist' in changes) {
        renderWhitelist(changes.shuffleWhitelist.newValue || []);
      }
      if ('musicMode' in changes) {
        toggleMusicMode.checked = Boolean(changes.musicMode.newValue);
      }
      if ('playbackSpeed' in changes) {
        updateSpeedButtonState(changes.playbackSpeed.newValue);
        updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, changes.playbackSpeed.newValue);
      }
      if ('smartSpeedEnabled' in changes) {
        isSmartSpeedEnabled = Boolean(changes.smartSpeedEnabled.newValue);
        if (toggleSmartSpeed) toggleSmartSpeed.checked = isSmartSpeedEnabled;
        updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, null);
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

      // 預讀 URL 中的播放清單 ID
      if (activeTab.url && activeTab.url.includes('list=')) {
        const parsed = parsePlaylistId(activeTab.url);
        if (parsed) {
          currentDetectedPlaylistId = parsed;
          updatePlaylistDetectionUi();
        }
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

            // 同步智慧自動調速與歌曲辨識狀態
            if (msg.smartSpeedEnabled !== undefined) {
              isSmartSpeedEnabled = Boolean(msg.smartSpeedEnabled);
              if (toggleSmartSpeed) toggleSmartSpeed.checked = isSmartSpeedEnabled;
            }
            if (msg.isMusicDetected !== undefined) {
              currentVideoIsMusic = Boolean(msg.isMusicDetected);
            }

            // 同步播放速度與狀態膠囊
            if (msg.playbackSpeed !== undefined) {
              updateSpeedButtonState(msg.playbackSpeed);
            }
            updateSmartSpeedBadge(isSmartSpeedEnabled, currentVideoIsMusic, msg.playbackSpeed);

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

            // 當前清單 ID 與白名單狀態更新
            if (msg.isPlaylist && msg.playlistId) {
              currentDetectedPlaylistId = msg.playlistId;
            } else {
              currentDetectedPlaylistId = '';
            }
            updatePlaylistDetectionUi();

            // 真隨機清單回饋
            if (msg.isPlaylist) {
              if (msg.isTrueShuffle) {
                if (msg.isWhitelistPlaylist || isCurrentPlaylistWhitelisted) {
                  shuffleStatusHint.textContent = `🌟 白名單自動隨機 (${msg.playedCount}/${msg.playlistCount} 首)`;
                  toggleShuffle.checked = true;
                } else {
                  shuffleStatusHint.textContent = `🟢 真隨機運作中 (${msg.playedCount}/${msg.playlistCount} 首)`;
                }
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
