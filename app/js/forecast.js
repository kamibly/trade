// Statistical forecasts. Each works on closing prices up to a given candle so
// the same code can score today and replay the past. No browser dependencies.

// Standard normal cumulative distribution (Abramowitz and Stegun 7.1.26).
export function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Inverse of normCdf (Acklam's approximation), for percentile bands.
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Least-squares line through values[end-n+1..end], x = 0..n-1.
export function linearRegression(values, end, n) {
  const start = end - n + 1;
  if (start < 0) return null;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let k = 0; k < n; k++) {
    const y = values[start + k];
    sx += k; sy += y; sxx += k * k; sxy += k * y;
  }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  let ssRes = 0; let ssTot = 0;
  const mean = sy / n;
  for (let k = 0; k < n; k++) {
    const y = values[start + k];
    ssRes += (y - (intercept + slope * k)) ** 2;
    ssTot += (y - mean) ** 2;
  }
  return {
    slope,
    intercept,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    sd: Math.sqrt(ssRes / n),
    at: k => intercept + slope * k, // k counted from the window's first candle
    n,
  };
}

// Holt's linear trend smoothing with a damped trend (Holt-Winters without a
// season, since markets have none worth modelling here).
export function holt(values, alpha = 0.3, beta = 0.05) {
  const level = new Array(values.length).fill(NaN);
  const trend = new Array(values.length).fill(NaN);
  if (values.length < 2) return { level, trend };
  let l = values[0];
  let t = values[1] - values[0];
  for (let i = 1; i < values.length; i++) {
    const prevL = l;
    l = alpha * values[i] + (1 - alpha) * (l + t);
    t = beta * (l - prevL) + (1 - beta) * t;
    level[i] = l;
    trend[i] = t;
  }
  return { level, trend };
}

export function holtForecast(h, i, steps, phi = 0.95) {
  let damp = 0;
  for (let k = 1; k <= steps; k++) damp += phi ** k;
  return h.level[i] + damp * h.trend[i];
}

export function logReturns(values, end, n) {
  const out = [];
  for (let i = Math.max(1, end - n + 1); i <= end; i++) out.push(Math.log(values[i] / values[i - 1]));
  return out;
}

// Solves a small linear system by Gaussian elimination with pivoting.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// ARIMA(p,1,0): an autoregressive model on log returns (the "1" is the
// differencing into returns), fitted by least squares. Returns the expected
// total log return over the next `steps` candles, or null without enough data.
export function arimaForecast(values, end, { p = 3, n = 120, steps = 5 } = {}) {
  const r = logReturns(values, end, n);
  if (r.length < p * 10) return null;
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const y = r.map(x => x - mean);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let t = p; t < y.length; t++) {
    for (let a = 0; a < p; a++) {
      b[a] += y[t] * y[t - 1 - a];
      for (let c = 0; c < p; c++) A[a][c] += y[t - 1 - a] * y[t - 1 - c];
    }
  }
  for (let a = 0; a < p; a++) A[a][a] += 1e-9; // keeps flat series solvable
  const phi = solve(A, b);
  if (!phi) return null;
  const hist = y.slice(-p).reverse(); // most recent first
  let total = 0;
  for (let s = 0; s < steps; s++) {
    const next = phi.reduce((sum, f, k) => sum + f * hist[k], 0);
    total += next + mean;
    hist.unshift(next);
    hist.pop();
  }
  return { total, phi };
}

// Drift and volatility per candle for geometric Brownian motion.
export function gbmParams(values, end, n = 100) {
  const r = logReturns(values, end, n);
  if (r.length < 20) return null;
  const mu = r.reduce((s, x) => s + x, 0) / r.length;
  const sigma = Math.sqrt(r.reduce((s, x) => s + (x - mu) ** 2, 0) / (r.length - 1));
  return { mu, sigma };
}

// Chance the price is higher after `steps` candles under that model.
export function probUp({ mu, sigma }, steps) {
  if (sigma === 0) return mu > 0 ? 1 : mu < 0 ? 0 : 0.5;
  return normCdf((mu * Math.sqrt(steps)) / sigma);
}

// Small seeded random generator so a forecast draws the same on every load.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Monte Carlo price paths; returns the 10th, 50th and 90th percentile per step.
export function monteCarlo(start, { mu, sigma }, steps, { paths = 500, seed = 7 } = {}) {
  const rand = mulberry32(seed);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const at = Array.from({ length: steps }, () => new Float64Array(paths));
  for (let p = 0; p < paths; p++) {
    let price = start;
    for (let s = 0; s < steps; s++) {
      price *= Math.exp(mu - (sigma * sigma) / 2 + sigma * gauss());
      at[s][p] = price;
    }
  }
  const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))];
  return at.map(arr => {
    arr.sort();
    return { p10: pct(arr, 0.1), p50: pct(arr, 0.5), p90: pct(arr, 0.9) };
  });
}

// Hurst exponent by rescaled range: above 0.5 trends persist, below 0.5 they revert.
export function hurst(values, end, n = 128) {
  const r = logReturns(values, end, n);
  if (r.length < 64) return null;
  const xs = [];
  const ys = [];
  for (let size = 8; size <= r.length / 2; size *= 2) {
    let total = 0;
    let count = 0;
    for (let s = 0; s + size <= r.length; s += size) {
      const chunk = r.slice(s, s + size);
      const mean = chunk.reduce((a, b) => a + b, 0) / size;
      let cum = 0; let max = -Infinity; let min = Infinity; let ss = 0;
      for (const x of chunk) {
        cum += x - mean;
        max = Math.max(max, cum);
        min = Math.min(min, cum);
        ss += (x - mean) ** 2;
      }
      const sd = Math.sqrt(ss / size);
      if (sd > 0) { total += (max - min) / sd; count++; }
    }
    if (count) { xs.push(Math.log(size)); ys.push(Math.log(total / count)); }
  }
  if (xs.length < 2) return null;
  const fit = linearRegression(ys, ys.length - 1, ys.length);
  // The regression's x is 0..k-1; rescale the slope to log(size) steps of log 2.
  return fit.slope / Math.log(2);
}
