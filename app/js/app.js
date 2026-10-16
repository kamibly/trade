import { TIMEFRAMES, isIntraday, changeOverDay } from './candles.js';
import { formatMoney, formatChange, priceDecimals, toCad, timeAgo } from './format.js';
import * as store from './storage.js';
import {
  fetchCandles, fetchQuotes, fetchCryptoTop, fetchUsdCad, checkStock, checkTwelveKey, twelveLimiter,
} from './data.js';
import { PriceChart } from './chart.js';
import * as F from './forecast.js';
import {
  analyze, signalAt, scoreVotes, crossings, actionFor, baseVotesAt, GROUPS, MIN_CANDLES,
} from './signals.js';
import { scanItem, alertFor, manualRule, autoTune, learnKey, backtestOptions, learnedFrom, ruleOf, tradeRecordLine } from './scanner.js';
import { SETUPS, recordLine, proven as setupProven, MIN_PROVEN } from './setups.js';
import { notify, canNotify, askPermission, inQuietHours } from './notify.js';
import { voteMatrix, backtest } from './backtest.js';
import * as paper from './paper.js';
import * as pf from './portfolio.js';
import { atr as atrSeries } from './indicators.js';
import * as srv from './server.js';
import { usable as modelUsable, mlOutlook, HORIZON as ML_HORIZON, TURN_EDGE } from './ml.js';

export const APP_VERSION = '0.9.3 (crypto around the clock)';
const MARKET_REFRESH_MS = 10 * 60_000;
const SYNC_DELAY_MS = 2000;
const SCAN_EVERY_MS = 5 * 60_000;
const FORECAST_STEPS = 20;

const QUOTE_REFRESH_MS = 60_000;
// Stock quotes cost one Twelve Data credit each (8 a minute free), so they
// refresh less often than crypto and leave room for charts.
const STOCK_REFRESH_MS = 5 * 60_000;
const FX_MAX_AGE_MS = 12 * 3600_000;
const TOP_MAX_AGE_MS = 24 * 3600_000;

const $ = id => document.getElementById(id);

const state = {
  view: 'signals',
  filter: 'all',
  editing: false,
  watchlist: store.getWatchlist(),
  settings: store.getSettings(),
  quotes: store.getQuotes(),
  fx: store.getFx(),
  chartItem: null,
  chartTf: null,
  chart: null,
  chartCandles: [],
  chartLoad: 0,
  chartAbort: null,
  quotesBusy: false,
  stocksAt: 0,
  addType: 'stock',
  cryptoTop: store.getCryptoTop(),
  signals: store.getSignals(),
  holdings: store.getHoldings(),
  paper: store.getPaper(),
  serverPaper: store.getServerPaper(), // the server's paper account while connected
  pfTab: 'holdings',
  holdEditing: false,
  holdType: 'stock',
  analysis: null, // { id, S, votes, bt } for the chart on screen
  market: store.getMarket(), // { at, fetchedAt, buys, sells, ... } from the server's scan
  models: store.getModels(), // { tf: { cutoff, trainedAt, lgbm, lstm } } trained on the server
  syncMeta: store.getSyncMeta(),
  syncTimer: null,
  serverStatus: null,
  scan: { busy: false, done: 0, total: 0, at: 0, errors: {}, abort: null },
  rated: {}, // opportunity id -> true (useful) or false, rated on this phone
};

// Small DOM helper: text always goes in as text, never as HTML.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c);
  return node;
}

let toastTimer;
function toast(message, action) {
  const t = $('toast');
  t.replaceChildren(el('span', { text: message }));
  if (action) t.append(el('button', { type: 'button', class: 'primary', text: action.label, onclick: action.run }));
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const changeClass = pct => (pct > 0 ? 'change up' : pct < 0 ? 'change down' : 'change');
const cadRate = () => (state.settings.showCad && state.fx ? state.fx.rate : NaN);
const thresholds = () => manualRule(state.settings);
const scoreClass = (score, rule = thresholds()) => (score >= rule.buy ? 'up' : score <= rule.sell ? 'down' : 'flat');
// One line on how a rule turns the score into Buy and Sell.
function ruleText(rule, tuned) {
  const who = tuned ? 'Tuned for this symbol: ' : '';
  return rule.mode === 'dip'
    ? `${who}buy the dip in an uptrend. Buy at ${fmtScore(rule.buy)} or more right after a pullback while the price is above its 200 average; sell at ${fmtScore(rule.sell)} or less, or when the price closes below that average.`
    : `${who}Buy at ${fmtScore(rule.buy)} or more, sell at ${fmtScore(rule.sell)} or less.`;
}
const ACTION_WORDS = { buy: 'Buy', sell: 'Sell', hold: 'Hold' };
// Everything that needs prices and signals: the watchlist plus held symbols.
function trackedItems() {
  const items = [...state.watchlist];
  const have = new Set(items.map(store.itemKey));
  for (const h of state.holdings) {
    if (have.has(h.key)) continue;
    have.add(h.key);
    items.push({ type: h.type, symbol: h.symbol, name: h.name, ...(h.geckoId ? { geckoId: h.geckoId } : {}) });
  }
  return items;
}
function findItem(key) {
  const own = trackedItems().find(i => store.itemKey(i) === key);
  if (own) return own;
  // Symbols from the server's market scan open as charts too.
  const m = state.market && [...(state.market.buys || []), ...(state.market.sells || []), ...(state.market.opportunities || [])].find(x => x.key === key);
  return m ? { type: m.type, symbol: m.symbol, name: m.name } : undefined;
}
const serverOn = () => !!(state.settings.serverUrl && state.settings.serverKey);
// With server alerts on, the server notifies; the open app only shows a toast.
const phoneNotifies = () => state.settings.notifications && !state.settings.serverPush;
const riskOpts = () => ({ stopAtr: state.settings.stopAtr, takeAtr: state.settings.takeAtr });
const fmtPct = v => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '–');
const priceOf = key => {
  const q = state.quotes[key];
  if (q && Number.isFinite(q.price)) return q.price;
  const s = state.signals[key];
  return s ? s.entry : NaN;
};

// ---- Views ------------------------------------------------------------------

const TITLES = { signals: 'Signals', watch: 'Watchlist', chart: 'Chart', portfolio: 'Portfolio', settings: 'Settings' };

// Hashes: #signals, #watch, #settings, #chart, or #chart/<type>/<symbol> from a notification.
function showView(route) {
  let [view, type, symbol] = String(route || '').split('/');
  if (!TITLES[view]) view = 'signals';
  if (view === 'chart' && type && symbol) {
    const item = findItem(`${type}:${decodeURIComponent(symbol)}`);
    if (item) { state.chartItem = item; state.chartTf = state.settings.alertTf; }
  }
  state.view = view;
  for (const v of Object.keys(TITLES)) $(`view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.view === view);
  $('title').textContent = TITLES[view];
  if (view === 'chart') openChart();
  if (view === 'settings') renderSettings();
  if (view === 'signals') renderSignals();
  if (view === 'portfolio') renderPortfolio();
  window.scrollTo(0, 0);
}

function go(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else showView(view);
}

// ---- Watchlist --------------------------------------------------------------

function renderWatchlist() {
  const list = $('watch-list');
  const items = state.watchlist.filter(i => state.filter === 'all' || i.type === state.filter);
  const rate = cadRate();
  list.replaceChildren(...items.map(item => {
    const q = state.quotes[store.itemKey(item)] || {};
    const hasPrice = Number.isFinite(q.price);
    const cad = toCad(q.price, rate);
    return el('li', { onclick: () => openChart(item, true) },
      el('div', { class: 'info' },
        el('div', { class: 'sym' }, item.symbol, el('span', { class: 'badge', text: item.type === 'stock' ? 'Stock' : 'Crypto' })),
        el('div', { class: 'name', text: item.name || '' })),
      state.editing
        ? el('button', {
          type: 'button', class: 'remove ghost', text: 'Remove', 'aria-label': `Remove ${item.symbol}`,
          onclick: e => { e.stopPropagation(); removeItem(item); },
        })
        : el('div', { class: 'quote' },
          el('div', { class: 'price', text: hasPrice ? formatMoney(q.price) : '–' }),
          Number.isFinite(cad) ? el('div', { class: 'sub', text: formatMoney(cad, 'CAD') }) : null,
          hasPrice && Number.isFinite(q.changePct) ? el('span', { class: changeClass(q.changePct), text: formatChange(q.changePct) }) : null,
          !hasPrice && q.error ? el('div', { class: 'sub bad', text: 'No price' }) : null));
  }));
  if (!items.length) list.append(el('p', { class: 'muted center', text: 'Nothing here yet. Tap Add symbol.' }));
  renderWatchNotice();
}

function renderWatchNotice() {
  const notice = $('watch-notice');
  const hasStocks = state.watchlist.some(i => i.type === 'stock');
  const errors = state.watchlist.map(i => state.quotes[store.itemKey(i)]).filter(q => q && q.error && !Number.isFinite(q.price));
  let msg = '';
  if (hasStocks && !state.settings.twelveKey) msg = 'Add your free Twelve Data key in Settings to see stock prices.';
  else if (errors.length) msg = errors[0].error;
  notice.textContent = msg;
  notice.hidden = !msg;
  const times = Object.values(state.quotes).map(q => q.at).filter(Boolean);
  $('watch-updated').textContent = times.length ? `Prices updated ${timeAgo(Math.max(...times))}` : '';
}

function removeItem(item) {
  state.watchlist = state.watchlist.filter(i => store.itemKey(i) !== store.itemKey(item));
  store.saveWatchlist(state.watchlist);
  markChanged();
  if (state.chartItem && store.itemKey(state.chartItem) === store.itemKey(item)) state.chartItem = null;
  renderWatchlist();
}

function addItem(item) {
  if (state.watchlist.some(i => store.itemKey(i) === store.itemKey(item))) {
    toast(`${item.symbol} is already on your watchlist`);
    return false;
  }
  state.watchlist.push(item);
  store.saveWatchlist(state.watchlist);
  markChanged();
  renderWatchlist();
  refreshQuotes({ force: true });
  toast(`Added ${item.symbol}`);
  return true;
}

async function refreshQuotes({ force = false } = {}) {
  if (state.quotesBusy || !navigator.onLine) return;
  state.quotesBusy = true;
  const withStocks = force || Date.now() - state.stocksAt >= STOCK_REFRESH_MS;
  if (withStocks) state.stocksAt = Date.now();
  try {
    const fresh = await fetchQuotes(trackedItems(), state.settings, { withStocks });
    // Keep the last good price when a refresh fails, but remember the error.
    for (const [k, q] of Object.entries(fresh)) {
      const old = state.quotes[k];
      state.quotes[k] = q.error && old && Number.isFinite(old.price) ? { ...old, error: q.error } : q;
    }
    store.saveQuotes(state.quotes);
  } catch (e) {
    console.warn('Quote refresh failed', e);
  } finally {
    state.quotesBusy = false;
    renderWatchlist();
    if (state.view === 'chart') renderChartHead();
    checkHoldings();
    if (state.view === 'portfolio') renderPortfolio();
  }
}

async function refreshFx(force = false) {
  if (!force && state.fx && Date.now() - state.fx.at < FX_MAX_AGE_MS) return;
  try {
    state.fx = await fetchUsdCad();
    store.saveFx(state.fx);
    renderWatchlist();
  } catch (e) {
    console.warn('USD to CAD rate failed', e);
  }
}

// ---- Add dialog -------------------------------------------------------------

function setAddType(type) {
  state.addType = type;
  for (const b of document.querySelectorAll('#add-form [data-type]')) b.classList.toggle('on', b.dataset.type === type);
  $('add-label').textContent = type === 'stock' ? 'Ticker, for example AAPL' : 'Coin symbol, for example BTC';
  $('add-input').setAttribute('list', type === 'crypto' ? 'crypto-options' : '');
  $('add-error').textContent = '';
}

async function loadCryptoTop() {
  if (state.cryptoTop && Date.now() - state.cryptoTop.at < TOP_MAX_AGE_MS) return state.cryptoTop.list;
  try {
    const list = await fetchCryptoTop(50);
    state.cryptoTop = { at: Date.now(), list };
    store.saveCryptoTop(state.cryptoTop);
  } catch (e) {
    if (!state.cryptoTop) throw e;
  }
  return state.cryptoTop.list;
}

function fillCryptoOptions(list) {
  $('crypto-options').replaceChildren(...list.map(c => el('option', { value: c.symbol, text: c.name })));
}

function openAddDialog() {
  setAddType(state.addType);
  $('add-input').value = '';
  $('add-dialog').showModal();
  $('add-input').focus();
  loadCryptoTop().then(fillCryptoOptions).catch(() => {});
}

async function resolveItem(type, symbol) {
  if (type === 'stock') {
    if (!state.settings.twelveKey) throw new Error('Add your Twelve Data key in Settings first.');
    const name = await checkStock(symbol, state.settings.twelveKey);
    return { type: 'stock', symbol, name };
  }
  const top = await loadCryptoTop().catch(() => []);
  const known = top.find(c => c.symbol === symbol);
  // Coins outside the top list still work through Coinbase or Kraken.
  return known ? { ...known } : { type: 'crypto', symbol, name: symbol };
}

async function submitAdd(e) {
  e.preventDefault();
  const symbol = $('add-input').value.trim().toUpperCase().replace(/\s+/g, '');
  const err = $('add-error');
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    err.textContent = 'Enter a ticker such as AAPL or BTC.';
    return;
  }
  const ok = $('add-ok');
  ok.disabled = true;
  err.textContent = 'Checking…';
  try {
    const item = await resolveItem(state.addType, symbol);
    if (addItem(item)) $('add-dialog').close();
    err.textContent = '';
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    ok.disabled = false;
  }
}

async function openTopCrypto() {
  showList('Top crypto by market value', [el('li', { class: 'muted', text: 'Loading…' })]);
  try {
    const list = await loadCryptoTop();
    const have = new Set(state.watchlist.map(store.itemKey));
    showList('Top crypto by market value', list.map((c, i) => el('li', {
      onclick: ev => {
        if (addItem({ ...c })) ev.currentTarget.querySelector('.sub').textContent = 'Added';
      },
    },
    el('div', { class: 'info' }, el('div', { class: 'sym', text: `${i + 1}. ${c.symbol}` }), el('div', { class: 'name', text: c.name })),
    el('div', { class: 'sub', text: have.has(store.itemKey(c)) ? 'On list' : 'Add' }))));
  } catch (e) {
    showList('Top crypto by market value', [el('li', { class: 'bad', text: e.message })]);
  }
}

function showList(title, items) {
  $('list-title').textContent = title;
  $('list-items').replaceChildren(...items);
  if (!$('list-dialog').open) $('list-dialog').showModal();
}

// ---- Chart ------------------------------------------------------------------

function ensureChart() {
  if (state.chart) return state.chart;
  try {
    state.chart = new PriceChart($('chart'));
  } catch (e) {
    $('chart-status').textContent = e.message;
  }
  return state.chart;
}

function renderTfButtons() {
  for (const b of document.querySelectorAll('#tf-seg button')) b.classList.toggle('on', b.dataset.tf === state.chartTf);
}

function renderChartHead() {
  const item = state.chartItem;
  if (!item) return;
  $('chart-symbol').textContent = item.symbol;
  const q = state.quotes[store.itemKey(item)];
  const candles = state.chartCandles;
  const last = candles.at(-1);
  // Prefer the live quote; fall back to the newest candle.
  const price = q && Number.isFinite(q.price) ? q.price : last ? last.close : NaN;
  const pct = q && Number.isFinite(q.changePct) ? q.changePct : changeOverDay(candles, TIMEFRAMES[state.chartTf].seconds);
  $('chart-price').textContent = formatMoney(price);
  const change = $('chart-change');
  change.textContent = Number.isFinite(pct) ? `${formatChange(pct)} 24h` : '';
  change.className = changeClass(pct);
  const cad = toCad(price, cadRate());
  $('chart-sub').textContent = [item.name, Number.isFinite(cad) ? `${formatMoney(cad, 'CAD')}` : ''].filter(Boolean).join(' · ');
}

function openChart(item, navigate = false) {
  if (item) state.chartItem = item;
  if (!state.chartItem) state.chartItem = state.watchlist[0] || null;
  if (!state.chartTf) state.chartTf = state.settings.timeframe;
  if (navigate) {
    go('chart');
    return;
  }
  renderTfButtons();
  if (!state.chartItem) {
    $('chart-symbol').textContent = 'No symbol';
    $('chart-status').textContent = 'Add a symbol to your watchlist first.';
    return;
  }
  loadChart();
}

async function loadChart() {
  const item = state.chartItem;
  const tf = state.chartTf;
  const chart = ensureChart();
  if (!item || !chart) return;
  const load = ++state.chartLoad;
  const key = `${store.itemKey(item)}:${tf}`;
  const status = $('chart-status');
  const draw = candles => {
    state.chartCandles = candles;
    const ref = candles.length ? candles.at(-1).close : 1;
    chart.setData(candles, { intraday: isIntraday(tf), key, decimals: priceDecimals(ref) });
    renderChartHead();
    renderAnalysis();
  };

  const saved = store.getCandles(item, tf);
  if (saved && saved.candles.length) draw(saved.candles);
  else { state.chartCandles = []; chart.clear(); renderChartHead(); renderAnalysis(); }

  if (!navigator.onLine) {
    status.textContent = saved ? `Offline. Showing prices saved ${timeAgo(saved.savedAt)}.` : 'Offline, and no saved prices for this chart yet.';
    return;
  }
  if (state.chartAbort) state.chartAbort.abort();
  const abort = new AbortController();
  state.chartAbort = abort;
  const wait = item.type === 'stock' && state.settings.twelveKey ? twelveLimiter.waitFor(1) : 0;
  status.textContent = wait > 0
    ? `Waiting for the free Twelve Data limit, about ${Math.ceil(wait / 1000)} seconds…`
    : 'Loading…';
  try {
    const { candles, source } = await fetchCandles(item, tf, state.settings, abort.signal);
    if (load !== state.chartLoad) return; // the user switched charts meanwhile
    store.saveCandles(item, tf, candles);
    draw(candles);
    status.textContent = `${candles.length} candles from ${source}, updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  } catch (e) {
    if (load !== state.chartLoad || e.name === 'AbortError') return;
    status.textContent = saved ? `${e.message} Showing prices saved ${timeAgo(saved.savedAt)}.` : e.message;
  }
}

function pickChartSymbol() {
  showList('Open chart', trackedItems().map(item => el('li', {
    onclick: () => { $('list-dialog').close(); openChart(item); },
  }, el('div', { class: 'info' }, el('div', { class: 'sym', text: item.symbol }), el('div', { class: 'name', text: item.name || '' })))));
}

// ---- Analysis under the chart ----------------------------------------------

const fmtScore = v => `${v > 0 ? '+' : ''}${Math.round(v)}`;

function scoreMeter(score) {
  // A bar from the middle: right and green for buy, left and red for sell.
  const pct = Math.min(50, Math.abs(score) / 2);
  return el('div', { class: 'meter', 'aria-hidden': 'true' },
    el('span', { class: `fill ${score >= 0 ? 'up' : 'down'}`, style: `${score >= 0 ? 'left' : 'right'}: 50%; width: ${pct}%` }));
}

function levelsLine(sig) {
  const word = sig.score >= 0 ? 'Target' : 'Target (falling)';
  return `Entry ${formatMoney(sig.entry)} · Stop ${formatMoney(sig.stop)} · ${word} ${formatMoney(sig.take)}`;
}

function chartOverlays(S, candles, scores, rule) {
  const o = state.settings.overlays;
  const n = candles.length;
  const step = TIMEFRAMES[state.chartTf].seconds;
  const last = candles[n - 1];
  const timeAt = i => (i < n ? candles[i].time : last.time + (i - n + 1) * step);
  const pts = arr => candles.map((c, i) => ({ time: c.time, value: arr[i] }));
  const overlays = {};
  if (o.ma) Object.assign(overlays, { sma20: pts(S.sma20), sma50: pts(S.sma50), sma200: pts(S.sma200) });
  if (o.bands) Object.assign(overlays, { bbUpper: pts(S.bb.upper), bbLower: pts(S.bb.lower) });
  if (o.cloud) {
    // The cloud is drawn 26 candles ahead of the values that make it.
    const { spanA, spanB, shift } = S.ichimoku;
    overlays.spanA = spanA.map((v, i) => ({ time: timeAt(i + shift), value: v }));
    overlays.spanB = spanB.map((v, i) => ({ time: timeAt(i + shift), value: v }));
  }
  if (o.forecast) {
    const g = F.gbmParams(S.close, n - 1);
    if (g) {
      const mc = F.monteCarlo(last.close, g, FORECAST_STEPS);
      const start = { time: last.time, value: last.close };
      overlays.fc50 = [start, ...mc.map((m, k) => ({ time: timeAt(n + k), value: m.p50 }))];
      overlays.fc10 = [start, ...mc.map((m, k) => ({ time: timeAt(n + k), value: m.p10 }))];
      overlays.fc90 = [start, ...mc.map((m, k) => ({ time: timeAt(n + k), value: m.p90 }))];
    }
  }
  // ML: a straight line to where the price went on average after similar
  // predictions in the models' test period, ML_HORIZON candles ahead.
  const titles = {};
  const outlook = mlOutlook(S, n - 1, baseVotesAt(S, n - 1), S.models);
  if (o.ml && outlook) {
    overlays.ml = [{ time: last.time, value: last.close }, { time: timeAt(n + ML_HORIZON - 1), value: last.close * (1 + outlook.ret) }];
    titles.ml = `ML ${fmtPct(outlook.ret)}`;
  }
  let markers = [];
  if (o.markers) {
    const hist = scores.map((v, i) => (i < n - 250 ? NaN : v));
    markers = crossings(hist, rule, S).map(x => ({ time: candles[x.i].time, action: x.action }));
  }
  return { overlays, markers, titles, outlook };
}

// The sentence under the chart that goes with the ML line.
function mlLineText(outlook, models) {
  if (!models) return '';
  if (!outlook) {
    const hasTable = ['lgbm', 'lstm'].some(k => models[k] && Array.isArray(models[k].outcomes));
    return hasTable
      ? 'ML line: no model passed its test for this timeframe, so there is no ML prediction.'
      : 'ML line: retrain the models on your server to get the prediction line.';
  }
  const who = outlook.models.map(m => m.name).join(' and ');
  return `ML: ${Math.round(outlook.up * 100)}% chance higher after fees in ${ML_HORIZON} candles, average move ${fmtPct(outlook.ret)}. That's what followed ${outlook.n} similar ${who} predictions in data the models never trained on.`;
}

function renderAnalysis() {
  const panel = $('analysis');
  const candles = state.chartCandles;
  for (const b of document.querySelectorAll('#overlay-chips button')) b.classList.toggle('on', !!state.settings.overlays[b.dataset.ov]);
  if (!state.chart) return;
  if (candles.length < MIN_CANDLES) {
    state.chart.setOverlays({}, []);
    $('ml-line').hidden = true;
    panel.replaceChildren(candles.length
      ? el('p', { class: 'muted small', text: `Signals need at least ${MIN_CANDLES} candles; this chart has ${candles.length}.` })
      : '');
    return;
  }
  // The votes and backtest take a moment on a phone, so they are kept until the candles change.
  const models = state.models[state.chartTf] || null;
  const id = `${store.itemKey(state.chartItem)}:${state.chartTf}:${candles.length}:${candles.at(-1).time}:${candles.at(-1).close}:${models ? models.trainedAt : ''}`;
  const key = learnKey(state.settings);
  if (!state.analysis || state.analysis.id !== id || state.analysis.key !== key) {
    const S = analyze(candles, { models });
    const votes = voteMatrix(S);
    const bt = backtest(S, backtestOptions(state.settings, votes));
    const learned = learnedFrom(bt, state.settings);
    if (bt) store.saveWeight(state.chartItem, state.chartTf, learned);
    state.analysis = { id, key, S, votes, bt, learned };
  }
  const { S, votes, bt, learned } = state.analysis;
  const weights = bt ? bt.weights : undefined;
  const rule = ruleOf(state.settings, learned);
  const tuned = autoTune(state.settings) && !!learned.rule;
  const opts = { thresholds: rule, ...riskOpts() };
  const scores = votes.map(v => (v.length ? scoreVotes(v, weights) : NaN));
  const { overlays, markers, titles, outlook } = chartOverlays(S, candles, scores, rule);
  state.chart.setOverlays(overlays, markers, titles);
  const mlText = state.settings.overlays.ml ? mlLineText(outlook, S.models) : '';
  $('ml-line').textContent = mlText;
  $('ml-line').hidden = !mlText;
  const sig = signalAt(S, candles.length - 1, { ...opts, weights });
  if (!sig) { panel.replaceChildren(); return; }

  const byGroup = {};
  for (const v of sig.votes) (byGroup[v.group] ||= []).push(v);
  panel.replaceChildren(
    el('div', { class: 'card score-card' },
      el('div', { class: 'score-row' },
        el('div', {},
          el('div', { class: 'muted small', text: `Combined score, ${TIMEFRAMES[state.chartTf].label} chart` }),
          el('div', { class: `score ${scoreClass(sig.score, rule)}`, text: fmtScore(sig.score) })),
        el('span', { class: `action ${sig.action}`, text: ACTION_WORDS[sig.action] })),
      scoreMeter(sig.score),
      el('p', { class: 'small', text: `${Math.round(sig.confidence * 100)}% of the methods with an opinion agree. ${ruleText(rule, tuned)}` }),
      rule.mode === 'dip' ? el('p', { class: 'muted small', text: dipLine(sig.ctx) }) : null,
      el('p', { class: 'small', text: levelsLine(sig) }),
      el('p', { class: 'muted small', text: `Stop is ${state.settings.stopAtr} × ATR and target ${state.settings.takeAtr} × ATR from the entry. ${bt ? 'Methods are weighted by how often they were right in the backtest below.' : 'Methods count equally until there is enough history to backtest.'} Not financial advice: these methods are often wrong.` })),
    bt ? backtestCard(bt) : el('p', { class: 'muted small', text: 'The backtest needs about 180 candles; this chart has fewer.' }),
    ...Object.entries(GROUPS).filter(([g]) => byGroup[g]).map(([g, title]) => el('div', { class: 'card votes' },
      el('h3', { text: title }),
      el('ul', {}, ...byGroup[g].map(v => el('li', {},
        el('div', { class: 'vote-name' }, el('span', { text: v.name }), el('span', { class: `vote-num ${v.vote > 0 ? 'good' : v.vote < 0 ? 'bad' : 'muted'}`, text: v.vote === 0 ? '0' : `${v.vote > 0 ? '+' : ''}${v.vote.toFixed(2)}` })),
        el('div', { class: 'muted small', text: methodNote(v, bt) }),
        scoreMeter(v.vote * 100)))))),
    modelsCard(models, bt),
  );
}

// What the server's models are and whether they earned a vote on this timeframe.
function modelsCard(models, bt) {
  if (!models) {
    return serverOn()
      ? el('p', { class: 'muted small', text: `Machine learning: your server hasn't trained models for the ${TIMEFRAMES[state.chartTf].label} chart yet. It trains every timeframe weekly, and any that has no models soon after it starts.` })
      : el('p', { class: 'muted small', text: 'Machine learning (LightGBM and an LSTM network) runs when your server is connected in Settings.' });
  }
  const fmtDate = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const row = (name, m, id) => {
    const t = m && m.test;
    if (!t) return el('div', { class: 'bt-row' }, el('span', { text: name }), el('span', { class: 'muted', text: 'not trained' }));
    const used = modelUsable(m);
    const s = bt && bt.stats[id];
    const base = Number.isFinite(t.base) ? ` (happens ${Math.round(t.base * 100)}% anyway)` : '';
    return el('div', { class: 'bt-row' },
      el('span', { text: name }),
      el('span', {
        class: used ? 'good' : 'muted',
        text: `right ${Math.round(t.hit * 100)}% of ${t.n} test calls${base} · ${used ? `votes${s && s.n ? ` · weight ${bt.weights[s.id].toFixed(2)}` : ''}` : 'not used'}`,
      }));
  };
  return el('div', { class: 'card' },
    el('h3', { text: 'Machine-learning models' }),
    el('p', { class: 'muted small', text: `Trained on your server ${fmtDate(models.trainedAt)} from ${models.symbols} charts. LightGBM and the LSTM predict whether the price is higher after fees ${ML_HORIZON} candles later. All four were tested on the newest ${models.testRows} candles they never trained on (prices went up ${Math.round(((models.lgbm && models.lgbm.test && models.lgbm.test.upShare) || 0) * 100)}% of the time there).` }),
    row('LightGBM', models.lgbm, 'lgbm'),
    row('LSTM', models.lstm, 'lstm'),
    row('Bottom finder', models.bottom, 'bottom'),
    row('Top finder', models.top, 'top'),
    el('p', { class: 'muted small', text: `The bottom finder learns whether a buy here reached its target before its stop; the top finder, whether the price fell to a target before rising to a stop. They only push the score their way. LightGBM and the LSTM vote only if right more than half the time on at least 200 clear test calls; the finders, only if right ${Math.round(TURN_EDGE * 100)} points more often than the outcome happens anyway. Like every method, the backtest then weights them by how often they were right.` }));
}

function methodNote(v, bt) {
  const s = bt && bt.stats[v.id];
  if (!s || !s.n) return v.note;
  return `${v.note} · right ${Math.round(s.hit * 100)}% of ${s.n} times · weight ${bt.weights[v.id].toFixed(2)}`;
}

function dipLine(ctx) {
  if (!ctx) return '';
  return ctx.uptrend
    ? `Uptrend now${ctx.pulledBack ? ', and the price just pulled back: a Buy can fire.' : ', but no pullback yet: waiting for RSI or Stochastic to dip.'}`
    : ctx.belowTrend ? 'The price is below its 200 average: no Buys until the uptrend is back.' : 'No clear uptrend yet: no Buys.';
}

function backtestCard(bt) {
  const fmtDate = t => new Date(t * 1000).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const line = (label, r) => el('div', { class: 'bt-row' },
    el('span', { text: label }),
    el('span', {
      class: r.totalReturn > 0 ? 'good' : r.totalReturn < 0 ? 'bad' : '',
      text: `${fmtPct(r.totalReturn)} · ${r.trades.length} trade${r.trades.length === 1 ? '' : 's'}${r.trades.length ? ` · ${Math.round(r.winRate * 100)}% won` : ''} · worst drop ${fmtPct(-r.maxDrawdown)}`,
    }));
  const w = bt.weighted;
  return el('div', { class: 'card' },
    el('h3', { text: 'Backtest' }),
    el('p', { class: 'muted small', text: `Weights learned from ${fmtDate(bt.trainFrom)} to ${fmtDate(bt.testFrom)}, then tested on the ${bt.testCandles} newer candles they never saw. Long only, buying on a new Buy score and selling on the stop-loss, target or a Sell score, with 0.1% fees.` }),
    bt.rule ? line(`Tuned levels (${bt.rule.mode === 'dip' ? 'dip mode' : 'standard'}, ${fmtScore(bt.rule.buy)} / ${fmtScore(bt.rule.sell)})`, bt.tuned) : null,
    bt.rule ? line('Standard levels (+40 / -40)', bt.standard) : line('Weighted methods', w),
    line('All methods equal', bt.equal),
    bt.rule ? el('p', { class: 'muted small', text: `The tuned levels were picked on the older candles only (where they made ${fmtPct(bt.tunedTrain ? bt.tunedTrain.totalReturn : NaN)}), so the test above shows whether they hold up on candles they never saw.` }) : null,
    el('div', { class: 'bt-row' }, el('span', { text: 'Buy and hold' }), el('span', { class: w.buyHold > 0 ? 'good' : 'bad', text: fmtPct(w.buyHold) })),
    w.open ? el('p', { class: 'small', text: `A test trade is still open from ${formatMoney(w.open.entry)}, counted at today's price.` }) : null,
    el('p', { class: 'muted small', text: 'Past results do not predict future ones, and a short test can be luck.' }));
}

// ---- Signals tab and scanner -----------------------------------------------

function signalCard(sig) {
  const item = findItem(sig.key);
  return el('li', { class: 'signal', onclick: () => { state.chartTf = sig.tf; openChart(item, true); } },
    el('div', { class: 'signal-top' },
      el('div', { class: 'sym' }, sig.symbol, el('span', { class: 'badge', text: sig.type === 'stock' ? 'Stock' : 'Crypto' }),
        el('span', { class: `action ${sig.action}`, text: ACTION_WORDS[sig.action] })),
      el('div', { class: `score ${scoreClass(sig.score, sig.rule)}`, text: fmtScore(sig.score) })),
    scoreMeter(sig.score),
    el('div', { class: 'sub', text: `${Math.round(sig.confidence * 100)}% agree · ${levelsLine(sig)}` }),
    sig.tuned && sig.rule ? el('div', { class: 'sub', text: tunedLine(sig) }) : null,
    sig.action === 'buy' && sig.record ? el('div', { class: 'sub', text: tradeRecordLine(sig.symbol, sig.record) }) : null,
    sig.top && sig.top.length ? el('div', { class: 'sub', text: `Led by ${sig.top.join(', ')}` }) : null);
}

// "Tuned: Buy +25, Sell -30, dip mode · test +8% vs +3% standard"
function tunedLine(sig) {
  const r = sig.rule;
  const t = sig.tuned.test;
  const test = t && t.tuned && t.standard ? ` · test ${fmtPct(t.tuned.ret)} vs ${fmtPct(t.standard.ret)} standard` : '';
  return `Tuned: Buy ${fmtScore(r.buy)}, Sell ${fmtScore(r.sell)}${r.mode === 'dip' ? ', dip mode' : ''}${test}`;
}

function renderSignals() {
  const tf = state.settings.alertTf;
  const all = Object.values(state.signals).filter(s => findItem(s.key) && s.tf === tf);
  const buys = all.filter(s => s.action === 'buy').sort((a, b) => b.score - a.score);
  const sells = all.filter(s => s.action === 'sell').sort((a, b) => a.score - b.score);
  const holds = all.filter(s => s.action === 'hold').sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
  const { scan } = state;
  const missingKey = !state.settings.twelveKey && state.watchlist.some(i => i.type === 'stock');
  $('scan-status').textContent = scan.busy
    ? `Scanning ${scan.done} of ${scan.total} on the ${TIMEFRAMES[tf].label} chart…`
    : scan.at ? `Scanned ${timeAgo(scan.at)} on the ${TIMEFRAMES[tf].label} chart.${missingKey ? ' Stocks need your Twelve Data key in Settings.' : ''}`
      : 'Not scanned yet.';
  $('scan-btn').disabled = scan.busy;
  const errors = Object.entries(scan.errors);
  const section = (title, list, empty) => [
    el('h2', { class: 'section', text: `${title} (${list.length})` }),
    list.length ? el('ul', { class: 'list' }, ...list.map(signalCard)) : el('p', { class: 'muted small', text: empty }),
  ];
  $('signals-body').replaceChildren(
    ...section('Buy ideas', buys, 'No symbol is a Buy right now.'),
    ...section('Sell ideas', sells, 'No symbol is a Sell right now.'),
    ...section('Watching', holds, 'Nothing else scanned yet.'),
    errors.length ? el('p', { class: 'muted small', text: `Could not score: ${errors.map(([k, e]) => `${k.split(':')[1]} (${e})`).join('; ')}` }) : '',
  );
  renderOpportunities();
  renderMarket();
}

// ---- Opportunities (from the server's market scan) -------------------------------

const setupName = id => (id === 'signal' ? 'Buy and Sell signals' : id === 'scan' ? 'Market scan ideas' : SETUPS[id] ? SETUPS[id].name : id);
const holdText = o => `${o.hold} ${o.type === 'stock' ? 'trading days' : 'days'}`;

async function rateSetup(setups, useful, id) {
  try {
    const { setups: info } = await srv.serverFetch(state.settings, '/feedback', { method: 'POST', body: { setups, useful, id } });
    if (id) state.rated[id] = useful;
    state.market = { ...state.market, setupsInfo: info };
    store.saveMarket(state.market);
    const muted = setups.filter(x => info.muted.includes(x));
    toast(muted.length ? `Thanks. ${setupName(muted[0])} alerts are now muted; turn them back on in Settings.` : 'Thanks, your rating is saved.');
    renderOpportunities();
  } catch (e) {
    toast(e.message);
  }
}

async function unmuteSetup(setup) {
  try {
    const { setups: info } = await srv.serverFetch(state.settings, '/setups/unmute', { method: 'POST', body: { setup } });
    state.market = { ...state.market, setupsInfo: info };
    store.saveMarket(state.market);
    toast(`${setupName(setup)} alerts are back on.`);
    renderOpportunities();
    renderSetupSettings();
  } catch (e) {
    toast(e.message);
  }
}

function feedbackButtons(setups, id) {
  const rated = state.rated[id];
  const button = (label, useful) => el('button', {
    type: 'button',
    class: rated === useful ? 'chosen' : '',
    text: label,
    onclick: e => { e.stopPropagation(); rateSetup(setups, useful, id); },
  });
  return el('div', { class: 'feedback' }, button('Useful', true), button('Not useful', false));
}

function opportunityCard(o) {
  const item = { type: o.type, symbol: o.symbol, name: o.name };
  const symbolRec = o.symbolRecord && o.symbolRecord.n >= 3
    ? `On ${o.symbol}: ${o.symbolRecord.wins} of ${o.symbolRecord.n} past cases made money, average ${fmtPct(o.symbolRecord.avg)}.` : '';
  return el('li', { class: 'signal opp', onclick: () => { state.chartTf = '1D'; openChart(item, true); } },
    el('div', { class: 'signal-top' },
      el('div', { class: 'sym' }, o.symbol, el('span', { class: 'badge', text: o.type === 'stock' ? 'Stock' : 'Crypto' }),
        el('span', { class: o.proven ? 'badge proven' : 'badge', text: o.proven ? 'Proven' : 'Watching, not proven' })),
      el('div', { class: `score ${o.ev > 0 ? 'up' : 'down'}`, text: fmtPct(o.ev) })),
    el('div', { class: 'sub', text: setupName(o.setup) }),
    el('p', { class: 'why', text: o.why }),
    el('div', { class: 'sub', text: recordLine(o.record, o.hold) }),
    symbolRec ? el('div', { class: 'sub', text: symbolRec }) : null,
    el('div', { class: 'sub', text: `Entry ${formatMoney(o.entry)} · Stop ${formatMoney(o.stop)} · Target ${formatMoney(o.take)} · hold up to ${holdText(o)}` }),
    feedbackButtons([o.setup], o.id));
}

function setupReport(m) {
  const records = m.records || {};
  const info = m.setupsInfo || {};
  const sources = info.sources || {};
  const enabled = state.settings.setups || {};
  const row = id => {
    const r = records[id] || { n: 0, wins: 0, avg: 0 };
    const status = enabled[id] === false ? 'Off' : (info.muted || []).includes(id) ? 'Muted' : setupProven(r) ? 'Proven' : r.n < MIN_PROVEN ? 'Too few cases' : 'Loses money';
    return el('tr', {},
      el('td', { text: SETUPS[id].name }),
      el('td', { text: String(r.n) }),
      el('td', { text: r.n ? `${Math.round((r.wins / r.n) * 100)}%` : '–' }),
      el('td', { text: r.n ? fmtPct(r.avg) : '–' }),
      el('td', { text: status }));
  };
  const SOURCE_NAMES = { insiders: 'SEC insider filings', earnings: 'SEC earnings dates', calendar: 'Nasdaq earnings calendar', fng: 'Fear & Greed index', funding: 'Kraken funding rates' };
  const sourceLines = Object.entries(SOURCE_NAMES).filter(([k]) => sources[k]).map(([k, label]) => {
    const st = sources[k];
    return el('li', { class: 'sub', text: `${label}: ${st.ok ? `loaded (${st.count})` : 'not loaded'}${st.at ? `, ${timeAgo(st.at)}` : ''}${st.error ? `. ${st.error}` : ''}` });
  });
  return el('details', { class: 'report' },
    el('summary', { text: 'Setup report' }),
    el('p', { class: 'muted small', text: 'Every past case of each setup on the scanned symbols\' daily charts: bought at the close, sold at the stop, the target or the end of the holding period, after fees. A setup sends alerts once it is proven: at least 30 cases with a positive average.' }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'setups' },
      el('thead', {}, el('tr', {}, ...['Setup', 'Cases', 'Won', 'Average', 'Status'].map(t => el('th', { text: t })))),
      el('tbody', {}, ...Object.keys(SETUPS).map(row)))),
    sourceLines.length ? el('ul', { class: 'list compact' }, ...sourceLines) : el('p', { class: 'muted small', text: 'The data sources load within an hour of the server starting.' }),
    info.secContact === false ? el('p', { class: 'small', text: 'Insider buying and earnings dates need SEC_CONTACT (your email) in the server\'s compose file.' }) : null);
}

async function runMarketNow(button) {
  button.disabled = true;
  try {
    await srv.serverFetch(state.settings, '/run', { method: 'POST', body: { what: 'market' } });
    button.textContent = 'Scanning on your server; this takes a few minutes';
    // Check back for the result while the scan runs.
    for (const wait of [3, 6, 10, 15]) setTimeout(() => refreshMarket({ force: true }), wait * 60_000);
  } catch (e) {
    button.disabled = false;
    toast(e.message);
  }
}

function renderOpportunities() {
  const body = $('opps-body');
  const m = state.market;
  if (!serverOn()) {
    body.replaceChildren();
    return;
  }
  // A scan from before the server had the setups (or none yet): say when they arrive.
  if (!m || !m.at || !m.records) {
    const failed = m && m.error ? ` The last scan failed: ${m.error}` : '';
    body.replaceChildren(
      el('h2', { class: 'section', text: 'Opportunities' }),
      el('p', { class: 'muted small', text: `Your server finds opportunities in its scans: crypto every 15 minutes around the clock, stocks every 30 minutes while the US market is open and at 20:00. They appear here after the next scan.${failed}` }),
      el('button', { type: 'button', class: 'ghost', text: 'Run the scans now', onclick: e => runMarketNow(e.currentTarget) }));
    return;
  }
  const opps = m.opportunities || [];
  const muted = (m.setupsInfo && m.setupsInfo.muted) || [];
  const warnings = m.warnings || [];
  body.replaceChildren(...[
    el('h2', { class: 'section', text: `Opportunities (${opps.length})` }),
    el('p', { class: 'muted small', text: `Ranked by the average result of past cases after fees, from the scan ${timeAgo(m.at)}.` }),
    muted.length ? el('p', { class: 'small', text: `Muted after your ratings: ${muted.map(setupName).join(', ')}. They still show here; turn their alerts back on in Settings.` }) : null,
    warnings.length ? el('ul', { class: 'list' }, ...warnings.map(w => el('li', { class: 'signal' }, el('div', { class: 'sym', text: w.title }), el('div', { class: 'sub', text: w.body })))) : null,
    opps.length ? el('ul', { class: 'list' }, ...opps.slice(0, 15).map(opportunityCard))
      : el('p', { class: 'muted small', text: 'No setup fired on the newest candles. The report below shows how each one did in the past.' }),
    setupReport(m),
  ].filter(Boolean));
}

function renderMarket() {
  const m = state.market;
  const body = $('market-body');
  if (!serverOn()) {
    body.replaceChildren(el('p', { class: 'muted small', text: 'Connect your server in Settings to see buy and sell ideas from the whole S&P 500 and every actively traded coin.' }));
    return;
  }
  if (!m || !m.at) {
    body.replaceChildren(el('h2', { class: 'section', text: 'Market scan' }),
      el('p', { class: 'muted small', text: m && m.error ? `The last market scan failed: ${m.error}` : 'Your server has not finished a market scan yet. It runs at the scan times shown in Settings.' }));
    return;
  }
  const fresh = new Set([...(m.newBuys || []), ...(m.newSells || [])]);
  const inPaper = new Set(serverPaperOn() ? (state.serverPaper.paper.positions || []).map(p => p.key) : []);
  const card = sig => {
    const li = signalCard(sig);
    if (fresh.has(sig.key)) li.querySelector('.sym').append(el('span', { class: 'badge', text: 'New' }));
    if (inPaper.has(sig.key)) li.querySelector('.sym').append(el('span', { class: 'badge proven', text: 'Paper' }));
    return li;
  };
  const list = (title, rows, empty) => [
    el('h3', { class: 'market-title', text: `${title} (${rows.length})` }),
    rows.length ? el('ul', { class: 'list' }, ...rows.slice(0, 10).map(card)) : el('p', { class: 'muted small', text: empty }),
  ];
  body.replaceChildren(
    el('h2', { class: 'section', text: 'Market scan' }),
    el('p', { class: 'muted small', text: scanLine(m) }),
    ...list('Buy ideas', m.buys || [], 'No buy ideas in the last scan.'),
    ...list('Sell ideas', m.sells || [], 'No sell ideas in the last scan.'),
  );
}

function scanLine(m) {
  if (!m.cryptoAt && !m.stocksAt) return `${m.scanned} of ${m.total} symbols on the daily chart, scanned ${timeAgo(m.at)} by your server.`;
  const crypto = m.cryptoAt ? `${m.cryptoScanned} coins ${timeAgo(m.cryptoAt)}` : 'crypto not yet';
  const stocks = m.stocksAt ? `${m.stocksScanned} S&P 500 stocks ${timeAgo(m.stocksAt)}` : 'stocks not yet';
  return `Daily chart, scanned by your server: ${crypto} (every 15 minutes, day and night), ${stocks}.`;
}

// ---- Your server ---------------------------------------------------------------

function markChanged() {
  state.syncMeta = { ...state.syncMeta, changedAt: Date.now() };
  store.saveSyncMeta(state.syncMeta);
  if (!serverOn()) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => syncNow(), SYNC_DELAY_MS);
}

// The newer side wins: this phone's edits go up, or another phone's come down.
async function syncNow() {
  if (!serverOn() || !navigator.onLine) return;
  try {
    const { profile } = await srv.serverFetch(state.settings, '/sync');
    const dir = srv.syncDirection(state.syncMeta.changedAt, profile);
    if (dir === 'pull') {
      state.watchlist = profile.watchlist;
      store.saveWatchlist(state.watchlist);
      state.holdings = srv.mergeHoldings(state.holdings, profile.holdings);
      saveHoldings();
      state.settings = store.saveSettings(Object.fromEntries(srv.SYNCED_SETTINGS.map(k => [k, profile.settings[k]])));
      renderWatchlist();
      if (state.view === 'portfolio') renderPortfolio();
      if (state.view === 'signals') renderSignals();
    } else if (dir === 'push') {
      await srv.serverFetch(state.settings, '/sync', {
        method: 'PUT',
        body: srv.buildProfile({ watchlist: state.watchlist, holdings: state.holdings, settings: state.settings, changedAt: state.syncMeta.changedAt || Date.now() }),
      });
    }
    state.syncMeta = { changedAt: dir === 'pull' ? profile.updatedAt : state.syncMeta.changedAt || Date.now(), syncedAt: Date.now() };
    store.saveSyncMeta(state.syncMeta);
  } catch (e) {
    console.warn('Sync failed', e);
  }
}

async function refreshMarket({ force = false } = {}) {
  if (!serverOn() || !navigator.onLine) return;
  if (!force && state.market && Date.now() - (state.market.fetchedAt || 0) < MARKET_REFRESH_MS) return;
  try {
    const { market, modelsAt = {}, setups = null } = await srv.serverFetch(state.settings, '/signals');
    state.market = market ? { ...market, setupsInfo: setups, fetchedAt: Date.now() } : { setupsInfo: setups, fetchedAt: Date.now() };
    store.saveMarket(state.market);
    if (state.view === 'signals') { renderOpportunities(); renderMarket(); }
    await refreshModels(modelsAt);
    await refreshPaper();
  } catch (e) {
    console.warn('Market scan fetch failed', e);
  }
}

// Downloads the models only when the server has trained new ones.
async function refreshModels(modelsAt) {
  const have = Object.fromEntries(Object.entries(state.models).map(([tf, m]) => [tf, m.trainedAt]));
  if (JSON.stringify(have, Object.keys(have).sort()) === JSON.stringify(modelsAt, Object.keys(modelsAt).sort())) return;
  try {
    const { models } = await srv.serverFetch(state.settings, '/models');
    state.models = models || {};
    store.saveModels(state.models);
    state.analysis = null;
    if (state.view === 'chart') renderAnalysis();
  } catch (e) {
    console.warn('Model download failed', e);
  }
}

async function loadServerStatus() {
  try {
    state.serverStatus = await srv.serverFetch(state.settings, '/status');
  } catch (e) {
    state.serverStatus = { error: e.message };
  }
  renderServer();
}

function renderServer() {
  const st = state.serverStatus;
  $('server-push').textContent = state.settings.serverPush ? 'Turn off server alerts' : 'Turn on server alerts';
  $('server-push').disabled = !serverOn();
  $('server-test').hidden = !state.settings.serverPush;
  $('server-train').disabled = !serverOn() || trainingNow(st);
  const info = $('server-info');
  if (!serverOn()) { info.textContent = 'Not connected.'; return; }
  if (!st) { info.textContent = 'Checking your server…'; return; }
  if (st.error) { info.textContent = st.error; return; }
  const w = st.watch || {};
  const errs = Object.keys(w.errors || {}).length;
  const failed = Object.entries(w.errors || {}).map(([key, msg]) => `${key.split(':').pop()}: ${String(msg).slice(0, 120)}`).join('; ');
  info.textContent = [
    `Connected (version ${st.version}).`,
    st.pushEnabled ? `${st.devices} phone${st.devices === 1 ? '' : 's'} get alerts.` : 'Notification keys are not set on the server yet.',
    w.lastRunAt ? `Watchlist and holdings checked ${timeAgo(w.lastRunAt)}, right after every candle closes and every ${st.watchEveryMinutes} minutes in between${errs ? `, ${errs} symbol${errs === 1 ? '' : 's'} failed (${failed})` : ''}.` : 'Watchlist checks start within a few minutes.',
    st.prices && st.prices.lastRunAt ? `Stop-losses and targets checked every minute, last ${timeAgo(st.prices.lastRunAt)}.` : '',
    cryptoLine(st.crypto),
    st.market.lastRunAt ? `Stock scan ${timeAgo(st.market.lastRunAt)}.` : '',
    st.market.nextAt ? `Next stock scan ${new Date(st.market.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : '',
    modelsLine(st),
  ].filter(Boolean).join(' ');
}

function cryptoLine(c) {
  if (!c) return '';
  if (!c.lastRunAt) return `Crypto scan every ${c.everyMinutes} minutes, starting shortly.`;
  return [
    `Crypto scan every ${c.everyMinutes} minutes around the clock, last ${timeAgo(c.lastRunAt)}: ${c.scanned} of ${c.total} coins traded on Coinbase or Kraken.`,
    c.listError ? `The coin list could not be refreshed: ${c.listError}.` : '',
    c.pulseAt ? `Fast moves watched every minute${c.lastMoveAt ? `, last one rescored ${timeAgo(c.lastMoveAt)}` : ''}.` : '',
  ].filter(Boolean).join(' ');
}

// The server marks a training run as started; a run takes up to an hour per
// timeframe, so after 5 hours it counts as stopped (the server restarted).
function trainingNow(st) {
  const t = st && st.training;
  return Boolean(t && t.runningSince && Date.now() - t.runningSince < 5 * 3600_000);
}

async function trainNow() {
  const status = $('server-status');
  $('server-train').disabled = true;
  try {
    await srv.serverFetch(state.settings, '/run', { method: 'POST', body: { what: 'train' } });
    status.textContent = 'Training started on your server. It takes 10 to 30 minutes per chart timeframe; this page shows the results when it finishes.';
    status.className = 'small good';
    setTimeout(loadServerStatus, 5000);
  } catch (e) {
    $('server-train').disabled = false;
    status.textContent = e.message;
    status.className = 'small bad';
  }
}

function modelsLine(st) {
  if (trainingNow(st)) return `Training the models now, started ${timeAgo(st.training.runningSince)}.`;
  const models = Object.entries(st.models || {});
  const failed = Object.entries((st.training && st.training.results) || {}).filter(([, r]) => r.error);
  const next = st.training && st.training.nextAt ? ` Next training ${new Date(st.training.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.` : '';
  if (!models.length) return `${failed.length ? `Model training failed: ${failed[0][1].error}.` : 'Machine-learning models are not trained yet.'}${next}`;
  const pct = t => (t ? `${Math.round(t.hit * 100)}%${t.usable ? '' : ' (not used)'}` : 'none');
  const turns = m => (m.bottom || m.top ? `, bottom finder ${pct(m.bottom)}, top finder ${pct(m.top)}` : '');
  return `${models.map(([tf, m]) => `${TIMEFRAMES[tf] ? TIMEFRAMES[tf].label : tf}: LightGBM ${pct(m.lgbm)}, LSTM ${pct(m.lstm)}${turns(m)} right in their test, trained ${timeAgo(m.trainedAt)}.`).join(' ')}${failed.length ? ` Last training failed: ${failed.map(([tf, r]) => `${tf}: ${r.error}`).join('; ')}.` : ''}${next}`;
}

async function saveServer() {
  const status = $('server-status');
  let url;
  try {
    url = srv.cleanUrl($('server-url').value);
  } catch (e) {
    status.textContent = e.message;
    status.className = 'small bad';
    return;
  }
  const key = $('server-key').value.trim();
  const changed = url !== state.settings.serverUrl || key !== state.settings.serverKey;
  state.settings = store.saveSettings({ serverUrl: url, serverKey: key, ...(changed ? { serverPush: false } : {}) });
  $('server-url').value = url;
  if (!url || !key) {
    status.textContent = url || key ? 'Add both the address and the key.' : 'Server disconnected.';
    status.className = 'small';
    state.serverStatus = null;
    renderServer();
    return;
  }
  status.textContent = 'Connecting…';
  status.className = 'small';
  await loadServerStatus();
  if (state.serverStatus.error) {
    status.textContent = `Saved, but ${state.serverStatus.error[0].toLowerCase()}${state.serverStatus.error.slice(1)}`;
    status.className = 'small bad';
    return;
  }
  srv.saveWorkerConfig(state.settings);
  status.textContent = 'Connected. Your watchlist and holdings now sync with the server.';
  status.className = 'small good';
  await syncNow();
  refreshMarket({ force: true });
}

async function toggleServerPush() {
  const status = $('server-status');
  status.className = 'small';
  try {
    if (state.settings.serverPush) {
      await srv.unsubscribePush(state.settings);
      state.settings = store.saveSettings({ serverPush: false });
      status.textContent = 'Server alerts are off on this phone.';
    } else {
      if (!state.serverStatus || state.serverStatus.error) await loadServerStatus();
      const st = state.serverStatus;
      if (st.error) throw new Error(st.error);
      if (!st.pushEnabled || !st.publicKey) throw new Error('Notification keys are not set on the server yet. See the server README, step 3.');
      if ((await askPermission()) !== 'granted') throw new Error('Allow notifications for this app in Chrome first.');
      status.textContent = 'Turning on…';
      await syncNow();
      await srv.subscribePush(state.settings, st.publicKey);
      state.settings = store.saveSettings({ serverPush: true, notifications: true });
      status.textContent = 'Server alerts are on. Tap Send a test alert to check.';
      status.className = 'small good';
    }
  } catch (e) {
    status.textContent = e.message;
    status.className = 'small bad';
  }
  renderNotifyStatus();
  loadServerStatus();
}

async function testServerPush() {
  const status = $('server-status');
  try {
    await srv.serverFetch(state.settings, '/push/test', { method: 'POST', body: { endpoint: await srv.currentEndpoint() } });
    status.textContent = 'Test alert sent. It should arrive in a few seconds.';
    status.className = 'small good';
  } catch (e) {
    status.textContent = e.message;
    status.className = 'small bad';
  }
}

function sendAlert(sig) {
  const word = ACTION_WORDS[sig.action];
  const held = sig.action === 'sell' && state.holdings.some(h => h.key === sig.key);
  const title = `${word} signal: ${sig.symbol}${held ? ' (you hold it)' : ''}`;
  const body = `Score ${fmtScore(sig.score)} on the ${TIMEFRAMES[sig.tf].label} chart. ${levelsLine(sig)}.${sig.top.length ? ` Led by ${sig.top.join(', ')}.` : ''}`;
  toast(title, { label: 'View', run: () => { $('toast').hidden = true; state.chartTf = sig.tf; openChart(findItem(sig.key), true); } });
  const quiet = state.settings.quietHours && inQuietHours(new Date());
  if (phoneNotifies() && !quiet) notify(title, body, `chart/${sig.type}/${encodeURIComponent(sig.symbol)}`);
}

async function runScan({ force = false } = {}) {
  if (state.scan.busy || !navigator.onLine) return;
  if (!force && Date.now() - state.scan.at < SCAN_EVERY_MS) return;
  const tf = state.settings.alertTf;
  // Crypto first: it is free and fast, while stocks may wait for the Twelve Data limit.
  const items = trackedItems()
    .filter(i => i.type === 'crypto' || state.settings.twelveKey)
    .sort((a, b) => (a.type === 'crypto' ? 0 : 1) - (b.type === 'crypto' ? 0 : 1));
  const abort = new AbortController();
  state.scan = { busy: true, done: 0, total: items.length, at: state.scan.at, errors: {}, abort };
  renderSignals();
  const deps = { getCandles: store.getCandles, saveCandles: store.saveCandles, fetchCandles, getWeight: store.weightFor, saveWeight: store.saveWeight, getModels: t => state.models[t] || null };
  const alerts = {};
  for (const item of items) {
    if (abort.signal.aborted) break;
    const key = store.itemKey(item);
    try {
      const r = await scanItem(item, tf, state.settings, thresholds(), deps, abort.signal);
      if (r.result) {
        const prev = state.signals[key];
        state.signals[key] = r.result;
        // No alert the first time a symbol is scored, or after switching timeframe.
        const alert = prev && prev.tf === tf ? alertFor(prev.action, r.result.action) : null;
        if (alert) { alerts[key] = alert; sendAlert(r.result); }
      } else {
        state.scan.errors[key] = r.error;
      }
    } catch (e) {
      if (e.name === 'AbortError') break;
      state.scan.errors[key] = e.message;
    }
    state.scan.done++;
    if (state.view === 'signals') renderSignals();
  }
  store.saveSignals(state.signals);
  state.scan.busy = false;
  if (!abort.signal.aborted) {
    state.scan.at = Date.now();
    stepPaper(tf, alerts);
  }
  checkHoldings(new Set(Object.keys(alerts)));
  renderSignals();
  if (state.view === 'portfolio') renderPortfolio();
}

// New buy/sell levels change each symbol's action without a new scan (and without alerts).
function rescoreSignals() {
  for (const s of Object.values(state.signals)) {
    const rule = autoTune(state.settings) && s.tuned && s.rule ? s.rule : thresholds();
    s.rule = rule;
    s.action = actionFor(s.score, rule, s.ctx);
  }
  store.saveSignals(state.signals);
  renderSignals();
  if (state.view === 'chart') renderAnalysis();
}

// ---- Portfolio: holdings ------------------------------------------------------

function saveHoldings() {
  store.saveHoldings(state.holdings);
}

// Stop-loss, target and sell alerts for real holdings. `skipSell` holds keys
// that already got a Sell signal alert this scan.
function checkHoldings(skipSell = new Set()) {
  let changed = false;
  for (const h of state.holdings) {
    const price = priceOf(h.key);
    const sig = state.signals[h.key];
    const action = sig && sig.tf === state.settings.alertTf ? sig.action : null;
    const { alerts, alerted } = pf.checkHolding(h, price, action);
    if (JSON.stringify(alerted) !== JSON.stringify(h.alerted || {})) { h.alerted = alerted; changed = true; }
    for (const a of alerts) {
      if (a === 'sell' && skipSell.has(h.key)) continue;
      const title = a === 'stop' ? `Stop-loss hit: ${h.symbol}` : a === 'target' ? `Target reached: ${h.symbol}` : `Sell signal on your ${h.symbol}`;
      const body = a === 'stop' ? `${formatMoney(price)} is at or below your stop of ${formatMoney(h.stop)}. Consider selling.`
        : a === 'target' ? `${formatMoney(price)} is at or above your target of ${formatMoney(h.take)}. Consider taking profit.`
          : `Score ${fmtScore(sig.score)} on the ${TIMEFRAMES[sig.tf].label} chart. You hold ${h.qty}.`;
      toast(title, { label: 'View', run: () => { $('toast').hidden = true; go('portfolio'); } });
      const quiet = state.settings.quietHours && inQuietHours(new Date());
      if (phoneNotifies() && !quiet) notify(title, body, 'portfolio');
    }
  }
  if (changed) saveHoldings();
}

function renderPortfolio() {
  for (const b of document.querySelectorAll('#pf-seg button')) b.classList.toggle('on', b.dataset.pf === state.pfTab);
  $('pf-holdings').hidden = state.pfTab !== 'holdings';
  $('pf-paper').hidden = state.pfTab !== 'paper';
  if (state.pfTab === 'holdings') renderHoldings();
  else renderPaper();
}

const stat = (label, value, cls = '') => el('div', {}, el('dt', { text: label }), el('dd', { class: cls, text: value }));
const upDown = v => (v > 0 ? 'good' : v < 0 ? 'bad' : '');

function renderHoldings() {
  const prices = Object.fromEntries(state.holdings.map(h => [h.key, priceOf(h.key)]));
  const t = pf.totals(state.holdings, prices);
  const rate = cadRate();
  $('holdings-total').replaceChildren(state.holdings.length ? el('div', { class: 'card' },
    el('div', { class: 'muted small', text: 'Total value' }),
    el('div', { class: 'big', text: formatMoney(t.value) }),
    Number.isFinite(rate) ? el('div', { class: 'muted small', text: formatMoney(toCad(t.value, rate), 'CAD') }) : null,
    el('dl', { class: 'stats' },
      stat('Paid', formatMoney(t.cost)),
      stat('Profit or loss', `${formatMoney(t.pnl)} (${fmtPct(t.pct)})`, upDown(t.pnl)),
      Number.isFinite(rate) ? stat('Profit or loss, CAD', formatMoney(toCad(t.pnl, rate), 'CAD'), upDown(t.pnl)) : null)) : '');
  $('hold-edit').hidden = !state.holdings.length;
  $('hold-edit').textContent = state.holdEditing ? 'Done' : 'Edit';
  const list = $('holdings-list');
  list.replaceChildren(...state.holdings.map(h => {
    const price = prices[h.key];
    const v = pf.value(h, price);
    const sig = state.signals[h.key];
    const lvl = pf.levelState(h, price);
    return el('li', { class: 'holding', onclick: () => { const item = findItem(h.key); if (item) openChart(item, true); } },
      el('div', { class: 'signal-top' },
        el('div', { class: 'sym' }, h.symbol, el('span', { class: 'badge', text: h.type === 'stock' ? 'Stock' : 'Crypto' }),
          sig ? el('span', { class: `action ${sig.action}`, text: ACTION_WORDS[sig.action] }) : null),
        state.holdEditing
          ? el('button', { type: 'button', class: 'remove ghost', text: 'Remove', onclick: e => { e.stopPropagation(); removeHolding(h); } })
          : el('div', { class: 'quote' },
            el('div', { class: 'price', text: formatMoney(v.value) }),
            el('span', { class: changeClass(v.pct), text: fmtPct(v.pct) }))),
      el('div', { class: 'sub', text: `${h.qty} at ${formatMoney(h.buyPrice)} · now ${formatMoney(price)} · ${v.pnl >= 0 ? '+' : ''}${formatMoney(v.pnl)}` }),
      el('div', { class: 'sub' },
        `Stop ${h.stop != null ? formatMoney(h.stop) : 'not set'} · Target ${h.take != null ? formatMoney(h.take) : 'not set'} `,
        lvl === 'stop' ? el('span', { class: 'level stop', text: 'Stop hit' }) : lvl === 'target' ? el('span', { class: 'level target', text: 'Target reached' }) : null));
  }));
  if (!state.holdings.length) list.append(el('p', { class: 'muted center', text: 'Add what you own to get stop-loss, target and sell alerts.' }));
}

function removeHolding(h) {
  state.holdings = state.holdings.filter(x => x.id !== h.id);
  saveHoldings();
  markChanged();
  renderHoldings();
}

function setHoldType(type) {
  state.holdType = type;
  for (const b of document.querySelectorAll('#hold-form [data-htype]')) b.classList.toggle('on', b.dataset.htype === type);
  $('hold-error').textContent = '';
}

function openHoldDialog() {
  setHoldType(state.holdType);
  for (const id of ['hold-symbol', 'hold-qty', 'hold-price', 'hold-stop', 'hold-take']) $(id).value = '';
  $('hold-dialog').showModal();
  $('hold-symbol').focus();
}

// The latest ATR for a symbol, from saved candles or the last scan.
function latestAtr(item) {
  const saved = store.getCandles(item, state.settings.alertTf);
  if (saved && saved.candles.length > 20) {
    const a = atrSeries(saved.candles).at(-1);
    if (Number.isFinite(a)) return a;
  }
  const sig = state.signals[store.itemKey(item)];
  return sig && Number.isFinite(sig.atr) ? sig.atr : NaN;
}

async function submitHolding(e) {
  e.preventDefault();
  const symbol = $('hold-symbol').value.trim().toUpperCase().replace(/\s+/g, '');
  const err = $('hold-error');
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) { err.textContent = 'Enter a ticker such as AAPL or BTC.'; return; }
  $('hold-ok').disabled = true;
  err.textContent = 'Checking…';
  try {
    const key = `${state.holdType}:${symbol}`;
    const item = findItem(key) || await resolveItem(state.holdType, symbol);
    const h = pf.makeHolding({
      ...item,
      qty: $('hold-qty').value,
      buyPrice: $('hold-price').value,
      stop: $('hold-stop').value,
      take: $('hold-take').value,
      atr: latestAtr(item),
      ...riskOpts(),
    });
    if (item.geckoId) h.geckoId = item.geckoId;
    state.holdings.push(h);
    saveHoldings();
    markChanged();
    $('hold-dialog').close();
    err.textContent = '';
    renderHoldings();
    toast(h.stop == null ? `Added ${symbol}. No price history yet, so set a stop-loss to get stop alerts.` : `Added ${symbol}`);
    checkHoldings();
    refreshQuotes({ force: true });
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    $('hold-ok').disabled = false;
  }
}

// ---- Portfolio: paper trading -------------------------------------------------

// With your server connected, paper trading runs there around the clock and
// the phone only shows it; otherwise the phone trades while the app is open.
const serverPaperOn = () => serverOn() && !!(state.serverPaper && state.serverPaper.paper);

async function refreshPaper() {
  if (!serverOn() || !navigator.onLine) return;
  try {
    const r = await srv.serverFetch(state.settings, '/paper');
    state.serverPaper = { ...r, fetchedAt: Date.now() };
    store.saveServerPaper(state.serverPaper);
    if (state.view === 'portfolio' && state.pfTab === 'paper') renderPaper();
    if (state.view === 'signals') renderMarket();
  } catch (e) {
    console.warn('Paper account fetch failed', e);
  }
}

function paperAccount() {
  if (serverPaperOn()) return state.serverPaper.paper;
  if (!state.paper) {
    state.paper = paper.newAccount(state.settings.paperStart);
    store.savePaper(state.paper);
  }
  return state.paper;
}

function stepPaper(tf, alerts) {
  if (serverOn()) return; // the server trades the paper account
  const signals = Object.fromEntries(Object.entries(state.signals).filter(([, s]) => s.tf === tf));
  const events = paper.step(paperAccount(), { signals, alerts, riskPct: state.settings.riskPct });
  store.savePaper(state.paper);
  for (const ev of events) {
    toast(ev.kind === 'open'
      ? `Paper trade: bought ${ev.symbol} for ${formatMoney(ev.cost)}`
      : `Paper trade: sold ${ev.symbol} (${ev.reason}), ${ev.pnl >= 0 ? '+' : ''}${formatMoney(ev.pnl)}`);
  }
}

function renderPaper() {
  const acc = paperAccount();
  const onServer = serverPaperOn();
  const serverPrices = (onServer && state.serverPaper.prices) || {};
  const prices = Object.fromEntries(acc.positions.map(p => [p.key, Number.isFinite(priceOf(p.key)) ? priceOf(p.key) : serverPrices[p.key]]));
  const sum = paper.summary(acc, prices);
  const events = onServer ? state.serverPaper.events || [] : [];
  const fmtTime = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  // replaceChildren() writes a null child as the text "null", so drop the empty sections.
  $('paper-body').replaceChildren(...[
    el('div', { class: 'card' },
      el('div', { class: 'muted small', text: `Paper account, started ${fmtTime(acc.createdAt)} with ${formatMoney(acc.start)}` }),
      el('p', { class: 'muted small', text: onServer
        ? `Runs on your server around the clock: it checks for new signals right after every candle closes and checks stop-losses and targets every minute (stocks while the US market is open). Updated ${timeAgo(state.serverPaper.fetchedAt)}.`
        : serverOn() ? 'Connecting to the paper account on your server…' : 'Trades only while the app is open. Connect your server in Settings to trade around the clock.' }),
      el('div', { class: 'big', text: formatMoney(sum.equity) }),
      el('dl', { class: 'stats' },
        stat('Return', fmtPct(sum.totalReturn), upDown(sum.totalReturn)),
        stat('Cash', formatMoney(acc.cash)),
        stat('Closed trades', String(sum.trades)),
        stat('Won', sum.trades ? `${Math.round(sum.winRate * 100)}%` : '–'),
        stat('Worst drop', fmtPct(-sum.maxDrawdown)))),
    bySetupTable(acc),
    el('h2', { class: 'section', text: `Open (${acc.positions.length})` }),
    acc.positions.length
      ? el('ul', { class: 'list' }, ...acc.positions.map(p => {
        const price = prices[p.key];
        const pnl = Number.isFinite(price) ? p.qty * price - p.cost : NaN;
        return el('li', { class: 'holding', onclick: () => { const item = findItem(p.key); if (item) openChart(item, true); } },
          el('div', { class: 'signal-top' },
            el('div', { class: 'sym', text: p.symbol }),
            el('span', { class: changeClass(pnl), text: Number.isFinite(pnl) ? `${pnl >= 0 ? '+' : ''}${formatMoney(pnl)}` : '–' })),
          el('div', { class: 'sub', text: `${Number(p.qty.toPrecision(6))} at ${formatMoney(p.entry)} · now ${formatMoney(price)}` }),
          el('div', { class: 'sub', text: `Stop ${formatMoney(p.stop)} · Target ${formatMoney(p.take)} · since ${fmtTime(p.openedAt)}${p.until ? ` · sells by ${fmtTime(p.until)}` : ''}` }),
          el('div', { class: 'sub', text: setupName(paper.setupOf(p)) }));
      }))
      : el('p', { class: 'muted small', text: 'No open paper trades. The next new Buy signal opens one.' }),
    events.length ? el('h2', { class: 'section', text: 'Latest paper trades' }) : null,
    events.length ? el('ul', { class: 'list compact' }, ...events.slice(0, 10).map(ev => el('li', { class: 'holding' },
      el('div', { class: 'sub', text: `${new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${ev.text}` })))) : null,
    el('h2', { class: 'section', text: `Closed (${acc.trades.length})` }),
    acc.trades.length
      ? el('ul', { class: 'list compact' }, ...acc.trades.slice(-30).reverse().map(t => el('li', { class: 'holding' },
        el('div', { class: 'signal-top' },
          el('div', { class: 'sym', text: t.symbol }),
          el('span', { class: changeClass(t.pnl), text: `${t.pnl >= 0 ? '+' : ''}${formatMoney(t.pnl)} (${fmtPct(t.ret)})` })),
        el('div', { class: 'sub', text: `${formatMoney(t.entry)} to ${formatMoney(t.exit)} · ${t.reason === 'time' ? 'holding period over' : t.reason} · ${fmtTime(t.openedAt)} to ${fmtTime(t.closedAt)} · ${setupName(t.setup || 'signal')}` }))))
      : el('p', { class: 'muted small', text: 'No closed paper trades yet.' }),
  ].filter(Boolean));
}

// Trades, win rate, return and worst drop for each way the account trades.
function bySetupTable(acc) {
  const rows = paper.bySetup(acc);
  if (!rows.length || (rows.length === 1 && rows[0].setup === 'signal')) return null;
  return el('div', { class: 'card' },
    el('h3', { text: 'By setup' }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'setups' },
      el('thead', {}, el('tr', {}, ...['Setup', 'Trades', 'Won', 'Return', 'Worst drop'].map(t => el('th', { text: t })))),
      el('tbody', {}, ...rows.map(r => el('tr', {},
        el('td', { text: `${setupName(r.setup)}${r.open ? ` (${r.open} open)` : ''}` }),
        el('td', { text: String(r.trades) }),
        el('td', { text: r.trades ? `${Math.round(r.winRate * 100)}%` : '–' }),
        el('td', { class: upDown(r.ret), text: r.trades ? fmtPct(r.ret) : '–' }),
        el('td', { text: r.trades ? fmtPct(-r.maxDrawdown) : '–' })))))),
    el('p', { class: 'muted small', text: 'Return is on the starting amount. Opportunity trades sell at their stop, their target or the end of their holding period.' }));
}

async function resetPaper() {
  if (!confirm(`Start the paper account over with ${formatMoney(state.settings.paperStart)}? Its trades will be deleted.`)) return;
  if (serverOn()) {
    try {
      const { paper: acc } = await srv.serverFetch(state.settings, '/paper/reset', { method: 'POST', body: { start: state.settings.paperStart } });
      state.serverPaper = { paper: acc, events: [], prices: {}, fetchedAt: Date.now() };
      store.saveServerPaper(state.serverPaper);
      renderPaper();
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  state.paper = paper.newAccount(state.settings.paperStart);
  store.savePaper(state.paper);
  renderPaper();
}

// ---- Settings ---------------------------------------------------------------

function renderSettings() {
  $('key-input').value = state.settings.twelveKey;
  $('tf-default').value = state.settings.timeframe;
  $('cad-toggle').checked = state.settings.showCad;
  $('fx-status').textContent = state.fx
    ? `1 USD = ${state.fx.rate.toFixed(4)} CAD (${state.fx.source}, ${timeAgo(state.fx.at)})`
    : 'USD to CAD rate not loaded yet.';
  $('version').textContent = `Version ${APP_VERSION}`;
  $('alert-tf').value = state.settings.alertTf;
  $('buy-at').value = state.settings.buyAt;
  $('sell-at').value = -state.settings.sellAt;
  $('tune-mode').value = autoTune(state.settings) ? 'auto' : 'manual';
  $('signal-mode').value = state.settings.mode === 'dip' ? 'dip' : 'standard';
  $('manual-levels').hidden = autoTune(state.settings);
  $('tune-note').textContent = autoTune(state.settings)
    ? 'Each symbol gets the buy and sell levels, and the way of reading the score (standard or buying the dip in an uptrend), that did best on its older history. Each signal shows how they did on newer candles they never saw.'
    : '';
  $('quiet-toggle').checked = state.settings.quietHours;
  $('stop-atr').value = state.settings.stopAtr;
  $('take-atr').value = state.settings.takeAtr;
  $('risk-pct').value = state.settings.riskPct;
  $('paper-start').value = state.settings.paperStart;
  $('server-url').value = state.settings.serverUrl;
  $('server-key').value = state.settings.serverKey;
  renderNotifyStatus();
  renderSetupSettings();
  renderServer();
  if (serverOn()) loadServerStatus();
}

function renderSetupSettings() {
  const on = state.settings.setups || {};
  $('setup-switches').replaceChildren(...Object.entries(SETUPS).map(([id, s]) => {
    const input = el('input', { type: 'checkbox' });
    input.checked = on[id] !== false;
    input.addEventListener('change', () => {
      state.settings = store.saveSettings({ setups: { ...state.settings.setups, [id]: input.checked } });
      markChanged();
      $('setups-status').textContent = 'Saved. The next market scan uses it.';
    });
    return el('label', { class: 'switch' }, input, el('span', { text: `${s.name}${s.kind === 'stock' ? ' (stocks)' : s.kind === 'crypto' ? ' (crypto)' : ''}` }));
  }));
  const info = (state.market && state.market.setupsInfo) || {};
  const muted = info.muted || [];
  $('setups-muted').replaceChildren(...muted.map(id => el('div', { class: 'row' },
    el('span', { class: 'small', text: `${setupName(id)} alerts are muted: you rated 7 of the last 10 "Not useful".` }),
    el('button', { type: 'button', class: 'ghost', text: 'Turn back on', onclick: () => unmuteSetup(id) }))));
}

function saveRisk() {
  const v = id => Number($(id).value);
  const next = { stopAtr: v('stop-atr'), takeAtr: v('take-atr'), riskPct: v('risk-pct'), paperStart: Math.round(v('paper-start')) };
  const inRange = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;
  if (!inRange(next.stopAtr, 0.5, 10) || !inRange(next.takeAtr, 0.5, 20) || !inRange(next.riskPct, 0.1, 5) || !inRange(next.paperStart, 100, 10_000_000)) {
    $('risk-status').textContent = 'Stop-loss 0.5 to 10, target 0.5 to 20, risk 0.1 to 5%, account 100 to 10,000,000.';
    renderSettings();
    return;
  }
  state.settings = store.saveSettings(next);
  markChanged();
  $('risk-status').textContent = 'Saved. New signals and holdings use these levels.';
}

function renderNotifyStatus() {
  const supported = typeof Notification !== 'undefined';
  const on = state.settings.notifications && canNotify();
  $('notify-btn').textContent = on ? 'Turn off notifications' : 'Turn on notifications';
  $('notify-btn').disabled = !supported;
  $('notify-status').textContent = !supported ? 'This browser cannot show notifications. Install the app from Chrome first.'
    : Notification.permission === 'denied' ? 'Notifications are blocked. Allow them in Chrome\'s site settings for this app.'
      : on && state.settings.serverPush ? 'On. Your server sends the alerts, even while the app is closed.'
        : on ? 'On while the app is open or in the background. Turn on server alerts below to get them when it is closed.'
        : 'Off.';
}

async function toggleNotifications() {
  if (state.settings.notifications && canNotify()) {
    state.settings = store.saveSettings({ notifications: false });
  } else {
    const result = await askPermission();
    state.settings = store.saveSettings({ notifications: result === 'granted' });
    if (result === 'granted') notify('Trade alerts are on', 'You will get Buy and Sell alerts here.', 'signals');
  }
  renderNotifyStatus();
}

function saveThresholds() {
  const buy = Math.round(Number($('buy-at').value));
  const sell = Math.round(Number($('sell-at').value));
  const valid = v => Number.isFinite(v) && v >= 10 && v <= 100;
  if (!valid(buy) || !valid(sell)) {
    $('alert-status').textContent = 'Use whole numbers from 10 to 100.';
    renderSettings();
    return;
  }
  state.settings = store.saveSettings({ buyAt: buy, sellAt: -sell, tune: $('tune-mode').value === 'manual' ? 'manual' : 'auto', mode: $('signal-mode').value === 'dip' ? 'dip' : 'standard' });
  markChanged();
  renderSettings();
  $('alert-status').textContent = 'Saved. Signals use the new levels from the next scan.';
  rescoreSignals();
}

async function saveKey() {
  const key = $('key-input').value.trim();
  const status = $('key-status');
  state.settings = store.saveSettings({ twelveKey: key });
  if (!key) {
    status.textContent = 'Key removed.';
    status.className = 'small';
    renderWatchlist();
    return;
  }
  status.textContent = 'Testing the key…';
  status.className = 'small';
  try {
    await checkTwelveKey(key);
    status.textContent = 'Key saved and working.';
    status.className = 'small good';
    refreshQuotes({ force: true });
    runScan({ force: true });
  } catch (e) {
    status.textContent = `Saved, but the test failed: ${e.message}`;
    status.className = 'small bad';
  }
}

function saveBackup() {
  const blob = new Blob([JSON.stringify(store.exportBackup(), null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `trade-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  $('backup-status').textContent = 'Backup saved. It includes your data key, so keep it private.';
}

async function loadBackup(file) {
  const status = $('backup-status');
  try {
    const count = store.importBackup(JSON.parse(await file.text()));
    state.watchlist = store.getWatchlist();
    state.settings = store.getSettings();
    renderSettings();
    renderWatchlist();
    refreshQuotes({ force: true });
    state.holdings = store.getHoldings();
    state.paper = store.getPaper();
    status.textContent = `Restored ${count} symbols, ${state.holdings.length} holdings and your settings.`;
  } catch (e) {
    status.textContent = e instanceof SyntaxError ? 'That file is not a backup.' : e.message;
  }
}

// ---- Start ------------------------------------------------------------------

function bind() {
  for (const b of document.querySelectorAll('.tabbar button')) b.addEventListener('click', () => go(b.dataset.view));
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

  for (const b of document.querySelectorAll('#filter button')) {
    b.addEventListener('click', () => {
      state.filter = b.dataset.filter;
      for (const x of document.querySelectorAll('#filter button')) x.classList.toggle('on', x === b);
      renderWatchlist();
    });
  }
  $('edit-btn').addEventListener('click', () => {
    state.editing = !state.editing;
    $('edit-btn').textContent = state.editing ? 'Done' : 'Edit';
    renderWatchlist();
  });
  $('add-btn').addEventListener('click', openAddDialog);
  $('top-btn').addEventListener('click', openTopCrypto);
  for (const b of document.querySelectorAll('#add-form [data-type]')) b.addEventListener('click', () => setAddType(b.dataset.type));
  $('add-form').addEventListener('submit', submitAdd);
  $('add-cancel').addEventListener('click', () => $('add-dialog').close());
  $('list-close').addEventListener('click', () => $('list-dialog').close());

  $('chart-pick').addEventListener('click', pickChartSymbol);
  for (const b of document.querySelectorAll('#tf-seg button')) {
    b.addEventListener('click', () => { state.chartTf = b.dataset.tf; renderTfButtons(); loadChart(); });
  }

  for (const b of document.querySelectorAll('#overlay-chips button')) {
    b.addEventListener('click', () => {
      state.settings = store.saveSettings({ overlays: { ...state.settings.overlays, [b.dataset.ov]: !state.settings.overlays[b.dataset.ov] } });
      renderAnalysis();
    });
  }
  $('scan-btn').addEventListener('click', () => runScan({ force: true }));
  for (const b of document.querySelectorAll('#pf-seg button')) b.addEventListener('click', () => { state.pfTab = b.dataset.pf; renderPortfolio(); if (state.pfTab === 'paper') refreshPaper(); });
  $('hold-add').addEventListener('click', openHoldDialog);
  $('hold-edit').addEventListener('click', () => { state.holdEditing = !state.holdEditing; renderHoldings(); });
  for (const b of document.querySelectorAll('#hold-form [data-htype]')) b.addEventListener('click', () => setHoldType(b.dataset.htype));
  $('hold-form').addEventListener('submit', submitHolding);
  $('hold-cancel').addEventListener('click', () => $('hold-dialog').close());
  $('paper-reset').addEventListener('click', resetPaper);
  for (const id of ['stop-atr', 'take-atr', 'risk-pct', 'paper-start']) $(id).addEventListener('change', saveRisk);
  $('alert-tf').addEventListener('change', e => {
    state.settings = store.saveSettings({ alertTf: e.target.value });
    markChanged();
    if (state.scan.abort) state.scan.abort.abort();
    setTimeout(() => runScan({ force: true }), 0);
  });
  $('buy-at').addEventListener('change', saveThresholds);
  $('tune-mode').addEventListener('change', saveThresholds);
  $('signal-mode').addEventListener('change', saveThresholds);
  $('sell-at').addEventListener('change', saveThresholds);
  $('notify-btn').addEventListener('click', toggleNotifications);
  $('quiet-toggle').addEventListener('change', e => { state.settings = store.saveSettings({ quietHours: e.target.checked }); markChanged(); });
  $('server-save').addEventListener('click', saveServer);
  $('server-push').addEventListener('click', toggleServerPush);
  $('server-test').addEventListener('click', testServerPush);
  $('server-train').addEventListener('click', trainNow);

  $('key-save').addEventListener('click', saveKey);
  $('key-show').addEventListener('click', () => {
    const input = $('key-input');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('key-show').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  $('tf-default').addEventListener('change', e => { state.settings = store.saveSettings({ timeframe: e.target.value }); });
  $('cad-toggle').addEventListener('change', e => {
    state.settings = store.saveSettings({ showCad: e.target.checked });
    if (e.target.checked) refreshFx();
    renderWatchlist();
  });
  $('backup-save').addEventListener('click', saveBackup);
  $('backup-load').addEventListener('click', () => $('backup-file').click());
  $('backup-file').addEventListener('change', e => { if (e.target.files[0]) loadBackup(e.target.files[0]); e.target.value = ''; });
  $('clear-cache').addEventListener('click', () => {
    store.clearCachedPrices();
    state.quotes = {};
    renderWatchlist();
    $('backup-status').textContent = 'Saved prices cleared.';
  });

  const online = () => {
    $('offline').hidden = navigator.onLine;
    if (navigator.onLine) { refreshQuotes(); if (state.view === 'chart') loadChart(); }
  };
  window.addEventListener('online', online);
  window.addEventListener('offline', online);
  $('offline').hidden = navigator.onLine;

  // Refresh while the app is on screen; stop when it is in the background.
  setInterval(() => {
    if (document.hidden) return;
    refreshQuotes();
    runScan();
    refreshMarket();
    if (state.view === 'chart' && isIntraday(state.chartTf)) loadChart();
  }, QUOTE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    refreshQuotes();
    syncNow();
    refreshMarket();
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('A new version is ready.', { label: 'Reload', run: () => location.reload() });
  });
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker failed', e));
}

function start() {
  bind();
  renderWatchlist();
  showView(location.hash.slice(1) || 'signals');
  refreshQuotes();
  runScan({ force: true });
  syncNow();
  refreshMarket({ force: true });
  if (state.settings.showCad) refreshFx();
  registerServiceWorker();
  if (serverOn()) srv.saveWorkerConfig(state.settings);
}

start();
