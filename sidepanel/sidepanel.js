// Blunder Buster — Side Panel Controller

import { Chess }                          from '../lib/chess.js';
import { analyzeGame, analyzePosition }   from '../analysis/analyzer.js';
import { fetchGame }                      from '../utils/api.js';
import { getCachedAnalysis, cacheAnalysis, local } from '../utils/storage.js';
import { ChessBoard }                     from './board.js';
import { EvalBar }                        from './eval-bar.js';
import { MoveList }                       from './move-list.js';
import { CoachPanel }                     from './coach.js';

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  // Game data
  gameId:       null,
  pgn:          null,
  result:       null,
  headers:      {},

  // Analysis result
  analysis:     null,    // AnalysisResult from analyzer.js

  // Playback
  currentIndex: -1,      // -1 = starting position
  chessInstances: [],    // chess.js instance per ply (index 0 = start, index N = after move N-1)

  // Deviation mode
  isInDeviation:     false,
  deviationIndex:    -1,    // last main-line index before branch
  deviationChess:    null,  // current chess instance in deviation path
  deviationAbort:    null,  // AbortController for ongoing deviation analysis

  // Cancellation for in-progress game analysis
  analysisAbort: null,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);
const welcome     = $('welcome');
const analysisUI  = $('analysis-ui');

const elBlackName    = $('black-name');
const elBlackRating  = $('black-rating');
const elBlackAcc     = $('black-accuracy');
const elWhiteName    = $('white-name');
const elWhiteRating  = $('white-rating');
const elWhiteAcc     = $('white-accuracy');
const elOpening      = $('opening-name');

const canvas         = $('board');
const statusText     = $('status-text');
const progressBar    = $('progress-bar');
const deviationBanner = $('deviation-banner');

// ── Components ────────────────────────────────────────────────────────────────

const board      = new ChessBoard(canvas, { onMove: handleUserMove });
const evalBar    = new EvalBar($('eval-bar-container'));
const moveList   = new MoveList($('move-list'), handleMoveClick);
const coachPanel = new CoachPanel(
  $('coach-panel'),
  () => local.getSettings().then(s => s.claudeApiKey ?? ''),
  () => state.gameId,
);

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', init);

async function init() {
  sizeBoard();
  window.addEventListener('resize', sizeBoard);

  bindControls();

  // Ask the service worker for any pending game
  try {
    const pending = await getPendingGame();
    if (pending) {
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_GAME' });
      await loadGame(pending.gameId, pending.username, pending.gameYearMonth);
    }
  } catch (err) {
    console.error('[BlunderBuster] init error:', err);
  }

  // Listen for new games arriving while the panel is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'GAME_OVER') {
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_GAME' });
      loadGame(msg.payload.gameId, msg.payload.username, msg.payload.gameYearMonth);
    }
  });
}

function getPendingGame() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_PENDING_GAME' }, (res) => {
      resolve(chrome.runtime.lastError ? null : res);
    });
  });
}

// ── Game loading pipeline ─────────────────────────────────────────────────────

async function loadGame(gameId, username, gameYearMonth = null) {
  if (state.analysisAbort) state.analysisAbort.abort();

  // Username is required to search the monthly archives.
  // If the content script couldn't extract it, ask the user once and cache it.
  if (!username) {
    username = await local.getSettings().then(s => s.cachedUsername ?? null);
  }
  if (!username) {
    username = await promptUsername();
    if (!username) { setStatus('Username required to fetch game.'); return; }
    await local.saveSettings({ cachedUsername: username });
  }

  state.gameId   = gameId;
  state.username = username;
  showAnalysisUI();
  setStatus('Fetching game…');

  // Check cache first — discard entries from older schema versions
  const cached = await getCachedAnalysis(gameId);
  if (cached && cached.schemaVersion === 2) {
    buildChessInstances(cached.pgn);
    const h = cached.headers ?? {};
    populateHeader(
      { white: { username: h.White, rating: h.WhiteElo }, black: { username: h.Black, rating: h.BlackElo } },
      username
    );
    goToIndex(-1);
    applyAnalysisResult(cached);
    setStatus('Loaded from cache');
    return;
  }

  // Fetch from chess.com API
  let gameData;
  try {
    gameData = await fetchGame(gameId, username, gameYearMonth, setStatus);
  } catch (err) {
    setStatus('Failed to fetch game: ' + err.message);
    return;
  }

  if (!gameData?.pgn) {
    setStatus('No PGN data returned for this game.');
    return;
  }

  state.pgn    = gameData.pgn;
  state.result = gameData;

  // Pre-populate header UI
  populateHeader(gameData, username);

  // Build chess instances for every ply (allows instant board navigation)
  buildChessInstances(gameData.pgn);

  // Show board at starting position immediately
  goToIndex(-1);

  // Run analysis
  const abort = new AbortController();
  state.analysisAbort = abort;
  setStatus('Analyzing…');
  setProgress(0);

  try {
    const result = await analyzeGame(gameData.pgn, Chess, {
      depth:      20,
      signal:     abort.signal,
      onProgress: ({ current, total, san }) => {
        const pct = Math.round((current / total) * 100);
        setProgress(pct);
        setStatus(`Analyzing move ${current}/${total}${san ? ` (${san})` : ''}…`);
      },
      onMoveResult: (moveData) => {
        // Progressive rendering: update each move as it finishes
        moveList.updateMove(moveData);
      },
    });

    if (!abort.signal.aborted) {
      applyAnalysisResult(result);
      await cacheAnalysis(gameId, result);
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      setStatus('Analysis error: ' + err.message);
    }
  }
}

function buildChessInstances(pgn) {
  state.chessInstances = [];
  const game = new Chess();
  // Strip annotations so chess.js parses cleanly
  const clean = pgn.replace(/\{[^}]*\}/g, '').replace(/\$\d+/g, '').trim();
  game.loadPgn(clean, { strict: false });
  const history = game.history({ verbose: true });

  const replay = new Chess();
  state.chessInstances.push(new Chess(replay.fen())); // index 0 = start

  for (const move of history) {
    replay.move(move.san);
    state.chessInstances.push(new Chess(replay.fen()));
  }
}

function applyAnalysisResult(result) {
  state.analysis = result;
  coachPanel.clear();

  // Update headers
  elOpening.textContent = result.opening ?? '';
  elWhiteAcc.textContent = result.whiteAccuracy !== null && result.whiteAccuracy !== undefined ? `${result.whiteAccuracy.toFixed(1)}%` : '';
  elBlackAcc.textContent = result.blackAccuracy !== null && result.blackAccuracy !== undefined ? `${result.blackAccuracy.toFixed(1)}%` : '';

  // Render move list with all classifications
  moveList.render(result.moves);
  moveList.setCurrentIndex(state.currentIndex);

  // Refresh board + eval for current position
  refreshBoard();
  setProgress(100);
  setStatus(`Analysis complete — White ${result.whiteAccuracy?.toFixed(1)}% | Black ${result.blackAccuracy?.toFixed(1)}%`);
}

// ── Navigation ────────────────────────────────────────────────────────────────

function goToIndex(idx) {
  const max = state.chessInstances.length - 2; // last move index
  state.currentIndex = Math.max(-1, Math.min(idx, max));
  clearDeviation();
  refreshBoard();
  moveList.setCurrentIndex(state.currentIndex);

  if (state.currentIndex >= 0 && state.analysis) {
    const moveData     = state.analysis.moves[state.currentIndex];
    const chessForCoach = state.chessInstances[state.currentIndex] ?? null; // position before the move
    if (moveData && chessForCoach) {
      coachPanel.show(moveData, chessForCoach, state.analysis.headers ?? {});
    } else {
      coachPanel.clear();
    }
  } else {
    coachPanel.clear();
  }
}

function refreshBoard() {
  const chess = getCurrentChess();
  if (!chess) return;

  const currentMove = state.currentIndex >= 0 && state.analysis
    ? state.analysis.moves[state.currentIndex]
    : null;
  const lastMove = currentMove
    ? { from: currentMove.uci.slice(0, 2), to: currentMove.uci.slice(2, 4) }
    : null;
  const classification = currentMove?.classification ?? null;

  board.setPosition(chess, lastMove, classification);

  // Eval bar
  if (state.analysis && state.currentIndex >= 0) {
    const m = state.analysis.moves[state.currentIndex];
    if (m) evalBar.update(m.evalAfter, m.isMateAfter ?? false, board.flipped);
  } else if (state.analysis && state.currentIndex === -1) {
    const firstEval = state.analysis.moves[0]?.evalBefore ?? 0;
    evalBar.update(firstEval, false, board.flipped);
  } else {
    evalBar.update(0, false);
  }

  // Best-move arrow
  if (state.analysis && state.currentIndex >= 0) {
    const nextMove = state.analysis.moves[state.currentIndex + 1];
    board.showArrow(nextMove?.bestUci ?? null);
  } else {
    board.clearArrows();
  }
}

function getCurrentChess() {
  if (state.isInDeviation) return state.deviationChess;
  const instanceIdx = state.currentIndex + 1; // chessInstances[0] = start
  return state.chessInstances[instanceIdx] ?? null;
}

// ── User move handling (deviation mode) ──────────────────────────────────────

async function handleUserMove({ from, to, promotion }) {
  const chess = getCurrentChess();
  if (!chess) return;

  // Clone and try the move
  const clone = new Chess(chess.fen());
  const result = clone.move({ from, to, promotion: promotion ?? 'q' });
  if (!result) return; // illegal move (shouldn't happen, board filters legal moves)

  const playedUci = from + to + (promotion || '');

  // Is this the next move in the main line?
  const nextMainMove = state.analysis?.moves[state.currentIndex + 1];
  const isMainLine   = !state.isInDeviation && nextMainMove?.uci === playedUci;

  if (isMainLine) {
    goToIndex(state.currentIndex + 1);
    return;
  }

  // Enter / extend deviation mode
  if (!state.isInDeviation) {
    state.deviationIndex = state.currentIndex;
    moveList.setDeviationStart(state.deviationIndex);
    deviationBanner.classList.add('visible');
  }

  state.isInDeviation  = true;
  state.deviationChess = clone;

  const lastMove = { from, to };
  board.setPosition(clone, lastMove);

  // Abort any previous deviation analysis
  state.deviationAbort?.abort();
  const abort = new AbortController();
  state.deviationAbort = abort;

  setStatus('Engine thinking…');
  board.showArrow(null);

  try {
    const evalResult = await analyzePosition(clone.fen(), 16, abort.signal);
    if (!abort.signal.aborted && evalResult) {
      evalBar.update(evalResult.score, evalResult.isMate, board.flipped);
      board.showArrow(evalResult.bestMove);
      setStatus(`Engine: ${evalResult.isMate ? 'Mate in ' + Math.abs(evalResult.score) : formatCp(evalResult.score)} — best: ${evalResult.bestMove ?? '?'}`);
    }
  } catch {
    setStatus('Engine analysis failed');
  }
}

function clearDeviation() {
  if (state.isInDeviation) {
    state.deviationAbort?.abort();
    state.isInDeviation  = false;
    state.deviationIndex = -1;
    state.deviationChess = null;
    moveList.clearDeviation();
    deviationBanner.classList.remove('visible');
    board.clearArrows();
  }
}

// ── Control bindings ──────────────────────────────────────────────────────────

function bindControls() {
  $('btn-start').addEventListener('click', () => goToIndex(-1));
  $('btn-end').addEventListener('click', () => {
    goToIndex((state.chessInstances.length ?? 1) - 2);
  });
  $('btn-prev').addEventListener('click', () => {
    if (state.isInDeviation) {
      clearDeviation();
      refreshBoard();
    } else {
      goToIndex(state.currentIndex - 1);
    }
  });
  $('btn-next').addEventListener('click', () => goToIndex(state.currentIndex + 1));
  $('btn-flip').addEventListener('click', () => {
    board.flip();
    refreshBoard();
  });
  $('btn-return-to-game').addEventListener('click', () => {
    clearDeviation();
    refreshBoard();
  });

  // Settings panel
  const settingsPanel  = $('settings-panel');
  const apiKeyInput    = $('api-key-input');
  $('btn-settings').addEventListener('click', async () => {
    const isOpen = settingsPanel.classList.toggle('open');
    if (isOpen) {
      const { claudeApiKey } = await local.getSettings();
      apiKeyInput.value = claudeApiKey ?? '';
      apiKeyInput.focus();
    }
  });
  $('btn-save-settings').addEventListener('click', async () => {
    await local.saveSettings({ claudeApiKey: apiKeyInput.value.trim() });
    settingsPanel.classList.remove('open');
  });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft')  $('btn-prev').click();
    if (e.key === 'ArrowRight') $('btn-next').click();
    if (e.key === 'ArrowUp')    $('btn-start').click();
    if (e.key === 'ArrowDown')  $('btn-end').click();
  });
}

function handleMoveClick(idx) {
  goToIndex(idx);
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function showAnalysisUI() {
  welcome.style.display    = 'none';
  analysisUI.style.display = 'flex';
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function setProgress(pct) {
  progressBar.style.width = `${pct}%`;
}

function sizeBoard() {
  const panelWidth = document.body.clientWidth;
  const boardWidth = panelWidth - 18 /* eval bar */ - 2 /* borders */;
  canvas.width  = boardWidth;
  canvas.height = boardWidth;
  refreshBoard();
}

function populateHeader(gameData, username) {
  const w = gameData.white || {};
  const b = gameData.black || {};
  elWhiteName.textContent   = w.username ?? 'White';
  elWhiteRating.textContent = w.rating ? `(${w.rating})` : '';
  elBlackName.textContent   = b.username ?? 'Black';
  elBlackRating.textContent = b.rating ? `(${b.rating})` : '';

  // Bold the current user
  if (username) {
    const isWhite = w.username?.toLowerCase() === username.toLowerCase();
    const isBlack = b.username?.toLowerCase() === username.toLowerCase();
    if (isWhite) elWhiteName.style.color = '#fff';
    if (isBlack) elBlackName.style.color = '#fff';
  }
}

function formatCp(cp) {
  const sign = cp >= 0 ? '+' : '';
  return `${sign}${(cp / 100).toFixed(2)}`;
}

/**
 * Show a small inline form asking the user for their chess.com username.
 * Returns the entered username, or null if dismissed.
 */
function promptUsername() {
  return new Promise(resolve => {
    // Remove any existing prompt
    document.getElementById('username-prompt')?.remove();

    const wrap = document.createElement('div');
    wrap.id = 'username-prompt';
    wrap.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.7);
      display:flex; align-items:center; justify-content:center; z-index:999;`;
    wrap.innerHTML = `
      <div style="background:#272727;border:1px solid #444;border-radius:8px;padding:20px;width:260px;text-align:center;">
        <p style="margin-bottom:12px;font-size:13px;color:#e0e0e0;">
          Enter your chess.com username to fetch games:
        </p>
        <input id="username-input" type="text" placeholder="your username"
          style="width:100%;padding:7px 10px;border-radius:4px;border:1px solid #555;
                 background:#1e1e1e;color:#e0e0e0;font-size:13px;box-sizing:border-box;" />
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;">
          <button id="username-ok"
            style="background:#96bc4b;color:#000;border:none;padding:6px 18px;
                   border-radius:4px;cursor:pointer;font-weight:600;">OK</button>
          <button id="username-cancel"
            style="background:#444;color:#e0e0e0;border:none;padding:6px 14px;
                   border-radius:4px;cursor:pointer;">Cancel</button>
        </div>
      </div>`;

    document.body.appendChild(wrap);
    const input = document.getElementById('username-input');
    input.focus();

    const finish = (value) => { wrap.remove(); resolve(value); };

    document.getElementById('username-ok').addEventListener('click', () => {
      const v = input.value.trim();
      finish(v || null);
    });
    document.getElementById('username-cancel').addEventListener('click', () => finish(null));
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('username-ok').click();
      if (e.key === 'Escape') finish(null);
    });
  });
}
