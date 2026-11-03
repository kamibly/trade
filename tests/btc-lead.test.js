import test from 'node:test';
import assert from 'node:assert/strict';
import { nyTime, nyDate, dayRows, measure, report } from '../server/btc_lead.mjs';

test('nyTime handles summer and winter time', () => {
  assert.equal(nyTime('2025-07-01', 16), Date.UTC(2025, 6, 1, 20) / 1000);
  assert.equal(nyTime('2025-12-01', 9), Date.UTC(2025, 11, 1, 14) / 1000);
  assert.equal(nyDate(Date.UTC(2025, 11, 1, 14, 30) / 1000), '2025-12-01');
});

// Weekdays from a start date, a stock candle at 09:30 NY each, and hourly BTC.
function world(days, link, seed = 7) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const dates = [];
  for (let t = Date.UTC(2024, 0, 2); dates.length < days; t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10));
  }
  const hours = [];
  let btc = 50000;
  const start = nyTime(dates[0], 0) - 86400, end = nyTime(dates[dates.length - 1], 23);
  const btcAt = {};
  for (let t = start; t < end; t += 3600) {
    hours.push({ time: t, open: btc, close: btc, high: btc, low: btc });
    btcAt[t + 3600] = btc;
    btc *= 1 + r() * 0.01;
    hours[hours.length - 1].close = btc;
  }
  const price = t => { let i = hours.findLastIndex(h => h.time + 3600 <= t); return hours[i].close; };
  const daily = [];
  let close = 100;
  for (let i = 0; i < dates.length; i++) {
    const move = i ? price(nyTime(dates[i], 9)) / price(nyTime(dates[i - 1], 16)) - 1 : 0;
    const open = close * (1 + r() * 0.01);
    close = open * (1 + link * move + r() * 0.02);
    daily.push({ time: nyTime(dates[i], 9, 30), open, close, high: open, low: open });
  }
  return { daily, hours };
}

test('dayRows measures Bitcoin from the last close to 09:00 New York', () => {
  const { daily, hours } = world(10, 0);
  const rows = dayRows(daily, hours);
  assert.equal(rows.length, 9);
  const p = t => hours.findLast(h => h.time + 3600 <= t).close;
  const want = p(nyTime(nyDate(daily[0].time), 16));
  assert.ok(Math.abs(rows[0].btc - (p(nyTime(rows[0].date, 9)) / want - 1)) < 1e-12);
  assert.ok(Math.abs(rows[0].day - (daily[1].close / daily[1].open - 1)) < 1e-12);
});

test('dayRows skips days with missing Bitcoin data', () => {
  const { daily } = world(10, 0);
  assert.equal(dayRows(daily, []).length, 0);
});

test('measure passes a real link and fails noise', () => {
  const strong = world(400, 1.5);
  const out = measure(dayRows(strong.daily, strong.hours));
  assert.equal(out.passes, true, out.why);
  assert.equal(out.why, 'passes');
  const noise = world(400, 0, 11);
  const none = measure(dayRows(noise.daily, noise.hours));
  assert.equal(none.passes, false);
  assert.equal(none.why, 'no clear link after the open');
  const short = measure(dayRows(strong.daily.slice(0, 50), strong.hours));
  assert.equal(short.why, 'only 49 days');
  const text = report({ results: { COIN: out, SPY: none }, errors: { HUT: 'nope' }, passed: ['COIN'] });
  assert.match(text, /COIN\t399\t/);
  assert.match(text, /Passed: COIN/);
  assert.match(text, /HUT\tcould not load: nope/);
});
