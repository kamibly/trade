// Opportunities across the market scan: runs the setups in js/setups.js over
// every symbol's daily history, keeps each setup's track record, and returns
// the ones that fire on the newest candles.

import * as Z from './js/setups.js';
import { feeRate } from './js/fees.js';

const DAY = 86400;

// The parts of an analyze() result the setups need, so 550 charts fit in memory.
export const lite = S => ({ candles: S.candles, close: S.close, atr: S.atr, sma50: S.sma50, sma200: S.sma200, rsi: S.rsi, stoch: { k: S.stoch.k } });

const money = v => (v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`);

// rows: [{ item: { type, symbol, name }, S, sector }] (S from lite())
// spy, btc: benchmark S (or null); events: { insiders, earnings, fng, funding } keyed by symbol
// enabled: { setup: bool }; held: Set of keys you or the paper account hold
// result: { opportunities, records, warnings, counts }
export function findOpportunities({ rows, spy, btc, events = {}, settings, enabled = {}, held = new Set(), nowSec }) {
  const on = id => enabled[id] !== false;
  const levels = { stopAtr: settings.stopAtr || 2, takeAtr: settings.takeAtr || 3 };
  const records = Object.fromEntries(Object.keys(Z.SETUPS).map(id => [id, Z.emptyRecord()]));
  const counts = Object.fromEntries(Object.keys(Z.SETUPS).map(id => [id, 0]));
  const opportunities = [];
  const warnings = [];
  const key = item => `${item.type}:${item.symbol}`;

  const rankFor = new Map();
  if (on('ranking')) {
    const stocks = rows.filter(r => r.item.type === 'stock').map(r => ({ key: key(r.item), S: r.S, group: r.sector }));
    const crypto = rows.filter(r => r.item.type === 'crypto').map(r => ({ key: key(r.item), S: r.S }));
    for (const [list, bench] of [[stocks, spy], [crypto, btc]]) {
      if (!bench || list.length < 10) continue;
      const ranks = Z.rankings(list, bench);
      const healthy = Z.healthyDays(bench);
      for (const r of list) rankFor.set(r.key, { ranks: ranks.get(r.key), healthy });
    }
  }

  for (const r of rows) {
    const { item, S } = r;
    const k = key(item);
    const n = S.candles.length;
    if (n < 30) continue;
    const fresh = i => i >= n - 2 && S.candles[i].time >= nowSec - 4 * DAY;
    const triggers = [];
    if (item.type === 'stock' && on('insider')) {
      for (const t of Z.insiderTriggers(S.candles, (events.insiders || {})[item.symbol])) {
        triggers.push({ setup: 'insider', i: t.i, why: `${t.people} insiders bought ${money(t.value)} on the open market (${t.names.join(', ')})` });
      }
    }
    if (item.type === 'stock' && (on('earnings') || held.has(k))) {
      for (const t of Z.earningsTriggers(S, (events.earnings || {})[item.symbol])) {
        if (t.up && on('earnings')) triggers.push({ setup: 'earnings', i: t.i, why: `Gapped up ${t.gap.toFixed(1)} ATR on its earnings, closed strong on heavy volume` });
        if (!t.up && held.has(k) && fresh(t.i)) {
          warnings.push({ kind: 'earnings-gap', key: k, id: `earnings-gap:${k}:${S.candles[t.i].time}`, title: `${item.symbol} gapped down on earnings`, body: `It opened ${Math.abs(t.gap).toFixed(1)} ATR below the last close. Your stop may be skipped over; check the chart.`, hash: `chart/${item.type}/${encodeURIComponent(item.symbol)}` });
        }
      }
    }
    if (on('ranking') && rankFor.has(k)) {
      const { ranks, healthy } = rankFor.get(k);
      for (const t of Z.rankingTriggers(S, ranks, healthy)) {
        const top = Math.max(1, Math.round((1 - t.rank) * 100));
        triggers.push({ setup: 'ranking', i: t.i, why: `In the top ${top}% strongest ${item.type === 'stock' ? 'S&P 500 stocks (against the S&P 500 and its sector)' : 'crypto (against Bitcoin)'}, pulling back in its uptrend while the market is healthy` });
      }
    }
    if (item.type === 'crypto' && on('crowd')) {
      for (const t of Z.crowdTriggers(S, item.symbol, events.fng, (events.funding || {})[item.symbol])) {
        if (t.side === 'buy') triggers.push({ setup: 'crowd', i: t.i, why: t.why });
        else if (held.has(k) && fresh(t.i)) {
          warnings.push({ kind: 'crowd-caution', key: k, id: `crowd:${k}:${S.candles[t.i].time}`, title: `Caution on your ${item.symbol}: the crowd is piled in`, body: `${t.why}. Extremes like this often come before a pullback.`, hash: `chart/${item.type}/${encodeURIComponent(item.symbol)}` });
        }
      }
    }

    const mine = {};
    for (const t of triggers) {
      const hold = Z.SETUPS[t.setup].hold;
      const ret = Z.outcome(S, t.i, { hold, ...levels, fee: feeRate(item.type) });
      Z.addOutcome(records[t.setup], ret);
      Z.addOutcome((mine[t.setup] ||= Z.emptyRecord()), ret);
      counts[t.setup] += 1;
    }
    for (const t of triggers) {
      if (!fresh(t.i)) continue;
      const atr = S.atr[t.i];
      const entry = S.close[t.i];
      opportunities.push({
        id: `${t.setup}:${k}:${S.candles[t.i].time}`,
        setup: t.setup,
        key: k,
        symbol: item.symbol,
        name: item.name || item.symbol,
        type: item.type,
        time: S.candles[t.i].time,
        why: t.why,
        entry,
        atr,
        stop: entry - levels.stopAtr * atr,
        take: entry + levels.takeAtr * atr,
        hold: Z.SETUPS[t.setup].hold,
        symbolRecord: Z.recordOf(mine[t.setup]),
      });
    }
  }

  const finalRecords = Object.fromEntries(Object.entries(records).map(([id, rec]) => [id, Z.recordOf(rec)]));
  for (const o of opportunities) {
    o.record = finalRecords[o.setup];
    o.proven = Z.proven(o.record);
    o.ev = o.record.avg;
  }
  // Best expected result first; a symbol shows once (its best setup).
  opportunities.sort((a, b) => (b.proven - a.proven) || (b.ev - a.ev));
  const seen = new Set();
  const unique = opportunities.filter(o => !seen.has(o.key) && seen.add(o.key));
  return { opportunities: unique, records: finalRecords, warnings, counts };
}

// One push for the scan: up to 5 proven opportunities not announced before.
export function digest(opportunities, announced = new Set(), muted = new Set()) {
  const fresh = opportunities.filter(o => o.proven && !announced.has(o.id) && !muted.has(o.setup)).slice(0, 5);
  if (!fresh.length) return null;
  const line = o => `${o.symbol}: ${Z.SETUPS[o.setup].name.toLowerCase()}, past cases ${Z.pct(o.record.avg)} on average`;
  return {
    kind: 'opportunities',
    setups: [...new Set(fresh.map(o => o.setup))],
    ids: fresh.map(o => o.id),
    title: fresh.length === 1 ? `Opportunity: ${fresh[0].symbol} (${Z.SETUPS[fresh[0].setup].name.toLowerCase()})` : `Top ${fresh.length} opportunities`,
    body: fresh.length === 1 ? `${fresh[0].why}. ${Z.recordLine(fresh[0].record, fresh[0].hold)}` : fresh.map(line).join(' · '),
    hash: 'signals',
  };
}
