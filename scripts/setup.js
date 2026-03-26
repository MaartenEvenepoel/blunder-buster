#!/usr/bin/env node
/**
 * Setup script: copies required library files into lib/ after npm install.
 * Run with: npm run setup
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB  = path.join(ROOT, 'lib');

if (!fs.existsSync(LIB)) fs.mkdirSync(LIB, { recursive: true });

function copy(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`MISSING: ${src}`);
    console.error('  → Run `npm install` first.');
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  console.log(`Copied: ${path.relative(ROOT, src)} → lib/${path.basename(dest)}`);
}

// chess.js ESM build
copy(
  path.join(ROOT, 'node_modules/chess.js/dist/esm/chess.js'),
  path.join(LIB, 'chess.js')
);

// Stockfish 16 single-thread WASM (no SharedArrayBuffer required)
copy(
  path.join(ROOT, 'node_modules/stockfish/src/stockfish-nnue-16-single.js'),
  path.join(LIB, 'stockfish.js')
);
// Keep the original filename — stockfish.js resolves it by name at runtime.
copy(
  path.join(ROOT, 'node_modules/stockfish/src/stockfish-nnue-16-single.wasm'),
  path.join(LIB, 'stockfish-nnue-16-single.wasm')
);

// ── Chess piece SVGs (Lichess cburnett set, CC BY-SA 4.0) ────────────────────
const PIECES_DIR = path.join(ROOT, 'icons', 'pieces');
if (!fs.existsSync(PIECES_DIR)) fs.mkdirSync(PIECES_DIR, { recursive: true });

const PIECE_KEYS = ['wK','wQ','wR','wB','wN','wP','bK','bQ','bR','bB','bN','bP'];
const BASE_URL   = 'https://cdn.jsdelivr.net/gh/lichess-org/lila@master/public/piece/cburnett/';

const https = require('https');
function download(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) { resolve(); return; } // skip if already present
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

console.log('\nDownloading piece SVGs (cburnett set)…');
Promise.all(
  PIECE_KEYS.map(k => download(`${BASE_URL}${k}.svg`, path.join(PIECES_DIR, `${k}.svg`))
    .then(() => console.log(`  ✓ ${k}.svg`))
    .catch(e  => console.error(`  ✗ ${k}.svg — ${e.message}`))
  )
).then(() => {
  console.log('\nDone! You can now load the extension in Chrome:');
  console.log('  1. Open chrome://extensions');
  console.log('  2. Enable Developer Mode');
  console.log('  3. Click "Load unpacked" and select this directory');
});
