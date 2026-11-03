// The Bitcoin lead check (plan step 4): does Bitcoin's move while the stock
// market is closed tell us how crypto-linked stocks do once it opens?
//
// For each trading day over the last two years:
//   btc   = Bitcoin's move from the previous stock close (16:00 New York) to
//           09:00 New York, half an hour before the open (weekends included);
//   gap   = the stock's open against its previous close (already in the price
//           by the time anyone can buy);
//   day   = the stock's close against its open (what a Buy at the open gets).
// A link we could trade shows in `day`, not in `gap`. Per stock it reports
// the correlations, the hit rate of "go with Bitcoin" on days it moved more
// than 1% (against chance), the average day after big Bitcoin moves, and both
// halves of the period apart, so a link that only held once doesn't pass.
//
// Run on the server (it needs Yahoo Finance, like the scans):
//   docker exec trade-service node btc_lead.mjs
// It prints a table and saves DATA_DIR/research/btc-lead.json.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fromYahoo } from './js/candles.js';
import { fallbackFetch, proxiedFetch } from './proxy.mjs';

export const LINKED = ['COIN', 'HOOD', 'GLXY', 'MSTR', 'XYZ', 'MARA', 'RIOT', 'CLSK', 'CORZ', 'HUT', 'CIFR', 'WULF', 'IREN', 'BITF', 'BTBT', 'IBIT', 'FBTC'];
export const MARKET = ['SPY'];
const BIG = 0.02;    // a "big" Bitcoin move for the averages
const MOVED = 0.01;  // days Bitcoin moved at least this much count for the hit rate
const EDGE = 0.03;   // the hit rate must beat chance by this much
const MIN_DAYS = 120;

// ---- New York time --------------------------------------------------------

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function nyParts(t) {
  const p = Object.fromEntries(NY.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
// Seconds since 1970 of a New York wall time (date 'YYYY-MM-DD', hour, minute).
export function nyTime(date, hour, minute = 0) {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour, minute) / 1000;
  for (const off of [4, 5]) {
    const t = guess + off * 3600;
    const p = nyParts(t);
    if (p.date === date && p.hour === hour && p.minute === minute) return t;
  }
  return guess + 5 * 3600;
}
export const nyDate = t => nyParts(t).date;

// ---- The numbers ----------------------------------------------------------

// Bitcoin's price at time t: the close of the last hourly candle ending by t.
function priceAt(hours, t) {
  let lo = 0, hi = hours.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hours[mid].time + 3600 <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // Too stale (a gap in the data) counts as missing.
  return best >= 0 && t - (hours[best].time + 3600) < 3 * 3600 ? hours[best].close : NaN;
}

// One row per trading day: { date, btc, gap, day }.
export function dayRows(daily, btcHours) {
  const rows = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1], cur = daily[i];
    if (!(prev.close > 0 && cur.open > 0 && cur.close > 0)) continue;
    const date = nyDate(cur.time);
    const from = priceAt(btcHours, nyTime(nyDate(prev.time), 16));
    const to = priceAt(btcHours, nyTime(date, 9));
    if (!(from > 0 && to > 0)) continue;
    rows.push({ date, btc: to / from - 1, gap: cur.open / prev.close - 1, day: cur.close / cur.open - 1 });
  }
  return rows;
}

function corr(xs, ys) {
  const n = xs.length;
  if (n < 3) return { r: 0, t: 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
  return { r, t: r * Math.sqrt((n - 2) / Math.max(1e-12, 1 - r * r)) };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

// "Go with Bitcoin": on days it moved more than MOVED, the stock's day goes its way.
// Chance: how often that would happen if the two were unrelated.
function hits(rows) {
  const moved = rows.filter(r => Math.abs(r.btc) >= MOVED && r.day !== 0);
  if (!moved.length) return { n: 0, hit: NaN, chance: NaN };
  const up = moved.filter(r => r.day > 0).length / moved.length;
  const btcUp = moved.filter(r => r.btc > 0).length / moved.length;
  return {
    n: moved.length,
    hit: moved.filter(r => Math.sign(r.btc) === Math.sign(r.day)).length / moved.length,
    chance: btcUp * up + (1 - btcUp) * (1 - up),
  };
}

export function measure(rows) {
  const half = Math.floor(rows.length / 2);
  const part = rs => ({ day: corr(rs.map(r => r.btc), rs.map(r => r.day)), ...hits(rs) });
  const all = part(rows);
  const first = part(rows.slice(0, half)), second = part(rows.slice(half));
  const out = {
    days: rows.length,
    from: rows[0] && rows[0].date, to: rows.length ? rows[rows.length - 1].date : null,
    gap: corr(rows.map(r => r.btc), rows.map(r => r.gap)),
    day: all.day,
    hit: all.hit, chance: all.chance, movedDays: all.n,
    afterBigUp: mean(rows.filter(r => r.btc >= BIG).map(r => r.day)),
    afterBigDown: mean(rows.filter(r => r.btc <= -BIG).map(r => r.day)),
    halves: [first, second].map(h => ({ r: h.day.r, hit: h.hit, chance: h.chance })),
  };
  // A link worth adding: significant on the day after the open, the same way in
  // both halves, and "go with Bitcoin" beats chance by EDGE overall and in each half.
  const beats = h => h.hit - h.chance >= EDGE;
  out.passes = rows.length >= MIN_DAYS && Math.abs(out.day.t) >= 2
    && Math.sign(first.day.r) === Math.sign(second.day.r) && Math.sign(first.day.r) === Math.sign(out.day.r)
    && beats(all) && beats(first) && beats(second);
  out.why = rows.length < MIN_DAYS ? `only ${rows.length} days`
    : out.passes ? 'passes'
    : Math.abs(out.gap.r) >= 0.3 && Math.abs(out.day.t) < 2 ? 'the move is already in the opening price'
    : Math.abs(out.day.t) < 2 ? 'no clear link after the open'
    : Math.sign(first.day.r) !== Math.sign(second.day.r) ? 'the link flips between the two years'
    : 'going with Bitcoin does not beat chance by 3 points in both years';
  return out;
}

// ---- Fetching -----------------------------------------------------------

const BROWSER = { 'User-Agent': 'Mozilla/5.0 (compatible; trade-service)', Accept: 'application/json' };
async function yahoo(fetchFn, symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetchFn(url, { headers: BROWSER, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Yahoo Finance answered ${res.status} for ${symbol}`);
  return fromYahoo(await res.json());
}

function serverFetch() {
  if (!process.env.STOCK_PROXY) return fetch;
  const file = join(process.env.DATA_DIR || '/data', 'stock-proxy-until');
  const store = { get: async () => Number(await readFile(file, 'utf8').catch(() => 0)) || 0, set: async until => { await writeFile(file, String(until)).catch(() => {}); } };
  return fallbackFetch(fetch, proxiedFetch(process.env.STOCK_PROXY), { store });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runCheck({ fetchFn = serverFetch(), symbols = [...LINKED, ...MARKET], pause = 1500, log = () => {} } = {}) {
  const btc = await yahoo(fetchFn, 'BTC-USD', '60m', '730d');
  const results = {};
  const errors = {};
  for (const symbol of symbols) {
    try {
      await sleep(pause);
      results[symbol] = measure(dayRows(await yahoo(fetchFn, symbol, '1d', '2y'), btc));
      log(symbol);
    } catch (e) {
      errors[symbol] = e.message;
    }
  }
  const linked = Object.entries(results).filter(([s]) => LINKED.includes(s));
  return { at: Date.now(), btcHours: btc.length, results, errors, passed: linked.filter(([, r]) => r.passes).map(([s]) => s) };
}

const pct = v => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%` : '–');
const p0 = v => (Number.isFinite(v) ? `${Math.round(v * 100)}%` : '–');
const r2 = v => (Number.isFinite(v) ? v.toFixed(2) : '–');

export function report(out) {
  const lines = ['Bitcoin lead check: Bitcoin from the stock close to 09:00 New York, against the stock after the open', ''];
  lines.push(['Stock', 'Days', 'r gap', 'r day', 't', 'Hit', 'Chance', 'Year 1', 'Year 2', 'BTC +2%', 'BTC -2%', 'Verdict'].join('\t'));
  for (const [s, r] of Object.entries(out.results)) {
    lines.push([s, r.days, r2(r.gap.r), r2(r.day.r), r2(r.day.t), p0(r.hit), p0(r.chance),
      `${r2(r.halves[0].r)} ${p0(r.halves[0].hit)}`, `${r2(r.halves[1].r)} ${p0(r.halves[1].hit)}`,
      pct(r.afterBigUp), pct(r.afterBigDown), r.why].join('\t'));
  }
  for (const [s, e] of Object.entries(out.errors)) lines.push(`${s}\tcould not load: ${e}`);
  lines.push('', out.passed.length ? `Passed: ${out.passed.join(', ')}` : 'No crypto-linked stock passed.');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await runCheck({ log: s => process.stderr.write(`${s} `) });
  process.stderr.write('\n');
  const dir = join(process.env.DATA_DIR || '/data', 'research');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'btc-lead.json'), JSON.stringify(out, null, 1));
  process.stdout.write(`${report(out)}\n`);
}
