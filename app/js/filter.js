// The trade filter: a LightGBM model (trained weekly by server/ml.py) that
// gives each buy idea its chance of reaching the target before the stop, from
// what was known on the buy day. The paper account skips ideas whose expected
// result after fees is below zero and sizes the rest by it.
//
// It learns from the backtest's candles that looked like a Buy (thousands of
// them across the training charts), not from the paper trades, which are far
// too few. It is only used once its own test, on the newest year it never
// trained on, shows the trades it keeps beat the ones it skips.

import { scoreVotes } from './signals.js';
import { featureNames, featureVector, lgbmProbability, TURN_HORIZON } from './ml.js';
import { feeRate } from './fees.js';

export const MIN_SCORE = 15; // candles whose equal-weight score is at least this become training rows
const MIN_VOTE = 0.3;
const ok = Number.isFinite;

// Features on top of the ML models' (votes + indicators).
export const FILTER_EXTRA = ['baseScore', 'agree', 'market', 'crypto'];
export const filterNames = methodIds => [...featureNames(methodIds), ...FILTER_EXTRA];

// The market's trend on a day: how far SPY (for stocks) or Bitcoin (for
// crypto) closed above its 200-day average, as a share.
export function marketTrend(S, i) {
  const c = S.close[i];
  const m = S.sma200[i];
  return ok(c) && ok(m) && m > 0 ? c / m - 1 : NaN;
}

// A sorted [time, trend] list → the trend on or before `time`.
export function trendAt(series, time) {
  if (!series || !series.length) return NaN;
  let lo = 0;
  let hi = series.length - 1;
  if (series[0][0] > time) return NaN;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid][0] <= time) lo = mid;
    else hi = mid - 1;
  }
  return series[lo][1];
}

// ctx: { type: 'stock' | 'crypto', market: trend share or NaN }
export function filterVector(S, i, baseVotes, names, ctx) {
  const extra = {
    baseScore: scoreVotes(baseVotes, {}),
    agree: agreement(baseVotes),
    market: ok(ctx.market) ? ctx.market : NaN,
    crypto: ctx.type === 'crypto' ? 1 : 0,
  };
  const base = featureVector(S, i, baseVotes, names.filter(n => !FILTER_EXTRA.includes(n)));
  let k = 0;
  return names.map(n => (FILTER_EXTRA.includes(n) ? extra[n] : base[k++]));
}

// Of the methods with a clear opinion, the share that say buy.
function agreement(votes) {
  const clear = votes.filter(v => Math.abs(v.vote) >= MIN_VOTE);
  return clear.length ? clear.filter(v => v.vote > 0).length / clear.length : NaN;
}

// A buy at candle i's close with the stop and target in ATRs: did it reach
// the target first (win), and what did it return after the broker's fees?
// Sold at the close TURN_HORIZON candles later if neither was hit. null near the end.
export function tradeOutcome(S, i, { stopAtr = 2, takeAtr = 3, type = 'stock' } = {}) {
  const c = S.close[i];
  const atr = S.atr[i];
  if (i + TURN_HORIZON >= S.close.length || !ok(c) || !ok(atr) || atr <= 0) return null;
  const fee = feeRate(type);
  const net = exit => (exit / c) * (1 - fee) * (1 - fee) - 1;
  const stop = c - stopAtr * atr;
  const take = c + takeAtr * atr;
  for (let j = i + 1; j <= i + TURN_HORIZON; j++) {
    const b = S.candles[j];
    if (b.low <= stop) return { win: 0, ret: net(Math.min(b.open, stop)) };
    if (b.high >= take) return { win: 1, ret: net(Math.max(b.open, take)) };
  }
  return { win: 0, ret: net(S.close[i + TURN_HORIZON]) };
}

export const usableFilter = m => !!(m && m.trees && m.test && m.test.passed);

// The filter's view of a buy idea at candle i: { p, ev, size }.
// ev = chance × gain at the target − the rest × loss at the stop − fees.
// size scales the trade's slot from 0.5 to 1.5 by ev against the typical
// kept trade's (1 at the median).
export function judge(model, S, i, baseVotes, ctx, { stopAtr = 2, takeAtr = 3 } = {}) {
  if (!usableFilter(model) || !(S.candles[i].time > model.cutoff)) return null;
  const c = S.close[i];
  const atr = S.atr[i];
  if (!ok(c) || !ok(atr) || atr <= 0) return null;
  const p = lgbmProbability(model, filterVector(S, i, baseVotes, model.features, ctx));
  const fee = feeRate(ctx.type);
  const ev = p * (takeAtr * atr / c) - (1 - p) * (stopAtr * atr / c) - 2 * fee;
  const typical = model.test.medianEv > 0 ? model.test.medianEv : 0.01;
  const size = ev > 0 ? Math.max(0.5, Math.min(1.5, ev / typical)) : 0;
  return { p: Number(p.toFixed(4)), ev: Number(ev.toFixed(5)), size: Number(size.toFixed(3)) };
}
