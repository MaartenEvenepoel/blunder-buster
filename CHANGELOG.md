# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial public release
- Automatic game-end detection on chess.com via MutationObserver, title watcher, and History API interception
- Local Stockfish 16 NNUE analysis (single-thread WebAssembly, runs entirely in the browser)
- Move classification: Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Blunder, Miss, Book
- Per-player accuracy scores using the chess.com accuracy formula
- Fast path: reuses embedded `%eval` annotations from chess.com PGN when available, skipping Stockfish
- Interactive Canvas chessboard with drag-and-drop and touch support
- SVG chess pieces (Lichess cburnett set)
- Classification badges drawn with canvas paths on the destination square of each move
- Animated evaluation bar
- Best-move arrow overlay
- Deviation mode: explore alternative lines from any position with real-time engine evaluation
- Opening name detection from PGN ECO headers
- LRU analysis cache (up to 20 games, persisted in `chrome.storage.local`)
- Automatic side panel opening when a game ends
- Username prompt with local caching so the user only needs to enter it once
- Two-phase game lookup: fast path using the date extracted from `window.__NEXT_DATA__`, full archive fallback
- Keyboard navigation (arrow keys)
