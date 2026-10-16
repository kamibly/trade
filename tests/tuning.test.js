import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, actionFor, contextAt, crossings, scoreHistory, MIN_CANDLES, DEFAULT_THRESHOLDS } from '../app/js/signals.js';
import { backtest, tuneRule, TUNE_BUY, TUNE_SELL } from '../app/js/backtest.js';
import { turnLabels, mlVotes, usable, TURN_HORIZON } from '../app/js/ml.js';
import { learn, ruleOf, manualRule, learnKey, scanItem } from '../app/js/scanner.js';

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

test('dip mode buys only in an uptrend after a pullback, and sells when the trend breaks', () => {
  const rule = { buy: 20, sell: -30, mode: 'dip' };
  const up = { uptrend: true, pulledBack: true, belowTrend: false };
  assert.equal(actionFor(25, rule, up), 'buy');
  assert.equal(actionFor(25, rule, { ...up, pulledBack: false }), 'hold');
  assert.equal(actionFor(80, rule, { ...up, uptrend: false }), 'hold');
  assert.equal(actionFor(10, rule, { uptrend: false, pulledBack: false, belowTrend: true }), 'sell');
  assert.equal(actionFor(-35, rule, up), 'sell');
  assert.equal(actionFor(25, rule, null), 'hold');
  // Standard mode ignores the trend.
  assert.equal(actionFor(25, { buy: 20, sell: -30 }, { uptrend: false }), 'buy');
});

test('dip mode never buys in a downtrend', () => {
  const S = analyze(series(500, -0.004, 0.03, 5));
  const scores = scoreHistory(S);
  const marks = crossings(scores, { buy: 15, sell: -60, mode: 'dip' }, S);
  for (const m of marks.filter(x => x.action === 'buy')) assert.ok(contextAt(S, m.i).uptrend);
  const late = marks.filter(m => m.i > 300 && m.action === 'buy');
  assert.deepEqual(late, []);
});

test('tuning picks thresholds from the training part only and reports the test part', () => {
  const S = analyze(series(600, 0.0015, 0.025, 9));
  const scores = scoreHistory(S);
  const first = MIN_CANDLES - 1;
  const split = 360;
  const a = tuneRule(S, scores, first, split);
  // Changing everything after the split must not change the pick.
  const scrambled = scores.map((s, i) => (i >= split ? -s : s));
  const b = tuneRule(S, scrambled, first, split);
  assert.ok(a && b);
  assert.deepEqual(a.rule, b.rule);
  assert.ok(TUNE_BUY.includes(a.rule.buy) && TUNE_SELL.includes(a.rule.sell) && ['standard', 'dip'].includes(a.rule.mode));
  assert.ok(a.result.trades.length + (a.result.open ? 1 : 0) >= 3);

  const bt = backtest(S, { tune: true });
  assert.ok(bt.rule && bt.tuned && bt.standard && bt.tunedTrain);
  assert.ok(TUNE_BUY.includes(bt.rule.buy));
  // Only the thresholds are tuned when the mode is fixed.
  const fixed = backtest(S, { tune: 'thresholds', thresholds: { ...DEFAULT_THRESHOLDS, mode: 'dip' } });
  assert.equal(fixed.rule.mode, 'dip');
  assert.equal(backtest(S).rule, undefined);
});

test('scanner: auto tuning uses the learned rule, manual uses your thresholds', async () => {
  const candles = series(400, 0.002, 0.02, 21);
  const S = analyze(candles);
  const base = { stopAtr: 2, takeAtr: 3, buyAt: 45, sellAt: -35, mode: 'dip' };
  const manual = learn(S, { ...base, tune: 'manual' });
  assert.equal(manual.rule, null);
  assert.deepEqual(ruleOf({ ...base, tune: 'manual' }, manual), { buy: 45, sell: -35, mode: 'dip' });
  const auto = learn(S, { ...base, tune: 'auto' });
  assert.ok(auto.rule && auto.test && auto.test.tuned);
  assert.deepEqual(ruleOf({ ...base, tune: 'auto' }, auto), auto.rule);
  assert.notEqual(learnKey({ ...base, tune: 'auto' }), learnKey({ ...base, tune: 'manual' }));
  assert.deepEqual(manualRule({ buyAt: 40, sellAt: -40 }), { buy: 40, sell: -40, mode: 'standard' });

  // A settings change makes the scanner learn again; the signal carries its rule.
  const saved = {};
  let learned = 0;
  const deps = {
    getCandles: () => ({ savedAt: Date.now(), candles }),
    saveCandles: () => {},
    fetchCandles: async () => { throw new Error('no network'); },
    getWeight: () => saved.w || null,
    saveWeight: (item, tf, l) => { learned++; saved.w = { at: Date.now(), ...l }; },
  };
  const item = { type: 'crypto', symbol: 'BTC' };
  const r1 = await scanItem(item, '1D', { ...base, tune: 'auto' }, manualRule(base), deps);
  await scanItem(item, '1D', { ...base, tune: 'auto' }, manualRule(base), deps);
  assert.equal(learned, 1);
  assert.deepEqual(r1.result.rule, saved.w.rule);
  assert.ok(r1.result.tuned && r1.result.ctx);
  const r2 = await scanItem(item, '1D', { ...base, tune: 'manual' }, manualRule(base), deps);
  assert.equal(learned, 2);
  assert.deepEqual(r2.result.rule, { buy: 45, sell: -35, mode: 'dip' });
  assert.equal(r2.result.tuned, null);
});

test('turning-point labels: did a trade from here hit its target before its stop', () => {
  // 40 flat candles (range 99-101), then a steady climb of 1 a candle.
  const candles = Array.from({ length: 120 }, (_, i) => {
    const c = i < 40 ? 100 : 100 + (i - 39);
    return { time: i * 86400, open: c, close: c, high: c + 1, low: c - 1, volume: 1000 };
  });
  const S = analyze(candles);
  const at = turnLabels(S, 39);
  assert.deepEqual(at, { bottom: 1, top: 0 });
  // Falling instead: a good place to sell, a bad place to buy.
  const down = candles.map((c, i) => (i < 40 ? c : { ...c, open: 200 - c.close, close: 200 - c.close, high: 201 - c.close, low: 199 - c.close }));
  assert.deepEqual(turnLabels(analyze(down), 39), { bottom: 0, top: 1 });
  assert.equal(turnLabels(S, candles.length - TURN_HORIZON), null);
});

test('turning-point models must beat their base rate, and only push the score their way', () => {
  assert.ok(usable({ test: { hit: 0.6, n: 300 } }));
  assert.ok(usable({ test: { hit: 0.44, base: 0.4, n: 300 } }));
  assert.ok(!usable({ test: { hit: 0.42, base: 0.4, n: 300 } }));
  assert.ok(!usable({ test: { hit: 0.9, base: 0.4, n: 100 } }));

  const S = analyze(series(300, 0.001, 0.02, 3));
  const model = (init, center) => ({ init, trees: [], features: ['rsi'], center, scale: 0.1, test: { hit: 0.5, base: 0.4, n: 500 } });
  // p = 50%: well above the usual 30%, so a full vote; the top model votes down.
  let votes = mlVotes(S, 250, [], { cutoff: 0, bottom: model(0, 0.3), top: model(0, 0.3) });
  assert.deepEqual(votes.map(v => [v.id, v.vote, v.group]), [['bottom', 1, 'ml'], ['top', -1, 'ml']]);
  // Below its usual level, a model says nothing rather than the opposite.
  votes = mlVotes(S, 250, [], { cutoff: 0, bottom: model(0, 0.7), top: model(0, 0.7) });
  assert.deepEqual(votes, []);
});
