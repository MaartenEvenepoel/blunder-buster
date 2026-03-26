// Blunder Buster — chess.com API helpers
//
// NOTE: chess.com has NO public single-game-by-ID endpoint.
// Games are retrieved via monthly archives:
//   GET https://api.chess.com/pub/player/{username}/games/{YYYY}/{MM}
// We locate a specific game by matching its numeric ID against the `url` field
// in each game object ("https://www.chess.com/game/live/{ID}").

const BASE    = 'https://api.chess.com/pub';
const HEADERS = { 'User-Agent': 'BlunderBuster/1.0 (chess analysis extension)' };

async function fetchJSON(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch the list of monthly archive URLs for a player (newest last).
 * @param {string} username
 * @returns {Promise<string[]>}
 */
export async function fetchArchives(username) {
  const data = await fetchJSON(
    `${BASE}/player/${encodeURIComponent(username)}/games/archives`
  );
  return data.archives ?? [];
}

/**
 * Fetch all games for a player in a given month.
 * @param {string} username
 * @param {number} year
 * @param {number} month  1-based
 * @returns {Promise<object[]>}
 */
export async function fetchGamesForMonth(username, year, month) {
  const mm   = String(month).padStart(2, '0');
  const data = await fetchJSON(
    `${BASE}/player/${encodeURIComponent(username)}/games/${year}/${mm}`
  );
  return data.games ?? [];
}

/**
 * Fetch a specific game by its numeric ID.
 *
 * Strategy:
 *  1. If `gameYearMonth` ("YYYY/MM") is provided by the content script, try that
 *     archive first — this hits the right month immediately for historical games.
 *  2. Search archives from newest → oldest until the game is found.
 *     All archives are searched (no arbitrary cap) so old games always work.
 *
 * @param {string}      gameId        numeric ID from the chess.com URL
 * @param {string}      username      chess.com username (required)
 * @param {string|null} gameYearMonth "YYYY/MM" hint from content script, or null
 * @param {function}    [onStatus]    (msg: string) => void  for UI progress updates
 * @returns {Promise<object>}  game object with .pgn, .white, .black, etc.
 */
export async function fetchGame(gameId, username, gameYearMonth = null, onStatus = null) {
  if (!username) {
    throw new Error(
      'Username is required to fetch a game. Make sure you are logged in to chess.com.'
    );
  }

  const gameUrlSuffix = `/${gameId}`;

  // ── Fast path: date hint → try the exact archive month first ────────────────
  if (gameYearMonth) {
    const [year, month] = gameYearMonth.split('/');
    onStatus?.(`Fetching game from ${gameYearMonth}…`);
    try {
      const data  = await fetchJSON(
        `${BASE}/player/${encodeURIComponent(username)}/games/${year}/${month}`
      );
      const match = (data.games ?? []).find(g => g.url?.endsWith(gameUrlSuffix));
      if (match) return match;
    } catch { /* month may not exist; fall through to full search */ }
  }

  // ── Full archive search: newest → oldest ────────────────────────────────────
  onStatus?.('Loading archive list…');
  const archives = await fetchArchives(username);
  if (archives.length === 0) {
    throw new Error(`No game archives found for "${username}".`);
  }

  // Reverse so we search newest first; skip the month we already tried
  const skipUrl = gameYearMonth
    ? `${BASE}/player/${encodeURIComponent(username)}/games/${gameYearMonth}`
    : null;

  const toSearch = [...archives].reverse().filter(url => url !== skipUrl);

  for (let i = 0; i < toSearch.length; i++) {
    const archiveUrl = toSearch[i];
    onStatus?.(`Searching archive ${i + 1}/${toSearch.length}…`);

    let games;
    try {
      const data = await fetchJSON(archiveUrl);
      games = data.games ?? [];
    } catch {
      await sleep(300);
      continue;
    }

    const match = games.find(g => g.url?.endsWith(gameUrlSuffix));
    if (match) return match;

    // Gentle rate-limit: 300 ms between archive requests
    await sleep(300);
  }

  throw new Error(
    `Game ${gameId} was not found in any archive for "${username}". ` +
    `The game may belong to a different account or be set to private.`
  );
}

/**
 * Fetch a player's most recently completed game.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
export async function fetchLatestGame(username) {
  const archives = await fetchArchives(username);
  if (archives.length === 0) return null;
  const data  = await fetchJSON(archives[archives.length - 1]);
  const games = data.games ?? [];
  return games[games.length - 1] ?? null;
}
