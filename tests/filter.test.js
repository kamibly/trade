import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, baseVotesAt, METHOD_IDS } from '../app/js/signals.js';
import { TURN_HORIZON } from '../app/js/ml.js';
import { filterNames, filterVector, tradeOutcome, trendAt, marketTrend, judge, usableFilter } from '../app/js/filter.js';

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

test('market trend is looked up on or before the day', () => {
  const s = [[10, 0.1], [20, 0.2], [30, -0.1]];
  assert.ok(Number.isNaN(trendAt(s, 5)));
  assert.equal(trendAt(s, 10), 0.1);
  assert.equal(trendAt(s, 29), 0.2);
  assert.equal(trendAt(s, 99), -0.1);
  assert.ok(Number.isNaN(trendAt([], 10)));
  const S = analyze(series(300, 0.002));
  assert.ok(Math.abs(marketTrend(S, 299) - (S.close[299] / S.sma200[299] - 1)) < 1e-12);
});

test('trade outcome: stop or target first, after fees, and sold at the horizon otherwise', () => {
  const flat = Array.from({ length: 60 }, (_, i) => ({ time: i, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 }));
  const S = { candles: flat, close: flat.map(c => c.close), atr: flat.map(() => 1) };
  const none = tradeOutcome(S, 10, { type: 'stock' });
  assert.equal(none.win, 0);
  assert.ok(Math.abs(none.ret - (0.999 * 0.999 - 1)) < 1e-12);
  const up = flat.map((c, i) => (i === 15 ? { ...c, high: 104 } : c));
  const w = tradeOutcome({ ...S, candles: up }, 10, { type: 'crypto' });
  assert.equal(w.win, 1);
  assert.ok(Math.abs(w.ret - (1.03 * 0.996 * 0.996 - 1)) < 1e-12);
  const down = flat.map((c, i) => (i === 12 ? { ...c, open: 97, low: 96 } : c));
  const l = tradeOutcome({ ...S, candles: down }, 10);
  assert.equal(l.win, 0);
  assert.ok(Math.abs(l.ret - (0.97 * 0.999 * 0.999 - 1)) < 1e-12); // gapped below the stop: sold at the open
  assert.equal(tradeOutcome(S, 60 - TURN_HORIZON), null); // not enough candles left
});

test('the filter sees only what was known on the buy day', () => {
  const candles = series(400, 0.001);
  const S = analyze(candles);
  const names = filterNames(METHOD_IDS);
  const i = 300;
  const x = filterVector(S, i, baseVotesAt(S, i), names, { type: 'crypto', market: 0.05 });
  assert.equal(x.length, names.length);
  assert.equal(x[names.indexOf('crypto')], 1);
  assert.equal(x[names.indexOf('market')], 0.05);
  const changed = candles.map((c, k) => (k > i ? { ...c, close: c.close * 3, high: c.high * 3, low: c.low * 0.2 } : c));
  const S2 = analyze(changed);
  const x2 = filterVector(S2, i, baseVotesAt(S2, i), names, { type: 'crypto', market: 0.05 });
  assert.deepEqual(x2.map(String), x.map(String));
});

test('judge: only a passed model, only after its cutoff, and sizes by expected result', () => {
  const S = analyze(series(300, 0.002));
  const i = 290;
  const votes = baseVotesAt(S, i);
  const features = filterNames(METHOD_IDS);
  const model = p => ({ init: Math.log(p / (1 - p)), features, trees: [], cutoff: 0, test: { passed: true, medianEv: 0.01 } });
  assert.equal(usableFilter({ ...model(0.5), test: { passed: false } }), false);
  assert.equal(judge({ ...model(0.5), test: { passed: false } }, S, i, votes, { type: 'stock' }), null);
  assert.equal(judge({ ...model(0.5), cutoff: S.candles[i].time }, S, i, votes, { type: 'stock' }), null);
  const tp = (3 * S.atr[i]) / S.close[i];
  const sp = (2 * S.atr[i]) / S.close[i];
  const good = judge(model(0.9), S, i, votes, { type: 'stock' });
  assert.ok(Math.abs(good.p - 0.9) < 1e-4);
  assert.ok(Math.abs(good.ev - (0.9 * tp - 0.1 * sp - 0.002)) < 1e-5);
  assert.ok(good.size >= 0.5 && good.size <= 1.5);
  const bad = judge(model(0.1), S, i, votes, { type: 'stock' });
  assert.ok(bad.ev < 0);
  assert.equal(bad.size, 0);
});
