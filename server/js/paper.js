// Paper trading: a pretend account that follows the app's own buy and sell
// signals with fake money, so you can see how they would have done before
// trusting them with real money. Long only, no leverage, prices in USD.

import { feeOf } from './fees.js';

export const DEFAULT_START = 10_000;
// Each source of trades has its own share of the account and its own
// positions, so none can crowd out the others and the By setup table compares
// them fairly. Without a server the phone trades only its alerts.
export const BUDGETS = {
  opportunities: { share: 0.4, max: 5, name: 'Opportunities' },
  stockIdeas: { share: 0.2, max: 5, name: 'Stock buy ideas' },
  cryptoIdeas: { share: 0.2, max: 5, name: 'Crypto buy ideas' },
  alerts: { share: 0.2, max: 5, name: 'Watchlist alerts' },
};
// The budgets with the server's current shares (they follow each source's results).
export function budgetsWith(shares) {
  if (!shares) return BUDGETS;
  return Object.fromEntries(Object.entries(BUDGETS).map(([k, b]) => [k, { ...b, share: Number.isFinite(shares[k]) ? shares[k] : b.share }]));
}
export const PHONE_BUDGETS = { alerts: { share: 1, max: 10, name: 'Watchlist alerts' } };
export const MAX_POSITIONS = Object.values(BUDGETS).reduce((n, b) => n + b.max, 0);
const DAY_MS = 86400_000;

const ok = Number.isFinite;
const round2 = v => Math.round(v * 100) / 100;

// Trailing stop: once the price is up half the trade's risk (1 ATR with a
// 2 ATR stop), the stop rises to break even after fees (`floor`), then
// follows the highest price at the trade's risk below it. No fixed target.
// risk = entry − the first stop. Returns the new stop (never below `stop`).
export function trailStop({ entry, stop, risk, high, floor }) {
  if (!(risk > 0) || !(high >= entry + risk / 2)) return stop;
  return Math.max(stop, floor, high - risk);
}

// Whether a trade trails: market scan ideas and watchlist Buys can;
// opportunities keep their own plan.
const canTrail = x => !x.setup || x.setup === 'signal' || x.setup === 'scan';

export function newAccount(start = DEFAULT_START, now = Date.now()) {
  return { start, cash: start, createdAt: now, positions: [], trades: [], history: [{ t: now, equity: start }] };
}

// Size so that hitting the stop loses `riskPct` of equity, capped at `cap`
// of equity per position (20%, or the budget's equal slot) and at the cash on hand.
export function positionSize({ equity, cash, entry, stop, riskPct = 1, cap = 0.2, type = 'stock' }) {
  const perUnit = entry - stop;
  if (!(entry > 0) || !(perUnit > 0) || !(cash > 0)) return 0;
  const byRisk = (equity * riskPct) / 100 / perUnit;
  const byCap = (equity * cap) / entry;
  // All the cash less the buy's fee (a stock's $1 minimum, or crypto's 0.4%).
  const all = cash / entry;
  const byCash = (cash - feeOf(type, all, entry)) / entry;
  return Math.max(0, Math.min(byRisk, byCap, byCash));
}

export function equity(acc, prices = {}) {
  return acc.cash + acc.positions.reduce((sum, p) => sum + p.qty * (ok(prices[p.key]) ? prices[p.key] : p.entry), 0);
}

function closePosition(acc, p, price, reason, now) {
  const value = p.qty * price - feeOf(p.type, p.qty, price);
  acc.cash = round2(acc.cash + value);
  const pnl = value - p.cost;
  acc.trades.push({ key: p.key, symbol: p.symbol, type: p.type, qty: p.qty, entry: p.entry, cost: p.cost, exit: price, openedAt: p.openedAt, closedAt: now, pnl: round2(pnl), ret: pnl / p.cost, reason, setup: setupOf(p), ...(p.filter ? { filter: p.filter } : {}) });
  acc.positions = acc.positions.filter(x => x !== p);
  return { kind: 'close', symbol: p.symbol, key: p.key, price, pnl: round2(pnl), reason, setup: setupOf(p) };
}

// What opened a position: 'signal' (a Buy signal) or an opportunity setup.
export const setupOf = p => p.setup || 'signal';

// Which budget a trade or idea draws on.
export function bucketOf(x) {
  const setup = x.setup || 'signal';
  if (setup === 'signal') return 'alerts';
  if (setup === 'scan') return x.type === 'crypto' ? 'cryptoIdeas' : 'stockIdeas';
  return 'opportunities';
}

// Room for one more position in this idea's budget: { cap } or null when full.
function room(acc, x, budgets) {
  const b = budgets[bucketOf(x)];
  if (!b) return null;
  const used = acc.positions.filter(p => bucketOf(p) === bucketOf(x)).length;
  return used < b.max ? { cap: Math.min(0.2, b.share / b.max) } : null;
}

// The trade filter's say on an idea (see filter.js): null when it has none
// (switched off, not trained, or an opportunity, which keeps its own gate).
const filterOf = (o, useFilter) => (useFilter && o.filter && Number.isFinite(o.filter.size) ? o.filter : null);

function open(acc, s, { key, riskPct, now, prices, setup, until, id, cap, filter, trail }) {
  const qty = positionSize({ equity: equity(acc, prices), cash: acc.cash, entry: s.entry, stop: s.stop, riskPct, cap, type: s.type });
  const cost = qty * s.entry + feeOf(s.type, qty, s.entry);
  // Under $10 the fees outweigh the trade.
  if (!(qty > 0) || cost < 10 || cost > acc.cash + 0.005) return null;
  acc.cash = round2(acc.cash - cost);
  acc.positions.push({ key, symbol: s.symbol, type: s.type, qty, entry: s.entry, stop: s.stop, take: s.take, cost, openedAt: now, setup, ...(until ? { until } : {}), ...(id ? { id } : {}), ...(filter ? { filter } : {}), ...(trail ? { trail: true, risk: s.entry - s.stop, high: s.entry } : {}) });
  return { kind: 'open', symbol: s.symbol, key, price: s.entry, qty, cost: round2(cost), setup };
}

// One step after a scan. `signals` maps key → { symbol, type, action, entry, stop, take },
// `alerts` maps key → 'buy' | 'sell' for actions that just changed this scan.
// Returns the events (paper buys and sells) and updates `acc` in place.
export function step(acc, { signals, alerts = {}, riskPct = 1, now = Date.now(), budgets = BUDGETS, useFilter = true, trail = false }) {
  const events = [];
  const prices = Object.fromEntries(Object.entries(signals).map(([k, s]) => [k, s.entry]));
  // Exits first so the freed cash can fund new buys.
  for (const p of [...acc.positions]) {
    const s = signals[p.key];
    if (!s || !ok(s.entry)) continue;
    if (p.trail) follow(p, s.entry);
    if (s.entry <= p.stop) events.push(closePosition(acc, p, s.entry, p.trail && p.stop > p.entry ? 'trailing stop' : 'stop', now));
    else if (!p.trail && s.entry >= p.take) events.push(closePosition(acc, p, s.entry, 'target', now));
    // Opportunity trades keep to their own plan: stop, target or time.
    else if (p.until && now >= p.until) events.push(closePosition(acc, p, s.entry, 'time', now));
    else if (s.action === 'sell' && setupOf(p) === 'signal') events.push(closePosition(acc, p, s.entry, 'sell signal', now));
  }
  // Watchlist Buys: not only a new Buy, but any current Buy the account
  // doesn't hold yet, while the price is within 1 ATR of where the Buy began.
  // Each Buy is bought once. (`alerts` only adds Buys a caller knows are new.)
  acc.signalStarts ||= {};
  acc.taken ||= [];
  for (const [key, sig] of Object.entries(signals)) {
    if (!sig.action) continue; // a price check, not a scored signal
    if (sig.action === 'buy' || alerts[key] === 'buy') acc.signalStarts[key] ||= { at: now, entry: sig.entry };
    else delete acc.signalStarts[key];
  }
  const buys = Object.entries(signals)
    .filter(([key, sig]) => sig.action === 'buy' || alerts[key] === 'buy')
    .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));
  for (const [key, sig] of buys) {
    const start = acc.signalStarts[key];
    const id = `signal:${key}:${start.at}`;
    const idea = { ...sig, id, key, setup: 'signal', ranAway: ok(sig.atr) && sig.entry > start.entry + sig.atr };
    const ev = tryOpen(acc, idea, { riskPct, now, prices, budgets, useFilter, trail });
    if (ev) events.push(ev);
  }
  pruneTaken(acc);
  mark(acc, prices, now);
  return events;
}

// Why an idea is not in the account, for the app: { key: reason }.
const SKIPS = {
  held: 'already held',
  full: 'its budget is full',
  cash: 'not enough cash left',
  done: 'already bought once for this signal',
  ranAway: 'the price moved more than 1 ATR since the idea began',
  levels: 'no valid stop below the price',
  filter: 'the trade filter expects a loss',
};

function skip(acc, key, why) {
  acc.skips ||= {};
  acc.skips[key] = SKIPS[why];
}

// Buys one idea if its budget, cash and price allow; records why not otherwise.
function tryOpen(acc, o, { riskPct, now, prices, budgets, useFilter = true, trail = false }) {
  acc.skips ||= {};
  if (acc.positions.some(p => p.key === o.key)) { delete acc.skips[o.key]; return null; }
  // An idea counts as taken only if it was really traded: older versions
  // marked ideas they had no cash for, which then were never bought.
  const traded = acc.positions.some(p => p.key === o.key) || acc.trades.some(t => t.key === o.key);
  if (acc.taken.includes(o.id) && traded) return skip(acc, o.key, 'done'), null;
  if (o.ranAway) return skip(acc, o.key, 'ranAway'), null;
  if (!(o.entry > 0) || !(o.stop < o.entry)) return skip(acc, o.key, 'levels'), null;
  const filter = filterOf(o, useFilter);
  if (filter && !(filter.size > 0)) return skip(acc, o.key, 'filter'), null;
  const slot = room(acc, o, budgets);
  if (!slot) return skip(acc, o.key, 'full'), null;
  // No holding period (market scan ideas): sold at the stop, the target or a later Sell.
  const days = !o.hold ? 0 : o.type === 'stock' ? o.hold * (7 / 5) : o.hold;
  const ev = open(acc, o, { key: o.key, riskPct, now, prices, setup: o.setup, until: days ? now + Math.round(days * DAY_MS) : null, id: o.id, cap: slot.cap * (filter ? filter.size : 1), filter, trail: trail && canTrail(o) });
  // Without the cash to buy it, the idea is tried again next scan.
  if (!ev) return skip(acc, o.key, 'cash'), null;
  delete acc.skips[o.key];
  acc.taken.push(o.id);
  return ev;
}

function pruneTaken(acc) {
  if (acc.taken.length > 300) acc.taken.splice(0, acc.taken.length - 300);
  const keys = Object.keys(acc.skips || {});
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete acc.skips[k];
}

// Opens paper trades for the market scan's opportunities, best expected
// result first, within each one's budget (see BUDGETS). Each opportunity is taken
// once; it is sold at its stop, its target or after its holding period
// (trading days for stocks, calendar days for crypto).
// opportunities: [{ id, setup, key, symbol, type, entry, stop, take, hold, ev }]
export function openSetups(acc, opportunities, { riskPct = 1, now = Date.now(), budgets = BUDGETS, useFilter = true, trail = false } = {}) {
  const events = [];
  acc.taken ||= [];
  const prices = {};
  const list = [...opportunities].sort((a, b) => (b.ev || 0) - (a.ev || 0));
  for (const o of list) {
    const ev = tryOpen(acc, o, { riskPct, now, prices, budgets, useFilter, trail });
    if (ev) events.push(ev);
  }
  pruneTaken(acc);
  if (events.length) mark(acc, prices, now);
  return events;
}

// You can sell a position yourself, or move its stop-loss and target. Each
// returns the event, or null with nothing changed when it doesn't apply.
export function sellNow(acc, key, price, now = Date.now()) {
  const p = acc.positions.find(x => x.key === key);
  if (!p || !(price > 0)) return null;
  const ev = closePosition(acc, p, price, 'sold by you', now);
  mark(acc, { [key]: price }, now);
  return ev;
}

// The stop must be below the target; either may be left as it is (undefined).
// `trail` turns the trailing stop on or off for this trade (its risk is the
// distance from the entry to the stop it was bought with).
export function setLevels(acc, key, { stop, take, trail } = {}) {
  const p = acc.positions.find(x => x.key === key);
  if (!p) return null;
  const s = stop === undefined ? p.stop : stop;
  const t = take === undefined ? p.take : take;
  const trailing = trail === undefined ? !!p.trail : trail;
  // A trailing stop can rise past the target, which it no longer uses.
  if (!(s > 0) || (!trailing && !(t > s))) return null;
  p.stop = s;
  p.take = t;
  p.edited = true;
  if (trail === true && !p.trail) {
    const risk = p.risk || (p.entry > s ? p.entry - s : (p.take - p.entry) * (2 / 3));
    Object.assign(p, { trail: true, risk, high: Math.max(p.high || 0, p.entry) });
  }
  else if (trail === false) p.trail = false;
  return { kind: 'levels', symbol: p.symbol, key, stop: s, take: t, trail: !!p.trail };
}

// Raises a trailing position's stop as the price climbs.
function follow(p, price) {
  p.high = Math.max(p.high || p.entry, price);
  p.stop = trailStop({ entry: p.entry, stop: p.stop, risk: p.risk || p.entry - p.stop, high: p.high, floor: breakEven(p) });
}

// The price at which selling gets back what the trade cost, fees included.
export const breakEven = p => priceForGain(p, 0.01);

// The lowest price at which selling the position keeps `gain` dollars after
// the buy and sell fees, rounded up to a fine enough price step.
export function priceForGain(p, gain) {
  if (!(gain > 0) || !(p.qty > 0)) return NaN;
  const net = price => p.qty * price - feeOf(p.type, p.qty, price) - p.cost;
  let lo = 0;
  let hi = p.entry * 2;
  while (net(hi) < gain) {
    hi *= 2;
    if (hi > p.entry * 1e6) return NaN;
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (net(mid) >= gain) hi = mid;
    else lo = mid;
  }
  // A price step small enough that one step moves the result by a few cents at most.
  const tick = Math.min(0.01, 10 ** Math.floor(Math.log10(0.05 / p.qty)));
  return Number((Math.ceil(hi / tick - 1e-9) * tick).toFixed(12));
}

// Market scan trades are sold when a later scan rates them Sell.
// sells: [{ key, entry }]
export function closeOnSells(acc, sells, setup, { now = Date.now() } = {}) {
  const at = new Map(sells.map(s => [s.key, s.entry]));
  const events = [];
  for (const p of [...acc.positions]) {
    if (setupOf(p) === setup && ok(at.get(p.key))) events.push(closePosition(acc, p, at.get(p.key), 'sell signal', now));
  }
  if (events.length) mark(acc, {}, now);
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
