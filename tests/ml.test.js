import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, votesAt, baseVotesAt, signalAt, METHOD_IDS } from '../app/js/signals.js';
import { featureNames, featureVector, sequence, label, lgbmProbability, lstmProbability, usable, mlVotes, mlOutlook, voteFor, modelsFor, SEQ_LEN, HORIZON } from '../app/js/ml.js';
import { runDataset } from '../server/engine.mjs';
import { backtest } from '../app/js/backtest.js';
import { scanItem } from '../app/js/scanner.js';

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

const sigmoid = x => 1 / (1 + Math.exp(-x));
const good = { hit: 0.56, n: 400 };

// One split on feature 0 at 1.0: <= goes left (leaf -1), > goes right (leaf +1); missing goes left.
const stump = missing => ({ init: 0.1, features: ['a'], trees: [{ nodes: [[0, 1.0, -1, -2, 1, missing]], leaves: [-1, 1] }], test: good });

test('LightGBM trees follow thresholds and missing-value rules', () => {
  assert.equal(lgbmProbability(stump(2), [0.5]), sigmoid(0.1 - 1));
  assert.equal(lgbmProbability(stump(2), [1.5]), sigmoid(0.1 + 1));
  assert.equal(lgbmProbability(stump(2), [NaN]), sigmoid(0.1 - 1)); // NaN takes the default (left)
  const rightDefault = { ...stump(2), trees: [{ nodes: [[0, -1.0, -1, -2, 0, 2]], leaves: [-1, 1] }] };
  assert.equal(lgbmProbability(rightDefault, [NaN]), sigmoid(0.1 + 1));
  const none = { ...stump(0), trees: [{ nodes: [[0, -1.0, -1, -2, 1, 0]], leaves: [-1, 1] }] };
  assert.equal(lgbmProbability(none, [NaN]), sigmoid(0.1 + 1)); // None: NaN counts as 0, and 0 > -1
  const zero = { ...stump(1), trees: [{ nodes: [[0, -1.0, -1, -2, 1, 1]], leaves: [-1, 1] }] };
  assert.equal(lgbmProbability(zero, [0]), sigmoid(0.1 - 1)); // Zero: 0 is missing, takes the default
  assert.equal(lgbmProbability({ trees: [{ nodes: [], leaves: [0.3] }] }, [9]), sigmoid(0.3));
});

test('LSTM with zero weights returns the output bias; gates use PyTorch order', () => {
  const H = 2;
  const zeros = (r, c) => Array.from({ length: r }, () => new Array(c).fill(0));
  const m = { hidden: H, wIh: zeros(4 * H, 2), wHh: zeros(4 * H, H), bIh: new Array(4 * H).fill(0), bHh: new Array(4 * H).fill(0), wOut: [1, 1], bOut: 0.4 };
  assert.equal(lstmProbability(m, [[1, 2], [3, 4]]), sigmoid(0.4));
  // Input gate fully open, forget closed, g = tanh(10·x0), output open: h = tanh(c) after one step.
  const big = 50;
  const m2 = { ...m, bIh: [big, big, -big, -big, 0, 0, big, big], wIh: [[0, 0], [0, 0], [0, 0], [0, 0], [10, 0], [10, 0], [0, 0], [0, 0]], wOut: [1, 0], bOut: 0 };
  const h = Math.tanh(Math.tanh(10 * 0.05));
  assert.ok(Math.abs(lstmProbability(m2, [[0.05, 0]]) - sigmoid(h)) < 1e-9);
});

test('features, sequence and label line up with the method ids', () => {
  const S = analyze(series(300, 0.002));
  const names = featureNames(METHOD_IDS);
  assert.equal(names.length, 30 + 11);
  assert.equal(names[0], `vote:${METHOD_IDS[0]}`);
  const x = featureVector(S, 250, baseVotesAt(S, 250), names);
  assert.equal(x.length, names.length);
  assert.ok(x.slice(0, 30).every(Number.isFinite));
  assert.ok(Number.isFinite(x[names.indexOf('rsi')]) && x[names.indexOf('rsi')] <= 1);
  assert.equal(featureVector(S, 250, [], ['vote:nope', 'nope'])[0], NaN);
  const seq = sequence(S, 250);
  assert.equal(seq.length, SEQ_LEN);
  assert.ok(seq.every(r => r.length === 2 && Math.abs(r[0]) <= 5));
  assert.equal(sequence(S, 10), null);
  assert.equal(label(S, 300 - HORIZON), null);
  assert.equal(label(S, 100), S.close[110] / S.close[100] - 1 > 0.002 ? 1 : 0);
});

test('ML votes join only after the cutoff and only for models that passed their test', () => {
  const candles = series(300, 0.002);
  const lstm = { hidden: 1, wIh: [[0, 0], [0, 0], [0, 0], [0, 0]], wHh: [[0], [0], [0], [0]], bIh: [0, 0, 0, 0], bHh: [0, 0, 0, 0], wOut: [0], bOut: -0.4, test: { hit: 0.45, n: 900 } };
  const models = { cutoff: candles[200].time, trainedAt: 1, lgbm: { ...stump(2), features: ['vote:sma'], trees: [{ nodes: [], leaves: [0.4] }] }, lstm };
  const S = analyze(candles, { models });
  assert.ok(!votesAt(S, 200).some(v => v.group === 'ml'));
  const late = votesAt(S, 250).filter(v => v.group === 'ml');
  assert.deepEqual(late.map(v => v.id), ['lgbm']); // the LSTM failed its test
  assert.ok(Math.abs(late[0].vote - (sigmoid(0.1 + 0.4) - 0.5) * 4) < 1e-12);
  assert.match(late[0].note, /right 56% in its test/);
  assert.ok(!usable({ test: { hit: 0.6, n: 199 } }) && usable({ test: good }) && !usable(null));
  assert.deepEqual(mlVotes(S, 250, baseVotesAt(S, 250), null), []);

  const sig = signalAt(S, 299, {});
  assert.ok(sig.votes.some(v => v.id === 'lgbm'));
  // With an older cutoff the backtest's training part sees the votes and weighs them like any method.
  const bt = backtest(analyze(candles, { models: { ...models, cutoff: candles[100].time } }), {});
  assert.ok(bt.stats.lgbm.n > 0 && Number.isFinite(bt.weights.lgbm));
  assert.equal(backtest(S, {}).weights.lgbm, undefined); // no votes in its training part: weight 1
});

test('the scanner passes the timeframe models to the scoring', async () => {
  const candles = series(300, 0.002);
  const lgbm = { features: [], trees: [{ nodes: [], leaves: [3] }], test: good };
  const seen = [];
  const deps = {
    getCandles: () => ({ savedAt: Date.now(), candles }),
    saveCandles: () => {},
    fetchCandles: async () => { throw new Error('no'); },
    getModels: tf => { seen.push(tf); return { cutoff: 0, trainedAt: 1, lgbm }; },
  };
  const withMl = await scanItem({ type: 'crypto', symbol: 'BTC' }, '1D', { stopAtr: 2, takeAtr: 3 }, { buy: 40, sell: -40 }, deps);
  const without = await scanItem({ type: 'crypto', symbol: 'BTC' }, '1D', { stopAtr: 2, takeAtr: 3 }, { buy: 40, sell: -40 }, { ...deps, getModels: undefined });
  assert.deepEqual(seen, ['1D']);
  assert.ok(withMl.result.score > without.result.score); // a strongly bullish model lifts the score
});

test('votes are measured from the model\'s usual prediction', () => {
  assert.equal(voteFor(0.6, {}), (0.6 - 0.5) * 4); // older models: 50% midpoint
  const m = { center: 0.45, scale: 0.02 };
  assert.ok(Math.abs(voteFor(0.46, m) - 0.5) < 1e-12);
  assert.equal(voteFor(0.40, m), -1);
  assert.equal(voteFor(0.45, m), 0);
});

test('the chart outlook uses what followed similar votes, weighted by cases', () => {
  const candles = series(300, 0.002);
  const S = analyze(candles);
  const table = (ret, up) => [-1, -0.6, -0.2, 0.2, 0.6].map((lo, k) => ({ lo, hi: [-0.6, -0.2, 0.2, 0.6, 1][k], n: 100, ret: k === 4 ? ret : 0, up: k === 4 ? up : 0.4 }));
  // A constant, very bullish tree model: vote +1, the "strong up" row.
  const lgbm = { features: [], trees: [{ nodes: [], leaves: [3] }], center: 0.5, scale: 0.1, test: good, outcomes: table(0.02, 0.7) };
  const out = mlOutlook(S, 299, baseVotesAt(S, 299), { cutoff: 0, lgbm });
  assert.equal(out.ret, 0.02);
  assert.equal(out.up, 0.7);
  assert.deepEqual(out.models.map(m => m.name), ['LightGBM']);
  assert.equal(mlOutlook(S, 299, [], { cutoff: 0, lgbm: { ...lgbm, test: { hit: 0.4, n: 999 } } }), null); // failed its test
  assert.equal(mlOutlook(S, 299, [], { cutoff: 0, lgbm: { ...lgbm, outcomes: undefined } }), null); // older models
  assert.equal(mlOutlook(S, 299, [], { cutoff: candles[299].time, lgbm }), null); // inside the training period
});

test('stocks and crypto use their own models, which vote under new ids', () => {
  const candles = series(300, 0.002);
  const lgbm = { features: ['vote:sma'], trees: [{ nodes: [], leaves: [3] }], center: 0.5, scale: 0.25, label: 'first', stopAtr: 2, takeAtr: 3,
    test: { hit: 0.6, n: 300, base: 0.4 } };
  const file = { tf: '1D', trainedAt: 9, kinds: ['stock', 'crypto'], filter: { x: 1 },
    stock: { cutoff: candles[200].time, lgbm }, crypto: { cutoff: candles[200].time, lgbm: { ...lgbm, test: { hit: 0.42, n: 300, base: 0.4 } } } };
  assert.equal(modelsFor(file, 'stock').lgbm, lgbm);
  assert.deepEqual([modelsFor(file, 'crypto').trainedAt, modelsFor(file, 'crypto').filter, modelsFor(file, 'crypto').type], [9, file.filter, 'crypto']);
  const old = { cutoff: 1, lgbm };
  assert.equal(modelsFor(old, 'crypto'), old, 'a file from before the split is the same for both');
  const votes = S => votesAt(S, 250).filter(v => v.group === 'ml');
  const stock = votes(analyze(candles, { models: modelsFor(file, 'stock') }));
  assert.deepEqual(stock.map(v => v.id), ['lgbm2']);
  assert.match(stock[0].note, /a Buy's target comes before a Sell's .* right 60% of its clear calls in its test, against 40% by chance/);
  assert.deepEqual(votes(analyze(candles, { models: modelsFor(file, 'crypto') })), [], 'not 3 points above chance: no vote');
  const kept = { ...file, crypto: { cutoff: candles[200].time, lgbm: { ...lgbm, label: undefined, test: { hit: 0.55, n: 300 } }, old: true } };
  assert.deepEqual(votes(analyze(candles, { models: modelsFor(kept, 'crypto') })).map(v => v.id), ['lgbm'], 'old mixed models kept for a kind vote as before');
});

test('training data for one kind: your symbols and that kind only', async () => {
  const seen = [];
  const deps = {
    yahooCandles: async item => { seen.push(item.symbol); return { candles: [] }; },
    fetchCandles: async item => { seen.push(item.symbol); return { candles: [] }; },
    fetchCryptoTop: async n => Array.from({ length: n }, (_, k) => ({ type: 'crypto', symbol: `COIN${k}X` })),
    now: () => 0,
  };
  const items = [{ type: 'stock', symbol: 'AAPL' }, { type: 'crypto', symbol: 'XYZ' }];
  const crypto = await runDataset({ tf: '1h', settings: {}, items, total: 50, kind: 'crypto' }, deps);
  assert.equal(crypto.symbols, 51, 'your coin plus all top 50');
  assert.ok(!seen.includes('AAPL'));
  seen.length = 0;
  const stock = await runDataset({ tf: '1h', settings: {}, items, total: 120, kind: 'stock' }, deps);
  assert.equal(stock.symbols, 120);
  assert.ok(seen.includes('AAPL') && !seen.some(s => s === 'XYZ' || /^COIN\d+X$/.test(s)));
});

test('the crypto training list asks CoinGecko again before giving up', async () => {
  let calls = 0;
  const deps = {
    fetchCandles: async () => ({ candles: [] }),
    yahooCandles: async () => ({ candles: [] }),
    fetchCryptoTop: async n => { calls += 1; if (calls < 3) throw new Error('429'); return [{ type: 'crypto', symbol: 'BTC' }]; },
    now: () => 0,
    retryWait: 0,
  };
  assert.equal((await runDataset({ tf: '1h', settings: {}, items: [], total: 50, kind: 'crypto' }, deps)).symbols, 1);
  calls = -10;
  await assert.rejects(runDataset({ tf: '1h', settings: {}, items: [], total: 50, kind: 'crypto' }, deps), /Couldn't get the top coins from CoinGecko: 429/);
});
