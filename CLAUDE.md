# Blunder Buster — Claude Code Instructions

## Project overview

Chrome Manifest V3 extension that detects chess.com game completions, fetches the PGN, runs Stockfish 16 WASM analysis in a side panel, and classifies every move with badge icons. Optionally upgrades move explanations via Google Gemini Flash (user-supplied API key).

## Dev setup

```bash
npm install
node scripts/setup.js   # copies chess.js + stockfish into lib/
npm run lint            # ESLint
npm run validate        # custom validation script
```

Load as unpacked extension in `chrome://extensions` — no build step required.

## Architecture constraints

- **No build step, no transpilation.** Vanilla JS only. Do not introduce bundlers, TypeScript, or JSX.
- **ES modules in sidepanel context** (`sidepanel/*.js`, `analysis/*.js`, `utils/*.js`). Use `import`/`export`.
- **Classic scripts in content context** (`content/dom-observer.js`, `content/content-script.js`). These run as regular `<script>` tags sharing scope — no `import`/`export`.
- **`lib/` is vendored — do not edit.** `lib/chess.js` and `lib/stockfish.js` are copied from node_modules by `scripts/setup.js`. Treat them as read-only.
- The Stockfish worker (`lib/stockfish.js`) is loaded directly as a Web Worker and auto-initializes over UCI via `postMessage`/`onmessage`.

## Key file map

| File | Role |
|------|------|
| `manifest.json` | Extension manifest |
| `background/service-worker.js` | Routes GAME_OVER messages, opens side panel |
| `content/dom-observer.js` | MutationObserver + history interception to detect game end |
| `content/content-script.js` | Sends GAME_OVER to service worker; manages per-game state |
| `utils/api.js` | chess.com API calls (fetch PGN by gameId or username) |
| `utils/storage.js` | chrome.storage.local wrappers for settings, cache, coach cache |
| `utils/pgn-parser.js` | PGN → move list with FEN, UCI, %eval annotations |
| `analysis/analyzer.js` | Full game analysis orchestration; parallel Stockfish workers |
| `analysis/classifier.js` | `cpToWinPct`, `classifyMove`, `computeAccuracy`, `BADGE_STYLES` |
| `analysis/opening-book.js` | Marks book moves from PGN ECO/opening headers |
| `sidepanel/sidepanel.js` | Main controller: state, navigation, rendering |
| `sidepanel/board.js` | Canvas chessboard renderer, drag-drop, deviation mode |
| `sidepanel/eval-bar.js` | `EvalBar` class — white/black advantage bar |
| `sidepanel/move-list.js` | `MoveList` class — per-move badges and navigation |
| `sidepanel/coach.js` | `CoachPanel` class — rule-based + Gemini AI explanations |

## Analysis pipeline (high level)

1. Content script detects game over → sends `GAME_OVER { gameId, username, gameYearMonth }` to service worker
2. Service worker stores in session storage, opens side panel
3. `sidepanel.js` reads pending game, fetches PGN from `api.chess.com`
4. `buildChessInstances(pgn)` — one `Chess` instance per ply for O(1) navigation
5. `analyzeGame(pgn, Chess, options)` — evaluates N+1 positions using 2 parallel Stockfish workers
6. If PGN contains `%eval` annotations: use those scores (fast path) + run SF at depth 14 for bestMove only
7. `classifyMove()` per move using win% loss thresholds (see `classifier.js`)
8. Progressive rendering via `onMoveResult` callback
9. Results cached in `chrome.storage.local` with `schemaVersion: 2`

## chess.com API endpoints

- `GET https://api.chess.com/pub/game/{gameId}` — single game with PGN
- `GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}` — monthly archive
- `GET https://api.chess.com/pub/player/{username}/games/archives` — list of archive months

## Important invariants

- **Stockfish scores are from side-to-move POV.** `normalizeToWhite()` in `analyzer.js` negates when it's black's turn. Always pass `isMate` correctly — a raw mate distance of 3 treated as centipawns gives ~50% win probability (a past bug).
- **`schemaVersion: 2`** must be present on cached analysis results. The cache check in `sidepanel.js` rejects entries without it to force re-analysis when the schema changes.
- **`%eval` fast path:** chess.com games always embed eval annotations. The fast path uses PGN scores for eval but still runs Stockfish at depth 14 to get `bestMove` — without this, Best/Brilliant/Great classifications are never assigned.
- **Content scripts share scope** — `dom-observer.js` is loaded before `content-script.js` and its globals (`observeGameEnd`, `extractGameId`, etc.) are available directly.
- **Game ID tracking:** Both `dom-observer.js` and `content-script.js` track the last seen game ID. Flag resets and `GAME_OVER` messages must only trigger when the game ID actually changes — chess.com mutates the URL for within-game move navigation.

## Move classification thresholds (win% loss, mover's perspective)

| Classification | Condition |
|----------------|-----------|
| Miss | Was winning (>60%) → now losing (<40%), loss >20% |
| Blunder | loss > 20% |
| Mistake | loss > 10% |
| Inaccuracy | loss > 5% |
| Good | loss > 2% |
| Best | loss ≤ 2%, played best move |
| Excellent | loss ≤ 2%, not best move |
| Great | loss ≤ 2%, best move, win% gain ≥ 3% |
| Brilliant | loss ≤ 2%, best move, sacrifice, win% gain ≥ 5% |
| Book | opening book move |

## Gemini AI coach

- Provider: Google Gemini Flash (`generativelanguage.googleapis.com/v1beta`)
- Model: `gemini-2.5-flash`
- Auth: user-supplied API key stored in `chrome.storage.local` via settings panel
- Responses cached in `coachCache` (500 entry cap, evict 100 oldest on overflow)
- `AbortController` cancels in-flight requests when user navigates to another move

## Code style

- Single quotes for strings
- 2-space indentation
- No semicolons are NOT required — the codebase uses semicolons; keep them
- Prefer `const` / `let`, never `var`
- Async/await over raw Promise chains where readable
- Do not add JSDoc to code you didn't write or change
- Do not add error handling for impossible cases — trust internal invariants
