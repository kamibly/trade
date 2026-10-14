import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, formatChange, priceDecimals, toCad, timeAgo } from '../app/js/format.js';
import { CreditLimiter } from '../app/js/limiter.js';
import { parseTwelveQuote, splitTwelveQuotes, parseCryptoTop } from '../app/js/data.js';

test('prices keep enough decimals for small coins', () => {
  assert.equal(priceDecimals(64000), 2);
  assert.equal(priceDecimals(0.5), 4);
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(0.00001234), '$0.00001234');
  assert.equal(formatMoney(2, 'CAD'), 'CA$2.00');
  assert.equal(formatMoney(NaN), '–');
});

test('changes and CAD conversion', () => {
  assert.equal(formatChange(1.234), '+1.23%');
  assert.equal(formatChange(-0.5), '-0.50%');
  assert.equal(toCad(10, 1.4), 14);
  assert.ok(Number.isNaN(toCad(10, undefined)));
  assert.equal(timeAgo(0, 30_000), 'just now');
  assert.equal(timeAgo(0, 5 * 60_000), '5 min ago');
});

test('limiter waits once the window is full, then frees credits as they expire', async () => {
  let now = 0;
  const waits = [];
  const limiter = new CreditLimiter(8, 60_000, { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
  await limiter.take(6);
  await limiter.take(2);
  assert.deepEqual(waits, []);
  now = 10_000;
  await limiter.take(1);
  // the first 6 credits expire at 60s, waited for in 1s steps
  assert.equal(waits.reduce((a, b) => a + b, 0), 50_000);
  assert.equal(limiter.used(), 1);
});

test('a cancelled caller stops waiting and spends nothing', async () => {
  let now = 0;
  const ctrl = new AbortController();
  const limiter = new CreditLimiter(1, 60_000, { now: () => now, sleep: async ms => { now += ms; if (now >= 3000) ctrl.abort(); } });
  await limiter.take(1);
  await assert.rejects(limiter.take(1, ctrl.signal), { name: 'AbortError' });
  assert.equal(limiter.used(), 1);
  assert.equal(now, 3000);
});

test('limiter treats a 429 as a full window', () => {
  const limiter = new CreditLimiter(8, 60_000, { now: () => 0 });
  limiter.penalize(0);
  assert.equal(limiter.waitFor(1, 0), 60_000);
});

test('Twelve Data quotes: one symbol returns an object, several return a map', () => {
  const one = splitTwelveQuotes({ symbol: 'AAPL', name: 'Apple Inc', close: '190.5', percent_change: '1.2' }, ['AAPL']);
  assert.deepEqual(one, { AAPL: { price: 190.5, changePct: 1.2, name: 'Apple Inc' } });
  const many = splitTwelveQuotes({
    AAPL: { close: '1', percent_change: '0' },
    BAD: { status: 'error', code: 404, message: 'not found' },
  }, ['AAPL', 'BAD']);
  assert.equal(many.AAPL.price, 1);
  assert.match(many.BAD.error, /does not know this symbol/);
  assert.ok(parseTwelveQuote(undefined).error);
});

test('top crypto list drops stablecoins and upper-cases symbols', () => {
  const rows = [
    { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
    { id: 'tether', symbol: 'usdt', name: 'Tether' },
    { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
  ];
  assert.deepEqual(parseCryptoTop(rows, 50), [
    { type: 'crypto', symbol: 'BTC', name: 'Bitcoin', geckoId: 'bitcoin' },
    { type: 'crypto', symbol: 'ETH', name: 'Ethereum', geckoId: 'ethereum' },
  ]);
});
