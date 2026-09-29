# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器與真隨機)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器與真隨機**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 當前版本：**v1.9.3 (根治音量忽大忽小抽吸・向下擴展防抖・AGC動態平穩化 ＆ 多分頁背景速度隔離加固)**
* 核心運作原則：
  1. **根治音量忽大忽小抽吸與動態平穩化 (v1.9.3 新增)**：
     - **向下擴展閘門防抖與持時延長 (Hold Time 1.2s)**：將抗底噪閘門觸發門限由 150ms 延長至 1.2 秒（24 幀），徹底消除說話句子間歇或音樂音符切換時每秒頻繁在 1.0 (0dB) 與 0.4 (-8dB) 間劇烈跳動引發的抽吸斷續感；長時靜音衰減由 -8dB 溫和化為 -3.1dB (0.70x)，搭配 400ms 慢速 ramp，過渡平滑無痕。
     - **宏觀 AGC 滑動視窗擴增與 1.5dB 防抖死區**：滑動視窗擴展為 7.0 秒（140 幀），累積至少 25 幀有效訊號才調整；滯後死區拓寬為 1.5dB，過渡改採 2.0 秒極平滑 slew，自然動態起伏（主歌/副歌）不再誘發 AGC 盲目追逐。
     - **廣播壓平機工作點對齊 (Leveler Compressor)**：門限由 -24dBFS 調整至 -18.0dBFS，比率調整為 3.5:1 平滑廣播級（音樂模式 2.5:1），徹底消滅壓縮器與 AGC 在 -21dBFS 處互搏形成的抽吸震盪。
  2. **多分頁背景速度獨立隔離加固 (v1.9.3 加固)**：
     - **杜絕 storage.onChanged 跨分頁記憶體污染**：當 `smartSpeedEnabled` 開啟時，背景分頁收到 storage 變更時嚴格跳過 `playbackSpeed` 同步，保護背景音樂分頁（1.0x）絕不被前景影片分頁（2.0x）覆寫。
     - **拔除 findAndHookVideo 盲目覆寫**：移除 1.5 秒維護定時器內強制覆寫 `video.playbackRate = currentSettings.playbackSpeed` 之破壞性邏輯。
     - **寫入權限嚴格綁定前景分頁**：`ratechange` 與同步邏輯僅在 `document.visibilityState === 'visible'` 時允許更新 storage。
  3. **滑鼠滾輪即時調音 (v1.9.2 新增)**：
     - **Popup 目標音量滑桿滾輪微調**：滑鼠懸停於擴充功能彈窗「目標聆聽音量」滑桿條（`#target-slider`）及卡片區域（`.slider-box` / `.volume-card`）時，支援滑鼠滾輪直接微調（向上 +2%、向下 -2%、按住 Shift 鍵 1% 極致微調、快速滾動 5%），自動在 0% ~ 100% 區間安全夾緊並同步即時更新數值與後台音訊增益。
     - **YouTube 原生播放器音量條滾輪微調**：滑鼠懸停於 YouTube 原生底欄音量區域（`.ytp-volume-area`、`.ytp-volume-panel`、`.ytp-volume-slider` 及 Shorts 聲音按鈕）時，支援滑鼠滾輪直接調整音量（5% 標準步長，對齊原生方向鍵；Shift 鍵 1% 微調），徹底攔截並阻止網頁隨滾輪上下捲動，靜音狀態下調高音量自動解除靜音，並透過 `page_bridge.js` 呼叫 YouTube 官方 Player API `player.setVolume()` 與 `<video>.volume` 雙向同步。
     - **倍速選單面板滑桿滾輪微調**：播放器懸浮倍速面板中的速度滑桿條（`#ytp-speed-slider-input`）同步支援滾輪微調（步長 0.05x，Shift 0.01x），操作體驗全域一致。
  2. **固定畫質零延遲起播與杜絕低畫質預載 (v1.9.1 新增)**：
     - **`localStorage['yt-player-quality']` 雙向同步持久化**：在 MAIN 世界第 0 毫秒同步讀寫 YouTube 原生本地儲存鍵，使 YouTube 播放器內部 ABR 引擎在初始載入 Manifest 前直接以鎖定畫質為首選，徹底消滅以 360p/480p 低解析度發起初始分段請求的根因。
     - **拔除人工延遲與零延遲階梯鎖定 (Zero-Delay Quality Ladder)**：徹底移除 `page_bridge.js` 舊版 300ms/1000ms 與 `content.js` 150ms 人工延遲；改採 0ms 立即同步執行 `applyQuality`，並搭配 `[20, 60, 150, 300, 600, 1200]ms` 密集微間隔階梯重試，確保播放器與清晰度清單就緒瞬間 100% 命中鎖定。
     - **全生命週期事件深層攔截**：監聽 `yt-navigate-start`（點擊新片 0ms）、`yt-navigate-finish`、`yt-page-data-updated`，以及 `<video>` 的 `loadstart`、`loadedmetadata`、`canplay`、`playing`，全鏈路不留死角。
     - **播放器狀態機監聽 (`onStateChange` & `onPlaybackQualityChange`)**：當播放器進入 UNSTARTED (-1) 或 BUFFERING (3) 時立即套用；若 YouTube ABR 在串流中試圖偷偷降級，即刻主動矯正還原。
  2. **YouTube Shorts 直式短影音全面支援 (v1.9.0 新增)**：
     - **多 Reel DOM 智慧動態追蹤**：Shorts 同時常駐多個 `<ytd-reel-video-renderer>`，透過 `getActiveVideo()` 與 `getActivePlayer()` 動態鎖定 `[is-active]` 作用中元素，杜絕鎖定預載影片或滑動後失效的問題。
     - **Web Audio 管線節點快取與熱拔插 (Hot-Swapping)**：每個 `<video>` 節點快取 `__ytNormalizerSource`，滑動換片時平穩斷開舊節點並連接新節點，徹底杜絕重複建立造成的 `InvalidStateError` 與記憶體洩漏。
     - **Shorts 專屬側邊操作列倍速按鈕**：在 Shorts `#actions` 側邊操作欄頂部注入現代半透明圓形玻璃徽章按鈕 (`#ytp-shorts-speed-btn`)，點擊向左滑順展開旗艦倍速面板，原生鍵盤快捷鍵（`<`、`>`、`Shift+S`、`Shift+3`）與中央 HUD Toast 100% 同步運作。
     - **Shorts 原聲與音樂智慧調速**：整合 Shorts 原生配樂標籤、音訊作者與標題音樂關鍵字分析，配樂短片自動降為 1.0x 原速，一般短影音自動以 2.0x 高速播放。
     - **速率變更精確過濾**：`ratechange` 監聽器精準過濾非 activeVideo 之事件干擾，防止預載背景影片觸發非預期覆蓋。
  3. **零控制台拋錯與重載孤兒自我銷毀 (v1.8.4~v1.8.8 多層加固)**：
     - **版本化 LOADED 旗標 (v1.8.8)**：改用 `__YT_VOLUME_NORMALIZER_1_8_8__` 版本化旗標，確保舊版殭屍腳本不阻擋新版載入，主控台輸出版本確認標識。
     - **全域護盾 URL 匹配修正**：`event.filename` 匹配改為 `chrome-extension://`，確保所有來自擴充功能的錯誤都被正確攔截（防範 Chrome 實際 URL 格式不符）。
     - **MutationObserver Debounce 節流**：YouTube SPA 換頁時 DOM 劇烈變動，加入 300ms debounce，防止爆發大量競態 `insertBefore` 調用。
     - **孤兒實例自我銷毀機制 (Anti-Orphan Teardown)**：定時器與 Watchdog 均主動檢查 `isExtensionValid()`，當擴充套件重新載入或上下文失效時，立即自我清除所有 `setInterval` 並斷開 `MutationObserver`，杜絕任何未刷新分頁產生的殭屍任務拋錯。
     - **全域例外攔截護盾 (Global Error Shield)**：監聽 `window.addEventListener('error')` 與 `unhandledrejection`，自動攔截內部潛在例外並執行 `preventDefault()`，確保 Chrome 擴充功能錯誤記錄器維持 0 報錯。
     - **安全 DOM 注入與脫鉤保護**：全面採用 `referenceNode.parentNode.insertBefore` 與 `isConnected` 檢測，即使 YouTube 播放器組件動態脫鉤或銷毀，外層全量包裹 `try-catch` 容錯，徹底杜絕任何未捕獲例外。
  2. **太小聲的影片**：自動平滑調高（安全上限 +12 dB），拯救微弱錄音，同時杜絕底噪放大。
  3. **太大聲的影片或廣告**：自動即刻調低（最高 -18 dB），防止突發爆音驚嚇。
  4. **目標音量範圍**：所有影片播放時，輸出音量嚴格維持在使用者在彈出視窗設定的音量範圍內（50% 基準點）。
  5. **智慧歌曲辨識自動調速與多分頁切換同步 (Smart Speed & Multi-Tab Isolation，v1.8.2 加強)**：
     - 8 層級 YouTube 官方與語義混合辨識（Category: Music、musicVideoType、Topic 官方頻道、藝人認證徽章、說明欄版權資訊、白名單歌單、標題強特徵）。
     - 聽歌 / 音樂歌曲時自動套用 **1.0x 原速**；一般影片時自動套用 **2.0x 倍速**。
     - **多分頁獨立隔離 (Tab-Level Isolation)**：開多個分頁時（例如一個分頁看片、另一個分頁聽歌），各分頁依自身內容獨立維持速度，徹底杜絕跨分頁 storage 污染。
     - **分頁切換即時同步 (Tab Switch Auto Sync)**：監聽 `visibilitychange`、`focus` 與 Background `tabs.onActivated`，切換進分頁時 0 秒即刻對齊該分頁的情境倍速，並同步更新控制列與 Popup 狀態。
     - 單片手動覆蓋保護（Manual Override）：單一影片手動覆蓋僅限本分頁，換片前不強制重設，換片後自動重新評估。
     - 播放器底欄 `#ytp-speed-btn` 即時回饋紫色微光 `🎵 1.0x` 或 `⚡ 2.0x`。
  6. **固定畫質 (Lock Quality，參考 YouTube Tweak)**：
     - 使用者可自由鎖定偏好解析度（自動 / 1080p FHD / 1440p 2K / 4K / 720p HD）。
     - 換片時自動強制套用；若影片不支援設定畫質，智慧向下 Fallback 至最接近的最高可用畫質。
     - 與純聽音樂模式完美聯動：純音黑屏時降至 144p 省電，關閉純音時自動秒速還原使用者鎖定之畫質。
   7. **3倍速按鈕 ＆ 現代旗艦倍速面板 (Modern Flagship Speed Panel，v1.8.7 支援原生快捷鍵與 HUD)**：
      - 突破 YouTube 官方 2.0x 限制，直接在播放器底欄注入專屬 `⚡倍速按鈕`。
      - **原生鍵盤快捷鍵全面支援 (v1.8.7)**：
        - `<` (`Shift+,`)：減慢播放速度（每次 -0.25x，下限 0.25x）。
        - `>` (`Shift+.`)：加快播放速度（每次 +0.25x，突破 2.0x 限制至最高 3.00x）。
        - `Shift+S`：循環切換常用倍速 (1.0x -> 1.5x -> 2.0x -> 3.0x)。
        - `Shift+3`：一鍵直達 3.0x 暴衝倍速。
        - **播放器即時 HUD Toast**：按下快捷鍵時於播放器居中彈出高質感半透明玻璃磨砂 HUD 徽章，秒級反饋當前速度。
        - **智能 ratechange 同步**：徹底根除舊版 ratechange 誤將快捷鍵與原生選單視為偷改而反覆重設回 1.0x 的問題；在廣告結束時精確還原，在使用者調整時主動同步並尊重手動調整。
      - **點擊彈出旗艦倍速面板**：點擊按鈕即刻在正上方展開半透明磨砂面板（對齊現代串流影音體驗）：
        - **32px 超大焦點數值**：居中顯示當前即時倍速（如 `1.00x`、`1.25x`、`2.00x`、`⚡ 3.00x`），自帶情境狀態標籤。
        - **無段微調步進器與滑桿**：`[-]` / `[+]` 圓形微調鈕（步長 0.05x，範圍 0.25x ~ 3.00x）＋ 自適應動態填色滑桿。
        - **常用倍速膠囊列**：精選 `1.0 (正常)`、`1.25`、`1.5`、`2.0`、`3.0`，一鍵直達。
        - **一鍵恢復智慧調速**：手動覆蓋時底部顯示「🤖 恢復智慧調速 (聽歌1.0x / 看片2.0x)」按鈕。
      - 點擊外部、標題列返回、按 `Escape`、視窗縮放或全螢幕切換時自動收合。
  8. **播放清單自動隨機白名單 (Auto Shuffle for Whitelist Playlists)**：
     - **特定歌單自動隨機**：支援輸入播放清單 ID（純 ID 或完整 YouTube 網址智慧解析），持久化儲存於 `chrome.storage.local`。
     - **遇白名單清單自動啟動**：載入或換片至白名單內的播放清單時，**自動開啟真隨機播放**；離開白名單清單時**自動還原關閉**，保護教學或連貫劇集體驗。
     - **主介面一鍵星號快捷**：在 YouTube 播放清單時，直接提供 `[⭐自動隨機]` / `[★已設自動隨機 (移除)]` 一鍵切換，無需手動複製 ID。
  9. **純聽音樂模式 (Music Mode 畫面遮擋與省電防中斷，v1.8.6 播放防卡頓加固)**：
     - **分頁獨立狀態 (Per-Tab Isolation)**：音樂模式為純分頁本地狀態，不寫入 `chrome.storage.local` 且不跨分頁同步，分頁 A 隱藏僅分頁 A 隱藏，分頁 B 絕不被波及。
     - **白名單歌單自動預設開啟音樂模式**：進入白名單歌單時，除了自動真隨機與 1.0x 外，**自動勾選並啟用純聽音樂模式（隱藏畫面）**；離開白名單清單時自動還原關閉。若使用者手動按 Shift+M 切換，即刻解除自動接管，尊重使用者選擇。
     - **全域 CSS 物理級壓制與 Video 解碼時鐘守護 (v1.8.6)**：`<video>` 元素嚴格採用 `opacity: 0 !important; pointer-events: none !important;`（絕不使用 `visibility: hidden`，徹底杜絕 Chromium 觸發 Background Video Suspend 導致音訊解碼時鐘中斷卡死）；字幕與浮動資訊卡維持 `visibility: hidden !important;`。
     - **高層級沉浸遮罩 (`z-index: 58 !important`)**：位於底欄控制列 (`z-index: 60`) 之下、所有畫面與字幕之上，兼顧沉浸感與底欄操控性。點擊空白處透過官方 Player API 安全同步 Play/Pause。
     - **144p 省電降頻節流與單次發送防抖 (v1.8.6)**：開啟遮罩時將影片解析度降至 `small` (144p)，僅在切換或新影片初次時發送一次訊息，杜絕 1.5 秒 UI 輪詢反覆發送指令打斷 YouTube DASH 緩衝區。關閉時安全還原鎖定畫質。
     - **Watchdog 安全防中斷與廣告防誤殺機制 (v1.8.6)**：自動跳過 YouTube 暫停確認彈窗；嚴格僅在播放器真正處於 `ad-showing` / `ad-interrupting` 狀態時點擊跳過或加速廣告，徹底移除誤判常駐 `.ytp-ad-player-overlay` DOM 與篡改 `video.currentTime = video.duration` 的致命 Bug，保證正常影片流暢播放絕不卡死。
  10. **零破音與抗底噪防護**：
     - **零溢出軟削頂器 (WaveShaper Soft Clipper, 4x Oversampling)**：最大輸出振幅硬性鎖定 $\le -0.5$ dBFS (峰值 $\le 0.945$)，徹底杜絕外接 DAC 與音效卡削頂爆裂破音 (Clipping Crackles)。
     - **智慧抗底噪門限與向下擴展 (Smart Noise Floor Gate & Downward Expander)**：門限 -46 dBFS，對話暫停時凍結 AGC 並溫和衰減 -8 dB，杜絕每句話之間的「沙沙沙」底噪抽吸 (Pumping)。
     - **消除波形調制失真**：優化為 10:1 平滑廣播壓縮比，釋放時間拉長至 380ms，消除男低音波形粗糙毛刺感。
     - **移除冗餘 Delay 節點**：拔除主音訊通道 25ms 延遲，解決藍牙耳機 Buffer Underruns 與 Seek 進度跳轉雜音。
     - **0.35dB 滯後防抖死區**：消除頻繁 parameter automation 引發的拉鍊噪音 (Zipper Noise)。
  9. **播放清單真隨機 (True Shuffle)**：
     - 破除 YouTube 演算法加權偏頗與少數歌曲循環，真正均勻無重複隨機輪播清單。
     - 一般清單預設關閉且單次有效（使用 `chrome.storage.session`），每次關閉 Chrome 瀏覽器後自動還原為關閉。

## 🛠️ 技術棧與核心架構 (Tech Stack & Architecture)
* 平台規範: Chrome Extension Manifest V3 (Service Worker + Isolated Content Script + MAIN World Bridge + Popup)
* 核心音訊: HTML5 Web Audio API
  - **智慧抗底噪向下擴展 (Downward Expander)**: -46 dBFS 門限，安靜間歇自動衰減 -8 dB，語音活躍即刻復原。
  - **廣播級平滑壓平機 (DynamicsCompressorNode)**: 核心硬體級壓平，Threshold -24dBFS，Ratio 10:1，Knee 18dB，Attack 8ms，Release 380ms。
  - **YouTube 官方 Content Loudness 預讀 (page_bridge.js)**: 運行於 MAIN world，於影片載入第 0 秒讀取後台轉檔響度偏差並預置初始增益。
  - **雙軌動態 AGC 連續跟蹤 (帶 0.35dB 防抖死區)**: 長期 Leq RMS 滑動視窗實時微調宏觀基底，安全增益限制在 [-18dB, +12dB]。
  - **前級瞬態平滑器 (Fast Peak Limiter)**: -1.5 dBFS 快速捕獲突發大動態。
  - **4x 超取樣零溢出軟限制器 (WaveShaper Soft Clipper)**: 雙曲正切數學平滑飽和，絕對天花板 -0.5 dBFS，0 延遲零溢出保護。
  - **零乾音洩漏保護 (Zero Dry Leakage)**: 明確初始化 dryGain 為 0，停用時平滑旁路。
  - **單例節點複用機制**: SPA 換片不重複建立管線節點，杜絕梳狀濾波與記憶體洩漏。
* 隨機與背景引擎: Fisher-Yates 均勻隨機算法、YouTube SPA 路由點擊導航與 `ended` / Next 攔截。
* 純音防中斷引擎: 自動跳過暫停確認彈窗、廣告快轉跳過、144p 節流訊息橋接。
* 介面工藝: 原生 HTML5 / CSS3 / Vanilla JS（依據 Design Craft 排版，零滾動條、三核心功能一目了然、進階設定優雅收合）

## 📋 當前狀態與開發進度
* [x] 專案初始化完成 (Git / .gitignore / CLAUDE.md)
* [x] 生成高質感等化器圖示 (16x16, 48x48, 128x128 PNG)
* [x] 完成 Manifest V3 宣告檔 (`manifest.json` v1.6.0)
* [x] 建立 Background Service Worker (`background/background.js`) 開放 session 權限
* [x] 純淨抗噪零破音等化核心引擎 (`content/content.js`，v1.9.3 根治忽大忽小與抽吸)
  - [x] 杜絕乾音洩漏 (Zero Dry Leakage)
  - [x] 零溢出軟限制器 (WaveShaper Soft Clipper 4x Oversampling)
  - [x] 智慧抗底噪向下擴展 (Downward Expander)：Hold Time 延長至 1.2s，溫和衰減 -3.1dB，杜絕每句話語音抽吸
  - [x] 廣播級 3.5:1 平滑工作點壓平機，450ms 溫和釋放，徹底消滅壓縮器與 AGC 互搏
  - [x] 官方 Content Loudness 0 秒快照跳起 (Jump-Start)
  - [x] 連續性動態 AGC 滑動 Leq 微調 (視窗 7.0s 帶 1.5dB 防抖死區與 2.0s 慢速過渡)
  - [x] 多分頁背景速度獨立隔離加固：防範 `storage.onChanged` 記憶體污染與移除定時器盲目覆寫，背景音樂 1.0x 絕不變 2.0x
  - [x] 拔除冗餘延遲節點，解決藍牙時鐘抖動與 Seek 雜音
* [x] 滑鼠滾輪即時調音與滑桿微調 (v1.9.2 新增)
  - [x] Popup 目標音量滑桿滾輪：滑鼠滾輪直接增減音量（預設 2%、Shift 鍵 1%、快速滾動 5%），自動 [0%, 100%] 安全夾緊
  - [x] YouTube 原生播放器音量條滾輪：滑鼠懸停於 `.ytp-volume-area` / `.ytp-volume-panel` / `.ytp-volume-slider` / Shorts 聲音按鈕時滾動滾輪，阻止頁面上下捲動，依 5% 原生步長（Shift 1%）即時調整音量，靜音時自動解除靜音
  - [x] 倍速選單面板滑桿滾輪：懸浮倍速面板速度滑桿條 (`#ytp-speed-slider-input`) 支援滾輪微調（步長 0.05x，Shift 0.01x）
* [x] 固定畫質引擎 (Lock Quality，參考 YouTube Tweak，v1.9.1 零延遲起播升級)
  - [x] 支援 Auto / 1080p / 1440p / 4K / 720p 偏好鎖定
  - [x] 換片智慧向下 Fallback 至最接近之最高可用解析度
  - [x] 與純音模式連動：解除純音時自動還原使用者鎖定畫質
  - [x] YouTube 原生 `localStorage['yt-player-quality']` 雙向同步持久化（消滅 360p/480p 初始預載）
  - [x] 零延遲階梯鎖定架構 (0ms 立即套用 ＋ 20ms/60ms/150ms/300ms 快速階梯重試)
  - [x] 全生命週期深層攔截 (`yt-navigate-start`、`loadstart`、`loadedmetadata`、`canplay`)
  - [x] 播放器狀態機即刻鎖定與自動防偷降級矯正 (`onStateChange` & `onPlaybackQualityChange`)
* [x] 3倍速按鈕 ＆ 現代旗艦倍速面板 (Modern Flagship Speed Panel)
  - [x] YouTube 播放器控制列專屬 `⚡倍速按鈕` (`#ytp-speed-btn`)，點擊展開 32px 大字、[-] 滑桿 [+] 與常用膠囊面板
  - [x] 常用倍速膠囊列 (`1.0 正常` / `1.25` / `1.5` / `2.0` / `3.0`)
  - [x] 支援一鍵「🤖 恢復智慧調速」切換回智慧接管
  - [x] 點擊外部、標題列或按 Escape 自動收合選單
  - [x] 原生鍵盤快捷鍵 `<` (`Shift+,`) 減速 ＆ `>` (`Shift+.`) 加速 (步長 0.25x，範圍 0.25x ~ 3.00x)
  - [x] 鍵盤快捷鍵 `Shift+S` (循環調速) ＆ `Shift+3` (直達 3.0x 暴衝倍速)
  - [x] 播放器即時 HUD Toast：快捷鍵觸發時於畫面正中秒級彈出半透明磨砂 Bezel 動畫
  - [x] 智能 `ratechange` 事件監聽器：廣告中跳過、廣告剛結束還原預期倍速、原生齒輪選單調整自動同步
  - [x] 控制面板整合 4 顆精簡倍速膠囊按鈕 (`1.0x` / `1.5x` / `2.0x` / `⚡3.0x`)
  - [x] 全域倍速格式化一致性 (formatSpeedText，v1.8.8)：精確保留兩位小數 (1.75x, 1.25x, 0.75x) 並維持整數/一位小數簡潔性 (1.0x, 2.0x)，徹底杜絕中央 HUD (1.75x) 與右下角按鈕徽章 (誤顯 1.8x) 數值衝突，同步支援慢速 (< 1.0x) 暖黃微光徽章樣式 (`speed-slow`)
* [x] YouTube Shorts 直式短影音全功能相容 (YouTube Shorts Integration，v1.9.0 新增)
  - [x] 多 Reel DOM 動態追蹤：`getActiveVideo()` 與 `getActivePlayer()` 即時綁定當前 `[is-active]` 節點
  - [x] Web Audio API 節點熱拔插：滑動換片自動斷開舊節點，復用 `__ytNormalizerSource` 杜絕 InvalidStateError
  - [x] Shorts 專屬側邊操作列倍速按鈕 (`#ytp-shorts-speed-btn`)，點擊向左滑順展開旗艦倍速面板
  - [x] Shorts 原聲/音樂智慧調速：配樂/音樂標籤短片 1.0x 原速，一般短影音 2.0x 高速播放
  - [x] 鍵盤快捷鍵 (< / > / Shift+S / Shift+3 / Shift+M) 與中央 HUD Toast 100% 完整支援
  - [x] 智能 `ratechange` 事件過濾：排除預載背景影片干擾，僅對 activeVideo 生效
* [x] 智慧歌曲辨識自動調速引擎 (Smart Speed Context Detection，v1.8.0 新增)
  - [x] 8 層級全方位音樂歌曲特徵辨識 (Category: Music, musicVideoType, Topic 頻道, 藝人認證徽章, 說明欄版權資訊, 白名單歌單, 標題強關鍵字)
  - [x] 換片智慧自動調速：音樂歌曲自動切換 1.0x 原速，一般影片自動切換 2.0x 倍速
  - [x] 單片手動覆蓋保護 (Manual Override)：手動調整當前影片速度後不強制重設，換片後自動重新評估
  - [x] 播放器底欄 `#ytp-speed-btn` 即時回饋紫色微光 `🎵 1.0x` 或 `⚡ 2.0x`
  - [x] 控制面板整合情境動態膠囊徽章與進階微調開關

* [x] 純聽音樂模式 (Music Mode 畫面遮擋與防中斷，v1.8.6 播放防卡頓加固)
  - [x] 分頁獨立隔離 (Per-Tab Isolation)：切換僅影響當前分頁，不寫入全域 storage，不干擾其他分頁
  - [x] 白名單歌單自動開啟音樂模式 (Auto Music Mode on Whitelist)：進入白名單歌單自動遮擋畫面，離開自動還原
  - [x] 沉浸式暗黑遮罩與音波動畫 (`#yt-music-mode-overlay`)，點擊空白處透過官方 Player API 同步 Play/Pause
  - [x] 解除 Video 解碼懸吊：`<video>` 改用 `opacity: 0` 防止 Chromium 暫停解碼時鐘，字幕維持 `visibility: hidden`
  - [x] 144p 切換防抖節流：僅在狀態切換或新影片時發送一次，避免 1.5s 輪詢反覆打斷 YouTube DASH 緩衝
  - [x] Watchdog 防誤殺正常影片：嚴格檢查 `ad-showing`，移除 `.ytp-ad-player-overlay` 誤判與篡改 `video.currentTime` 破壞性操作
  - [x] YouTube 播放器控制列專屬快捷按鈕 (`#ytp-music-mode-btn`)
  - [x] 鍵盤快捷鍵 `Shift+M` 秒速切換
  - [x] 自動跳過 YouTube「影片已暫停。要繼續觀看嗎？」中斷彈窗
  - [x] 純音模式下遇廣告自動點擊跳過或溫和加速通過，絕不卡死
* [x] 播放清單真隨機 (True Shuffle) 引擎 (`content/content.js`)
  - [x] 預設關閉、Session Storage 單次有效（重開 Chrome 自動關閉）
  - [x] 攔截影片結束與下一首點擊，均勻隨機選取未播歌曲
* [x] 播放清單自動隨機白名單 (Auto Shuffle Whitelist)
  - [x] 支援輸入播放清單 ID 或貼上 YouTube 網址智慧解析
  - [x] 遇到白名單清單時自動啟動真隨機，離開白名單清單自動還原關閉
  - [x] 主介面 True Shuffle 卡片整合一鍵 `[⭐自動隨機]` 星號快捷切換
  - [x] 進階微調面板整合白名單標籤展示箱 (Tag Chips) 與快捷加入當前清單列
* [x] 現代極簡 Design Craft 控制面板 (`popup/popup.html`, `popup.css`, `popup.js`)
  - [x] 寬度 326px 緊湊精緻版面，零滾動條，一目了然
  - [x] 大字級目標音量滑桿 (0% ~ 100%，50% 基準點一鍵重設)
  - [x] 科技感極簡即時動態指示膠囊與 3px 高精度 VU 能量線
  - [x] 播放速度與固定畫質卡片 (四速膠囊切換 + 畫質下拉選單)
  - [x] 核心開關清單 (純聽音樂模式 + 播放清單真隨機與白名單自動隨機)
  - [x] 優雅收合之進階微調選單 (分段膠囊按鈕調整嚴格度/調音風格 + 白名單歌單管理)

## 🎯 下一階段待辦事項 (Todo)
* [ ] 實測長時播放 YouTube 歌單與微弱 Podcast，驗證長期聆聽穩定度。
* [ ] Chrome Web Store 上架商店文案與宣傳截圖整理。

## ⚠️ 開發規範與注意事項
* 預設回應語言：繁體中文 (Traditional Chinese)。
* 嚴禁擅自刪除任何檔案、資料、程式碼、紀錄或設定；刪除前須主動說明並獲得確認。
* 所有檔案修改維持高可讀性與清晰註釋。
