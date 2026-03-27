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

  const gameObserver = observeGameEnd(handleGameOver);

  // Reset both flags when the URL changes so every new game page can trigger.
  // Without resetting gameObserver, the internal `fired` guard stays true after
  // the first game and blocks all subsequent detections in the same tab session.
  let lastHref   = window.location.href;
  let lastGameId = extractGameId(window.location.href);
  setInterval(() => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
      const newGameId = extractGameId(window.location.href);
      // Only reset detection flags and trigger when the game ID itself changes.
      // chess.com mutates the URL during move-by-move navigation within the same
      // review (hash, query params, etc.) — resetting flags there would let the
      // bodyObserver re-fire on result text that's already on the page.
      if (newGameId && newGameId !== lastGameId) {
        lastGameId = newGameId;
        notified = false;
        gameObserver.reset();
        setTimeout(handleGameOver, 1200);
      }
    }
  }, 500);
})();
