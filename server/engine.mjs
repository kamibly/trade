// The server's signal engine. It runs copies of the app's own modules (js/,
// copied from app/js by `npm run sync-server`), so
// a symbol scores exactly the same on the server as on the phone.
//
// The Python service runs it as:  node engine.mjs < job.json > result.json
// job: { mode: 'watch' | 'market' | 'dataset', ... }  (see runWatch, runMarket and runDataset below)

import { TIMEFRAMES } from './js/candles.js';
import { readFile } from 'node:fs/promises';
import { fetchCandles, yahooCandles, fetchCryptoTop } from './js/data.js';
import { analyze, signalAt, baseVotesAt, METHOD_IDS, MIN_CANDLES } from './js/signals.js';
import { featureNames, featureVector, sequence, label } from './js/ml.js';
import { backtest } from './js/backtest.js';
import { summarize, alertFor, WEIGHTS_MAX_AGE_MS } from './js/scanner.js';
import { checkHolding } from './js/portfolio.js';
import { formatMoney } from './js/format.js';

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
// `models` are this timeframe's ML models; new models mean new weights.
async function score(item, tf, settings, weightsCache, deps, models) {
  const { candles } = await candlesFor(item, tf, settings, deps);
  if (candles.length < MIN_CANDLES) throw new Error(`Only ${candles.length} candles, ${MIN_CANDLES} needed`);
  const thresholds = { buy: settings.buyAt, sell: settings.sellAt };
  const S = analyze(candles, { models });
  const wKey = `${key(item)}:${tf}`;
  const modelsAt = (models && models.trainedAt) || null;
  let w = weightsCache[wKey];
  if (!w || deps.now() - w.at >= WEIGHTS_MAX_AGE_MS || (w.modelsAt || null) !== modelsAt) {
    const bt = backtest(S, { thresholds, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr });
    w = { at: deps.now(), modelsAt, weights: bt ? bt.weights : null };
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
      signals[key(item)] = await score(item, tf, settings, weights, deps, job.models);
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
      results.push(await score(item, tf, settings, weights, deps, job.models));
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

// Your symbols plus a spread of S&P 500 stocks and top cryptos, so the models
// learn from more than a handful of charts. `total` caps the list.
async function trainingItems(job, deps) {
  const out = [];
  const seen = new Set();
  const add = item => {
    if (out.length < job.total && !seen.has(key(item))) {
      seen.add(key(item));
      out.push(item);
    }
  };
  (job.items || []).forEach(add);
  const room = job.total - out.length;
  if (room > 0) {
    let crypto = [];
    try {
      crypto = await deps.fetchCryptoTop(20);
    } catch { /* stocks alone are enough */ }
    crypto.slice(0, Math.ceil(room / 5)).forEach(add);
    const stocks = parseSp500(await readFile(new URL('./sp500.csv', import.meta.url), 'utf8'));
    const step = Math.max(1, Math.floor(stocks.length / (job.total - out.length || 1)));
    stocks.filter((_, i) => i % step === 0).forEach(add);
  }
  return out;
}

// Training data for the ML models: one row per candle that has a known outcome.
// job: { tf, items, settings, total }
// result: { tf, features, symbols, rows: { key, t, x, seq, y, ret }[], errors }
export async function runDataset(job, deps = defaultDeps) {
  const { tf, settings } = job;
  const names = featureNames(METHOD_IDS);
  const rows = [];
  const errors = {};
  const items = job.total ? await trainingItems(job, deps) : job.items || [];
  await pool(items, 4, async item => {
    try {
      const { candles } = await candlesFor(item, tf, settings, deps);
      if (candles.length < MIN_CANDLES + 20) throw new Error(`Only ${candles.length} candles`);
      const S = analyze(candles);
      for (let i = MIN_CANDLES - 1; i < candles.length; i++) {
        const y = label(S, i);
        if (y === null) break;
        const seq = sequence(S, i);
        if (!seq) continue;
        const x = featureVector(S, i, baseVotesAt(S, i), names).map(v => (Number.isFinite(v) ? Number(v.toFixed(5)) : null));
        rows.push({ key: key(item), t: candles[i].time, x, seq: seq.map(r => r.map(v => Number(v.toFixed(4)))), y, ret: S.close[i + 10] / S.close[i] - 1 });
      }
    } catch (e) {
      errors[key(item)] = e.message;
    }
  });
  return { tf, features: names, symbols: items.length, rows, errors };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input);
  const run = { market: runMarket, dataset: runDataset }[job.mode] || runWatch;
  const result = await run(job);
  if (job.stream) {
    // Training data is big: a header line, then one row per line, so Python
    // can read it without holding the whole text at once.
    const { rows, ...header } = result;
    process.stdout.write(`${JSON.stringify(header)}\n`);
    for (const row of rows) {
      if (!process.stdout.write(`${JSON.stringify(row)}\n`)) await new Promise(r => process.stdout.once('drain', r));
    }
  } else {
    process.stdout.write(JSON.stringify(result));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exit(1);
  });
}
