// Walk-forward backtest. The older part of the history (the training part)
// measures how often each method's vote pointed the right way; those hit rates
// become method weights. The newer part (the test part), which the weights
// never saw, then trades the signals so the results are not fitted to the past.

import { votesAt, scoreVotes, actionFor, contextAt, MIN_CANDLES, DEFAULT_THRESHOLDS } from './signals.js';

export const FEE = 0.001; // 0.1% per side; callers pass the broker's rate for the symbol (fees.js)
const MIN_VOTE = 0.3; // only count votes with a clear opinion
const SHRINK = 50; // a method needs ~50 opinions before its weight moves far from 1

const ok = Number.isFinite;

// Votes for every candle, computed once (the expensive part).
export function voteMatrix(S, from = 0) {
  return S.candles.map((_, i) => (i < Math.max(from, MIN_CANDLES - 1) ? [] : votesAt(S, i)));
}

// How often each method's clear votes matched the move over the next `horizon` candles, after fees.
export function methodStats(S, votes, start, end, { horizon = 10, fee = FEE } = {}) {
  const stats = {};
  for (let i = start; i < end && i + horizon < S.close.length; i++) {
    const ret = S.close[i + horizon] / S.close[i] - 1;
    for (const v of votes[i]) {
      const s = (stats[v.id] ||= { id: v.id, name: v.name, group: v.group, n: 0, hits: 0 });
      if (Math.abs(v.vote) < MIN_VOTE) continue;
      s.n += 1;
      if ((v.vote > 0 && ret > 2 * fee) || (v.vote < 0 && ret < -2 * fee)) s.hits += 1;
    }
  }
  for (const s of Object.values(stats)) s.hit = s.n ? s.hits / s.n : NaN;
  return stats;
}

// 50% right keeps weight 1; 60% right doubles it; 40% or worse drops it to 0.
// Few opinions pull the weight back toward 1 so luck on a handful of votes doesn't count.
export function weightsFrom(stats) {
  const w = {};
  for (const s of Object.values(stats)) {
    if (!s.n) { w[s.id] = 1; continue; }
    const raw = Math.max(0, Math.min(2, 1 + (s.hit - 0.5) * 10));
    const shrink = s.n / (s.n + SHRINK);
    w[s.id] = Number((1 + shrink * (raw - 1)).toFixed(3));
  }
  return w;
}

// Long-only trading of the score between start and end. Enters at the close of
// the candle whose score crosses into buy; exits on the stop, the target or a
// sell score. If one candle touches both stop and target, the stop counts.
export function simulate(S, scores, start, end, { thresholds = DEFAULT_THRESHOLDS, stopAtr = 2, takeAtr = 3, fee = FEE, ctx } = {}) {
  const c = S.candles;
  const trades = [];
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  let pos = null;
  let prev = 'hold';
  const mark = price => {
    const value = pos ? equity * (price / pos.entry) * (1 - fee) : equity;
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
  };
  const close = (i, price, reason) => {
    const ret = (price / pos.entry) * (1 - fee) * (1 - fee) - 1;
    equity *= 1 + ret;
    trades.push({ entryTime: c[pos.i].time, exitTime: c[i].time, entry: pos.entry, exit: price, ret, reason });
    pos = null;
  };
  for (let i = start; i < end; i++) {
    if (pos && i > pos.i) {
      const bar = c[i];
      if (bar.low <= pos.stop) close(i, Math.min(bar.open, pos.stop), 'stop');
      else if (bar.high >= pos.take) close(i, Math.max(bar.open, pos.take), 'target');
    }
    const s = scores[i];
    if (!ok(s)) continue;
    const action = actionFor(s, thresholds, thresholds.mode === 'dip' ? (ctx ? ctx[i] : contextAt(S, i)) : null);
    if (pos && action === 'sell') close(i, S.close[i], 'sell signal');
    else if (!pos && action === 'buy' && prev !== 'buy' && ok(S.atr[i])) {
      const entry = S.close[i];
      pos = { i, entry, stop: entry - stopAtr * S.atr[i], take: entry + takeAtr * S.atr[i] };
    }
    prev = action;
    mark(S.close[i]);
  }
  const open = pos ? { entry: pos.entry, entryTime: c[pos.i].time, ret: (S.close[end - 1] / pos.entry) * (1 - fee) * (1 - fee) - 1 } : null;
  if (open) equity *= 1 + open.ret;
  const wins = trades.filter(t => t.ret > 0).length;
  return {
    trades,
    open,
    winRate: trades.length ? wins / trades.length : NaN,
    totalReturn: equity - 1,
    maxDrawdown,
    buyHold: end > start ? S.close[end - 1] / S.close[start] - 1 : NaN,
  };
}

// ---- Threshold tuning ---------------------------------------------------------

export const TUNE_BUY = [15, 20, 25, 30, 35, 40, 50, 60];
export const TUNE_SELL = [-15, -20, -25, -30, -35, -40, -50, -60];
const MIN_TUNE_TRADES = 3;

// Tuning score: return, less half the worst drop, so one lucky trade with a
// deep slump doesn't beat a steadier pair.
const merit = r => r.totalReturn - 0.5 * r.maxDrawdown;
const tradeCount = r => r.trades.length + (r.open ? 1 : 0);

// The best { buy, sell, mode } between start and end, or null when no pair
// made at least 3 trades there. `modes` limits which modes are tried.
export function tuneRule(S, scores, start, end, { stopAtr = 2, takeAtr = 3, modes = ['standard', 'dip'], fee = FEE } = {}) {
  const ctx = S.candles.map((_, i) => (i >= start && i < end ? contextAt(S, i) : null));
  let best = null;
  for (const mode of modes) {
    for (const buy of TUNE_BUY) {
      for (const sell of TUNE_SELL) {
        const rule = { buy, sell, mode };
        const r = simulate(S, scores, start, end, { thresholds: rule, stopAtr, takeAtr, ctx, fee });
        if (tradeCount(r) < MIN_TUNE_TRADES) continue;
        const m = merit(r);
        if (!best || m > best.merit + 1e-9) best = { rule, merit: m, result: r };
      }
    }
  }
  return best;
}

// The whole walk-forward run for one symbol and timeframe. With `tune`, the
// thresholds (and the mode, unless `thresholds.mode` is fixed by `tune ===
// 'thresholds'`) are picked on the training part and checked on the test part.
export function backtest(S, { thresholds = DEFAULT_THRESHOLDS, horizon = 10, trainShare = 0.6, stopAtr = 2, takeAtr = 3, votes, tune = false, fee = FEE } = {}) {
  const n = S.candles.length;
  const first = MIN_CANDLES - 1;
  if (n - first < 120) return null;
  const split = first + Math.floor((n - first) * trainShare);
  votes ||= voteMatrix(S);
  const stats = methodStats(S, votes, first, split - horizon, { horizon, fee });
  const weights = weightsFrom(stats);
  const scoresWith = w => votes.map((v, i) => (v.length ? scoreVotes(v, w) : NaN));
  const opts = { thresholds, stopAtr, takeAtr, fee };
  const weightedScores = scoresWith(weights);
  const out = {
    candles: n,
    trainFrom: S.candles[first].time,
    testFrom: S.candles[split].time,
    testCandles: n - split,
    stats,
    weights,
    weighted: simulate(S, weightedScores, split, n, opts),
    equal: simulate(S, scoresWith({}), split, n, opts),
  };
  if (tune) {
    const modes = tune === 'thresholds' ? [thresholds.mode || 'standard'] : ['standard', 'dip'];
    const best = tuneRule(S, weightedScores, first, split, { stopAtr, takeAtr, modes, fee });
    out.rule = best ? best.rule : { ...DEFAULT_THRESHOLDS, mode: modes[0] };
    out.tunedTrain = best ? best.result : null;
    out.tuned = simulate(S, weightedScores, split, n, { ...opts, thresholds: out.rule });
    out.standard = simulate(S, weightedScores, split, n, { ...opts, thresholds: { ...DEFAULT_THRESHOLDS, mode: 'standard' } });
  }
  return out;
}
