// Stock charts and prices for the server, with backups for when Yahoo Finance
// refuses (it answers 429 to a server it thinks asks too much, sometimes for
// hours):
//   1. Yahoo's query1 host, as before;
//   2. Yahoo's query2 host with a session cookie and "crumb", the way a
//      browser asks, which Yahoo limits less;
//   3. for daily and weekly charts and live prices, Nasdaq's public quote
//      API (no key). Nasdaq has no intraday history, so 15m and 1H charts
//      fall back to Twelve Data only when the server has a key.

import { TIMEFRAMES, fromYahoo, toWeekly, cleanCandles } from './js/candles.js';

const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function httpError(url, status) {
  const err = new Error(`${new URL(url).host} answered ${status}`);
  err.status = status;
  return err;
}

async function getJson(fetchFn, url, headers = BROWSER) {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw httpError(url, res.status);
  return res.json();
}

const yahooSymbol = s => encodeURIComponent(s.replace(/\./g, '-'));

// ---- Yahoo with a cookie and crumb ------------------------------------------

export function yahooSession(fetchFn = fetch) {
  let session = null;
  const open = async () => {
    const first = await fetchFn('https://fc.yahoo.com/', { headers: BROWSER, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const cookies = (first.headers.getSetCookie ? first.headers.getSetCookie() : [first.headers.get('set-cookie')].filter(Boolean))
      .map(c => c.split(';')[0]).join('; ');
    if (!cookies) throw new Error('Yahoo Finance gave no session cookie');
    const res = await fetchFn('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { ...BROWSER, Cookie: cookies }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw httpError('https://query2.finance.yahoo.com', res.status);
    const crumb = (await res.text()).trim();
    if (!crumb || crumb.includes('<')) throw new Error('Yahoo Finance gave no crumb');
    return { cookies, crumb };
  };
  return async url => {
    session = session || await open();
    const res = await fetchFn(`${url}&crumb=${encodeURIComponent(session.crumb)}`, { headers: { ...BROWSER, Cookie: session.cookies }, signal: AbortSignal.timeout(15000) });
    if (res.status === 401 || res.status === 403) session = null; // stale crumb: a new one next time
    if (!res.ok) throw httpError(url, res.status);
    return res.json();
  };
}

// Yahoo's daily chart can lag a day for some symbols (AAPL on a Friday
// evening ended at Thursday), while the chart's own quote is current. A day
// missing from the chart is added from that quote, with the open at the
// previous close.
export function withYahooToday(candles, json) {
  const m = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
  const close = m && Number(m.regularMarketPrice);
  const at = m && Number(m.regularMarketTime);
  if (!candles.length || !(close > 0) || !(at > 0)) return candles;
  const last = candles.at(-1);
  const day = Math.floor(at / 86400);
  if (day <= Math.floor(last.time / 86400)) return candles;
  const open = last.close;
  const hi = Number(m.regularMarketDayHigh);
  const lo = Number(m.regularMarketDayLow);
  const volume = Number(m.regularMarketVolume);
  return [...candles, {
    time: day * 86400 + 13.5 * 3600, open, close,
    high: Math.max(hi > 0 ? hi : 0, open, close), low: Math.min(lo > 0 ? lo : Infinity, open, close),
    volume: Number.isFinite(volume) ? volume : 0,
  }];
}

// ---- Nasdaq -----------------------------------------------------------------

const money = v => Number(String(v ?? '').replace(/[$,\s]/g, ''));

// Nasdaq's historical table: rows of { date: "10/15/2026", open: "$1.00", ... }.
export function fromNasdaq(json) {
  const rows = json && json.data && json.data.tradesTable && json.data.tradesTable.rows;
  if (!rows || !rows.length) throw new Error('Nasdaq: no data');
  return cleanCandles(rows.map(r => {
    const [m, d, y] = String(r.date).split('/').map(Number);
    // 13:30 UTC is the US open, where Yahoo puts its daily candles too.
    return { time: Date.UTC(y, m - 1, d, 13, 30) / 1000, open: money(r.open), high: money(r.high), low: money(r.low), close: money(r.close), volume: money(r.volume) };
  }));
}

export function nasdaqPriceOf(json) {
  const p = json && json.data && json.data.primaryData;
  const price = p && money(p.lastSalePrice);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Nasdaq: no price');
  return price;
}

// Nasdaq's history table only gets a day's row the next day, so a scan in the
// evening would score yesterday's chart. Its live quote adds today's candle:
// the last price, the day's range when given, and an open at the previous close.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function withToday(candles, info) {
  const d = info && info.data;
  const p = d && d.primaryData;
  const close = p && money(p.lastSalePrice);
  const m = p && /([A-Z][a-z]{2})\w* (\d{1,2}), (\d{4})/.exec(String(p.lastTradeTimestamp || ''));
  if (!candles.length || !(close > 0) || !m || !MONTHS.includes(m[1])) return candles;
  const time = Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]), 13, 30) / 1000;
  const last = candles.at(-1);
  if (time <= last.time) return candles;
  const range = String((d.keyStats && d.keyStats.dayrange && d.keyStats.dayrange.value) || '').split('-').map(money);
  const open = last.close;
  const [lo, hi] = range.length === 2 && range.every(v => v > 0) ? range : [Math.min(open, close), Math.max(open, close)];
  const volume = money(p.volume);
  return [...candles, { time, open, high: Math.max(hi, open, close), low: Math.min(lo, open, close), close, volume: Number.isFinite(volume) ? volume : 0 }];
}

// Stocks and ETFs (SPY) are separate asset classes on Nasdaq.
async function nasdaq(fetchFn, symbol, path) {
  const sym = encodeURIComponent(symbol.replace(/-/g, '.'));
  let last;
  for (const cls of ['stocks', 'etf']) {
    try {
      const json = await getJson(fetchFn, `https://api.nasdaq.com/api/quote/${sym}/${path}${path.includes('?') ? '&' : '?'}assetclass=${cls}`);
      if (json && json.data) return json;
      last = new Error('Nasdaq: no data');
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ---- Together ---------------------------------------------------------------

// `limit` spaces and pauses each source's calls (engine.mjs's politely).
export function stockSources({ fetchFn = fetch, limitYahoo = f => f, limitNasdaq = f => f, now = Date.now } = {}) {
  const crumbed = yahooSession(fetchFn);
  const yahooChart = limitYahoo(async (item, tf) => {
    const [interval, range] = TIMEFRAMES[tf].yahoo;
    const path = `/v8/finance/chart/${yahooSymbol(item.symbol)}?interval=${interval}&range=${range}`;
    const parse = json => (tf === '1D' ? withYahooToday(fromYahoo(json), json) : fromYahoo(json));
    try {
      return parse(await getJson(fetchFn, `https://query1.finance.yahoo.com${path}`));
    } catch (e) {
      if (e.status !== 429) throw e;
      try {
        return parse(await crumbed(`https://query2.finance.yahoo.com${path}`));
      } catch {
        throw e; // report the first refusal
      }
    }
  });
  const nasdaqDaily = limitNasdaq(async (item, tf) => {
    const to = new Date(now());
    const from = new Date(to.getTime() - (tf === '1W' ? 10 * 365 : 2 * 365) * 86400_000);
    const day = d => d.toISOString().slice(0, 10);
    const json = await nasdaq(fetchFn, item.symbol, `historical?fromdate=${day(from)}&todate=${day(to)}&limit=9999`);
    let daily = fromNasdaq(json);
    try {
      daily = withToday(daily, await nasdaq(fetchFn, item.symbol, 'info'));
    } catch {
      // History alone, a day behind.
    }
    return tf === '1W' ? toWeekly(daily) : daily;
  });
  const nasdaqPrice = limitNasdaq(async item => nasdaqPriceOf(await nasdaq(fetchFn, item.symbol, 'info')));
  const yahooPrice = limitYahoo(async item => {
    const json = await getJson(fetchFn, `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(item.symbol)}?interval=1m&range=1d`);
    const meta = json && json.chart && json.chart.result && json.chart.result[0] && json.chart.result[0].meta;
    const price = meta && Number(meta.regularMarketPrice);
    if (Number.isFinite(price) && price > 0) return price;
    const candles = fromYahoo(json);
    if (!candles.length) throw new Error(`No price for ${item.symbol}`);
    return candles.at(-1).close;
  });

  return {
    async candles(item, tf) {
      try {
        return { candles: (await yahooChart(item, tf)).slice(-500), source: 'Yahoo Finance' };
      } catch (e) {
        if (tf !== '1D' && tf !== '1W') throw e;
        try {
          return { candles: (await nasdaqDaily(item, tf)).slice(-500), source: 'Nasdaq' };
        } catch (n) {
          throw new Error(`${e.message}; Nasdaq: ${n.message.replace(/^Nasdaq: /, '')}`);
        }
      }
    },
    async price(item) {
      try {
        return await yahooPrice(item);
      } catch (e) {
        try {
          return await nasdaqPrice(item);
        } catch (n) {
          throw new Error(`${e.message}; Nasdaq: ${n.message.replace(/^Nasdaq: /, '')}`);
        }
      }
    },
  };
}
