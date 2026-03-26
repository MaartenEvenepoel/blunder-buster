// Blunder Buster — Game Analyzer
//
// stockfish.js (from the npm `stockfish` package) is designed to be used
// *directly* as a Web Worker. When loaded that way it auto-initializes,
// exposes a plain-string UCI interface over postMessage / onmessage, and
// resolves the WASM file relative to its own script URL
// (lib/stockfish-nnue-16-single.wasm).
//
// Usage from the extension page:
//   const worker = new Worker(chrome.runtime.getURL('lib/stockfish.js'));
//   worker.postMessage('uci');              // → UCI output lines arrive as event.data strings
//   worker.postMessage('go depth 20');

import { cpToWinPct, classifyMove, computeAccuracy } from './classifier.js';
import { detectBookMoves, getOpeningName }            from './opening-book.js';
import { pgnToMoveList, parsePGNHeaders }             from '../utils/pgn-parser.js';

// ── StockfishEngine ───────────────────────────────────────────────────────────

class StockfishEngine {
  constructor() {
    this._worker    = new Worker(chrome.runtime.getURL('lib/stockfish.js'));
    this._handlers  = new Set();
    this._worker.addEventListener('message', e => {
      for (const fn of this._handlers) fn(e.data);
    });
    this._readyPromise = this._init();
  }

  _init() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Stockfish init timeout — WASM may not have loaded.')),
        20000
      );
      const handler = line => {
        if (line === 'readyok') {
          clearTimeout(timeout);
          this._handlers.delete(handler);
          resolve();
        }
      };
      this._handlers.add(handler);
      this._send('uci');
      this._send('setoption name Threads value 1');
      this._send('setoption name Hash value 32');
      this._send('isready');
    });
  }

  _send(cmd) { this._worker.postMessage(cmd); }

  /** Evaluate a single FEN. Returns { score, isMate, bestMove, pv }. */
  evaluate(fen, depth, onUpdate) {
    return new Promise(resolve => {
      let lastInfo = null;

      const handler = line => {
        if (line.startsWith('info') && line.includes('score')) {
          const info = parseInfoLine(line);
          if (info) { lastInfo = info; onUpdate?.(info); }
        }
        if (line.startsWith('bestmove')) {
          this._handlers.delete(handler);
          const parts    = line.split(' ');
          const bestMove = (parts[1] && parts[1] !== '(none)') ? parts[1] : null;
          resolve({
            bestMove,
            score:  lastInfo?.score  ?? 0,
            isMate: lastInfo?.isMate ?? false,
            depth:  lastInfo?.depth  ?? 0,
            pv:     lastInfo?.pv     ?? [],
          });
        }
      };

      this._handlers.add(handler);
      this._send('ucinewgame');
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth}`);
    });
  }

  stop()      { this._send('stop'); }
  terminate() { this._send('quit'); this._worker.terminate(); }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze a complete chess game.
 *
 * @param {string}      pgn
 * @param {typeof Chess} Chess    chess.js constructor
 * @param {object}      options
 * @param {number}      [options.depth=20]
 * @param {function}    [options.onProgress]   ({ current, total, san }) => void
 * @param {function}    [options.onMoveResult] (moveData) => void
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<AnalysisResult>}
 */
export async function analyzeGame(pgn, Chess, {
  depth        = 20,
  onProgress   = null,
  onMoveResult = null,
  signal       = null,
} = {}) {
  const headers = parsePGNHeaders(pgn);
  const moves   = pgnToMoveList(pgn, Chess);
  const bookSet = detectBookMoves(headers, moves);

  // N moves → N+1 positions (start + after every move)
  const positions = [
    moves[0]?.fenBefore ?? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    ...moves.map(m => m.fenAfter),
  ];

  // ── Fast path: embedded %eval annotations ──────────────────────────────────
  const hasPgnEvals = moves.length > 0 && moves.every(m => m.pgnEval !== null);
  let rawEvals;

  if (hasPgnEvals) {
    rawEvals = [
      { score: 0, isMate: false, bestMove: null },
      ...moves.map(m => ({
        score:    m.pgnIsMate ? m.pgnEval * 100 : Math.round(m.pgnEval * 100),
        isMate:   m.pgnIsMate,
        bestMove: null,
      })),
    ];
  } else {
    rawEvals = await runStockfishAnalysis(positions, depth, signal, onProgress, moves);
  }

  // ── Classify each move ─────────────────────────────────────────────────────
  const movesData = [];

  for (let i = 0; i < moves.length; i++) {
    if (signal?.aborted) break;

    const move = moves[i];

    // rawEvals[i]   = eval of position before move i
    // rawEvals[i+1] = eval of position after  move i
    // Stockfish scores are from the side-to-move's POV; normalise to white's POV.
    const evalBefore = normalizeToWhite(rawEvals[i].score,   rawEvals[i].isMate,   move.color === 'w');
    const evalAfter  = normalizeToWhite(rawEvals[i+1].score, rawEvals[i+1].isMate, move.color !== 'w');

    const winPctBefore = cpToWinPct(evalBefore, rawEvals[i].isMate);
    const winPctAfter  = cpToWinPct(evalAfter,  rawEvals[i+1].isMate);
    const bestUci      = rawEvals[i].bestMove ?? '';
    const isSacrifice  = detectSacrifice(move, Chess);

    const moveData = {
      moveIndex:  i,
      san:        move.san,
      uci:        move.uci,
      color:      move.color,
      piece:      move.piece,
      captured:   move.captured,
      fenBefore:  move.fenBefore,
      fenAfter:   move.fenAfter,
      evalBefore,
      evalAfter,
      winPctBefore,
      winPctAfter,
      bestUci,
      isBookMove: bookSet.has(i),
      isSacrifice,
      pgnClk:     move.pgnClk,
      classification: classifyMove({
        color:      move.color,
        winPctBefore,
        winPctAfter,
        playedUci:  move.uci,
        bestUci,
        isBookMove: bookSet.has(i),
        isSacrifice,
      }),
    };

    movesData.push(moveData);
    onMoveResult?.(moveData);
  }

  return {
    pgn,
    headers,
    opening:       getOpeningName(headers),
    moves:         movesData,
    whiteAccuracy: computeAccuracy(movesData, 'w'),
    blackAccuracy: computeAccuracy(movesData, 'b'),
    analyzedWith:  hasPgnEvals ? 'pgn-evals' : 'stockfish',
  };
}

/**
 * Analyze a single ad-hoc position (for deviation/exploration mode).
 * Creates its own short-lived engine instance.
 *
 * @param {string}      fen
 * @param {number}      [depth=16]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{score, isMate, bestMove, pv}|null>}
 */
export async function analyzePosition(fen, depth = 16, signal = null) {
  const engine = new StockfishEngine();

  try {
    await engine._readyPromise;
    if (signal?.aborted) return null;

    return await new Promise((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => { engine.stop(); resolve(null); }, { once: true });
      }
      engine.evaluate(fen, depth).then(resolve).catch(reject);
    });
  } finally {
    engine.terminate();
  }
}

// ── Stockfish evaluation loop ─────────────────────────────────────────────────

async function runStockfishAnalysis(positions, depth, signal, onProgress, moves) {
  const engine = new StockfishEngine();
  await engine._readyPromise;

  const rawEvals = [];

  for (let i = 0; i < positions.length; i++) {
    if (signal?.aborted) break;

    onProgress?.({
      current: i,
      total:   positions.length,
      san:     i > 0 ? moves[i - 1]?.san : null,
    });

    const result = await engine.evaluate(positions[i], depth);
    rawEvals.push(result);
  }

  engine.terminate();
  return rawEvals;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeToWhite(score, isMate, whiteToMove) {
  // Stockfish reports from side-to-move POV; negate when it's black to move.
  return whiteToMove ? score : -score;
}

function detectSacrifice(move, Chess) {
  try {
    const chess = new Chess(move.fenAfter);
    const toSq  = move.uci.slice(2, 4);
    const enemy = move.color === 'w' ? 'b' : 'w';
    return chess.isAttacked(toSq, enemy);
  } catch {
    return false;
  }
}

function parseInfoLine(line) {
  const tokens = line.split(' ');
  let depth = 0, score = 0, isMate = false;
  const pv  = [];
  let inPv  = false;

  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth': depth = parseInt(tokens[++i]); break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          score = parseInt(tokens[i + 2]); isMate = false; i += 2;
        } else if (tokens[i + 1] === 'mate') {
          score = parseInt(tokens[i + 2]); isMate = true;  i += 2;
        }
        break;
      case 'pv': inPv = true; break;
      default:   if (inPv) pv.push(tokens[i]);
    }
  }

  if (depth === 0) return null;
  return { depth, score, isMate, pv };
}
