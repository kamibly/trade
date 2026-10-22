import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeOf, feeRate } from '../app/js/fees.js';
import * as paper from '../app/js/paper.js';

test('IBKR stock fees: $0.005 a share, at least $1, at most 1% of the order; NDAX crypto 0.2%', () => {
  assert.equal(feeOf('stock', 10, 100), 1); // $1,000 order: the $1 minimum
  assert.equal(feeOf('stock', 1000, 1), 5); // 1,000 shares: $5
  assert.equal(feeOf('stock', 0.1, 5), 0.005); // a $0.50 order: 1% cap
  assert.ok(Math.abs(feeOf('crypto', 2, 100) - 0.4) < 1e-9);
  assert.equal(feeRate('crypto'), 0.002);
  assert.equal(feeRate('stock'), 0.001);
});

test('the paper account pays the broker fees on each buy and sell', () => {
  const acc = paper.newAccount(10000, 0);
  const signals = { 'stock:AAA': { symbol: 'AAA', type: 'stock', action: 'buy', entry: 100, stop: 90, take: 130, atr: 5 } };
  paper.step(acc, { signals, now: 1, budgets: paper.PHONE_BUDGETS });
  const p = acc.positions[0];
  assert.ok(Math.abs(p.cost - (p.qty * 100 + 1)) < 1e-9, 'the $1 minimum on the buy');
  paper.step(acc, { signals: { 'stock:AAA': { ...signals['stock:AAA'], action: 'hold', entry: 130 } }, now: 2, budgets: paper.PHONE_BUDGETS });
  const t = acc.trades[0];
  assert.ok(Math.abs(t.pnl - Math.round((p.qty * 130 - 1 - p.cost) * 100) / 100) < 0.011, 'the $1 minimum on the sell');
});
