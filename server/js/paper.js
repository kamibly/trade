// Paper trading: a pretend account that follows the app's own buy and sell
// signals with fake money, so you can see how they would have done before
// trusting them with real money. Long only, no leverage, prices in USD.

import { FEE } from './backtest.js';

export const DEFAULT_START = 10_000;
export const MAX_POSITIONS = 10;
const DAY_MS = 86400_000;

const ok = Number.isFinite;
const round2 = v => Math.round(v * 100) / 100;

export function newAccount(start = DEFAULT_START, now = Date.now()) {
  return { start, cash: start, createdAt: now, positions: [], trades: [], history: [{ t: now, equity: start }] };
}

// Size so that hitting the stop loses `riskPct` of equity, capped at 20% of
// equity per position and at the cash on hand.
export function positionSize({ equity, cash, entry, stop, riskPct = 1 }) {
  const perUnit = entry - stop;
  if (!(entry > 0) || !(perUnit > 0) || !(cash > 0)) return 0;
  const byRisk = (equity * riskPct) / 100 / perUnit;
  const byCap = (equity * 0.2) / entry;
  const byCash = cash / (entry * (1 + FEE));
  return Math.max(0, Math.min(byRisk, byCap, byCash));
}

export function equity(acc, prices = {}) {
  return acc.cash + acc.positions.reduce((sum, p) => sum + p.qty * (ok(prices[p.key]) ? prices[p.key] : p.entry), 0);
}

function closePosition(acc, p, price, reason, now) {
  const value = p.qty * price * (1 - FEE);
  acc.cash = round2(acc.cash + value);
  const pnl = value - p.cost;
  acc.trades.push({ key: p.key, symbol: p.symbol, type: p.type, qty: p.qty, entry: p.entry, exit: price, openedAt: p.openedAt, closedAt: now, pnl: round2(pnl), ret: pnl / p.cost, reason, setup: setupOf(p) });
  acc.positions = acc.positions.filter(x => x !== p);
  return { kind: 'close', symbol: p.symbol, key: p.key, price, pnl: round2(pnl), reason, setup: setupOf(p) };
}

// What opened a position: 'signal' (a Buy signal) or an opportunity setup.
export const setupOf = p => p.setup || 'signal';

function open(acc, s, { key, riskPct, now, prices, setup, until, id }) {
  const qty = positionSize({ equity: equity(acc, prices), cash: acc.cash, entry: s.entry, stop: s.stop, riskPct });
  const cost = qty * s.entry * (1 + FEE);
  if (cost < 1) return null;
  acc.cash = round2(acc.cash - cost);
  acc.positions.push({ key, symbol: s.symbol, type: s.type, qty, entry: s.entry, stop: s.stop, take: s.take, cost, openedAt: now, setup, ...(until ? { until } : {}), ...(id ? { id } : {}) });
  return { kind: 'open', symbol: s.symbol, key, price: s.entry, qty, cost: round2(cost), setup };
}

// One step after a scan. `signals` maps key → { symbol, type, action, entry, stop, take },
// `alerts` maps key → 'buy' | 'sell' for actions that just changed this scan.
// Returns the events (paper buys and sells) and updates `acc` in place.
export function step(acc, { signals, alerts = {}, riskPct = 1, now = Date.now() }) {
  const events = [];
  const prices = Object.fromEntries(Object.entries(signals).map(([k, s]) => [k, s.entry]));
  // Exits first so the freed cash can fund new buys.
  for (const p of [...acc.positions]) {
    const s = signals[p.key];
    if (!s || !ok(s.entry)) continue;
    if (s.entry <= p.stop) events.push(closePosition(acc, p, s.entry, 'stop', now));
    else if (s.entry >= p.take) events.push(closePosition(acc, p, s.entry, 'target', now));
    // Opportunity trades keep to their own plan: stop, target or time.
    else if (p.until && now >= p.until) events.push(closePosition(acc, p, s.entry, 'time', now));
    else if (s.action === 'sell' && setupOf(p) === 'signal') events.push(closePosition(acc, p, s.entry, 'sell signal', now));
  }
  for (const [key, action] of Object.entries(alerts)) {
    const s = signals[key];
    if (action !== 'buy' || !s || acc.positions.some(p => p.key === key) || acc.positions.length >= MAX_POSITIONS) continue;
    const ev = open(acc, s, { key, riskPct, now, prices, setup: 'signal' });
    if (ev) events.push(ev);
  }
  mark(acc, prices, now);
  return events;
}

// Opens paper trades for the market scan's opportunities, best expected
// result first, up to MAX_POSITIONS open at once. Each opportunity is taken
// once; it is sold at its stop, its target or after its holding period
// (trading days for stocks, calendar days for crypto).
// opportunities: [{ id, setup, key, symbol, type, entry, stop, take, hold, ev }]
export function openSetups(acc, opportunities, { riskPct = 1, now = Date.now() } = {}) {
  const events = [];
  acc.taken ||= [];
  const prices = {};
  const list = [...opportunities].sort((a, b) => (b.ev || 0) - (a.ev || 0));
  for (const o of list) {
    if (acc.positions.length >= MAX_POSITIONS) break;
    if (acc.taken.includes(o.id) || acc.positions.some(p => p.key === o.key)) continue;
    if (!(o.entry > 0) || !(o.stop < o.entry)) continue;
    const days = o.type === 'stock' ? o.hold * (7 / 5) : o.hold;
    const ev = open(acc, o, { key: o.key, riskPct, now, prices, setup: o.setup, until: now + Math.round(days * DAY_MS), id: o.id });
    acc.taken.push(o.id);
    if (ev) events.push(ev);
  }
  if (acc.taken.length > 300) acc.taken.splice(0, acc.taken.length - 300);
  if (events.length) mark(acc, prices, now);
  return events;
}

function mark(acc, prices, now) {
  const last = acc.history[acc.history.length - 1];
  const value = round2(equity(acc, prices));
  // One point per hour at most keeps the history small.
  if (!last || now - last.t >= 3600_000) acc.history.push({ t: now, equity: value });
  else last.equity = value;
  if (acc.history.length > 2000) acc.history.splice(0, acc.history.length - 2000);
}

export function summary(acc, prices = {}) {
  const value = equity(acc, prices);
  let peak = acc.start;
  let maxDrawdown = 0;
  for (const h of [...acc.history, { equity: value }]) {
    peak = Math.max(peak, h.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - h.equity / peak);
  }
  const wins = acc.trades.filter(t => t.pnl > 0).length;
  return {
    equity: value,
    totalReturn: value / acc.start - 1,
    trades: acc.trades.length,
    winRate: acc.trades.length ? wins / acc.trades.length : NaN,
    maxDrawdown,
  };
}

// Results per setup for the Paper tab: trades, win rate, return on the
// starting amount and the worst drop of that setup's running result.
export function bySetup(acc) {
  const groups = new Map();
  for (const t of [...acc.trades].sort((a, b) => a.closedAt - b.closedAt)) {
    const id = t.setup || 'signal';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(t);
  }
  const open = new Map();
  for (const p of acc.positions) open.set(setupOf(p), (open.get(setupOf(p)) || 0) + 1);
  for (const id of open.keys()) if (!groups.has(id)) groups.set(id, []);
  return [...groups].map(([setup, trades]) => {
    let run = 0;
    let peak = 0;
    let worst = 0;
    for (const t of trades) {
      run += t.pnl;
      peak = Math.max(peak, run);
      worst = Math.max(worst, (peak - run) / (acc.start + peak));
    }
    const wins = trades.filter(t => t.pnl > 0).length;
    return { setup, trades: trades.length, open: open.get(setup) || 0, winRate: trades.length ? wins / trades.length : NaN, ret: run / acc.start, maxDrawdown: worst };
  });
}
