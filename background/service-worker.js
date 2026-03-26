// Blunder Buster — Service Worker (Manifest V3)
// Responsibilities:
//   - Receive GAME_OVER messages from the content script
//   - Store the pending game in session storage (survives service worker termination)
//   - Open the side panel for the active tab
//   - Handle extension icon clicks

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GAME_OVER') {
    const payload = { ...message.payload, tabId: sender.tab?.id };
    chrome.storage.session.set({ pendingGame: payload }).then(() => {
      openSidePanel(sender.tab?.id);
      // Forward to the side panel if it is already open.
      // chrome.runtime.sendMessage broadcasts to all extension pages.
      chrome.runtime.sendMessage({ type: 'GAME_OVER', payload }).catch(() => {
        // Ignored — the panel may not be open yet; it will read from session storage on load.
      });
    });
    sendResponse({ received: true });
    return false;
  }

  if (message.type === 'GET_PENDING_GAME') {
    chrome.storage.session.get(['pendingGame']).then((result) => {
      sendResponse(result.pendingGame ?? null);
    });
    return true; // keeps the message channel open for async response
  }

  if (message.type === 'CLEAR_PENDING_GAME') {
    chrome.storage.session.remove(['pendingGame']);
    return false;
  }
});

async function openSidePanel(tabId) {
  if (!tabId) return;
  try {
    await chrome.sidePanel.open({ tabId });
  } catch {
    // sidePanel.open() requires a user gesture in some Chrome versions.
    // As a fallback, just ensure the panel is enabled — the user can open it manually.
    await chrome.sidePanel.setOptions({ tabId, enabled: true }).catch(() => {});
  }
}

// Manual open via toolbar icon click
chrome.action.onClicked.addListener((tab) => {
  openSidePanel(tab.id);
});
