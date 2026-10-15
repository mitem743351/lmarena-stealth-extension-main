/* LMArena Stealth — service worker: toolbar badge with the hidden-model count. */

chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (msg && msg.t === 'models' && sender && sender.tab && sender.tab.id != null) {
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#7c3aed', tabId: sender.tab.id });
      chrome.action.setBadgeText({ text: String(msg.n || ''), tabId: sender.tab.id });
    } catch (e) {}
  }
  return false;
});

chrome.tabs.onUpdated.addListener(function (tabId, info) {
  if (info.status === 'loading') {
    try { chrome.action.setBadgeText({ text: '', tabId: tabId }); } catch (e) {}
  }
});