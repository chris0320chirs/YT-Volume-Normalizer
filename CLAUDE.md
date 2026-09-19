# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器與真隨機)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器與真隨機**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 當前版本：**v1.8.6 (純聽音樂模式遮擋畫面播放防卡頓加固・Watchdog 防誤殺正常影片・144p 切換防抖節流・Video 解碼懸吊解除)**
* 核心運作原則：
  1. **零控制台拋錯與重載孤兒自我銷毀 (v1.8.4~v1.8.6 多層加固)**：
     - **版本化 LOADED 旗標 (v1.8.6)**：改用 `__YT_VOLUME_NORMALIZER_1_8_6__` 版本化旗標，確保舊版殭屍腳本不阻擋新版載入，主控台輸出版本確認標識。
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
  7. **3倍速按鈕 ＆ 懸浮倍速選單 (Speed Control & Picker Menu，v1.8.6 改進)**：
     - 突破 YouTube 官方 2.0x 限制，直接在播放器底欄注入專屬 `⚡倍速按鈕`。
     - **點擊彈出精緻選單 (Speed Picker Menu)**：點擊按鈕即刻在正上方展開半透明磨砂選單，直覺點選目標倍速（`0.5x`、`0.75x`、`1.0x`、`1.25x`、`1.5x`、`1.75x`、`2.0x`、`2.5x`、`⚡3.0x`），取代原先繁瑣的循環點擊；支援一鍵「🤖 恢復智慧調速」。
     - 點擊外部或按 `Escape` 自動收合選單。
     - 全域快捷鍵維持支援：`Shift+S` 循環調速、`Shift+3` 一鍵直達 3.0x 暴衝倍速。
     - 自動防重設：監聽影片 `ratechange` 事件，防止 YouTube SPA 換片或廣告插播後被偷偷重設回 1.0x。
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
* [x] 純淨抗噪零破音等化核心引擎 (`content/content.js`)
  - [x] 杜絕乾音洩漏 (Zero Dry Leakage)
  - [x] 零溢出軟限制器 (WaveShaper Soft Clipper 4x Oversampling)
  - [x] 智慧抗底噪門限 (-46dBFS) 與向下擴展 (-8dB)
  - [x] 廣播級 10:1 平滑壓縮，380ms 自然釋放
  - [x] 官方 Content Loudness 0 秒快照跳起 (Jump-Start)
  - [x] 連續性動態 AGC 滑動 Leq 微調 (帶 0.35dB 防抖死區)
  - [x] 拔除冗餘延遲節點，解決藍牙時鐘抖動與 Seek 雜音
  - [x] 單例管線複用，徹底消除 SPA 導航重複節點疊加問題
* [x] 固定畫質引擎 (Lock Quality，參考 YouTube Tweak)
  - [x] 支援 Auto / 1080p / 1440p / 4K / 720p 偏好鎖定
  - [x] 換片智慧向下 Fallback 至最接近之最高可用解析度
  - [x] 與純音模式連動：解除純音時自動還原使用者鎖定畫質
* [x] 3倍速按鈕 ＆ 懸浮倍速選單 (Speed Control & Picker Menu)
  - [x] YouTube 播放器控制列專屬 `⚡倍速按鈕` (`#ytp-speed-btn`)，點擊彈出精緻選單 (0.5x ~ 3.0x)
  - [x] 支援一鍵「🤖 恢復智慧調速」切換回智慧接管
  - [x] 點擊外部或按 Escape 自動收合選單
  - [x] 鍵盤快捷鍵 `Shift+S` (循環調速) ＆ `Shift+3` (直達 3.0x 暴衝倍速)
  - [x] 監聽 `ratechange` 事件防止 YouTube 換片/廣告偷重設速度
  - [x] 控制面板整合 4 顆精簡倍速膠囊按鈕 (`1.0x` / `1.5x` / `2.0x` / `⚡3.0x`)
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
