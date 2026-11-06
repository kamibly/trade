// The chart levels check: would Buys do better with the stop just under
// support and the target at resistance, instead of 2 and 3 ATR away?
//
// It takes every candle that looks like a Buy (the trade filter's rule: an
// equal-weight score of 15 or more) on the daily charts the ML trains on, and
// plays each one out over the next 30 candles four ways:
//   fixed         stop and target from your settings (2 and 3 ATR)
//   levels        stop a quarter ATR under the nearest support, target at the
//                 nearest resistance (the `sr` method's swing levels)
//   levels 2:1    the same, only when the target is at least twice the stop
//   fixed, same   fixed levels on the same candles as "levels 2:1", so the
//                 difference between those two rows is the exit alone
//   scored, scored 2:1, fixed, same s
//                 the same with srLevels: zones ranked by recent, big-bounce,
//                 high-volume touches (what the chart draws)
//   zones, zones 2:1, fixed, same z
//                 the same three with srZones: levels the price turned at
//                 more than once (the stop under the top of the support zone,
//                 the target at the bottom of the resistance zone)
// Fees are taken off. Each row shows the average result per trade and per unit
// of risk (what a trade sized by the 1% risk rule earns), for the older and the
// newer half of the history apart: a rule only passes if it wins in both.
//
// Run on the server (it needs the chart history):
//   docker exec trade-service python levels_check.py
import { analyze, baseVotesAt, scoreVotes, MIN_CANDLES } from './js/signals.js';
import { swings, srZones, srLevels } from './js/indicators.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MIN_SCORE } from './js/filter.js';
import { feeRate } from './js/fees.js';
import { candlesFor, trainingItems, defaultDeps } from './engine.mjs';

export const HOLD = 30;        // candles a trade may run (as the scoreboard and ML labels)
export const BUFFER = 0.25;    // ATRs under support for the stop
export const RATIO = 2;        // target at least this many times the stop
export const STOP_MIN = 0.5, STOP_MAX = 4;  // ATRs: closer or further stops are left out

// Plays out a Buy at candle i's close: { win, ret, days } after fees (days =
// candles until it closed), or null when the chart ends first.
export function playOut(S, i, stop, take, type) {
  if (i + HOLD >= S.close.length) return null;
  const c = S.close[i];
  const fee = feeRate(type);
  const net = exit => (exit / c) * (1 - fee) * (1 - fee) - 1;
  for (let j = i + 1; j <= i + HOLD; j++) {
    const b = S.candles[j];
    if (b.low <= stop) return { win: 0, ret: net(Math.min(b.open, stop)), days: j - i };
    if (b.high >= take) return { win: 1, ret: net(Math.max(b.open, take)), days: j - i };
  }
  return { win: 0, ret: net(S.close[i + HOLD]), days: HOLD };
}

// Support and resistance at candle i, from swing points confirmed by then.
export function levelsAt(S, i) {
  const { highs, lows } = swings(S.candles, i, 3, 120);
  const c = S.close[i];
  const res = highs.map(k => S.candles[k].high).filter(h => h > c).sort((a, b) => a - b)[0];
  const sup = lows.map(k => S.candles[k].low).filter(l => l < c).sort((a, b) => b - a)[0];
  return { sup, res };
}

const ROWS = ['fixed', 'levels', 'levels 2:1', 'fixed, same', 'zones', 'zones 2:1', 'fixed, same z', 'scored', 'scored 2:1', 'fixed, same s'];

// One chart's trades: [{ row, t, ret, risk, win }], risk = the stop's distance as a share.
export function tradesOf(S, type, { stopAtr = 2, takeAtr = 3 } = {}) {
  const out = [];
  for (let i = MIN_CANDLES - 1; i + HOLD < S.close.length; i++) {
    const c = S.close[i];
    const atr = S.atr[i];
    if (!(c > 0) || !(atr > 0)) continue;
    if (scoreVotes(baseVotesAt(S, i), {}) < MIN_SCORE) continue;
    const t = S.candles[i].time;
    const add = (row, stop, take) => {
      const o = playOut(S, i, stop, take, type);
      if (o) out.push({ row, t, ret: o.ret, risk: (c - stop) / c, win: o.win });
    };
    const fs = c - stopAtr * atr, ft = c + takeAtr * atr;
    add('fixed', fs, ft);
    // Two ways to find the levels: the nearest swing (today's voter) and zones touched more than once.
    const tryLevels = (sup, res, [all, ratio, same]) => {
      if (!(sup > 0) || !(res > 0)) return;
      const ls = sup - BUFFER * atr;
      const dist = (c - ls) / atr;
      if (!(ls > 0) || dist < STOP_MIN || dist > STOP_MAX) return;
      add(all, ls, res);
      if (res - c >= RATIO * (c - ls)) {
        add(ratio, ls, res);
        add(same, fs, ft);
      }
    };
    const { sup, res } = levelsAt(S, i);
    tryLevels(sup, res, ['levels', 'levels 2:1', 'fixed, same']);
    const z = srZones(S.candles, i, atr);
    // A zone's near edge: the stop goes under the top of support, the target at the bottom of resistance.
    tryLevels(z.support && z.support.hi, z.resistance && z.resistance.lo, ['zones', 'zones 2:1', 'fixed, same z']);
    const sc = srLevels(S.candles, i, atr);
    tryLevels(sc.support && sc.support.hi, sc.resistance && sc.resistance.lo, ['scored', 'scored 2:1', 'fixed, same s']);
  }
  return out;
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// The table: per kind and row, trades, right, average % and R, by half.
export function summarize(trades) {
  const ts = trades.map(x => x.t).sort((a, b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const out = {};
  for (const row of ROWS) {
    const mine = trades.filter(x => x.row === row);
    const part = xs => ({
      n: xs.length,
      right: mean(xs.map(x => x.win)),
      pct: mean(xs.map(x => x.ret)) * 100,
      r: mean(xs.map(x => x.ret / x.risk)),
    });
    out[row] = { ...part(mine), older: part(mine.filter(x => x.t < mid)), newer: part(mine.filter(x => x.t >= mid)) };
  }
  const f = out.fixed;
  const beats = (x, y) => x.n >= 100 && y.n >= 100 && x.pct > y.pct && x.r > y.r;
  const passes = (a, b) => beats(a.older, b.older) && beats(a.newer, b.newer) && beats(a.older, f.older) && beats(a.newer, f.newer);
  out.passes = passes(out['levels 2:1'], out['fixed, same']);
  out.zonesPass = passes(out['zones 2:1'], out['fixed, same z']);
  out.scoredPass = passes(out['scored 2:1'], out['fixed, same s']);
  return out;
}

const f1 = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const sgn = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(d)}` : '–');

export function show(kind, s) {
  const lines = [`${kind}`, `${''.padEnd(14)}${'trades'.padStart(7)}${'right'.padStart(7)}${'avg %'.padStart(8)}${'avg R'.padStart(7)}   ${'older %'.padStart(8)}${'R'.padStart(6)}   ${'newer %'.padStart(8)}${'R'.padStart(6)}`];
  for (const row of ROWS) {
    const x = s[row];
    lines.push(`${row.padEnd(14)}${String(x.n).padStart(7)}${`${f1(x.right * 100, 0)}%`.padStart(7)}${sgn(x.pct).padStart(8)}${sgn(x.r).padStart(7)}   ${sgn(x.older.pct).padStart(8)}${sgn(x.older.r).padStart(6)}   ${sgn(x.newer.pct).padStart(8)}${sgn(x.newer.r).padStart(6)}`);
  }
  lines.push(`Levels 2:1 ${s.passes ? 'PASSES' : 'does not pass'}, zones 2:1 ${s.zonesPass ? 'PASSES' : 'does not pass'}, scored 2:1 ${s.scoredPass ? 'PASSES' : 'does not pass'} (beats both its fixed rows on % and R in both halves)`);
  return lines.join('\n');
}

// --sr: today's levels on your watchlist's daily charts, both ways, and the
// charts saved to DATA_DIR/research/sr-charts.json to share.
async function showLevels(job, deps) {
  const rows = [];
  const saved = {};
  const money = x => (Number.isFinite(x) ? x.toPrecision(x >= 1 ? Math.max(4, String(Math.floor(x)).length + 2) : 3) : '–');
  for (const item of job.items || []) {
    try {
      const { candles } = await candlesFor(item, '1D', job.settings, deps);
      const S = analyze(candles);
      const i = candles.length - 1;
      const old = levelsAt(S, i);
      const z = srZones(candles, i, S.atr[i]);
      const sc = srLevels(candles, i, S.atr[i]);
      const zone = x => (x ? `${money(x.price)} (${x.touches})` : '–');
      rows.push(`${item.symbol.padEnd(8)}${money(S.close[i]).padStart(11)}   ${money(old.sup).padStart(10)}${money(old.res).padStart(10)}   ${zone(z.support).padStart(14)}${zone(z.resistance).padStart(14)}   ${zone(sc.support).padStart(14)}${zone(sc.resistance).padStart(14)}`);
      saved[`${item.type}:${item.symbol}`] = candles.slice(-200).map(x => [x.time, x.open, x.high, x.low, x.close]);
    } catch (e) {
      rows.push(`${item.symbol.padEnd(8)} could not load: ${e.message}`);
    }
  }
  const dir = join(process.env.DATA_DIR || '/data', 'research');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'sr-charts.json'), JSON.stringify(saved));
  return [`${'symbol'.padEnd(8)}${'close'.padStart(11)}   ${'old sup'.padStart(10)}${'old res'.padStart(10)}   ${'zone sup'.padStart(14)}${'zone res'.padStart(14)}   ${'scored sup'.padStart(14)}${'scored res'.padStart(14)}`, ...rows,
    '', '(n) = touches. Charts saved to trade-data/research/sr-charts.json'].join('\n');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input);
  const deps = defaultDeps;
  if (process.argv.includes('--sr')) {
    process.stdout.write(`${await showLevels(job, deps)}\n`);
    return;
  }
  const printed = [];
  for (const [kind, total] of [['stock', job.total || 120], ['crypto', job.cryptoTotal || 50]]) {
    const items = await trainingItems({ ...job, kind, total }, deps);
    const trades = [];
    let charts = 0;
    for (const item of items) {
      try {
        const { candles } = await candlesFor(item, '1D', job.settings, deps);
        if (candles.length < MIN_CANDLES + HOLD + 20) continue;
        trades.push(...tradesOf(analyze(candles), item.type, job.settings));
        charts++;
      } catch (e) {
        // A chart that can't load is left out.
      }
    }
    printed.push(`${show(`${kind === 'stock' ? 'Stocks' : 'Crypto'}: ${charts} charts`, summarize(trades))}`);
  }
  process.stdout.write(`${printed.join('\n\n')}\n\navg %: per trade after fees. avg R: per unit of risk (a trade sized by the 1% rule earns R%).\nolder / newer: the two halves of the history.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exit(1);
  });
}
