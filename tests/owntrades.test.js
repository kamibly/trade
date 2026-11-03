import test from 'node:test';
import assert from 'node:assert/strict';
import * as own from '../app/js/owntrades.js';
import * as paper from '../app/js/paper.js';

const DAY = 86400_000;
function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

// Trades whose MACD vote decides whether they win (mostly), one a day.
function history(n, { link = true, seed = 3 } = {}) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const macd = r() < 0.5 ? 1 : -1;
    const win = link ? (macd > 0 ? r() < 0.8 : r() < 0.2) : r() < 0.5;
    const why = { score: 30, votes: [['macd', 'MACD', 'trend', macd, 1], ['rsi', 'RSI', 'momentum', r() < 0.5 ? 1 : -1, 1]] };
    return { key: `stock:S${i}`, symbol: `S${i}`, type: 'stock', setup: 'scan', openedAt: i * DAY, closedAt: i * DAY + DAY / 2, pnl: win ? 10 : -10, why,
      own: { x: own.compact(own.inputsOf({ why, filter: null, type: 'stock', setup: 'scan', mood: 0 })) } };
  });
}

test('inputs: votes, score, filter, kind, source and mood; opportunities skip the votes', () => {
  const why = { score: 40, votes: [['macd', 'MACD', 'trend', 0.5, 1]] };
  const x = own.inputsOf({ why, filter: { p: 0.6 }, type: 'crypto', setup: 'signal', mood: 0.1 });
  assert.equal(x['vote:macd'], 0.5);
  assert.equal(x.score, 0.4);
  assert.ok(Math.abs(x.filter - 0.1) < 1e-9);
  assert.equal(x.hasFilter, 1);
  assert.equal(x.crypto, 1);
  assert.equal(x['from:alerts'], 1);
  assert.equal(x.mood, 0.1);
  const o = own.inputsOf({ why, filter: null, type: 'stock', setup: 'dip', mood: NaN });
  assert.equal(o['vote:macd'], 0);
  assert.equal(o['from:opportunities'], 1);
  assert.deepEqual(own.compact(o), { 'from:opportunities': 1 });
});

test('size: 1 + 2 × (chance − usual win rate), within ×0.5 and ×1.5; both sizes within ×0.25 and ×2', () => {
  assert.ok(Math.abs(own.sizeFor(0.62, 0.47) - 1.3) < 1e-9);
  assert.ok(Math.abs(own.sizeFor(0.40, 0.47) - 0.86) < 1e-9);
  assert.equal(own.sizeFor(0.99, 0.2), 1.5);
  assert.equal(own.sizeFor(0.01, 0.8), 0.5);
  assert.equal(own.bothSizes(1.2, { size: 1.3, used: false }), 1.2);
  assert.equal(own.bothSizes(NaN, { size: 1.3, used: true }), 1.3);
  assert.ok(Math.abs(own.bothSizes(1.2, { size: 1.3, used: true }) - 1.56) < 1e-9);
  assert.equal(own.bothSizes(1.5, { size: 1.5, used: true }), 2);
  assert.equal(own.bothSizes(0.5, { size: 0.5, used: true }), 0.25);
});

test('fit learns a real link, passes the fair test and judges each trade only on earlier ones', () => {
  const trades = history(80);
  const out = own.fit({ trades });
  assert.equal(out.trades, 80);
  assert.equal(out.judged, 80 - own.TRAIN_MIN);
  assert.ok(out.extra > 0);
  assert.equal(out.qualified, true);
  assert.equal(out.top[0][0], 'vote:macd');
  assert.ok(out.top[0][1] > 0);
  const up = own.chance(out.model, { 'vote:macd': 1, score: 0.3, 'from:ideas': 1 });
  const down = own.chance(out.model, { 'vote:macd': -1, score: 0.3, 'from:ideas': 1 });
  assert.ok(up > 0.6 && down < 0.4, `${up} ${down}`);
  // The first trades have too little before them to be judged.
  assert.equal(out.preds[own.tradeId(trades[own.TRAIN_MIN - 1])], undefined);
  assert.ok(out.preds[own.tradeId(trades[own.TRAIN_MIN])]);
});

test('fit does not qualify on noise or with too few judged trades', () => {
  const noise = own.fit({ trades: history(80, { link: false, seed: 13 }) });
  assert.equal(noise.qualified, false);
  const few = own.fit({ trades: history(35) });
  assert.equal(few.judged, 25);
  assert.equal(few.qualified, false);
});

test('fit: what-if exits and shadow trades add rows, rebuilt inputs count, unknown trades are left out', () => {
  const trades = history(20);
  const plain = own.fit({ trades });
  const id = own.tradeId(trades[0]);
  const withExits = own.fit({ trades, whatIf: { [id]: { target: { pnl: 5, open: false, at: 1 }, trail: { pnl: -3, open: false, at: 1 }, lock: { pnl: 1, open: true } } } });
  assert.notDeepEqual(withExits.model.w, plain.model.w);
  const shadowOnly = { ...history(1, { seed: 5 })[0], key: 'stock:SH', openedAt: 3 * DAY, closedAt: 4 * DAY };
  const withShadow = own.fit({ trades, shadowTrades: [shadowOnly, trades[1]] });
  assert.equal(withShadow.trades, 20);
  assert.notDeepEqual(withShadow.model.w, plain.model.w);
  const bare = trades.map(({ own: _, ...t }) => t);
  assert.equal(own.fit({ trades: bare }).model, null);
  const rebuilt = own.fit({ trades: bare, inputs: Object.fromEntries(trades.map(t => [own.tradeId(t), t.own.x])) });
  assert.deepEqual(rebuilt.model.w, plain.model.w);
});

test('a resized trade is judged on the result it would have had without the model', () => {
  const trades = history(60);
  const base = own.fit({ trades });
  const resized = trades.map(t => ({ ...t, pnl: t.pnl * 1.5, own: { ...t.own, used: true, mult: 1.5 } }));
  assert.ok(Math.abs(own.fit({ trades: resized }).extra - base.extra) < 1e-6);
});

test('paper buys keep the inputs, record the view while learning and multiply sizes once it qualified', () => {
  const state = own.fit({ trades: history(80) });
  const good = { score: 30, votes: [['macd', 'MACD', 'trend', 1, 1]] };
  const idea = (symbol, extra) => ({ id: `scan:stock:${symbol}:1`, setup: 'scan', key: `stock:${symbol}`, symbol, type: 'stock', entry: 100, stop: 90, take: 115, ev: 0.5, why: good, ...extra });
  const opts = { riskPct: 5, now: 1, useFilter: true };

  const none = paper.newAccount(10_000, 0);
  paper.openSetups(none, [idea('AAA')], opts);
  assert.ok(none.positions[0].own.x['vote:macd'] === 1 && !('p' in none.positions[0].own));

  const learning = paper.newAccount(10_000, 0);
  paper.openSetups(learning, [idea('AAA'), idea('BBB', { why: null })], { ...opts, own: { model: state.model, qualified: false } });
  const [a, b] = ['AAA', 'BBB'].map(s => learning.positions.find(p => p.symbol === s));
  assert.ok(a.own.p > 0.5 && a.own.used === false);
  assert.ok(Math.abs(a.qty / b.qty - 1) < 0.02, 'learning: sizes unchanged');

  const live = paper.newAccount(10_000, 0);
  paper.openSetups(live, [idea('AAA', { filter: { p: 0.7, ev: 0.03, size: 1.2 } }), idea('BBB', { why: null })], { ...opts, own: { model: state.model, qualified: true } });
  const [x, y] = ['AAA', 'BBB'].map(s => live.positions.find(p => p.symbol === s));
  assert.equal(x.own.used, true);
  const want = Math.min(2, 1.2 * x.own.size) / y.own.size;
  assert.ok(Math.abs(x.qty / y.qty - want) < 0.03, `${x.qty / y.qty} vs ${want}`);
  assert.ok(Math.abs(x.own.mult - Math.min(2, 1.2 * x.own.size) / 1.2) < 1e-3);
  // The trade keeps it when it closes.
  paper.sellNow(live, 'stock:AAA', 110, 2);
  assert.equal(live.trades[0].own.used, true);
});

test('runOwnTrades rebuilds missing inputs from the daily chart and the market mood', async () => {
  const { runOwnTrades } = await import('../server/engine.mjs');
  let p = 100;
  const candles = Array.from({ length: 300 }, (_, i) => { const o = p; p *= 1 + Math.sin(i / 9) * 0.01; return { time: i * 86400, open: o, close: p, high: Math.max(o, p) * 1.01, low: Math.min(o, p) * 0.99, volume: 1000 }; });
  const asked = [];
  const deps = { fetchCandles: async item => { asked.push(item.symbol); return { candles }; }, yahooCandles: async item => { asked.push(item.symbol); return { candles }; }, now: () => 1 };
  const trades = history(15).map(({ own: _, why, ...t }, i) => ({ ...t, key: 'stock:AAA', symbol: 'AAA', openedAt: (250 + i) * DAY, closedAt: (250 + i) * DAY + 1 }));
  trades[0].setup = 'dip';
  const r = await runOwnTrades({ settings: {}, trades, positions: [{ ...trades[1], openedAt: 299 * DAY }] }, deps);
  assert.ok(asked.includes('SPY') && asked.includes('AAA'));
  const x = r.inputs[own.tradeId(trades[1])];
  assert.ok(Object.keys(x).some(k => k.startsWith('vote:')));
  assert.ok('mood' in x);
  assert.ok(!Object.keys(r.inputs[own.tradeId(trades[0])]).some(k => k.startsWith('vote:')), 'opportunities: no votes');
  assert.equal(r.state.trades, 15);
  assert.ok(r.state.preds[`stock:AAA:${299 * DAY}`]);
});
