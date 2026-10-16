import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockSources, fromNasdaq, nasdaqPriceOf } from '../server/stocks.mjs';

const yahooChart = closes => ({ chart: { result: [{ timestamp: closes.map((_, i) => 1_700_000_000 + i * 86400), indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1) }] } }] } });
const nasdaqRows = n => ({ data: { tradesTable: { rows: Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 0, 2) + i * 86400_000);
  return { date: `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`, open: '$10.00', high: '$11.50', low: '$9.00', close: `$${(10 + i / 100).toFixed(2)}`, volume: '1,234,567' };
}).reverse() } } });

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push(url);
    const [, reply] = routes.find(([match]) => url.includes(match)) || [null, { status: 404 }];
    const r = typeof reply === 'function' ? reply(url, opts) : reply;
    const headers = new Headers(r.headers || {});
    return { ok: (r.status || 200) < 400, status: r.status || 200, headers, json: async () => r.body, text: async () => r.text ?? JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

test('Nasdaq tables and quotes parse', () => {
  const c = fromNasdaq(nasdaqRows(3));
  assert.equal(c.length, 3);
  assert.deepEqual(c[0], { time: Date.UTC(2026, 0, 2, 13, 30) / 1000, open: 10, high: 11.5, low: 9, close: 10, volume: 1234567 });
  assert.equal(nasdaqPriceOf({ data: { primaryData: { lastSalePrice: '$1,234.56' } } }), 1234.56);
  assert.throws(() => fromNasdaq({ data: null }), /no data/);
});

test('a Yahoo refusal tries the crumb host, then Nasdaq for daily charts and prices', async () => {
  const now = () => Date.UTC(2026, 9, 16);
  // Yahoo answers normally.
  let f = fakeFetch([['query1', { body: yahooChart([1, 2, 3]) }]]);
  let src = stockSources({ fetchFn: f, now });
  assert.equal((await src.candles({ symbol: 'AAPL' }, '1D')).source, 'Yahoo Finance');

  // query1 refuses; the cookie-and-crumb request to query2 works.
  f = fakeFetch([
    ['query1', { status: 429 }],
    ['fc.yahoo.com', { status: 404, headers: { 'set-cookie': 'A3=abc; Domain=.yahoo.com' } }],
    ['getcrumb', { text: 'Xy1' }],
    ['query2.finance.yahoo.com/v8', (url, opts) => (url.includes('crumb=Xy1') && opts.headers.Cookie === 'A3=abc' ? { body: yahooChart([5, 6]) } : { status: 401 })],
  ]);
  src = stockSources({ fetchFn: f, now });
  const viaCrumb = await src.candles({ symbol: 'BRK.B' }, '15m');
  assert.equal(viaCrumb.candles.at(-1).close, 6);
  assert.ok(f.calls[0].includes('/BRK-B?'));

  // Both Yahoo hosts refuse: daily and weekly come from Nasdaq (SPY is an ETF there).
  f = fakeFetch([
    ['query1', { status: 429 }], ['fc.yahoo.com', { status: 429 }],
    ['SPY/historical', url => (url.includes('assetclass=etf') ? { body: nasdaqRows(400) } : { body: { data: null } })],
    ['SPY/info', url => (url.includes('assetclass=etf') ? { body: { data: { primaryData: { lastSalePrice: '$580.10' } } } } : { body: { data: null } })],
  ]);
  src = stockSources({ fetchFn: f, now });
  const daily = await src.candles({ symbol: 'SPY' }, '1D');
  assert.equal(daily.source, 'Nasdaq');
  assert.equal(daily.candles.length, 400);
  const weekly = await src.candles({ symbol: 'SPY' }, '1W');
  assert.ok(weekly.candles.length < 70 && weekly.candles.length > 50);
  assert.equal(await src.price({ symbol: 'SPY' }), 580.1);
  // Intraday has no Nasdaq history: Yahoo's refusal is reported.
  await assert.rejects(src.candles({ symbol: 'SPY' }, '15m'), /answered 429/);
  // Nothing works: both reasons are given.
  f = fakeFetch([['query1', { status: 429 }], ['fc.yahoo.com', { status: 429 }], ['nasdaq', { status: 403 }]]);
  await assert.rejects(stockSources({ fetchFn: f, now }).candles({ symbol: 'AAPL' }, '1D'), /yahoo.com answered 429; Nasdaq: api.nasdaq.com answered 403/);
});
