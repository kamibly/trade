import { TIMEFRAMES, isIntraday, changeOverDay } from './candles.js';
import { formatMoney, formatChange, priceDecimals, toCad, timeAgo } from './format.js';
import * as store from './storage.js';
import {
  fetchCandles, fetchQuotes, fetchCryptoTop, fetchUsdCad, checkStock, checkTwelveKey, twelveLimiter,
} from './data.js';
import { PriceChart } from './chart.js';
import * as F from './forecast.js';
import {
  analyze, signalAt, scoreVotes, scoreParts, crossings, actionFor, baseVotesAt, GROUPS, MIN_CANDLES,
} from './signals.js';
import { METHOD_INFO, SCORE_STEPS } from './explain.js';
import { scanItem, alertFor, manualRule, autoTune, learnKey, backtestOptions, learnedFrom, ruleOf, tradeRecordLine } from './scanner.js';
import { SETUPS, recordLine, proven as setupProven, MIN_PROVEN } from './setups.js';
import { notify, canNotify, askPermission, inQuietHours } from './notify.js';
import { voteMatrix, backtest } from './backtest.js';
import * as paper from './paper.js';
import { feeOf } from './fees.js';
import * as pf from './portfolio.js';
import { atr as atrSeries } from './indicators.js';
import * as srv from './server.js';
import { usable as modelUsable, mlOutlook, HORIZON as ML_HORIZON, TURN_EDGE } from './ml.js';

export const APP_VERSION = '0.23.0 (score breakdown)';
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
  openCards: new Set(), // signal cards opened to show their details
  marketSide: 'buy',
  paperSort: 'loss',
  paperSource: 'all',
  closedFilter: 'all',
  closedSource: 'all',
  closedShown: 10,
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
  t.append(el('button', { type: 'button', class: 'ghost toast-close', 'aria-label': 'Close', text: '✕', onclick: () => { clearTimeout(toastTimer); t.hidden = true; } }));
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
  if (m) return { type: m.type, symbol: m.symbol, name: m.name };
  // So do paper trades of ideas that have since left the scan's lists.
  const acc = state.serverPaper && state.serverPaper.paper ? state.serverPaper.paper : state.paper;
  const p = acc && [...(acc.positions || []), ...(acc.trades || [])].find(x => x.key === key);
  return p ? { type: p.type, symbol: p.symbol, name: p.symbol } : undefined;
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
const fmtVote = v => (v === 0 ? '0.00' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`);
const fmtPts = v => (Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

// A folded section that remembers whether it was open (by `id`).
function fold(id, summary, ...body) {
  // Taps inside stay here: they don't fold the card it sits in.
  return el('details', { class: 'why-fold', open: state.openCards.has(id), onclick: e => e.stopPropagation(), ontoggle: e => { if (e.currentTarget.open) state.openCards.add(id); else state.openCards.delete(id); } },
    el('summary', {}, ...[].concat(summary)), ...body);
}

// How a score added up, group by group, with each method's vote × weight.
// votes: [{ id, name, group, vote, weight, note?, hit? }]. `id` keeps what is open.
function scoreTable(votes, id) {
  const { parts, groups } = scoreParts(votes);
  const order = Object.keys(GROUPS);
  parts.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
  return el('div', {}, el('div', { class: 'why-table' },
    el('div', { class: 'why-row why-head muted small' }, el('span', { text: 'Group' }), el('span', { text: 'Vote' }), el('span', { text: 'Adds' })),
    ...parts.map(g => fold(`${id}:${g.group}`, [
      el('span', { text: GROUPS[g.group] || g.group }),
      el('span', { class: upDown(g.vote), text: Number.isFinite(g.vote) ? fmtVote(g.vote) : '–' }),
      el('span', { class: upDown(g.adds), text: Number.isFinite(g.vote) ? fmtPts(g.adds) : 'not counted' }),
    ], el('ul', { class: 'why-votes' }, ...g.votes.map(v => el('li', {},
      el('div', {}, el('span', { text: v.name }), el('span', { class: `small ${upDown(v.vote)}`, text: `${fmtVote(v.vote)} × ${v.weight.toFixed(2)}${v.weight > 0 ? '' : ' (no vote)'}` })),
      v.note ? el('div', { class: 'muted small', text: `Now: ${v.note}${Number.isFinite(v.hit) ? ` · right ${Math.round(v.hit * 100)}% in the backtest` : ''}` }) : null,
      METHOD_INFO[v.id] ? el('div', { class: 'muted small', text: METHOD_INFO[v.id] }) : null))),
      Number.isFinite(g.vote) ? el('div', { class: 'muted small', text: `Group vote ${fmtVote(g.vote)} = Σ(vote × weight) ÷ Σ weight; adds 100 × ${fmtVote(g.vote)} ÷ ${groups} groups = ${fmtPts(g.adds)}` }) : el('div', { class: 'muted small', text: 'Every method here has weight 0, so this group is left out.' })))),
    fold(`${id}:how`, el('span', { text: 'How the score is worked out' }),
      el('ol', { class: 'small why-steps' }, ...SCORE_STEPS.map(t => el('li', { text: t })))));
}

const snapVotes = snap => snap.votes.map(([id, name, group, vote, weight]) => ({ id, name, group, vote, weight }));
const lineText = (rule, side) => (rule ? `${side === 'sell' ? 'Sell' : 'Buy'} line ${fmtScore(side === 'sell' ? rule.sell : rule.buy)}${rule.mode === 'dip' && side !== 'sell' ? ' (buy the dip)' : ''}` : '');

// A paper trade's saved score: "Why it bought" or "Why it sold".
function whyFold(snap, id, side, filter = null) {
  if (!snap || !Array.isArray(snap.votes)) return null;
  const when = Number.isFinite(snap.time) ? new Date(snap.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const parts = scoreParts(snapVotes(snap)).parts;
  const pulls = side === 'sell' ? parts.filter(g => g.adds < -0.05).sort((a, b) => a.adds - b.adds).slice(0, 3) : [];
  return fold(id, [el('span', { text: side === 'sell' ? 'Why it sold' : 'Why it bought' }), el('span', { class: 'muted small', text: ` score ${fmtScore(snap.score)}${when ? ` · candle of ${when}` : ''}` })],
    el('div', { class: 'why-top small' },
      el('span', {}, 'Score ', el('strong', { class: upDown(snap.score), text: fmtPts(snap.score) })),
      el('span', { class: 'muted', text: lineText(snap.rule, side) })),
    pulls.length ? el('div', { class: 'muted small', text: `Pulled down most by ${pulls.map(g => `${GROUPS[g.group] || g.group} ${fmtPts(g.adds)}`).join(' · ')}` }) : null,
    scoreTable(snapVotes(snap), id),
    filter ? el('div', { class: 'why-filter small', text: filterText(filter) }) : null);
}

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
    const bt = backtest(S, backtestOptions(state.settings, votes, state.chartItem.type));
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
    el('div', { class: 'card why-card' },
      el('h3', { text: 'How this score was worked out' }),
      el('p', { class: 'muted small', text: `Each group's votes are averaged using their weights, then the groups count equally. ${lineText(rule, 'buy')}, ${lineText(rule, 'sell')}.` }),
      scoreTable(sig.votes.map(v => ({ ...v, weight: (weights || {})[v.id] ?? 1, hit: bt && bt.stats[v.id] ? bt.stats[v.id].hit : NaN })), 'why:chart')),
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
    filterRow(models.filter),
    el('p', { class: 'muted small', text: `The bottom finder learns whether a buy here reached its target before its stop; the top finder, whether the price fell to a target before rising to a stop. They only push the score their way. LightGBM and the LSTM vote only if right more than half the time on at least 200 clear test calls; the finders, only if right ${Math.round(TURN_EDGE * 100)} points more often than the outcome happens anyway. Like every method, the backtest then weights them by how often they were right.` }));
}

// The trade filter's test on the newest year of Buy-looking candles it never trained on.
function filterRow(m) {
  const t = m && m.test;
  if (!t) return el('div', { class: 'bt-row' }, el('span', { text: 'Trade filter' }), el('span', { class: 'muted', text: 'not trained' }));
  return el('div', {},
    el('div', { class: 'bt-row' },
      el('span', { text: 'Trade filter' }),
      el('span', { class: t.passed ? 'good' : 'muted', text: `${t.passed ? 'passed' : 'not used'} · kept ${t.kept} of ${t.n} test trades` })),
    el('p', { class: 'muted small', text: `In its test year, the trades it kept made ${fmtPct(t.keptAvg)} each on average after fees (won ${Math.round(t.keptWin * 100)}%), against ${fmtPct(t.allAvg)} for all of them (won ${Math.round(t.allWin * 100)}%) and ${fmtPct(t.skippedAvg)} for the ones it skipped.${t.passed ? ' The paper account uses it.' : ` Not used: ${t.why}.`}` }));
}

// The trade filter's view of a buy idea, for its card.
const filterText = f => `Trade filter: ${Math.round(f.p * 100)}% chance of the target before the stop, ${f.size > 0 ? `expects ${fmtPct(f.ev)} after fees${f.size !== 1 ? `, sized ×${f.size.toFixed(1)}` : ''}` : `expects a loss (${fmtPct(f.ev)})`}`;

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
    el('p', { class: 'muted small', text: `Weights learned from ${fmtDate(bt.trainFrom)} to ${fmtDate(bt.testFrom)}, then tested on the ${bt.testCandles} newer candles they never saw. Long only, buying on a new Buy score and selling on the stop-loss, target or a Sell score, with ${state.chartItem.type === 'crypto' ? 'NDAX\'s 0.2%' : 'IBKR\'s fee (0.1% on a $1,000 order)'} on each buy and sell.` }),
    bt.rule ? line(`Tuned levels (${bt.rule.mode === 'dip' ? 'dip mode' : 'standard'}, ${fmtScore(bt.rule.buy)} / ${fmtScore(bt.rule.sell)})`, bt.tuned) : null,
    bt.rule ? line('Standard levels (+40 / -40)', bt.standard) : line('Weighted methods', w),
    line('All methods equal', bt.equal),
    bt.trailed ? line('Same trades, trailing stop instead of the target', bt.trailed) : null,
    bt.locked ? line('Same trades, target with a profit lock', bt.locked) : null,
    bt.trailed ? el('p', { class: 'muted small', text: `The trailing stop moves to break even after fees once a trade is up ${state.settings.stopAtr / 2} ATR, then follows the highest price ${state.settings.stopAtr} ATR below it (your stop-loss distance). Compare it with the ${bt.rule ? 'tuned' : 'weighted'} line above, which uses the target, to see which exit did better here. The profit lock keeps the target, and once a trade is up ${state.settings.stopAtr} ATR its stop keeps half of the best gain, rising to three quarters near the target.` }) : null,
    bt.rule ? el('p', { class: 'muted small', text: `The tuned levels were picked on the older candles only (where they made ${fmtPct(bt.tunedTrain ? bt.tunedTrain.totalReturn : NaN)}), so the test above shows whether they hold up on candles they never saw.` }) : null,
    el('div', { class: 'bt-row' }, el('span', { text: 'Buy and hold' }), el('span', { class: w.buyHold > 0 ? 'good' : 'bad', text: fmtPct(w.buyHold) })),
    w.open ? el('p', { class: 'small', text: `A test trade is still open from ${formatMoney(w.open.entry)}, counted at today's price.` }) : null,
    el('p', { class: 'muted small', text: 'Past results do not predict future ones, and a short test can be luck.' }));
}

// ---- Signals tab and scanner -----------------------------------------------

// A one-line card: tap it for the details, or the chart button for the chart.
// Cards you opened stay open when the list is drawn again.
function foldCard(cls, id, top, details, openIt) {
  const more = el('div', { class: 'details', hidden: !state.openCards.has(id) }, ...details.filter(Boolean));
  const li = el('li', { class: `${cls} fold${more.hidden ? '' : ' open'}`, 'data-card': id, onclick: () => {
    more.hidden = !more.hidden;
    li.classList.toggle('open', !more.hidden);
    if (more.hidden) state.openCards.delete(id);
    else state.openCards.add(id);
  } },
  el('div', { class: 'signal-top' }, ...top,
    el('button', { type: 'button', class: 'ghost chart-btn', 'aria-label': 'Open the chart', text: '📈', onclick: e => { e.stopPropagation(); openIt(); } })),
  more);
  return li;
}

function signalCard(sig) {
  const item = findItem(sig.key);
  return foldCard('signal', `sig:${sig.key}`, [
    el('div', { class: 'sym' }, sig.symbol, typeBadge(sig.type),
      el('span', { class: `action ${sig.action}`, text: ACTION_WORDS[sig.action] })),
    el('div', { class: `score ${scoreClass(sig.score, sig.rule)}`, text: fmtScore(sig.score) }),
  ], [
    scoreMeter(sig.score),
    el('div', { class: 'sub', text: `${Math.round(sig.confidence * 100)}% agree · ${levelsLine(sig)}` }),
    sig.tuned && sig.rule ? el('div', { class: 'sub', text: tunedLine(sig) }) : null,
    sig.action === 'buy' && sig.record ? el('div', { class: 'sub', text: tradeRecordLine(sig.symbol, sig.record) }) : null,
    sig.top && sig.top.length ? el('div', { class: 'sub', text: `Led by ${sig.top.join(', ')}` }) : null,
  ], () => { state.chartTf = sig.tf; openChart(item, true); });
}

// The strongest few, then a button for the rest.
const FIRST_SHOWN = 5;
function shortList(rows, card) {
  const ul = el('ul', { class: 'list' }, ...rows.slice(0, FIRST_SHOWN).map(card));
  const more = rows.length > FIRST_SHOWN
    ? el('button', { type: 'button', class: 'ghost show-all', text: `Show all ${rows.length}`, onclick: e => { ul.append(...rows.slice(FIRST_SHOWN).map(card)); e.currentTarget.remove(); } })
    : null;
  return [ul, more].filter(Boolean);
}

// Watchlist, Opportunities and Market: one at a time, the last one remembered.
const SIGNAL_TABS = [['watchlist', 'Watchlist', 'signals-body'], ['opps', 'Opportunities', 'opps-body'], ['market', 'Market', 'market-body']];
function renderSignalTabs() {
  const tabs = serverOn() ? SIGNAL_TABS : SIGNAL_TABS.filter(([id]) => id !== 'opps');
  const on = tabs.some(([id]) => id === state.settings.signalsTab) ? state.settings.signalsTab : 'watchlist';
  const m = state.market || {};
  const tf = state.settings.alertTf;
  const counts = {
    watchlist: Object.values(state.signals).filter(s => findItem(s.key) && s.tf === tf && s.action !== 'hold').length,
    opps: m.at && m.records ? (m.opportunities || []).length : null,
    market: m.at ? (m.buys || []).length + (m.sells || []).length : null,
  };
  $('signal-tabs').replaceChildren(...tabs.map(([id, label]) => el('button', {
    type: 'button', role: 'tab', class: id === on ? 'on' : '', 'aria-selected': id === on ? 'true' : 'false',
    text: counts[id] == null ? label : `${label} (${counts[id]})`,
    onclick: () => { state.settings = store.saveSettings({ signalsTab: id }); renderSignalTabs(); },
  })));
  for (const [id, , body] of SIGNAL_TABS) $(body).hidden = id !== on;
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
  const card = sig => paperNote(signalCard(sig), sig);
  const section = (title, list, empty) => [
    el('h2', { class: 'section', text: `${title} (${list.length})` }),
    ...(list.length ? shortList(list, card) : [el('p', { class: 'muted small', text: empty })]),
  ];
  const holdsOpen = state.openCards.has('holds');
  $('signals-body').replaceChildren(
    ...section(`Buy on ${TIMEFRAMES[tf].label}`, buys, 'No symbol is a Buy right now.'),
    ...section(`Sell on ${TIMEFRAMES[tf].label}`, sells, 'No symbol is a Sell right now.'),
    holds.length ? el('details', { class: 'report', open: holdsOpen, ontoggle: e => { if (e.currentTarget.open) state.openCards.add('holds'); else state.openCards.delete('holds'); } },
      el('summary', { text: `No signal (${holds.length})` }),
      el('ul', { class: 'list' }, ...holds.map(card))) : null,
    errors.length ? el('details', { class: 'report' },
      el('summary', { text: `Could not score ${errors.length}` }),
      el('p', { class: 'muted small', text: errors.map(([k, e]) => `${k.split(':')[1]} (${e})`).join('; ') })) : '',
  );
  renderOpportunities();
  renderMarket();
}

// ---- Opportunities (from the server's market scan) -------------------------------

const setupName = id => (id === 'signal' ? 'Buy and Sell signals' : id === 'scan' ? 'Market scan ideas' : SETUPS[id] ? SETUPS[id].name : id);
// Stock or crypto, in its own colour so the two are told apart at a glance.
const typeBadge = type => el('span', { class: `badge type-${type === 'crypto' ? 'crypto' : 'stock'}`, text: type === 'crypto' ? 'Crypto' : 'Stock' });
// The paper page's source filters, and which one a trade belongs to.
const SOURCES = [['all', 'All'], ['signal', 'Signals'], ['scan', 'Scan'], ['opps', 'Opportunities']];
const sourceOf = p => { const s = paper.setupOf(p); return s === 'signal' || s === 'scan' ? s : 'opps'; };
// A short tag for where a paper trade came from.
const sourceTag = id => (id === 'signal' ? 'Signal' : id === 'scan' ? 'Scan' : SETUPS[id] ? SETUPS[id].name : id);
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
  return foldCard('signal opp', `opp:${o.id}`, [
    el('div', { class: 'sym' }, o.symbol, typeBadge(o.type),
      el('span', { class: o.proven ? 'badge proven' : 'badge', text: o.proven ? 'Proven' : 'Not proven' }),
      el('span', { class: 'opp-setup', text: setupName(o.setup) })),
    el('div', { class: `score ${o.ev > 0 ? 'up' : 'down'}`, text: fmtPct(o.ev) }),
  ], [
    el('p', { class: 'why', text: o.why }),
    el('div', { class: 'sub', text: recordLine(o.record, o.hold) }),
    symbolRec ? el('div', { class: 'sub', text: symbolRec }) : null,
    el('div', { class: 'sub', text: `Entry ${formatMoney(o.entry)} · Stop ${formatMoney(o.stop)} · Target ${formatMoney(o.take)} · hold up to ${holdText(o)}` }),
    feedbackButtons([o.setup], o.id),
  ], () => { state.chartTf = '1D'; openChart(item, true); });
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
    el('summary', { text: 'How each setup has done' }),
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
  renderSignalTabs();
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
    el('p', { class: 'muted small', text: `Ranked by the average result of past cases after fees, from the scan ${timeAgo(m.at)}.` }),
    muted.length ? el('p', { class: 'small', text: `Muted after your ratings: ${muted.map(setupName).join(', ')}. They still show here; turn their alerts back on in Settings.` }) : null,
    warnings.length ? el('ul', { class: 'list' }, ...warnings.map(w => el('li', { class: 'signal' }, el('div', { class: 'sym', text: w.title }), el('div', { class: 'sub', text: w.body })))) : null,
    ...(opps.length ? shortList(opps, o => oppPaperNote(opportunityCard(o), o))
      : [el('p', { class: 'muted small', text: 'No setup fired on the newest candles. The report below shows how each one did in the past.' })]),
    setupReport(m),
  ].filter(Boolean));
}

function renderMarket() {
  const m = state.market;
  const body = $('market-body');
  renderSignalTabs();
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
  const card = sig => {
    const li = signalCard(sig);
    if (fresh.has(sig.key)) li.querySelector('.sym').append(el('span', { class: 'badge', text: 'New' }));
    return paperNote(li, sig);
  };
  // Buy or sell ideas, one list at a time.
  const side = state.marketSide === 'sell' ? 'sell' : 'buy';
  const rows = (side === 'buy' ? m.buys : m.sells) || [];
  const pick = (id, label, n) => el('button', { type: 'button', class: id === side ? 'on' : '', text: `${label} (${n})`, onclick: () => { state.marketSide = id; renderMarket(); } });
  body.replaceChildren(
    el('p', { class: 'muted small', text: scanLine(m) }),
    el('div', { class: 'chips' }, pick('buy', 'Buy ideas', (m.buys || []).length), pick('sell', 'Sell ideas', (m.sells || []).length)),
    ...(rows.length ? shortList(rows, card) : [el('p', { class: 'muted small', text: `No ${side} ideas in the last scan.` })]),
  );
}

function scanLine(m) {
  if (!m.cryptoAt && !m.stocksAt) return `${m.scanned} of ${m.total} symbols on the daily chart, scanned ${timeAgo(m.at)} by your server.`;
  const crypto = m.cryptoAt ? `${m.cryptoScanned} coins ${timeAgo(m.cryptoAt)}` : 'crypto not yet';
  const stocks = m.stocksAt ? `${m.stocksScanned} S&P 500 stocks ${timeAgo(m.stocksAt)}` : 'stocks not yet';
  return `Daily chart, scanned by your server: ${crypto} (every 15 minutes, day and night), ${stocks}.`;
}

// Opportunities the server's paper account bought get a PAPER tag too; the
// others say why it didn't buy them.
function oppPaperNote(li, o) {
  if (!serverPaperOn()) return li;
  const acc = state.serverPaper.paper;
  if ((acc.positions || []).some(p => p.id === o.id || (p.key === o.key && p.setup === o.setup))) {
    li.querySelector('.sym').append(el('span', { class: 'badge proven', text: 'Paper' }));
  } else if (acc.skips && acc.skips[o.key]) {
    (li.querySelector('.details') || li).append(el('div', { class: 'sub', text: `Not in paper trading: ${acc.skips[o.key]}.` }));
  }
  return li;
}

// Buy ideas the server's paper account holds get a PAPER tag; the others say
// why it didn't buy them.
function paperNote(li, sig) {
  if (!serverPaperOn() || sig.action !== 'buy') return li;
  const acc = state.serverPaper.paper;
  const details = li.querySelector('.details') || li;
  const filter = sig.filter || ((state.serverSignals || {})[sig.key] || {}).filter;
  if (filter) details.append(el('div', { class: 'sub', text: filterText(filter) }));
  if ((acc.positions || []).some(p => p.key === sig.key)) {
    li.querySelector('.sym').append(el('span', { class: 'badge proven', text: 'Paper' }));
  } else if (acc.skips && acc.skips[sig.key]) {
    details.append(el('div', { class: 'sub', text: `Not in paper trading: ${acc.skips[sig.key]}.` }));
  } else {
    // The server buys on its own score, which can differ from this phone's.
    const s = (state.serverSignals || {})[sig.key];
    const why = !state.serverSignals ? null
      : !s ? 'the server has not scored it yet'
        : s.action !== 'buy' ? `the server rates it ${s.action === 'sell' ? 'Sell' : 'Hold'} (${fmtScore(s.score)}${s.tf ? ` on ${s.tf}` : ''}, price ${formatMoney(s.entry)}${s.candleTime ? `, candle of ${new Date(s.candleTime * 1000).toLocaleDateString()}` : ''}${s.source ? ` from ${s.source}` : ''}${s.at ? `, scored ${new Date(s.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''})`
          : null;
    if (why) details.append(el('div', { class: 'sub', text: `Not in paper trading: ${why}.` }));
  }
  return li;
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
    const { signals = {}, market, modelsAt = {}, setups = null } = await srv.serverFetch(state.settings, '/signals');
    state.serverSignals = signals; // the server's own watchlist scores, which paper-trade
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
  $('server-push').checked = !!state.settings.serverPush;
  $('server-push').disabled = !serverOn();
  $('server-test').hidden = !state.settings.serverPush;
  $('server-train').disabled = !serverOn() || trainingNow(st);
  if (!serverOn()) $('server-conn').open = true;
  renderSettingsSummaries();
  const info = $('server-info');
  if (!serverOn()) { info.replaceChildren(el('p', { class: 'small', text: 'Not connected. Add your server below.' })); return; }
  if (!st) { info.replaceChildren(el('p', { class: 'muted small', text: 'Checking your server…' })); return; }
  if (st.error) { info.replaceChildren(el('p', { class: 'small bad', text: st.error })); return; }
  const w = st.watch || {};
  const c = st.crypto || {};
  const when = t => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const rows = [
    ['Alerts', st.pushEnabled ? `${state.settings.serverPush ? 'On' : 'Off'} on this phone · ${st.devices} phone${st.devices === 1 ? '' : 's'} in all` : 'Notification keys are not set on the server'],
    ['Watchlist', w.lastRunAt ? `${timeAgo(w.lastRunAt)} · every ${st.watchEveryMinutes} min and at each candle close` : 'Starts within a few minutes'],
    ['Stops and targets', st.prices && st.prices.lastRunAt ? `${timeAgo(st.prices.lastRunAt)} · every minute` : 'Starts within a minute'],
    ['Crypto scan', c.lastRunAt ? `${timeAgo(c.lastRunAt)} · ${c.scanned} of ${c.total} coins · every ${c.everyMinutes} min` : `Every ${c.everyMinutes || 15} min, starting shortly`],
    ['Fast moves', c.pulseAt ? `Watched every minute${c.lastMoveAt ? ` · last ${timeAgo(c.lastMoveAt)}` : ''}` : null],
    ['Stock scan', [st.market && st.market.lastRunAt ? timeAgo(st.market.lastRunAt) : null, st.market && st.market.nextAt ? `next ${when(st.market.nextAt)}` : null].filter(Boolean).join(' · ') || null],
  ].filter(([, v]) => v);
  // What went wrong, on its own line, with the details a tap away.
  const problems = [
    ...Object.entries(w.errors || {}).map(([key, msg]) => `${key.split(':').pop()}: ${String(msg).slice(0, 160)}`),
    c.listError ? `Coin list: ${c.listError}` : null,
    st.market && st.market.error ? `Stock scan: ${st.market.error}` : null,
    ...Object.entries((st.training && st.training.results) || {}).filter(([, r]) => r.error).map(([tf, r]) => `Training ${tf}: ${r.error}`),
  ].filter(Boolean);
  const models = Object.entries(st.models || {});
  const pct = t => (t ? `${Math.round(t.hit * 100)}%${t.usable ? '' : ' off'}` : '–');
  const training = trainingNow(st) ? `Training now, started ${timeAgo(st.training.runningSince)}`
    : st.training && st.training.nextAt ? `Next training ${when(st.training.nextAt)}` : '';
  info.replaceChildren(...[
    el('dl', { class: 'srv-rows' }, ...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
    problems.length ? el('details', { class: 'srv-problems' },
      el('summary', { class: 'bad small', text: `${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0].split(':')[0]}${problems.length > 1 ? ' and more' : ''}` }),
      el('ul', { class: 'small' }, ...problems.map(t => el('li', { text: t })))) : null,
    el('div', { class: 'muted small srv-models-head', text: models.length ? `Models, right in their test${training ? ` · ${training}` : ''}` : `Models are not trained yet${training ? ` · ${training}` : ''}` }),
    models.length ? el('table', { class: 'srv-models' },
      el('thead', {}, el('tr', {}, ...['', 'LightGBM', 'LSTM', 'Bottom', 'Top'].map(t => el('th', { text: t })))),
      el('tbody', {}, ...models.map(([tf, m]) => el('tr', {},
        el('th', { text: TIMEFRAMES[tf] ? TIMEFRAMES[tf].label : tf }),
        ...[m.lgbm, m.lstm, m.bottom, m.top].map(t => el('td', { class: t && !t.usable ? 'muted' : '', text: pct(t) })))))) : null,
  ].filter(Boolean));
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
      status.textContent = 'Server alerts are on. Tap Test alert to check.';
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
      outcomeLine(h.qty, h.qty * h.buyPrice, h.stop, h.take),
      el('div', { class: 'sub' },
        `Stop ${h.stop != null ? formatMoney(h.stop) : 'not set'} · Target ${h.take != null ? formatMoney(h.take) : 'not set'} `,
        lvl === 'stop' ? el('span', { class: 'level stop', text: 'Stop hit' }) : lvl === 'target' ? el('span', { class: 'level target', text: 'Target reached' }) : null));
  }));
  if (!state.holdings.length) list.append(el('p', { class: 'muted center', text: 'Add what you own to get stop-loss, target and sell alerts.' }));
}

// What the position is worth if it sells at its stop and at its target,
// against what was invested (less the broker's fee when `type` is given).
function outcomeLine(qty, invested, stop, take, type) {
  const at = price => qty * price - (type ? feeOf(type, qty, price) : 0);
  const part = (name, price) => {
    if (price == null || !Number.isFinite(price)) return null;
    const v = at(price);
    return el('span', {}, `${name}: ${formatMoney(v)} `, el('span', { class: upDown(v - invested), text: `(${signed(v - invested)})` }));
  };
  const s = part('At the stop', stop);
  const t = part('At the target', take);
  if (!s && !t) return null;
  return el('div', { class: 'sub' }, ...[s, s && t ? ' · ' : null, t].filter(Boolean));
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
    if (state.view === 'signals') renderSignals();
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
  const events = paper.step(paperAccount(), { signals, alerts, riskPct: state.settings.riskPct, budgets: paper.PHONE_BUDGETS, trail: state.settings.paperExit === 'trail', lock: state.settings.paperExit === 'lock' });
  store.savePaper(state.paper);
  for (const ev of events) {
    toast(ev.kind === 'open'
      ? `Paper trade: bought ${ev.symbol} for ${formatMoney(ev.cost)}`
      : `Paper trade: sold ${ev.symbol} (${ev.reason}), ${ev.pnl >= 0 ? '+' : ''}${formatMoney(ev.pnl)}`);
  }
}

function renderPaper({ force = false } = {}) {
  // Background refreshes wait while you are changing a trade's stop and target.
  if (!force && state.paperEditing && document.querySelector('.paper-edit:not([hidden])')) return;
  state.paperEditing = null;
  const full = paperAccount();
  // All, Stocks or Crypto: the summary, the tabs and the lists below show that kind only.
  const kind = ['all', 'stock', 'crypto'].includes(state.settings.paperKind) ? state.settings.paperKind : 'all';
  const ofKind = x => kind === 'all' || (String(x.key || '').startsWith('crypto:') ? 'crypto' : 'stock') === kind;
  const acc = kind === 'all' ? full : { ...full, positions: full.positions.filter(ofKind), trades: full.trades.filter(ofKind) };
  const onServer = serverPaperOn();
  const serverPrices = (onServer && state.serverPaper.prices) || {};
  // Your watchlist's quote, else the server's latest price, else the last scan's close
  // (its buy and sell ideas and its opportunities).
  const m = state.market || {};
  const scanned = Object.fromEntries([...(m.opportunities || []), ...(m.buys || []), ...(m.sells || [])].map(s => [s.key, s.entry]));
  const lastPrice = key => [priceOf(key), serverPrices[key], ((state.serverSignals || {})[key] || {}).entry, scanned[key]].find(Number.isFinite);
  const prices = Object.fromEntries(acc.positions.map(p => [p.key, lastPrice(p.key)]));
  const sum = paper.summary(full, prices);
  const events = (onServer ? state.serverPaper.events || [] : []).filter(ofKind);
  const fmtTime = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const open = acc.positions.map(p => {
    const price = prices[p.key];
    const value = Number.isFinite(price) ? p.qty * price : NaN;
    return { p, price, value, pnl: value - p.cost, ret: value / p.cost - 1 };
  });
  const invested = open.reduce((t, o) => t + (Number.isFinite(o.value) ? o.value : o.p.cost), 0);
  const priced = open.filter(o => Number.isFinite(o.value));
  const openCost = priced.reduce((t, o) => t + o.p.cost, 0);
  const openPnl = priced.length ? priced.reduce((t, o) => t + o.pnl, 0) : NaN;
  const closedPnl = acc.trades.reduce((t, x) => t + x.pnl, 0);
  const sumMore = state.openCards.has('paper:more');
  const kindChips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Show' }, ...[['all', 'All'], ['stock', 'Stocks'], ['crypto', 'Crypto']]
    .map(([id, label]) => el('button', { type: 'button', class: id === kind ? 'on' : '', 'aria-pressed': id === kind ? 'true' : 'false', text: label,
      onclick: () => { state.settings = store.saveSettings({ paperKind: id }); renderPaper({ force: true }); } })));
  const summary = kind !== 'all' ? kindSummary() : el('div', { class: 'card' },
    el('div', { class: 'muted small', text: `Paper account, started ${fmtTime(acc.createdAt)} with ${formatMoney(acc.start)}${onServer ? ` · on your server, updated ${timeAgo(state.serverPaper.fetchedAt)}` : ''}` }),
    el('div', { class: 'big', text: formatMoney(sum.equity) }),
    el('dl', { class: 'stats' },
      stat('Return', fmtPct(sum.totalReturn), upDown(sum.totalReturn)),
      stat('Open gain/loss', Number.isFinite(openPnl) ? `${signed(openPnl)} (${fmtPct(openPnl / openCost)})` : '–', upDown(openPnl)),
      stat('Closed gain/loss', acc.trades.length ? signed(closedPnl) : '–', upDown(closedPnl)),
      stat('Invested now', formatMoney(invested)),
      stat('Cash', formatMoney(acc.cash))),
    equityChart(acc, sum.equity, onServer ? state.serverPaper.shadow : null, { bare: true }),
    el('details', { class: 'report', open: sumMore, ontoggle: e => { if (e.currentTarget.open) state.openCards.add('paper:more'); else state.openCards.delete('paper:more'); } },
      el('summary', { text: 'More' }),
      el('dl', { class: 'stats' },
        stat('Closed trades', String(sum.trades)),
        stat('Won', sum.trades ? `${Math.round(sum.winRate * 100)}%` : '–'),
        stat('Worst drop', fmtPct(-sum.maxDrawdown)))));

  // Open, Closed and Results: one at a time, the last one remembered.
  const tab = ['open', 'closed', 'results', 'latest'].includes(state.settings.paperTab) ? state.settings.paperTab : 'open';
  const tabs = el('div', { class: 'chips tabs', role: 'tablist' }, ...[['open', `Open (${acc.positions.length})`], ['closed', `Closed (${acc.trades.length})`], ['results', 'By setup'], ['latest', 'Latest']]
    .map(([id, label]) => el('button', { type: 'button', role: 'tab', class: id === tab ? 'on' : '', 'aria-selected': id === tab ? 'true' : 'false', text: label,
      onclick: () => { state.settings = store.saveSettings({ paperTab: id }); renderPaper({ force: true }); } })));

  const body = tab === 'open' ? openTab() : tab === 'closed' ? closedTab() : tab === 'latest' ? [
    // Every buy and sell, newest first.
    events.length ? el('ul', { class: 'list' }, ...events.slice(0, 50).map(latestCard))
      : el('p', { class: 'muted small', text: onServer ? 'No paper buys or sells yet.' : 'The latest buys and sells show here when your server runs the paper account.' }),
  ] : [
    bySetupTable(acc, onServer ? state.serverPaper.budgets : null),
    onServer ? filterTrialCard(state.serverPaper) : null,
  ];
  // replaceChildren() writes a null child as the text "null", so drop the empty parts.
  $('paper-body').replaceChildren(...[kindChips, summary, onServer ? whatIfTotals(acc) : null, tabs, ...body].filter(Boolean));

  // One kind's results: its gain/loss after the fees paid so far (closed trades
  // as they sold, open ones at today's price) and its running gain over time.
  // Cash and the account value stay under All, since both kinds share the cash.
  function kindSummary() {
    const closed = closedPnl;
    const gain = closed + (Number.isFinite(openPnl) ? openPnl : 0);
    const used = acc.trades.reduce((t, x) => t + costOf(x), 0) + acc.positions.reduce((t, p) => t + p.cost, 0);
    const won = acc.trades.filter(t => t.pnl > 0).length;
    const name = kind === 'crypto' ? 'Crypto' : 'Stock';
    let run = 0;
    let peak = 0;
    let worst = 0;
    const history = [{ t: full.createdAt, equity: full.start }];
    for (const t of acc.trades.slice().sort((a, b) => a.closedAt - b.closedAt)) {
      run += t.pnl;
      peak = Math.max(peak, run);
      worst = Math.max(worst, (peak - run) / (full.start + peak));
      history.push({ t: t.closedAt, equity: full.start + run });
    }
    return el('div', { class: 'card' },
      el('div', { class: 'muted small', text: `${name} trades since ${fmtTime(full.createdAt)}${onServer ? ` · on your server, updated ${timeAgo(state.serverPaper.fetchedAt)}` : ''}` }),
      el('div', { class: `big ${upDown(gain)}`, text: acc.trades.length || acc.positions.length ? signed(gain) : '–' }),
      el('div', { class: 'muted small', text: 'Gain/loss, closed and open, after the fees paid so far. Return is on the money these trades used.' }),
      el('dl', { class: 'stats' },
        stat('Return', used > 0 ? fmtPct(gain / used) : '–', upDown(gain)),
        stat('Open gain/loss', Number.isFinite(openPnl) ? `${signed(openPnl)} (${fmtPct(openPnl / openCost)})` : '–', upDown(openPnl)),
        stat('Closed gain/loss', acc.trades.length ? signed(closed) : '–', upDown(closed)),
        stat('Invested now', formatMoney(invested))),
      equityChart({ ...full, history }, full.start + gain, null, { bare: true, gainOf: name.toLowerCase() }),
      el('details', { class: 'report', open: sumMore, ontoggle: e => { if (e.currentTarget.open) state.openCards.add('paper:more'); else state.openCards.delete('paper:more'); } },
        el('summary', { text: 'More' }),
        el('dl', { class: 'stats' },
          stat('Closed trades', String(acc.trades.length)),
          stat('Won', acc.trades.length ? `${Math.round((won / acc.trades.length) * 100)}%` : '–'),
          stat('Worst drop', acc.trades.length ? fmtPct(-worst) : '–'))));
  }

  // One buy or sell. The server's line carries the price, quantity and cost;
  // the matching open or closed trade adds the rest, fees included.
  function latestCard(ev, i) {
    const when = new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const near = t => Number.isFinite(t) && Math.abs(t - ev.at) < 10 * 60000;
    const type = String(ev.key || '').startsWith('crypto:') ? 'crypto' : 'stock';
    const top = (word, cls, right, rightCls) => [
      el('div', {},
        el('div', { class: 'sym' }, el('span', { class: `latest-kind ${cls}`, text: word }), ev.symbol, typeBadge(type)),
        el('div', { class: 'sub', text: when })),
      el('div', { class: `paper-gain ${rightCls || ''}`, text: right }),
    ];
    const tile = (label, value, cls) => stat(label, value, cls);
    const cents = v => `$${v.toFixed(2)}`;
    const chart = () => { const item = findItem(ev.key); if (item) openChart(item, true); };
    if (ev.kind === 'open') {
      const pos = acc.positions.find(p => p.key === ev.key && near(p.openedAt)) || acc.trades.find(t => t.key === ev.key && near(t.openedAt));
      const value = ev.qty * ev.price;
      return foldCard('holding', `latest:${ev.key}:${ev.at}:${i}`, top('Bought', 'good', formatMoney(ev.cost)), [
        el('div', { class: 'sub', text: sourceTag(ev.setup || 'signal') }),
        el('dl', { class: 'money-row' },
          tile('Quantity', fmtQty({ qty: ev.qty, type })),
          tile('Buy price', formatMoney(ev.price)),
          tile('Order value', formatMoney(value))),
        el('dl', { class: 'money-row' },
          tile('Fee', cents(Math.max(0, ev.cost - value))),
          tile('Total paid', formatMoney(ev.cost))),
        pos && Number.isFinite(pos.stop) ? el('div', { class: 'sub', text: pos.trail
          ? `Bought with a trailing stop from ${formatMoney(pos.trail && pos.risk ? pos.entry - pos.risk : pos.stop)} and no target`
          : `Bought with the stop at ${formatMoney(pos.stop)} and the target at ${formatMoney(pos.take)}` }) : null,
        pos && !acc.positions.includes(pos) ? el('div', { class: 'sub', text: 'Sold since; see the Closed tab.' }) : null,
      ], chart);
    }
    if (ev.kind === 'close') {
      const t = acc.trades.find(x => x.key === ev.key && near(x.closedAt));
      const why = ev.reason === 'time' ? 'holding period over' : ev.reason;
      const pct = t && costOf(t) > 0 ? ` · ${fmtPct(t.pnl / costOf(t))}` : '';
      const head = top('Sold', 'bad', `${signed(ev.pnl)}${pct}`, upDown(ev.pnl));
      if (!t) return foldCard('holding', `latest:${ev.key}:${ev.at}:${i}`, head, [el('div', { class: 'sub', text: ev.text || why })], chart);
      const value = t.qty * t.exit;
      const back = costOf(t) + t.pnl;
      const buyFee = Math.max(0, costOf(t) - t.qty * t.entry);
      const sellFee = Math.max(0, value - back);
      const days = Math.max(0, Math.round((t.closedAt - t.openedAt) / 86400000));
      return foldCard('holding', `latest:${ev.key}:${ev.at}:${i}`, head, [
        el('div', { class: 'sub', text: `${sourceTag(t.setup || 'signal')} · ${why}` }),
        el('dl', { class: 'money-row' },
          tile('Quantity', fmtQty(t)),
          tile('Sell price', formatMoney(t.exit)),
          tile('Order value', formatMoney(value))),
        el('dl', { class: 'money-row' },
          tile('Fee', cents(sellFee)),
          tile('Got back', formatMoney(back)),
          tile('It cost', formatMoney(costOf(t)))),
        el('div', { class: 'sub', text: `Bought at ${formatMoney(t.entry)} on ${fmtTime(t.openedAt)}, held ${days < 1 ? 'under a day' : `${days} day${days === 1 ? '' : 's'}`}` }),
        el('div', { class: 'sub', text: `Fees on this trade: ${cents(buyFee + sellFee)} (buy ${cents(buyFee)}, sell ${cents(sellFee)})` }),
      ], chart);
    }
    return el('li', { class: 'holding' }, el('div', { class: 'sub', text: `${when} · ${ev.text || ''}` }));
  }

  // Where trades came from, for the filter buttons on Open and Closed.
  function sourceButtons(source, list, gainOf, pick) {
    const sum = id => list.filter(x => id === 'all' || sourceOf(x) === id).reduce((t, x) => t + (Number.isFinite(gainOf(x)) ? gainOf(x) : 0), 0);
    return el('div', { class: 'chips' }, ...SOURCES.map(([id, label]) => {
      const n = list.filter(x => id === 'all' || sourceOf(x) === id).length;
      const g = sum(id);
      return el('button', { type: 'button', class: id === source ? 'on' : '', onclick: () => pick(id) },
        label, n ? el('span', { class: `chip-gain ${upDown(g)}`, text: ` ${signed(g)}` }) : null);
    }));
  }

  // A picture of one source: three tiles, a bar of trades that went up
  // against down (or won against lost), and for opportunities a gain bar
  // for each setup.
  function sourceSummary(source, { tiles, split, setups }) {
    const name = (SOURCES.find(([id]) => id === source) || SOURCES[0])[1];
    const [good, bad, goodLabel, badLabel] = split;
    const n = good + bad;
    const most = Math.max(1, ...(setups || []).map(x => Math.abs(x.gain)));
    return el('div', { class: 'card source-sum' },
      el('div', { class: 'sum-title', text: name }),
      el('div', { class: 'sum-tiles' }, ...tiles.map(([label, value, cls, note]) => el('div', { class: 'sum-tile' },
        el('span', { class: 'sum-label', text: label }),
        el('strong', { class: cls || '', text: value }),
        note ? el('span', { class: `sum-note ${cls || ''}`, text: note }) : null))),
      n ? el('div', { class: 'sum-split-label', text: `${good} ${goodLabel}, ${bad} ${badLabel}` }) : null,
      n ? el('div', { class: 'sum-split' },
        good ? el('span', { class: 'good', style: `width:${(good / n) * 100}%` }) : null,
        bad ? el('span', { class: 'bad', style: `width:${(bad / n) * 100}%` }) : null) : null,
      setups && setups.length ? el('div', { class: 'sum-split-label', text: 'Gain by setup' }) : null,
      setups && setups.length ? el('div', { class: 'sum-setups' }, ...setups.flatMap(x => [
        el('span', { text: `${x.name} (${x.count})` }),
        el('div', { class: 'sum-track' }, el('span', { class: upDown(x.gain), style: `width:${Math.max(3, (Math.abs(x.gain) / most) * 100)}%` })),
        el('span', { class: upDown(x.gain), text: signed(x.gain) }),
      ])) : null);
  }
  function bySetup(list, gainOf) {
    const groups = {};
    for (const x of list) (groups[x.setup || 'signal'] ||= []).push(x);
    return Object.entries(groups).map(([id, xs]) => ({
      name: setupName(id), count: xs.length,
      gain: xs.reduce((t, x) => t + (Number.isFinite(gainOf(x)) ? gainOf(x) : 0), 0),
    })).sort((a, b) => b.gain - a.gain);
  }

  function openTab() {
    const source = SOURCES.some(([id]) => id === state.paperSource) ? state.paperSource : 'all';
    const sorts = { loss: (a, b) => (a.pnl || 0) - (b.pnl || 0), gain: (a, b) => (b.pnl || 0) - (a.pnl || 0), newest: (a, b) => b.p.openedAt - a.p.openedAt };
    const sort = sorts[state.paperSort] ? state.paperSort : 'loss';
    const rows = open.filter(o => source === 'all' || sourceOf(o.p) === source).sort(sorts[sort]);
    const pricedRows = rows.filter(o => Number.isFinite(o.value));
    const cost = pricedRows.reduce((t, o) => t + o.p.cost, 0);
    const worth = pricedRows.reduce((t, o) => t + o.value, 0);
    const unpriced = rows.filter(o => !Number.isFinite(o.value)).reduce((t, o) => t + o.p.cost, 0);
    const summary = rows.length ? sourceSummary(source, {
      tiles: [
        ['Invested', formatMoney(rows.reduce((t, o) => t + o.p.cost, 0)), '', `${rows.length} open`],
        ['Worth now', pricedRows.length ? formatMoney(worth + unpriced) : '–'],
        ['Gain', pricedRows.length ? signed(worth - cost) : '–', upDown(worth - cost), pricedRows.length ? fmtPct((worth - cost) / cost) : ''],
      ],
      split: [pricedRows.filter(o => o.pnl > 0).length, pricedRows.filter(o => o.pnl <= 0).length, 'up', 'down'],
      setups: source === 'opps' ? bySetup(rows.map(o => ({ setup: o.p.setup, pnl: o.pnl })), x => x.pnl) : null,
    }) : null;
    const select = el('select', { 'aria-label': 'Sort', onchange: e => { state.paperSort = e.target.value; renderPaper({ force: true }); } },
      ...[['loss', 'Biggest loss first'], ['gain', 'Biggest gain first'], ['newest', 'Newest first']].map(([v, t]) => el('option', { value: v, text: t, selected: v === sort })));
    return [
      acc.positions.length ? el('div', { class: 'paper-tools' },
        sourceButtons(source, open.map(o => ({ ...o.p, pnl: o.pnl })), x => x.pnl, id => { state.paperSource = id; renderPaper({ force: true }); }),
        select) : null,
      summary,
      pnlBars(pricedRows),
      rows.length ? el('ul', { class: 'list' }, ...rows.map(openCard))
        : el('p', { class: 'muted small', text: acc.positions.length ? 'No open trades from this source.' : 'No open paper trades. The next new Buy signal opens one.' }),
    ];
  }

  function openCard({ p, price, value, pnl, ret }) {
    return foldCard('holding paper-card', `paper:${p.key}`, [
      el('div', { class: 'sym' }, p.symbol, typeBadge(p.type), el('span', { class: 'badge', text: sourceTag(p.setup || 'signal') }),
        p.trail ? el('span', { class: 'badge', text: 'Trailing' }) : p.lock ? el('span', { class: 'badge', text: 'Profit lock' }) : null),
      el('div', { class: `paper-gain ${upDown(pnl)}`, text: Number.isFinite(pnl) ? `${signed(pnl)} · ${fmtPct(ret)}` : '–' }),
    ], [
      el('dl', { class: 'money-row' },
        stat('Invested', formatMoney(p.cost)),
        stat('Worth now', Number.isFinite(value) ? formatMoney(value) : '–'),
        stat('Gain/loss', Number.isFinite(pnl) ? signed(pnl) : '–', upDown(pnl))),
      el('div', { class: 'sub', text: `${fmtQty(p)} bought at ${formatMoney(p.entry)} · now ${formatMoney(price)}` }),
      el('div', { class: 'sub', text: p.trail
        ? `Trailing stop at ${formatMoney(p.stop)}${p.stop > p.entry ? ' (above what it cost)' : ''}, highest ${formatMoney(p.high || p.entry)}; no target`
        : `Sells at the stop ${formatMoney(p.stop)}${p.lock && p.stop > p.entry ? ' (profit locked)' : ''} or the target ${formatMoney(p.take)}${p.until ? `, or by ${fmtTime(p.until)}` : ''}${p.lock ? `; the stop keeps part of the best gain (highest ${formatMoney(p.high || p.entry)})` : ''}` }),
      outcomeLine(p.qty, p.cost, p.stop, p.trail ? null : p.take, p.type),
      p.filter && !p.why ? el('div', { class: 'sub', text: filterText(p.filter) }) : null,
      whyFold(p.why, `why:${p.key}:${p.openedAt}`, 'buy', p.filter),
      el('div', { class: 'sub', text: `${setupName(paper.setupOf(p))} · bought ${fmtTime(p.openedAt)}${p.edited ? ' · stop and target set by you' : ''}` }),
      whatIfRow(p, pnl, paper.exitOf(p), true),
      paperControls(p, price),
    ], () => { const item = findItem(p.key); if (item) openChart(item, true); });
  }

  function closedTab() {
    const result = ['all', 'won', 'lost'].includes(state.closedFilter) ? state.closedFilter : 'all';
    const source = SOURCES.some(([id]) => id === state.closedSource) ? state.closedSource : 'all';
    const fromSource = acc.trades.filter(t => source === 'all' || sourceOf(t) === source);
    const rows = fromSource.filter(t => result === 'all' || (result === 'won' ? t.pnl > 0 : t.pnl <= 0)).slice().reverse();
    const won = fromSource.filter(t => t.pnl > 0).length;
    const total = fromSource.reduce((t, x) => t + x.pnl, 0);
    const invested = fromSource.reduce((t, x) => t + costOf(x), 0);
    const summary = fromSource.length ? sourceSummary(source, {
      tiles: [
        ['Trades', String(fromSource.length), '', 'closed'],
        ['Won', `${Math.round((won / fromSource.length) * 100)}%`, '', `${won} of ${fromSource.length}`],
        ['Gain', signed(total), upDown(total), invested > 0 ? fmtPct(total / invested) : ''],
      ],
      split: [won, fromSource.length - won, 'won', 'lost'],
      setups: source === 'opps' ? bySetup(fromSource, x => x.pnl) : null,
    }) : null;
    const shown = state.closedShown || 10;
    const why = t => (t.reason === 'time' ? 'holding period over' : t.reason);
    const card = t => foldCard('holding', `closed:${t.key}:${t.closedAt}`, [
      el('div', { class: 'sym' }, t.symbol, typeBadge(t.type), el('span', { class: 'closed-why', text: why(t) })),
      el('div', { class: `paper-gain ${upDown(t.pnl)}`, text: `${signed(t.pnl)} · ${fmtPct(t.ret)}` }),
    ], [
      el('div', { class: 'sub', text: `Invested ${formatMoney(costOf(t))} · got back ${formatMoney(costOf(t) + t.pnl)}` }),
      el('div', { class: 'sub', text: `${fmtQty(t)} from ${formatMoney(t.entry)} to ${formatMoney(t.exit)}` }),
      el('div', { class: 'sub', text: `${setupName(t.setup || 'signal')} · ${fmtTime(t.openedAt)} to ${fmtTime(t.closedAt)}` }),
      whyFold(t.why, `why:${t.key}:${t.openedAt}`, 'buy', t.filter),
      whyFold(t.whySold, `whysold:${t.key}:${t.closedAt}`, 'sell'),
      whatIfRow(t, t.pnl, t.sellsAt, false),
    ], () => { const item = findItem(t.key); if (item) openChart(item, true); });
    return [
      acc.trades.length ? sourceButtons(source, acc.trades, x => x.pnl, id => { state.closedSource = id; state.closedShown = 10; renderPaper({ force: true }); }) : null,
      acc.trades.length ? el('div', { class: 'chips' }, ...[['all', 'All'], ['won', 'Won'], ['lost', 'Lost']].map(([id, label]) =>
        el('button', { type: 'button', class: id === result ? 'on' : '', text: label, onclick: () => { state.closedFilter = id; state.closedShown = 10; renderPaper({ force: true }); } }))) : null,
      summary,
      rows.length ? el('ul', { class: 'list' }, ...rows.slice(0, shown).map(card))
        : el('p', { class: 'muted small', text: acc.trades.length ? 'No trades here.' : 'No closed paper trades yet.' }),
      rows.length > shown ? el('button', { type: 'button', class: 'ghost show-all', text: `Show more (${rows.length - shown} left)`, onclick: () => { state.closedShown = shown + 20; renderPaper({ force: true }); } }) : null,
    ];
  }
}

// What if: the same trade sold at its target, on a trailing stop and with a
// profit lock (the server replays each one, see paper.whatIf). Your own exit
// shows what really happened; the others what the replay says.
const EXIT_NAMES = { target: 'Target', trail: 'Trail', lock: 'Lock' };
const whatIfOf = t => ((state.serverPaper && state.serverPaper.whatIf) || {})[`${t.key}:${t.openedAt}`];

function whatIfRow(t, actual, mine, isOpen) {
  const r = whatIfOf(t);
  if (!r || !paper.EXITS.every(k => r[k])) return null;
  const value = k => (k === mine && Number.isFinite(actual) ? actual : r[k].pnl);
  const best = paper.EXITS.reduce((a, k) => (value(k) > value(a) ? k : a), mine);
  const note = k => (k === mine ? (isOpen ? 'held' : 'yours') : r[k].open ? 'still held' : r[k].reason === 'target' ? 'at target' : `sold, ${r[k].reason}`);
  return el('div', { class: 'whatif' },
    el('div', { class: 'whatif-label', text: isOpen ? 'What if, so far' : 'What if' }),
    el('div', { class: 'whatif-row' }, ...paper.EXITS.map(k => el('div', { class: `whatif-box ${k === mine ? 'mine' : ''}` },
      el('span', { class: 'whatif-name', text: `${EXIT_NAMES[k]}${k === mine ? ' (yours)' : ''}` }),
      el('strong', { class: upDown(value(k)), text: signed(value(k)) }),
      el('span', { class: 'whatif-note', text: note(k) })))),
    best !== mine && value(best) - value(mine) >= 0.5
      ? el('div', { class: 'whatif-note', text: `${EXIT_NAMES[best]} would have ${isOpen ? 'been' : 'made'} ${formatMoney(value(best) - value(mine))} more${isOpen ? ' so far' : ''}` }) : null);
}

// Every closed trade the server has replayed, added up for each exit. A trade
// counts with what it really made under the exit it used.
function whatIfTotals(acc) {
  const rows = acc.trades.map(t => ({ t, r: whatIfOf(t) })).filter(({ r }) => r && paper.EXITS.every(k => r[k]));
  if (!rows.length) return null;
  const total = k => rows.reduce((sum, { t, r }) => sum + (t.sellsAt === k ? t.pnl : r[k].pnl), 0);
  const sums = Object.fromEntries(paper.EXITS.map(k => [k, total(k)]));
  const real = rows.reduce((sum, { t }) => sum + t.pnl, 0);
  const best = paper.EXITS.reduce((a, k) => (sums[k] > sums[a] ? k : a), 'target');
  const mine = ['target', 'trail', 'lock'].includes(state.settings.paperExit) ? state.settings.paperExit : 'target';
  const held = rows.filter(({ t, r }) => paper.EXITS.some(k => k !== t.sellsAt && r[k].open)).length;
  return el('div', { class: 'card whatif-card' },
    el('h3', { text: 'Which exit would have done best' }),
    el('div', { class: 'muted small', text: `${rows.length} closed trade${rows.length === 1 ? '' : 's'} replayed · yours made ${signed(real)}` }),
    el('div', { class: 'whatif-row' }, ...paper.EXITS.map(k => el('div', { class: `whatif-box ${k === mine ? 'mine' : ''}` },
      el('span', { class: 'whatif-name', text: `${EXIT_NAMES[k]}${k === mine ? ' (yours)' : ''}` }),
      el('strong', { class: upDown(sums[k]), text: signed(sums[k]) })))),
    el('div', { class: 'whatif-note', text: sums[best] - real >= 0.5 ? `${EXIT_NAMES[best]} is ahead of your trades by ${formatMoney(sums[best] - real)}` : 'Your trades did better than any one exit' }),
    held ? el('div', { class: 'whatif-note', text: `${held} would still be held by another exit; counted at today's price` }) : null);
}

// Your own say on a paper trade: move its stop and target, or sell it now.
function paperControls(p, price) {
  const stop = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: String(p.stop) });
  const take = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', value: String(p.take) });
  const status = el('p', { class: 'small', role: 'status' });
  // Or a target set by what you want to keep: the price where selling makes
  // that much after both brokers' fees.
  const gain = el('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: 'e.g. 5' });
  // How this trade sells: at the target, on a trailing stop, or at the target with a profit lock.
  const exit = el('select', { 'aria-label': 'Sells at' },
    ...[['target', 'The target'], ['trail', 'A trailing stop (no target)'], ['lock', 'The target, with a profit lock']]
      .map(([v, t]) => el('option', { value: v, text: t, selected: v === (p.trail ? 'trail' : p.lock ? 'lock' : 'target') })));
  const trail = { get checked() { return exit.value === 'trail'; } };
  const keep = el('p', { class: 'muted small' });
  const showKeep = () => {
    const t = Number(take.value);
    const s = Number(stop.value);
    const net = price => p.qty * price - feeOf(p.type, p.qty, price) - p.cost;
    take.disabled = gain.disabled = trail.checked;
    keep.textContent = trail.checked
      ? `No target: the stop moves to break even once the price is up ${formatMoney(p.risk ? p.risk / 2 : (p.entry - s) / 2)}, then follows the highest price.${s > 0 ? ` At the stop now you keep ${signed(net(s))}.` : ''}`
      : t > 0 ? `At the target you keep ${signed(net(t))} after fees${s > 0 ? `; at the stop, ${signed(net(s))}` : ''}.${exit.value === 'lock' ? ' Profit lock: once the price is up the trade\'s risk, the stop keeps half of the best gain, up to three quarters near the target.' : ''}` : '';
  };
  exit.addEventListener('change', showKeep);
  gain.addEventListener('input', () => {
    const t = paper.priceForGain(p, Number(gain.value));
    if (Number.isFinite(t)) take.value = String(t);
    showKeep();
  });
  take.addEventListener('input', () => { gain.value = ''; showKeep(); });
  stop.addEventListener('input', showKeep);
  showKeep();
  const form = el('div', { class: 'paper-edit', hidden: true },
    el('div', { class: 'row two' },
      el('label', { class: 'field' }, el('span', { text: 'Stop-loss, USD' }), stop),
      el('label', { class: 'field' }, el('span', { text: 'Target, USD' }), take)),
    el('label', { class: 'field' }, el('span', { text: 'Or: sell when I make, after fees, USD' }), gain),
    el('label', { class: 'field' }, el('span', { text: 'Sells at' }), exit),
    keep,
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'primary', text: 'Save', onclick: () => editPaper(p, { action: 'levels', stop: Number(stop.value), take: Number(take.value), trail: exit.value === 'trail', lock: exit.value === 'lock' }, status) }),
      el('button', { type: 'button', class: 'ghost', text: 'Cancel', onclick: () => { form.hidden = true; state.paperEditing = null; } })),
    status);
  const wrap = el('div', { class: 'paper-actions', onclick: e => e.stopPropagation() },
    el('div', { class: 'row' },
      el('button', { type: 'button', class: 'ghost', text: 'Change stop and target', onclick: () => { form.hidden = !form.hidden; state.paperEditing = form.hidden ? null : p.key; } }),
      el('button', { type: 'button', class: 'ghost', text: 'Sell now', onclick: () => editPaper(p, { action: 'sell', price }, status) })),
    form);
  return wrap;
}

async function editPaper(p, { action, price, stop, take, trail, lock }, status) {
  if (action === 'levels' && !(stop > 0 && (trail || take > stop))) {
    status.textContent = 'The stop must be above zero and below the target.';
    return;
  }
  if (action === 'sell') {
    if (!(price > 0)) { status.textContent = 'No price for it yet; try again in a minute.'; return; }
    if (!confirm(`Sell ${fmtQty(p)} of ${p.symbol} now at about ${formatMoney(price)}?`)) return;
  }
  if (serverPaperOn()) {
    try {
      const path = action === 'sell' ? '/paper/sell' : '/paper/levels';
      const body = action === 'sell' ? { key: p.key, price } : { key: p.key, stop, take, trail: !!trail, lock: !!lock };
      const { paper: acc } = await srv.serverFetch(state.settings, path, { method: 'POST', body });
      state.serverPaper = { ...state.serverPaper, paper: acc, fetchedAt: Date.now() };
      store.saveServerPaper(state.serverPaper);
      refreshPaper();
    } catch (e) {
      status.textContent = `Your server said no: ${e.message}`;
      return;
    }
  } else {
    const ok = action === 'sell' ? paper.sellNow(paperAccount(), p.key, price) : paper.setLevels(paperAccount(), p.key, { stop, take, trail: !!trail, lock: !!lock });
    if (!ok) { status.textContent = 'That did not apply.'; return; }
    store.savePaper(state.paper);
  }
  toast(action === 'sell' ? `Paper trade: sold ${p.symbol}` : trail ? `Paper trade: ${p.symbol} now trails its stop from ${formatMoney(stop)}` : lock ? `Paper trade: ${p.symbol} now sells at ${formatMoney(take)} with a profit lock` : `Paper trade: ${p.symbol} now sells at ${formatMoney(stop)} or ${formatMoney(take)}`);
  renderPaper({ force: true });
}

const signed = v => `${v >= 0 ? '+' : '−'}${formatMoney(Math.abs(v))}`;
// What a closed trade cost; older trades didn't keep it.
const costOf = t => (Number.isFinite(t.cost) ? t.cost : t.ret ? t.pnl / t.ret : t.qty * t.entry);
const fmtQty = p => `${Number(p.qty.toPrecision(4))} ${p.type === 'crypto' ? 'coins' : p.qty === 1 ? 'share' : 'shares'}`;

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
  for (const c of children.flat()) if (c) node.append(c);
  return node;
}

// The account's value over time against what it started with: green above, red below.
// A grey line shows the same account without the trade filter, from when it began.
// `bare`: just the chart and its note, to sit inside another card.
// With gainOf, the line is that kind's running gain/loss over the starting amount.
function equityChart(acc, now, shadow, { bare = false, gainOf = null } = {}) {
  const pts = [...acc.history.map(h => ({ t: h.t, v: h.equity })), { t: Date.now(), v: now }]
    .filter(p => Number.isFinite(p.v) && p.t >= acc.createdAt - 60_000);
  if (pts.length < 2) return null;
  const spts = shadow ? shadow.history.map(h => ({ t: h.t, v: h.equity })).filter(p => Number.isFinite(p.v) && p.t >= pts[0].t) : [];
  const W = 600, H = 170, padL = 4, padR = 4, padT = 10, padB = 22;
  const t0 = pts[0].t, t1 = pts.at(-1).t;
  const vs = [...pts.map(p => p.v), ...spts.map(p => p.v), acc.start];
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = Math.max((hi - lo) * 0.1, acc.start * 0.002);
  lo -= pad; hi += pad;
  const x = t => padL + (t1 > t0 ? (t - t0) / (t1 - t0) : 1) * (W - padL - padR);
  const y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const path = list => list.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const line = path(pts);
  const base = y(acc.start);
  const area = `${line}L${x(t1).toFixed(1)},${base.toFixed(1)}L${x(t0).toFixed(1)},${base.toFixed(1)}Z`;
  const id = `eq${Math.random().toString(36).slice(2, 8)}`;
  const day = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const change = now - acc.start;
  // Touch or drag on the graph: a line and a dot at that moment, with its time
  // and value (and the grey line's) above the graph. Letting go shows now again.
  const at = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const valueLine = (label, v, sv) => gainOf ? `${label} · ${signed(v - acc.start)}` : `${label} · ${formatMoney(v)} · ${fmtPct((v - acc.start) / acc.start)}${Number.isFinite(sv) ? ` · without filter ${formatMoney(sv)}` : ''}`;
  const nearest = (list, t) => list.reduce((a, p) => (Math.abs(p.t - t) < Math.abs(a.t - t) ? p : a), list[0]);
  const shadowNow = spts.length > 1 ? spts.at(-1).v : NaN;
  const readout = el('div', { class: 'eq-readout small', text: valueLine('Now', now, shadowNow) });
  const cursor = svg('line', { y1: padT, y2: H - padB, stroke: 'var(--muted)', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svg('circle', { r: 5, fill: 'var(--text)', visibility: 'hidden' });
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'equity-chart', role: 'img', 'aria-label': gainOf ? `Running ${gainOf} gain/loss, now ${signed(now - acc.start)}` : `Account value from ${formatMoney(acc.start)} to ${formatMoney(now)}` },
      svg('defs', {},
        svg('clipPath', { id: `${id}a` }, svg('rect', { x: 0, y: 0, width: W, height: base })),
        svg('clipPath', { id: `${id}b` }, svg('rect', { x: 0, y: base, width: W, height: H - base }))),
      svg('path', { d: area, fill: 'var(--up)', 'fill-opacity': 0.15, 'clip-path': `url(#${id}a)` }),
      svg('path', { d: area, fill: 'var(--down)', 'fill-opacity': 0.15, 'clip-path': `url(#${id}b)` }),
      svg('line', { x1: padL, x2: W - padR, y1: base, y2: base, stroke: 'var(--muted)', 'stroke-dasharray': '4 4', 'stroke-width': 1 }),
      svg('path', { d: line, fill: 'none', stroke: 'var(--up)', 'stroke-width': 2, 'clip-path': `url(#${id}a)` }),
      svg('path', { d: line, fill: 'none', stroke: 'var(--down)', 'stroke-width': 2, 'clip-path': `url(#${id}b)` }),
      spts.length > 1 ? svg('path', { d: path(spts), fill: 'none', stroke: 'var(--muted)', 'stroke-width': 1.5, 'stroke-dasharray': '6 3' }) : null,
      svg('text', { x: padL, y: H - 6, fill: 'var(--muted)', 'font-size': 20 }, day(t0)),
      svg('text', { x: W - padR, y: H - 6, fill: 'var(--muted)', 'font-size': 20, 'text-anchor': 'end' }, 'now'),
      cursor, dot);
  const show = e => {
    const box = chart.getBoundingClientRect();
    if (!box.width) return;
    const sx = ((e.clientX - box.left) / box.width) * W;
    const t = t0 + Math.min(1, Math.max(0, (sx - padL) / (W - padL - padR))) * (t1 - t0);
    const p = nearest(pts, t);
    const sp = spts.length > 1 && t >= spts[0].t ? nearest(spts, t).v : NaN;
    for (const [k, v] of [['x1', x(p.t)], ['x2', x(p.t)]]) cursor.setAttribute(k, v.toFixed(1));
    dot.setAttribute('cx', x(p.t).toFixed(1));
    dot.setAttribute('cy', y(p.v).toFixed(1));
    cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('visibility', 'visible');
    readout.textContent = valueLine(p === pts.at(-1) ? 'Now' : at(p.t), p.v, sp);
  };
  const hide = () => {
    cursor.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    readout.textContent = valueLine('Now', now, shadowNow);
  };
  chart.addEventListener('pointerdown', e => { chart.setPointerCapture(e.pointerId); show(e); });
  chart.addEventListener('pointermove', e => { if (e.pointerType === 'mouse' || chart.hasPointerCapture(e.pointerId)) show(e); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) chart.addEventListener(ev, hide);
  return el('div', { class: bare ? 'equity-in' : 'card' },
    bare ? null : el('div', { class: 'signal-top' },
      el('h3', { text: 'Account value' }),
      el('span', { class: changeClass(change), text: `${signed(change)} (${fmtPct(change / acc.start)})` })),
    readout,
    chart,
    el('p', { class: 'muted small', text: gainOf ? 'Dashed line: no gain or loss. The line steps as trades close; its end adds the open ones at today\'s price.' : `Dashed line: the ${formatMoney(acc.start)} you started with.${spts.length > 1 ? ' Grey line: the same account without the trade filter.' : ''}` }));
}

// The filtered account against the same account without the filter, on the
// trades both opened since the comparison began.
function filterTrialCard(sp) {
  const t = sp.filterTrial;
  if (!t || !sp.shadow) return null;
  const since = new Date(t.since).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const prices = sp.prices || {};
  const status = t.result === 'ahead'
    ? 'The filter has proved itself: ready to let it choose stops and targets.'
    : t.result === 'behind'
      ? 'The filter did worse than trading without it, so it is switched off. Starting the paper account over gives it a new trial.'
      : t.judged
        ? `Testing: ${t.judged} of the ${t.need} closed trades it needs before it is judged.`
        : 'Waiting for its first trades. It has a say only once it has passed its own test on your server.';
  const line = (name, trades, pnl, acc) => el('tr', {},
    el('td', { text: name }),
    el('td', { text: String(trades) }),
    el('td', { class: upDown(pnl), text: signed(pnl) }),
    el('td', { text: formatMoney(paper.equity(acc, prices)) }));
  return el('div', { class: 'card' },
    el('h3', { text: 'Trade filter' }),
    el('p', { class: t.result === 'ahead' ? 'small good' : 'small', text: status }),
    el('div', { class: 'table-wrap' }, el('table', { class: 'setups' },
      el('thead', {}, el('tr', {}, ...['Account', 'Closed trades', `Gain/loss since ${since}`, 'Value now'].map(h => el('th', { text: h })))),
      el('tbody', {},
        line('With the filter', t.trades, t.pnl, sp.paper),
        line('Without it', t.shadowTrades, t.shadowPnl, sp.shadow)))),
    el('p', { class: 'muted small', text: `Both accounts take the same ideas; the one without the filter buys every one, the same size as before. After ${t.need} closed trades the filter had a say on, it stays on only if it is ahead.` }));
}

// Each open trade's gain or loss in dollars, biggest first.
// In the order given, so the bars match the list under them.
function pnlBars(rows) {
  if (!rows.length) return null;
  const sorted = rows;
  const max = Math.max(...sorted.map(r => Math.abs(r.pnl)), 0.01);
  return el('div', { class: 'card pnl-bars' },
    el('h3', { text: 'Gain or loss on each open trade' }),
    el('p', { class: 'muted small', text: 'Tap a bar to open that trade.' }),
    ...sorted.map(r => el('div', { class: 'pnl-row', role: 'button', tabindex: '0', onclick: () => showPaperTrade(r.p.key) },
      el('span', { class: 'pnl-sym', text: r.p.symbol }),
      el('span', { class: 'pnl-track' },
        el('span', { class: `pnl-fill ${r.pnl >= 0 ? 'up' : 'down'}`, style: `width:${(Math.abs(r.pnl) / max * 50).toFixed(1)}%` })),
      el('span', { class: `pnl-val ${upDown(r.pnl)}`, text: `${signed(r.pnl)} (${fmtPct(r.ret)})` }))));
}

// Opens one open trade's card and scrolls to it.
function showPaperTrade(key) {
  const id = `paper:${key}`;
  state.openCards.add(id);
  state.paperSource = 'all';
  renderPaper({ force: true });
  const card = [...document.querySelectorAll('#paper-body [data-card]')].find(c => c.dataset.card === id);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Trades, win rate, return and worst drop for each way the account trades.
function bySetupTable(acc, budgets) {
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
    el('p', { class: 'muted small', text: 'Return is on the starting amount. Opportunity trades sell at their stop, their target or the end of their holding period.' }),
    budgets && budgets.shares ? el('p', { class: 'muted small', text: `Share of the account each source can use (one trade gets up to a fifth of it, up to 10 trades): ${Object.entries(paper.BUDGETS).map(([k, b]) => `${b.name} ${Math.round((budgets.shares[k] ?? b.share) * 100)}%`).join(', ')}. Once two sources have 50 closed trades, the one with the best average trade takes up to 5 points a week from the worst, within 10% to 50%.` }) : null);
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

// The line under each folded Settings section: what it is set to now.
function renderSettingsSummaries() {
  const s = state.settings;
  const tfName = tf => ({ '15m': '15 min', '1h': '1 hour', '1D': '1 day', '1W': '1 week' })[tf] || tf;
  const st = state.serverStatus;
  const server = $('sum-server');
  server.textContent = !serverOn() ? 'Not connected'
    : !st ? 'Checking…'
    : st.error ? 'Can\'t reach it'
    : `Connected · v${st.version} · alerts ${s.serverPush ? 'on' : 'off'}`;
  server.className = `set-sum ${!serverOn() || (st && st.error) ? 'bad' : st ? 'good' : ''}`;
  $('sum-signals').textContent = [`${tfName(s.alertTf)} chart`, autoTune(s) ? 'Auto levels' : `Buy ${s.buyAt}, sell ${s.sellAt}`,
    s.notifications && canNotify() ? 'notifications on' : 'notifications off', s.quietHours ? 'quiet hours' : null].filter(Boolean).join(' · ');
  const ids = Object.keys(SETUPS);
  const on = ids.filter(id => (s.setups || {})[id] !== false).length;
  const muted = ((state.market && state.market.setupsInfo) || {}).muted || [];
  $('sum-setups').textContent = `${on} of ${ids.length} on${muted.length ? ` · ${muted.length} muted` : ''}`;
  const exits = { target: 'sells at target', trail: 'trailing stop', lock: 'profit lock' };
  $('sum-paper').textContent = [formatMoney(s.paperStart), `${s.riskPct}% risk`, `stop ${s.stopAtr}, target ${s.takeAtr} ATR`, exits[s.paperExit] || exits.target, s.tradeFilter !== false ? 'filter on' : 'filter off'].join(' · ');
  const mode = ['off', 'dry', 'live'].includes(s.ndaxMode) ? s.ndaxMode : 'off';
  const modeName = { off: 'Off', dry: 'Dry run', live: 'Live' }[mode];
  const nd = state.ndax;
  const [ndText, ndTone] = !serverOn() ? ['Needs your server', '']
    : !nd ? [`Checking… · ${modeName}`, '']
    : nd.error ? ['Can\'t reach your server', 'bad']
    : !nd.configured ? [`Key not set · ${modeName}`, 'bad']
    : nd.balanceError ? ['NDAX refused the key', 'bad']
    : [`Connected · $${Number((nd.balance || {}).CAD || 0).toFixed(2)} CAD cash · ${modeName}`, 'good'];
  $('sum-ndax').textContent = ndText;
  $('sum-ndax').className = `set-sum ${ndTone}`;
  for (const b of document.querySelectorAll('#ndax-mode-btns button')) b.classList.toggle('on', b.dataset.mode === mode);
  const ibMode = s.ibkrMode === 'paper' ? 'paper' : 'off';
  const ib = state.ibkr;
  const acct = ib && ib.account;
  const [ibText, ibTone] = !serverOn() ? ['Needs your server', '']
    : !ib ? [`Checking… · ${ibMode === 'paper' ? 'Paper' : 'Off'}`, '']
    : ib.fetchError ? [/404|Not Found/.test(ib.fetchError) ? 'Update your server' : 'Can\'t reach your server', 'bad']
    : !ib.configured ? ['Gateway not set up', '']
    : ib.error || !acct ? ['Gateway not answering', 'bad']
    : [`Connected · ${acct.paper ? 'paper' : 'live'} ${acct.id}${Number.isFinite(acct.available) ? ` · ${formatMoney(acct.available)} ${acct.currency || ''}` : ''} · ${ibMode === 'paper' ? 'Paper' : 'Off'}`, acct.paper ? 'good' : 'warn'];
  $('sum-ibkr').textContent = ibText;
  $('sum-ibkr').className = `set-sum ${ibTone}`;
  for (const b of document.querySelectorAll('#ibkr-mode-btns button')) b.classList.toggle('on', b.dataset.mode === ibMode);
  $('sum-display').textContent = `Charts open on ${tfName(s.timeframe || '1D')}${s.showCad ? ' · CAD shown' : ''}`;
  $('sum-data').textContent = `${s.twelveKey ? 'Stock key saved' : 'No stock key'} · backup`;
}

// NDAX: your cash there, what is really held and the latest orders.
async function renderNdax() {
  const box = $('ndax-body');
  if (!serverOn()) {
    box.replaceChildren(el('p', { class: 'muted small', text: 'Connect your server below first; it places the orders.' }));
    return;
  }
  let r;
  try {
    r = await srv.serverFetch(state.settings, '/ndax');
    state.ndax = r;
  } catch (e) {
    state.ndax = { error: e.message };
    renderSettingsSummaries();
    box.replaceChildren(el('p', { class: 'muted small', text: /404|Not Found/.test(e.message) ? 'Update your server to use NDAX.' : `Couldn't reach your server: ${e.message}` }));
    return;
  }
  renderSettingsSummaries();
  const fmtCad = v => `$${Number(v).toFixed(2)} CAD`;
  const orders = r.orders || [];
  const held = Object.entries(r.positions || {});
  // The latest buy of each coin still held gets the Held tag.
  const heldBuy = new Map();
  for (const [key, p] of held) {
    const i = orders.findIndex(o => o.side === 'buy' && o.key === key && ['dry', 'filled'].includes(o.status) && (!p.at || o.at <= p.at + 60_000));
    if (i >= 0) heldBuy.set(i, p);
  }
  const unlisted = held.filter(([, p]) => ![...heldBuy.values()].includes(p));
  const word = { dry: 'Dry run', filled: 'Filled', failed: 'Failed', skipped: 'Skipped' };
  box.replaceChildren(...[
    // The cash shows on the section's folded line; only a key problem needs words here.
    !r.configured || r.balanceError ? el('p', { class: 'small', text: !r.configured
      ? 'The NDAX key is not set on your server yet (NDAX_API_KEY, NDAX_API_SECRET and NDAX_USER_ID). A dry run still works without it.'
      : `Key set, but NDAX refused it: ${r.balanceError}` }) : null,
    el('p', { class: 'muted small', text: `${r.coins ? `${r.coins} coins sold for CAD on NDAX; crypto paper trades buy only these.` : 'NDAX\'s coin list has not loaded yet.'}${r.lossToday ? ` Live losses today: ${fmtCad(r.lossToday)}.` : ''}` }),
    // Held coins are tagged on their buy below; any whose buy is no longer in the list show here.
    unlisted.length ? el('div', { class: 'sub', text: `Also held: ${unlisted.map(([, p]) => `${p.symbol} ${fmtCad(p.cad)}${p.mode === 'dry' ? ' (dry run)' : ''}`).join(', ')}` }) : null,
    orders.length ? el('ul', { class: 'list' }, ...orders.map((o, i) => foldCard('holding', `ndax:${o.at}:${i}`, [
      el('div', {},
        el('div', { class: 'sym' }, el('span', { class: `latest-kind ${o.side === 'buy' ? 'good' : 'bad'}`, text: o.side === 'buy' ? 'Buy' : 'Sell' }), o.symbol,
          el('span', { class: 'badge', text: word[o.status] || o.status }),
          heldBuy.has(i) ? el('span', { class: 'badge held', text: 'Held' }) : null),
        el('div', { class: 'sub', text: new Date(o.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })),
      el('div', { class: `paper-gain ${o.side === 'sell' ? upDown(o.pnl) : ''}`, text: o.side === 'sell' && Number.isFinite(o.pnl) ? signed(o.pnl) : Number.isFinite(o.cad) ? fmtCad(o.cad) : '–' }),
    ], [
      Number.isFinite(o.qty) ? el('dl', { class: 'money-row' },
        stat('Quantity', `${Number(o.qty.toPrecision(6))}`),
        stat('Price', Number.isFinite(o.price) ? fmtCad(o.price) : '–'),
        stat('Fee', Number.isFinite(o.fee) ? fmtCad(o.fee) : '–')) : null,
      el('div', { class: 'sub', text: `${o.mode === 'live' ? 'Sent to NDAX' : 'Dry run, not sent'}${o.reason ? ` · ${o.reason}` : ''}${o.id ? ` · order ${o.id}` : ''}` }),
      o.error ? el('div', { class: 'sub', text: o.error }) : null,
    ], () => { const item = findItem(o.key); if (item) openChart(item, true); }))) : el('p', { class: 'muted small', text: 'No real or dry-run orders yet.' }),
  ].filter(Boolean));
}

// IBKR: the account IB Gateway is logged in to, what is held and the latest orders.
async function renderIbkr() {
  const box = $('ibkr-body');
  if (!serverOn()) {
    box.replaceChildren(el('p', { class: 'muted small', text: 'Connect your server first; it places the orders.' }));
    return;
  }
  let r;
  try {
    r = await srv.serverFetch(state.settings, '/ibkr');
    state.ibkr = r;
  } catch (e) {
    state.ibkr = { fetchError: e.message };
    renderSettingsSummaries();
    box.replaceChildren(el('p', { class: 'muted small', text: /404|Not Found/.test(e.message) ? 'Update your server to use IBKR.' : `Couldn't reach your server: ${e.message}` }));
    return;
  }
  renderSettingsSummaries();
  const orders = r.orders || [];
  const held = Object.entries(r.positions || {});
  const heldBuy = new Map();
  for (const [key, p] of held) {
    const i = orders.findIndex(o => o.side === 'buy' && o.key === key && ['filled', 'working'].includes(o.status) && (!p.at || o.at <= p.at + 60_000));
    if (i >= 0) heldBuy.set(i, p);
  }
  const unlisted = held.filter(([, p]) => ![...heldBuy.values()].includes(p));
  const word = { filled: 'Filled', working: 'Waiting for the open', failed: 'Failed', skipped: 'Skipped' };
  const acct = r.account;
  box.replaceChildren(...[
    !r.configured ? el('p', { class: 'small', text: 'IB Gateway is not set up on your server yet (the ib-gateway service and IBKR_HOST; see the server README).' })
      : r.error ? el('p', { class: 'small', text: `IB Gateway didn't answer: ${r.error}` })
      : acct && !acct.paper ? el('p', { class: 'small warn', text: `The gateway is logged in to live account ${acct.id}. Paper mode sends nothing to it.` }) : null,
    r.lossToday ? el('p', { class: 'muted small', text: `Losses today: ${formatMoney(r.lossToday)}.` }) : null,
    unlisted.length ? el('div', { class: 'sub', text: `Also held: ${unlisted.map(([, p]) => `${p.symbol} ${p.qty} shares`).join(', ')}` }) : null,
    orders.length ? el('ul', { class: 'list' }, ...orders.map((o, i) => foldCard('holding', `ibkr:${o.at}:${i}`, [
      el('div', {},
        el('div', { class: 'sym' }, el('span', { class: `latest-kind ${o.side === 'buy' ? 'good' : 'bad'}`, text: o.side === 'buy' ? 'Buy' : 'Sell' }), o.symbol,
          el('span', { class: 'badge', text: word[o.status] || o.status }),
          heldBuy.has(i) ? el('span', { class: 'badge held', text: 'Held' }) : null),
        el('div', { class: 'sub', text: new Date(o.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) })),
      el('div', { class: `paper-gain ${o.side === 'sell' ? upDown(o.pnl) : ''}`, text: o.side === 'sell' && Number.isFinite(o.pnl) ? signed(o.pnl) : Number.isFinite(o.usd) ? formatMoney(o.usd) : '–' }),
    ], [
      Number.isFinite(o.qty) ? el('dl', { class: 'money-row' },
        stat('Shares', String(o.qty)),
        stat('Price', o.price > 0 ? formatMoney(o.price) : '–'),
        stat('Fee', Number.isFinite(o.fee) ? formatMoney(o.fee) : '–')) : null,
      el('div', { class: 'sub', text: `Sent to IBKR (${o.mode})${o.reason ? ` · ${o.reason}` : ''}${o.id ? ` · order ${o.id}` : ''}` }),
      o.error ? el('div', { class: 'sub', text: o.error }) : null,
    ], () => { const item = findItem(o.key); if (item) openChart(item, true); }))) : el('p', { class: 'muted small', text: 'No IBKR orders yet.' }),
  ].filter(Boolean));
}

function renderSettings() {
  $('key-input').value = state.settings.twelveKey;
  $('tf-default').value = state.settings.timeframe;
  $('cad-toggle').checked = state.settings.showCad;
  $('fx-status').textContent = state.fx
    ? `1 USD = ${state.fx.rate.toFixed(4)} CAD (${state.fx.source}, ${timeAgo(state.fx.at)})`
    : 'USD to CAD rate not loaded yet.';
  $('version').textContent = `Version ${APP_VERSION} · data in ${store.backend()}`;
  $('alert-tf').value = state.settings.alertTf;
  $('buy-at').value = state.settings.buyAt;
  $('sell-at').value = -state.settings.sellAt;
  $('tune-mode').value = autoTune(state.settings) ? 'auto' : 'manual';
  $('signal-mode').value = state.settings.mode === 'dip' ? 'dip' : 'standard';
  $('manual-levels').hidden = autoTune(state.settings);
  $('tune-note').textContent = autoTune(state.settings)
    ? 'Each symbol gets the buy and sell levels, and the way of reading the score (standard or buying the dip in an uptrend), that did best on its older history. Each signal shows how they did on newer candles they never saw.'
    : 'Every symbol uses the levels and the way of reading the score you set below.';
  $('quiet-toggle').checked = state.settings.quietHours;
  $('stop-atr').value = state.settings.stopAtr;
  $('take-atr').value = state.settings.takeAtr;
  $('risk-pct').value = state.settings.riskPct;
  $('paper-start').value = state.settings.paperStart;
  $('filter-toggle').checked = state.settings.tradeFilter !== false;
  $('paper-exit').value = ['trail', 'lock'].includes(state.settings.paperExit) ? state.settings.paperExit : 'target';
  $('ndax-mode').value = ['off', 'dry', 'live'].includes(state.settings.ndaxMode) ? state.settings.ndaxMode : 'off';
  $('ndax-budget').value = state.settings.ndaxBudget;
  $('ndax-max').value = state.settings.ndaxMaxTrade;
  $('ndax-loss').value = state.settings.ndaxDailyLoss;
  renderNdax();
  $('ibkr-budget').value = state.settings.ibkrBudget;
  $('ibkr-max').value = state.settings.ibkrMaxTrade;
  $('ibkr-loss').value = state.settings.ibkrDailyLoss;
  renderIbkr();
  $('server-url').value = state.settings.serverUrl;
  $('server-key').value = state.settings.serverKey;
  renderNotifyStatus();
  renderSetupSettings();
  renderServer();
  renderSettingsSummaries();
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
  $('notify-btn').checked = !!on;
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
  $('signals-info').addEventListener('click', e => {
    const notice = $('signals-notice');
    notice.hidden = !notice.hidden;
    e.currentTarget.setAttribute('aria-expanded', String(!notice.hidden));
  });
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
  $('notify-btn').addEventListener('change', toggleNotifications);
  $('quiet-toggle').addEventListener('change', e => { state.settings = store.saveSettings({ quietHours: e.target.checked }); markChanged(); });
  $('filter-toggle').addEventListener('change', e => {
    state.settings = store.saveSettings({ tradeFilter: e.target.checked });
    markChanged();
    $('risk-status').textContent = 'Saved. The paper account uses it from the next check.';
  });
  $('paper-exit').addEventListener('change', e => {
    state.settings = store.saveSettings({ paperExit: ['trail', 'lock'].includes(e.target.value) ? e.target.value : 'target' });
    markChanged();
    $('risk-status').textContent = 'Saved. New paper trades use it; open ones keep theirs (change them on the Paper tab).';
  });
  $('ndax-mode').addEventListener('change', e => {
    const mode = e.target.value;
    if (mode === 'live' && !confirm('Live sends real orders to NDAX with your money, following the paper account\'s crypto trades. Continue?')) {
      e.target.value = state.settings.ndaxMode || 'off';
      renderSettingsSummaries();
      return;
    }
    state.settings = store.saveSettings({ ndaxMode: mode });
    markChanged();
    $('ndax-status').textContent = mode === 'off' ? 'Off. No new real buys; coins already bought are still sold with the paper trade.'
      : mode === 'dry' ? 'Dry run. The next crypto paper trades show here as the orders they would be.'
      : 'Live. The next crypto paper trades are sent to NDAX.';
  });
  $('ndax-save').addEventListener('click', () => {
    const budget = Number($('ndax-budget').value), max = Number($('ndax-max').value), loss = Number($('ndax-loss').value);
    if (![budget, max, loss].every(v => Number.isFinite(v) && v >= 0)) {
      $('ndax-status').textContent = 'Enter amounts of 0 or more.';
      return;
    }
    state.settings = store.saveSettings({ ndaxBudget: budget, ndaxMaxTrade: max, ndaxDailyLoss: loss });
    markChanged();
    $('ndax-status').textContent = 'Saved. New real orders use these limits.';
  });
  for (const b of document.querySelectorAll('#ibkr-mode-btns button')) b.addEventListener('click', () => {
    const mode = b.dataset.mode === 'paper' ? 'paper' : 'off';
    state.settings = store.saveSettings({ ibkrMode: mode });
    markChanged();
    renderSettingsSummaries();
    $('ibkr-status').textContent = mode === 'off' ? 'Off. No new IBKR buys; shares already bought are still sold with the paper trade.'
      : 'Paper. The next stock paper trades are sent to your IBKR paper account.';
  });
  $('ibkr-save').addEventListener('click', () => {
    const budget = Number($('ibkr-budget').value), max = Number($('ibkr-max').value), loss = Number($('ibkr-loss').value);
    if (![budget, max, loss].every(v => Number.isFinite(v) && v >= 0)) {
      $('ibkr-status').textContent = 'Enter amounts of 0 or more.';
      return;
    }
    state.settings = store.saveSettings({ ibkrBudget: budget, ibkrMaxTrade: max, ibkrDailyLoss: loss });
    markChanged();
    $('ibkr-status').textContent = 'Saved. New IBKR orders use these limits.';
  });
  $('server-save').addEventListener('click', saveServer);
  $('server-push').addEventListener('change', toggleServerPush);
  for (const b of document.querySelectorAll('#ndax-mode-btns button')) b.addEventListener('click', () => {
    $('ndax-mode').value = b.dataset.mode;
    $('ndax-mode').dispatchEvent(new Event('change'));
  });
  // ⓘ buttons show or hide the longer explanation they point to.
  for (const b of document.querySelectorAll('#view-settings .info-btn[data-info]')) b.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    const box = $(b.dataset.info);
    box.hidden = !box.hidden;
    b.setAttribute('aria-expanded', String(!box.hidden));
  });
  // Every change in Settings refreshes the one-line summaries on the folded sections.
  $('view-settings').addEventListener('change', () => setTimeout(renderSettingsSummaries, 0));
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
