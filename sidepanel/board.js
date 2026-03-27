// Blunder Buster — Canvas Chessboard

// Unicode chess symbols (fallback when SVGs not loaded)
const GLYPHS = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

// SVG piece images — loaded once, cached here
const PIECE_IMAGES = {};
const PIECE_KEYS = ['wK','wQ','wR','wB','wN','wP','bK','bQ','bR','bB','bN','bP'];

function loadPieceImages() {
  for (const key of PIECE_KEYS) {
    const img = new Image();
    img.src = chrome.runtime.getURL(`icons/pieces/${key}.svg`);
    PIECE_IMAGES[key] = img;
  }
}

// Board color themes
const THEMES = {
  default: { light: '#f0d9b5', dark: '#b58863', highlight: 'rgba(20,85,30,0.5)', lastMove: 'rgba(20,85,30,0.35)' },
};

loadPieceImages();

export class ChessBoard {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object}            options
   * @param {function}          options.onMove  ({ from, to, promotion }) => void
   *                             Called when the user drags a piece to a legal square.
   */
  constructor(canvas, { onMove } = {}) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.onMove   = onMove ?? (() => {});
    this.flipped  = false;
    this.theme    = THEMES.default;

    // State
    this._chess          = null;   // chess.js instance for current position
    this._lastMove       = null;   // { from, to }
    this._classification = null;   // classification string for last move badge
    this._highlights     = [];     // squares to highlight
    this._arrows         = [];     // [{ from, to, color }]
    this._drag           = null;   // { from, piece, x, y, legalTargets }
    this._promotionPending = null; // { from, to, resolve }

    this._bindEvents();
    this._buildPromotionPicker();
  }

  get squareSize() {
    return this.canvas.width / 8;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Render a position from a chess.js Chess instance.
   * @param {Chess}  chess
   * @param {{ from:string, to:string }|null} lastMove
   * @param {string|null} classification  e.g. 'blunder', 'brilliant', etc.
   */
  setPosition(chess, lastMove = null, classification = null) {
    this._chess          = chess;
    this._lastMove       = lastMove;
    this._classification = classification;
    this._drag           = null;
    this._render();
  }

  flip() {
    this.flipped = !this.flipped;
    this._render();
  }

  /**
   * Draw a best-move arrow on the board.
   * @param {string|null} uci  e.g. "e2e4", or null to clear
   */
  showArrow(uci) {
    this._arrows = uci ? [{ from: uci.slice(0, 2), to: uci.slice(2, 4), color: 'rgba(0,120,255,0.55)' }] : [];
    this._render();
  }

  clearArrows() {
    this._arrows = [];
    this._render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  _render() {
    const { ctx, canvas } = this;
    const sz = this.squareSize;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this._drawSquares(sz);
    this._drawHighlights(sz);
    if (this._lastMove) this._drawLastMove(sz);
    this._drawArrows(sz);
    if (this._chess) this._drawPieces(sz);
    if (this._drag)  this._drawDraggedPiece(sz);
    if (this._lastMove && this._classification) this._drawClassificationBadge(sz);
  }

  _drawSquares(sz) {
    const { ctx, theme, flipped } = this;
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const { x, y } = this._squareToXY(file, rank, sz);
        ctx.fillStyle = (rank + file) % 2 === 0 ? theme.dark : theme.light;
        ctx.fillRect(x, y, sz, sz);
      }
    }

    // Rank & file labels
    ctx.font = `bold ${sz * 0.18}px sans-serif`;
    ctx.textBaseline = 'top';

    // File labels along the bottom edge of the canvas
    for (let col = 0; col < 8; col++) {
      const chessFile = flipped ? 7 - col : col;
      const fileChar  = String.fromCharCode(97 + chessFile);
      const x = col * sz;
      const y = 7 * sz;
      const dark = (chessFile + (flipped ? 7 : 0)) % 2 === 0;
      ctx.fillStyle = dark ? theme.light : theme.dark;
      ctx.fillText(fileChar, x + sz * 0.03, y + sz * 0.75);
    }

    // Rank labels along the left edge of the canvas
    for (let row = 0; row < 8; row++) {
      const chessRank = flipped ? row : 7 - row;
      const rankLabel = chessRank + 1;
      const y = row * sz;
      const dark = chessRank % 2 === 0;
      ctx.fillStyle = dark ? theme.light : theme.dark;
      ctx.fillText(rankLabel, sz * 0.03, y + sz * 0.03);
    }
  }

  _drawLastMove(sz) {
    if (!this._lastMove) return;
    const { ctx, theme } = this;
    ctx.fillStyle = theme.lastMove;
    for (const sq of [this._lastMove.from, this._lastMove.to]) {
      const { x, y } = this._sqNameToXY(sq, sz);
      ctx.fillRect(x, y, sz, sz);
    }
  }

  _drawHighlights(sz) {
    const { ctx, theme } = this;
    ctx.fillStyle = theme.highlight;
    for (const sq of this._highlights) {
      const { x, y } = this._sqNameToXY(sq, sz);
      ctx.beginPath();
      ctx.arc(x + sz / 2, y + sz / 2, sz * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawArrows(sz) {
    const { ctx } = this;
    for (const arrow of this._arrows) {
      this._drawArrow(ctx, arrow.from, arrow.to, sz, arrow.color);
    }
  }

  _drawArrow(ctx, from, to, sz, color) {
    const f = this._sqNameToXY(from, sz);
    const t = this._sqNameToXY(to, sz);
    const fx = f.x + sz / 2, fy = f.y + sz / 2;
    const tx = t.x + sz / 2, ty = t.y + sz / 2;

    const angle  = Math.atan2(ty - fy, tx - fx);
    const headLen = sz * 0.35;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle   = color;
    ctx.lineWidth   = sz * 0.17;
    ctx.lineCap     = 'round';

    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx - headLen * 0.6 * Math.cos(angle), ty - headLen * 0.6 * Math.sin(angle));
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - headLen * Math.cos(angle - 0.4), ty - headLen * Math.sin(angle - 0.4));
    ctx.lineTo(tx - headLen * Math.cos(angle + 0.4), ty - headLen * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  _drawPieces(sz) {
    const board = this._chess.board();
    for (let rank = 0; rank < 8; rank++) {
      for (let file = 0; file < 8; file++) {
        const piece = board[rank][file];
        if (!piece) continue;
        // chess.board() index 0 = rank 8 (top), index 7 = rank 1 (bottom).
        // _squareToXY expects chess rank index (0 = rank 1 = bottom), so invert.
        const chessRank = 7 - rank;
        const sq = this._fileRankToSqName(file, chessRank);
        if (this._drag?.from === sq) continue;
        const { x, y } = this._squareToXY(file, chessRank, sz);
        this._drawPiece(piece.color + piece.type.toUpperCase(), x + sz / 2, y + sz / 2, sz);
      }
    }
  }

  _drawDraggedPiece(sz) {
    const { _drag: d } = this;
    if (!d) return;
    this._drawPiece(d.piece, d.x, d.y, sz);
  }

  _drawPiece(key, cx, cy, sz) {
    const { ctx } = this;
    const img = PIECE_IMAGES[key];
    if (img?.complete && img.naturalWidth > 0) {
      const half = sz * 0.47;
      ctx.drawImage(img, cx - half, cy - half, half * 2, half * 2);
      return;
    }

    // Unicode fallback
    const glyph = GLYPHS[key];
    if (!glyph) return;
    const color   = key[0] === 'w' ? 'white' : '#1a1a1a';
    const outline = key[0] === 'w' ? '#333' : '#eee';
    ctx.font = `${sz * 0.78}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle  = outline;
    ctx.lineWidth    = sz * 0.06;
    ctx.strokeText(glyph, cx, cy);
    ctx.fillStyle    = color;
    ctx.fillText(glyph, cx, cy);
  }

  // ── Classification badge ─────────────────────────────────────────────────────

  _drawClassificationBadge(sz) {
    const BADGE = {
      brilliant:  { bg: '#1baca6', icon: 'double_exclaim'  },
      great:      { bg: '#5c8bb0', icon: 'exclaim'         },
      best:       { bg: '#7ab32a', icon: 'star_filled'     },
      excellent:  { bg: '#4a9e6a', icon: 'star_outline'    },
      good:       { bg: '#7a9e6e', icon: 'plus'            },
      inaccuracy: { bg: '#c9971e', icon: 'question_exclaim' },
      mistake:    { bg: '#e07b3c', icon: 'question'        },
      blunder:    { bg: '#ca3431', icon: 'double_question'  },
      miss:       { bg: '#8b1a1a', icon: 'cross'           },
      book:       { bg: '#7a5c3a', icon: 'lines'           },
    };

    const style = BADGE[this._classification?.toLowerCase()];
    if (!style) return;

    const { ctx } = this;
    const { x, y } = this._sqNameToXY(this._lastMove.to, sz);

    const r  = Math.round(sz * 0.25);
    const bx = Math.round(x + sz - r * 0.88);
    const by = Math.round(y + r * 0.88);

    ctx.save();

    // Circle background
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = style.bg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.13);
    ctx.stroke();

    // Icon drawn with paths — always crisp
    ctx.fillStyle   = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    this._badgeIcon(ctx, style.icon, bx, by, r);

    ctx.restore();
  }

  _badgeIcon(ctx, icon, bx, by, r) {
    const lw = Math.max(1, r * 0.2);
    ctx.lineWidth = lw;

    switch (icon) {

      case 'star_filled': {
        this._drawStar(ctx, bx, by, r, true, lw);
        break;
      }

      case 'star_outline': {
        this._drawStar(ctx, bx, by, r, false, lw);
        break;
      }

      case 'plus': {
        const arm = r * 0.40;
        ctx.lineWidth = Math.max(1, r * 0.22);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(bx - arm, by); ctx.lineTo(bx + arm, by);
        ctx.moveTo(bx, by - arm); ctx.lineTo(bx, by + arm);
        ctx.stroke();
        break;
      }

      case 'lines': {
        const lineLen = r * 0.50;
        const lw2 = Math.max(1, r * 0.14);
        ctx.lineWidth = lw2;
        ctx.lineCap = 'round';
        for (const dy of [-r * 0.24, 0, r * 0.24]) {
          ctx.beginPath();
          ctx.moveTo(bx - lineLen, by + dy);
          ctx.lineTo(bx + lineLen, by + dy);
          ctx.stroke();
        }
        break;
      }

      case 'exclaim': {
        ctx.beginPath();
        ctx.moveTo(bx, by - r * 0.42);
        ctx.lineTo(bx, by + r * 0.06);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(bx, by + r * 0.30, lw * 0.55, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'double_exclaim': {
        const off = r * 0.24;
        for (const dx of [-off, off]) {
          ctx.lineWidth = Math.max(1, r * 0.17);
          ctx.beginPath();
          ctx.moveTo(bx + dx, by - r * 0.42);
          ctx.lineTo(bx + dx, by + r * 0.06);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(bx + dx, by + r * 0.30, Math.max(1, r * 0.17) * 0.55, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }

      case 'question':
        this._drawQ(ctx, bx, by, r, lw);
        break;

      case 'double_question': {
        const off = r * 0.26;
        const lw2 = Math.max(1, r * 0.15);
        this._drawQ(ctx, bx - off, by, r * 0.82, lw2);
        this._drawQ(ctx, bx + off, by, r * 0.82, lw2);
        break;
      }

      case 'question_exclaim': {
        const lw2 = Math.max(1, r * 0.16);
        this._drawQ(ctx, bx - r * 0.27, by, r * 0.82, lw2);
        // Right: !
        ctx.lineWidth = lw2;
        const ix = bx + r * 0.27;
        ctx.beginPath();
        ctx.moveTo(ix, by - r * 0.40);
        ctx.lineTo(ix, by + r * 0.06);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ix, by + r * 0.28, lw2 * 0.55, 0, Math.PI * 2);
        ctx.fill();
        break;
      }

      case 'cross': {
        const d = r * 0.38;
        ctx.beginPath();
        ctx.moveTo(bx - d, by - d); ctx.lineTo(bx + d, by + d);
        ctx.moveTo(bx + d, by - d); ctx.lineTo(bx - d, by + d);
        ctx.stroke();
        break;
      }

    }
  }

  // Draws a 5-pointed star; filled=true for ★, false for ☆
  _drawStar(ctx, cx, cy, r, filled, lw) {
    const outerR = r * 0.58;
    const innerR = r * 0.24;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI / 5) - Math.PI / 2;
      const rad   = i % 2 === 0 ? outerR : innerR;
      const x = cx + rad * Math.cos(angle);
      const y = cy + rad * Math.sin(angle);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    if (filled) {
      ctx.fill();
    } else {
      ctx.lineWidth = Math.max(1, lw * 0.8);
      ctx.stroke();
    }
  }

  // Draws a single question-mark glyph using arcs and a bezier curve
  _drawQ(ctx, bx, by, r, lw) {
    ctx.lineWidth = lw;
    const arcR = r * 0.27;
    const arcCy = by - r * 0.16;
    // Arc (top curve of ?)
    ctx.beginPath();
    ctx.arc(bx, arcCy, arcR, Math.PI * 0.8, Math.PI * 0.15);
    ctx.stroke();
    // Tail curving down to centre
    ctx.beginPath();
    ctx.moveTo(bx + arcR, arcCy);
    ctx.bezierCurveTo(
      bx + arcR, by + r * 0.06,
      bx,        by + r * 0.06,
      bx,        by + r * 0.16
    );
    ctx.stroke();
    // Dot
    ctx.beginPath();
    ctx.arc(bx, by + r * 0.38, lw * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Drag and drop ───────────────────────────────────────────────────────────

  _bindEvents() {
    const canvas = this.canvas;
    canvas.addEventListener('mousedown',  e => this._onMouseDown(e));
    canvas.addEventListener('mousemove',  e => this._onMouseMove(e));
    canvas.addEventListener('mouseup',    e => this._onMouseUp(e));
    canvas.addEventListener('mouseleave', e => this._onMouseUp(e));
    // Touch support
    canvas.addEventListener('touchstart', e => { e.preventDefault(); this._onMouseDown(this._touchToMouse(e)); }, { passive: false });
    canvas.addEventListener('touchmove',  e => { e.preventDefault(); this._onMouseMove(this._touchToMouse(e)); }, { passive: false });
    canvas.addEventListener('touchend',   e => { e.preventDefault(); this._onMouseUp(this._touchToMouse(e));   }, { passive: false });
  }

  _touchToMouse(e) {
    const t = e.touches[0] || e.changedTouches[0];
    return { clientX: t.clientX, clientY: t.clientY, preventDefault: () => {} };
  }

  _onMouseDown(e) {
    if (!this._chess) return;
    const { sq } = this._canvasCoords(e);
    const piece = this._chess.get(sq);

    if (!piece) return;
    // Only allow dragging the side to move
    if (piece.color !== this._chess.turn()) return;

    const legalTargets = this._chess
      .moves({ square: sq, verbose: true })
      .map(m => m.to);

    const { x, y } = this._sqNameToXY(sq, this.squareSize);
    this._drag = {
      from: sq,
      piece: piece.color + piece.type.toUpperCase(),
      x: x + this.squareSize / 2,
      y: y + this.squareSize / 2,
      legalTargets,
    };
    this._highlights = legalTargets;
    this._render();
  }

  _onMouseMove(e) {
    if (!this._drag) return;
    const rect = this.canvas.getBoundingClientRect();
    this._drag.x = e.clientX - rect.left;
    this._drag.y = e.clientY - rect.top;
    this._render();
  }

  async _onMouseUp(e) {
    if (!this._drag) return;
    const { sq: toSq } = this._canvasCoords(e);
    const fromSq = this._drag.from;
    this._highlights = [];

    if (this._drag.legalTargets.includes(toSq)) {
      // Check if pawn promotion
      const piece = this._chess.get(fromSq);
      let promotion = undefined;
      if (piece?.type === 'p') {
        const toRank = toSq[1];
        if ((piece.color === 'w' && toRank === '8') || (piece.color === 'b' && toRank === '1')) {
          promotion = await this._askPromotion(piece.color);
        }
      }
      this._drag = null;
      this.onMove({ from: fromSq, to: toSq, promotion });
    } else {
      this._drag = null;
      this._render();
    }
  }

  // ── Promotion picker ────────────────────────────────────────────────────────

  _buildPromotionPicker() {
    const picker = document.createElement('div');
    picker.id        = 'promotion-picker';
    picker.className = 'promotion-picker hidden';
    picker.innerHTML = `
      <div class="promotion-picker__inner">
        <span class="promo-piece" data-piece="q">♛</span>
        <span class="promo-piece" data-piece="r">♜</span>
        <span class="promo-piece" data-piece="b">♝</span>
        <span class="promo-piece" data-piece="n">♞</span>
      </div>`;
    this.canvas.parentElement?.appendChild(picker);
    this._picker = picker;
  }

  _askPromotion(color) {
    return new Promise(resolve => {
      const picker = this._picker;
      picker.classList.remove('hidden');
      // Update piece glyphs for the right color
      picker.querySelectorAll('.promo-piece').forEach(el => {
        const key = color + el.dataset.piece.toUpperCase();
        el.textContent = GLYPHS[key] || el.textContent;
      });

      const handler = (e) => {
        const piece = e.target.closest('.promo-piece')?.dataset.piece;
        if (!piece) return;
        picker.classList.add('hidden');
        picker.removeEventListener('click', handler);
        resolve(piece);
      };
      picker.addEventListener('click', handler);
    });
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────────

  _canvasCoords(e) {
    const rect = this.canvas.getBoundingClientRect();
    const px   = e.clientX - rect.left;
    const py   = e.clientY - rect.top;
    const sz   = this.squareSize;
    const file = Math.floor(px / sz);
    const rank = Math.floor(py / sz);
    const sq   = this._fileRankToSqName(
      this.flipped ? 7 - file : file,
      this.flipped ? rank     : 7 - rank
    );
    return { sq, file, rank };
  }

  /** file=0→'a', rank=0→'1' */
  _fileRankToSqName(file, rank) {
    return String.fromCharCode(97 + file) + (rank + 1);
  }

  /** Returns canvas {x, y} top-left corner of the square for a file/rank index */
  _squareToXY(file, rank, sz) {
    const cx = this.flipped ? 7 - file : file;
    const cy = this.flipped ? rank      : 7 - rank;
    return { x: cx * sz, y: cy * sz };
  }

  /** Returns canvas {x, y} for a square name like "e4" */
  _sqNameToXY(sq, sz) {
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1]) - 1;
    return this._squareToXY(file, rank, sz);
  }
}
