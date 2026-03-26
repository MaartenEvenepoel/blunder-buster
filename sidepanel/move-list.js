// Blunder Buster — Move List component

import { BADGE_STYLES } from '../analysis/classifier.js';

export class MoveList {
  /**
   * @param {HTMLElement} container
   * @param {function} onMoveClick  (moveIndex: number) => void
   */
  constructor(container, onMoveClick) {
    this.container   = container;
    this.onMoveClick = onMoveClick;
    this._moves      = [];      // MoveData[]
    this._currentIdx = -1;
    this._deviationIdx = -1;   // index where deviation starts (-1 = no deviation)
    this.container.innerHTML = '';
  }

  /**
   * Render the full move list from an array of MoveData.
   * Can be called incrementally (items are replaced/added as analysis arrives).
   * @param {object[]} moves  Array of MoveData objects
   */
  render(moves) {
    this._moves = moves;
    this._rebuild();
  }

  /**
   * Update a single move entry (called as Stockfish analysis completes per move).
   * @param {object} moveData
   */
  updateMove(moveData) {
    this._moves[moveData.moveIndex] = moveData;
    const existing = this.container.querySelector(`[data-idx="${moveData.moveIndex}"]`);
    const newEl = this._buildMoveEntry(moveData);
    if (existing) {
      existing.replaceWith(newEl);
    } else {
      // Append to the row this move belongs to
      this._rebuild();
    }
  }

  /**
   * Highlight the current move (as the user navigates).
   * @param {number} idx  0-based move index, or -1 for start position
   */
  setCurrentIndex(idx) {
    this._currentIdx = idx;
    this.container.querySelectorAll('[data-idx]').forEach(el => {
      el.classList.toggle('move-entry--active', parseInt(el.dataset.idx) === idx);
    });
    // Scroll active entry into view
    const active = this.container.querySelector('.move-entry--active');
    active?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * Show a deviation indicator after a given move index.
   * Moves after deviationIdx are dimmed.
   * @param {number} idx  0-based index of last main-line move before deviation
   */
  setDeviationStart(idx) {
    this._deviationIdx = idx;
    this._rebuild();
  }

  clearDeviation() {
    this._deviationIdx = -1;
    this._rebuild();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _rebuild() {
    this.container.innerHTML = '';

    if (this._moves.length === 0) return;

    // Group moves into rows: white move + black move per row
    for (let i = 0; i < this._moves.length; i += 2) {
      const row = document.createElement('div');
      row.className = 'move-row';

      const moveNum = document.createElement('span');
      moveNum.className = 'move-number';
      moveNum.textContent = `${Math.floor(i / 2) + 1}.`;
      row.appendChild(moveNum);

      // White move (index i)
      if (i < this._moves.length) {
        row.appendChild(this._buildMoveEntry(this._moves[i]));
      }

      // Black move (index i+1)
      if (i + 1 < this._moves.length) {
        row.appendChild(this._buildMoveEntry(this._moves[i + 1]));
      }

      this.container.appendChild(row);
    }

    // Insert deviation marker if applicable
    if (this._deviationIdx >= 0) {
      const row  = Math.floor(this._deviationIdx / 2);
      const rows = this.container.querySelectorAll('.move-row');
      if (rows[row]) {
        const marker = document.createElement('div');
        marker.className = 'deviation-marker';
        marker.textContent = '— exploring alternative —';
        rows[row].after(marker);
        // Dim rows after deviation
        for (let r = row + 1; r < rows.length; r++) {
          rows[r].classList.add('move-row--dimmed');
        }
      }
    }

    // Restore active state
    this.setCurrentIndex(this._currentIdx);
  }

  _buildMoveEntry(moveData) {
    const el = document.createElement('span');
    el.className = 'move-entry';
    el.dataset.idx = moveData.moveIndex;

    if (moveData.moveIndex === this._currentIdx) {
      el.classList.add('move-entry--active');
    }
    if (this._deviationIdx >= 0 && moveData.moveIndex > this._deviationIdx) {
      el.classList.add('move-entry--dimmed');
    }

    el.textContent = moveData.san;

    if (moveData.classification) {
      const badge = this._buildBadge(moveData.classification);
      el.appendChild(badge);
    }

    el.addEventListener('click', () => this.onMoveClick(moveData.moveIndex));

    return el;
  }

  _buildBadge(classification) {
    const style = BADGE_STYLES[classification];
    if (!style) return document.createTextNode('');

    const badge = document.createElement('span');
    badge.className = 'move-badge';
    badge.title     = style.label;
    badge.textContent = style.symbol;
    badge.style.color = style.color;
    return badge;
  }
}
