// Number formatting shared by the screens. No browser dependencies.

// Small coins need more decimals than stocks: 0.00001234 must not show as 0.00.
export function priceDecimals(value) {
  const v = Math.abs(value);
  if (v >= 1) return 2;
  if (v >= 0.01) return 4;
  if (v === 0) return 2;
  return Math.min(10, 3 - Math.floor(Math.log10(v))); // four significant digits
}

export function formatMoney(value, currency = 'USD') {
  if (!Number.isFinite(value)) return '–';
  const digits = priceDecimals(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatChange(pct) {
  if (!Number.isFinite(pct)) return '–';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function toCad(usd, usdToCad) {
  return Number.isFinite(usd) && Number.isFinite(usdToCad) ? usd * usdToCad : NaN;
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
