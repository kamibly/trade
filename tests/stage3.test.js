import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, DEFAULT_THRESHOLDS } from '../app/js/signals.js';
import { voteMatrix, methodStats, weightsFrom, simulate, backtest } from '../app/js/backtest.js';
import * as paper from '../app/js/paper.js';
import * as pf from '../app/js/portfolio.js';
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

test('weights: 50% right stays at 1, better rises, worse falls, few votes stay near 1', () => {
  const w = weightsFrom({
    a: { id: 'a', n: 1000, hit: 0.5 },
    b: { id: 'b', n: 1000, hit: 0.6 },
    c: { id: 'c', n: 1000, hit: 0.35 },
    d: { id: 'd', n: 5, hit: 1 },
    e: { id: 'e', n: 0, hit: NaN },
  });
  assert.equal(w.a, 1);
  assert.ok(w.b > 1.9 && w.b <= 2);
  assert.ok(w.c < 0.1);
  assert.ok(w.d > 1 && w.d < 1.2);
  assert.equal(w.e, 1);
});

test('method stats count trend votes as right in a steady uptrend', () => {
  const S = analyze(series(400, 0.004, 0.01));
  const votes = voteMatrix(S);
  const stats = methodStats(S, votes, 59, 380, { horizon: 10 });
  assert.ok(stats['sma-cross'].n > 100);
  assert.ok(stats['sma-cross'].hit > 0.8);
});

test('simulate takes the stop before the target and counts fees', () => {
  const candles = Array.from({ length: 5 }, (_, i) => ({ time: i, open: 100, high: 101, low: 99, close: 100, volume: 0 }));
  candles[2] = { time: 2, open: 100, high: 120, low: 80, close: 100, volume: 0 };
  const S = { candles, close: candles.map(c => c.close), atr: candles.map(() => 5) };
  const scores = [NaN, 50, 0, 0, 0];
  const r = simulate(S, scores, 0, 5, { thresholds: DEFAULT_THRESHOLDS, stopAtr: 2, takeAtr: 3 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'stop');
  assert.equal(r.trades[0].exit, 90);
  assert.ok(r.totalReturn < -0.1 && r.totalReturn > -0.11);
});

test('simulate exits on a sell score and tracks drawdown', () => {
  const closes = [100, 100, 110, 105, 95, 96];
  const candles = closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 0 }));
  const S = { candles, close: closes, atr: closes.map(() => 100) };
  const r = simulate(S, [0, 50, 10, 10, -50, 0], 0, 6);
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'sell signal');
  assert.ok(Math.abs(r.trades[0].ret - (0.95 * 0.999 * 0.999 - 1)) < 1e-9);
  assert.ok(r.maxDrawdown > 0.13);
  assert.ok(Math.abs(r.buyHold - (-0.04)) < 1e-9);
});

test('backtest splits history and reports weighted and equal results', () => {
  const S = analyze(series(500, 0.002, 0.02, 5));
  const bt = backtest(S);
  assert.ok(bt.testFrom > bt.trainFrom);
  assert.ok(bt.testCandles > 150 && bt.testCandles < 200);
  for (const r of [bt.weighted, bt.equal]) {
    assert.ok(Number.isFinite(r.totalReturn));
    assert.ok(r.maxDrawdown >= 0 && r.maxDrawdown < 1);
  }
  assert.equal(backtest(analyze(series(150, 0))), null);
});

test('paper position size: 1% risk, capped at 20% of equity and at cash', () => {
  assert.ok(Math.abs(paper.positionSize({ equity: 10000, cash: 10000, entry: 100, stop: 90, riskPct: 1 }) - 10) < 1e-9);
  assert.ok(Math.abs(paper.positionSize({ equity: 10000, cash: 10000, entry: 100, stop: 99.9, riskPct: 1 }) - 20) < 1e-9);
  assert.ok(paper.positionSize({ equity: 10000, cash: 500, entry: 100, stop: 90 }) < 5);
  assert.equal(paper.positionSize({ equity: 10000, cash: 10000, entry: 100, stop: 110 }), 0);
});

test('paper account buys on a buy alert and sells on target, stop or sell', () => {
  const acc = paper.newAccount(10000, 0);
  const sig = (entry, action = 'hold') => ({ symbol: 'BTC', type: 'crypto', action, entry, stop: 90, take: 130 });
  let ev = paper.step(acc, { signals: { 'crypto:BTC': sig(100, 'buy') }, alerts: { 'crypto:BTC': 'buy' }, now: 1 });
  assert.equal(ev[0].kind, 'open');
  assert.equal(acc.positions.length, 1);
  assert.ok(acc.cash < 10000 && acc.cash > 8900);
  ev = paper.step(acc, { signals: { 'crypto:BTC': sig(110) }, now: 2 });
  assert.equal(ev.length, 0);
  ev = paper.step(acc, { signals: { 'crypto:BTC': sig(131) }, now: 3 });
  assert.equal(ev[0].reason, 'target');
  assert.ok(ev[0].pnl > 300);
  assert.equal(acc.positions.length, 0);
  const s = paper.summary(acc);
  assert.equal(s.trades, 1);
  assert.equal(s.winRate, 1);
  assert.ok(s.totalReturn > 0.03);

  paper.step(acc, { signals: { 'crypto:BTC': sig(100, 'buy') }, alerts: { 'crypto:BTC': 'buy' }, now: 4 });
  ev = paper.step(acc, { signals: { 'crypto:BTC': sig(95, 'sell') }, now: 5 });
  assert.equal(ev[0].reason, 'sell signal');
  assert.ok(ev[0].pnl < 0);
});

test('holdings: auto levels from ATR, validation, value and alerts fire once', () => {
  const h = pf.makeHolding({ type: 'stock', symbol: 'AAPL', qty: '10', buyPrice: '200', stop: '', take: '', atr: 5 });
  assert.equal(h.stop, 190);
  assert.equal(h.take, 215);
  assert.throws(() => pf.makeHolding({ type: 'stock', symbol: 'AAPL', qty: '0', buyPrice: '1' }));
  assert.throws(() => pf.makeHolding({ type: 'stock', symbol: 'AAPL', qty: '1', buyPrice: '100', stop: '120' }));
  const none = pf.makeHolding({ type: 'stock', symbol: 'AAPL', qty: '1', buyPrice: '100' });
  assert.equal(none.stop, null);

  const v = pf.value(h, 210);
  assert.equal(v.pnl, 100);
  assert.ok(Math.abs(v.pct - 0.05) < 1e-12);
  assert.equal(pf.totals([h], { 'stock:AAPL': 220 }).pnl, 200);

  let r = pf.checkHolding(h, 189, 'hold');
  assert.deepEqual(r.alerts, ['stop']);
  h.alerted = r.alerted;
  r = pf.checkHolding(h, 188, 'sell');
  assert.deepEqual(r.alerts, ['sell']);
  h.alerted = r.alerted;
  r = pf.checkHolding(h, 200, 'hold');
  assert.deepEqual(r.alerts, []);
  h.alerted = r.alerted;
  assert.deepEqual(pf.checkHolding(h, 186, 'hold').alerts, ['stop']);
  assert.deepEqual(pf.checkHolding(h, 216, 'hold').alerts, ['target']);
});

test('scanner learns weights once and reuses them', async () => {
  const candles = series(300, 0.003, 0.02, 11);
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
  const a = await scanItem(item, '1D', {}, DEFAULT_THRESHOLDS, deps);
  const b = await scanItem(item, '1D', {}, DEFAULT_THRESHOLDS, deps);
  assert.equal(learned, 1);
  assert.ok(Number.isFinite(a.result.atr));
  assert.equal(a.result.score, b.result.score);
});
