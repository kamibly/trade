// Everything the app remembers lives in this phone's browser storage.
// Browser storage can be missing or full (private mode, cleared data), so
// every access is guarded and the app still runs without it.

const PREFIX = 'trade:';
const CANDLE_PREFIX = `${PREFIX}candles:`;
const MAX_CANDLE_SETS = 40;

export const DEFAULT_WATCHLIST = [
  { type: 'stock', symbol: 'AAPL', name: 'Apple' },
  { type: 'stock', symbol: 'MSFT', name: 'Microsoft' },
  { type: 'stock', symbol: 'NVDA', name: 'NVIDIA' },
  { type: 'stock', symbol: 'AMZN', name: 'Amazon' },
  { type: 'stock', symbol: 'GOOGL', name: 'Alphabet' },
  { type: 'stock', symbol: 'SPY', name: 'S&P 500 ETF' },
  { type: 'crypto', symbol: 'BTC', name: 'Bitcoin', geckoId: 'bitcoin' },
  { type: 'crypto', symbol: 'ETH', name: 'Ethereum', geckoId: 'ethereum' },
  { type: 'crypto', symbol: 'SOL', name: 'Solana', geckoId: 'solana' },
  { type: 'crypto', symbol: 'XRP', name: 'XRP', geckoId: 'ripple' },
  { type: 'crypto', symbol: 'DOGE', name: 'Dogecoin', geckoId: 'dogecoin' },
  { type: 'crypto', symbol: 'ADA', name: 'Cardano', geckoId: 'cardano' },
];

export const DEFAULT_SETTINGS = {
  twelveKey: '',
  timeframe: '1D',
  showCad: true,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const itemKey = item => `${item.type}:${item.symbol}`;

export function getWatchlist() {
  const list = read('watchlist', null);
  return Array.isArray(list) ? list : DEFAULT_WATCHLIST.map(i => ({ ...i }));
}

export const saveWatchlist = list => write('watchlist', list);

export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...read('settings', {}) };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings', next);
  return next;
}

export const getQuotes = () => read('quotes', {});
export const saveQuotes = quotes => write('quotes', quotes);

export const getFx = () => read('fx', null);
export const saveFx = fx => write('fx', fx);

export const getCryptoTop = () => read('cryptoTop', null);
export const saveCryptoTop = top => write('cryptoTop', top);

// Last candles per symbol and timeframe, so charts open offline.
export function getCandles(item, tf) {
  return read(`candles:${itemKey(item)}:${tf}`, null);
}

export function saveCandles(item, tf, candles) {
  const entry = { savedAt: Date.now(), candles: candles.slice(-500) };
  if (write(`candles:${itemKey(item)}:${tf}`, entry)) {
    pruneCandles();
    return;
  }
  // Storage full: drop the oldest sets and try once more.
  pruneCandles(Math.floor(MAX_CANDLE_SETS / 2));
  write(`candles:${itemKey(item)}:${tf}`, entry);
}

function candleKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CANDLE_PREFIX)) keys.push(k);
    }
  } catch { /* storage unavailable */ }
  return keys;
}

function pruneCandles(keep = MAX_CANDLE_SETS) {
  const keys = candleKeys();
  if (keys.length <= keep) return;
  const dated = keys.map(k => {
    try { return { k, at: JSON.parse(localStorage.getItem(k)).savedAt || 0 }; } catch { return { k, at: 0 }; }
  }).sort((a, b) => a.at - b.at);
  for (const { k } of dated.slice(0, keys.length - keep)) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

export function clearCachedPrices() {
  for (const k of candleKeys()) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
  write('quotes', {});
}

// Backup: watchlist and settings (including the data key) as one JSON file.
export function exportBackup() {
  return { app: 'trade', version: 1, exportedAt: new Date().toISOString(), watchlist: getWatchlist(), settings: getSettings() };
}

export function importBackup(data) {
  if (!data || data.app !== 'trade' || !Array.isArray(data.watchlist)) throw new Error('This is not a Trade backup file.');
  const list = data.watchlist.filter(i => i && (i.type === 'stock' || i.type === 'crypto') && typeof i.symbol === 'string');
  const given = data.settings || {};
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, k in given ? given[k] : DEFAULT_SETTINGS[k]]));
  saveWatchlist(list);
  saveSettings(settings);
  return list.length;
}
