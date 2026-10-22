// What a trade costs, as the brokers chosen for real trading charge it:
// US stocks at Interactive Brokers (IBKR Pro fixed: $0.005 a share, at least
// $1 and at most 1% of the order) and crypto at NDAX (a flat 0.20% on each buy
// and sell). Prices change; check the brokers' pages.

export const FEES = {
  stock: { perShare: 0.005, min: 1, maxPct: 0.01 },
  crypto: { pct: 0.002 },
};

// Dollars for one side (a buy or a sell) of `qty` at `price`.
export function feeOf(type, qty, price) {
  const value = qty * price;
  if (!(value > 0)) return 0;
  if (type === 'crypto') return value * FEES.crypto.pct;
  const f = FEES.stock;
  return Math.min(Math.max(f.min, qty * f.perShare), value * f.maxPct);
}

// One side as a share of the trade, for backtests and track records, which
// don't know the order size: a stock order of about $1,000 pays IBKR's $1
// minimum, 0.1%.
export const feeRate = type => (type === 'crypto' ? FEES.crypto.pct : 0.001);
