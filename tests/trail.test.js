import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THRESHOLDS } from '../app/js/signals.js';
import { simulate } from '../app/js/backtest.js';
import * as paper from '../app/js/paper.js';

test('trailing stop waits for half the risk, then breaks even and follows the high', () => {
  const base = { entry: 100, stop: 90, risk: 10, floor: 100.2 };
  assert.equal(paper.trailStop({ ...base, high: 104 }), 90);
  assert.equal(paper.trailStop({ ...base, high: 106 }), 100.2);
  assert.equal(paper.trailStop({ ...base, high: 120 }), 110);
  // It never moves down.
  assert.equal(paper.trailStop({ ...base, stop: 110, high: 112 }), 110);
});

test('simulate with a trailing stop rides past the target and sells on the trail', () => {
  const bar = (time, open, high, low, close) => ({ time, open, high, low, close, volume: 0 });
  const candles = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 106, 101, 104),
    bar(3, 105, 115, 104, 112), bar(4, 110, 110, 104, 104), bar(5, 104, 104, 104, 104)];
  const S = { candles, close: candles.map(c => c.close), atr: candles.map(() => 5) };
  const scores = [NaN, 50, 0, 0, 0, 0];
  const opts = { thresholds: DEFAULT_THRESHOLDS, stopAtr: 2, takeAtr: 3 };
  const fixed = simulate(S, scores, 0, 6, opts);
  assert.equal(fixed.trades[0].reason, 'target');
  assert.equal(fixed.trades[0].exit, 115);
  const trailed = simulate(S, scores, 0, 6, { ...opts, trail: true });
  assert.equal(trailed.trades.length, 1);
  assert.equal(trailed.trades[0].reason, 'trailing stop');
  assert.equal(trailed.trades[0].exit, 105);
});

test('paper trades trail when asked; opportunities keep their target', () => {
  const acc = paper.newAccount(10000, 0);
  const idea = (setup, key) => ({ id: `${setup}:${key}`, setup, key, symbol: key, type: 'crypto', entry: 100, stop: 90, take: 115 });
  paper.openSetups(acc, [idea('scan', 'crypto:A'), idea('insider', 'crypto:B')], { now: 1, trail: true });
  const a = acc.positions.find(p => p.key === 'crypto:A');
  const b = acc.positions.find(p => p.key === 'crypto:B');
  assert.ok(a && a.trail && a.risk === 10);
  assert.ok(b && !b.trail);
  const step = price => paper.step(acc, { signals: { 'crypto:A': { symbol: 'A', type: 'crypto', action: 'hold', entry: price } }, now: 2 });
  step(106);
  assert.ok(a.stop > 100 && a.stop < 101, `stop ${a.stop}`);
  assert.equal(step(120).length, 0, 'no sale at the target');
  assert.equal(a.stop, 110);
  const ev = step(109);
  assert.equal(ev[0].reason, 'trailing stop');
  assert.ok(ev[0].pnl > 0);
});

test('you can turn trailing on for a trade, and its stop may then pass the target', () => {
  const acc = paper.newAccount(10000, 0);
  paper.openSetups(acc, [{ id: 's:A', setup: 'scan', key: 'crypto:A', symbol: 'A', type: 'crypto', entry: 100, stop: 90, take: 115 }], { now: 1 });
  assert.equal(paper.setLevels(acc, 'crypto:A', { stop: 120, take: 115 }), null);
  const ev = paper.setLevels(acc, 'crypto:A', { stop: 95, take: 115, trail: true });
  assert.equal(ev.trail, true);
  assert.equal(acc.positions[0].risk, 5);
  assert.ok(paper.setLevels(acc, 'crypto:A', { stop: 120, take: 115 }));
  assert.equal(paper.setLevels(acc, 'crypto:A', { stop: 95, take: 115, trail: false }).trail, false);
});

test('a source keeps buying until its share of the money is used, up to 10 trades', () => {
  // $1,000 account: a 25% stop limits each opportunity to $40 (a $10 loss), under its $80 slot.
  const acc = paper.newAccount(1000, 0);
  const opp = k => ({ id: `insider:crypto:C${k}:1`, setup: 'insider', key: `crypto:C${k}`, symbol: `C${k}`, type: 'crypto', entry: 100, stop: 75, take: 150, hold: 10, ev: 0.1 - k / 1000 });
  paper.openSetups(acc, Array.from({ length: 12 }, (_, k) => opp(k)), { now: 1 });
  assert.equal(acc.positions.length, 10, 'stops at 10 trades');
  assert.ok(acc.positions.every(p => p.cost <= 40.5));
  // Without the risk limit, the trades fill the 40% share and stop there.
  const big = paper.newAccount(1000, 0);
  const wide = k => ({ ...opp(k), stop: 99 });
  paper.openSetups(big, Array.from({ length: 12 }, (_, k) => wide(k)), { now: 1 });
  const spent = big.positions.reduce((t, p) => t + p.cost, 0);
  assert.equal(big.positions.length, 5);
  assert.ok(spent <= 400.01 && spent > 390, `spent ${spent}`);
  assert.match(big.skips['crypto:C11'], /full/);
});

test('crypto paper buys only coins the exchange sells, when its list is known', () => {
  const acc = paper.newAccount(1000, 0);
  const sig = (symbol, type = 'crypto') => ({ symbol, type, action: 'buy', entry: 100, stop: 90, take: 130, atr: 5 });
  const signals = { 'crypto:AAA': sig('AAA'), 'crypto:ZZZ': sig('ZZZ'), 'stock:SSS': sig('SSS', 'stock') };
  paper.step(acc, { signals, now: 1, budgets: paper.PHONE_BUDGETS, tradable: ['AAA'] });
  assert.deepEqual(acc.positions.map(p => p.symbol).sort(), ['AAA', 'SSS']);
  assert.equal(acc.skips['crypto:ZZZ'], 'NDAX does not sell this coin');
  const any = paper.newAccount(1000, 0);
  paper.step(any, { signals, now: 1, budgets: paper.PHONE_BUDGETS, tradable: null });
  assert.equal(any.positions.length, 3);
});

test('profit lock: break even at half the risk, then half to three quarters of the best gain', () => {
  const base = { entry: 100, stop: 90, risk: 10, take: 130, floor: 100.4 };
  assert.equal(paper.lockStop({ ...base, high: 104 }), 90); // not up enough yet
  assert.equal(paper.lockStop({ ...base, high: 106 }), 100.4); // break even after fees
  assert.equal(paper.lockStop({ ...base, high: 110 }), 105); // up the full risk: keeps half of $10
  assert.equal(paper.lockStop({ ...base, high: 130 }), 122.5); // at the target: three quarters of $30
  assert.equal(paper.lockStop({ ...base, high: 120 }), 100 + 0.625 * 20); // halfway between
  assert.equal(paper.lockStop({ ...base, stop: 112, high: 110 }), 112); // never lowers the stop
});

test('the paper account locks profit on opportunities too, and keeps the target', () => {
  const acc = paper.newAccount(10000, 0);
  const opp = { id: 'o1', setup: 'ranking', key: 'crypto:AAA', symbol: 'AAA', type: 'crypto', entry: 100, stop: 90, take: 130, hold: 30, ev: 1 };
  paper.openSetups(acc, [opp], { now: 1, lock: true, trail: true });
  const p = acc.positions[0];
  assert.ok(p.lock && !p.trail, 'opportunities lock; they never trail');
  const price = (entry, now) => paper.step(acc, { signals: { 'crypto:AAA': { symbol: 'AAA', type: 'crypto', entry } }, now });
  price(120, 2);
  assert.equal(p.stop, 112.5);
  const [ev] = price(112, 3);
  assert.equal(ev.reason, 'profit lock');
  assert.ok(acc.trades[0].pnl > 0, 'sold with a gain instead of riding back down');
});

test('the backtest shows the profit lock next to the target and the trailing stop', () => {
  const c = [];
  for (let i = 0; i < 40; i++) {
    const close = i < 10 ? 100 : i < 20 ? 100 + (i - 9) * 2 : 120 - (i - 19) * 2;
    c.push({ time: i, open: close, high: close + 0.5, low: close - 0.5, close, volume: 1 });
  }
  const S = { candles: c, close: c.map(x => x.close), atr: c.map(() => 5) };
  const scores = c.map((_, i) => (i === 9 ? 90 : 0));
  const target = simulate(S, scores, 0, 40, { stopAtr: 2, takeAtr: 6 });
  const locked = simulate(S, scores, 0, 40, { stopAtr: 2, takeAtr: 6, lock: true });
  assert.equal(locked.trades[0].reason, 'profit lock');
  assert.ok(locked.totalReturn > target.totalReturn, 'it kept part of the rise the target-only trade gave back');
});
