import test from 'node:test';
import assert from 'node:assert/strict';
import * as paper from '../app/js/paper.js';

const T = 1_700_000_000_000;
const H = 3600;
const bar = (i, open, high, low, close) => ({ time: T / 1000 + i * H, open, high, low, close });
// Up 25 from a $100 buy with a $90 stop and a $130 target, then back to 113.
const candles = [bar(-1, 100, 101, 99, 100), bar(0, 100, 112, 99, 111), bar(1, 111, 125, 110, 124), bar(2, 120, 121, 112, 113)];
const trade = { key: 'crypto:SOL', symbol: 'SOL', type: 'crypto', qty: 1, entry: 100, cost: 100.2, stop0: 90, take0: 130, openedAt: T };

test('what if: each exit replays the same trade on its candles', () => {
  const r = paper.whatIf(trade, candles, { now: T + 10 * H * 1000 });
  // The target was never reached: still held, worth the last close.
  assert.deepEqual([r.target.open, r.target.price, r.target.pnl], [true, 113, 12.57]);
  // The trailing stop followed the $125 high at the $10 risk below it.
  assert.deepEqual([r.trail.open, r.trail.price, r.trail.reason, r.trail.pnl], [false, 115, 'trailing stop', 14.57]);
  // The profit lock kept 69% of the $25 gain.
  assert.deepEqual([r.lock.open, r.lock.price, r.lock.reason, r.lock.pnl], [false, 117.1875, 'profit lock', 16.75]);
});

test('what if: a Sell signal or your own sale ends every version at the same price', () => {
  const closed = { ...trade, closedAt: T + 1.5 * H * 1000, exit: 122, reason: 'sell signal' };
  const r = paper.whatIf(closed, candles, { now: T + 10 * H * 1000 });
  for (const k of paper.EXITS) assert.deepEqual([r[k].open, r[k].price, r[k].reason], [false, 122, 'sell signal']);
});

test('what if needs candles from before the buy and the first stop', () => {
  assert.equal(paper.whatIf(trade, candles.slice(2)), null);
  assert.equal(paper.whatIf({ ...trade, stop0: undefined, edited: true, stop: 95 }, candles), null);
});

test('closed trades keep the stop, target and exit they were bought with', () => {
  const acc = paper.newAccount(1000, T);
  acc.positions.push({ ...trade, stop: 110, take: 130, lock: true, risk: 10, high: 125 });
  paper.sellNow(acc, 'crypto:SOL', 120, T + H * 1000);
  const [t] = acc.trades;
  assert.deepEqual([t.stop0, t.take0, t.sellsAt], [90, 130, 'lock']);
  // Older positions without stop0: the first stop comes from the risk, or the stop itself.
  assert.deepEqual(paper.firstLevels({ entry: 100, stop: 110, take: 130, risk: 10, trail: true }), { stop0: 90, take0: 130 });
  assert.deepEqual(paper.firstLevels({ entry: 100, stop: 92, take: 130 }), { stop0: 92, take0: 130 });
});

test('the server replays its paper trades, falling back to daily candles', async () => {
  const { runWhatIf } = await import('../server/engine.mjs');
  const asked = [];
  const deps = {
    fetchCandles: async (item, tf) => { asked.push(tf); return { candles: tf === '1h' ? candles.slice(2) : candles }; },
    now: () => T + 10 * H * 1000,
  };
  const r = await runWhatIf({ settings: {}, trades: [{ ...trade, id: 'a' }], prices: { 'crypto:SOL': 118 } }, deps);
  assert.deepEqual(asked, ['1h', '1D']);
  assert.equal(r.results.a.target.price, 118);
  assert.equal(r.results.a.lock.reason, 'profit lock');
});
