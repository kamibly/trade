import test from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../app/js/forecast.js';
import { analyze, signalAt, scoreVotes, scoreHistory, crossings, actionFor, votesAt } from '../app/js/signals.js';
import { alertFor, isFresh, scanItem } from '../app/js/scanner.js';
import { inQuietHours } from '../app/js/notify.js';

// Deterministic price series: drift per candle plus pseudo-random noise.
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

test('normal distribution helpers', () => {
  assert.ok(Math.abs(F.normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(F.normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(F.normInv(0.975) - 1.96) < 1e-3);
});

test('linear regression recovers a straight line', () => {
  const v = Array.from({ length: 50 }, (_, i) => 3 + 2 * i);
  const lr = F.linearRegression(v, 49, 50);
  assert.ok(Math.abs(lr.slope - 2) < 1e-9);
  assert.ok(Math.abs(lr.r2 - 1) < 1e-9);
});

test('holt forecast continues a trend', () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + i);
  const h = F.holt(v);
  assert.ok(F.holtForecast(h, 59, 10) > 159);
});

test('arima forecast is positive for steady growth and null without data', () => {
  const v = series(200, 0.01, 0.005).map(c => c.close);
  assert.ok(F.arimaForecast(v, 199).total > 0);
  assert.equal(F.arimaForecast(v.slice(0, 10), 9), null);
});

test('monte carlo bands are ordered and reproducible', () => {
  const a = F.monteCarlo(100, { mu: 0.001, sigma: 0.02 }, 10);
  const b = F.monteCarlo(100, { mu: 0.001, sigma: 0.02 }, 10);
  assert.deepEqual(a, b);
  for (const s of a) assert.ok(s.p10 < s.p50 && s.p50 < s.p90);
  assert.ok(a[9].p90 - a[9].p10 > a[0].p90 - a[0].p10); // widens with time
});

test('hurst separates trending from reverting returns', () => {
  const trend = [100];
  let step = 1;
  for (let i = 0; i < 200; i++) { if (i % 25 === 0) step = -step; trend.push(trend.at(-1) * (1 + 0.01 * step)); }
  const revert = Array.from({ length: 201 }, (_, i) => 100 * (1 + 0.01 * (i % 2)));
  assert.ok(F.hurst(trend, 200) > F.hurst(revert, 200));
});

test('score is positive in an uptrend, negative in a downtrend', () => {
  const up = signalAt(analyze(series(400, 0.01)));
  const down = signalAt(analyze(series(400, -0.01)));
  assert.ok(up.score > 20, String(up.score));
  assert.ok(down.score < -20, String(down.score));
  assert.ok(up.stop < up.entry && up.take > up.entry);
  assert.ok(down.stop > down.entry && down.take < down.entry);
  assert.equal(up.votes.length, 30);
});

test('every vote stays between -1 and 1 and has a note', () => {
  const S = analyze(series(300, 0.002, 0.03, 7));
  for (let i = 60; i < 300; i += 17) {
    for (const v of votesAt(S, i)) {
      assert.ok(v.vote >= -1 && v.vote <= 1, `${v.id} ${v.vote}`);
      assert.ok(typeof v.note === 'string' && v.note.length, v.id);
    }
  }
});

test('methods without volume data drop out instead of voting zero', () => {
  const c = series(300, 0.01).map(x => ({ ...x, volume: 0 }));
  const votes = signalAt(analyze(c)).votes;
  assert.ok(!votes.some(v => v.group === 'volume'));
});

test('groups are averaged before groups are combined', () => {
  const votes = [
    { id: 'a', group: 'trend', vote: 1 }, { id: 'b', group: 'trend', vote: 1 }, { id: 'c', group: 'trend', vote: 1 },
    { id: 'd', group: 'volume', vote: -1 },
  ];
  assert.equal(scoreVotes(votes), 0);
  assert.equal(scoreVotes(votes, { d: 0 }), 100);
});

test('crossings mark entries into buy and sell zones once', () => {
  assert.deepEqual(crossings([0, 45, 50, 10, -45, -50, NaN, 41]).map(c => [c.i, c.action]), [[1, 'buy'], [4, 'sell'], [7, 'buy']]);
  assert.equal(actionFor(40), 'buy');
  assert.equal(actionFor(-39), 'hold');
});

test('score history has values only once there is enough history', () => {
  const h = scoreHistory(analyze(series(120, 0.01)));
  assert.ok(Number.isNaN(h[10]));
  assert.ok(Number.isFinite(h[119]));
});

test('alerts only fire on a change into buy or sell', () => {
  assert.equal(alertFor('hold', 'buy'), 'buy');
  assert.equal(alertFor('buy', 'buy'), null);
  assert.equal(alertFor('buy', 'hold'), null);
  assert.equal(alertFor('buy', 'sell'), 'sell');
});

test('saved candles are reused while fresh', async () => {
  const now = Date.now();
  assert.equal(isFresh({ savedAt: now - 30 * 60_000 }, '1D', now), true);
  assert.equal(isFresh({ savedAt: now - 30 * 60_000 }, '15m', now), false);
  let fetched = 0;
  const deps = {
    getCandles: () => ({ savedAt: Date.now(), candles: series(300, 0.01) }),
    saveCandles: () => {},
    fetchCandles: async () => { fetched++; return { candles: [] }; },
  };
  const r = await scanItem({ type: 'crypto', symbol: 'BTC', name: 'Bitcoin' }, '1D', {}, { buy: 40, sell: -40 }, deps);
  assert.equal(fetched, 0);
  assert.equal(r.result.key, 'crypto:BTC');
  assert.ok(Number.isFinite(r.result.score));
});

test('a failed fetch falls back to old candles, or reports the error', async () => {
  const fail = async () => { throw new Error('offline'); };
  const old = { savedAt: 0, candles: series(300, 0.01) };
  const withOld = await scanItem({ type: 'crypto', symbol: 'X' }, '1D', {}, undefined, { getCandles: () => old, saveCandles() {}, fetchCandles: fail });
  assert.ok(withOld.result);
  const none = await scanItem({ type: 'crypto', symbol: 'X' }, '1D', {}, undefined, { getCandles: () => null, saveCandles() {}, fetchCandles: fail });
  assert.equal(none.error, 'offline');
});

test('quiet hours wrap past midnight', () => {
  const at = h => new Date(2024, 0, 1, h, 30);
  assert.equal(inQuietHours(at(23)), true);
  assert.equal(inQuietHours(at(3)), true);
  assert.equal(inQuietHours(at(7)), false);
  assert.equal(inQuietHours(at(12)), false);
});
