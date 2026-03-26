// Blunder Buster — PGN parsing utilities
// Runs in the sidepanel context; Chess is imported by the caller.

/**
 * Parse PGN tag headers into a plain object.
 * e.g. [White "Magnus Carlsen"] → { White: "Magnus Carlsen" }
 * @param {string} pgn
 * @returns {Record<string,string>}
 */
export function parsePGNHeaders(pgn) {
  const headers = {};
  const re = /\[(\w+)\s+"([^"]*)"\]/g;
  let m;
  while ((m = re.exec(pgn)) !== null) {
    headers[m[1]] = m[2];
  }
  return headers;
}

/**
 * Strip embedded annotations from a PGN string so chess.js can load it cleanly.
 * Removes clock, eval, and other %cmd annotations: {[%clk ...]} {[%eval ...]}
 * Also removes move-text comments in braces that don't affect move order.
 * @param {string} pgn
 * @returns {string}
 */
export function stripAnnotations(pgn) {
  // Remove %clk, %eval, %emt, %csl, %cal etc. annotations within braces
  return pgn
    .replace(/\{[^}]*\}/g, '')      // remove all { } comments
    .replace(/\$\d+/g, '')           // remove NAG symbols ($1 $2 etc)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract clock-time and eval annotations from each move's comment.
 * chess.com encodes these as: { [%clk H:MM:SS] [%eval N.NN] }
 *
 * @param {string} pgn
 * @returns {Array<{clk:string|null, eval:number|null, isMate:boolean}>}
 *   One entry per half-move (ply), in order.
 */
export function extractMoveAnnotations(pgn) {
  const annotations = [];
  // Match move tokens followed by optional comment
  const moveRe = /(?:\d+\.{1,3}\s*)?([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQK])?[+#]?|O-O(?:-O)?[+#]?)(?:\s*\{([^}]*)\})?/g;
  let m;
  while ((m = moveRe.exec(pgn)) !== null) {
    const comment = m[2] || '';
    const clkMatch  = comment.match(/%clk\s+([\d:]+)/);
    const evalMatch = comment.match(/%eval\s+([#\-\d.]+)/);

    let evalVal  = null;
    let isMate   = false;
    if (evalMatch) {
      const raw = evalMatch[1];
      if (raw.startsWith('#')) {
        isMate  = true;
        evalVal = parseInt(raw.slice(1));
      } else {
        evalVal = parseFloat(raw);
      }
    }

    annotations.push({
      clk:    clkMatch ? clkMatch[1] : null,
      eval:   evalMatch ? evalVal : null,
      isMate,
    });
  }
  return annotations;
}

/**
 * Replay a PGN string and collect the FEN at every ply.
 * Returns an array of move objects, one per half-move.
 *
 * @param {string} pgn
 * @param {typeof Chess} Chess  chess.js Chess constructor (passed in to avoid import issues)
 * @returns {Array<MoveRecord>}
 */
export function pgnToMoveList(pgn, Chess) {
  const annotations = extractMoveAnnotations(pgn);
  const cleanPgn    = stripAnnotations(pgn);

  const game = new Chess();
  game.loadPgn(cleanPgn, { strict: false });
  const history = game.history({ verbose: true });

  // Replay from start to capture FEN at each step
  const replay = new Chess();
  const moves  = [];

  history.forEach((move, i) => {
    const fenBefore = replay.fen();
    replay.move(move.san);
    const fenAfter = replay.fen();

    moves.push({
      moveIndex: i,
      san:       move.san,
      uci:       move.from + move.to + (move.promotion || ''),
      color:     move.color,       // 'w' or 'b'
      piece:     move.piece,
      captured:  move.captured,
      flags:     move.flags,
      fenBefore,
      fenAfter,
      // Annotation data (may be null if chess.com didn't embed them)
      pgnEval:   annotations[i]?.eval  ?? null,
      pgnIsMate: annotations[i]?.isMate ?? false,
      pgnClk:    annotations[i]?.clk   ?? null,
    });
  });

  return moves;
}

/**
 * Determine the side-to-move from a FEN string.
 * @param {string} fen
 * @returns {'w'|'b'}
 */
export function sideToMove(fen) {
  return fen.split(' ')[1];
}
