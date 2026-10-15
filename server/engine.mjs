// The server's signal engine. It reuses the app's own modules from app/js, so
// a symbol scores exactly the same on the server as on the phone.
//
// The Python service runs it as:  node engine.mjs < job.json > result.json
// job: { mode: 'watch' | 'market', ... }  (see runWatch and runMarket below)

import { TIMEFRAMES } from '../app/js/candles.js';
import { readFile } from 'node:fs/promises';
import { fetchCandles, yahooCandles, fetchCryptoTop } from '../app/js/data.js';
import { analyze, signalAt, MIN_CANDLES } from '../app/js/signals.js';
import { backtest } from '../app/js/backtest.js';
import { summarize, alertFor, WEIGHTS_MAX_AGE_MS } from '../app/js/scanner.js';
import { checkHolding } from '../app/js/portfolio.js';
import { formatMoney } from '../app/js/format.js';

const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const fmtScore = v => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const key = item => `${item.type}:${item.symbol}`;

export const defaultDeps = {
  fetchCandles,
  yahooCandles,
  fetchCryptoTop,
  fetchText: async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.text();
  },
  now: () => Date.now(),
};

// Stocks: Yahoo Finance first (no key, no tight limit), then Twelve Data if the server has a key.
async function candlesFor(item, tf, settings, deps) {
  if (item.type === 'crypto') return deps.fetchCandles(item, tf, settings);
  try {
    return await deps.yahooCandles(item, tf);
  } catch (e) {
    if (!settings.twelveKey) throw e;
    try {
      return await deps.fetchCandles(item, tf, settings);
    } catch (e2) {
      throw new Error(`${e.message} · ${e2.message}`);
    }
  }
}

// Scores one symbol, re-learning its method weights from the backtest once a day.
async function score(item, tf, settings, weightsCache, deps) {
  const { candles } = await candlesFor(item, tf, settings, deps);
  if (candles.length < MIN_CANDLES) throw new Error(`Only ${candles.length} candles, ${MIN_CANDLES} needed`);
  const thresholds = { buy: settings.buyAt, sell: settings.sellAt };
  const S = analyze(candles);
  const wKey = `${key(item)}:${tf}`;
  let w = weightsCache[wKey];
  if (!w || deps.now() - w.at >= WEIGHTS_MAX_AGE_MS) {
    const bt = backtest(S, { thresholds, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr });
    w = { at: deps.now(), weights: bt ? bt.weights : null };
    weightsCache[wKey] = w;
  }
  const sig = signalAt(S, candles.length - 1, {
    thresholds, weights: w.weights || undefined, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr,
  });
  if (!sig) throw new Error('Not enough history');
  return { ...summarize(item, sig, tf), at: deps.now() };
}

// Runs `fn` over `items` with a few at a time, so big scans finish without hammering a source.
async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

const levels = s => `Entry ${formatMoney(s.entry)} · Stop ${formatMoney(s.stop)} · Target ${formatMoney(s.take)}`;

// Watchlist and holdings on the alert timeframe.
// job: { tf, settings, items, holdings, prev: { key: signal }, weights: { "key:tf": {at, weights} } }
// result: { signals, alerts, holdingsAlerted, weights, errors }
export async function runWatch(job, deps = defaultDeps) {
  const { tf, settings } = job;
  const weights = { ...(job.weights || {}) };
  const prev = job.prev || {};
  const signals = {};
  const errors = {};
  const alerts = [];
  await pool(job.items || [], 3, async item => {
    try {
      signals[key(item)] = await score(item, tf, settings, weights, deps);
    } catch (e) {
      errors[key(item)] = e.message;
    }
  });
  const held = new Set((job.holdings || []).map(h => h.key));
  for (const [k, s] of Object.entries(signals)) {
    const p = prev[k];
    // Like the phone: no alert the first time a symbol is scored or after a timeframe change.
    const action = p && p.tf === tf ? alertFor(p.action, s.action) : null;
    if (!action) continue;
    const yours = action === 'sell' && held.has(k);
    alerts.push({
      kind: 'signal',
      key: k,
      title: `${action === 'buy' ? 'Buy' : 'Sell'} signal: ${s.symbol}${yours ? ' (you hold it)' : ''}`,
      body: `Score ${fmtScore(s.score)} on the ${TIMEFRAMES[tf].label} chart. ${levels(s)}.${s.top.length ? ` Led by ${s.top.join(', ')}.` : ''}`,
      hash: `chart/${s.type}/${encodeURIComponent(s.symbol)}`,
    });
  }
  const holdingsAlerted = {};
  for (const h of job.holdings || []) {
    const s = signals[h.key];
    if (!s) continue;
    const { alerts: hits, alerted } = checkHolding(h, s.entry, s.action);
    holdingsAlerted[h.id] = alerted;
    for (const a of hits) {
      // A Sell signal on a holding already got the signal alert above.
      if (a === 'sell' && alerts.some(x => x.key === h.key)) continue;
      alerts.push({
        kind: a,
        key: h.key,
        urgent: a === 'stop', // stop-loss hits come through quiet hours
        title: a === 'stop' ? `Stop-loss hit: ${h.symbol}` : a === 'target' ? `Target reached: ${h.symbol}` : `Sell signal on your ${h.symbol}`,
        body: a === 'stop' ? `${formatMoney(s.entry)} is at or below your stop of ${formatMoney(h.stop)}. Consider selling.`
          : a === 'target' ? `${formatMoney(s.entry)} is at or above your target of ${formatMoney(h.take)}. Consider taking profit.`
            : `Score ${fmtScore(s.score)} on the ${TIMEFRAMES[tf].label} chart. You hold ${h.qty}.`,
        hash: 'portfolio',
      });
    }
  }
  return { signals, alerts, holdingsAlerted, weights, errors };
}

export function parseSp500(csv) {
  return csv.split(/\r?\n/).slice(1)
    .map(line => {
      // Symbol,Security,... where Security may be quoted and contain commas.
      const m = line.match(/^([A-Z0-9.\-]+),("([^"]*)"|[^,]*)/);
      return m ? { type: 'stock', symbol: m[1], name: m[3] ?? m[2] } : null;
    })
    .filter(Boolean);
}

// S&P 500 and the top 50 cryptos on the daily chart.
// job: { settings, prev: { key: action }, weights }
// result: { at, scanned, buys, sells, newBuys, newSells, actions, weights, errors, alert }
export async function runMarket(job, deps = defaultDeps) {
  const tf = '1D';
  const { settings } = job;
  const weights = { ...(job.weights || {}) };
  const errors = {};
  let stocks;
  try {
    stocks = parseSp500(await deps.fetchText(SP500_CSV));
    if (stocks.length < 400) throw new Error(`only ${stocks.length} rows`);
  } catch (e) {
    errors.sp500 = `S&P 500 list: ${e.message}; using the copy saved with the server`;
    stocks = parseSp500(await readFile(new URL('./sp500.csv', import.meta.url), 'utf8'));
  }
  let crypto = [];
  try {
    crypto = await deps.fetchCryptoTop(50);
  } catch (e) {
    errors.cryptoTop = `Top crypto list: ${e.message}`;
  }
  const results = [];
  await pool([...crypto, ...stocks], 4, async item => {
    try {
      results.push(await score(item, tf, settings, weights, deps));
    } catch (e) {
      errors[key(item)] = e.message;
    }
  });
  const prev = job.prev || {};
  const actions = Object.fromEntries(results.map(r => [r.key, r.action]));
  const buys = results.filter(r => r.action === 'buy').sort((a, b) => b.score - a.score);
  const sells = results.filter(r => r.action === 'sell').sort((a, b) => a.score - b.score);
  // New ideas only: symbols that were scanned before and just turned buy or sell.
  const fresh = list => list.filter(r => r.key in prev && prev[r.key] !== r.action);
  const newBuys = fresh(buys);
  const newSells = fresh(sells);
  const names = list => list.slice(0, 4).map(r => `${r.symbol} ${fmtScore(r.score)}`).join(', ');
  let alert = null;
  if (newBuys.length || newSells.length) {
    alert = {
      kind: 'market',
      title: `Market scan: ${[newBuys.length && `${newBuys.length} new buy`, newSells.length && `${newSells.length} new sell`].filter(Boolean).join(', ')} idea${newBuys.length + newSells.length === 1 ? '' : 's'}`,
      body: [newBuys.length && `Buy: ${names(newBuys)}`, newSells.length && `Sell: ${names(newSells)}`].filter(Boolean).join('. '),
      hash: 'signals',
    };
  }
  // Keep the weights file from growing without end: only what this scan used.
  const used = new Set(results.map(r => `${r.key}:${tf}`));
  const kept = Object.fromEntries(Object.entries(weights).filter(([k]) => used.has(k)));
  return {
    at: deps.now(),
    tf,
    scanned: results.length,
    total: stocks.length + crypto.length,
    buys: buys.slice(0, 25),
    sells: sells.slice(0, 25),
    newBuys: newBuys.map(r => r.key),
    newSells: newSells.map(r => r.key),
    actions,
    weights: kept,
    errors,
    alert,
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input);
  const result = job.mode === 'market' ? await runMarket(job) : await runWatch(job);
  process.stdout.write(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exit(1);
  });
}
