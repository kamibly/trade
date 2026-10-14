import { TIMEFRAMES, isIntraday, changeOverDay } from './candles.js';
import { formatMoney, formatChange, priceDecimals, toCad, timeAgo } from './format.js';
import * as store from './storage.js';
import {
  fetchCandles, fetchQuotes, fetchCryptoTop, fetchUsdCad, checkStock, checkTwelveKey, twelveLimiter,
} from './data.js';
import { PriceChart } from './chart.js';

export const APP_VERSION = '0.1.0 (stage 1)';

const QUOTE_REFRESH_MS = 60_000;
// Stock quotes cost one Twelve Data credit each (8 a minute free), so they
// refresh less often than crypto and leave room for charts.
const STOCK_REFRESH_MS = 5 * 60_000;
const FX_MAX_AGE_MS = 12 * 3600_000;
const TOP_MAX_AGE_MS = 24 * 3600_000;

const $ = id => document.getElementById(id);

const state = {
  view: 'watch',
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

// ---- Views ------------------------------------------------------------------

const TITLES = { watch: 'Watchlist', chart: 'Chart', settings: 'Settings' };

function showView(view) {
  if (!TITLES[view]) view = 'watch';
  state.view = view;
  for (const v of Object.keys(TITLES)) $(`view-${v}`).hidden = v !== view;
  for (const b of document.querySelectorAll('.tabbar button')) b.classList.toggle('on', b.dataset.view === view);
  $('title').textContent = TITLES[view];
  if (view === 'chart') openChart();
  if (view === 'settings') renderSettings();
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
    const fresh = await fetchQuotes(state.watchlist, state.settings, { withStocks });
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
    let item;
    if (state.addType === 'stock') {
      if (!state.settings.twelveKey) throw new Error('Add your Twelve Data key in Settings first.');
      const name = await checkStock(symbol, state.settings.twelveKey);
      item = { type: 'stock', symbol, name };
    } else {
      const top = await loadCryptoTop().catch(() => []);
      const known = top.find(c => c.symbol === symbol);
      // Coins outside the top list still work through Coinbase or Kraken.
      item = known ? { ...known } : { type: 'crypto', symbol, name: symbol };
    }
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
  };

  const saved = store.getCandles(item, tf);
  if (saved && saved.candles.length) draw(saved.candles);
  else { state.chartCandles = []; chart.clear(); renderChartHead(); }

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
  showList('Open chart', state.watchlist.map(item => el('li', {
    onclick: () => { $('list-dialog').close(); openChart(item); },
  }, el('div', { class: 'info' }, el('div', { class: 'sym', text: item.symbol }), el('div', { class: 'name', text: item.name || '' })))));
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
    status.textContent = `Restored ${count} symbols and your settings.`;
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
    if (state.view === 'chart' && isIntraday(state.chartTf)) loadChart();
  }, QUOTE_REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshQuotes(); });
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
  showView(location.hash.slice(1) || 'watch');
  refreshQuotes();
  if (state.settings.showCad) refreshFx();
  registerServiceWorker();
}

start();
