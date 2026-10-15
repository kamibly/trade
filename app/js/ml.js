// Machine-learning votes. The models are trained weekly on your OCI server
// (server/ml.py) and saved as plain JSON, so both the server and the phone run
// them here with the same code: a LightGBM tree ensemble on indicator features
// and a small LSTM network on the recent sequence of price moves.

export const HORIZON = 10; // candles ahead the models predict
export const FEE = 0.001; // the same per-side fee as the backtest
export const SEQ_LEN = 32; // candles the LSTM reads
export const MIN_HIT = 0.5; // a model must beat a coin flip in its own test to vote

const ok = Number.isFinite;
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- Features ---------------------------------------------------------------

// Extra numeric features next to the 30 method votes. Each is scaled so
// symbols at very different prices look alike.
const EXTRA = {
  ret1: (S, i) => logRet(S, i, 1) / atrPct(S, i),
  ret5: (S, i) => logRet(S, i, 5) / atrPct(S, i),
  ret10: (S, i) => logRet(S, i, 10) / atrPct(S, i),
  ret20: (S, i) => logRet(S, i, 20) / atrPct(S, i),
  atrPct: (S, i) => atrPct(S, i) * 100,
  rsi: (S, i) => S.rsi[i] / 100,
  adx: (S, i) => S.adx.adx[i] / 100,
  sma50Dist: (S, i) => (S.close[i] - S.sma50[i]) / S.atr[i],
  sma200Dist: (S, i) => (S.close[i] - S.sma200[i]) / S.atr[i],
  bbWidth: (S, i) => S.bb.width[i],
  volRatio: (S, i) => (S.volAvg && S.volAvg[i] > 0 ? S.candles[i].volume / S.volAvg[i] : NaN),
};

function logRet(S, i, k) {
  return i - k >= 0 ? Math.log(S.close[i] / S.close[i - k]) : NaN;
}

function atrPct(S, i) {
  return S.atr[i] / S.close[i];
}

// Feature names for a model: one per method vote, then the extras.
export function featureNames(methodIds) {
  return [...methodIds.map(id => `vote:${id}`), ...Object.keys(EXTRA)];
}

// The feature vector for candle i, in the order of `names`. Missing values are NaN.
export function featureVector(S, i, baseVotes, names) {
  const votes = Object.fromEntries(baseVotes.map(v => [v.id, v.vote]));
  return names.map(name => {
    if (name.startsWith('vote:')) {
      const v = votes[name.slice(5)];
      return v === undefined ? NaN : v;
    }
    const f = EXTRA[name];
    const v = f ? f(S, i) : NaN;
    return ok(v) ? v : NaN;
  });
}

// The LSTM's input: the last SEQ_LEN candles as [move, volume change], each
// move divided by the typical move size so every symbol is on one scale.
export function sequence(S, i) {
  if (i < SEQ_LEN) return null;
  const rets = [];
  for (let k = i - SEQ_LEN + 1; k <= i; k++) rets.push(Math.log(S.close[k] / S.close[k - 1]));
  const sd = Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length) || 1e-9;
  const out = [];
  for (let k = i - SEQ_LEN + 1, j = 0; k <= i; k++, j++) {
    const v0 = S.candles[k - 1].volume;
    const v1 = S.candles[k].volume;
    const vol = v0 > 0 && v1 > 0 ? clamp(Math.log(v1 / v0), -3, 3) : 0;
    out.push([clamp(rets[j] / sd, -5, 5), vol]);
  }
  return out;
}

// 1 when the price is up by more than the round-trip fee HORIZON candles later.
export function label(S, i) {
  if (i + HORIZON >= S.close.length) return null;
  return S.close[i + HORIZON] / S.close[i] - 1 > 2 * FEE ? 1 : 0;
}

// ---- LightGBM ----------------------------------------------------------------

// model.trees: [{ nodes: [[feature, threshold, left, right, defaultLeft, missing]], leaves: [values] }]
// Children >= 0 are node indexes; a negative child -k-1 is leaf k.
// `missing` follows LightGBM: 0 = None (NaN counts as 0), 1 = Zero, 2 = NaN.
function treeValue(tree, x) {
  if (!tree.nodes.length) return tree.leaves[0];
  let n = 0;
  for (;;) {
    const [f, threshold, left, right, defaultLeft, missing] = tree.nodes[n];
    let v = x[f];
    let goLeft;
    if (missing === 2 && !ok(v)) goLeft = defaultLeft;
    else if (missing === 1 && (!ok(v) || v === 0)) goLeft = defaultLeft;
    else {
      if (!ok(v)) v = 0;
      goLeft = v <= threshold;
    }
    const next = goLeft ? left : right;
    if (next < 0) return tree.leaves[-next - 1];
    n = next;
  }
}

export function lgbmProbability(model, x) {
  let raw = model.init || 0;
  for (const t of model.trees) raw += treeValue(t, x);
  return sigmoid(raw);
}

// ---- LSTM ---------------------------------------------------------------------

// PyTorch layout: wIh [4H][I], wHh [4H][H], bIh, bHh [4H], gates in order i, f, g, o;
// then a linear layer out = wOut . h + bOut.
export function lstmProbability(model, seq) {
  const H = model.hidden;
  let h = new Array(H).fill(0);
  let c = new Array(H).fill(0);
  for (const xt of seq) {
    const gates = new Array(4 * H);
    for (let r = 0; r < 4 * H; r++) {
      let s = model.bIh[r] + model.bHh[r];
      const wi = model.wIh[r];
      for (let k = 0; k < xt.length; k++) s += wi[k] * xt[k];
      const wh = model.wHh[r];
      for (let k = 0; k < H; k++) s += wh[k] * h[k];
      gates[r] = s;
    }
    const nh = new Array(H);
    const nc = new Array(H);
    for (let k = 0; k < H; k++) {
      const ig = sigmoid(gates[k]);
      const fg = sigmoid(gates[H + k]);
      const gg = Math.tanh(gates[2 * H + k]);
      const og = sigmoid(gates[3 * H + k]);
      nc[k] = fg * c[k] + ig * gg;
      nh[k] = og * Math.tanh(nc[k]);
    }
    h = nh;
    c = nc;
  }
  let out = model.bOut;
  for (let k = 0; k < H; k++) out += model.wOut[k] * h[k];
  return sigmoid(out);
}

// ---- Votes --------------------------------------------------------------------

export const usable = m => !!m && m.test && m.test.hit > MIN_HIT && m.test.n >= 200;

const describe = (p, m) => `${Math.round(p * 100)}% chance higher in ${HORIZON} candles · right ${Math.round(m.test.hit * 100)}% in its test`;

// models: { cutoff, lgbm, lstm } for this timeframe. Only candles after the
// cutoff get votes: earlier ones were used for training, so votes there would
// flatter the backtest.
export function mlVotes(S, i, baseVotes, models) {
  if (!models || !(S.candles[i].time > models.cutoff)) return [];
  const out = [];
  const { lgbm, lstm } = models;
  if (usable(lgbm)) {
    const p = lgbmProbability(lgbm, featureVector(S, i, baseVotes, lgbm.features));
    out.push({ id: 'lgbm', name: 'LightGBM (gradient-boosted trees)', group: 'ml', vote: clamp((p - 0.5) * 4, -1, 1), note: describe(p, lgbm) });
  }
  if (usable(lstm)) {
    const seq = sequence(S, i);
    if (seq) {
      const p = lstmProbability(lstm, seq);
      out.push({ id: 'lstm', name: 'LSTM neural network', group: 'ml', vote: clamp((p - 0.5) * 4, -1, 1), note: describe(p, lstm) });
    }
  }
  return out;
}
