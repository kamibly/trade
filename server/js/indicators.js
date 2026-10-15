// Technical indicators as full arrays aligned with the candles, NaN where an
// indicator has too little history. No browser dependencies.

const blank = n => new Array(n).fill(NaN);
const ok = Number.isFinite;

export const closes = c => c.map(x => x.close);

// First index where `p` values in a row are all finite (start of a series).
function firstRun(values, p) {
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run = ok(values[i]) ? run + 1 : 0;
    if (run === p) return i;
  }
  return -1;
}

export function sma(values, p) {
  const out = blank(values.length);
  let sum = 0;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    if (!ok(values[i])) { sum = 0; run = 0; continue; }
    sum += values[i];
    run++;
    if (run > p) sum -= values[i - p];
    if (run >= p) out[i] = sum / p;
  }
  return out;
}

// Exponential average seeded with the simple average of its first `p` values.
function smoothed(values, p, alpha) {
  const out = blank(values.length);
  const end = firstRun(values, p);
  if (end < 0) return out;
  let prev = 0;
  for (let i = end - p + 1; i <= end; i++) prev += values[i] / p;
  out[end] = prev;
  for (let i = end + 1; i < values.length; i++) {
    if (!ok(values[i])) { out[i] = prev; continue; }
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

export const ema = (values, p) => smoothed(values, p, 2 / (p + 1));
// Wilder's smoothing, used by RSI, ATR and ADX.
export const rma = (values, p) => smoothed(values, p, 1 / p);

export function stdev(values, p) {
  const mean = sma(values, p);
  const out = blank(values.length);
  for (let i = p - 1; i < values.length; i++) {
    if (!ok(mean[i])) continue;
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (values[j] - mean[i]) ** 2;
    out[i] = Math.sqrt(s / p);
  }
  return out;
}

function rolling(values, p, fn) {
  const out = blank(values.length);
  for (let i = p - 1; i < values.length; i++) out[i] = fn(values.slice(i - p + 1, i + 1));
  return out;
}
const highest = (values, p) => rolling(values, p, w => Math.max(...w));
const lowest = (values, p) => rolling(values, p, w => Math.min(...w));

export function rsi(close, p = 14) {
  const up = blank(close.length);
  const down = blank(close.length);
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    up[i] = Math.max(d, 0);
    down[i] = Math.max(-d, 0);
  }
  const au = rma(up, p);
  const ad = rma(down, p);
  return au.map((u, i) => (!ok(u) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])));
}

export function macd(close, fast = 12, slow = 26, sig = 9) {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const line = f.map((v, i) => v - s[i]);
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export function bollinger(close, p = 20, k = 2) {
  const mid = sma(close, p);
  const sd = stdev(close, p);
  const upper = mid.map((m, i) => m + k * sd[i]);
  const lower = mid.map((m, i) => m - k * sd[i]);
  return { mid, upper, lower, width: mid.map((m, i) => (upper[i] - lower[i]) / m) };
}

export function trueRange(c) {
  return c.map((x, i) => (i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
}

export const atr = (c, p = 14) => rma(trueRange(c), p);

export function stochastic(c, p = 14, d = 3) {
  const hh = highest(c.map(x => x.high), p);
  const ll = lowest(c.map(x => x.low), p);
  const k = c.map((x, i) => (hh[i] === ll[i] ? 50 : (100 * (x.close - ll[i])) / (hh[i] - ll[i])));
  return { k, d: sma(k, d) };
}

export function williamsR(c, p = 14) {
  const hh = highest(c.map(x => x.high), p);
  const ll = lowest(c.map(x => x.low), p);
  return c.map((x, i) => (hh[i] === ll[i] ? -50 : (-100 * (hh[i] - x.close)) / (hh[i] - ll[i])));
}

export function cci(c, p = 20) {
  const tp = c.map(x => (x.high + x.low + x.close) / 3);
  const mean = sma(tp, p);
  return tp.map((v, i) => {
    if (!ok(mean[i])) return NaN;
    let dev = 0;
    for (let j = i - p + 1; j <= i; j++) dev += Math.abs(tp[j] - mean[i]);
    dev /= p;
    return dev === 0 ? 0 : (v - mean[i]) / (0.015 * dev);
  });
}

export function adx(c, p = 14) {
  const plus = blank(c.length);
  const minus = blank(c.length);
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(c);
  tr[0] = NaN;
  const str = rma(tr, p);
  const plusDI = rma(plus, p).map((v, i) => (100 * v) / str[i]);
  const minusDI = rma(minus, p).map((v, i) => (100 * v) / str[i]);
  const dx = plusDI.map((v, i) => (v + minusDI[i] === 0 ? 0 : (100 * Math.abs(v - minusDI[i])) / (v + minusDI[i])));
  return { adx: rma(dx, p), plusDI, minusDI };
}

export function obv(c) {
  const out = blank(c.length);
  let total = 0;
  c.forEach((x, i) => {
    if (i > 0) total += x.close > c[i - 1].close ? x.volume : x.close < c[i - 1].close ? -x.volume : 0;
    out[i] = total;
  });
  return out;
}

// Volume-weighted average price over the last `p` candles.
export function vwap(c, p = 20) {
  const pv = c.map(x => ((x.high + x.low + x.close) / 3) * x.volume);
  const sp = sma(pv, p);
  const sv = sma(c.map(x => x.volume), p);
  return sp.map((v, i) => (sv[i] > 0 ? v / sv[i] : NaN));
}

export function mfi(c, p = 14) {
  const tp = c.map(x => (x.high + x.low + x.close) / 3);
  const out = blank(c.length);
  for (let i = p; i < c.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const flow = tp[j] * c[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = pos + neg === 0 ? NaN : neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

// Channel of the previous `p` candles, so today's close can break out of it.
export function donchian(c, p = 20) {
  const hh = highest(c.map(x => x.high), p);
  const ll = lowest(c.map(x => x.low), p);
  return { upper: [NaN, ...hh.slice(0, -1)], lower: [NaN, ...ll.slice(0, -1)] };
}

export function keltner(c, p = 20, m = 2) {
  const mid = ema(closes(c), p);
  const a = atr(c, p);
  return { mid, upper: mid.map((v, i) => v + m * a[i]), lower: mid.map((v, i) => v - m * a[i]) };
}

export function parabolicSar(c, step = 0.02, max = 0.2) {
  const sar = blank(c.length);
  const up = new Array(c.length).fill(null);
  if (c.length < 2) return { sar, up };
  let long = c[1].close >= c[0].close;
  let ep = long ? c[0].high : c[0].low;
  let s = long ? c[0].low : c[0].high;
  let af = step;
  for (let i = 1; i < c.length; i++) {
    s += af * (ep - s);
    if (long) {
      s = Math.min(s, c[i - 1].low, i > 1 ? c[i - 2].low : c[i - 1].low);
      if (c[i].low < s) { long = false; s = ep; ep = c[i].low; af = step; } else if (c[i].high > ep) { ep = c[i].high; af = Math.min(max, af + step); }
    } else {
      s = Math.max(s, c[i - 1].high, i > 1 ? c[i - 2].high : c[i - 1].high);
      if (c[i].high > s) { long = true; s = ep; ep = c[i].high; af = step; } else if (c[i].low < ep) { ep = c[i].low; af = Math.min(max, af + step); }
    }
    sar[i] = s;
    up[i] = long;
  }
  return { sar, up };
}

export function supertrend(c, p = 10, m = 3) {
  const a = atr(c, p);
  const line = blank(c.length);
  const up = new Array(c.length).fill(null);
  let upper = NaN;
  let lower = NaN;
  let long = true;
  for (let i = 0; i < c.length; i++) {
    if (!ok(a[i])) continue;
    const hl2 = (c[i].high + c[i].low) / 2;
    const bu = hl2 + m * a[i];
    const bl = hl2 - m * a[i];
    const prevClose = i > 0 ? c[i - 1].close : c[i].close;
    upper = !ok(upper) || bu < upper || prevClose > upper ? bu : upper;
    lower = !ok(lower) || bl > lower || prevClose < lower ? bl : lower;
    if (long && c[i].close < lower) long = false;
    else if (!long && c[i].close > upper) long = true;
    line[i] = long ? lower : upper;
    up[i] = long;
  }
  return { line, up };
}

// Ichimoku spans are returned unshifted: the cloud under candle i is span[i - 26].
export function ichimoku(c, t = 9, k = 26, s = 52) {
  const hi = c.map(x => x.high);
  const lo = c.map(x => x.low);
  const mid = p => {
    const ll = lowest(lo, p);
    return highest(hi, p).map((h, i) => (h + ll[i]) / 2);
  };
  const tenkan = mid(t);
  const kijun = mid(k);
  const spanA = tenkan.map((v, i) => (v + kijun[i]) / 2);
  const spanB = mid(s);
  return { tenkan, kijun, spanA, spanB, shift: k };
}

// Classic floor pivots from the previous candle.
export function pivots(c, i) {
  if (i < 1) return null;
  const { high: h, low: l, close: cl } = c[i - 1];
  const p = (h + l + cl) / 3;
  return { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) };
}

// Indices of swing highs and lows confirmed by `w` candles on each side, up to `end`.
export function swings(c, end, w = 3, lookback = 150) {
  const highs = [];
  const lows = [];
  for (let i = Math.max(w, end - lookback); i <= end - w; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) isHigh = false;
      if (c[j].low <= c[i].low) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}

// Retracement of the largest move in the last `p` candles.
export function fibonacci(c, end, p = 100) {
  const start = Math.max(0, end - p + 1);
  let hi = start;
  let lo = start;
  for (let i = start; i <= end; i++) {
    if (c[i].high > c[hi].high) hi = i;
    if (c[i].low < c[lo].low) lo = i;
  }
  const high = c[hi].high;
  const low = c[lo].low;
  const rising = lo < hi; // low came first, so the move was up
  const range = high - low;
  const level = r => (rising ? high - r * range : low + r * range);
  return { high, low, rising, levels: { 0.236: level(0.236), 0.382: level(0.382), 0.5: level(0.5), 0.618: level(0.618), 0.786: level(0.786) } };
}

// Common one- and two-candle patterns at candle i.
export function candlePattern(c, i) {
  if (i < 1) return null;
  const x = c[i];
  const prev = c[i - 1];
  const body = Math.abs(x.close - x.open);
  const range = x.high - x.low || 1e-12;
  const upperWick = x.high - Math.max(x.open, x.close);
  const lowerWick = Math.min(x.open, x.close) - x.low;
  if (prev.close < prev.open && x.close > x.open && x.close >= prev.open && x.open <= prev.close) return 'bullish engulfing';
  if (prev.close > prev.open && x.close < x.open && x.close <= prev.open && x.open >= prev.close) return 'bearish engulfing';
  if (body / range < 0.35 && lowerWick > 2 * body && upperWick < body) return 'hammer';
  if (body / range < 0.35 && upperWick > 2 * body && lowerWick < body) return 'shooting star';
  if (body / range < 0.1) return 'doji';
  return null;
}
