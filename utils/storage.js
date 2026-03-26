// Blunder Buster — chrome.storage wrappers + game result cache

const CACHE_KEY       = 'analyzedGames';
const MAX_CACHED_GAMES = 20;

// ── Session storage (volatile, cleared on browser restart) ──────────────────

export const session = {
  get: (keys) => chrome.storage.session.get(keys),
  set: (data) => chrome.storage.session.set(data),
  remove: (keys) => chrome.storage.session.remove(keys),
};

// ── Local storage (persistent) ───────────────────────────────────────────────

export const local = {
  get:  (keys) => chrome.storage.local.get(keys),
  set:  (data) => chrome.storage.local.set(data),

  async getSettings() {
    const defaults = {
      analysisDepth: 20,
      autoAnalyze:   true,
      showBestMove:  true,
      boardTheme:    'default',
    };
    const stored = await chrome.storage.local.get(Object.keys(defaults));
    return { ...defaults, ...stored };
  },

  async saveSettings(settings) {
    return chrome.storage.local.set(settings);
  },
};

// ── Game analysis cache (LRU, max 20 games) ──────────────────────────────────

/**
 * Load all cached analysis entries (array, newest first).
 * @returns {Promise<Array<{gameId:string, timestamp:number, data:object}>>}
 */
async function loadCache() {
  const result = await chrome.storage.local.get([CACHE_KEY]);
  return result[CACHE_KEY] ?? [];
}

/**
 * Save a completed analysis result for a game.
 * @param {string} gameId
 * @param {object} analysisData  — the full analysis result
 */
export async function cacheAnalysis(gameId, analysisData) {
  let cache = await loadCache();

  // Remove existing entry for this game if present
  cache = cache.filter(entry => entry.gameId !== gameId);

  // Prepend new entry
  cache.unshift({ gameId, timestamp: Date.now(), data: analysisData });

  // Enforce max size
  if (cache.length > MAX_CACHED_GAMES) {
    cache = cache.slice(0, MAX_CACHED_GAMES);
  }

  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

/**
 * Retrieve a cached analysis by gameId.
 * @param {string} gameId
 * @returns {Promise<object|null>}
 */
export async function getCachedAnalysis(gameId) {
  const cache = await loadCache();
  return cache.find(entry => entry.gameId === gameId)?.data ?? null;
}

/**
 * Clear all cached analyses.
 */
export async function clearCache() {
  await chrome.storage.local.remove([CACHE_KEY]);
}
