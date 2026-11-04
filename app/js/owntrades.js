// The own-trades model (plan step 3): learns from our own closed paper trades
// which Buys make money after fees, and sizes new Buys by it.
//
// It is a logistic model (one weight per input), small on purpose: it learns
// from tens of trades, not thousands of candles. Each Buy gets a chance of a
// profit; its size is 1 + 2 × (chance − how often our trades usually win),
// kept within ×0.5 and ×1.5. It never blocks a Buy.
//
// Fair test: each closed trade is judged by a model trained only on trades
// that closed before it was bought. Once JUDGE_MIN trades are judged, the model
// qualifies if its sizes would have earned clearly more than the sizes the
// trades got (more than luck would give: see SURE).
// It keeps being judged, and goes back to learning if it falls behind.
import { METHOD_IDS } from './signals.js';

export const JUDGE_MIN = 30;     // judged trades before it may resize
export const TRAIN_MIN = 10;     // closed trades before a model can judge one
export const SURE = 1;           // how clearly its extra must beat 0 (a t-value; noise passes about 1 time in 6)
export const SIZE_MIN = 0.5;
export const SIZE_MAX = 1.5;
export const SIZE_SLOPE = 2;     // size gained per point of chance above the usual win rate
export const BOTH_MIN = 0.25;    // the filter's size × the model's size stays within these
export const BOTH_MAX = 2;
export const WHATIF_WEIGHT = 1 / 3;
export const SHADOW_WEIGHT = 0.5;
const L2 = 1;                    // how strongly weights are pulled to 0
const STEPS = 250;
const RATE = 0.3;

export const SOURCES = ['alerts', 'ideas', 'opportunities'];
export const sourceOfSetup = setup => (!setup || setup === 'signal' ? 'alerts' : setup === 'scan' ? 'ideas' : 'opportunities');

export const INPUTS = [...METHOD_IDS.map(id => `vote:${id}`), 'score', 'filter', 'hasFilter', 'crypto', ...SOURCES.map(s => `from:${s}`), 'mood'];

const ok = Number.isFinite;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = z => 1 / (1 + Math.exp(-z));
const val = (x, k) => (ok(x[k]) ? x[k] : 0);
// Only the inputs that aren't 0, to keep saved trades small.
export const compact = x => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== 0).map(([k, v]) => [k, round(v, 4)]));

// A Buy's inputs: { why: breakdown | null, filter: { p } | null, type, setup, mood: trend share | NaN }.
// Opportunities never use votes (they aren't scored by the methods).
export function inputsOf({ why, filter, type, setup, mood }) {
  const x = Object.fromEntries(INPUTS.map(n => [n, 0]));
  const source = sourceOfSetup(setup);
  if (why && source !== 'opportunities') {
    for (const v of why.votes || []) if (`vote:${v[0]}` in x && ok(v[3])) x[`vote:${v[0]}`] = v[3];
    if (ok(why.score)) x.score = why.score / 100;
  }
  if (filter && ok(filter.p)) { x.filter = filter.p - 0.5; x.hasFilter = 1; }
  x.crypto = type === 'crypto' ? 1 : 0;
  x[`from:${source}`] = 1;
  x.mood = ok(mood) ? clamp(mood, -1, 1) : 0;
  return x;
}

// Trains on rows [{ x, y: 0 | 1, w }]. Inputs are scaled to mean 0, spread 1
// first, so the pull towards 0 treats them alike.
export function train(rows) {
  const n = INPUTS.length;
  const W = rows.reduce((t, r) => t + r.w, 0);
  if (!rows.length || !(W > 0)) return null;
  const mean = INPUTS.map(k => rows.reduce((t, r) => t + r.w * val(r.x, k), 0) / W);
  const sd = INPUTS.map((k, j) => Math.sqrt(rows.reduce((t, r) => t + r.w * (val(r.x, k) - mean[j]) ** 2, 0) / W) || 1);
  const X = rows.map(r => INPUTS.map((k, j) => (val(r.x, k) - mean[j]) / sd[j]));
  const win = rows.reduce((t, r) => t + r.w * r.y, 0) / W;
  const w = new Array(n).fill(0);
  let b = Math.log(clamp(win, 0.02, 0.98) / (1 - clamp(win, 0.02, 0.98)));
  for (let s = 0; s < STEPS; s++) {
    const gw = w.map(v => (L2 * v) / W);
    let gb = 0;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i].w * (sigmoid(b + X[i].reduce((t, v, j) => t + v * w[j], 0)) - rows[i].y) / W;
      gb += e;
      for (let j = 0; j < n; j++) gw[j] += e * X[i][j];
    }
    b -= RATE * gb;
    for (let j = 0; j < n; j++) w[j] -= RATE * gw[j];
  }
  return { inputs: INPUTS, mean, sd, w, b, win };
}

export function chance(model, x) {
  if (!model) return NaN;
  return sigmoid(model.b + model.inputs.reduce((t, k, j) => t + (val(x, k) - model.mean[j]) / model.sd[j] * model.w[j], 0));
}

export const sizeFor = (p, win) => (ok(p) && ok(win) ? clamp(1 + SIZE_SLOPE * (p - win), SIZE_MIN, SIZE_MAX) : 1);

// What the model says about a Buy: { p, size, win, used, x }.
// `used`: whether it may change the size (it qualified).
// Without a model yet, only { x }: the inputs are kept for later training.
export function judgeBuy(state, buy) {
  const x = inputsOf(buy);
  const p = state && state.model ? chance(state.model, x) : NaN;
  if (!ok(p)) return { x: compact(x) };
  return { p: round(p, 4), size: round(sizeFor(p, state.model.win), 3), win: round(state.model.win, 4), used: !!state.qualified, x: compact(x) };
}

// The trade's size against its slot, after the filter and the model:
// filterSize (or 1) × model size, kept within ×0.25 and ×2 when both apply.
export function bothSizes(filterSize, own) {
  if (!own || !own.used) return ok(filterSize) ? filterSize : 1;
  if (!ok(filterSize)) return own.size;
  return clamp(filterSize * own.size, BOTH_MIN, BOTH_MAX);
}

const round = (x, d) => Number(x.toFixed(d));
export const tradeId = t => `${t.key}:${t.openedAt}`;

// The rows one closed trade gives: itself, plus each what-if exit that sold
// before `cutoff` (and isn't the exit it really took), at a third of the weight.
function rowsOf(t, x, whatIf, weight, cutoff) {
  if (!(t.closedAt < cutoff)) return [];
  const rows = [{ x, y: t.pnl > 0 ? 1 : 0, w: weight }];
  for (const [kind, v] of Object.entries(whatIf || {})) {
    if (!v || v.open || kind === (t.sellsAt || 'target') || !(v.at < cutoff) || !ok(v.pnl)) continue;
    rows.push({ x, y: v.pnl > 0 ? 1 : 0, w: weight * WHATIF_WEIGHT });
  }
  return rows;
}

// How much a trade's own result would have changed with the model's size.
// Trades the model already resized count from the size they would have had without it.
const baseResult = t => (t.own && t.own.used && t.own.mult > 0 ? t.pnl / t.own.mult : t.pnl);

// Everything from the trades: the model, the fair test and each trade's
// judged chance and size.
// trades / shadowTrades: closed trades; inputs: { id: x } (rebuilt inputs for
// trades that didn't save their own); whatIf: { id: { target, trail, lock } }.
// Returns { model, judged, extra, qualified, trades, preds: { id: { p, size } }, top }.
export function fit({ trades = [], shadowTrades = [], inputs = {}, whatIf = {}, now = Date.now() }) {
  const xOf = t => (t.own && t.own.x) || inputs[tradeId(t)] || null;
  const mainIds = new Set(trades.map(tradeId));
  const pool = [
    ...trades.map(t => ({ t, w: 1 })),
    ...shadowTrades.filter(t => !mainIds.has(tradeId(t))).map(t => ({ t, w: SHADOW_WEIGHT })),
  ].filter(({ t }) => xOf(t) && ok(t.pnl) && ok(t.closedAt));
  const rowsBefore = cutoff => pool.flatMap(({ t, w }) => rowsOf(t, xOf(t), whatIf[tradeId(t)], w, cutoff));
  const preds = {};
  const gains = [];
  for (const t of [...trades].filter(t => xOf(t) && ok(t.pnl)).sort((a, b) => a.openedAt - b.openedAt)) {
    const before = pool.filter(({ t: u, w }) => w === 1 && u.closedAt < t.openedAt).length;
    if (before < TRAIN_MIN) continue;
    const m = train(rowsBefore(t.openedAt));
    if (!m) continue;
    const p = chance(m, xOf(t));
    const size = sizeFor(p, m.win);
    preds[tradeId(t)] = { p: round(p, 4), size: round(size, 3) };
    gains.push(baseResult(t) * (size - 1));
  }
  const model = train(rowsBefore(Infinity));
  const judged = gains.length;
  const extra = gains.reduce((a, b) => a + b, 0);
  // More than luck: the extra must be clearly above 0 (t of at least SURE),
  // or a model with no edge would pass about half the time.
  const avg = judged ? extra / judged : 0;
  const spread = judged > 1 ? Math.sqrt(gains.reduce((a, g) => a + (g - avg) ** 2, 0) / (judged - 1)) : 0;
  const sure = spread > 0 ? avg / (spread / Math.sqrt(judged)) : 0;
  const qualified = !!model && judged >= JUDGE_MIN && extra > 0 && sure >= SURE;
  const top = model ? model.inputs.map((k, j) => [k, round(model.w[j], 3)]).filter(([, w]) => w !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 8) : [];
  return { at: now, model, trades: pool.filter(({ w }) => w === 1).length, judged, extra: round(extra, 2), sure: round(sure, 2), qualified, preds, top };
}

// Names for the app.
export function inputName(k) {
  if (k.startsWith('vote:')) return `${k.slice(5)} vote`;
  return { score: 'score', filter: 'trade filter', hasFilter: 'filter had a say', crypto: 'crypto', 'from:alerts': 'watchlist Buy', 'from:ideas': 'scan idea', 'from:opportunities': 'opportunity', mood: 'market mood' }[k] || k;
}
