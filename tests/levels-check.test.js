import test from 'node:test';
import assert from 'node:assert/strict';
import { playOut, levelsAt, tradesOf, summarize, show } from '../server/levels_check.mjs';
import { analyze } from '../app/js/signals.js';

// A wavy random walk, so there are swing highs and lows to find.
function chart(n = 700, seed = 3) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const candles = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = Math.max(5, p * (1 + 0.02 * r() + 0.01 * Math.sin(i / 9)));
    candles.push({ time: 86400 * (20000 + i), open, high: Math.max(open, p) * (1 + Math.abs(r()) * 0.01), low: Math.min(open, p) * (1 - Math.abs(r()) * 0.01), close: p, volume: 1e6 * (1 + r()) });
  }
  return analyze(candles);
}

test('playOut stops, takes or times out with fees', () => {
  const S = { close: [100, 100, 100], candles: [{}, { open: 100, high: 101, low: 94 }, {}] };
  S.close.length = 40;
  S.candles.length = 40;
  for (let j = 2; j < 40; j++) { S.candles[j] = { open: 100, high: 100, low: 100 }; S.close[j] = 100; }
  const stopped = playOut(S, 0, 95, 110, 'stock');
  assert.equal(stopped.win, 0);
  assert.ok(stopped.ret < -0.05);
  S.candles[1] = { open: 100, high: 111, low: 99 };
  assert.equal(playOut(S, 0, 95, 110, 'stock').win, 1);
});

test('levels sit on either side of the close and the table builds', () => {
  const S = chart();
  const i = 400;
  const { sup, res } = levelsAt(S, i);
  if (Number.isFinite(sup)) assert.ok(sup < S.close[i]);
  if (Number.isFinite(res)) assert.ok(res > S.close[i]);
  const trades = tradesOf(S, 'stock');
  assert.ok(trades.some(t => t.row === 'fixed'));
  for (const t of trades.filter(t => t.row === 'levels 2:1')) assert.ok(t.risk > 0);
  const s = summarize(trades);
  assert.equal(typeof s.passes, 'boolean');
  assert.match(show('Stocks', s), /levels 2:1/);
});
