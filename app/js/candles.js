// Candle helpers with no browser dependencies, so they run under `node --test`.
// A candle is { time, open, high, low, close, volume }, with `time` in Unix
// seconds (UTC) and the array sorted oldest first.

export const TIMEFRAMES = {
  '15m': { label: '15m', seconds: 900, coinbase: 900, kraken: 15, twelve: '15min', geckoDays: 1, yahoo: ['15m', '1mo'] },
  '1h': { label: '1H', seconds: 3600, coinbase: 3600, kraken: 60, twelve: '1h', geckoDays: 14, yahoo: ['60m', '6mo'] },
  '1D': { label: '1D', seconds: 86400, coinbase: 86400, kraken: 1440, twelve: '1day', geckoDays: 365, yahoo: ['1d', '2y'] },
  // Coinbase has no weekly candles, so weekly crypto is built from daily ones.
  '1W': { label: '1W', seconds: 604800, coinbase: null, kraken: 10080, twelve: '1week', geckoDays: 'max', yahoo: ['1wk', '10y'] },
};

export const isIntraday = tf => TIMEFRAMES[tf].seconds < 86400;

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

// Drops broken rows, removes duplicate times (keeping the last) and sorts.
export function cleanCandles(candles) {
  const byTime = new Map();
  for (const c of candles) {
    const row = {
      time: Math.floor(num(c.time)),
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: Number.isFinite(num(c.volume)) ? num(c.volume) : 0,
    };
    if ([row.time, row.open, row.high, row.low, row.close].every(Number.isFinite)) byTime.set(row.time, row);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

// Coinbase Exchange /products/{id}/candles: [[time, low, high, open, close, volume], ...], newest first.
export function fromCoinbase(rows) {
  if (!Array.isArray(rows)) throw new Error('Unexpected Coinbase response');
  return cleanCandles(rows.map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume })));
}

// Kraken /0/public/OHLC: { error: [], result: { <pair>: [[time, open, high, low, close, vwap, volume, count]], last } }.
export function fromKraken(json) {
  if (!json || (json.error && json.error.length)) throw new Error(`Kraken: ${(json && json.error || []).join(', ') || 'no data'}`);
  const key = Object.keys(json.result || {}).find(k => k !== 'last');
  if (!key) throw new Error('Kraken: no data');
  return cleanCandles(json.result[key].map(([time, open, high, low, close, , volume]) => ({ time, open, high, low, close, volume })));
}

// CoinGecko /coins/{id}/ohlc: [[ms, open, high, low, close]], no volume.
export function fromCoinGeckoOhlc(rows) {
  if (!Array.isArray(rows)) throw new Error('Unexpected CoinGecko response');
  return cleanCandles(rows.map(([ms, open, high, low, close]) => ({ time: ms / 1000, open, high, low, close, volume: 0 })));
}

// "2024-01-02" or "2024-01-02 15:30:00", requested with timezone=UTC.
export function parseUtcDateTime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text).trim());
  if (!m) return NaN;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) / 1000;
}

// Twelve Data /time_series: { values: [{ datetime, open, high, low, close, volume }], status: "ok" }, newest first.
export function fromTwelve(json) {
  if (!json || json.status === 'error') {
    const err = new Error(twelveErrorMessage(json));
    err.code = json && json.code;
    throw err;
  }
  return cleanCandles((json.values || []).map(v => ({ ...v, time: parseUtcDateTime(v.datetime) })));
}

// Yahoo Finance /v8/finance/chart (server only: it does not allow browser calls).
// { chart: { result: [{ timestamp: [...], indicators: { quote: [{ open, high, low, close, volume }] } }], error } }
export function fromYahoo(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) throw new Error(`Yahoo Finance: ${(json && json.chart && json.chart.error && json.chart.error.description) || 'no data'}`);
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  return cleanCandles((r.timestamp || []).map((time, i) => ({
    time, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i], volume: q.volume?.[i],
  })));
}

export function twelveErrorMessage(json) {
  const code = json && json.code;
  if (code === 401 || code === 403) return 'Twelve Data rejected the key, or this symbol needs a paid plan. Check the key in Settings.';
  if (code === 429) return 'Twelve Data limit reached (8 requests a minute on the free plan). It will retry shortly.';
  if (code === 400 || code === 404) return 'Twelve Data does not know this symbol.';
  return `Twelve Data: ${(json && json.message) || 'no data'}`;
}

// Monday 00:00 UTC of the week containing `time`.
export function weekStart(time) {
  const day = Math.floor(time / 86400);
  const weekday = (new Date(day * 86400000).getUTCDay() + 6) % 7; // Monday = 0
  return (day - weekday) * 86400;
}

export function toWeekly(daily) {
  const weeks = [];
  for (const c of cleanCandles(daily)) {
    const start = weekStart(c.time);
    const last = weeks.at(-1);
    if (last && last.time === start) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      weeks.push({ ...c, time: start });
    }
  }
  return weeks;
}

// Percentage change of the last close against the close one day earlier.
export function changeOverDay(candles, tfSeconds) {
  if (candles.length < 2) return null;
  const last = candles.at(-1);
  const back = Math.max(1, Math.round(86400 / tfSeconds));
  const ref = candles.at(-1 - Math.min(back, candles.length - 1));
  return ref.close ? ((last.close - ref.close) / ref.close) * 100 : null;
}
