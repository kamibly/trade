import test from 'node:test';
import assert from 'node:assert/strict';
import { fromYahoo } from '../app/js/candles.js';
import { runWatch, runMarket, runPrices, parseSp500 } from '../server/engine.mjs';
import { newAccount } from '../app/js/paper.js';

function series(n, drift, vol = 0.02, seed = 42) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= Math.exp(drift + vol * (r() - 0.5) * 2);
    return { time: i * 86400, open: o, close: p, high: Math.max(o, p) * (1 + r() * vol), low: Math.min(o, p) * (1 - r() * vol), volume: 1000 + r() * 1000 };
  });
}

const settings = { tune: 'manual', buyAt: 40, sellAt: -40, stopAtr: 2, takeAtr: 3, twelveKey: '' };

function deps(map, extra = {}) {
  const get = item => {
    const c = map[item.symbol];
    if (!c) throw new Error(`no data for ${item.symbol}`);
    return { candles: c, source: 'stub' };
  };
  return { fetchCandles: async get2 => get(get2), yahooCandles: async item => get(item), fetchCryptoTop: async () => [], fetchText: async () => { throw new Error('offline'); }, now: () => 1_000_000, ...extra };
}

test('Yahoo chart JSON becomes clean candles, dropping empty bars', () => {
  const json = { chart: { result: [{ timestamp: [100, 200, 300], indicators: { quote: [{ open: [1, 2, null], high: [2, 3, null], low: [0.5, 1.5, null], close: [1.5, 2.5, null], volume: [10, null, null] }] } }] } };
  assert.deepEqual(fromYahoo(json), [
    { time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: 200, open: 2, high: 3, low: 1.5, close: 2.5, volume: 0 },
  ]);
  assert.throws(() => fromYahoo({ chart: { result: null, error: { description: 'No data found' } } }), /No data found/);
});

test('S&P 500 list parses quoted names', () => {
  const rows = parseSp500('Symbol,Security,Sector\nMMM,3M,Industrials\nBRK.B,"Berkshire Hathaway, Inc.",Financials\n');
  assert.deepEqual(rows.map(r => r.symbol), ['MMM', 'BRK.B']);
  assert.equal(rows[1].name, 'Berkshire Hathaway, Inc.');
});

test('watch run: signals, a change alert, holding stop alert and errors', async () => {
  const up = series(300, 0.006, 0.01, 3);
  const map = { UP: up, HELD: up };
  const items = [{ type: 'stock', symbol: 'UP' }, { type: 'stock', symbol: 'HELD' }, { type: 'crypto', symbol: 'GONE' }];
  const last = up.at(-1).close;
  const holdings = [{ id: 'h1', key: 'stock:HELD', type: 'stock', symbol: 'HELD', qty: 3, buyPrice: last * 1.5, stop: last * 1.2, take: null, alerted: {} }];
  const prev = { 'stock:UP': { action: 'hold', tf: '1D' } };
  const r = await runWatch({ tf: '1D', settings, items, holdings, prev, weights: {} }, deps(map));
  assert.equal(r.signals['stock:UP'].action, 'buy');
  assert.ok(Number.isFinite(r.signals['stock:UP'].atr));
  assert.match(r.errors['crypto:GONE'], /no data/);
  const buy = r.alerts.find(a => a.kind === 'signal');
  assert.equal(buy.key, 'stock:UP');
  assert.match(buy.title, /^Buy signal: UP/);
  assert.equal(buy.hash, 'chart/stock/UP');
  // HELD has no previous signal, so only its stop-loss alert fires.
  const stop = r.alerts.find(a => a.kind === 'stop');
  assert.equal(stop.urgent, true);
  assert.deepEqual(r.holdingsAlerted.h1, { stop: true });
  assert.ok(r.weights['stock:UP:1D'].weights);

  // Same state again: nothing new to say.
  const again = await runWatch({ tf: '1D', settings, items, holdings: [{ ...holdings[0], alerted: r.holdingsAlerted.h1 }], prev: r.signals, weights: r.weights }, deps(map));
  assert.equal(again.alerts.length, 0);
});

test('stocks fall back to Twelve Data only when the server has a key', async () => {
  const c = series(200, 0.001);
  let twelve = 0;
  const d = deps({}, {
    yahooCandles: async () => { throw new Error('Yahoo down'); },
    fetchCandles: async () => { twelve++; return { candles: c, source: 'Twelve Data' }; },
  });
  const item = { type: 'stock', symbol: 'AAPL' };
  const noKey = await runWatch({ tf: '1D', settings, items: [item], holdings: [] }, d);
  assert.match(noKey.errors['stock:AAPL'], /Yahoo down/);
  assert.equal(twelve, 0);
  const withKey = await runWatch({ tf: '1D', settings: { ...settings, twelveKey: 'k' }, items: [item], holdings: [] }, d);
  assert.ok(withKey.signals['stock:AAPL']);
  assert.equal(twelve, 1);
});

test('market scan uses the saved S&P list offline and only announces new ideas', async () => {
  const up = series(300, 0.006, 0.01, 3);
  const flat = series(300, 0, 0.02, 9);
  const d = deps({}, {
    yahooCandles: async item => ({ candles: item.symbol === 'MMM' ? up : flat, source: 'stub' }),
    fetchCryptoTop: async () => [{ type: 'crypto', symbol: 'BTC', name: 'Bitcoin', geckoId: 'bitcoin' }],
    fetchCandles: async () => ({ candles: up, source: 'stub' }),
  });
  const first = await runMarket({ settings, prev: {}, weights: {} }, d);
  assert.match(first.errors.sp500, /saved with the server/);
  assert.ok(first.total > 400);
  assert.equal(first.scanned, first.total);
  assert.ok(first.buys.some(b => b.key === 'stock:MMM'));
  assert.equal(first.alert, null); // nothing was scanned before

  const prev = { ...first.actions, 'stock:MMM': 'hold', 'crypto:BTC': 'buy' };
  const second = await runMarket({ settings, prev, weights: first.weights }, d);
  assert.deepEqual(second.newBuys, ['stock:MMM']);
  assert.match(second.alert.title, /1 new buy idea$/);
  assert.match(second.alert.body, /^Buy: MMM \+\d+/);
});

test('app sync helpers: direction, merge and profile', async () => {
  const srv = await import('../app/js/server.js');
  assert.equal(srv.syncDirection(5, null), 'push');
  assert.equal(srv.syncDirection(5, { updatedAt: 9 }), 'pull');
  assert.equal(srv.syncDirection(9, { updatedAt: 5 }), 'push');
  assert.equal(srv.syncDirection(5, { updatedAt: 5 }), 'same');
  const merged = srv.mergeHoldings([{ id: 'a', alerted: { stop: true } }], [{ id: 'a', qty: 2, alerted: { take: true } }, { id: 'b', qty: 1 }]);
  assert.deepEqual(merged, [{ id: 'a', qty: 2, alerted: { take: true, stop: true } }, { id: 'b', qty: 1, alerted: {} }]);
  const p = srv.buildProfile({ watchlist: [{ type: 'crypto', symbol: 'BTC', name: 'Bitcoin', geckoId: 'bitcoin', extra: 1 }], holdings: [], settings: { alertTf: '1h', buyAt: 40, sellAt: -40, stopAtr: 2, takeAtr: 3, quietHours: true, serverKey: 'secret' }, changedAt: 7 });
  assert.deepEqual(p.watchlist[0], { type: 'crypto', symbol: 'BTC', name: 'Bitcoin', geckoId: 'bitcoin' });
  assert.equal(p.settings.serverKey, undefined);
  assert.equal(p.updatedAt, 7);
  assert.equal(srv.cleanUrl('my.host:8898/'), 'https://my.host:8898');
  assert.equal(srv.cleanUrl(''), '');
});

test('server/js copies match app/js (run npm run sync-server if this fails)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { SHARED } = await import('../scripts/sync-server-js.mjs');
  for (const name of SHARED) {
    const app = await readFile(new URL(`../app/js/${name}.js`, import.meta.url), 'utf8');
    const copy = await readFile(new URL(`../server/js/${name}.js`, import.meta.url), 'utf8');
    assert.equal(copy, app, `server/js/${name}.js is out of date`);
  }
});

test('watch run trades the paper account on a new Buy signal', async () => {
  const up = series(300, 0.006, 0.01, 3);
  const items = [{ type: 'stock', symbol: 'UP' }];
  const acc = newAccount(10000, 0);
  const r = await runWatch({ tf: '1D', settings, items, holdings: [], prev: { 'stock:UP': { action: 'hold', tf: '1D' } }, weights: {}, paper: acc, riskPct: 1 }, deps({ UP: up }));
  assert.deepEqual(r.changes, { 'stock:UP': 'buy' });
  assert.equal(r.paper.positions.length, 1);
  assert.equal(r.paperEvents[0].kind, 'open');
  assert.match(r.paperEvents[0].text, /^Bought UP at/);
  // No paper account sent: nothing traded.
  const none = await runWatch({ tf: '1D', settings, items, holdings: [], prev: {}, weights: {} }, deps({ UP: up }));
  assert.equal(none.paper, null);
  assert.deepEqual(none.paperEvents, []);
});

test('minute price check: stop and target alerts once, paper exits at the stop', async () => {
  const holdings = [
    { id: 'h1', key: 'stock:AAPL', type: 'stock', symbol: 'AAPL', qty: 1, buyPrice: 100, stop: 90, take: 130, alerted: {} },
    { id: 'h2', key: 'crypto:BTC', type: 'crypto', symbol: 'BTC', qty: 1, buyPrice: 100, stop: 50, take: 110, alerted: {} },
  ];
  const acc = { ...newAccount(1000, 0), cash: 900, positions: [{ key: 'crypto:BTC', symbol: 'BTC', type: 'crypto', qty: 1, entry: 100, stop: 120, take: 200, cost: 100.1, openedAt: 0 }] };
  const d = deps({ BTC: [{ time: 0, open: 115, high: 116, low: 114, close: 115, volume: 1 }] }, { yahooPrice: async () => 89 });
  const r = await runPrices({ settings, items: [{ type: 'stock', symbol: 'AAPL' }, { type: 'crypto', symbol: 'BTC' }], holdings, paper: acc }, d);
  assert.deepEqual(r.prices, { 'stock:AAPL': 89, 'crypto:BTC': 115 });
  assert.deepEqual(r.alerts.map(a => [a.kind, a.key, !!a.urgent]), [['stop', 'stock:AAPL', true], ['target', 'crypto:BTC', false]]);
  assert.deepEqual(r.holdingsAlerted, { h1: { stop: true }, h2: { take: true } });
  assert.equal(r.paper.positions.length, 0); // 115 is below the paper stop of 120
  assert.match(r.paperEvents[0].text, /^Sold BTC at .* \(stop\)/);
  const again = await runPrices({ settings, items: [{ type: 'stock', symbol: 'AAPL' }], holdings: [{ ...holdings[0], alerted: { stop: true } }], paper: null }, d);
  assert.equal(again.alerts.length, 0);
  const down = await runPrices({ settings, items: [{ type: 'stock', symbol: 'AAPL' }], holdings, paper: null }, deps({}, { yahooPrice: async () => { throw new Error('Yahoo down'); } }));
  assert.match(down.errors['stock:AAPL'], /Yahoo down/);
});
