// Price data straight from the providers. GitHub Pages has no server, so the
// phone calls these APIs itself: crypto from free feeds that need no key, and
// US stocks from Twelve Data with the key saved on this phone.

import {
  TIMEFRAMES, fromCoinbase, fromKraken, fromCoinGeckoOhlc, fromTwelve, fromYahoo, toWeekly, twelveErrorMessage,
} from './candles.js';
import { CreditLimiter } from './limiter.js';

const COINBASE = 'https://api.exchange.coinbase.com';
const KRAKEN = 'https://api.kraken.com/0/public';
const GECKO = 'https://api.coingecko.com/api/v3';
const TWELVE = 'https://api.twelvedata.com';

// Twelve Data's free plan: 8 credits a minute, one credit per symbol.
export const twelveLimiter = new CreditLimiter(8);

// Stablecoins track the dollar, so they make no sense as trades.
const STABLECOINS = new Set(['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usde', 'usds', 'fdusd', 'pyusd', 'usdd', 'usd1', 'susde', 'gusd']);

export class DataError extends Error {}

export async function getJson(url, { timeout = 15000, headers } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const host = new URL(url).host;
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new DataError(`${host} answered ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') throw new DataError(`${host} took too long to answer`);
    if (e instanceof TypeError) throw new DataError(`Could not reach ${host}. Check your connection.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---- Crypto -----------------------------------------------------------------

async function coinbaseCandles(symbol, tf) {
  const granularity = TIMEFRAMES[tf].coinbase || 86400;
  const rows = await getJson(`${COINBASE}/products/${encodeURIComponent(symbol)}-USD/candles?granularity=${granularity}`);
  const candles = fromCoinbase(rows);
  return tf === '1W' ? toWeekly(candles) : candles;
}

async function krakenCandles(symbol, tf) {
  const pair = `${symbol === 'BTC' ? 'XBT' : symbol}USD`;
  return fromKraken(await getJson(`${KRAKEN}/OHLC?pair=${encodeURIComponent(pair)}&interval=${TIMEFRAMES[tf].kraken}`));
}

async function geckoCandles(geckoId, tf) {
  if (!geckoId) throw new DataError('No CoinGecko id');
  return fromCoinGeckoOhlc(await getJson(`${GECKO}/coins/${encodeURIComponent(geckoId)}/ohlc?vs_currency=usd&days=${TIMEFRAMES[tf].geckoDays}`));
}

async function cryptoCandles(item, tf) {
  const tries = [
    ['Coinbase', () => coinbaseCandles(item.symbol, tf)],
    ['Kraken', () => krakenCandles(item.symbol, tf)],
    ['CoinGecko', () => geckoCandles(item.geckoId, tf)],
  ];
  const errors = [];
  for (const [source, run] of tries) {
    try {
      const candles = await run();
      if (candles.length) return { candles, source };
      errors.push(`${source}: no data`);
    } catch (e) {
      errors.push(`${source}: ${e.message}`);
    }
  }
  throw new DataError(`No price source has ${item.symbol} right now. ${errors.join(' · ')}`);
}

// ---- Stocks -----------------------------------------------------------------

function needKey(key) {
  if (!key) throw new DataError('Add your free Twelve Data key in Settings to load stock prices.');
}

async function twelveGet(path, params, key, credits, signal) {
  needKey(key);
  await twelveLimiter.take(credits, signal);
  const qs = new URLSearchParams({ ...params, apikey: key });
  let json;
  try {
    json = await getJson(`${TWELVE}/${path}?${qs}`);
  } catch (e) {
    if (e.status === 429) twelveLimiter.penalize();
    if (e.body && e.body.status === 'error') throw new DataError(twelveErrorMessage(e.body));
    throw e;
  }
  if (json && json.status === 'error') {
    if (json.code === 429) twelveLimiter.penalize();
    throw new DataError(twelveErrorMessage(json));
  }
  return json;
}

async function stockCandles(item, tf, key, signal) {
  const json = await twelveGet('time_series', {
    symbol: item.symbol, interval: TIMEFRAMES[tf].twelve, outputsize: '500', timezone: 'UTC',
  }, key, 1, signal);
  return { candles: fromTwelve(json), source: 'Twelve Data' };
}

// Yahoo Finance needs no key but refuses browser calls, so only the OCI
// server uses it. Class shares use a dash there (BRK-B, not BRK.B).
export async function yahooCandles(item, tf) {
  const [interval, range] = TIMEFRAMES[tf].yahoo;
  const symbol = encodeURIComponent(item.symbol.replace(/\./g, '-'));
  const json = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
  });
  return { candles: fromYahoo(json).slice(-500), source: 'Yahoo Finance' };
}

// The latest stock price from Yahoo Finance (server only), for the
// every-minute stop-loss and target checks.
export async function yahooPrice(item) {
  const symbol = encodeURIComponent(item.symbol.replace(/\./g, '-'));
  const json = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' },
  });
  const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  const price = meta && Number(meta.regularMarketPrice);
  if (Number.isFinite(price) && price > 0) return price;
  const candles = fromYahoo(json);
  if (!candles.length) throw new DataError(`No price for ${item.symbol}`);
  return candles.at(-1).close;
}

// ---- Public API -------------------------------------------------------------

// `signal` drops a stock request still queued behind the rate limit, so
// flicking between charts doesn't use up the free plan's credits.
export function fetchCandles(item, tf, settings, signal) {
  return item.type === 'crypto' ? cryptoCandles(item, tf) : stockCandles(item, tf, settings.twelveKey, signal);
}

// Turns a Twelve Data /quote object into { price, changePct }.
export function parseTwelveQuote(q) {
  if (!q || q.status === 'error') return { error: twelveErrorMessage(q) };
  const price = Number(q.close);
  const changePct = Number(q.percent_change);
  return Number.isFinite(price) ? { price, changePct: Number.isFinite(changePct) ? changePct : null, name: q.name } : { error: 'No price' };
}

// One request returns one symbol's object directly, several return a map.
export function splitTwelveQuotes(json, symbols) {
  if (symbols.length === 1) return { [symbols[0]]: parseTwelveQuote(json) };
  const out = {};
  for (const s of symbols) out[s] = parseTwelveQuote(json && json[s]);
  return out;
}

async function stockQuotes(items, key) {
  const out = {};
  const symbols = items.map(i => i.symbol);
  for (let i = 0; i < symbols.length; i += 8) {
    const chunk = symbols.slice(i, i + 8);
    try {
      const json = await twelveGet('quote', { symbol: chunk.join(',') }, key, chunk.length);
      Object.assign(out, splitTwelveQuotes(json, chunk));
    } catch (e) {
      for (const s of chunk) out[s] = { error: e.message };
    }
  }
  return out;
}

async function cryptoQuotes(items) {
  const out = {};
  const withId = items.filter(i => i.geckoId);
  if (withId.length) {
    try {
      const ids = [...new Set(withId.map(i => i.geckoId))].join(',');
      const json = await getJson(`${GECKO}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`);
      for (const i of withId) {
        const q = json && json[i.geckoId];
        out[i.symbol] = q && Number.isFinite(q.usd)
          ? { price: q.usd, changePct: Number.isFinite(q.usd_24h_change) ? q.usd_24h_change : null }
          : { error: 'No price from CoinGecko' };
      }
    } catch (e) {
      for (const i of withId) out[i.symbol] = { error: e.message };
    }
  }
  // Coins without a CoinGecko id, or that CoinGecko missed: Coinbase 24h stats.
  for (const i of items.filter(x => !out[x.symbol] || out[x.symbol].error)) {
    try {
      const s = await getJson(`${COINBASE}/products/${encodeURIComponent(i.symbol)}-USD/stats`);
      const price = Number(s.last);
      const open = Number(s.open);
      out[i.symbol] = Number.isFinite(price) ? { price, changePct: open ? ((price - open) / open) * 100 : null } : out[i.symbol];
    } catch (e) {
      out[i.symbol] = out[i.symbol] || { error: e.message };
    }
  }
  return out;
}

// Returns { "<type>:<symbol>": { price, changePct, at } or { error } }.
// `withStocks: false` skips stocks, to save Twelve Data credits for charts.
export async function fetchQuotes(watchlist, settings, { withStocks = true } = {}) {
  const crypto = watchlist.filter(i => i.type === 'crypto');
  const stocks = withStocks ? watchlist.filter(i => i.type === 'stock') : [];
  const [c, s] = await Promise.all([
    crypto.length ? cryptoQuotes(crypto) : {},
    stocks.length && settings.twelveKey ? stockQuotes(stocks, settings.twelveKey) : {},
  ]);
  const at = Date.now();
  const out = {};
  for (const [sym, q] of Object.entries(c)) out[`crypto:${sym}`] = { ...q, at };
  for (const [sym, q] of Object.entries(s)) out[`stock:${sym}`] = { ...q, at };
  return out;
}

// Looks a stock up before it joins the watchlist. Returns its name.
export async function checkStock(symbol, key) {
  const json = await twelveGet('quote', { symbol }, key, 1);
  const q = parseTwelveQuote(json);
  if (q.error) throw new DataError(q.error);
  return json.name || symbol;
}

export async function checkTwelveKey(key) {
  await checkStock('AAPL', key);
  return true;
}

// Top coins by market value, without stablecoins.
export async function fetchCryptoTop(limit = 50) {
  const rows = await getJson(`${GECKO}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit + 15}&page=1`);
  return parseCryptoTop(rows, limit);
}

export function parseCryptoTop(rows, limit = 50) {
  if (!Array.isArray(rows)) throw new DataError('Unexpected CoinGecko response');
  return rows
    .filter(r => r && r.id && r.symbol && !STABLECOINS.has(String(r.symbol).toLowerCase()))
    .slice(0, limit)
    .map(r => ({ type: 'crypto', symbol: String(r.symbol).toUpperCase(), name: r.name, geckoId: r.id }));
}

// USD to CAD from the European Central Bank's daily rate, Coinbase as backup.
export async function fetchUsdCad() {
  try {
    const json = await getJson('https://api.frankfurter.app/latest?from=USD&to=CAD');
    const rate = json && json.rates && Number(json.rates.CAD);
    if (Number.isFinite(rate) && rate > 0) return { rate, at: Date.now(), source: 'ECB' };
  } catch { /* try the backup */ }
  const json = await getJson('https://api.coinbase.com/v2/exchange-rates?currency=USD');
  const rate = Number(json && json.data && json.data.rates && json.data.rates.CAD);
  if (!Number.isFinite(rate) || rate <= 0) throw new DataError('No USD to CAD rate');
  return { rate, at: Date.now(), source: 'Coinbase' };
}
