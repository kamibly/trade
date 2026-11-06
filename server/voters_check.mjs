// The voters check: is each voter right more often than chance, on the daily
// charts the ML trains on? It grades every firm vote the way the scoreboard
// does (an up vote is right when a Buy's target, takeAtr up, comes before its
// stop, stopAtr down, within 30 candles; a down vote likewise for a Sell) and
// sets it against how often that happens anyway on the same charts.
//
// For each voter, each group (its voters' average vote) and the score itself:
//   up / down     firm calls (vote of 0.3 or more either way), how often right,
//                 and the edge over "anyway"
//   fresh         only the first candle of each run of calls, so a vote that
//                 stays on for weeks counts once
//   older / newer the edge of all calls in each half of the history apart
//   flipped       "yes" when both sides lose in both halves: the rule would do
//                 better turned around, which is what a sign error looks like
//
// --weights: sets voter weights from the older half of the history (only the
// voters that beat chance there) and grades the score with them on the newer
// half, next to today's equal weights.
//
// Run on the server (it needs the chart history):
//   docker exec trade-service python voters_check.py
//   docker exec trade-service python voters_check.py --weights
//   docker exec trade-service python voters_check.py --lines
//   docker exec trade-service python voters_check.py --exits
//
// --lines: today's score with Buy lines of 15 to 40. A trade opens when the
// score first reaches the line and closes at the stop, the target or after 30
// candles (no new trade on that chart until then).
// --exits: the same with other stops and targets (EXITS, in ATRs).
import { analyze, baseVotesAt, scoreVotes, MIN_CANDLES, GROUPS } from './js/signals.js';
import { turnLabels } from './js/ml.js';
import { candlesFor, trainingItems, defaultDeps } from './engine.mjs';
import { playOut } from './levels_check.mjs';

export const FIRM = 0.3;      // the scoreboard's firm vote
export const SCORE = 40;      // the score's Buy and Sell lines

// One chart's labelled candles: [{ t, votes: [[id, group, vote]], bottom, top, ret, days }],
// ret = a Buy's result after fees with the fixed stop and target (levels_check's playOut).
// `exits`: more [stopAtr, takeAtr] pairs to play each Buy out with, kept in row.exits.
export function rowsOf(S, settings = {}, type = 'stock', exits = []) {
  const rows = [];
  for (let i = MIN_CANDLES - 1; i < S.close.length; i++) {
    const lab = turnLabels(S, i, settings);
    if (!lab) continue;
    const votes = baseVotesAt(S, i);
    if (!votes.length) continue;
    const c = S.close[i], atr = S.atr[i];
    const o = playOut(S, i, c - (settings.stopAtr || 2) * atr, c + (settings.takeAtr || 3) * atr, type);
    const row = { t: S.candles[i].time, votes: votes.map(v => [v.id, v.group, v.vote]), bottom: lab.bottom, top: lab.top, ret: o ? o.ret : NaN, days: o ? o.days : NaN };
    if (exits.length) {
      row.exits = exits.map(([sa, ta]) => {
        const x = playOut(S, i, c - sa * atr, c + ta * atr, type);
        return x ? { ret: x.ret, days: x.days } : { ret: NaN, days: NaN };
      });
    }
    rows.push(row);
  }
  return rows;
}

const asVotes = row => row.votes.map(([id, group, vote]) => ({ id, group, vote }));

// Firm calls of every voter, group and the score: [{ id, side, t, right, fresh }].
// Rows must be one chart's, in order (fresh = the call before it was different).
export function callsOfRows(rows, weights = {}) {
  const calls = [];
  const base = [];
  let last = {};
  for (const row of rows) {
    const now = {};
    const lean = (id, v) => { if (v >= FIRM) now[id] = 'up'; else if (v <= -FIRM) now[id] = 'down'; };
    const groups = {};
    for (const [id, group, vote] of row.votes) {
      lean(id, vote);
      (groups[group] ||= []).push(vote);
    }
    for (const [g, list] of Object.entries(groups)) lean(`g:${g}`, list.reduce((a, b) => a + b, 0) / list.length);
    const score = scoreVotes(asVotes(row), weights);
    if (score >= SCORE) now.score = 'up';
    else if (score <= -SCORE) now.score = 'down';
    base.push({ t: row.t, bottom: row.bottom, top: row.top });
    for (const [id, side] of Object.entries(now)) {
      calls.push({ id, side, t: row.t, right: side === 'up' ? row.bottom : row.top, fresh: last[id] !== side });
    }
    last = now;
  }
  return { calls, base };
}

export const callsOf = (S, settings = {}) => callsOfRows(rowsOf(S, settings));

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// The table: per voter, side and half, the calls, how often right and the edge.
export function summarize({ calls, base }) {
  const ts = base.map(x => x.t).sort((a, b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const half = { older: x => x.t < mid, newer: x => x.t >= mid };
  const anyway = (side, keep = () => true) => mean(base.filter(keep).map(x => (side === 'up' ? x.bottom : x.top)));
  const rates = {
    up: { all: anyway('up'), older: anyway('up', half.older), newer: anyway('up', half.newer) },
    down: { all: anyway('down'), older: anyway('down', half.older), newer: anyway('down', half.newer) },
  };
  const ids = [...new Set(calls.map(c => c.id))];
  const rows = {};
  for (const id of ids) {
    const mine = calls.filter(c => c.id === id);
    const row = {};
    for (const side of ['up', 'down']) {
      const s = mine.filter(c => c.side === side);
      const part = (xs, rate) => ({ n: xs.length, right: mean(xs.map(c => c.right)), edge: mean(xs.map(c => c.right)) - rate });
      row[side] = {
        ...part(s, rates[side].all),
        fresh: part(s.filter(c => c.fresh), rates[side].all),
        older: part(s.filter(half.older), rates[side].older),
        newer: part(s.filter(half.newer), rates[side].newer),
      };
    }
    const loses = x => x.n >= 100 && x.edge < 0;
    row.flipped = ['up', 'down'].every(side => loses(row[side].older) && loses(row[side].newer));
    rows[id] = row;
  }
  return { rates, rows, candles: base.length };
}

const pct = x => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '–');
const pts = x => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}` : '–');

// Voters first in the app's order, then the groups, then the score.
function order(ids) {
  const rank = id => (id === 'score' ? 2 : id.startsWith('g:') ? 1 : 0);
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

export function show(title, s) {
  const head = `${''.padEnd(16)}${'up'.padStart(7)}${'right'.padStart(7)}${'edge'.padStart(7)}${'fresh'.padStart(7)}   `
    + `${'down'.padStart(7)}${'right'.padStart(7)}${'edge'.padStart(7)}${'fresh'.padStart(7)}   ${'older'.padStart(7)}${'newer'.padStart(7)}  flipped`;
  const lines = [title, `Right anyway: up ${pct(s.rates.up.all)}, down ${pct(s.rates.down.all)} (${s.candles} candles)`, head];
  for (const id of order(Object.keys(s.rows))) {
    const r = s.rows[id];
    // Older / newer: both sides' edges, weighted by their calls.
    const both = h => {
      const n = r.up[h].n + r.down[h].n;
      return n ? ((r.up[h].n ? r.up[h].edge * r.up[h].n : 0) + (r.down[h].n ? r.down[h].edge * r.down[h].n : 0)) / n : NaN;
    };
    const name = id.startsWith('g:') ? `[${GROUPS[id.slice(2)] || id.slice(2)}]` : id;
    lines.push(`${name.slice(0, 16).padEnd(16)}`
      + `${String(r.up.n).padStart(7)}${pct(r.up.right).padStart(7)}${pts(r.up.edge).padStart(7)}${pts(r.up.fresh.edge).padStart(7)}   `
      + `${String(r.down.n).padStart(7)}${pct(r.down.right).padStart(7)}${pts(r.down.edge).padStart(7)}${pts(r.down.fresh.edge).padStart(7)}   `
      + `${pts(both('older')).padStart(7)}${pts(both('newer')).padStart(7)}  ${r.flipped ? 'yes' : ''}`);
  }
  return lines.join('\n');
}

// ---- --weights: are voter weights set on the older half still better on the newer half? ----

const DAY = 86400;
export const LINES = [40, 20];   // the score's Buy/Sell line and a looser one

// Weights from one period's summary: 'winners' gives 1 to every voter whose
// calls (both sides together) beat chance, 0 to the rest; 'edge' weighs each
// winner by its edge in points. Voters with fewer than 100 calls get 0.
export function fitWeights(summary, how = 'winners') {
  const w = {};
  for (const [id, r] of Object.entries(summary.rows)) {
    if (id === 'score' || id.startsWith('g:')) continue;
    const n = r.up.n + r.down.n;
    const edge = n ? ((r.up.n ? r.up.edge * r.up.n : 0) + (r.down.n ? r.down.edge * r.down.n : 0)) / n : NaN;
    w[id] = n >= 100 && edge > 0 ? (how === 'edge' ? edge * 100 : 1) : 0;
  }
  return w;
}

// The score's calls on some rows with some weights, at each line:
// up and down calls, right, edge, and Buys' average result after fees
// (all up calls, and fresh ones: the first day of each run, like a trade opening).
export function gradeScore(charts, weights, keep = () => true) {
  const kept = charts.map(rows => rows.filter(keep));
  const all = kept.flat();
  const rate = side => mean(all.map(x => (side === 'up' ? x.bottom : x.top)));
  const out = {};
  for (const line of LINES) {
    const up = [], down = [], fresh = [];
    for (const rows of kept) {
      let prev = 0;
      for (const row of rows) {
        const s = scoreVotes(asVotes(row), weights);
        const side = s >= line ? 1 : s <= -line ? -1 : 0;
        if (side > 0) { up.push(row); if (prev <= 0) fresh.push(row); }
        if (side < 0) down.push(row);
        prev = side;
      }
    }
    const rets = xs => xs.map(x => x.ret).filter(Number.isFinite);
    out[line] = {
      up: up.length, upRight: mean(up.map(x => x.bottom)), upEdge: mean(up.map(x => x.bottom)) - rate('up'),
      down: down.length, downRight: mean(down.map(x => x.top)), downEdge: mean(down.map(x => x.top)) - rate('down'),
      buyPct: mean(rets(up)) * 100, fresh: fresh.length, freshPct: mean(rets(fresh)) * 100,
    };
  }
  return out;
}

// Fits on the older half (leaving out the 30 days before the split, whose
// outcomes run into the newer half) and grades on the newer half.
export function holdout(charts) {
  const ts = charts.flat().map(x => x.t).sort((a, b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const old = { calls: [], base: [] };
  for (const rows of charts) {
    const r = callsOfRows(rows.filter(x => x.t < mid - 30 * DAY));
    old.calls.push(...r.calls);
    old.base.push(...r.base);
  }
  const fitted = summarize(old);
  const weights = { equal: {}, winners: fitWeights(fitted, 'winners'), edge: fitWeights(fitted, 'edge') };
  const newer = x => x.t >= mid;
  const grades = Object.fromEntries(Object.entries(weights).map(([k, w]) => [k, gradeScore(charts, w, newer)]));
  return { mid, weights, grades };
}

export function showHoldout(title, h) {
  const day = new Date(h.mid * 1000).toISOString().slice(0, 10);
  const kept = Object.entries(h.weights.edge).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1])
    .map(([id, w]) => `${id} ${w.toFixed(1)}`);
  const lines = [title, `Weights set on candles before ${day}, graded from ${day} on.`,
    `Voters kept (edge in points): ${kept.join(', ') || 'none'}`,
    `${'weights'.padEnd(9)}${'line'.padStart(5)}${'up'.padStart(7)}${'right'.padStart(7)}${'edge'.padStart(7)}${'down'.padStart(7)}${'right'.padStart(7)}${'edge'.padStart(7)}   ${'Buy %'.padStart(7)}${'trades'.padStart(8)}${'trade %'.padStart(9)}`];
  for (const [name, g] of Object.entries(h.grades)) {
    for (const line of LINES) {
      const x = g[line];
      const sp = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : '–');
      lines.push(`${name.padEnd(9)}${`±${line}`.padStart(5)}${String(x.up).padStart(7)}${pct(x.upRight).padStart(7)}${pts(x.upEdge).padStart(7)}`
        + `${String(x.down).padStart(7)}${pct(x.downRight).padStart(7)}${pts(x.downEdge).padStart(7)}   ${sp(x.buyPct).padStart(7)}${String(x.fresh).padStart(8)}${sp(x.freshPct).padStart(9)}`);
    }
  }
  return lines.join('\n');
}

// ---- --lines: which Buy line earns the most? ----

export const BUY_LINES = [15, 20, 25, 30, 40];
export const EXITS = [[2, 3], [3, 2], [2, 2], [3, 3]];   // [stop, target] in ATRs
export const MIN_TRADES = 100;

// Trades at one Buy line: [{ t, ret }]. Rows are consecutive candles per chart.
// `ex`: which of row.exits to use (-1: the settings' stop and target).
export function tradesAt(charts, line, weights = {}, ex = -1) {
  const out = [];
  for (const rows of charts) {
    let prev = -Infinity;
    for (let k = 0; k < rows.length; k++) {
      const row = rows[k];
      const s = scoreVotes(asVotes(row), weights);
      const o = ex >= 0 ? row.exits[ex] : row;
      if (s >= line && prev < line && Number.isFinite(o.ret)) {
        out.push({ t: row.t, ret: o.ret });
        k += o.days;                 // in the trade until it closes
        prev = Infinity;               // and the score must dip under the line again
        continue;
      }
      prev = s;
    }
  }
  return out;
}

// Per line: trades and average % in all, the older and the newer half, and
// whether it passes (100+ trades and above 0 in both halves, and above the 40 line in both).
export function lineTable(charts, ex = -1) {
  const ts = charts.flat().map(x => x.t).sort((a, b) => a - b);
  const mid = ts[Math.floor(ts.length / 2)];
  const part = xs => ({ n: xs.length, pct: mean(xs.map(x => x.ret)) * 100, right: mean(xs.map(x => (x.ret > 0 ? 1 : 0))) });
  const rows = {};
  for (const line of BUY_LINES) {
    const tr = tradesAt(charts, line, {}, ex);
    rows[line] = { ...part(tr), older: part(tr.filter(x => x.t < mid)), newer: part(tr.filter(x => x.t >= mid)) };
  }
  const base = rows[40];
  for (const line of BUY_LINES) {
    const r = rows[line];
    r.passes = line !== 40 && ['older', 'newer'].every(h => r[h].n >= MIN_TRADES && r[h].pct > 0 && !(base[h].pct >= r[h].pct));
  }
  return { mid, rows };
}

export function showLines(title, tbl) {
  const day = new Date(tbl.mid * 1000).toISOString().slice(0, 10);
  const sp = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : '–');
  const lines = [title, `Older half before ${day}, newer from ${day}.`,
    `${'Buy at'.padEnd(8)}${'trades'.padStart(7)}${'won'.padStart(6)}${'avg %'.padStart(8)}   ${'older'.padStart(6)}${'avg %'.padStart(8)}   ${'newer'.padStart(6)}${'avg %'.padStart(8)}  passes`];
  for (const line of BUY_LINES) {
    const r = tbl.rows[line];
    lines.push(`${String(line).padEnd(8)}${String(r.n).padStart(7)}${pct(r.right).padStart(6)}${sp(r.pct).padStart(8)}   `
      + `${String(r.older.n).padStart(6)}${sp(r.older.pct).padStart(8)}   ${String(r.newer.n).padStart(6)}${sp(r.newer.pct).padStart(8)}  ${r.passes ? 'yes' : ''}`);
  }
  return lines.join('\n');
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input);
  const deps = defaultDeps;
  const printed = [];
  const weightsMode = process.argv.includes('--weights');
  const linesMode = process.argv.includes('--lines');
  const exitsMode = process.argv.includes('--exits');
  for (const [kind, total] of [['stock', job.total || 120], ['crypto', job.cryptoTotal || 50]]) {
    const items = await trainingItems({ ...job, kind, total }, deps);
    const charts = [];
    for (const item of items) {
      try {
        const { candles } = await candlesFor(item, '1D', job.settings, deps);
        if (candles.length < MIN_CANDLES + 50) continue;
        charts.push(rowsOf(analyze(candles), job.settings, item.type, exitsMode ? EXITS : []));
      } catch (e) {
        // A chart that can't load is left out.
      }
    }
    const title = `${kind === 'stock' ? 'Stocks' : 'Crypto'}: ${charts.length} charts`;
    if (weightsMode) {
      printed.push(showHoldout(title, holdout(charts)));
      continue;
    }
    if (linesMode) {
      printed.push(showLines(title, lineTable(charts)));
      continue;
    }
    if (exitsMode) {
      EXITS.forEach(([sa, ta], ex) => {
        const even = Math.round((100 * sa) / (sa + ta));
        printed.push(showLines(`${title}. Stop ${sa} ATR, target ${ta} ATR: break-even ${even}% won, before fees`, lineTable(charts, ex)));
      });
      continue;
    }
    const all = { calls: [], base: [] };
    for (const rows of charts) {
      const { calls, base } = callsOfRows(rows);
      for (const c of calls) all.calls.push(c);
      for (const b of base) all.base.push(b);
    }
    printed.push(show(title, summarize(all)));
  }
  if (exitsMode) {
    process.stdout.write(`${printed.join('\n\n')}\n\nA trade opens when today's score first reaches the line and closes at the stop, the target or after 30 candles.
won: share of trades that made money after fees. avg %: average result per trade after fees.
break-even: how often a trade must win to make 0 before fees (stop / (stop + target)).
passes: 100+ trades and above 0 in both halves, and better than the 40 line in both.
`);
    return;
  }
  if (linesMode) {
    process.stdout.write(`${printed.join('\n\n')}\n\nA trade opens when today's score first reaches the line and closes at your stop, your target or after 30 candles.
won: share of trades that made money after fees. avg %: average result per trade after fees.
passes: 100+ trades and above 0 in both halves, and better than the 40 line in both.
`);
    return;
  }
  if (weightsMode) {
    process.stdout.write(`${printed.join('\n\n')}\n\nequal: today's score. winners: only voters that beat chance in the older half. edge: winners weighted by their edge.
line: score of +line or more is an up call (Buy), -line or less a down call. right / edge: as in the voters table.
Buy %: every up-call day bought, average result after fees. trades / trade %: only the first day of each run (one trade each).
`);
    return;
  }
  process.stdout.write(`${printed.join('\n\n')}\n\nright: how often the call's target came before its stop. edge: right minus "right anyway", in points.\n`
    + 'fresh: only the first day of each run of calls. older / newer: edge of all calls in each half of the history.\n'
    + 'flipped: both sides lose in both halves (100+ calls each), so the rule does better turned around.\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exit(1);
  });
}
