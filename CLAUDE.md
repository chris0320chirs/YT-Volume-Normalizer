# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器與真隨機)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器與真隨機**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 當前版本：**v1.4.0 (純淨抗噪零破音架構)**
* 核心運作原則：
  1. **太小聲的影片**：自動平滑調高（安全上限 +12 dB），拯救微弱錄音，同時杜絕底噪放大。
  2. **太大聲的影片或廣告**：自動即刻調低（最高 -18 dB），防止突發爆音驚嚇。
  3. **目標音量範圍**：所有影片播放時，輸出音量嚴格維持在使用者在彈出視窗設定的音量範圍內。
  4. **零破音與抗底噪防護**：
     - **零溢出軟削頂器 (WaveShaper Soft Clipper, 4x Oversampling)**：最大輸出振幅硬性鎖定 $\le -0.5$ dBFS (峰值 $\le 0.945$)，徹底杜絕外接 DAC 與音效卡削頂爆裂破音 (Clipping Crackles)。
     - **智慧抗底噪門限與向下擴展 (Smart Noise Floor Gate & Downward Expander)**：門限 -46 dBFS，對話暫停時凍結 AGC 並溫和衰減 -8 dB，杜絕每句話之間的「沙沙沙」底噪抽吸 (Pumping)。
     - **消除波形調制失真**：優化為 10:1 平滑廣播壓縮比，釋放時間拉長至 380ms，消除男低音波形粗糙毛刺感。
     - **移除冗餘 Delay 節點**：拔除主音訊通道 25ms 延遲，解決藍牙耳機 Buffer Underruns 與 Seek 進度跳轉雜音。
     - **0.35dB 滯後防抖死區**：消除頻繁 parameter automation 引發的拉鍊噪音 (Zipper Noise)。
  5. **播放清單真隨機 (True Shuffle)**：
     - 破除 YouTube 演算法加權偏頗與少數歌曲循環，真正均勻無重複隨機輪播清單。
     - **預設關閉**且**不記憶**（使用 `chrome.storage.session`），每次關閉 Chrome 瀏覽器後自動還原為關閉。

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
* 隨機引擎: Fisher-Yates 均勻隨機算法、YouTube SPA 路由點擊導航與 `ended` / Next 攔截。
* 通訊架構: `chrome.storage.local`（音量全域持久化）、`chrome.storage.session`（真隨機單次有效）、`chrome.tabs.connect`（30fps 即時傳輸）
* 介面工藝: 原生 HTML5 / CSS3 / Vanilla JS（依據 Design Craft 排版）

## 📋 當前狀態與開發進度
* [x] 專案初始化完成 (Git / .gitignore / CLAUDE.md)
* [x] 生成高質感等化器圖示 (16x16, 48x48, 128x128 PNG)
* [x] 完成 Manifest V3 宣告檔 (`manifest.json` v1.4.0)
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
* [x] 播放清單真隨機 (True Shuffle) 引擎 (`content/content.js`)
  - [x] 預設關閉、Session Storage 單次有效（重開 Chrome 自動關閉）
  - [x] 攔截影片結束與下一首點擊，均勻隨機選取未播歌曲
* [x] 現代暗黑質感控制面板 (`popup/popup.html`, `popup.css`, `popup.js`)
  - [x] 目標固定音量調節滑桿 (0% ~ 150%)
  - [x] 醒目三態動態指示燈 (`[ ⬆️ 太小・自動調高 ]` / `[ 🎯 在設定範圍內 ]` / `[ ⬇️ 太大・自動調低 ]`)
  - [x] 音量範圍嚴格度選擇 (嚴格 ±1dB 預設 / 標準 ±2dB / 寬鬆 ±3.5dB)
  - [x] 等化風格模式 (📻 廣播級恆定 10:1 / 🗣️ 人聲強效 / 🎵 音樂原味)
  - [x] 播放清單真隨機開關與即時清單狀態顯示
  - [x] 目標區間動態 VU 量表與零破音防護徽章

## ⚠️ 開發規範與注意事項
* 預設回應語言：繁體中文 (Traditional Chinese)。
* 嚴禁擅自刪除任何檔案、資料、程式碼、紀錄或設定；刪除前須主動說明並獲得確認。
* 所有檔案修改維持高可讀性與清晰註釋。
