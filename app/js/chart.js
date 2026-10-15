// Candlestick and volume chart with optional overlays, drawn with TradingView
// Lightweight Charts (loaded as a global from vendor/ so it works offline).

const UP = '#26a69a';
const DOWN = '#ef5350';

// The chart library shows times in UTC. Shift intraday candles to the phone's
// local time so 9:30 in New York reads as the local equivalent.
const toLocal = t => t - new Date(t * 1000).getTimezoneOffset() * 60;

const LINES = {
  sma20: { color: '#f2c94c', lineWidth: 1 },
  sma50: { color: '#4c9aff', lineWidth: 1 },
  sma200: { color: '#c77dff', lineWidth: 2 },
  bbUpper: { color: 'rgba(139,148,158,0.8)', lineWidth: 1 },
  bbLower: { color: 'rgba(139,148,158,0.8)', lineWidth: 1 },
  spanA: { color: 'rgba(38,166,154,0.7)', lineWidth: 1 },
  spanB: { color: 'rgba(239,83,80,0.7)', lineWidth: 1 },
  fc50: { color: '#4c9aff', lineWidth: 2, lineStyle: 2 },
  fc10: { color: 'rgba(76,154,255,0.55)', lineWidth: 1, lineStyle: 2 },
  fc90: { color: 'rgba(76,154,255,0.55)', lineWidth: 1, lineStyle: 2 },
  ml: { color: '#ff9f43', lineWidth: 3, lineStyle: 0, lastValueVisible: true },
};

export class PriceChart {
  constructor(el) {
    const LW = window.LightweightCharts;
    if (!LW) throw new Error('Chart library did not load');
    this.chart = LW.createChart(el, {
      autoSize: true,
      layout: { background: { type: 'solid', color: '#161b22' }, textColor: '#c9d1d9', fontSize: 12 },
      grid: { vertLines: { color: '#222a35' }, horzLines: { color: '#222a35' } },
      rightPriceScale: { borderColor: '#2a313c' },
      timeScale: { borderColor: '#2a313c', rightOffset: 12 },
      crosshair: { mode: LW.CrosshairMode.Normal },
      handleScroll: { vertTouchDrag: false },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN,
    });
    this.volume = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    this.lines = {};
    this.key = null;
    this.shift = t => t;
  }

  line(name) {
    if (!this.lines[name]) {
      this.lines[name] = this.chart.addLineSeries({
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...LINES[name],
      });
    }
    return this.lines[name];
  }

  // `key` identifies symbol + timeframe; the view is only re-fitted when it changes.
  setData(candles, { intraday, key, decimals }) {
    this.shift = intraday ? toLocal : t => t;
    const shift = this.shift;
    this.chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    const minMove = Number((10 ** -decimals).toFixed(decimals));
    this.priceFormat = { type: 'price', precision: decimals, minMove };
    this.candles.applyOptions({ priceFormat: this.priceFormat });
    this.candles.setData(candles.map(c => ({ time: shift(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    const hasVolume = candles.some(c => c.volume > 0);
    this.volume.setData(hasVolume
      ? candles.map(c => ({ time: shift(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)' }))
      : []);
    if (key !== this.key) {
      this.key = key;
      const bars = Math.min(candles.length, 120);
      if (candles.length) this.chart.timeScale().setVisibleLogicalRange({ from: candles.length - bars, to: candles.length + 12 });
    }
  }

  // overlays: { name: [{ time, value }] | null }, markers: [{ time, action }],
  // titles: { name: label shown with the line's last value on the price scale }
  setOverlays(overlays, markers = [], titles = {}) {
    for (const name of Object.keys(LINES)) {
      const points = overlays[name];
      if (!points && !this.lines[name]) continue;
      const series = this.line(name);
      series.applyOptions({ priceFormat: this.priceFormat, title: titles[name] || '' });
      series.setData(points ? points.filter(p => Number.isFinite(p.value)).map(p => ({ time: this.shift(p.time), value: p.value })) : []);
    }
    this.candles.setMarkers(markers.map(m => ({
      time: this.shift(m.time),
      position: m.action === 'buy' ? 'belowBar' : 'aboveBar',
      color: m.action === 'buy' ? UP : DOWN,
      shape: m.action === 'buy' ? 'arrowUp' : 'arrowDown',
      text: m.action === 'buy' ? 'Buy' : 'Sell',
    })));
  }

  clear() {
    this.candles.setData([]);
    this.candles.setMarkers([]);
    this.volume.setData([]);
    for (const s of Object.values(this.lines)) s.setData([]);
    this.key = null;
  }
}
