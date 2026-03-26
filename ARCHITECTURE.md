# Blunder Buster — Architecture & Implementation

This document is a detailed technical reference for the entire Blunder Buster codebase. It covers the data flow end-to-end, the purpose and implementation of every file, and the key design decisions made along the way.

---

## Table of contents

1. [High-level architecture](#1-high-level-architecture)
2. [Extension platform choices (MV3)](#2-extension-platform-choices-mv3)
3. [Game detection pipeline](#3-game-detection-pipeline)
4. [Fetching games from chess.com](#4-fetching-games-from-chessccom)
5. [PGN parsing and FEN replay](#5-pgn-parsing-and-fen-replay)
6. [Stockfish integration](#6-stockfish-integration)
7. [Move classification system](#7-move-classification-system)
8. [Opening book detection](#8-opening-book-detection)
9. [Side panel UI](#9-side-panel-ui)
10. [Canvas chessboard](#10-canvas-chessboard)
11. [Storage and caching](#11-storage-and-caching)
12. [Setup script](#12-setup-script)
13. [File reference](#13-file-reference)

---

## 1. High-level architecture

```
chess.com tab
  └── content/dom-observer.js      (MutationObserver, title watcher, history interception)
  └── content/content-script.js    (sends GAME_OVER message)
          │
          │  chrome.runtime.sendMessage
          ▼
background/service-worker.js       (stores pending game in chrome.storage.session,
          │                          opens side panel, forwards message if panel is open)
          │
          │  chrome.sidePanel.open()  /  chrome.runtime.onMessage
          ▼
sidepanel/sidepanel.js             (main controller)
  ├── utils/api.js                 (fetch game PGN from chess.com archives)
  ├── utils/pgn-parser.js          (parse PGN → per-ply move records with FEN)
  ├── analysis/analyzer.js         (run Stockfish on every position)
  │     ├── analysis/classifier.js (win% → classification, accuracy)
  │     └── analysis/opening-book.js
  ├── utils/storage.js             (LRU cache, settings)
  ├── sidepanel/board.js           (Canvas 2D chessboard)
  ├── sidepanel/eval-bar.js        (evaluation bar component)
  └── sidepanel/move-list.js       (move list with badges)
```

The extension has four distinct browser contexts:

| Context | Files | Lifetime |
|---|---|---|
| Content script | `content/` | Lives as long as the chess.com tab |
| Service worker | `background/` | Spawned on demand; terminates after ~30 s idle |
| Side panel page | `sidepanel/`, `analysis/`, `utils/` | Lives as long as the panel is open |
| Web worker (Stockfish) | `lib/stockfish.js` | Spawned by the side panel during analysis |

---

## 2. Extension platform choices (MV3)

### Manifest V3 constraints

Blunder Buster uses Manifest V3 (MV3), Chrome's current extension platform. MV3 introduced several constraints that shaped the architecture:

**Service workers instead of background pages.** MV3 background scripts are service workers that terminate after ~30 seconds of inactivity. State cannot be kept in memory. We use `chrome.storage.session` (volatile, cleared on browser restart) to persist the pending game between the service worker termination and the side panel opening. Any `GET_PENDING_GAME` message from the side panel reads from session storage rather than relying on in-memory state.

**Content Security Policy for WebAssembly.** MV3 disallows `unsafe-eval` by default. Loading Stockfish's WebAssembly binary requires the `wasm-unsafe-eval` source in the extension's CSP:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

Without this the WASM module fails to compile and Stockfish never initialises.

**`web_accessible_resources`.** Files that need to be loaded by extension pages (the side panel) but live inside the extension package must be declared as web-accessible. This applies to `lib/stockfish.js`, the WASM binary, `lib/chess.js`, and `icons/pieces/*.svg`.

### Side panel API

The `chrome.sidePanel` API (Chrome 114+) lets an extension display a persistent panel alongside the active tab without displacing the page content. The side panel is declared in `manifest.json`:

```json
"side_panel": { "default_path": "sidepanel/sidepanel.html" }
```

`chrome.sidePanel.open({ tabId })` is called by the service worker when a game ends. If the panel is already open the service worker also broadcasts a `GAME_OVER` message via `chrome.runtime.sendMessage` so the already-open panel can react immediately.

---

## 3. Game detection pipeline

**Files:** `content/dom-observer.js`, `content/content-script.js`

Chess.com is a React single-page application. The page does not fully reload between games; React updates the DOM in place. A simple `DOMContentLoaded` listener is therefore insufficient. `dom-observer.js` uses three parallel strategies so that at least one fires regardless of which chess.com page variant the user is on:

### Strategy 1 — MutationObserver on `document.body`

A `MutationObserver` watches for any DOM addition in the page body. On each mutation it looks for:

- Elements with `role="dialog"` or class names containing `modal`, `game-over`, or `gameover`
- Elements with class names containing `result`, `GameOver`, or a `data-cy="game-result"` attribute

Each candidate element's text content is tested against a result pattern:

```
/\b(1-0|0-1|½-½|checkmate|stalemate|timeout|resignation|draw|white wins|black wins|game over)\b/i
```

This avoids dependence on specific hashed class names that chess.com changes frequently.

### Strategy 2 — `<title>` mutation

Chess.com updates the page `<title>` to include the result string (e.g. "Magnus Carlsen vs. You — 1-0"). A second `MutationObserver` watches the `<title>` element and fires when the title matches the result pattern.

### Strategy 3 — `history.pushState` / `replaceState` interception

After a live game ends chess.com navigates (via the History API, not a real page load) to `/game/live/{id}`. We wrap `history.pushState` and `history.replaceState` to intercept this and fire after an 800 ms delay (giving React time to render). `popstate` is also handled.

A `fired` guard ensures `onGameOver` is called exactly once per game, regardless of which strategy fires first. A URL-change watcher (polling every 500 ms) resets the `notified` flag between games played in the same tab.

### Data extracted by the content script

`content-script.js` calls three helpers from `dom-observer.js` and packages the results into the `GAME_OVER` payload:

| Field | Source | Purpose |
|---|---|---|
| `gameId` | URL regex `/game/(live\|computer\|daily)/(\d+)` | Identifies the game |
| `username` | `window.chesscom.user`, nav links, DOM selectors | Needed to query the API |
| `gameYearMonth` | `window.__NEXT_DATA__`, `window.chesscom.context`, `<time>` element | Fast-path archive hint |
| `url` | `window.location.href` | Diagnostic |
| `timestamp` | `Date.now()` | Diagnostic |

---

## 4. Fetching games from chess.com

**File:** `utils/api.js`

### Why there is no single-game endpoint

The chess.com public API **does not expose a `GET /pub/game/{id}` endpoint**. Games are only available through monthly archive endpoints:

```
GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
```

This returns all games a player played in that calendar month. A specific game is identified by matching its numeric ID against the `url` field of each game object (e.g. `"url": "https://www.chess.com/game/live/107375255172"`).

### Two-phase lookup

`fetchGame(gameId, username, gameYearMonth, onStatus)` implements a fast path and a full fallback:

**Fast path.** If the content script successfully extracted the game date (`gameYearMonth = "YYYY/MM"`), that exact archive month is fetched first. For a game just finished — or a historical game whose date is embedded in `__NEXT_DATA__` — this resolves in a single API call.

**Full archive search.** If the fast path misses (date not available or API error), all archive URLs are fetched via `GET /pub/player/{username}/games/archives`, reversed (newest first), and searched sequentially with a 300 ms rate-limit delay between requests. There is no cap on the number of archives searched; this ensures arbitrarily old games are always found.

---

## 5. PGN parsing and FEN replay

**File:** `utils/pgn-parser.js`

chess.com PGN files embed clock times and evaluations as move comments:

```
14. Nf3 { [%clk 0:04:51] [%eval 0.23] } 14... d5 { [%clk 0:04:39] [%eval -0.15] }
```

### `extractMoveAnnotations(pgn)`

A regex walks the move text and extracts `%clk` and `%eval` values from each comment block. `%eval` values starting with `#` are forced mates (e.g. `#3` = mate in 3).

### `pgnToMoveList(pgn, Chess)`

The annotations are stripped and chess.js is used to replay the clean PGN. At each ply we capture:

- `fenBefore` / `fenAfter` — the position as a FEN string before and after the move
- `san` — the Standard Algebraic Notation move string (e.g. `Nf3`)
- `uci` — the UCI move string (e.g. `g1f3`)
- `color`, `piece`, `captured`, `flags` — from chess.js's verbose history
- `pgnEval`, `pgnIsMate`, `pgnClk` — from the annotation extraction step

### `parsePGNHeaders(pgn)`

A simple regex extracts all `[Key "Value"]` tag pairs from the PGN header section into a plain object, e.g. `{ White: "Magnus", WhiteElo: "3000", ECO: "B20", … }`.

---

## 6. Stockfish integration

**Files:** `analysis/analyzer.js`, `lib/stockfish.js`, `lib/stockfish-nnue-16-single.wasm`

### How the `stockfish` npm package works in an extension

The `stockfish` npm package distributes a self-contained JS file (`stockfish-nnue-16-single.js`) that is designed to be **loaded directly as a Web Worker**. When used this way it:

1. Auto-initialises the WASM binary (resolved relative to the worker script's own URL as `stockfish-nnue-16-single.wasm`)
2. Communicates over the standard UCI protocol: strings are sent to the worker via `worker.postMessage(string)` and received via the `message` event

The key insight is that this file must **not** be wrapped in another worker or loaded via `importScripts` — it is already the worker. The setup script copies it into `lib/` so it can be loaded with `chrome.runtime.getURL('lib/stockfish.js')`.

### `StockfishEngine` class

```
constructor()  → creates the Worker, registers a message dispatcher
_init()        → sends 'uci' + 'isready', resolves when 'readyok' is received (20 s timeout)
evaluate(fen, depth, onUpdate?)  → sends 'position fen …' + 'go depth N',
                                    resolves with { score, isMate, bestMove, pv } on 'bestmove'
stop()         → sends 'stop'
terminate()    → sends 'quit' + calls worker.terminate()
```

The engine uses a `Set` of handler functions rather than a single `onmessage` callback. This allows multiple callers to subscribe simultaneously and lets each call remove its own handler when complete.

### Full game analysis — `analyzeGame(pgn, Chess, options)`

**Fast path.** If every move in the PGN has a `%eval` annotation, Stockfish is skipped entirely. The embedded evaluations are used directly, converting centipawn scores via `Math.round(pgnEval * 100)`.

**Stockfish path.** For each of the N+1 positions (start + after each move) the engine evaluates at the configured depth (default 20). Results arrive sequentially; `onProgress` and `onMoveResult` callbacks update the UI progressively as each move completes.

**Score normalisation.** Stockfish always reports the score from the side-to-move's point of view. For classification, scores are normalised to white's perspective by negating black-to-move scores:

```javascript
function normalizeToWhite(score, isMate, whiteToMove) {
  return whiteToMove ? score : -score;
}
```

**Sacrifice detection.** After a move is made, `chess.isAttacked(toSquare, enemy)` checks whether the moved piece is now attacked. This is used by the classifier to detect speculative sacrifices that may warrant a Brilliant classification.

### Ad-hoc position analysis — `analyzePosition(fen, depth, signal)`

Used in deviation mode. Creates a short-lived `StockfishEngine` instance, evaluates the given FEN, and terminates the engine when done. An `AbortSignal` allows the caller to cancel mid-flight (e.g. when the user makes another move before the previous evaluation completes).

---

## 7. Move classification system

**File:** `analysis/classifier.js`

### Win percentage

Raw centipawn scores are converted to a win probability using a logistic function:

```
winPct = 50 + 50 × (2 / (1 + e^(−0.00368208 × cp)) − 1)
```

This maps the full centipawn range to (0, 100) with 0 cp = 50% win chance. For forced mate scores a large proxy value (±32 000) is used so the logistic function returns values very close to 0 or 100.

The constant `0.00368208` is taken from chess.com's own accuracy formula (derived from their public documentation).

### Classification thresholds

Classification is based on the **win percentage loss from the moving player's perspective** (a positive value means the position got worse for the mover):

| Classification | Condition |
|---|---|
| **Book** | Move is in the detected opening book |
| **Brilliant** | Best move AND sacrifice AND mover's win% increased by ≥ 5 |
| **Best** | Best move (played UCI matches engine's top choice) |
| **Excellent** | Win% loss ≤ 2%, not best move |
| **Good** | Win% loss ≤ 5% |
| **Inaccuracy** | Win% loss ≤ 10% |
| **Mistake** | Win% loss ≤ 20% |
| **Miss** | Mover was winning (> 60%) and is now losing (< 40%) — lost a decisive advantage |
| **Blunder** | Win% loss > 20% |

Note: "Miss" is checked before "Blunder" because it represents a specific pattern (throwing away a decisive advantage) that is more descriptive than just "large loss".

### Accuracy score

Per-player accuracy is computed using the chess.com formula applied to all non-book moves:

```
moveAccuracy = 103.1668 × e^(−0.04354 × loss) − 3.1668
```

where `loss` is the win% loss clamped to [0, 100]. The per-player accuracy is the mean of all individual move accuracies.

### `BADGE_STYLES`

A map of classification → `{ color, symbol, label }` used by the move list to render inline badges.

---

## 8. Opening book detection

**File:** `analysis/opening-book.js`

Chess.com embeds ECO (Encyclopaedia of Chess Openings) information in PGN headers:

```
[ECO "B20"]
[ECOUrl "https://www.chess.com/openings/Sicilian-Defense-2...Nc6-3.Nf3"]
[Opening "Sicilian Defense: Kan Variation"]
```

`detectBookMoves(headers, moves)` uses these to estimate how many plies were opening theory:

1. **ECOUrl present** — the URL path is split on hyphens; each segment roughly represents one move pair. The estimated book depth is `min(segments × 1.5, 20)` plies.
2. **ECO code only** — a conservative 10 plies are marked as book.
3. **Neither** — no moves are marked as book.

This is an approximation. Because chess.com's API does not return the exact number of theory moves, this heuristic works well for common openings but may over- or under-count for unusual lines.

`getOpeningName(headers)` returns the `Opening` header if present, falling back to the `ECO` code.

---

## 9. Side panel UI

**Files:** `sidepanel/sidepanel.js`, `sidepanel/sidepanel.html`, `sidepanel/sidepanel.css`

### State model

`sidepanel.js` maintains a single plain `state` object:

```javascript
{
  gameId, pgn, result, headers,     // game data
  analysis,                          // full AnalysisResult from analyzer.js
  currentIndex,                      // -1 = starting position, 0 = after move 1
  chessInstances,                    // chess.js instance per ply (prebuilt for instant nav)
  isInDeviation, deviationIndex,    // deviation mode
  deviationChess, deviationAbort,   // deviation chess state + abort controller
  analysisAbort,                    // AbortController for in-progress game analysis
}
```

### Game loading pipeline

```
loadGame(gameId, username, gameYearMonth)
  │
  ├── check cache → if hit: buildChessInstances + goToIndex(-1) + applyAnalysisResult
  │
  ├── fetchGame() → game PGN from chess.com API
  ├── buildChessInstances(pgn)  ← prebuilds all N+1 chess.js instances
  ├── goToIndex(-1)             ← shows starting position immediately
  │
  └── analyzeGame(pgn, Chess, { depth:20, onProgress, onMoveResult })
        ├── onMoveResult → moveList.updateMove()  (progressive UI)
        └── on complete  → applyAnalysisResult() + cacheAnalysis()
```

**Why prebuilt chess instances?** Navigating to an arbitrary position with chess.js would require replaying all moves from the start each time. Instead, a `Chess` instance is snapshotted after every move during `buildChessInstances`. Navigation (`goToIndex`) is then O(1): it simply indexes into `state.chessInstances`.

### Deviation mode

When the user drags a piece to a square that does not match the next move in the main line, the side panel enters deviation mode:

1. The played move is applied to a cloned chess instance (`deviationChess`)
2. The move list is dimmed beyond the deviation point with a `— exploring alternative —` marker
3. `analyzePosition(deviationChess.fen(), 16, abortSignal)` is called to evaluate the resulting position
4. The eval bar and best-move arrow update with the engine result
5. The user can keep making moves; each new move re-evaluates the resulting position
6. Pressing **←** or clicking **Return to game** calls `clearDeviation()` which restores the main line at the deviation start index

If the user makes moves quickly, the previous deviation analysis is aborted via `deviationAbort.abort()` before the new one starts.

### Username handling

The chess.com API requires a username to search archives. The content script attempts to extract it from the page but may fail on some layouts. The fallback chain:

1. `username` from the `GAME_OVER` payload (extracted by content script)
2. `cachedUsername` from `chrome.storage.local` (saved from a previous session)
3. An inline prompt dialog asking the user to enter their username

The entered username is saved to local storage so it only needs to be entered once.

---

## 10. Canvas chessboard

**File:** `sidepanel/board.js`

The board is rendered on an HTML5 `<canvas>` element using the 2D API. All rendering is immediate-mode (redrawn from scratch on each state change).

### Coordinate system

The core mapping between chess coordinates and canvas pixels:

```javascript
_squareToXY(file, rank, sz) {
  const cx = this.flipped ? 7 - file : file;
  const cy = this.flipped ? rank      : 7 - rank;
  return { x: cx * sz, y: cy * sz };
}
```

Where `file` is 0–7 (a–h) and `rank` is 0–7 (rank 1 – rank 8). When not flipped, rank 0 maps to `cy = 7` (bottom of canvas) and rank 7 to `cy = 0` (top of canvas) — white at the bottom.

**Important:** `chess.js`'s `board()` method returns `board[0]` = rank 8 (the top row as displayed), not rank 1. `_drawPieces` compensates with `chessRank = 7 - rank` to convert from `board()` array indices to the coordinate system above.

### Render order

```
1. _drawSquares       — fills square colours + rank/file labels
2. _drawHighlights    — semi-transparent dots on legal target squares (during drag)
3. _drawLastMove      — highlight on from/to squares of the last move
4. _drawArrows        — best-move arrow
5. _drawPieces        — piece SVG images (or Unicode glyph fallback)
6. _drawDraggedPiece  — piece being dragged (rendered on top)
7. _drawClassificationBadge — coloured circle + icon at destination square corner
```

### Piece rendering

SVG images from the cburnett set are pre-loaded at module startup via `loadPieceImages()`. In `_drawPiece`, if the image is loaded (`img.complete && img.naturalWidth > 0`), `ctx.drawImage` is used. Otherwise a Unicode chess glyph is drawn as a fallback, which covers the period between board first render and image load completion.

### Classification badges

Badges are drawn with canvas paths rather than text characters to ensure crispness at small sizes. Each badge is a filled circle (colour-coded by classification) with an icon drawn on top:

- **Checkmarks** (Best, Excellent, Good) — two-segment path
- **Exclamation marks** (Great, Brilliant) — vertical stroke + dot
- **Question marks** (Mistake, Blunder, Inaccuracy) — arc + bezier tail + dot
- **Cross** (Miss) — two diagonal strokes
- **Book** — open-book shape with two filled page polygons and horizontal line details

Badge position: top-right corner of the destination square. Size: `r = sz × 0.25` pixels radius.

### Drag and drop

`mousedown` on a piece records `_drag = { from, piece, legalTargets, x, y }` and highlights legal squares. `mousemove` updates `_drag.x/y` and re-renders. `mouseup` checks whether the drop square is in `legalTargets`; if so it calls `this.onMove({ from, to, promotion })`. Touch events are mapped to the same handlers via `_touchToMouse`.

Promotion is handled with a small overlay picker (`_buildPromotionPicker`) that appears when a pawn reaches the last rank.

---

## 11. Storage and caching

**File:** `utils/storage.js`

Three storage mechanisms are used:

| Storage | API | Contents | Lifetime |
|---|---|---|---|
| Session | `chrome.storage.session` | `pendingGame` (gameId, username, gameYearMonth) | Until browser restart |
| Local | `chrome.storage.local` | `analyzedGames` cache, `cachedUsername`, settings | Persistent |
| Web Worker memory | (in-process) | Stockfish search state | While the worker is alive |

### Analysis cache

`cacheAnalysis(gameId, data)` / `getCachedAnalysis(gameId)` implement a simple LRU cache stored as a JSON array in `chrome.storage.local` under the key `analyzedGames`. The array is kept sorted newest-first; on write, any existing entry for the same game is removed before prepending the new one. The array is capped at 20 entries.

The full `AnalysisResult` object (all moves with evaluations, classifications, headers) is stored. On cache hit the board is rebuilt from the cached PGN (`buildChessInstances`) before displaying.

### Settings

`local.getSettings()` merges stored values with defaults:

```javascript
{
  analysisDepth: 20,
  autoAnalyze:   true,
  showBestMove:  true,
  boardTheme:    'default',
}
```

---

## 12. Setup script

**File:** `scripts/setup.js`

Run once via `npm run setup`. Does three things:

1. **Copies chess.js ESM build** from `node_modules/chess.js/dist/esm/chess.js` → `lib/chess.js`

2. **Copies Stockfish files** from `node_modules/stockfish/src/`:
   - `stockfish-nnue-16-single.js` → `lib/stockfish.js`
   - `stockfish-nnue-16-single.wasm` → `lib/stockfish-nnue-16-single.wasm`

   The WASM file **must keep its original name** because `stockfish.js` resolves it at runtime relative to its own script URL by that exact filename. Renaming it to e.g. `stockfish.wasm` would cause a load failure.

3. **Downloads SVG chess pieces** from the Lichess cburnett set via jsDelivr CDN into `icons/pieces/{key}.svg` for each of the 12 piece types (`wK`, `wQ`, `wR`, `wB`, `wN`, `wP`, `bK`, `bQ`, `bR`, `bB`, `bN`, `bP`). Already-downloaded files are skipped.

The `lib/` and `icons/pieces/` directories are not committed to version control because they contain files derived from npm packages and external CDNs.

---

## 13. File reference

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: permissions, CSP, content scripts, side panel path, web-accessible resources |
| `background/service-worker.js` | Receives `GAME_OVER`, stores pending game in `chrome.storage.session`, opens side panel, forwards message to open panel |
| `content/dom-observer.js` | `observeGameEnd()`, `extractGameId()`, `extractUsername()`, `extractGameDate()` — runs on chess.com pages |
| `content/content-script.js` | Calls `observeGameEnd(handleGameOver)`, builds payload, sends `GAME_OVER` to service worker |
| `sidepanel/sidepanel.html` | HTML shell for the side panel; loads `sidepanel.js` as an ES module |
| `sidepanel/sidepanel.css` | Dark theme CSS for all side panel elements |
| `sidepanel/sidepanel.js` | Main controller: state, game loading pipeline, navigation, deviation mode, UI helpers |
| `sidepanel/board.js` | `ChessBoard` class: Canvas 2D rendering, SVG pieces, drag-and-drop, classification badges |
| `sidepanel/eval-bar.js` | `EvalBar` class: animated vertical evaluation bar |
| `sidepanel/move-list.js` | `MoveList` class: paired move rows, per-move classification badges, deviation dimming |
| `analysis/analyzer.js` | `StockfishEngine` class + `analyzeGame()` + `analyzePosition()` |
| `analysis/classifier.js` | `cpToWinPct()`, `classifyMove()`, `computeAccuracy()`, `BADGE_STYLES` |
| `analysis/opening-book.js` | `detectBookMoves()`, `getOpeningName()` |
| `utils/api.js` | `fetchGame()`, `fetchArchives()`, `fetchGamesForMonth()`, `fetchLatestGame()` |
| `utils/pgn-parser.js` | `parsePGNHeaders()`, `pgnToMoveList()`, `extractMoveAnnotations()`, `stripAnnotations()` |
| `utils/storage.js` | `session`, `local`, `cacheAnalysis()`, `getCachedAnalysis()`, `clearCache()` |
| `scripts/setup.js` | One-time setup: copies library files, downloads piece SVGs |
| `lib/chess.js` | chess.js ESM build (generated, not committed) |
| `lib/stockfish.js` | Stockfish 16 single-thread JS worker (generated, not committed) |
| `lib/stockfish-nnue-16-single.wasm` | Stockfish 16 NNUE WASM binary (generated, not committed) |
| `icons/pieces/*.svg` | cburnett SVG piece set — 12 files (generated, not committed) |
