// Your real holdings: what you bought, at what price, and the stop-loss and
// target you want to be warned about. The app never trades; it only alerts.

const ok = Number.isFinite;

export function makeHolding({ type, symbol, name, qty, buyPrice, stop, take, atr, stopAtr = 2, takeAtr = 3 }) {
  const q = Number(qty);
  const b = Number(buyPrice);
  if (!(q > 0)) throw new Error('Enter how many you hold.');
  if (!(b > 0)) throw new Error('Enter the price you paid.');
  const s = stop === '' || stop == null ? (ok(atr) ? b - stopAtr * atr : NaN) : Number(stop);
  const t = take === '' || take == null ? (ok(atr) ? b + takeAtr * atr : NaN) : Number(take);
  if (ok(s) && s >= b) throw new Error('The stop-loss must be below the price you paid.');
  if (ok(t) && t <= b) throw new Error('The target must be above the price you paid.');
  return {
    id: `${type}:${symbol}:${Date.now().toString(36)}`,
    key: `${type}:${symbol}`,
    type,
    symbol,
    name: name || symbol,
    qty: q,
    buyPrice: b,
    stop: ok(s) && s > 0 ? s : null,
    take: ok(t) ? t : null,
    alerted: {},
  };
}

export function value(h, price) {
  const p = ok(price) ? price : h.buyPrice;
  return { value: h.qty * p, cost: h.qty * h.buyPrice, pnl: h.qty * (p - h.buyPrice), pct: p / h.buyPrice - 1 };
}

export function totals(holdings, prices) {
  let v = 0;
  let cost = 0;
  for (const h of holdings) {
    const x = value(h, prices[h.key]);
    v += x.value;
    cost += x.cost;
  }
  return { value: v, cost, pnl: v - cost, pct: cost ? v / cost - 1 : NaN };
}

// Where the price sits against the holding's levels.
export function levelState(h, price) {
  if (!ok(price)) return 'unknown';
  if (h.stop != null && price <= h.stop) return 'stop';
  if (h.take != null && price >= h.take) return 'target';
  return 'ok';
}

// Alerts for one holding: each one fires once until the price moves back
// (stop and target) or the signal leaves sell. Returns { alerts, alerted }.
export function checkHolding(h, price, action) {
  const was = h.alerted || {};
  const alerted = {};
  const alerts = [];
  const lvl = levelState(h, price);
  if (lvl === 'stop') {
    alerted.stop = true;
    if (!was.stop) alerts.push('stop');
  }
  if (lvl === 'target') {
    alerted.take = true;
    if (!was.take) alerts.push('target');
  }
  if (action === 'sell') {
    alerted.sell = true;
    if (!was.sell) alerts.push('sell');
  }
  return { alerts, alerted };
}
