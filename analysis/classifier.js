// Blunder Buster — Move classifier
// Converts Stockfish centipawn evaluations into chess.com-style move classifications.

/**
 * Convert a centipawn score to a win probability percentage (0–100).
 * Uses the standard logistic formula tuned to match Lichess/chess.com.
 * Always returns the probability for WHITE winning.
 *
 * @param {number}  cp      centipawn evaluation (positive = white better)
 * @param {boolean} isMate  true if score represents mate-in-N
 * @returns {number}  0–100
 */
export function cpToWinPct(cp, isMate = false) {
  if (isMate) {
    cp = cp > 0 ? 32000 - cp * 10 : -32000 - cp * 10;
  }
  const clamped = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamped)) - 1);
}

/**
 * Classification labels in display order (best → worst).
 */
export const CLASSIFICATIONS = [
  'Brilliant', 'Great', 'Best', 'Excellent', 'Good',
  'Inaccuracy', 'Mistake', 'Blunder', 'Miss', 'Book',
];

/**
 * Win% loss thresholds (from the moving player's perspective).
 * Loss = winPctBefore(mover) − winPctAfter(mover).
 */
const T = {
  BEST_MAX_LOSS:        2,
  GOOD_MAX_LOSS:        5,
  INACCURACY_MAX_LOSS: 10,
  MISTAKE_MAX_LOSS:    20,
  MISS_WINNING:        60,   // was winning above this
  MISS_LOSING:         40,   // now losing below this
  BRILLIANT_MIN_GAIN:   5,   // mover's win% must increase by this much (sacrifice)
  GREAT_MIN_GAIN:       3,   // mover's win% must increase by this much (any best move)
};

/**
 * Classify a single move.
 *
 * @param {object} p
 * @param {string}  p.color        'w' or 'b'
 * @param {number}  p.winPctBefore win% for WHITE before the move
 * @param {number}  p.winPctAfter  win% for WHITE after the move
 * @param {string}  p.playedUci    UCI string of the played move
 * @param {string}  p.bestUci      UCI string of Stockfish's best move
 * @param {boolean} p.isBookMove
 * @param {boolean} p.isSacrifice  true if piece moved to an attacked square
 * @returns {string}  one of CLASSIFICATIONS
 */
export function classifyMove({ color, winPctBefore, winPctAfter, playedUci, bestUci, isBookMove, isSacrifice }) {
  if (isBookMove) return 'Book';

  // Convert to mover's perspective
  const moverBefore = color === 'w' ? winPctBefore : 100 - winPctBefore;
  const moverAfter  = color === 'w' ? winPctAfter  : 100 - winPctAfter;
  const loss = moverBefore - moverAfter;  // positive = worse for mover

  const isBestMove = playedUci === bestUci;

  // Miss: had a decisive advantage and threw it away
  if (moverBefore > T.MISS_WINNING && moverAfter < T.MISS_LOSING && loss > T.MISTAKE_MAX_LOSS) {
    return 'Miss';
  }

  if (loss > T.MISTAKE_MAX_LOSS) return 'Blunder';
  if (loss > T.INACCURACY_MAX_LOSS) return 'Mistake';
  if (loss > T.GOOD_MAX_LOSS) return 'Inaccuracy';
  if (loss > T.BEST_MAX_LOSS) return 'Good';

  // loss ≤ 2%: near-optimal play
  if (isBestMove) {
    if (isSacrifice && (moverAfter - moverBefore) >= T.BRILLIANT_MIN_GAIN) {
      return 'Brilliant';
    }
    if ((moverAfter - moverBefore) >= T.GREAT_MIN_GAIN) {
      return 'Great';   // best move that actively improves the position
    }
    return 'Best';
  }

  return 'Excellent';
}

/**
 * Compute per-player accuracy score (0–100) across a game.
 * Uses chess.com's formula: accuracy_i = 103.1668 * exp(-0.04354 * loss_i) − 3.1668
 *
 * @param {object[]} movesData  array of MoveData objects
 * @param {'w'|'b'} color
 * @returns {number}  0–100
 */
export function computeAccuracy(movesData, color) {
  const playerMoves = movesData.filter(m => m.color === color && !m.isBookMove);
  if (playerMoves.length === 0) return 100;

  const accuracies = playerMoves.map(m => {
    const moverBefore = m.color === 'w' ? m.winPctBefore : 100 - m.winPctBefore;
    const moverAfter  = m.color === 'w' ? m.winPctAfter  : 100 - m.winPctAfter;
    const loss = Math.max(0, moverBefore - moverAfter);
    return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1668));
  });

  return accuracies.reduce((a, b) => a + b, 0) / accuracies.length;
}

/**
 * Badge styling data for each classification.
 * bg: pill background color  fg: text color inside the pill
 */
export const BADGE_STYLES = {
  Brilliant:  { bg: '#1baca6', fg: '#fff', symbol: '!!', label: 'Brilliant — sacrifice that gains advantage' },
  Great:      { bg: '#5c8bb0', fg: '#fff', symbol: '!',  label: 'Great — best move that improves your position' },
  Best:       { bg: '#7ab32a', fg: '#fff', symbol: '★',  label: 'Best — engine\'s top choice' },
  Excellent:  { bg: '#4a9e6a', fg: '#fff', symbol: '☆',  label: 'Excellent — near-optimal, not the engine\'s top move' },
  Good:       { bg: '#7a9e6e', fg: '#fff', symbol: '+',  label: 'Good — solid move with a minor imprecision' },
  Inaccuracy: { bg: '#c9971e', fg: '#fff', symbol: '?!', label: 'Inaccuracy — slightly imprecise' },
  Mistake:    { bg: '#e07b3c', fg: '#fff', symbol: '?',  label: 'Mistake' },
  Blunder:    { bg: '#ca3431', fg: '#fff', symbol: '??', label: 'Blunder' },
  Miss:       { bg: '#8b1a1a', fg: '#fff', symbol: '✗',  label: 'Miss — threw away a winning position' },
  Book:       { bg: '#7a5c3a', fg: '#fff', symbol: '≡',  label: 'Book move — opening theory' },
};
