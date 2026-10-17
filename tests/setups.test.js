import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze } from '../app/js/signals.js';
import * as Z from '../app/js/setups.js';
import * as paper from '../app/js/paper.js';
import { tradeRecord, tradeRecordLine } from '../app/js/scanner.js';
import { lite, findOpportunities, digest } from '../server/opportunities.mjs';
import { parseSp500, runPaper } from '../server/engine.mjs';

const DAY = 86400;

function series(n, drift, vol = 0.02, seed = 42) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= Math.exp(drift + vol * (r() - 0.5) * 2);
    return { time: i * DAY, open: o, close: p, high: Math.max(o, p) * (1 + r() * vol), low: Math.min(o, p) * (1 - r() * vol), volume: 1000 + r() * 1000 };
  });
}

const flat = n => Array.from({ length: n }, (_, i) => ({ time: i * DAY + 48600, open: 100, close: 100, high: 101, low: 99, volume: 1000 }));
const buy = (day, owner, value) => ({ filed: day * DAY, owner, name: owner, role: 'Director', value });

test('insider buying: two insiders and $100k within 30 days; one insider or a small total is not a cluster', () => {
  const c = flat(120);
  const hits = Z.insiderTriggers(c, [buy(10, 'a', 60_000), buy(20, 'b', 50_000)]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].people, 2);
  assert.equal(hits[0].value, 110_000);
  // Filed on day 20: the trade is entered on the next session, never the filing day.
  assert.equal(hits[0].i, 21);
  assert.deepEqual(Z.insiderTriggers(c, [buy(10, 'a', 80_000), buy(12, 'a', 80_000)]), []); // one person
  assert.deepEqual(Z.insiderTriggers(c, [buy(10, 'a', 40_000), buy(12, 'b', 40_000)]), []); // under $100k
  assert.deepEqual(Z.insiderTriggers(c, [buy(10, 'a', 90_000), buy(45, 'b', 90_000)]), []); // too far apart
  // More filings in the same cluster don't fire again.
  assert.equal(Z.insiderTriggers(c, [buy(10, 'a', 60_000), buy(20, 'b', 50_000), buy(25, 'c', 50_000)]).length, 1);
});

test('earnings: a strong gap up on heavy volume is the drift setup; a gap down is flagged for holders', () => {
  const c = flat(100);
  c[50] = { ...c[50], open: 105, high: 107.5, low: 104.8, close: 107, volume: 5000 };
  for (let i = 51; i < 100; i++) c[i] = { ...c[i], open: 107, close: 107, high: 108, low: 106 };
  c[80] = { ...c[80], open: 100, close: 101, high: 102, low: 99.5 };
  const S = analyze(c);
  // Released before the open on day 50, and after the close on day 79.
  const hits = Z.earningsTriggers(S, [c[50].time - 3600, c[79].time + 8 * 3600]);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].i, 50);
  assert.ok(hits[0].up && hits[0].gap >= 1);
  assert.equal(hits[1].i, 80);
  assert.ok(!hits[1].up && hits[1].gap <= -1);
  // The same gap on normal volume is not the setup.
  c[50] = { ...c[50], volume: 1000 };
  assert.ok(!Z.earningsTriggers(analyze(c), [c[50].time - 3600]).some(h => h.up));
});

test('ranking: leaders are the strongest against the benchmark, and only buy pullbacks in a healthy market', () => {
  const bench = analyze(series(600, 0.001, 0.01, 7));
  const rows = Array.from({ length: 12 }, (_, k) => ({ key: `stock:S${k}`, S: analyze(series(600, -0.002 + k * 0.0006, 0.025, 11 + k)), group: k % 2 ? 'Tech' : 'Energy' }));
  const ranks = Z.rankings(rows, bench);
  const last = Math.floor(rows[0].S.candles[599].time / DAY);
  assert.ok(ranks.get('stock:S11').get(last) > ranks.get('stock:S0').get(last));
  const healthy = Z.healthyDays(bench);
  let fired = 0;
  for (const r of rows) {
    for (const t of Z.rankingTriggers(r.S, ranks.get(r.key), healthy)) {
      fired++;
      assert.ok(t.rank >= Z.LEADER);
      assert.ok(healthy.has(Math.floor(r.S.candles[t.i].time / DAY)));
    }
  }
  assert.ok(fired > 0);
  // No healthy days, no trades.
  assert.deepEqual(Z.rankingTriggers(rows[11].S, ranks.get('stock:S11'), new Set()), []);
});

test('crowd extremes: extreme fear and very negative funding are buys; greed and crowded longs are cautions', () => {
  const S = analyze(series(400, 0.001, 0.02, 5));
  const t0 = S.candles[0].time;
  const fng = Array.from({ length: 400 }, (_, k) => [t0 + k * DAY, k === 100 ? 12 : k === 300 ? 90 : 50]);
  const hits = Z.crowdTriggers(S, 'BTC', fng, null);
  assert.deepEqual(hits.map(h => [h.i, h.side]), [[101, 'buy'], [301, 'caution']]);
  assert.deepEqual(Z.crowdTriggers(S, 'DOGE', fng, null), []); // the index is for BTC and ETH
  const funding = Array.from({ length: 400 }, (_, k) => [t0 + k * DAY, k === 250 ? -0.002 : k === 350 ? 0.004 : 0.0001 + (k % 7) * 0.00001]);
  const f = Z.crowdTriggers(S, 'SOL', null, funding);
  assert.deepEqual(f.map(h => [h.i, h.side]), [[251, 'buy'], [351, 'caution']]);
  assert.match(f[0].why, /betting on a drop/);
});

test('outcomes, track records and the proven gate', () => {
  const S = analyze(series(300, 0.004, 0.01, 3));
  const r = Z.outcome(S, 100, { hold: 10 });
  assert.ok(Number.isFinite(r));
  assert.equal(Z.outcome(S, 295, { hold: 10 }), null); // still open
  const rec = Z.emptyRecord();
  for (let k = 0; k < 29; k++) Z.addOutcome(rec, 0.01);
  assert.ok(!Z.proven(Z.recordOf(rec)));
  Z.addOutcome(rec, -0.02);
  assert.ok(Z.proven(Z.recordOf(rec)));
  const losing = Z.emptyRecord();
  for (let k = 0; k < 40; k++) Z.addOutcome(losing, -0.001);
  assert.ok(!Z.proven(Z.recordOf(losing)));
  assert.match(Z.recordLine(Z.recordOf(rec), 20), /^After 30 past cases: 97% made money within 20 days, average \+0\.9% after fees\.$/);
});

// A rising stock with an insider cluster every 40 days, the last one just filed.
function insiderMarket() {
  const candles = series(1400, 0.002, 0.01, 21).map(c => ({ ...c, time: c.time + 48600 }));
  const purchases = [];
  for (let d = 30; d < 1390; d += 40) purchases.push(buy(d, `a${d}`, 70_000), buy(d + 1, `b${d}`, 70_000));
  purchases.push(buy(1396, 'x', 70_000), buy(1397, 'y', 70_000));
  const S = lite(analyze(candles));
  return { S, purchases, nowSec: candles.at(-1).time };
}

test('opportunities: fresh triggers with the setup track record, and one digest of proven ones', () => {
  const { S, purchases, nowSec } = insiderMarket();
  const rows = [{ item: { type: 'stock', symbol: 'ACME', name: 'Acme' }, S, sector: 'Tech' }];
  const found = findOpportunities({ rows, spy: null, btc: null, events: { insiders: { ACME: purchases } }, settings: { stopAtr: 2, takeAtr: 3 }, nowSec });
  assert.ok(found.records.insider.n >= 30);
  assert.equal(found.opportunities.length, 1);
  const o = found.opportunities[0];
  assert.equal(o.setup, 'insider');
  assert.equal(o.id, `insider:stock:ACME:${S.candles.at(-2).time}`); // filed on the 1397th day, bought the next
  assert.ok(o.proven && o.ev > 0 && o.stop < o.entry && o.take > o.entry);
  assert.match(o.why, /2 insiders bought \$140k/);

  const push = digest(found.opportunities);
  assert.equal(push.kind, 'opportunities');
  assert.deepEqual(push.setups, ['insider']);
  assert.match(push.title, /Opportunity: ACME/);
  assert.equal(digest(found.opportunities, new Set([o.id])), null); // already sent
  assert.equal(digest(found.opportunities, new Set(), new Set(['insider'])), null); // muted
  assert.equal(digest(found.opportunities.map(x => ({ ...x, proven: false }))), null); // not proven yet

  // Switched off: no insider trades at all.
  const off = findOpportunities({ rows, events: { insiders: { ACME: purchases } }, settings: {}, enabled: { insider: false }, nowSec });
  assert.equal(off.opportunities.length, 0);
  assert.equal(off.records.insider.n, 0);
});

test('paper: opportunities are tagged, kept to their budget, and sold when their time is up', () => {
  const acc = paper.newAccount(100_000, 0);
  const opps = Array.from({ length: 12 }, (_, k) => ({ id: `ranking:stock:S${k}:1`, setup: k % 2 ? 'ranking' : 'insider', key: `stock:S${k}`, symbol: `S${k}`, type: 'stock', entry: 100, stop: 80, take: 130, hold: 10, ev: k / 100 }));
  const events = paper.openSetups(acc, opps, { riskPct: 1, now: 0 });
  assert.equal(events.length, paper.BUDGETS.opportunities.max);
  assert.equal(acc.positions.length, 5);
  // Equal slots: 40% of the account over 5 positions.
  assert.ok(acc.positions.every(p => p.qty * p.entry <= 8000 + 1)); // at most 40% over 5 positions
  // Best expected result first: S11 and S10 got in, S0 and S1 didn't.
  assert.ok(acc.positions.some(p => p.key === 'stock:S11') && !acc.positions.some(p => p.key === 'stock:S0'));
  assert.equal(acc.positions.find(p => p.key === 'stock:S11').setup, 'ranking');
  // 10 trading days is 14 calendar days.
  assert.equal(acc.positions[0].until, 14 * 86400_000);
  // The same opportunity is not taken twice.
  assert.equal(paper.openSetups(acc, opps, { now: 1 }).length, 0);

  // A Sell signal doesn't close an opportunity trade; its time does.
  const signals = Object.fromEntries(acc.positions.map(p => [p.key, { entry: 101, action: 'sell' }]));
  assert.equal(paper.step(acc, { signals, now: 86400_000 }).length, 0);
  const out = paper.step(acc, { signals, now: 15 * 86400_000 });
  assert.equal(out.length, 5);
  assert.ok(out.every(e => e.reason === 'time'));
  const table = paper.bySetup(acc);
  assert.deepEqual(table.map(r => r.setup).sort(), ['insider', 'ranking']);
  assert.deepEqual(table.map(r => r.trades).sort(), [2, 3]);
  assert.ok(table.every(r => r.winRate === 1 && r.ret > 0));
});

test('paper engine mode opens the scan opportunities', async () => {
  const opp = { id: 'crowd:crypto:BTC:1', setup: 'crowd', key: 'crypto:BTC', symbol: 'BTC', type: 'crypto', entry: 100, stop: 90, take: 120, hold: 10, ev: 0.02 };
  const r = await runPaper({ paper: paper.newAccount(10_000, 0), opportunities: [opp], riskPct: 1 }, { now: () => 5 });
  assert.equal(r.paper.positions.length, 1);
  assert.equal(r.paper.positions[0].until, 5 + 10 * 86400_000);
  assert.match(r.paperEvents[0].text, /^Bought BTC at .*crowd extreme\)$/);
});

test('signal track record line', () => {
  const rec = tradeRecord({ trades: [{ ret: 0.05, entryTime: 0, exitTime: 9 * DAY }, { ret: -0.01, entryTime: 0, exitTime: 9 * DAY }, { ret: 0.02, entryTime: 0, exitTime: 9 * DAY }] });
  assert.deepEqual(rec, { n: 3, wins: 2, avg: 0.02, days: 9 });
  assert.equal(tradeRecordLine('AAPL', rec), 'This signal on AAPL: won 2 of 3 test trades, average +2.0% over about 9 days.');
  assert.equal(tradeRecord({ trades: [] }), null);
});

test('S&P 500 list carries the sector and the SEC company number', async () => {
  const rows = parseSp500(await readFile(new URL('../server/sp500.csv', import.meta.url), 'utf8'));
  const aapl = rows.find(r => r.symbol === 'AAPL');
  assert.equal(aapl.sector, 'Information Technology');
  assert.equal(aapl.cik, 320193);
  assert.ok(rows.filter(r => r.sector && r.cik).length > 490);
});

test('paper takes the market scan buy ideas and sells them when a later scan says Sell', async () => {
  const idea = (sym, score) => ({ id: `scan:stock:${sym}:1`, setup: 'scan', key: `stock:${sym}`, symbol: sym, type: 'stock', entry: 100, stop: 90, take: 130, ev: score / 100 });
  const acc = paper.newAccount(10_000, 0);
  const r = await runPaper({ paper: acc, scanBuys: [idea('AAA', 45), idea('BBB', 70)], riskPct: 1 }, { now: () => 5 });
  // Strongest score first, no holding period.
  assert.deepEqual(r.paper.positions.map(p => p.key), ['stock:BBB', 'stock:AAA']);
  assert.ok(r.paper.positions.every(p => p.setup === 'scan' && !p.until));
  assert.match(r.paperEvents[0].text, /market scan idea\)$/);
  const later = await runPaper({ paper: r.paper, scanSells: [{ key: 'stock:AAA', entry: 104 }, { key: 'stock:ZZZ', entry: 1 }] }, { now: () => 9 });
  assert.equal(later.paperEvents.length, 1);
  assert.equal(later.paper.trades[0].setup, 'scan');
  assert.equal(later.paper.trades[0].reason, 'sell signal');
  assert.deepEqual(later.paper.positions.map(p => p.key), ['stock:BBB']);
});

test('an idea the paper account had no cash for is tried again later', async () => {
  const paper = await import('../app/js/paper.js');
  const acc = paper.newAccount(1000, 0);
  acc.cash = 0.5;
  const idea = { id: 'scan:stock:AAPL:1', setup: 'scan', key: 'stock:AAPL', symbol: 'AAPL', type: 'stock', entry: 100, stop: 95, take: 110, ev: 0.5 };
  assert.equal(paper.openSetups(acc, [idea], { now: 1 }).length, 0);
  assert.deepEqual(acc.taken, []);
  acc.cash = 1000;
  assert.equal(paper.openSetups(acc, [idea], { now: 2 }).length, 1);
  assert.deepEqual(acc.taken, ['scan:stock:AAPL:1']);
  assert.equal(paper.openSetups(acc, [idea], { now: 3 }).length, 0); // once per idea
});

test('an idea marked taken by an older version but never traded is bought', async () => {
  const paper = await import('../app/js/paper.js');
  const acc = paper.newAccount(10000, 0);
  acc.taken = ['insider:stock:AAPL:1'];
  const idea = { id: 'insider:stock:AAPL:1', setup: 'insider', key: 'stock:AAPL', symbol: 'AAPL', type: 'stock', entry: 100, stop: 95, take: 110, hold: 20, ev: 0.02 };
  assert.equal(paper.openSetups(acc, [idea], { now: 1 }).length, 1);
});

test('paper: each source has its own budget, so opportunities cannot crowd out buy ideas', () => {
  const acc = paper.newAccount(10_000, 0);
  const idea = (setup, type, k) => ({ id: `${setup}:${type}:X${k}:1`, setup, key: `${type}:X${k}`, symbol: `X${k}`, type, entry: 100, stop: 90, take: 130, ev: 0.5 });
  const opps = Array.from({ length: 14 }, (_, k) => idea('ranking', 'stock', k));
  const stocks = Array.from({ length: 7 }, (_, k) => idea('scan', 'stock', 100 + k));
  const coins = Array.from({ length: 9 }, (_, k) => idea('scan', 'crypto', 200 + k));
  paper.openSetups(acc, opps, { now: 1 });
  paper.openSetups(acc, [...coins, ...stocks], { now: 1 });
  const count = b => acc.positions.filter(p => paper.bucketOf(p) === b).length;
  assert.equal(count('opportunities'), 5);
  assert.equal(count('stockIdeas'), 5);
  assert.equal(count('cryptoIdeas'), 5);
  // Watchlist alerts still have their own 5 slots and 20%.
  const signals = { 'stock:W': { symbol: 'W', type: 'stock', entry: 50, stop: 45, take: 60, action: 'buy' } };
  assert.equal(paper.step(acc, { signals, alerts: { 'stock:W': 'buy' }, now: 2 }).length, 1);
  const w = acc.positions.find(p => p.key === 'stock:W');
  assert.ok(Math.abs(w.qty * w.entry - 400) < 1); // 20% / 5 = 4% of $10,000
  assert.ok(acc.cash > 0);
});
