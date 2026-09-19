# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器與真隨機)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器與真隨機**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 當前版本：**v1.7.0 (自動隨機白名單歌單・固定畫質 ＆ 3倍速強化版)**
* 核心運作原則：
  1. **太小聲的影片**：自動平滑調高（安全上限 +12 dB），拯救微弱錄音，同時杜絕底噪放大。
  2. **太大聲的影片或廣告**：自動即刻調低（最高 -18 dB），防止突發爆音驚嚇。
  3. **目標音量範圍**：所有影片播放時，輸出音量嚴格維持在使用者在彈出視窗設定的音量範圍內（50% 基準點）。
  4. **固定畫質 (Lock Quality，參考 YouTube Tweak)**：
     - 使用者可自由鎖定偏好解析度（自動 / 1080p FHD / 1440p 2K / 4K / 720p HD）。
     - 換片時自動強制套用；若影片不支援設定畫質，智慧向下 Fallback 至最接近的最高可用畫質。
     - 與純聽音樂模式完美聯動：純音黑屏時降至 144p 省電，關閉純音時自動秒速還原使用者鎖定之畫質。
  5. **3倍速按鈕 ＆ 播放速度控制 (Speed Control，參考 YouTube Tweak)**：
     - 突破 YouTube 官方 2.0x 限制，直接在播放器底欄注入專屬 `⚡倍速按鈕`。
     - 點擊按鈕直接循環切換：`1.0x` ➔ `1.5x` ➔ `2.0x` ➔ `⚡3.0x` ➔ `1.0x`。
     - 全域快捷鍵：`Shift+S` 循環調速、`Shift+3` 一鍵直達 3.0x 暴衝倍速。
     - 自動防重設：監聽影片 `ratechange` 事件，防止 YouTube SPA 換片或廣告插播後被偷偷重設回 1.0x。
  6. **播放清單自動隨機白名單 (Auto Shuffle for Whitelist Playlists)**：
     - **特定歌單自動隨機**：支援輸入播放清單 ID（純 ID 或完整 YouTube 網址智慧解析），持久化儲存於 `chrome.storage.local`。
     - **遇白名單清單自動啟動**：載入或換片至白名單內的播放清單時，**自動開啟真隨機播放**；離開白名單清單時**自動還原關閉**，保護教學或連貫劇集體驗。
     - **主介面一鍵星號快捷**：在 YouTube 播放清單時，直接提供 `[⭐自動隨機]` / `[★已設自動隨機 (移除)]` 一鍵切換，無需手動複製 ID。
  7. **純聽音樂模式 (Music Mode 畫面遮擋)**：
     - **優雅暗黑遮罩**：深邃沉浸純黑背景與唱片動畫，遮擋影片畫面，專注純音樂聽覺體驗。
     - **播放器控制列快捷按鈕**：直接在 YouTube 播放器右下角控制列注入專屬音樂圖標按鈕，一鍵秒切換。
     - **全域快捷鍵支援**：隨時按下 `Shift+M` 即刻切換遮擋與畫面。
     - **144p 省電降頻節流**：開啟遮罩時自動將影片解析度降至 `small` (144p)，大幅節省 85% GPU 解碼運算與網路頻寬，且音質完全不受影響；關閉時自動還原鎖定畫質。
     - **背景防中斷 Watchdog**：自動跳過 YouTube「影片已暫停。要繼續觀看嗎？」確認彈窗，並在純音模式下自動秒跳過廣告。
  8. **零破音與抗底噪防護**：
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
* [x] 3倍速按鈕 ＆ 倍速控制引擎 (Speed Control，參考 YouTube Tweak)
  - [x] YouTube 播放器控制列專屬 `⚡倍速按鈕` (`#ytp-speed-btn`)
  - [x] 鍵盤快捷鍵 `Shift+S` (循環調速) ＆ `Shift+3` (直達 3.0x 暴衝倍速)
  - [x] 監聽 `ratechange` 事件防止 YouTube 換片/廣告偷重設速度
  - [x] 控制面板整合 4 顆精簡倍速膠囊按鈕 (`1.0x` / `1.5x` / `2.0x` / `⚡3.0x`)
* [x] 純聽音樂模式 (Music Mode 畫面遮擋與防中斷)
  - [x] 沉浸式暗黑遮罩與音波動畫 (`#yt-music-mode-overlay`)
  - [x] YouTube 播放器控制列專屬快捷按鈕 (`#ytp-music-mode-btn`)
  - [x] 鍵盤快捷鍵 `Shift+M` 秒速切換
  - [x] 144p (small) 解析度切換，節省 85% GPU 算力與頻寬
  - [x] 自動跳過 YouTube「影片已暫停。要繼續觀看嗎？」中斷彈窗
  - [x] 純音模式下自動秒跳過廣告
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
