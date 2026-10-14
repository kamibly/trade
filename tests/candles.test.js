import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanCandles, fromCoinbase, fromKraken, fromCoinGeckoOhlc, fromTwelve, parseUtcDateTime, toWeekly, weekStart, changeOverDay,
} from '../app/js/candles.js';

test('Coinbase rows are reordered oldest first with open/high/low/close mapped', () => {
  const rows = [
    [1700086400, 9, 12, 10, 11, 5],
    [1700000000, 8, 11, 9, 10, 4],
  ];
  assert.deepEqual(fromCoinbase(rows), [
    { time: 1700000000, open: 9, high: 11, low: 8, close: 10, volume: 4 },
    { time: 1700086400, open: 10, high: 12, low: 9, close: 11, volume: 5 },
  ]);
});

test('Kraken result uses the pair key, string values and skips vwap', () => {
  const json = { error: [], result: { XXBTZUSD: [[1700000000, '1', '3', '0.5', '2', '1.7', '42', 7]], last: 1700000000 } };
  assert.deepEqual(fromKraken(json), [{ time: 1700000000, open: 1, high: 3, low: 0.5, close: 2, volume: 42 }]);
});

test('Kraken errors are thrown', () => {
  assert.throws(() => fromKraken({ error: ['EQuery:Unknown asset pair'] }), /Unknown asset pair/);
});

test('CoinGecko OHLC milliseconds become seconds with zero volume', () => {
  assert.deepEqual(fromCoinGeckoOhlc([[1700000000000, 1, 2, 0.5, 1.5]]), [
    { time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 },
  ]);
});

test('Twelve Data dates and times parse as UTC', () => {
  assert.equal(parseUtcDateTime('2024-01-02'), Date.UTC(2024, 0, 2) / 1000);
  assert.equal(parseUtcDateTime('2024-01-02 15:30:00'), Date.UTC(2024, 0, 2, 15, 30) / 1000);
  assert.ok(Number.isNaN(parseUtcDateTime('yesterday')));
});

test('Twelve Data series is sorted and errors carry a readable message', () => {
  const json = {
    status: 'ok',
    values: [
      { datetime: '2024-01-03', open: '2', high: '3', low: '1', close: '2.5', volume: '100' },
      { datetime: '2024-01-02', open: '1', high: '2', low: '0.5', close: '2', volume: '90' },
    ],
  };
  const c = fromTwelve(json);
  assert.equal(c.length, 2);
  assert.equal(c[0].close, 2);
  assert.equal(c[1].volume, 100);
  assert.throws(() => fromTwelve({ status: 'error', code: 429, message: 'x' }), /limit reached/);
  assert.throws(() => fromTwelve({ status: 'error', code: 401, message: 'x' }), /rejected the key/);
});

test('cleanCandles drops broken rows and duplicate times', () => {
  const c = cleanCandles([
    { time: 2, open: 1, high: 1, low: 1, close: 1 },
    { time: 1, open: 'x', high: 1, low: 1, close: 1 },
    { time: 2, open: 2, high: 2, low: 2, close: 2, volume: 3 },
  ]);
  assert.deepEqual(c, [{ time: 2, open: 2, high: 2, low: 2, close: 2, volume: 3 }]);
});

test('weekStart is Monday 00:00 UTC', () => {
  const wed = Date.UTC(2024, 0, 3, 12) / 1000; // Wednesday 3 Jan 2024
  assert.equal(weekStart(wed), Date.UTC(2024, 0, 1) / 1000);
  const sun = Date.UTC(2024, 0, 7) / 1000;
  assert.equal(weekStart(sun), Date.UTC(2024, 0, 1) / 1000);
  const mon = Date.UTC(2024, 0, 8) / 1000;
  assert.equal(weekStart(mon), mon);
});

test('toWeekly merges days into weeks', () => {
  const day = (d, o, h, l, c, v) => ({ time: Date.UTC(2024, 0, d) / 1000, open: o, high: h, low: l, close: c, volume: v });
  const weeks = toWeekly([day(1, 10, 12, 9, 11, 1), day(3, 11, 15, 10, 14, 2), day(7, 14, 14, 8, 9, 3), day(8, 9, 10, 8, 10, 4)]);
  assert.deepEqual(weeks, [
    { time: Date.UTC(2024, 0, 1) / 1000, open: 10, high: 15, low: 8, close: 9, volume: 6 },
    { time: Date.UTC(2024, 0, 8) / 1000, open: 9, high: 10, low: 8, close: 10, volume: 4 },
  ]);
});

test('changeOverDay compares with the close one day back', () => {
  const hourly = Array.from({ length: 30 }, (_, i) => ({ time: i * 3600, open: 1, high: 1, low: 1, close: 100 + i, volume: 0 }));
  // last close 129, 24 candles back = 105
  assert.equal(changeOverDay(hourly, 3600).toFixed(4), (((129 - 105) / 105) * 100).toFixed(4));
  assert.equal(changeOverDay([hourly[0]], 3600), null);
});
