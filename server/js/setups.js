// Opportunity setups that read more than the price chart: insider buying,
// earnings reactions, the market's strongest symbols and crypto crowd
// extremes. Each detector only looks at what was known on the candle it
// fires on, so the track record it builds from past candles is honest.
// Times are in seconds, like the candles. Daily candles only.

import { feeRate } from './fees.js';
import { rsi, sma } from './indicators.js';
import { contextAt } from './signals.js';

export const SETUPS = {
  insider: { name: 'Insider buying', hold: 20, kind: 'stock' },
  earnings: { name: 'Earnings drift', hold: 20, kind: 'stock' },
  ranking: { name: 'Market leader on a pullback', hold: 10, kind: 'any' },
  crowd: { name: 'Crowd extreme', hold: 10, kind: 'crypto' },
};

export const MIN_PROVEN = 30; // cases a setup needs before it may send alerts
const DAY = 86400;
const ok = Number.isFinite;

// ---- Insider buying -------------------------------------------------------------

export const INSIDER = { windowDays: 30, minPeople: 2, minValue: 100_000 };

// Clusters of open-market purchases by different insiders. `purchases` are
// { filed, owner, name, role, value } with `filed` the SEC filing date: a
// cluster becomes known when its last filing is public, and the trade is
// entered at the close of the next session.
// result: [{ i, people, value, names }] one per cluster (not one per filing)
export function insiderTriggers(candles, purchases, opts = INSIDER) {
  if (!purchases || !purchases.length) return [];
  const list = [...purchases].filter(p => ok(p.filed) && p.value > 0).sort((a, b) => a.filed - b.filed);
  const out = [];
  let lastAt = -Infinity;
  for (let k = 0; k < list.length; k++) {
    const now = list[k].filed;
    if (now - lastAt < opts.windowDays * DAY) continue; // still the same cluster
    const recent = list.slice(0, k + 1).filter(p => p.filed > now - opts.windowDays * DAY);
    const owners = new Map();
    for (const p of recent) owners.set(p.owner, (owners.get(p.owner) || { name: p.name, role: p.role, value: 0 }));
    for (const p of recent) owners.get(p.owner).value += p.value;
    const value = recent.reduce((a, p) => a + p.value, 0);
    if (owners.size < opts.minPeople || value < opts.minValue) continue;
    const i = candles.findIndex(c => c.time >= now + DAY);
    if (i < 1) continue;
    lastAt = now;
    out.push({ i, people: owners.size, value, names: [...owners.values()].sort((a, b) => b.value - a.value).slice(0, 3).map(o => o.role || o.name) });
  }
  return out;
}

// ---- Earnings -------------------------------------------------------------------

// The first candle that could react to results released at `at` (seconds):
// daily candles are stamped at the open, so results out before the open
// belong to that day and results after the close to the next one.
export function reactionIndex(candles, at) {
  return candles.findIndex(c => c.time >= at);
}

// Strong reactions to earnings: a gap of at least 1 ATR from the last close,
// a close in the top half of the day's range and at least twice normal volume
// (the drift setup), plus gap-downs for holdings warnings.
// result: [{ i, gap, up }] (gap in ATRs; `up` marks the drift setup)
export function earningsTriggers(S, releases) {
  if (!releases || !releases.length) return [];
  const c = S.candles;
  const vol = sma(c.map(x => x.volume), 20);
  const out = [];
  for (const at of releases) {
    const i = reactionIndex(c, at);
    if (i < 1) continue;
    const atr = S.atr[i - 1];
    if (!ok(atr) || atr <= 0) continue;
    const gap = (c[i].open - c[i - 1].close) / atr;
    const strongClose = c[i].close >= (c[i].high + c[i].low) / 2;
    const heavy = ok(vol[i - 1]) && vol[i - 1] > 0 && c[i].volume >= 2 * vol[i - 1];
    if (gap >= 1 && strongClose && heavy) out.push({ i, gap, up: true });
    else if (gap <= -1) out.push({ i, gap, up: false });
  }
  return out;
}

// ---- Market leaders ---------------------------------------------------------------

const RS_FROM = 126; // about 6 months of trading days
const RS_SKIP = 21; // leave out the last month (short-term moves tend to reverse)
export const LEADER = 0.9; // top 10% of the ranking

// Strength against a benchmark at candle i: the 6-month return without the
// last month, less the benchmark's over the same days. NaN without history.
export function relativeStrength(S, i, benchClose) {
  if (i < RS_FROM) return NaN;
  const c = S.close;
  const t1 = S.candles[i - RS_SKIP].time;
  const t0 = S.candles[i - RS_FROM].time;
  const b1 = benchClose.get(t1);
  const b0 = benchClose.get(t0);
  if (!ok(b1) || !ok(b0) || !(c[i - RS_FROM] > 0)) return NaN;
  return Math.log(c[i - RS_SKIP] / c[i - RS_FROM]) - Math.log(b1 / b0);
}

// Day (UTC) of a candle, so stocks and their benchmark line up whatever the hour.
const dayOf = t => Math.floor(t / DAY);

// Percentile ranks per day. `rows` is [{ key, S, group }] all of one asset
// class; `bench` is that class's benchmark S. The composite rank mixes each
// symbol's own strength (70%) with its group's (30%; sectors for stocks).
// result: Map key → Map day → rank 0..1
export function rankings(rows, bench) {
  const benchClose = new Map(bench.candles.map((c, i) => [c.time, bench.close[i]]));
  // Benchmark closes by day too, for symbols stamped at other hours.
  const benchDay = new Map(bench.candles.map((c, i) => [dayOf(c.time), bench.close[i]]));
  const lookup = { get: t => (benchClose.has(t) ? benchClose.get(t) : benchDay.get(dayOf(t))) };
  const byDay = new Map(); // day → [{ key, rs, group }]
  for (const r of rows) {
    for (let i = RS_FROM; i < r.S.candles.length; i++) {
      const rs = relativeStrength(r.S, i, lookup);
      if (!ok(rs)) continue;
      const d = dayOf(r.S.candles[i].time);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push({ key: r.key, rs, group: r.group || null });
    }
  }
  const out = new Map(rows.map(r => [r.key, new Map()]));
  for (const [d, list] of byDay) {
    if (list.length < 10) continue; // too few symbols that day to rank
    const pct = rankOf(list.map(x => x.rs));
    const groups = new Map();
    for (const x of list) if (x.group) (groups.get(x.group) || groups.set(x.group, []).get(x.group)).push(x.rs);
    const gNames = [...groups.keys()];
    const gPct = new Map(gNames.map((g, k) => [g, rankOf(gNames.map(n => mean(groups.get(n))))[k]]));
    list.forEach((x, k) => {
      const own = pct[k];
      out.get(x.key).set(d, x.group && gNames.length > 1 ? 0.7 * own + 0.3 * gPct.get(x.group) : own);
    });
  }
  return out;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// Percentile (0 = weakest, 1 = strongest) of each value in its list.
function rankOf(values) {
  const order = values.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  order.forEach(([, k], pos) => { out[k] = values.length > 1 ? pos / (values.length - 1) : 1; });
  return out;
}

// A healthy market: the benchmark above its 200-candle average and the 50 above the 200.
export function healthyDays(bench) {
  const out = new Set();
  bench.candles.forEach((c, i) => {
    if (bench.close[i] > bench.sma200[i] && bench.sma50[i] > bench.sma200[i]) out.add(dayOf(c.time));
  });
  return out;
}

// A leader in its own uptrend after a short pullback, in a healthy market.
// result: [{ i, rank }]
export function rankingTriggers(S, ranks, healthy) {
  if (!ranks) return [];
  const rsi2 = rsi(S.close, 2);
  const out = [];
  let last = -Infinity;
  for (let i = 3; i < S.candles.length; i++) {
    const d = dayOf(S.candles[i].time);
    const rank = ranks.get(d);
    if (!(rank >= LEADER) || !healthy.has(d)) continue;
    if (!contextAt(S, i).uptrend) continue;
    const c = S.close;
    const pulled = rsi2[i] < 10 || (c[i] < c[i - 1] && c[i - 1] < c[i - 2] && c[i - 2] < c[i - 3]);
    if (!pulled || i - last < 5) continue;
    last = i;
    out.push({ i, rank });
  }
  return out;
}

// ---- Crypto crowd extremes -----------------------------------------------------------

export const CROWD = { fear: 15, greed: 85, low: 0.05, high: 0.95, minDays: 90 };
export const FNG_COINS = new Set(['BTC', 'ETH']); // the index describes the whole market

// Percentile of the last value among the past year's values (causal). Ties
// count half, so a rate that often sits at its floor isn't always "extreme".
function trailingPct(series, k) {
  const from = Math.max(0, k - 365);
  const past = series.slice(from, k);
  if (past.length < CROWD.minDays) return NaN;
  const v = series[k][1];
  const below = past.filter(p => p[1] < v).length;
  const same = past.filter(p => p[1] === v).length;
  return (below + same / 2) / past.length;
}

// Fear & Greed (`fng`: [[day seconds, value]]) and this coin's daily funding
// (`funding`: [[day seconds, rate]]) at their extremes. Buys fire on the
// crowd betting on a drop; cautions on the crowd piling in.
// result: [{ i, side: 'buy' | 'caution', why }]
export function crowdTriggers(S, symbol, fng, funding) {
  const c = S.candles;
  const at = new Map();
  const add = (t, side, why) => {
    const i = c.findIndex(x => x.time >= t + DAY);
    if (i < 1) return;
    const prev = at.get(i);
    if (!prev || (prev.side === 'caution' && side === 'buy')) at.set(i, { i, side, why });
  };
  if (FNG_COINS.has(symbol) && fng) {
    for (let k = 1; k < fng.length; k++) {
      const [t, v] = fng[k];
      const before = fng[k - 1][1];
      if (v <= CROWD.fear && before > CROWD.fear) add(t, 'buy', `Fear & Greed at ${v} (extreme fear)`);
      if (v >= CROWD.greed && before < CROWD.greed) add(t, 'caution', `Fear & Greed at ${v} (extreme greed)`);
    }
  }
  if (funding && funding.length > CROWD.minDays) {
    let state = 0;
    for (let k = CROWD.minDays; k < funding.length; k++) {
      const p = trailingPct(funding, k);
      if (!ok(p)) continue;
      const now = p <= CROWD.low ? -1 : p >= CROWD.high ? 1 : 0;
      const rate = `${(funding[k][1] * 100).toFixed(3)}%`;
      if (now === -1 && state !== -1) add(funding[k][0], 'buy', `Funding ${rate} a day, lower than 95% of the past year (traders betting on a drop)`);
      if (now === 1 && state !== 1) add(funding[k][0], 'caution', `Funding ${rate} a day, higher than 95% of the past year (traders piled in)`);
      state = now;
    }
  }
  return [...at.values()].sort((a, b) => a.i - b.i);
}

// ---- Outcomes and track records ------------------------------------------------------

// What a trade entered at candle i's close did: stop and target in ATRs like
// the paper account, otherwise sold at the close `hold` candles later.
// null while the trade would still be open.
export function outcome(S, i, { hold, stopAtr = 2, takeAtr = 3, fee = feeRate('stock') }) {
  const c = S.candles;
  const entry = S.close[i];
  const atr = S.atr[i];
  if (!ok(entry) || !ok(atr) || atr <= 0) return null;
  const stop = entry - stopAtr * atr;
  const take = entry + takeAtr * atr;
  for (let j = i + 1; j <= i + hold; j++) {
    if (j >= c.length) return null;
    if (c[j].low <= stop) return net(entry, Math.min(c[j].open, stop), fee);
    if (c[j].high >= take) return net(entry, Math.max(c[j].open, take), fee);
  }
  return net(entry, S.close[i + hold], fee);
}

const net = (entry, exit, fee) => (exit / entry) * (1 - fee) * (1 - fee) - 1;

export const emptyRecord = () => ({ n: 0, wins: 0, sum: 0 });

export function addOutcome(rec, ret) {
  if (!ok(ret)) return rec;
  rec.n += 1;
  rec.wins += ret > 0 ? 1 : 0;
  rec.sum += ret;
  return rec;
}

// { n, wins, avg } for the app and alerts.
export const recordOf = rec => ({ n: rec.n, wins: rec.wins, avg: rec.n ? Number((rec.sum / rec.n).toFixed(5)) : 0 });

// A setup may alert once it has enough cases and made money on average after fees.
export const proven = r => !!r && r.n >= MIN_PROVEN && r.avg > 0;

export const pct = v => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

// "After past cases like this: 61% higher 20 days later, average +3.8% (n 212)."
export function recordLine(r, hold) {
  if (!r || !r.n) return 'No past cases yet.';
  return `After ${r.n} past cases: ${Math.round((r.wins / r.n) * 100)}% made money within ${hold} days, average ${pct(r.avg)} after fees.`;
}
