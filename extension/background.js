// Background service worker
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Chess AI Hub] Extension installed');
});

// 监听来自 content script 的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_ANALYSIS') {
    // Proxy to local API (避免 CORS)
    fetch(`http://localhost:3002/api/engine/analyze?variant=chess&depth=20&multipv=3`)
      .then(response => response.json())
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // 异步响应
  }
});
