// Blunder Buster — Content Script
// Injected into chess.com game pages.
// Depends on dom-observer.js (loaded first, shares classic script scope).

(function () {
  'use strict';

  let notified = false;

  function handleGameOver() {
    if (notified) return;
    notified = true;

    const gameId   = extractGameId(window.location.href);
    const username = extractUsername();

    if (!gameId) {
      // Try again in 1s — URL may not have updated yet
      setTimeout(() => {
        notified = false;
        handleGameOver();
      }, 1000);
      return;
    }

    const payload = {
      gameId,
      username,
      gameYearMonth: extractGameDate(), // "YYYY/MM" or null
      url: window.location.href,
      timestamp: Date.now(),
    };

    chrome.runtime.sendMessage({ type: 'GAME_OVER', payload }, (_response) => {
      if (chrome.runtime.lastError) {
        // Service worker may have been terminated — retry once
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'GAME_OVER', payload });
        }, 500);
      }
    });
  }

  // Reset notification state when URL changes so a new game on the same tab
  // triggers again.
  let lastHref = window.location.href;
  setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      notified = false;
    }
  }, 500);

  observeGameEnd(handleGameOver);
})();
