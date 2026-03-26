// Blunder Buster — Opening book detection
// Marks the "book" phase of a game using PGN header data.
// chess.com embeds ECO and opening name in PGN headers; we use the move
// count implied by the ECO URL to determine how many moves were theory.

/**
 * Determine which move indices (0-based plies) are "book" moves.
 *
 * Strategy (in priority order):
 *  1. If the PGN annotations contain explicit {Book} comments — use those.
 *  2. Use the ECOUrl to count opening moves by comparing the URL's move
 *     sequence to the game's actual moves.
 *  3. Fall back: mark first 10 plies as book if any ECO header is present.
 *
 * @param {Record<string,string>} headers  parsed PGN headers
 * @param {object[]}              moves    output of pgnToMoveList()
 * @returns {Set<number>}  set of 0-based move indices that are book moves
 */
export function detectBookMoves(headers, moves) {
  const bookIndices = new Set();

  // Strategy 1: explicit {Book} annotations already handled during PGN parse
  // (chess.com sometimes embeds these but it's rare in the raw API response)

  // Strategy 2: ECOUrl contains the canonical opening line as UCI moves
  // e.g. https://www.chess.com/openings/Sicilian-Defense-2...Nc6
  // We compare the PGN header moves against known opening length heuristics
  const ecoUrl = headers['ECOUrl'] || '';
  if (ecoUrl) {
    // Each hyphen-separated segment after the base name typically represents
    // one move pair. Count them as a rough proxy.
    const parts = ecoUrl.split('/').pop()?.split('-') ?? [];
    // Rough heuristic: length of path correlates with opening depth
    // Most ECO URLs: 2-8 "words" → 4–16 plies
    const estimatedBookPlies = Math.min(parts.length * 1.5, 20);
    for (let i = 0; i < Math.floor(estimatedBookPlies) && i < moves.length; i++) {
      bookIndices.add(i);
    }
    return bookIndices;
  }

  // Strategy 3: any ECO code means at least some opening theory was played
  if (headers['ECO']) {
    const bookPlies = 10; // conservative default
    for (let i = 0; i < bookPlies && i < moves.length; i++) {
      bookIndices.add(i);
    }
  }

  return bookIndices;
}

/**
 * Short opening name for display in the UI header.
 * @param {Record<string,string>} headers
 * @returns {string}
 */
export function getOpeningName(headers) {
  if (headers['Opening']) return headers['Opening'];
  if (headers['ECO'])     return headers['ECO'];
  return 'Unknown opening';
}
