# Contributing to Blunder Buster

Thank you for your interest in contributing. This document explains how to get the project running locally and what to keep in mind when submitting changes.

---

## Development setup

### Prerequisites

- **Node.js 18+**
- **Google Chrome 114+** (or any Chromium-based browser that supports the Side Panel API)

### First-time setup

```bash
git clone https://github.com/MaartenEvenepoel/blunder-buster.git
cd blunder-buster
npm install       # installs chess.js and stockfish npm packages
npm run setup     # copies library files into lib/ and downloads piece SVGs into icons/pieces/
```

The `setup` script must be re-run any time you run `npm install` from scratch (e.g. after cloning on a new machine). It is safe to run multiple times — already-downloaded SVGs are skipped.

### Loading the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right)
3. Click **Load unpacked** → select the repository root
4. The Blunder Buster icon appears in the toolbar

After making code changes, click the **refresh icon** on the extension card in `chrome://extensions` to reload it. Changes to the side panel HTML/CSS/JS take effect immediately after reload; changes to the service worker or content scripts may require closing and reopening the chess.com tab.

### Linting

```bash
npm run lint        # ESLint across all source files
npm run validate    # checks manifest.json and that all referenced files exist
```

Both checks run automatically in CI on every pull request.

---

## Project structure overview

The codebase has four distinct browser contexts. Understanding which context a file runs in is important — they have different APIs and different module system rules.

| Context | Files | Notes |
|---|---|---|
| Content script | `content/` | Classic scripts (no ES module `import`). Injected into chess.com pages. |
| Service worker | `background/` | ES module. Terminates after ~30 s idle; do not store state in memory. |
| Side panel | `sidepanel/`, `analysis/`, `utils/` | ES modules. Full browser API access. |
| Web worker | `lib/stockfish.js` | Generated file — do not edit. Communicates via plain UCI strings. |

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed explanation of how these contexts interact.

---

## Guidelines

### Scope

- **Bug fixes** are always welcome. Please open an issue first for anything non-trivial so we can align on the approach.
- **New features** should be discussed in a GitHub issue before a pull request is opened. The extension is intentionally focused on post-game analysis; features that require persistent background activity or broad new permissions are unlikely to be accepted.

### Code style

- Follow the existing patterns in each file — indentation, naming conventions, and comment style should be consistent with surrounding code.
- ES modules (`import`/`export`) everywhere except `content/` scripts, which are classic scripts.
- No build step, no bundler. The code runs directly in the browser as written.
- Do not introduce new external dependencies without discussion. The dependency surface is intentionally small.

### Content Security Policy

The extension's CSP only allows `'self'` and `'wasm-unsafe-eval'`. Any code that uses `eval`, `new Function`, or dynamically constructed `<script>` tags will be blocked and must not be added.

### chess.com API

The chess.com public API is rate-limited. The existing code includes 300 ms delays between archive requests. Do not remove these or add new endpoints that could hammer the API.

### Manifest permissions

Do not add new `permissions` or `host_permissions` entries without a strong justification. Each addition expands the extension's attack surface and will receive scrutiny during review.

---

## Pull request checklist

- [ ] `npm run lint` passes with no new errors
- [ ] `npm run validate` passes
- [ ] Manually tested in Chrome with a real chess.com game
- [ ] CHANGELOG.md updated under `[Unreleased]`
- [ ] New behaviour is covered in ARCHITECTURE.md if it changes the design

---

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). The most useful things to include are the browser version, the chess.com game URL, and any errors from the browser console (`F12` → Console tab, or right-click the side panel → Inspect).
