// Blunder Buster — Coach Panel
// Provides per-move explanations: rule-based instantly, Claude API if a key is set.

import { getCoachExplanation, saveCoachExplanation } from '../utils/storage.js';

const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

function pieceName(p) { return PIECE_NAMES[p?.toLowerCase()] ?? p ?? 'piece'; }
function sign(n)       { return n >= 0 ? '+' : ''; }
function fmtDelta(d)   { return `${sign(-d)}${Math.abs(Math.round(d))}%`; }

export class CoachPanel {
  /**
   * @param {HTMLElement} el          — the #coach-panel container
   * @param {function}    getApiKey   — async () => string|''
   * @param {function}    getGameId   — () => string|null
   */
  constructor(el, getApiKey, getGameId) {
    this._el        = el;
    this._getApiKey = getApiKey;
    this._getGameId = getGameId;
    this._abort     = null;   // AbortController for the in-flight fetch
    this._nameEl    = el.querySelector('#coach-name');
    this._textEl    = el.querySelector('#coach-text');
    this._badgeEl   = el.querySelector('#coach-ai-badge');
    this.clear();
  }

  /** Called whenever the user navigates to a move. */
  async show(moveData, chessInstance, headers = {}) {
    // Cancel any previous in-flight LLM call immediately
    this._abort?.abort();
    this._abort = null;

    const bestSan = this._uciBestToSan(moveData.bestUci, chessInstance);

    // 1. Rule-based text appears instantly
    const ruleText = this._buildRuleText(moveData, bestSan, headers);
    this._setText(ruleText, false);

    // 2. Check cache for a saved AI explanation
    const gameId = this._getGameId();
    if (gameId) {
      const cached = await getCoachExplanation(gameId, moveData.moveIndex);
      if (cached?.isAI) {
        this._setText(cached.text, true);
        return;
      }
    }

    // 3. If we have an API key, fetch from Gemini
    const apiKey = await this._getApiKey();
    if (apiKey) {
      await this._callGemini(moveData, bestSan, headers, apiKey, gameId);
    }
  }

  /** Called when the user is at the starting position. */
  clear() {
    this._abort?.abort();
    this._abort = null;
    this._setText('Select a move to see coach feedback.', false, true);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _setText(text, isAI, dim = false) {
    this._textEl.textContent = text;
    this._textEl.style.opacity = dim ? '0.45' : '1';
    this._badgeEl.classList.toggle('visible', isAI);
  }

  _uciBestToSan(bestUci, chessInstance) {
    if (!bestUci || !chessInstance) return null;
    try {
      const clone = chessInstance.clone ? chessInstance.clone() : null;
      if (!clone) return null;
      const result = clone.move({ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), promotion: bestUci[4] });
      return result?.san ?? null;
    } catch {
      return null;
    }
  }

  _buildRuleText(moveData, bestSan, headers) {
    const { san, classification, color, piece, captured, isSacrifice, isBookMove,
            winPctBefore, winPctAfter } = moveData;

    const moverWinBefore = color === 'w' ? winPctBefore : 100 - winPctBefore;
    const moverWinAfter  = color === 'w' ? winPctAfter  : 100 - winPctAfter;
    const delta          = moverWinBefore - moverWinAfter; // positive = got worse
    const bestStr        = bestSan ? ` ${bestSan} was the engine's choice.` : '';
    const captureStr     = captured ? `, capturing the ${pieceName(captured)},` : '';
    const opening        = headers?.Opening ?? headers?.ECO ?? null;

    switch (classification) {
      case 'Brilliant':
        return `${san} is a brilliant move${captureStr}! Moving the ${pieceName(piece)} to an attacked square looks risky, but it gains ${fmtDelta(-delta)} winning chances — the engine's top pick. A genuinely strong find.`;

      case 'Great':
        return `${san} is a great move. It gains ${fmtDelta(-delta)} winning chances and ranks among the engine's top suggestions. Well played.`;

      case 'Best':
        return `${san} is the engine's best move in this position${captureStr}. You found the most precise continuation, keeping the position under control.`;

      case 'Excellent':
        return `${san} is an excellent move${captureStr}. It stays very close to the engine's top choice and loses only ${fmtDelta(delta)} winning chances.`;

      case 'Good':
        return `${san} is a good, solid move${captureStr}. It loses ${fmtDelta(delta)} winning chances — within the acceptable range.${bestStr}`;

      case 'Inaccuracy':
        return `${san}${captureStr} is an inaccuracy, losing ${fmtDelta(delta)} winning chances.${bestStr} Not a blunder, but a more precise move was available.`;

      case 'Mistake':
        return `${san}${captureStr} is a mistake, giving away ${fmtDelta(delta)} winning chances.${bestStr}${isSacrifice ? ' The piece sacrifice here was not fully sound.' : ''}`;

      case 'Blunder':
        return `${san}${captureStr} is a blunder — it loses ${fmtDelta(delta)} winning chances.${bestStr}${isSacrifice ? ' This apparent sacrifice backfires.' : ''}`;

      case 'Miss':
        return `${san} is a miss. You had a ${Math.round(moverWinBefore)}% chance of winning but dropped to ${Math.round(moverWinAfter)}% — a decisive advantage was let go.${bestStr}`;

      case 'Book':
        return opening
          ? `${san} is a book move in the ${opening}. You're still in well-known opening theory.`
          : `${san} is a book move — this line is part of established opening theory.`;

      default:
        return `${san} was played here.`;
    }
  }

  async _callGemini(moveData, bestSan, headers, apiKey, gameId) {
    const { san, classification, color, moveIndex, winPctBefore, winPctAfter,
            evalBefore, evalAfter, isSacrifice } = moveData;

    const moverWinBefore = color === 'w' ? winPctBefore : 100 - winPctBefore;
    const moverWinAfter  = color === 'w' ? winPctAfter  : 100 - winPctAfter;
    const moveNum        = Math.floor(moveIndex / 2) + 1;
    const colorLabel     = color === 'w' ? 'White' : 'Black';
    const opening        = headers?.Opening ?? headers?.ECO ?? 'unknown opening';
    const whiteElo       = headers?.WhiteElo ? ` (${headers.WhiteElo})` : '';
    const blackElo       = headers?.BlackElo ? ` (${headers.BlackElo})` : '';

    const systemPrompt =
      `You are Buster, a friendly and direct chess coach inside a browser extension. ` +
      `Explain in exactly 2–3 sentences why the move was classified as "${classification}". ` +
      `Be specific: name the piece, the square it moved to, and the concrete tactical or strategic reason. ` +
      `Do not use markdown, bullet points, or headers. Write in plain prose.`;

    const userMessage =
      `Game: ${opening}\n` +
      `White: ${headers?.White ?? 'Unknown'}${whiteElo} | Black: ${headers?.Black ?? 'Unknown'}${blackElo}\n` +
      `Move ${moveNum} (${colorLabel}): ${san} — classified as ${classification}\n` +
      `Eval before: ${evalBefore} cp (${Math.round(moverWinBefore)}% for mover)\n` +
      `Eval after: ${evalAfter} cp (${Math.round(moverWinAfter)}% for mover)\n` +
      `Win% change for mover: ${fmtDelta(moverWinBefore - moverWinAfter)}\n` +
      (bestSan ? `Engine preferred: ${bestSan}\n` : '') +
      (isSacrifice ? `Sacrifice: yes (piece moved to attacked square)\n` : '');

    this._abort = new AbortController();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const res = await fetch(url, {
        method:  'POST',
        signal:  this._abort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userMessage }] }],
          generationConfig: { maxOutputTokens: 300, temperature: 0.4 },
        }),
      });

      if (res.status === 400 || res.status === 403) {
        this._textEl.textContent = '⚠ Invalid API key — check Settings.';
        this._textEl.style.color = 'var(--danger)';
        return;
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg  = body?.error?.message ?? `API error ${res.status}`;
        console.warn('Buster:', msg);
        this._textEl.textContent = `⚠ ${msg}`;
        this._textEl.style.color = 'var(--danger)';
        return;
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
      if (!text) return;

      this._setText(text, true);

      if (gameId) {
        saveCoachExplanation(gameId, moveIndex, text, true).catch(() => {});
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.warn('Buster: fetch failed', err);
    }
  }
}
