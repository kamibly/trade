import test from 'node:test';
import assert from 'node:assert/strict';
import * as paper from '../app/js/paper.js';
import { breakdown, scoreParts, scoreVotes } from '../app/js/signals.js';

const votes = [
  { id: 'macd', name: 'MACD', group: 'trend', vote: 0.6 },
  { id: 'adx', name: 'ADX', group: 'trend', vote: -0.2 },
  { id: 'rsi', name: 'RSI', group: 'momentum', vote: 1 },
  { id: 'obv', name: 'OBV', group: 'volume', vote: -1 },
];
const weights = { macd: 1.4, adx: 0, rsi: 1, obv: 0 };

test('score parts add up to the score, group by group', () => {
  const b = breakdown({ score: scoreVotes(votes, weights), rule: { buy: 40, sell: -40 }, time: 1, votes }, weights);
  const parts = scoreParts(b.votes.map(([id, name, group, vote, weight]) => ({ id, name, group, vote, weight })));
  // Volume's only method has weight 0, so two groups count: each adds up to 50.
  assert.equal(parts.groups, 2);
  assert.equal(Math.round(parts.score * 10) / 10, b.score);
  assert.deepEqual(parts.parts.map(p => [p.group, Math.round(p.adds)]), [['trend', 30], ['momentum', 50], ['volume', 0]]);
});

test('a paper trade keeps why it bought, and why it sold on a Sell', () => {
  const why = { score: 45, rule: { buy: 40, sell: -40 }, votes: [] };
  const acc = paper.newAccount(10000, 0);
  const buy = { 'stock:AAPL': { symbol: 'AAPL', type: 'stock', action: 'buy', score: 45, entry: 100, stop: 90, take: 130, atr: 5, why } };
  paper.step(acc, { signals: buy, now: 1 });
  assert.deepEqual(acc.positions[0].why, why);
  const sold = { score: -50, rule: { buy: 40, sell: -40 }, votes: [] };
  paper.step(acc, { signals: { 'stock:AAPL': { ...buy['stock:AAPL'], action: 'sell', entry: 101, why: sold } }, now: 2 });
  assert.deepEqual([acc.trades[0].why, acc.trades[0].whySold, acc.trades[0].reason], [why, sold, 'sell signal']);
});
