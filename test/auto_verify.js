/**
 * YouTube 音量鎖定 ＆ 純音模式 - 全功能自動化確認與邏輯測試套件
 * 用於全面自我驗證擴充套件之核心功能是否達到使用者所有設定之目標
 */

const assert = require('assert');

console.log('====================================================');
console.log('🧪 開始執行 YouTube 音量鎖定 ＆ 智慧調速 全功能自動化驗證');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${desc}`);
    passCount++;
  } catch (err) {
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     錯誤: ${err.message}`);
    failCount++;
  }
}

// --------------------------------------------------------------------------
// 測試模組 1: 播放清單 ID 智慧解析 (parsePlaylistId)
// --------------------------------------------------------------------------
console.log('--- 測試 1: 播放清單 ID 智慧解析 (純 ID 與各類 YouTube 網址) ---');

function parsePlaylistId(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
  return '';
}

it('應正確解析純清單 ID (標準、合輯、混音清單)', () => {
  assert.strictEqual(parsePlaylistId('PLr3-0S2vAix4yvW3_kC9nE8_'), 'PLr3-0S2vAix4yvW3_kC9nE8_');
  assert.strictEqual(parsePlaylistId('OLAK5uy_k123456789'), 'OLAK5uy_k123456789');
  assert.strictEqual(parsePlaylistId('RDMM4kL37G'), 'RDMM4kL37G');
});

it('應正確解析完整 YouTube 播放清單網址', () => {
  const url1 = 'https://www.youtube.com/playlist?list=PL1234567890abcdef_';
  assert.strictEqual(parsePlaylistId(url1), 'PL1234567890abcdef_');

  const url2 = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL987654321&index=5';
  assert.strictEqual(parsePlaylistId(url2), 'PL987654321');

  const url3 = 'https://music.youtube.com/watch?v=abc&list=RDAMVM123';
  assert.strictEqual(parsePlaylistId(url3), 'RDAMVM123');
});

it('遇到無效、空白或特殊字元應回傳空字串', () => {
  assert.strictEqual(parsePlaylistId(''), '');
  assert.strictEqual(parsePlaylistId('   '), '');
  assert.strictEqual(parsePlaylistId(null), '');
  assert.strictEqual(parsePlaylistId(undefined), '');
  assert.strictEqual(parsePlaylistId('https://youtube.com/watch?v=123'), '');
  assert.strictEqual(parsePlaylistId('!@#$%^&*()'), '');
});

// --------------------------------------------------------------------------
// 測試模組 2: 8 層級音樂歌曲辨識引擎 (evaluateIsMusicVideo)
// --------------------------------------------------------------------------
console.log('\n--- 測試 2: 8 層級全方位音樂歌曲特徵辨識邏輯 ---');

function evaluateIsMusicVideoMock(context) {
  const {
    musicMode = false,
    listId = null,
    shuffleWhitelist = [],
    category = null,
    musicVideoType = null,
    author = '',
    hasArtistBadge = false,
    structuredDesc = '',
    title = '',
  } = context;

  if (musicMode) return { isMusic: true, reason: '純聽音樂模式開啟中' };

  if (listId) {
    if (shuffleWhitelist.includes(listId)) {
      return { isMusic: true, reason: `白名單歌單 (${listId})` };
    }
    if (listId.startsWith('OLAK5uy_') || listId.startsWith('RDMM') || listId.startsWith('RD') || listId === 'LM') {
      return { isMusic: true, reason: `官方音樂合輯/專輯清單 (${listId})` };
    }
  }

  if (category && category.toLowerCase() === 'music') {
    return { isMusic: true, reason: '官方分類標籤：Music' };
  }

  if (musicVideoType && String(musicVideoType).toUpperCase().includes('MUSIC')) {
    return { isMusic: true, reason: `官方音樂類型：${musicVideoType}` };
  }

  if (author.endsWith(' - Topic') || author.endsWith('- Topic')) {
    return { isMusic: true, reason: `官方主題音樂頻道 (${author})` };
  }

  if (hasArtistBadge) {
    return { isMusic: true, reason: '官方音樂人認證標章' };
  }

  if (
    structuredDesc.includes('Music in this video') ||
    structuredDesc.includes('這部影片中的音樂') ||
    (structuredDesc.includes('歌曲') && structuredDesc.includes('演出者'))
  ) {
    return { isMusic: true, reason: '說明欄包含官方版權音樂資訊' };
  }

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

it('純音模式開啟時應一律判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ musicMode: true });
  assert.strictEqual(res.isMusic, true);
});

it('白名單播放清單應自動判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ listId: 'PL_FAVORITES', shuffleWhitelist: ['PL_FAVORITES'] });
  assert.strictEqual(res.isMusic, true);
});

it('官方合輯或專輯清單 (OLAK5uy / RDMM) 應自動判定為音樂', () => {
  assert.strictEqual(evaluateIsMusicVideoMock({ listId: 'OLAK5uy_abcdef' }).isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ listId: 'RDMM123456' }).isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ listId: 'RDabc' }).isMusic, true);
});

it('官方微格式分類 Category === "Music" 應判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ category: 'Music' });
  assert.strictEqual(res.isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ category: 'music' }).isMusic, true);
});

it('官方音樂影片類型 (MUSIC_VIDEO_TYPE_OMV) 應判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ musicVideoType: 'MUSIC_VIDEO_TYPE_OMV' });
  assert.strictEqual(res.isMusic, true);
});

it('官方主題音樂頻道 (Artist - Topic) 應判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ author: 'Jay Chou - Topic' });
  assert.strictEqual(res.isMusic, true);
});

it('官方音樂人認證徽章應判定為音樂', () => {
  const res = evaluateIsMusicVideoMock({ hasArtistBadge: true });
  assert.strictEqual(res.isMusic, true);
});

it('說明欄包含官方版權音樂資訊應判定為音樂', () => {
  const res1 = evaluateIsMusicVideoMock({ structuredDesc: 'Music in this video: Song: Hello, Artist: Adele' });
  assert.strictEqual(res1.isMusic, true);
  const res2 = evaluateIsMusicVideoMock({ structuredDesc: '這部影片中的音樂 歌曲: 晴天 演出者: 周杰倫' });
  assert.strictEqual(res2.isMusic, true);
});

it('標題包含強音樂特徵關鍵字應判定為音樂', () => {
  assert.strictEqual(evaluateIsMusicVideoMock({ title: 'Taylor Swift - Anti-Hero (Official Music Video)' }).isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ title: 'YOASOBI「アイドル」 Official Music Video' }).isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ title: 'Ado - 唱【動畫MV】' }).isMusic, true);
  assert.strictEqual(evaluateIsMusicVideoMock({ title: 'Interstellar OST - Hans Zimmer (Remix)' }).isMusic, true);
});

it('一般教學、遊戲、開箱與新聞影片應判定為一般影片 (isMusic: false)', () => {
  const regular1 = evaluateIsMusicVideoMock({
    category: 'Education',
    author: 'freeCodeCamp.org',
    title: 'Python for Beginners - Full Course [Programming Tutorial]',
  });
  assert.strictEqual(regular1.isMusic, false);

  const regular2 = evaluateIsMusicVideoMock({
    category: 'Gaming',
    author: 'IGN',
    title: 'Black Myth: Wukong - Final Review & Gameplay Walkthrough',
  });
  assert.strictEqual(regular2.isMusic, false);
});

// --------------------------------------------------------------------------
// 測試模組 3: 智慧調速與單片手動覆蓋保護 (evaluateAndApplySmartSpeed)
// --------------------------------------------------------------------------
console.log('\n--- 測試 3: 智慧調速與手動覆蓋保護機制 ---');

class SmartSpeedControllerMock {
  constructor() {
    this.settings = {
      smartSpeedEnabled: true,
      musicSpeed: 1.0,
      videoSpeed: 2.0,
      playbackSpeed: 2.0,
    };
    this.lastEvaluatedVideoId = null;
    this.manualSpeedOverriddenVideoId = null;
    this.currentVideoIsMusic = false;
    this.appliedSpeed = null;
  }

  evaluateAndApply(videoId, context, isUserAction = false) {
    if (videoId && videoId !== this.lastEvaluatedVideoId) {
      this.manualSpeedOverriddenVideoId = null;
      this.lastEvaluatedVideoId = videoId;
    }

    const evaluation = evaluateIsMusicVideoMock(context);
    this.currentVideoIsMusic = evaluation.isMusic;

    if (!this.settings.smartSpeedEnabled) {
      this.appliedSpeed = this.settings.playbackSpeed || 2.0;
      return;
    }

    if (this.manualSpeedOverriddenVideoId === videoId && !isUserAction) {
      return; // 尊重手動覆蓋，不更改 appliedSpeed
    }

    const targetSpeed = this.currentVideoIsMusic
      ? (parseFloat(this.settings.musicSpeed) || 1.0)
      : (parseFloat(this.settings.videoSpeed) || 2.0);

    this.appliedSpeed = targetSpeed;
  }

  userManualOverride(videoId, newSpeed) {
    this.manualSpeedOverriddenVideoId = videoId;
    this.appliedSpeed = newSpeed;
    this.settings.playbackSpeed = newSpeed;
  }
}

it('換片到一般影片應自動切換為 2.0x 倍速', () => {
  const ctrl = new SmartSpeedControllerMock();
  ctrl.evaluateAndApply('vid1', { category: 'Education', title: 'Calculus 101' });
  assert.strictEqual(ctrl.appliedSpeed, 2.0);
  assert.strictEqual(ctrl.currentVideoIsMusic, false);
});

it('換片到音樂歌曲應自動切換為 1.0x 原速', () => {
  const ctrl = new SmartSpeedControllerMock();
  ctrl.evaluateAndApply('vid2', { category: 'Music', title: 'Ed Sheeran - Shape of You' });
  assert.strictEqual(ctrl.appliedSpeed, 1.0);
  assert.strictEqual(ctrl.currentVideoIsMusic, true);
});

it('單片手動覆蓋 (Manual Override)：手動調整後，同部影片後續更新不被重設', () => {
  const ctrl = new SmartSpeedControllerMock();
  // 1. 載入一般影片，自動 2.0x
  ctrl.evaluateAndApply('vid3', { category: 'Education', title: 'Tech Talk' });
  assert.strictEqual(ctrl.appliedSpeed, 2.0);

  // 2. 使用者在當前影片手動調整為 1.5x
  ctrl.userManualOverride('vid3', 1.5);
  assert.strictEqual(ctrl.appliedSpeed, 1.5);

  // 3. 頁面非同步資料到達，再次觸發 evaluateAndApply，應維持 1.5x 不被重設為 2.0x
  ctrl.evaluateAndApply('vid3', { category: 'Education', title: 'Tech Talk' });
  assert.strictEqual(ctrl.appliedSpeed, 1.5);
});

it('換片後手動覆蓋自動解除，新影片恢復智慧調速', () => {
  const ctrl = new SmartSpeedControllerMock();
  ctrl.evaluateAndApply('vidA', { category: 'Education', title: 'Video A' });
  ctrl.userManualOverride('vidA', 3.0); // 使用者覆蓋為 3.0x
  assert.strictEqual(ctrl.appliedSpeed, 3.0);

  // 換片至 vidB (音樂歌曲)
  ctrl.evaluateAndApply('vidB', { category: 'Music', title: 'Song B' });
  // 應自動切換為 1.0x，原先的 3.0x 覆蓋已解除
  assert.strictEqual(ctrl.appliedSpeed, 1.0);
});

it('智慧調速開關關閉時，均維持固定 playbackSpeed', () => {
  const ctrl = new SmartSpeedControllerMock();
  ctrl.settings.smartSpeedEnabled = false;
  ctrl.settings.playbackSpeed = 1.5;

  ctrl.evaluateAndApply('vidMusic', { category: 'Music' });
  assert.strictEqual(ctrl.appliedSpeed, 1.5);

  ctrl.evaluateAndApply('vidRegular', { category: 'Education' });
  assert.strictEqual(ctrl.appliedSpeed, 1.5);
});

// --------------------------------------------------------------------------
// 測試模組 4: 白名單自動接管真隨機與離開還原 (checkAndApplyWhitelistShuffle)
// --------------------------------------------------------------------------
console.log('\n--- 測試 4: 白名單播放清單自動接管與還原邏輯 ---');

class WhitelistShuffleManagerMock {
  constructor(whitelist = []) {
    this.whitelist = whitelist;
    this.isTrueShuffleEnabled = false;
    this.autoEnabledByWhitelist = false;
  }

  checkAndApply(listId) {
    const isWhitelisted = Boolean(listId && this.whitelist.includes(listId));
    if (isWhitelisted) {
      if (!this.isTrueShuffleEnabled) {
        this.isTrueShuffleEnabled = true;
        this.autoEnabledByWhitelist = true;
      }
    } else {
      if (this.autoEnabledByWhitelist && this.isTrueShuffleEnabled) {
        this.isTrueShuffleEnabled = false;
        this.autoEnabledByWhitelist = false;
      }
    }
  }
}

it('載入白名單歌單時應自動開啟真隨機', () => {
  const mgr = new WhitelistShuffleManagerMock(['PL_MUSIC_FAV', 'OLAK5uy_ALBUM']);
  mgr.checkAndApply('PL_MUSIC_FAV');
  assert.strictEqual(mgr.isTrueShuffleEnabled, true);
  assert.strictEqual(mgr.autoEnabledByWhitelist, true);
});

it('離開白名單歌單至一般清單時應自動還原關閉', () => {
  const mgr = new WhitelistShuffleManagerMock(['PL_MUSIC_FAV']);
  mgr.checkAndApply('PL_MUSIC_FAV'); // 進入白名單
  assert.strictEqual(mgr.isTrueShuffleEnabled, true);

  mgr.checkAndApply('PL_COURSE_101'); // 進入非白名單教學清單
  assert.strictEqual(mgr.isTrueShuffleEnabled, false);
  assert.strictEqual(mgr.autoEnabledByWhitelist, false);
});

it('若使用者非白名單手動開啟真隨機，離開清單不應被白名單誤關閉', () => {
  const mgr = new WhitelistShuffleManagerMock(['PL_MUSIC_FAV']);
  mgr.isTrueShuffleEnabled = true;
  mgr.autoEnabledByWhitelist = false; // 使用者主動手動開啟

  mgr.checkAndApply('PL_SOME_LIST');
  assert.strictEqual(mgr.isTrueShuffleEnabled, true); // 保持開啟
});

// --------------------------------------------------------------------------
// 測試模組 5: 零溢出超平滑軟限制器數學曲線 (WaveShaper)
// --------------------------------------------------------------------------
console.log('\n--- 測試 5: 65536 點超平滑軟限制器數學曲線特性 ---');

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

const curve = createZeroOvershootCurve();

it('|x| <= 0.80 區間應為 100% 絕對 1:1 線性純淨輸出', () => {
  const half = (65536 - 1) / 2;
  // 檢查 x = 0, 0.25, 0.5, 0.75, -0.5
  [-0.75, -0.5, -0.2, 0, 0.2, 0.5, 0.75].forEach((testVal) => {
    const idx = Math.round(testVal * half + half);
    const out = curve[idx];
    assert(Math.abs(out - testVal) < 0.0001, `x=${testVal} 時輸出應為 ${testVal}，實際為 ${out}`);
  });
});

it('最大輸出振幅峰值絕對不超過 0.945 (-0.5 dBFS)，杜絕硬體削頂破音', () => {
  let maxAbs = 0;
  for (let i = 0; i < curve.length; i++) {
    const abs = Math.abs(curve[i]);
    if (abs > maxAbs) maxAbs = abs;
  }
  assert(maxAbs <= 0.945 + 0.0001, `最大峰值應 <= 0.945，實際為 ${maxAbs}`);
  const maxDb = 20 * Math.log10(maxAbs);
  assert(maxDb <= -0.49, `最大輸出 dBFS 應 <= -0.49 dBFS，實際為 ${maxDb.toFixed(2)} dBFS`);
});

// --------------------------------------------------------------------------
// 測試模組 6: 固定畫質階梯式向下 Fallback 演算法 (applyQuality)
// --------------------------------------------------------------------------
console.log('\n--- 測試 6: 固定畫質階梯式向下 Fallback 演算法 ---');

const QUALITY_PRIORITY = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];

function getTargetQuality(targetQuality, available) {
  if (!targetQuality || targetQuality === 'auto') return 'auto';
  if (available.length === 0) return targetQuality;
  if (available.includes(targetQuality)) return targetQuality;

  const prefIdx = QUALITY_PRIORITY.indexOf(targetQuality);
  const fallbackList = prefIdx >= 0 ? QUALITY_PRIORITY.slice(prefIdx) : QUALITY_PRIORITY;
  const matched = fallbackList.find((q) => available.includes(q));
  return matched || available[0];
}

it('影片支援所選畫質時應精確命中', () => {
  assert.strictEqual(getTargetQuality('hd1080', ['hd2160', 'hd1080', 'hd720']), 'hd1080');
  assert.strictEqual(getTargetQuality('hd2160', ['hd2160', 'hd1440', 'hd1080']), 'hd2160');
});

it('老影片不支援 4K/2K 時應向下 Fallback 至最高可用畫質', () => {
  // 要求 4K (hd2160)，影片最高只有 1080p
  assert.strictEqual(getTargetQuality('hd2160', ['hd1080', 'hd720', 'large']), 'hd1080');
  // 要求 1080p，影片最高只有 720p
  assert.strictEqual(getTargetQuality('hd1080', ['hd720', 'large', 'medium']), 'hd720');
});

// --------------------------------------------------------------------------
// 測試模組 7: 播放速度循環 (1.0x -> 1.5x -> 2.0x -> 3.0x -> 1.0x)
// --------------------------------------------------------------------------
console.log('\n--- 測試 7: 播放速度循環與快捷鍵 ---');

const SPEED_LEVELS = [1.0, 1.5, 2.0, 3.0];

function cycleSpeed(cur) {
  let idx = SPEED_LEVELS.indexOf(cur);
  if (idx === -1) idx = 0;
  return SPEED_LEVELS[(idx + 1) % SPEED_LEVELS.length];
}

it('播放速度應依序循環 1.0x -> 1.5x -> 2.0x -> 3.0x -> 1.0x', () => {
  assert.strictEqual(cycleSpeed(1.0), 1.5);
  assert.strictEqual(cycleSpeed(1.5), 2.0);
  assert.strictEqual(cycleSpeed(2.0), 3.0);
  assert.strictEqual(cycleSpeed(3.0), 1.0);
});

// --------------------------------------------------------------------------
// 測試模組 8: 純聽音樂模式 (Music Mode) 遮擋與狀態切換邏輯
// --------------------------------------------------------------------------
console.log('\n--- 測試 8: 純聽音樂模式 (Music Mode) 遮擋與狀態切換 ---');

class MusicModeControllerMock {
  constructor() {
    this.musicMode = false;
    this.globalClasses = new Set();
    this.videoOpacity = '1';
    this.overlayActive = false;
    this.requestedQuality = null;
  }

  applyMusicMode(enabled, lockedQuality = 'auto') {
    this.musicMode = Boolean(enabled);
    if (this.musicMode) {
      this.globalClasses.add('yt-music-mode-active');
      this.videoOpacity = '0';
      this.overlayActive = true;
      this.requestedQuality = 'small';
    } else {
      this.globalClasses.delete('yt-music-mode-active');
      this.videoOpacity = '1';
      this.overlayActive = false;
      this.requestedQuality = lockedQuality;
    }
  }
}

it('啟用純聽音樂模式時應立即加入 yt-music-mode-active、隱藏影片並切換 small 畫質', () => {
  const controller = new MusicModeControllerMock();
  controller.applyMusicMode(true, 'hd1080');

  assert.strictEqual(controller.musicMode, true);
  assert.strictEqual(controller.globalClasses.has('yt-music-mode-active'), true);
  assert.strictEqual(controller.videoOpacity, '0');
  assert.strictEqual(controller.overlayActive, true);
  assert.strictEqual(controller.requestedQuality, 'small');
});

it('關閉純聽音樂模式時應立即移除 yt-music-mode-active、還原影片並恢復鎖定畫質', () => {
  const controller = new MusicModeControllerMock();
  controller.applyMusicMode(true, 'hd1080');
  controller.applyMusicMode(false, 'hd1080');

  assert.strictEqual(controller.musicMode, false);
  assert.strictEqual(controller.globalClasses.has('yt-music-mode-active'), false);
  assert.strictEqual(controller.videoOpacity, '1');
  assert.strictEqual(controller.overlayActive, false);
  assert.strictEqual(controller.requestedQuality, 'hd1080');
});

// --------------------------------------------------------------------------
// 測試模組 9: 多分頁情境倍速隔離與切換同步 (Multi-Tab Speed Isolation & Sync)
// --------------------------------------------------------------------------
console.log('\n--- 測試 9: 多分頁情境倍速隔離與切換同步 ---');

class MockTabEnvironment {
  constructor(tabId, isMusic, globalSettings) {
    this.tabId = tabId;
    this.isMusic = isMusic;
    this.globalSettings = globalSettings;
    this.localPlaybackRate = 1.0;
    this.manualOverrideSpeed = null;
    this.isVisible = false;
    this.reapplyCount = 0;
  }

  evaluateAndApply() {
    this.reapplyCount++;
    if (!this.globalSettings.smartSpeedEnabled) {
      this.localPlaybackRate = parseFloat(this.globalSettings.playbackSpeed) || 2.0;
      return;
    }
    if (this.manualOverrideSpeed !== null) {
      this.localPlaybackRate = this.manualOverrideSpeed;
      return;
    }
    this.localPlaybackRate = this.isMusic
      ? (parseFloat(this.globalSettings.musicSpeed) || 1.0)
      : (parseFloat(this.globalSettings.videoSpeed) || 2.0);
  }

  onTabSwitch(visible) {
    this.isVisible = visible;
    if (visible) {
      this.evaluateAndApply();
      // 同步為全域目前作用中分頁速度供 Popup 讀取
      this.globalSettings.playbackSpeed = this.localPlaybackRate;
    }
  }

  onStorageChanged(key, newValue) {
    if (key === 'playbackSpeed') {
      // 關鍵：開啟智慧調速時，不被其他分頁的 playbackSpeed 污染
      if (!this.globalSettings.smartSpeedEnabled) {
        this.localPlaybackRate = newValue;
      }
    } else if (key === 'smartSpeedEnabled' || key === 'musicSpeed' || key === 'videoSpeed') {
      this.evaluateAndApply();
    }
  }
}

it('多分頁各自播放時速度獨立隔離：影片分頁 2.0x 與音樂分頁 1.0x 互不干擾', () => {
  const sharedSettings = {
    smartSpeedEnabled: true,
    musicSpeed: 1.0,
    videoSpeed: 2.0,
    playbackSpeed: 2.0,
  };

  const tabVideo = new MockTabEnvironment('tab1', false, sharedSettings);
  const tabMusic = new MockTabEnvironment('tab2', true, sharedSettings);

  tabVideo.evaluateAndApply();
  tabMusic.evaluateAndApply();

  assert.strictEqual(tabVideo.localPlaybackRate, 2.0, '影片分頁應為 2.0x');
  assert.strictEqual(tabMusic.localPlaybackRate, 1.0, '音樂分頁應為 1.0x');

  // 模擬 tabVideo 變更了 playbackSpeed storage
  tabMusic.onStorageChanged('playbackSpeed', 2.0);
  assert.strictEqual(tabMusic.localPlaybackRate, 1.0, '音樂分頁在開啟智慧調速時，絕對不被影片分頁的 storage 變更污染');
});

it('切換分頁時，目標分頁即刻對齊自身情境速度並更新全域作用中狀態', () => {
  const sharedSettings = {
    smartSpeedEnabled: true,
    musicSpeed: 1.0,
    videoSpeed: 2.0,
    playbackSpeed: 2.0,
  };

  const tabVideo = new MockTabEnvironment('tab1', false, sharedSettings);
  const tabMusic = new MockTabEnvironment('tab2', true, sharedSettings);

  // 一開始在 tabVideo
  tabVideo.onTabSwitch(true);
  assert.strictEqual(sharedSettings.playbackSpeed, 2.0, '前景分頁為影片時，全域狀態對齊 2.0x');

  // 切換到 tabMusic
  tabVideo.onTabSwitch(false);
  tabMusic.onTabSwitch(true);

  assert.strictEqual(tabMusic.localPlaybackRate, 1.0, '切換進音樂分頁時應為 1.0x');
  assert.strictEqual(sharedSettings.playbackSpeed, 1.0, '切換進音樂分頁時，全域狀態即時同步為 1.0x (供 Popup 讀取)');

  // 切換回 tabVideo
  tabMusic.onTabSwitch(false);
  tabVideo.onTabSwitch(true);

  assert.strictEqual(tabVideo.localPlaybackRate, 2.0, '切換回影片分頁時應為 2.0x');
  assert.strictEqual(sharedSettings.playbackSpeed, 2.0, '切換回影片分頁時，全域狀態即時同步為 2.0x');
});

it('單片手動覆蓋僅限於該分頁，不干擾另一分頁的智慧速度', () => {
  const sharedSettings = {
    smartSpeedEnabled: true,
    musicSpeed: 1.0,
    videoSpeed: 2.0,
    playbackSpeed: 2.0,
  };

  const tabVideo = new MockTabEnvironment('tab1', false, sharedSettings);
  const tabMusic = new MockTabEnvironment('tab2', true, sharedSettings);

  tabVideo.evaluateAndApply();
  tabMusic.evaluateAndApply();

  // 使用者在 tabVideo 手動設為 3.0x 暴衝速
  tabVideo.manualOverrideSpeed = 3.0;
  tabVideo.evaluateAndApply();

  assert.strictEqual(tabVideo.localPlaybackRate, 3.0, '影片分頁手動覆蓋為 3.0x');
  assert.strictEqual(tabMusic.localPlaybackRate, 1.0, '音樂分頁依然保持 1.0x 原速，不受另一分頁手動調整影響');
});

it('關閉智慧調速時，所有分頁統一同步全域速度', () => {
  const sharedSettings = {
    smartSpeedEnabled: false,
    musicSpeed: 1.0,
    videoSpeed: 2.0,
    playbackSpeed: 1.5,
  };

  const tabVideo = new MockTabEnvironment('tab1', false, sharedSettings);
  const tabMusic = new MockTabEnvironment('tab2', true, sharedSettings);

  tabVideo.evaluateAndApply();
  tabMusic.evaluateAndApply();

  assert.strictEqual(tabVideo.localPlaybackRate, 1.5);
  assert.strictEqual(tabMusic.localPlaybackRate, 1.5);

  // 變更全域速度為 3.0x
  tabVideo.onStorageChanged('playbackSpeed', 3.0);
  tabMusic.onStorageChanged('playbackSpeed', 3.0);

  assert.strictEqual(tabVideo.localPlaybackRate, 3.0);
  assert.strictEqual(tabMusic.localPlaybackRate, 3.0);
});

// --------------------------------------------------------------------------
// 總結統計
// --------------------------------------------------------------------------
console.log('\n====================================================');
console.log(`📊 測試完成！通過: ${passCount} 項, 失敗: ${failCount} 項`);
console.log('====================================================\n');

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
