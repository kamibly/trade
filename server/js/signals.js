// Turns every method into a vote between -1 (sell) and +1 (buy), then into one
// score from -100 to +100. Votes are first averaged inside their group, then
// the groups are averaged, so six trend indicators don't outvote one volume
// signal. Methods can be weighted by how well each backtests (backtest.js).

import * as I from './indicators.js';
import * as F from './forecast.js';
import { mlVotes } from './ml.js';

export const GROUPS = {
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  volume: 'Volume',
  structure: 'Price structure',
  stats: 'Statistical forecasts',
  ml: 'Machine learning',
};

// On random-walk prices the score stays within ±30 99% of the time, while
// steady trends reach 35-50, so ±40 fires on real moves but rarely on noise.
export const DEFAULT_THRESHOLDS = { buy: 40, sell: -40 };
export const MIN_CANDLES = 60;
const HORIZON = 10; // candles ahead for the forecast votes

const ok = Number.isFinite;
const clamp = (v, lo = -1, hi = 1) => (ok(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);
const fmt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3));

// Everything that can be computed once for the whole series. `models` are the
// machine-learning models for this timeframe from your server, if any.
export function analyze(candles, { models } = {}) {
  const close = I.closes(candles);
  const hasVolume = candles.some(c => c.volume > 0);
  return {
    candles,
    close,
    hasVolume,
    sma20: I.sma(close, 20),
    sma50: I.sma(close, 50),
    sma200: I.sma(close, 200),
    ema50: I.ema(close, 50),
    ema200: I.ema(close, 200),
    macd: I.macd(close),
    adx: I.adx(candles),
    ichimoku: I.ichimoku(candles),
    psar: I.parabolicSar(candles),
    supertrend: I.supertrend(candles),
    rsi: I.rsi(close),
    stoch: I.stochastic(candles),
    willr: I.williamsR(candles),
    cci: I.cci(candles),
    bb: I.bollinger(close),
    keltner: I.keltner(candles),
    donchian: I.donchian(candles),
    atr: I.atr(candles),
    obv: hasVolume ? I.obv(candles) : null,
    vwap: hasVolume ? I.vwap(candles) : null,
    mfi: hasVolume ? I.mfi(candles) : null,
    volAvg: hasVolume ? I.sma(candles.map(c => c.volume), 20) : null,
    holt: F.holt(close),
    models: models || null,
  };
}

const vote = (id, name, group, v, note) => ({ id, name, group, vote: clamp(v), note });

// Each function returns a vote, or null when it has too little history at i.
const METHODS = [
  // ---- Trend
  (S, i) => {
    const a = S.sma20[i]; const b = S.sma50[i]; const atr = S.atr[i];
    if (!ok(a) || !ok(b) || !ok(atr)) return null;
    const crossed = sign(a - b) !== sign(S.sma20[i - 1] - S.sma50[i - 1]);
    return vote('sma-cross', 'SMA 20/50', 'trend', crossed ? sign(a - b) : (a - b) / atr,
      `${a > b ? 'Fast above slow' : 'Fast below slow'}${crossed ? ', just crossed' : ''}`);
  },
  (S, i) => {
    const a = S.ema50[i]; const b = S.ema200[i]; const atr = S.atr[i];
    if (!ok(a) || !ok(b) || i < 200) return null;
    return vote('ema-cross', 'EMA 50/200', 'trend', (a - b) / (2 * atr), a > b ? 'Golden cross regime' : 'Death cross regime');
  },
  (S, i) => {
    const m = S.sma200[i];
    if (!ok(m)) return null;
    return vote('sma200', 'Price vs SMA 200', 'trend', (S.close[i] - m) / (3 * S.atr[i]), `${S.close[i] > m ? 'Above' : 'Below'} the 200 average`);
  },
  (S, i) => {
    const h = S.macd.hist[i]; const prev = S.macd.hist[i - 1];
    if (!ok(h) || !ok(prev)) return null;
    const crossed = sign(h) !== sign(prev);
    return vote('macd', 'MACD', 'trend', crossed ? sign(h) : h / (0.5 * S.atr[i]),
      `Histogram ${fmt(h)}${crossed ? `, ${h > 0 ? 'bullish' : 'bearish'} cross` : ''}`);
  },
  (S, i) => {
    const a = S.adx.adx[i]; const p = S.adx.plusDI[i]; const m = S.adx.minusDI[i];
    if (!ok(a)) return null;
    return vote('adx', 'ADX', 'trend', a < 20 ? 0 : sign(p - m) * (a - 20) / 20,
      a < 20 ? `No clear trend (ADX ${a.toFixed(0)})` : `${p > m ? 'Up' : 'Down'}trend strength ${a.toFixed(0)}`);
  },
  (S, i) => {
    const { tenkan, kijun, spanA, spanB, shift } = S.ichimoku;
    const a = spanA[i - shift]; const b = spanB[i - shift];
    if (!ok(a) || !ok(b) || !ok(tenkan[i])) return null;
    const top = Math.max(a, b); const bottom = Math.min(a, b); const c = S.close[i];
    const pos = c > top ? 1 : c < bottom ? -1 : 0;
    const tk = sign(tenkan[i] - kijun[i]);
    return vote('ichimoku', 'Ichimoku Cloud', 'trend', pos === 0 ? 0 : pos === tk ? pos : pos * 0.5,
      pos > 0 ? 'Price above the cloud' : pos < 0 ? 'Price below the cloud' : 'Price inside the cloud');
  },
  (S, i) => {
    const up = S.psar.up[i];
    if (up === null || i < 30) return null;
    const flipped = S.psar.up[i - 1] !== null && S.psar.up[i - 1] !== up;
    return vote('psar', 'Parabolic SAR', 'trend', (up ? 1 : -1) * (flipped ? 1 : 0.5), `${up ? 'Rising' : 'Falling'}${flipped ? ', just flipped' : ''}`);
  },
  (S, i) => {
    const up = S.supertrend.up[i];
    if (up === null) return null;
    const flipped = S.supertrend.up[i - 1] !== null && S.supertrend.up[i - 1] !== up;
    return vote('supertrend', 'Supertrend', 'trend', (up ? 1 : -1) * (flipped ? 1 : 0.6), `${up ? 'Up' : 'Down'}${flipped ? ', just flipped' : ''}`);
  },

  // ---- Momentum (oscillators vote for a reversal at extremes)
  (S, i) => {
    const r = S.rsi[i];
    if (!ok(r)) return null;
    return vote('rsi', 'RSI 14', 'momentum', r < 30 ? (30 - r) / 15 + 0.3 : r > 70 ? -((r - 70) / 15 + 0.3) : 0,
      `${r.toFixed(0)}${r < 30 ? ', oversold' : r > 70 ? ', overbought' : ''}`);
  },
  (S, i) => {
    const k = S.stoch.k[i]; const d = S.stoch.d[i];
    if (!ok(k) || !ok(d)) return null;
    const v = k < 20 ? (k > d ? 1 : 0.5) : k > 80 ? (k < d ? -1 : -0.5) : 0;
    return vote('stoch', 'Stochastic', 'momentum', v, `%K ${k.toFixed(0)}${k < 20 ? ', oversold' : k > 80 ? ', overbought' : ''}`);
  },
  (S, i) => {
    const w = S.willr[i];
    if (!ok(w)) return null;
    return vote('willr', 'Williams %R', 'momentum', w < -80 ? 0.6 : w > -20 ? -0.6 : 0, w.toFixed(0));
  },
  (S, i) => {
    const c = S.cci[i];
    if (!ok(c)) return null;
    return vote('cci', 'CCI', 'momentum', c < -100 ? (-100 - c) / 100 + 0.3 : c > 100 ? -((c - 100) / 100 + 0.3) : 0, c.toFixed(0));
  },
  (S, i) => {
    if (i < 12 || !ok(S.atr[i])) return null;
    const change = S.close[i] - S.close[i - 12];
    return vote('roc', 'Rate of change (12)', 'momentum', change / (S.atr[i] * Math.sqrt(12)),
      `${((change / S.close[i - 12]) * 100).toFixed(1)}% over 12 candles`);
  },
  (S, i) => {
    // RSI divergence between the last two swing lows (bullish) or highs (bearish).
    if (i < 40 || !ok(S.rsi[i - 40])) return null;
    const { highs, lows } = I.swings(S.candles, i, 3, 40);
    const c = S.candles;
    if (lows.length >= 2) {
      const [a, b] = lows.slice(-2);
      if (c[b].low < c[a].low && S.rsi[b] > S.rsi[a] && i - b <= 10) return vote('rsi-div', 'RSI divergence', 'momentum', 0.8, 'Bullish: lower price low, higher RSI low');
    }
    if (highs.length >= 2) {
      const [a, b] = highs.slice(-2);
      if (c[b].high > c[a].high && S.rsi[b] < S.rsi[a] && i - b <= 10) return vote('rsi-div', 'RSI divergence', 'momentum', -0.8, 'Bearish: higher price high, lower RSI high');
    }
    return vote('rsi-div', 'RSI divergence', 'momentum', 0, 'None');
  },

  // ---- Volatility
  (S, i) => {
    const { upper, lower, mid, width } = S.bb;
    if (!ok(upper[i]) || i < 120) return null;
    const c = S.close[i];
    if (c < lower[i]) return vote('bollinger', 'Bollinger Bands', 'volatility', 0.7, 'Below the lower band');
    if (c > upper[i]) return vote('bollinger', 'Bollinger Bands', 'volatility', -0.7, 'Above the upper band');
    const recent = width.slice(i - 119, i + 1).filter(ok).sort((a, b) => a - b);
    const squeeze = width[i] <= recent[Math.floor(recent.length * 0.1)];
    return vote('bollinger', 'Bollinger Bands', 'volatility', squeeze ? 0.5 * sign(c - mid[i]) : 0, squeeze ? 'Squeeze: a big move may follow' : 'Inside the bands');
  },
  (S, i) => {
    const { upper, lower } = S.keltner;
    if (!ok(upper[i])) return null;
    const c = S.close[i];
    return vote('keltner', 'Keltner Channels', 'volatility', c > upper[i] ? 0.6 : c < lower[i] ? -0.6 : 0,
      c > upper[i] ? 'Breaking out upward' : c < lower[i] ? 'Breaking down' : 'Inside the channel');
  },
  (S, i) => {
    const up = S.donchian.upper[i]; const lo = S.donchian.lower[i];
    if (!ok(up)) return null;
    const c = S.close[i];
    return vote('donchian', 'Donchian breakout', 'volatility', c > up ? 1 : c < lo ? -1 : 0,
      c > up ? 'New 20-candle high' : c < lo ? 'New 20-candle low' : 'Inside the 20-candle range');
  },

  // ---- Volume
  (S, i) => {
    if (!S.obv || i < 20) return null;
    const obvUp = S.obv[i] - S.obv[i - 20];
    const priceUp = S.close[i] - S.close[i - 20];
    const diverge = sign(obvUp) !== sign(priceUp) && sign(obvUp) !== 0;
    return vote('obv', 'On-balance volume', 'volume', sign(obvUp) * (diverge ? 0.8 : 0.5),
      diverge ? `Volume ${obvUp > 0 ? 'rising' : 'falling'} against price` : `Volume confirms the ${priceUp > 0 ? 'rise' : 'fall'}`);
  },
  (S, i) => {
    if (!S.vwap || !ok(S.vwap[i])) return null;
    return vote('vwap', 'VWAP (20)', 'volume', (S.close[i] - S.vwap[i]) / (2 * S.atr[i]), `${S.close[i] > S.vwap[i] ? 'Above' : 'Below'} volume-weighted price`);
  },
  (S, i) => {
    if (!S.mfi || !ok(S.mfi[i])) return null;
    const m = S.mfi[i];
    return vote('mfi', 'Money flow index', 'volume', m < 20 ? 0.7 : m > 80 ? -0.7 : 0, `${m.toFixed(0)}${m < 20 ? ', oversold' : m > 80 ? ', overbought' : ''}`);
  },
  (S, i) => {
    if (!S.volAvg || !ok(S.volAvg[i])) return null;
    const x = S.candles[i];
    const spike = x.volume > 2 * S.volAvg[i];
    return vote('vol-spike', 'Volume spike', 'volume', spike ? 0.7 * sign(x.close - x.open) : 0,
      spike ? `${(x.volume / S.volAvg[i]).toFixed(1)}x normal volume on a ${x.close >= x.open ? 'green' : 'red'} candle` : 'Normal volume');
  },

  // ---- Price structure
  (S, i) => {
    if (i < 30) return null;
    const { highs, lows } = I.swings(S.candles, i, 3, 120);
    const c = S.close[i]; const atr = S.atr[i];
    const res = highs.map(k => S.candles[k].high).filter(h => h > c).sort((a, b) => a - b)[0];
    const sup = lows.map(k => S.candles[k].low).filter(l => l < c).sort((a, b) => b - a)[0];
    const brokeOut = highs.some(k => S.close[i - 1] <= S.candles[k].high && c > S.candles[k].high && i - k > 3);
    if (brokeOut) return vote('sr', 'Support and resistance', 'structure', 0.8, 'Broke above resistance');
    if (ok(sup) && c - sup < atr) return vote('sr', 'Support and resistance', 'structure', 0.6, `Near support at ${fmt(sup)}`);
    if (ok(res) && res - c < atr) return vote('sr', 'Support and resistance', 'structure', -0.6, `Near resistance at ${fmt(res)}`);
    return vote('sr', 'Support and resistance', 'structure', 0, 'Between levels');
  },
  (S, i) => {
    if (i < 100) return null;
    const f = I.fibonacci(S.candles, i);
    const c = S.close[i];
    const lo = Math.min(f.levels[0.5], f.levels[0.618]); const hi = Math.max(f.levels[0.5], f.levels[0.618]);
    const inZone = c >= lo && c <= hi;
    return vote('fib', 'Fibonacci retracement', 'structure', inZone ? (f.rising ? 0.6 : -0.6) : 0,
      inZone ? `In the 50-61.8% zone of the last ${f.rising ? 'rise' : 'fall'}` : 'Outside the key zone');
  },
  (S, i) => {
    const p = I.pivots(S.candles, i);
    if (!p) return null;
    const c = S.close[i];
    return vote('pivots', 'Pivot points', 'structure', c > p.r1 ? 0.5 : c < p.s1 ? -0.5 : 0.2 * sign(c - p.p),
      c > p.r1 ? 'Above R1' : c < p.s1 ? 'Below S1' : `${c > p.p ? 'Above' : 'Below'} the pivot`);
  },
  (S, i) => {
    if (i < 10) return null;
    const pat = I.candlePattern(S.candles, i);
    const before = S.close[i - 1] - S.close[i - 6]; // the move into the pattern
    const bull = (pat === 'bullish engulfing' || pat === 'hammer') && before < 0;
    const bear = (pat === 'bearish engulfing' || pat === 'shooting star') && before > 0;
    return vote('candles', 'Candlestick pattern', 'structure', bull ? 0.7 : bear ? -0.7 : 0,
      pat ? `${pat[0].toUpperCase()}${pat.slice(1)}${bull || bear ? ' after a ' + (bull ? 'fall' : 'rise') : ''}` : 'No pattern');
  },

  // ---- Statistical forecasts
  (S, i) => {
    const lr = F.linearRegression(S.close, i, 100);
    if (!lr) return null;
    const perWindow = (lr.slope * 20) / S.atr[i];
    return vote('linreg', 'Linear regression (100)', 'stats', perWindow * lr.r2,
      `Trend ${lr.slope > 0 ? 'up' : 'down'}, fit R² ${lr.r2.toFixed(2)}`);
  },
  (S, i) => {
    if (i < 50) return null;
    const f = F.holtForecast(S.holt, i, HORIZON);
    return vote('holt', 'Holt-Winters smoothing', 'stats', (f - S.close[i]) / (2 * S.atr[i]), `${HORIZON}-candle forecast ${fmt(f)}`);
  },
  (S, i) => {
    const f = F.arimaForecast(S.close, i, { steps: HORIZON });
    if (!f) return null;
    const expected = S.close[i] * Math.exp(f.total);
    return vote('arima', 'ARIMA(3,1,0)', 'stats', (expected - S.close[i]) / (S.atr[i] * Math.sqrt(HORIZON) * 0.5), `${HORIZON}-candle forecast ${fmt(expected)}`);
  },
  (S, i) => {
    const g = F.gbmParams(S.close, i);
    if (!g) return null;
    const p = F.probUp(g, HORIZON);
    return vote('montecarlo', 'Monte Carlo (GBM)', 'stats', (p - 0.5) * 4, `${(p * 100).toFixed(0)}% chance higher in ${HORIZON} candles`);
  },
  (S, i) => {
    const h = F.hurst(S.close, i);
    if (h === null || !ok(S.sma50[i])) return null;
    const dir = sign(S.close[i] - S.sma50[i]);
    // R/S reads a little high on short samples, so 0.6 / 0.4 mark real persistence.
    const v = h > 0.6 ? dir * (h - 0.6) * 5 : h < 0.4 ? -dir * (0.4 - h) * 5 : 0;
    return vote('hurst', 'Hurst exponent', 'stats', v, `${h.toFixed(2)}: ${h > 0.6 ? 'trends persist' : h < 0.4 ? 'moves tend to reverse' : 'random-walk like'}`);
  },
];

// The ids of the 30 methods, in order (the ML features use them).
export const METHOD_IDS = ['sma-cross', 'ema-cross', 'sma200', 'macd', 'adx', 'ichimoku', 'psar', 'supertrend',
  'rsi', 'stoch', 'willr', 'cci', 'roc', 'rsi-div', 'bollinger', 'keltner', 'donchian',
  'obv', 'vwap', 'mfi', 'vol-spike', 'sr', 'fib', 'pivots', 'candles', 'linreg', 'holt', 'arima', 'montecarlo', 'hurst'];

// The 30 methods' votes, without machine learning.
export function baseVotesAt(S, i) {
  if (i < MIN_CANDLES - 1 || i >= S.candles.length) return [];
  return METHODS.map(m => m(S, i)).filter(Boolean);
}

export function votesAt(S, i) {
  const base = baseVotesAt(S, i);
  return base.length && S.models ? [...base, ...mlVotes(S, i, base, S.models)] : base;
}

// `weights` (method id → weight) comes from the backtest; default 1.
export function scoreVotes(votes, weights = {}) {
  const groups = {};
  for (const v of votes) {
    const w = weights[v.id] ?? 1;
    if (w <= 0) continue;
    (groups[v.group] ||= { sum: 0, weight: 0 });
    groups[v.group].sum += w * v.vote;
    groups[v.group].weight += w;
  }
  const means = Object.values(groups).filter(g => g.weight > 0).map(g => g.sum / g.weight);
  if (!means.length) return 0;
  return (100 * means.reduce((a, b) => a + b, 0)) / means.length;
}

// A Buy's or Sell's score, kept with a paper trade so you can see later why it
// bought or sold: { score, rule, time, votes: [[id, name, group, vote, weight]] }.
export function breakdown(sig, weights = {}) {
  const r2 = x => Math.round(x * 100) / 100;
  return {
    score: Math.round(sig.score * 10) / 10,
    rule: sig.rule,
    time: sig.time,
    votes: sig.votes.map(v => [v.id, v.name, v.group, r2(v.vote), r2(weights[v.id] ?? 1)]),
  };
}

// How a score adds up, the same way scoreVotes() does it: each group's
// weighted average vote, and the points it adds (groups count equally; a group
// whose methods all have weight 0 drops out). votes: [{ id, name, group, vote, weight }]
export function scoreParts(votes) {
  const groups = {};
  for (const v of votes) {
    const g = (groups[v.group] ||= { group: v.group, sum: 0, weight: 0, votes: [] });
    g.votes.push(v);
    if (v.weight > 0) { g.sum += v.weight * v.vote; g.weight += v.weight; }
  }
  const counted = Object.values(groups).filter(g => g.weight > 0);
  const parts = Object.values(groups).map(g => {
    const vote = g.weight > 0 ? g.sum / g.weight : NaN;
    return { group: g.group, votes: g.votes, vote, adds: g.weight > 0 ? (100 * vote) / counted.length : 0 };
  });
  return { parts, groups: counted.length, score: parts.reduce((t, p) => t + p.adds, 0) };
}

export function scoreAt(S, i, weights) {
  return scoreVotes(votesAt(S, i), weights);
}

// Score for every candle from `from` on (NaN before there is enough history).
export function scoreHistory(S, { from = 0, weights } = {}) {
  return S.candles.map((_, i) => (i < Math.max(from, MIN_CANDLES - 1) ? NaN : scoreAt(S, i, weights)));
}

// How the score becomes Buy, Sell or Hold. `rule` is { buy, sell, mode }:
// - 'standard': Buy at or above `buy`, Sell at or below `sell`.
// - 'dip' (buy the dip in an uptrend): Buy only in an uptrend right after a
//   pullback (RSI or Stochastic oversold in the last 5 candles); Sell when the
//   score falls to `sell` or the price closes below its 200-candle average.
// `ctx` comes from contextAt() and is only needed for 'dip'.
export const MODES = { standard: 'Standard', dip: 'Buy the dip in an uptrend' };
const PULLBACK_CANDLES = 5;

export function actionFor(score, rule = DEFAULT_THRESHOLDS, ctx = null) {
  if (rule.mode === 'dip') {
    if (!ctx) return 'hold';
    if (score <= rule.sell || ctx.belowTrend) return 'sell';
    return ctx.uptrend && ctx.pulledBack && score >= rule.buy ? 'buy' : 'hold';
  }
  return score >= rule.buy ? 'buy' : score <= rule.sell ? 'sell' : 'hold';
}

// The trend facts the 'dip' mode needs at candle i.
export function contextAt(S, i) {
  const m200 = S.sma200[i];
  const m50 = S.sma50[i];
  if (!ok(m200) || !ok(m50)) return { uptrend: false, pulledBack: false, belowTrend: false };
  let pulledBack = false;
  for (let k = Math.max(0, i - PULLBACK_CANDLES + 1); k <= i && !pulledBack; k++) {
    pulledBack = (ok(S.rsi[k]) && S.rsi[k] <= 35) || (ok(S.stoch.k[k]) && S.stoch.k[k] <= 20);
  }
  return { uptrend: S.close[i] > m200 && m50 > m200, pulledBack, belowTrend: S.close[i] < m200 };
}

// The full read-out for one candle: score, action, agreement and trade levels.
export function signalAt(S, i = S.candles.length - 1, { thresholds = DEFAULT_THRESHOLDS, weights, stopAtr = 2, takeAtr = 3 } = {}) {
  const votes = votesAt(S, i);
  if (!votes.length) return null;
  const score = scoreVotes(votes, weights);
  const ctx = contextAt(S, i);
  const action = actionFor(score, thresholds, ctx);
  // In 'dip' mode a Buy can come with a modest score; its levels are a buy's.
  const dir = action === 'buy' ? 1 : action === 'sell' ? -1 : sign(score);
  const active = votes.filter(v => v.vote !== 0);
  const agree = active.filter(v => sign(v.vote) === dir).length;
  const entry = S.close[i];
  const atr = S.atr[i];
  // For a sell, the levels are those of a short position (or of exiting a long).
  return {
    time: S.candles[i].time,
    score,
    action,
    ctx,
    rule: { buy: thresholds.buy, sell: thresholds.sell, mode: thresholds.mode || 'standard' },
    confidence: active.length && dir ? agree / active.length : 0,
    entry,
    atr,
    stop: dir >= 0 ? entry - stopAtr * atr : entry + stopAtr * atr,
    take: dir >= 0 ? entry + takeAtr * atr : entry - takeAtr * atr,
    votes,
    top: [...active].filter(v => sign(v.vote) === dir).sort((a, b) => Math.abs(b.vote) - Math.abs(a.vote)).slice(0, 3).map(v => v.name),
  };
}

// Candles where the action turned to buy or sell, for chart markers.
// `S` is needed for the 'dip' mode.
export function crossings(scores, thresholds = DEFAULT_THRESHOLDS, S = null) {
  const out = [];
  let prev = 'hold';
  scores.forEach((s, i) => {
    if (!ok(s)) return;
    const a = actionFor(s, thresholds, S ? contextAt(S, i) : null);
    if (a !== prev && a !== 'hold') out.push({ i, action: a, score: s });
    prev = a;
  });
  return out;
}
