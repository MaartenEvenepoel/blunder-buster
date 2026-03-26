// Blunder Buster — DOM Observer
// Runs as a classic content script on chess.com.
// Exports helpers used by content-script.js (via shared scope).
/* exported observeGameEnd, extractGameId, extractGameDate, extractUsername */

/**
 * Watch for a chess game ending on chess.com.
 * Chess.com re-uses the same page and updates content via React, so we use
 * a MutationObserver with multiple detection strategies rather than relying
 * on a single fragile class name.
 *
 * @param {function} onGameOver - called once when a game ends; receives no args.
 */
function observeGameEnd(onGameOver) {
  let fired = false;

  function notify() {
    if (fired) return;
    fired = true;
    onGameOver();
  }

  // Strategy 1: watch for the result modal/overlay appearing in the DOM.
  // chess.com renders a dialog-like element when the game concludes.
  // We look for structural signals rather than brittle hashed class names:
  //   - role="dialog" containing a result text pattern
  //   - elements containing the game-over result strings
  const resultPattern = /\b(1-0|0-1|½-½|checkmate|stalemate|timeout|resignation|draw|white wins|black wins|game over)\b/i;

  const bodyObserver = new MutationObserver(() => {
    // Look for a dialog-like overlay
    const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="game-over"], [class*="gameover"]');
    for (const el of dialogs) {
      if (resultPattern.test(el.textContent)) {
        notify();
        return;
      }
    }

    // Fallback: scan for result text in known structural containers
    const containers = document.querySelectorAll(
      '[class*="result"], [class*="GameOver"], [data-cy="game-result"]'
    );
    for (const el of containers) {
      if (resultPattern.test(el.textContent)) {
        notify();
        return;
      }
    }
  });

  bodyObserver.observe(document.body, { childList: true, subtree: true });

  // Strategy 2: watch <title> — chess.com updates it to include the result.
  const titleObserver = new MutationObserver(() => {
    if (resultPattern.test(document.title)) {
      notify();
    }
  });
  const titleEl = document.querySelector('title');
  if (titleEl) {
    titleObserver.observe(titleEl, { childList: true });
  }

  // Strategy 3: intercept history.pushState / replaceState.
  // After a live game ends chess.com sometimes navigates to /game/live/{id}.
  const originalPushState    = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  function onNavigate(url) {
    if (/\/game\/(live|computer|daily)\/\d+/.test(url)) {
      // Small delay so chess.com can finish rendering
      setTimeout(notify, 800);
    }
  }

  history.pushState = function (...args) {
    originalPushState(...args);
    onNavigate(window.location.href);
  };
  history.replaceState = function (...args) {
    originalReplaceState(...args);
    onNavigate(window.location.href);
  };

  window.addEventListener('popstate', () => onNavigate(window.location.href));

  // Check immediately in case we loaded directly onto a finished game page
  if (/\/game\/(live|computer|daily)\/\d+/.test(window.location.pathname)) {
    setTimeout(() => {
      if (resultPattern.test(document.body?.textContent ?? '')) notify();
    }, 1500);
  }
}

/**
 * Extract the chess.com game ID from the current URL (or a given URL string).
 * Handles /game/live/{id}, /game/computer/{id}, /game/daily/{id}.
 * @returns {string|null}
 */
function extractGameId(url) {
  const match = (url || window.location.href).match(/\/game\/(live|computer|daily)\/(\d+)/);
  return match ? match[2] : null;
}

/**
 * Extract the game date from the chess.com page.
 * Returns "YYYY/MM" (the archive month) so api.js can jump directly to the
 * right archive instead of scanning from newest → oldest.
 *
 * chess.com embeds game data in several places depending on the page version:
 *   1. window.__NEXT_DATA__ (Next.js SSR payload) — most reliable
 *   2. window.chesscom.context — older layout
 *   3. A <meta> tag or <time> element with the date
 *
 * @returns {string|null}  e.g. "2023/07"
 */
function extractGameDate() {
  // 1. Next.js SSR data
  try {
    const nd = window.__NEXT_DATA__;
    // Path varies by chess.com version; try a few known locations
    const candidates = [
      nd?.props?.pageProps?.game?.pgnHeaders?.Date,
      nd?.props?.pageProps?.gameData?.pgnHeaders?.Date,
      nd?.props?.pageProps?.component?.game?.pgnHeaders?.Date,
    ];
    for (const d of candidates) {
      if (d && /\d{4}[\.\-]\d{2}/.test(d)) {
        // Normalise "2023.07.15" or "2023-07-15" → "2023/07"
        const [year, month] = d.replace(/\./g, '-').split('-');
        if (year && month) return `${year}/${month.padStart(2, '0')}`;
      }
    }
  } catch { /* ignore */ }

  // 2. chesscom global context
  try {
    const ctx = window.chesscom?.context ?? window.ChesscomData?.context;
    const endTime = ctx?.game?.endTime ?? ctx?.endTime;
    if (endTime) {
      const d = new Date(endTime * 1000);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    }
  } catch { /* ignore */ }

  // 3. <time> element with a parseable datetime attribute
  try {
    const timeEl = document.querySelector('time[datetime]');
    if (timeEl) {
      const dt = timeEl.getAttribute('datetime'); // e.g. "2023-07-15T10:30:00Z"
      const m = dt.match(/^(\d{4})-(\d{2})/);
      if (m) return `${m[1]}/${m[2]}`;
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Extract the logged-in username from the chess.com page.
 * Tries several selectors / globals in order of reliability.
 * @returns {string|null}
 */
function extractUsername() {
  // 1. chess.com's global data object (most reliable)
  try {
    const data = window.chesscom || window.ChesscomData;
    if (data?.user?.username) return data.user.username;
  } catch { /* ignore */ }

  // 2. Profile link in top navigation
  const profileLink = document.querySelector('a[href^="/member/"]');
  if (profileLink) {
    const m = profileLink.getAttribute('href').match(/^\/member\/([^/]+)/);
    if (m) return m[1];
  }

  // 3. Username span in nav
  const navUsername = document.querySelector(
    '[class*="username"], [class*="nav-username"], [data-username]'
  );
  if (navUsername) {
    return navUsername.dataset.username || navUsername.textContent.trim() || null;
  }

  // 4. Player component in the board UI
  const playerLinks = document.querySelectorAll('[class*="player"] a[href^="/member/"]');
  for (const link of playerLinks) {
    const m = link.getAttribute('href').match(/^\/member\/([^/]+)/);
    if (m) return m[1];
  }

  return null;
}
