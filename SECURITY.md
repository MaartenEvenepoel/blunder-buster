# Security policy

## Supported versions

Only the latest version of Blunder Buster is actively maintained. Please make sure you are running the most recent commit from `main` before reporting a vulnerability.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability, send an email to the repository maintainer. You can find contact details on the GitHub profile page. Please include:

- A description of the vulnerability
- Steps to reproduce it
- The potential impact
- Any suggested mitigations, if you have them

You can expect an acknowledgement within 72 hours and a resolution or status update within 14 days.

## Scope

Blunder Buster is a browser extension that:

- Runs content scripts on `https://www.chess.com/*`
- Fetches data from `https://api.chess.com/pub/*` (read-only, public API)
- Stores usernames and game analysis results in `chrome.storage.local`
- Runs the Stockfish engine locally as a Web Worker — no data is sent to any external server

Areas of particular interest for security research:

- Content script injection or XSS risks on chess.com pages
- Unintended data exfiltration from `chrome.storage`
- Privilege escalation via the extension's `host_permissions`

## What is out of scope

- Vulnerabilities in chess.com itself
- Vulnerabilities in the Stockfish engine or chess.js library (please report those to their respective maintainers)
- Theoretical attacks that require physical access to the user's machine
