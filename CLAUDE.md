# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器與真隨機)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器與真隨機**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 核心運作原則：
  1. **太小聲的影片**：自動迅速平滑調高（最高 +24 dB，約 16 倍放大），拯救微弱錄音。
  2. **太大聲的影片或廣告**：自動即刻調低（最高 -24 dB，壓至 0.06 倍），防止突發爆音驚嚇。
  3. **目標音量範圍**：所有影片播放時，輸出音量嚴格維持在使用者在彈出視窗設定的音量範圍內。
  4. **播放清單真隨機 (True Shuffle)**：
     - 破除 YouTube 演算法加權偏頗與少數歌曲循環，真正均勻無重複隨機輪播清單。
     - **預設關閉**且**不記憶**（使用 `chrome.storage.session`），每次關閉 Chrome 瀏覽器後自動還原為關閉。

## 🛠️ 技術棧與核心架構 (Tech Stack & Architecture)
* 平台規範: Chrome Extension Manifest V3 (Service Worker + Isolated Content Script + MAIN World Bridge + Popup)
* 核心音訊: HTML5 Web Audio API
  - **廣播級 20:1 C++ DSP 壓平機 (DynamicsCompressorNode)**: 核心硬體級壓平，Threshold -28dBFS，Ratio 20:1，Knee 14dB，Attack 3ms，Release 220ms。徹底根絕音量落差。
  - **25ms Lookahead 前瞻緩衝 (DelayNode)**: 音訊路徑延遲 25ms，讓探測探針提前 0.025 秒探知未來波形，在爆音到達前平滑壓制。
  - **YouTube 官方 Content Loudness 預讀 (page_bridge.js)**: 運行於 MAIN world，於影片載入第 0 秒讀取後台轉檔響度偏差並預置初始增益。
  - **雙軌動態 AGC 連續跟蹤**: 長期 Leq RMS 滑動視窗實時微調宏觀基底，無感平滑，靜音閘門凍結杜絕底噪抽吸。
  - **零乾音洩漏保護 (Zero Dry Leakage)**: 明確杜絕未處理原始音訊洩漏。
  - **目標耳感化妝增益 (Target Makeup Gain)**: 平整後的音訊無級縮放至使用者指定的目標固定音量。
  - **磚牆式防破音保護器 (Brickwall Limiter)**: -0.5 dBFS 輸出端鎖定，任何情況絕不爆音破音。
* 隨機引擎: Fisher-Yates 均勻隨機算法、YouTube SPA 路由點擊導航與 `ended` / Next 攔截。
* 通訊架構: `chrome.storage.local`（音量全域持久化）、`chrome.storage.session`（真隨機單次有效）、`chrome.tabs.connect`（30fps 即時傳輸）
* 介面工藝: 原生 HTML5 / CSS3 / Vanilla JS（依據 Design Craft 排版）

## 📋 當前狀態與開發進度
* [x] 專案初始化完成 (Git / .gitignore / CLAUDE.md)
* [x] 生成高質感等化器圖示 (16x16, 48x48, 128x128 PNG)
* [x] 完成 Manifest V3 宣告檔 (`manifest.json` v1.3.0)
* [x] 建立 Background Service Worker (`background/background.js`) 開放 session 權限
* [x] 廣播級 20:1 壓平與智慧調高/調低核心引擎 (`content/content.js`)
  - [x] 杜絕乾音洩漏 (Zero Dry Leakage)
  - [x] 原生 C++ DynamicsCompressor 20:1 硬體級壓平
  - [x] 25ms Lookahead 前瞻預判緩衝
  - [x] 官方 Content Loudness 0 秒快照跳起 (Jump-Start)
  - [x] 連續性動態 AGC 滑動 Leq 微調
  - [x] 語音靜音閘門 (Silence Gate 凍結) 與磚牆防破音保護 (-0.5dBFS)
* [x] 播放清單真隨機 (True Shuffle) 引擎 (`content/content.js`)
  - [x] 預設關閉、Session Storage 單次有效（重開 Chrome 自動關閉）
  - [x] 攔截影片結束與下一首點擊，均勻隨機選取未播歌曲
* [x] 現代暗黑質感控制面板 (`popup/popup.html`, `popup.css`, `popup.js`)
  - [x] 目標固定音量調節滑桿 (0% ~ 150%)
  - [x] 醒目三態動態指示燈 (`[ ⬆️ 太小・自動調高 ]` / `[ 🎯 在設定範圍內 ]` / `[ ⬇️ 太大・自動調低 ]`)
  - [x] 音量範圍嚴格度選擇 (嚴格 ±1dB 預設 / 標準 ±2dB / 寬鬆 ±3.5dB)
  - [x] 等化風格模式 (📻 廣播級恆定 20:1 / 🗣️ 人聲強效 / 🎵 音樂原味)
  - [x] 播放清單真隨機開關與即時清單狀態顯示
  - [x] 目標區間動態 VU 量表

## ⚠️ 開發規範與注意事項
* 預設回應語言：繁體中文 (Traditional Chinese)。
* 嚴禁擅自刪除任何檔案、資料、程式碼、紀錄或設定；刪除前須主動說明並獲得確認。
* 所有檔案修改維持高可讀性與清晰註釋。
