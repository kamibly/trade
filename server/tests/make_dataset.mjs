// Synthetic training data for test_ml.py: trending random walks run through
// the real engine's dataset mode, so features match what the server makes.
import { runDataset } from '../engine.mjs';

function series(n, seed) {
  let s = seed;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = 100;
  let m = 0;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    m = 0.9 * m + 0.004 * (r() - 0.5); // drifts that persist, so there is something to learn
    p *= Math.exp(m + 0.02 * (r() - 0.5));
    return { time: 1e9 + i * 86400, open: o, close: p, high: Math.max(o, p) * (1 + r() * 0.01), low: Math.min(o, p) * (1 - r() * 0.01), volume: 1000 + r() * 1000 };
  });
}

const n = Number(process.argv[2] || 8);
const items = Array.from({ length: n }, (_, k) => ({ type: 'stock', symbol: `S${k}` }));
const deps = {
  yahooCandles: async item => ({ candles: series(Number(process.argv[3] || 600), 7 + (Number(item.symbol.slice(1)) || 99) * 13) }),
  fetchCandles: async () => { throw new Error('offline'); },
  fetchCryptoTop: async () => [],
  now: () => 0,
};
const data = await runDataset({ tf: '1D', settings: { buyAt: 40, sellAt: -40, twelveKey: '' }, items }, deps);
process.stdout.write(JSON.stringify(data));
