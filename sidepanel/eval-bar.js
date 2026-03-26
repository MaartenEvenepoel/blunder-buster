// Blunder Buster — Evaluation Bar component

export class EvalBar {
  /**
   * @param {HTMLElement} container  element that will hold the bar
   */
  constructor(container) {
    this.container = container;
    this._build();
    this.update(0, false);
  }

  _build() {
    this.container.innerHTML = `
      <div class="eval-bar">
        <div class="eval-bar__black"></div>
        <div class="eval-bar__white"></div>
        <div class="eval-bar__label eval-bar__label--top"></div>
        <div class="eval-bar__label eval-bar__label--bottom"></div>
      </div>`;
    this._black  = this.container.querySelector('.eval-bar__black');
    this._white  = this.container.querySelector('.eval-bar__white');
    this._top    = this.container.querySelector('.eval-bar__label--top');
    this._bottom = this.container.querySelector('.eval-bar__label--bottom');
  }

  /**
   * Update the bar to reflect a new evaluation.
   *
   * @param {number}  cp      centipawn score (white-perspective, + = white better)
   * @param {boolean} isMate  true if this is a forced mate score
   * @param {boolean} [flipped=false]  true when board is flipped (black at bottom)
   */
  update(cp, isMate, flipped = false) {
    const winPct = cpToWinPct(cp, isMate);   // 0-100, % for white

    // White bar grows from the bottom (or top when flipped)
    const whitePct = flipped ? 100 - winPct : winPct;
    this._white.style.height = `${whitePct}%`;
    this._black.style.height = `${100 - whitePct}%`;

    // Labels
    const text = isMate
      ? (cp > 0 ? `M${Math.abs(cp)}` : `-M${Math.abs(cp)}`)
      : formatCp(cp);

    if (flipped) {
      this._top.textContent    = text;
      this._bottom.textContent = '';
    } else {
      this._top.textContent    = cp < 0 ? text : '';
      this._bottom.textContent = cp >= 0 ? text : '';
    }

    // Colour the numeric label based on who's ahead
    const labelEl = cp >= 0 ? this._bottom : this._top;
    labelEl.style.color = '';
    const inactiveEl = cp >= 0 ? this._top : this._bottom;
    inactiveEl.textContent = '';
  }

  /** Show a loading / unknown state */
  reset() {
    this.update(0, false);
  }
}

// ── Helpers (duplicated here to keep the module self-contained) ──────────────

function cpToWinPct(cp, isMate) {
  if (isMate) cp = cp > 0 ? 32000 - cp * 10 : -32000 - cp * 10;
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

function formatCp(cp) {
  const abs = Math.abs(cp) / 100;
  const sign = cp >= 0 ? '+' : '-';
  return `${sign}${abs.toFixed(1)}`;
}
