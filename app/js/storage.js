// Everything the app remembers lives in this phone's browser storage:
// IndexedDB, which has its own allowance, so Trade leaves the 5 MB of
// localStorage it would share with other apps on the same site. The data is
// loaded into memory once at start (the await below), so reads stay instant;
// each write updates memory and is saved in the background. Without
// IndexedDB (some private modes) it falls back to localStorage.
// Browser storage can be missing or full (private mode, cleared data), so
// every access is guarded and the app still runs without it.

const PREFIX = 'trade:';
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
  alertTf: '1D',
  tune: 'auto',
  mode: 'standard',
  buyAt: 40,
  sellAt: -40,
  notifications: false,
  quietHours: true,
  riskPct: 1,
  paperStart: 10000,
  tradeFilter: true, // the server's paper account skips and sizes ideas by the trade filter
  stopAtr: 2,
  takeAtr: 3,
  signalsTab: 'watchlist', // the Signals page's tab: watchlist, opps or market
  paperTab: 'open', // the Paper page's tab: open, closed or results
  paperKind: 'all', // the Paper page's filter: all, stock or crypto
  paperExit: 'target', // 'target': sell paper trades at the target; 'trail': a trailing stop instead; 'lock': the target with a profit lock
  ndaxMode: 'off', // real crypto orders on NDAX: 'off', 'dry' (recorded, not sent) or 'live'
  ndaxBudget: 100, // CAD the real crypto trades may use in all
  ndaxMaxTrade: 25, // CAD at most in one real trade
  ndaxDailyLoss: 20, // CAD of live losses in a day that stops new buys until tomorrow
  serverUrl: '',
  serverKey: '',
  serverPush: false,
  overlays: { ma: true, bands: false, cloud: false, forecast: true, ml: true, markers: true },
  setups: { insider: true, earnings: true, ranking: true, crowd: true }, // opportunity setups the server looks for
};

const DB_NAME = 'trade';
const STORE = 'kv';
const mem = new Map(); // key (without PREFIX) → the saved JSON text
let db = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function localKeys() {
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
  } catch { /* storage unavailable */ }
  return keys;
}

// Loads everything into memory. The first time, it moves what an older
// version kept in localStorage over to IndexedDB and frees that space.
export async function init() {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const kv = tx.objectStore(STORE);
    await new Promise((resolve, reject) => {
      const req = kv.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        if (typeof c.value === 'string') mem.set(String(c.key), c.value);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    const moved = localKeys();
    for (const k of moved) {
      const key = k.slice(PREFIX.length);
      const raw = localStorage.getItem(k);
      if (raw !== null && !mem.has(key)) {
        mem.set(key, raw);
        kv.put(raw, key);
      }
    }
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    for (const k of moved) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
  } catch {
    db = null;
    mem.clear();
  }
}

// Where the data is kept, shown under About: 'IndexedDB' or 'localStorage'.
export const backend = () => (db ? 'IndexedDB' : 'localStorage');

function save(key, raw) {
  if (!db) {
    localStorage.setItem(PREFIX + key, raw);
    return;
  }
  mem.set(key, raw);
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).put(raw, key);
  } catch { /* saved in memory for this visit */ }
}

function remove(key) {
  if (!db) {
    try { localStorage.removeItem(PREFIX + key); } catch { /* ignore */ }
    return;
  }
  mem.delete(key);
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
  } catch { /* ignore */ }
}

function rawOf(key) {
  if (db) return mem.has(key) ? mem.get(key) : null;
  return localStorage.getItem(PREFIX + key);
}

function keys() {
  return db ? [...mem.keys()] : localKeys().map(k => k.slice(PREFIX.length));
}

function read(key, fallback) {
  try {
    const raw = rawOf(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    save(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

await init();

export const itemKey = item => `${item.type}:${item.symbol}`;

export function getWatchlist() {
  const list = read('watchlist', null);
  return Array.isArray(list) ? list : DEFAULT_WATCHLIST.map(i => ({ ...i }));
}

export const saveWatchlist = list => write('watchlist', list);

export function getSettings() {
  const saved = read('settings', {});
  // New chart overlays start with their default when older settings lack them.
  return { ...DEFAULT_SETTINGS, ...saved, overlays: { ...DEFAULT_SETTINGS.overlays, ...(saved.overlays || {}) }, setups: { ...DEFAULT_SETTINGS.setups, ...(saved.setups || {}) } };
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  write('settings', next);
  return next;
}

export const getQuotes = () => read('quotes', {});
export const saveQuotes = quotes => write('quotes', quotes);

// Latest signal per symbol on the alert timeframe: { "<type>:<symbol>": summary }.
export const getSignals = () => read('signals', {});
export const saveSignals = signals => write('signals', signals);

// Method weights and tuned rule from the backtest per symbol and timeframe: { "<key>:<tf>": { at, weights, rule, test, key } }.
export const getWeights = () => read('weights', {});
// `learned` is scanner.learn()'s result: { weights, rule, test, key }.
export function saveWeight(item, tf, learned) {
  const all = getWeights();
  all[`${itemKey(item)}:${tf}`] = { at: Date.now(), ...learned };
  write('weights', all);
}
export const weightFor = (item, tf) => getWeights()[`${itemKey(item)}:${tf}`] || null;

// Real holdings (alerts only) and the paper-trading account.
export const getHoldings = () => {
  const h = read('holdings', []);
  return Array.isArray(h) ? h : [];
};
export const saveHoldings = list => write('holdings', list);
export const getPaper = () => read('paper', null);
// The paper account your server runs, when connected: { paper, events, prices, fetchedAt }.
export const getServerPaper = () => read('serverPaper', null);
export const saveServerPaper = p => write('serverPaper', p);
export const savePaper = acc => write('paper', acc);

// When the watchlist, holdings or synced settings last changed on this phone.
export const getSyncMeta = () => read('sync', { changedAt: 0 });
export const saveSyncMeta = meta => write('sync', meta);

// Machine-learning models from the server per timeframe: { "1D": { cutoff, trainedAt, lgbm, lstm } }.
// New models change the votes, so the learned method weights start over.
export const getModels = () => read('models', {});
export function saveModels(models) {
  write('weights', {});
  return write('models', models);
}

// The server's last market scan, so the Signals tab shows it offline.
export const getMarket = () => read('market', null);
export const saveMarket = m => write('market', m);

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

const CANDLE_KEY = 'candles:';
const candleKeys = () => keys().filter(k => k.startsWith(CANDLE_KEY));

function pruneCandles(keep = MAX_CANDLE_SETS) {
  const list = candleKeys();
  if (list.length <= keep) return;
  const dated = list.map(k => ({ k, at: (read(k, null) || {}).savedAt || 0 })).sort((a, b) => a.at - b.at);
  for (const { k } of dated.slice(0, list.length - keep)) remove(k);
}

export function clearCachedPrices() {
  for (const k of candleKeys()) remove(k);
  write('quotes', {});
}

// Backup: watchlist, settings (including the data key), holdings and the
// paper account as one JSON file.
export function exportBackup() {
  return {
    app: 'trade', version: 2, exportedAt: new Date().toISOString(),
    watchlist: getWatchlist(), settings: getSettings(), holdings: getHoldings(), paper: getPaper(),
  };
}

export function importBackup(data) {
  if (!data || data.app !== 'trade' || !Array.isArray(data.watchlist)) throw new Error('This is not a Trade backup file.');
  const list = data.watchlist.filter(i => i && (i.type === 'stock' || i.type === 'crypto') && typeof i.symbol === 'string');
  const given = data.settings || {};
  const settings = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, k in given ? given[k] : DEFAULT_SETTINGS[k]]));
  saveWatchlist(list);
  saveSettings(settings);
  if (Array.isArray(data.holdings)) saveHoldings(data.holdings.filter(h => h && typeof h.key === 'string' && h.qty > 0 && h.buyPrice > 0));
  if (data.paper && Array.isArray(data.paper.positions) && Number.isFinite(data.paper.cash)) savePaper(data.paper);
  return list.length;
}
