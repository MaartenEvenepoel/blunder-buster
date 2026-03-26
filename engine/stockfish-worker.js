// Blunder Buster — Stockfish Web Worker
// Wraps the Stockfish 16 single-thread WASM build in a clean message interface.
//
// Inbound messages (from analyzer.js):
//   { type: 'ANALYZE', fen: string, depth: number }
//   { type: 'STOP' }
//   { type: 'QUIT' }
//
// Outbound messages (to analyzer.js):
//   { type: 'READY' }
//   { type: 'EVAL_UPDATE', depth, score, isMate, pv }
//   { type: 'RESULT',      bestMove, ponder, score, isMate, depth, pv }
//   { type: 'ERROR',       message }

'use strict';

// Tell the Stockfish glue where to find the .wasm binary
// (chrome.runtime.getURL is available inside extension workers)
self.Module = {
  locateFile(path) {
    return self.stockfishBase + path;
  },
};

let sf = null;          // Stockfish instance
let lastInfo = null;    // last parsed info line
let resolveResult = null;
let analyzing = false;

// ── Boot ─────────────────────────────────────────────────────────────────────

// stockfishBase is injected as the first message before any ANALYZE commands
self.onmessage = async function bootstrap(event) {
  if (event.data.type !== 'INIT') return;

  self.stockfishBase = event.data.baseUrl; // e.g. chrome-extension://abc123/lib/

  try {
    importScripts(self.stockfishBase + 'stockfish.js');
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: 'Failed to load Stockfish: ' + err.message });
    return;
  }

  // Stockfish() returns a Promise<StockfishInstance>
  sf = await Stockfish();
  sf.addMessageListener(handleUCI);
  send('uci');
  send('setoption name Threads value 1');
  send('setoption name Hash value 32');
  send('setoption name MultiPV value 1');
  send('isready');

  // Replace bootstrap handler with the real one
  self.onmessage = handleMessage;
};

// ── Message handler ───────────────────────────────────────────────────────────

function handleMessage(event) {
  const { type, fen, depth } = event.data;

  switch (type) {
    case 'ANALYZE':
      if (analyzing) send('stop');
      lastInfo = null;
      analyzing = true;
      send('ucinewgame');
      send(`position fen ${fen}`);
      send(`go depth ${depth ?? 20}`);
      break;

    case 'STOP':
      if (analyzing) send('stop');
      break;

    case 'QUIT':
      send('quit');
      self.close();
      break;
  }
}

// ── UCI output parser ─────────────────────────────────────────────────────────

function handleUCI(line) {
  if (line === 'readyok') {
    self.postMessage({ type: 'READY' });
    return;
  }

  if (line.startsWith('info') && line.includes('score')) {
    const info = parseInfo(line);
    if (info) {
      lastInfo = info;
      self.postMessage({ type: 'EVAL_UPDATE', ...info });
    }
    return;
  }

  if (line.startsWith('bestmove')) {
    analyzing = false;
    const parts   = line.split(' ');
    const bestMove = parts[1] === '(none)' ? null : parts[1];
    const ponder   = parts[3] ?? null;

    self.postMessage({
      type:     'RESULT',
      bestMove,
      ponder,
      score:    lastInfo?.score  ?? 0,
      isMate:   lastInfo?.isMate ?? false,
      depth:    lastInfo?.depth  ?? 0,
      pv:       lastInfo?.pv     ?? [],
    });
  }
}

function parseInfo(line) {
  const tokens = line.split(' ');
  let depth = 0, score = 0, isMate = false;
  const pv = [];
  let inPv = false;

  for (let i = 0; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        depth = parseInt(tokens[++i]);
        break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          score  = parseInt(tokens[i + 2]);
          isMate = false;
          i += 2;
        } else if (tokens[i + 1] === 'mate') {
          score  = parseInt(tokens[i + 2]);
          isMate = true;
          i += 2;
        }
        break;
      case 'pv':
        inPv = true;
        break;
      default:
        if (inPv) pv.push(tokens[i]);
    }
  }

  if (depth === 0) return null;
  return { depth, score, isMate, pv };
}

function send(cmd) {
  sf.postMessage(cmd);
}
