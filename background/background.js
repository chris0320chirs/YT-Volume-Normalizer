/**
 * YouTube 音量範圍鎖定器 - Background Service Worker
 * 負責在擴充功能啟動時，開放 chrome.storage.session 供 Content Script 讀取，
 * 確保「真隨機」功能在關閉瀏覽器後 100% 自動重設為關閉。
 */

// 開放 session storage 權限給 content script
function initSessionAccess() {
  if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    }).catch((err) => {
      console.warn('[YT Volume Normalizer] 設定 session 權限提示:', err);
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initSessionAccess();
  // 確保初始 session 中的 trueShuffle 為 false (預設關閉)
  chrome.storage.session.set({ trueShuffle: false });
});

chrome.runtime.onStartup.addListener(() => {
  initSessionAccess();
  // 瀏覽器重新啟動時強制重設為關閉
  chrome.storage.session.set({ trueShuffle: false });
});

// 初始化調用
initSessionAccess();
