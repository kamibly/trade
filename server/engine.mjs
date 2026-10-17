// The server's signal engine. It runs copies of the app's own modules (js/,
// copied from app/js by `npm run sync-server`), so
// a symbol scores exactly the same on the server as on the phone.
//
// The Python service runs it as:  node engine.mjs < job.json > result.json
// job: { mode: 'watch' | 'prices' | 'market' | 'dataset', ... }  (see the run* functions below)

import { TIMEFRAMES } from './js/candles.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchCandles, fetchCryptoTop } from './js/data.js';
import { stockSources } from './stocks.mjs';
import { proxiedFetch, fallbackFetch } from './proxy.mjs';
import { analyze, signalAt, baseVotesAt, METHOD_IDS, MIN_CANDLES } from './js/signals.js';
import { featureNames, featureVector, sequence, label, turnLabels } from './js/ml.js';
import { summarize, alertFor, learn, learnKey, ruleOf, tradeRecordLine, WEIGHTS_MAX_AGE_MS } from './js/scanner.js';
import { checkHolding } from './js/portfolio.js';
import * as paper from './js/paper.js';
import { formatMoney } from './js/format.js';
import { SETUPS } from './js/setups.js';
import { lite, findOpportunities, digest } from './opportunities.mjs';

const SP500_CSV = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
const fmtScore = v => `${v > 0 ? '+' : ''}${Math.round(v)}`;
const key = item => `${item.type}:${item.symbol}`;

// Yahoo Finance answers 429 when asked too fast, and the watch, the scans,
// training and the minute price check each run their own engine. So every run
// spaces its Yahoo calls, and a 429 pauses all of them: the pause is shared
// through a file in the data folder. After the last retry a run stops asking
// for a few minutes, so a long scan fails fast instead of hammering.
const YAHOO_GAP_MS = 300;
const YAHOO_WAITS_MS = [3000, 10000, 30000];
const YAHOO_GIVE_UP_MS = 5 * 60_000;
const COOLDOWN_FILE = join(process.env.DATA_DIR || '/data', 'yahoo-cooldown');
const fileCooldown = {
  get: async () => Number(await readFile(COOLDOWN_FILE, 'utf8').catch(() => 0)) || 0,
  set: async until => { await writeFile(COOLDOWN_FILE, String(until)).catch(() => {}); },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function politely(fn, { gap = YAHOO_GAP_MS, waits = YAHOO_WAITS_MS, giveUp = YAHOO_GIVE_UP_MS, wait = sleep, now = Date.now, cooldown = fileCooldown } = {}) {
  let next = 0;
  let blockedUntil = 0;
  let blockedError = null;
  return async (...args) => {
    for (let attempt = 0; ; attempt++) {
      if (now() < blockedUntil) throw blockedError;
      const paused = await cooldown.get();
      const slot = Math.max(now(), next, paused);
      next = slot + gap;
      if (slot > now()) await wait(slot - now());
      try {
        return await fn(...args);
      } catch (e) {
        if (e.status !== 429) throw e;
        if (attempt >= waits.length) {
          blockedUntil = now() + giveUp;
          blockedError = e;
          throw e;
        }
        await cooldown.set(Math.max(await cooldown.get(), now() + waits[attempt]));
      }
    }
  };
}

// Nasdaq, the backup for daily charts and prices, gets the same spacing; it
// isn't retried, since Yahoo is still asked first next time.
const memoryCooldown = () => { let until = 0; return { get: async () => until, set: async t => { until = t; } }; };
// STOCK_PROXY: when Yahoo or Nasdaq refuse the VM, their requests go out
// through another address (see proxy.mjs) for the next 30 minutes.
const PROXY_FILE = join(process.env.DATA_DIR || '/data', 'stock-proxy-until');
const proxyStore = {
  get: async () => Number(await readFile(PROXY_FILE, 'utf8').catch(() => 0)) || 0,
  set: async until => { await writeFile(PROXY_FILE, String(until)).catch(() => {}); },
};
const stockFetch = process.env.STOCK_PROXY ? fallbackFetch(fetch, proxiedFetch(process.env.STOCK_PROXY), { store: proxyStore }) : fetch;
const stocks = stockSources({ fetchFn: stockFetch, limitYahoo: politely, limitNasdaq: f => politely(f, { gap: 250, waits: [], cooldown: memoryCooldown() }) });

export const defaultDeps = {
  fetchCandles,
  yahooCandles: stocks.candles,
  yahooPrice: stocks.price,
  fetchCryptoTop,
  fetchText: async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.text();
  },
  now: () => Date.now(),
};

// Stocks: Yahoo Finance first (no key), then Nasdaq for daily and weekly charts
// (see stocks.mjs), then Twelve Data if the server has a key.
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

// Scores one symbol, re-learning its method weights (and, with tuning on, its
// thresholds and mode) from the backtest once a day, or when the settings or
// the ML models change. `onS` gets the analyzed chart when the caller needs it.
async function score(item, tf, settings, weightsCache, deps, models, onS) {
  const { candles } = await candlesFor(item, tf, settings, deps);
  if (candles.length < MIN_CANDLES) throw new Error(`Only ${candles.length} candles, ${MIN_CANDLES} needed`);
  const S = analyze(candles, { models });
  const wKey = `${key(item)}:${tf}`;
  const modelsAt = (models && models.trainedAt) || null;
  let w = weightsCache[wKey];
  if (!w || deps.now() - w.at >= WEIGHTS_MAX_AGE_MS || (w.modelsAt || null) !== modelsAt || w.key !== learnKey(settings)) {
    w = { at: deps.now(), modelsAt, ...learn(S, settings) };
    weightsCache[wKey] = w;
  }
  const sig = signalAt(S, candles.length - 1, {
    thresholds: ruleOf(settings, w), weights: w.weights || undefined, stopAtr: settings.stopAtr, takeAtr: settings.takeAtr,
  });
  if (!sig) throw new Error('Not enough history');
  if (onS) onS(S);
  return { ...summarize(item, sig, tf, w), at: deps.now() };
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

// Paper trades become a short line for the app's Paper tab.
const setupNote = ev => (ev.setup === 'scan' ? ', market scan idea' : ev.setup && SETUPS[ev.setup] ? `, ${SETUPS[ev.setup].name.toLowerCase()}` : '');
const paperLine = ev => (ev.kind === 'open'
  ? `Bought ${ev.symbol} at ${formatMoney(ev.price)} (${formatMoney(ev.cost)}${setupNote(ev)})`
  : `Sold ${ev.symbol} at ${formatMoney(ev.price)} (${ev.reason === 'time' ? 'holding period over' : ev.reason}${setupNote(ev)}), ${ev.pnl >= 0 ? '+' : ''}${formatMoney(ev.pnl)}`);

// Watchlist and holdings on the alert timeframe, plus the paper account.
// job: { tf, settings, items, holdings, prev: { key: signal }, weights: { "key:tf": {at, weights} },
//        models, paper: account | null, riskPct }
// result: { signals, alerts, changes, holdingsAlerted, weights, errors, paper, paperEvents }
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
  const changes = {};
  for (const [k, s] of Object.entries(signals)) {
    const p = prev[k];
    // Like the phone: no alert the first time a symbol is scored or after a timeframe change.
    const action = p && p.tf === tf ? alertFor(p.action, s.action) : null;
    if (!action) continue;
    changes[k] = action;
    const yours = action === 'sell' && held.has(k);
    const record = action === 'buy' ? tradeRecordLine(s.symbol, s.record) : '';
    alerts.push({
      kind: 'signal',
      key: k,
      setups: ['signal'],
      title: `${action === 'buy' ? 'Buy' : 'Sell'} signal: ${s.symbol}${yours ? ' (you hold it)' : ''}`,
      body: `Score ${fmtScore(s.score)} on the ${TIMEFRAMES[tf].label} chart. ${levels(s)}.${s.top.length ? ` Led by ${s.top.join(', ')}.` : ''}${record ? ` ${record}` : ''}`,
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
  // The paper account trades the same signals: buys a Buy it doesn't hold yet
  // (within 1 ATR of where it began), sells on a Sell, the stop-loss or the target.
  let paperEvents = [];
  if (job.paper) {
    paperEvents = paper.step(job.paper, { signals, alerts: changes, riskPct: job.riskPct || 1, now: deps.now() })
      .map(ev => ({ ...ev, at: deps.now(), text: paperLine(ev) }));
  }
  return { signals, alerts, changes, holdingsAlerted, weights, errors, paper: job.paper || null, paperEvents };
}

// The latest price: Yahoo Finance's live quote for stocks, the newest 15-minute
// candle for crypto (Coinbase, then Kraken, then CoinGecko).
async function latestPrice(item, settings, deps) {
  if (item.type === 'stock') {
    try {
      return await deps.yahooPrice(item);
    } catch (e) {
      if (!settings.twelveKey) throw e;
    }
  }
  const { candles } = await candlesFor(item, '15m', settings, deps);
  if (!candles.length) throw new Error('No price');
  return candles.at(-1).close;
}

// Every-minute check of holdings and paper positions against their stop-loss
// and target, at the latest price.
// job: { settings, items, holdings, paper, actions: { key: last signal action } }
// result: { prices, alerts, holdingsAlerted, paper, paperEvents, errors }
export async function runPrices(job, deps = defaultDeps) {
  const { settings } = job;
  const prices = {};
  const errors = {};
  await pool(job.items || [], 4, async item => {
    try {
      prices[key(item)] = await latestPrice(item, settings, deps);
    } catch (e) {
      errors[key(item)] = e.message;
    }
  });
  const alerts = [];
  const holdingsAlerted = {};
  for (const h of job.holdings || []) {
    const price = prices[h.key];
    if (!Number.isFinite(price)) continue;
    // Only levels here: Sell signals come from the candle-close checks.
    const { alerts: hits, alerted } = checkHolding(h, price, 'hold');
    holdingsAlerted[h.id] = alerted;
    for (const a of hits) {
      if (a !== 'stop' && a !== 'target') continue;
      alerts.push({
        kind: a,
        key: h.key,
        urgent: a === 'stop',
        title: a === 'stop' ? `Stop-loss hit: ${h.symbol}` : `Target reached: ${h.symbol}`,
        body: a === 'stop' ? `${formatMoney(price)} is at or below your stop of ${formatMoney(h.stop)}. Consider selling.`
          : `${formatMoney(price)} is at or above your target of ${formatMoney(h.take)}. Consider taking profit.`,
        hash: 'portfolio',
      });
    }
  }
  let paperEvents = [];
  if (job.paper) {
    const signals = Object.fromEntries(Object.entries(prices).map(([k, p]) => [k, { entry: p }]));
    paperEvents = paper.step(job.paper, { signals, alerts: {}, now: deps.now() })
      .map(ev => ({ ...ev, at: deps.now(), text: paperLine(ev) }));
  }
  return { prices, alerts, holdingsAlerted, paper: job.paper || null, paperEvents, errors };
}

// One CSV line into its fields (quoted fields may hold commas and "" quotes).
function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Symbol, Security, GICS Sector, ..., CIK: the name, the sector (for the
// ranking) and the SEC's company number (for filings).
export function parseSp500(csv) {
  const lines = csv.split(/\r?\n/);
  const head = csvFields(lines[0] || '').map(h => h.trim().toLowerCase());
  const col = name => head.indexOf(name);
  const [iSym, iName, iSector, iCik] = [col('symbol'), col('security'), col('gics sector'), col('cik')];
  return lines.slice(1)
    .map(line => {
      const f = csvFields(line);
      const symbol = (f[iSym < 0 ? 0 : iSym] || '').trim();
      if (!/^[A-Z0-9.\-]+$/.test(symbol)) return null;
      const item = { type: 'stock', symbol, name: (f[iName < 0 ? 1 : iName] || symbol).trim() };
      if (iSector >= 0 && f[iSector]) item.sector = f[iSector].trim();
      if (iCik >= 0 && /^\d+$/.test((f[iCik] || '').trim())) item.cik = Number(f[iCik]);
      return item;
    })
    .filter(Boolean);
}

// S&P 500 and the top 50 cryptos on the daily chart, plus the opportunity setups.
// job: { settings, prev: { key: action }, weights, models,
//        events: { insiders, earnings, fng, funding }, enabled: { setup: bool },
//        held: [key], announced: [id], muted: [setup],
//        scope: 'stocks' | 'crypto' | 'all', items: crypto to scan (default the top 50),
//        only: [key] to rescore just these (fast moves; no setups),
//        buyStarts: { key: { at, entry } } where each current buy idea began }
// result: { at, scanned, buys, sells, newBuys, newSells, actions, weights, errors, alert,
//           opportunities, records, counts, warnings, digest }
export async function runMarket(job, deps = defaultDeps) {
  const tf = '1D';
  const { settings } = job;
  const weights = { ...(job.weights || {}) };
  const errors = {};
  const scope = job.scope || 'all';
  let stocks = [];
  if (scope !== 'crypto') {
    try {
      stocks = parseSp500(await deps.fetchText(SP500_CSV));
      if (stocks.length < 400) throw new Error(`only ${stocks.length} rows`);
    } catch (e) {
      errors.sp500 = `S&P 500 list: ${e.message}; using the copy saved with the server`;
      stocks = parseSp500(await readFile(new URL('./sp500.csv', import.meta.url), 'utf8'));
    }
  }
  let crypto = [];
  if (scope !== 'stocks') {
    if (job.items && job.items.length) crypto = job.items;
    else {
      try {
        crypto = await deps.fetchCryptoTop(50);
      } catch (e) {
        errors.cryptoTop = `Top crypto list: ${e.message}`;
      }
    }
  }
  let items = [...crypto, ...stocks];
  if (job.only) {
    const only = new Set(job.only);
    items = items.filter(i => only.has(key(i)));
  }
  const results = [];
  const rows = [];
  await pool(items, 4, async item => {
    try {
      results.push(await score(item, tf, settings, weights, deps, job.models, S => rows.push({ item, S: lite(S), sector: item.sector || null })));
    } catch (e) {
      errors[key(item)] = e.message;
    }
  });
  const setups = job.only ? {} : await opportunitiesFor({ ...job, scope }, rows, deps, errors);
  const prev = job.prev || {};
  const actions = Object.fromEntries(results.map(r => [r.key, r.action]));
  const buys = results.filter(r => r.action === 'buy').sort((a, b) => b.score - a.score);
  const sells = results.filter(r => r.action === 'sell').sort((a, b) => a.score - b.score);
  // New ideas only: symbols that were scanned before and just turned buy or sell.
  const fresh = list => list.filter(r => r.key in prev && prev[r.key] !== r.action);
  const newBuys = fresh(buys);
  const newSells = fresh(sells);
  // Where each buy idea began: kept while it stays a Buy, so the paper account
  // can buy an idea it missed while the price is still near its start.
  const oldStarts = job.buyStarts || {};
  const buyStarts = Object.fromEntries(buys.map(r => [r.key,
    prev[r.key] === 'buy' && oldStarts[r.key] ? oldStarts[r.key] : { at: deps.now(), entry: r.entry }]));
  const names = list => list.slice(0, 4).map(r => `${r.symbol} ${fmtScore(r.score)}`).join(', ');
  let alert = null;
  if (newBuys.length || newSells.length) {
    alert = {
      kind: 'market',
      setups: ['signal'],
      title: `${scope === 'crypto' ? 'Crypto' : 'Market'} scan: ${[newBuys.length && `${newBuys.length} new buy`, newSells.length && `${newSells.length} new sell`].filter(Boolean).join(', ')} idea${newBuys.length + newSells.length === 1 ? '' : 's'}`,
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
    total: items.length,
    buys: buys.slice(0, 100),
    sells: sells.slice(0, 100),
    newBuys: newBuys.map(r => r.key),
    newSells: newSells.map(r => r.key),
    actions,
    weights: kept,
    errors,
    alert,
    // For the paper account: every buy idea still within 1 ATR of where it
    // began, strongest first (each bought once per idea), and every Sell.
    scanBuys: buys.map(r => ({
      id: `scan:${r.key}:${buyStarts[r.key].at}`, setup: 'scan', key: r.key, symbol: r.symbol, type: r.type, entry: r.entry, stop: r.stop, take: r.take, ev: r.score / 100,
      ranAway: r.entry > buyStarts[r.key].entry + (r.atr || 0),
    })),
    buyStarts,
    scanSells: sells.map(r => ({ key: r.key, entry: r.entry })),
    // Where each symbol stood, for the every-minute fast-move watch.
    levels: Object.fromEntries(results.filter(r => r.type === 'crypto').map(r => [r.key, { entry: r.entry, atr: r.atr }])),
    scope,
    ...setups,
  };
}

// The setups on the scan's charts. SPY is the stocks' benchmark, Bitcoin the crypto's.
async function opportunitiesFor(job, rows, deps, errors) {
  let spy = null;
  if (job.scope !== 'crypto') {
    try {
      const { candles } = await deps.yahooCandles({ type: 'stock', symbol: 'SPY', name: 'S&P 500' }, '1D');
      if (candles.length >= MIN_CANDLES) spy = lite(analyze(candles));
    } catch (e) {
      errors.spy = `S&P 500 benchmark (SPY): ${e.message}`;
    }
  }
  const btcRow = rows.find(r => r.item.type === 'crypto' && r.item.symbol === 'BTC');
  const found = findOpportunities({
    rows,
    spy,
    btc: btcRow ? btcRow.S : null,
    events: job.events || {},
    settings: job.settings,
    enabled: job.enabled || {},
    held: new Set(job.held || []),
    nowSec: Math.floor(deps.now() / 1000),
  });
  const push = digest(found.opportunities, new Set(job.announced || []), new Set(job.muted || []));
  return {
    opportunities: found.opportunities.slice(0, 30),
    records: found.records,
    counts: found.counts,
    warnings: found.warnings,
    digest: push,
  };
}

// The paper account takes the market scan's opportunities.
// job: { paper, opportunities, riskPct }  result: { paper, paperEvents }
// job: { paper, opportunities, scanBuys, scanSells, riskPct }
export async function runPaper(job, deps = defaultDeps) {
  const opts = { riskPct: job.riskPct || 1, now: deps.now() };
  const paperEvents = [
    ...paper.closeOnSells(job.paper, job.scanSells || [], 'scan', opts),
    ...paper.openSetups(job.paper, job.opportunities || [], opts),
    ...paper.openSetups(job.paper, job.scanBuys || [], opts),
  ].map(ev => ({ ...ev, at: deps.now(), text: paperLine(ev) }));
  return { paper: job.paper, paperEvents };
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
// result: { tf, features, symbols, rows: { key, t, x, seq, y, ret, yb, yt }[], errors }
// (yb and yt are the turning-point labels, null for the last candles)
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
        const turn = turnLabels(S, i, settings);
        rows.push({
          key: key(item), t: candles[i].time, x, seq: seq.map(r => r.map(v => Number(v.toFixed(4)))), y, ret: S.close[i + 10] / S.close[i] - 1,
          yb: turn ? turn.bottom : null, yt: turn ? turn.top : null,
        });
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
  const run = { market: runMarket, dataset: runDataset, prices: runPrices, paper: runPaper }[job.mode] || runWatch;
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
