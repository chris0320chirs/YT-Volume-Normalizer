# 專案名稱: YT影片音量固定 (YouTube 音量範圍鎖定器)

## 🎯 專案目標與簡介
* 本專案為適用於 Google Chrome 與 Microsoft Edge 的 Manifest V3 擴充套件（**YouTube 音量範圍鎖定器**）。
* GitHub 儲存庫：[https://github.com/chris0320chirs/YT-Volume-Normalizer](https://github.com/chris0320chirs/YT-Volume-Normalizer) (Public)
* 核心運作原則：
  1. **太小聲的影片**：自動迅速平滑調高（最高 +24 dB，約 16 倍放大），拯救微弱錄音。
  2. **太大聲的影片或廣告**：自動即刻調低（最高 -24 dB，壓至 0.06 倍），防止突發爆音驚嚇。
  3. **目標音量範圍**：所有影片播放時，輸出音量嚴格維持在使用者在彈出視窗設定的音量範圍內。
  4. **換片瞬時咬定**：切換新影片或 Shorts 時，於 0.1 秒內瞬時收斂至目標範圍，無延遲感。

## 🛠️ 技術棧與核心演算法 (Tech Stack & Architecture)
* 平台規範: Chrome Extension Manifest V3 (相容 Microsoft Edge、Brave 等 Chromium 瀏覽器)
* 核心音訊: HTML5 Web Audio API
  - **前饋式雙向分析**: 2048 點時域 RMS 採樣，即時偵測原始音量差距 $\Delta\text{dB}$。
  - **自適應調高/調低控制 (Adaptive Boost & Cut)**: 太小主動調高、太大主動調低。
  - **三態範圍判定**: `boosting` (太小調高) / `cutting` (太大調低) / `locked` (已在設定範圍內)。
  - **-62 dBFS 寬容閘門**: 既能拉升極小微弱人聲，又能在安靜停頓時鎖定增益防底噪。
  - **磚牆式防破音保護器 (Brickwall Limiter)**: 輸出端鎖定，任何情況絕不爆音破音。
* 通訊架構: `chrome.storage.local`（跨分頁全域同步）、`chrome.tabs.connect`（30fps 即時傳輸三態指示與補償數值）
* 介面工藝: 原生 HTML5 / CSS3 / Vanilla JS（依據 Design Craft 排版）

## 📋 當前狀態與開發進度
* [x] 專案初始化完成 (Git / .gitignore / CLAUDE.md)
* [x] 生成高質感等化器圖示 (16x16, 48x48, 128x128 PNG)
* [x] 完成 Manifest V3 宣告檔 (`manifest.json`)
* [x] 智慧調高/調低核心引擎 (`content/content.js`)
  - [x] 太小聲自動調高 (最高 +24 dB)
  - [x] 太大聲自動調低 (最高 -24 dB)
  - [x] 新片切換 0.1 秒瞬時收斂定位
  - [x] 雙重語音閘門與磚牆防破音保護
* [x] 現代暗黑質感控制面板 (`popup/popup.html`, `popup.css`, `popup.js`)
  - [x] 目標固定音量調節滑桿 (0% ~ 150%)
  - [x] 醒目三態動態指示燈 (`[ ⬆️ 太小・自動調高 ]` / `[ 🎯 在設定範圍內 ]` / `[ ⬇️ 太大・自動調低 ]`)
  - [x] 音量範圍嚴格度選擇 (嚴格 ±1dB / 標準 ±2dB / 寬鬆 ±3.5dB)
  - [x] 目標區間動態 VU 量表

## ⚠️ 開發規範與注意事項
* 預設回應語言：繁體中文 (Traditional Chinese)。
* 嚴禁擅自刪除任何檔案、資料、程式碼、紀錄或設定；刪除前須主動說明並獲得確認。
* 所有檔案修改維持高可讀性與清晰註釋。
