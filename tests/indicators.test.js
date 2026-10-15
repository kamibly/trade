import test from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../app/js/indicators.js';

const close = n => n.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 100 }));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma and ema', () => {
  const s = I.sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(s[1]));
  assert.deepEqual(s.slice(2), [2, 3, 4]);
  const e = I.ema([1, 2, 3, 4, 5], 3);
  near(e[2], 2); // seeded with the first average
  near(e[3], 0.5 * 4 + 0.5 * 2);
});

test('rsi is 100 on a straight rise and near 50 on alternating moves', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  near(I.rsi(up).at(-1), 100);
  const zig = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
  const r = I.rsi(zig).at(-1);
  assert.ok(r > 40 && r < 60, String(r));
});

test('macd histogram is positive in a rising series', () => {
  const up = Array.from({ length: 80 }, (_, i) => 100 * 1.01 ** i);
  assert.ok(I.macd(up).hist.at(-1) > 0);
});

test('bollinger bands surround the mean', () => {
  const v = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i));
  const b = I.bollinger(v);
  assert.ok(b.upper.at(-1) > b.mid.at(-1) && b.lower.at(-1) < b.mid.at(-1));
});

test('atr of constant-range candles equals the range', () => {
  const c = close(Array.from({ length: 30 }, (_, i) => [i, 10, 11, 9, 10]));
  near(I.atr(c).at(-1), 2);
});

test('adx shows a strong uptrend with +DI above -DI', () => {
  const c = close(Array.from({ length: 80 }, (_, i) => [i, 100 + i, 101.5 + i, 99.5 + i, 101 + i]));
  const a = I.adx(c);
  assert.ok(a.plusDI.at(-1) > a.minusDI.at(-1));
  assert.ok(a.adx.at(-1) > 40);
});

test('stochastic and williams %R at the top of the range', () => {
  const c = close(Array.from({ length: 20 }, (_, i) => [i, 100 + i, 101 + i, 99 + i, 101 + i]));
  assert.ok(I.stochastic(c).k.at(-1) > 90);
  assert.ok(I.williamsR(c).at(-1) > -10);
});

test('donchian uses the previous candles so a breakout can exceed it', () => {
  const c = close(Array.from({ length: 25 }, (_, i) => [i, 100, i === 24 ? 120 : 101, 99, i === 24 ? 119 : 100]));
  const d = I.donchian(c);
  assert.equal(d.upper.at(-1), 101);
  assert.ok(c.at(-1).close > d.upper.at(-1));
});

test('obv adds volume on up closes and subtracts on down closes', () => {
  const c = close([[0, 1, 1, 1, 1, 10], [1, 1, 2, 1, 2, 5], [2, 2, 2, 1, 1, 3]]);
  assert.deepEqual(I.obv(c), [0, 5, 2]);
});

test('parabolic SAR and supertrend follow a steady rise', () => {
  const c = close(Array.from({ length: 60 }, (_, i) => [i, 100 + i, 101 + i, 99.5 + i, 100.8 + i]));
  assert.equal(I.parabolicSar(c).up.at(-1), true);
  assert.equal(I.supertrend(c).up.at(-1), true);
});

test('fibonacci levels of a rise sit between its low and high', () => {
  const c = close(Array.from({ length: 50 }, (_, i) => [i, 100 + i, 101 + i, 99 + i, 100 + i]));
  const f = I.fibonacci(c, 49, 50);
  assert.equal(f.rising, true);
  near(f.levels[0.5], (f.high + f.low) / 2);
});

test('candle patterns', () => {
  const c = close([[0, 10, 10.5, 8.9, 9], [1, 8.8, 10.6, 8.7, 10.4]]);
  assert.equal(I.candlePattern(c, 1), 'bullish engulfing');
  const h = close([[0, 10, 10, 9, 9.5], [1, 9.5, 9.62, 8, 9.6]]);
  assert.equal(I.candlePattern(h, 1), 'hammer');
});

test('swings find a clear peak and trough', () => {
  const ys = [5, 6, 7, 9, 7, 6, 5, 3, 1, 3, 5, 6, 7];
  const c = close(ys.map((y, i) => [i, y, y + 0.5, y - 0.5, y]));
  const s = I.swings(c, ys.length - 1, 3);
  assert.deepEqual(s.highs, [3]);
  assert.deepEqual(s.lows, [8]);
});
