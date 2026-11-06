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
// Run on the server (it needs the chart history):
//   docker exec trade-service python voters_check.py
import { analyze, baseVotesAt, scoreVotes, MIN_CANDLES, GROUPS } from './js/signals.js';
import { turnLabels } from './js/ml.js';
import { candlesFor, trainingItems, defaultDeps } from './engine.mjs';

export const FIRM = 0.3;      // the scoreboard's firm vote
export const SCORE = 40;      // the score's Buy and Sell lines

// One chart's calls: [{ id, side: 'up'|'down', t, right, fresh }] plus its labelled candles.
export function callsOf(S, settings = {}) {
  const calls = [];
  const base = [];
  const last = {};           // id → side of the previous candle's call
  for (let i = MIN_CANDLES - 1; i < S.close.length; i++) {
    const votes = baseVotesAt(S, i);
    if (!votes.length) continue;
    const lab = turnLabels(S, i, settings);
    const now = {};
    const lean = (id, v) => { if (v >= FIRM) now[id] = 'up'; else if (v <= -FIRM) now[id] = 'down'; };
    const groups = {};
    for (const v of votes) {
      lean(v.id, v.vote);
      (groups[v.group] ||= []).push(v.vote);
    }
    for (const [g, list] of Object.entries(groups)) lean(`g:${g}`, list.reduce((a, b) => a + b, 0) / list.length);
    const score = scoreVotes(votes, {});
    if (score >= SCORE) now.score = 'up';
    else if (score <= -SCORE) now.score = 'down';
    if (lab) {
      const t = S.candles[i].time;
      base.push({ t, bottom: lab.bottom, top: lab.top });
      for (const [id, side] of Object.entries(now)) {
        calls.push({ id, side, t, right: side === 'up' ? lab.bottom : lab.top, fresh: last[id] !== side });
      }
    }
    for (const k of Object.keys(last)) delete last[k];
    Object.assign(last, now);
  }
  return { calls, base };
}

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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input);
  const deps = defaultDeps;
  const printed = [];
  for (const [kind, total] of [['stock', job.total || 120], ['crypto', job.cryptoTotal || 50]]) {
    const items = await trainingItems({ ...job, kind, total }, deps);
    const all = { calls: [], base: [] };
    let charts = 0;
    for (const item of items) {
      try {
        const { candles } = await candlesFor(item, '1D', job.settings, deps);
        if (candles.length < MIN_CANDLES + 50) continue;
        const { calls, base } = callsOf(analyze(candles), job.settings);
        for (const c of calls) all.calls.push(c);
        for (const b of base) all.base.push(b);
        charts++;
      } catch (e) {
        // A chart that can't load is left out.
      }
    }
    printed.push(show(`${kind === 'stock' ? 'Stocks' : 'Crypto'}: ${charts} charts`, summarize(all)));
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
