/**
 * YouTube 音量範圍鎖定器 - Background Service Worker
 * 負責在擴充功能啟動時，開放 chrome.storage.session 供 Content Script 讀取，
 * 確保「真隨機」功能在關閉瀏覽器後 100% 自動重設為關閉。
 */

function initSessionAccess() {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.setAccessLevel === 'function') {
      chrome.storage.session.setAccessLevel({
        accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
      }).catch((err) => {
        console.warn('[YT Volume Normalizer] 設定 session 權限提示:', err);
      });
    }
  } catch (err) {
    // 忽略未就緒例外
  }
}

function resetSessionShuffle() {
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === 'function') {
      chrome.storage.session.set({ trueShuffle: false }).catch(() => {});
    }
  } catch (err) {
    // 忽略未就緒例外
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initSessionAccess();
  resetSessionShuffle();
});

chrome.runtime.onStartup.addListener(() => {
  initSessionAccess();
  resetSessionShuffle();
});

// 初始化調用
initSessionAccess();

